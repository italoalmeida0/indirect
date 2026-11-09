/* shim.c is the C half of packages/qjs: it owns one QuickJS runtime plus
   context per module evaluation and exposes the three primitives the Go
   loader needs — create a sandbox, evaluate one ES module graph, tear down.
   Imports are real ES module imports: QuickJS's module loader callback is
   wired to the Go side (guQjsModuleSource), so `import base from
   "skill:agentic_base"` links a second module into the SAME context and the
   skill composes with ordinary JavaScript (spread, concatenation).

   Nothing in this file re-implements QuickJS: it only wires the public API
   (no eval intrinsic, no host modules, no file or process access). */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "shim.h"

/* Exported by the Go side (package qjs). guQjsModuleSource resolves one
   import specifier to the module source on the loader's goroutine;
   guQjsInterrupt answers non-zero once the module deadline has passed. */
extern int guQjsModuleSource(uintptr_t handle, const char *name, char **out_src, size_t *out_src_len, char **out_err);
/* guQjsModuleEdge records one import edge (importer -> import) and answers
   non-zero when the edge would close an import cycle. */
extern int guQjsModuleEdge(uintptr_t handle, const char *base, const char *name, char **out_err);
extern int guQjsInterrupt(uintptr_t handle);

/* Hard ceilings enforced in C as well: Go re-checks the real budgets, but a
   tampered sandbox must not be able to hand back an unbounded string. */
#define GU_MAX_SNAPSHOT_BYTES (24 * 1024 * 1024)
#define GU_MEMORY_LIMIT (96 * 1024 * 1024)
#define GU_MAX_STACK (1 * 1024 * 1024)

struct QjsRun {
    uintptr_t handle;
    JSRuntime *rt;
    JSContext *ctx;
    JSValue snapshot_fn; /* held directly: immune to global reassignment */
};

static char *gu_strdup(const char *s)
{
    size_t n;
    char *out;
    if (!s) {
        s = "";
    }
    n = strlen(s);
    out = (char *)malloc(n + 1);
    if (!out) {
        return NULL;
    }
    memcpy(out, s, n + 1);
    return out;
}

/* gu_error_text renders the pending exception: message plus the JS stack
   when available, so a failing skill points at its own lines. */
static char *gu_error_text(JSContext *ctx)
{
    JSValue exc, msg, stack;
    const char *cmsg = NULL, *cstack = NULL;
    char *out = NULL;
    size_t need;

    exc = JS_GetException(ctx);
    if (JS_IsNull(exc)) {
        JS_FreeValue(ctx, exc);
        return gu_strdup("RangeError: out of memory");
    }
    if (JS_IsError(exc)) {
        msg = JS_GetPropertyStr(ctx, exc, "message");
        if (JS_IsException(msg)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            msg = JS_UNDEFINED;
        } else if (JS_IsString(msg)) {
            cmsg = JS_ToCString(ctx, msg);
        }
        stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (JS_IsException(stack)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            stack = JS_UNDEFINED;
        } else if (JS_IsString(stack)) {
            cstack = JS_ToCString(ctx, stack);
        }
        if (cstack && cmsg && strstr(cstack, cmsg)) {
            JS_FreeCString(ctx, cmsg);
            cmsg = NULL; /* the stack already carries the message */
        }
        need = strlen(cmsg ? cmsg : "error") + (cstack ? strlen(cstack) : 0) + 4;
        out = (char *)malloc(need);
        if (out) {
            snprintf(out, need, "%s%s%s", cstack ? cstack : "", cstack ? "\n" : "", cmsg ? cmsg : "");
        }
        if (cstack) {
            JS_FreeCString(ctx, cstack);
        }
        if (cmsg) {
            JS_FreeCString(ctx, cmsg);
        }
        JS_FreeValue(ctx, stack);
        JS_FreeValue(ctx, msg);
    } else if (JS_IsSymbol(exc)) {
        JSAtom atom = JS_ValueToAtom(ctx, exc);
        const char *desc = atom != JS_ATOM_NULL ? JS_AtomToCString(ctx, atom) : NULL;
        need = strlen(desc ? desc : "") + 16;
        out = (char *)malloc(need);
        if (out) {
            snprintf(out, need, "Symbol(%s)", desc ? desc : "");
        }
        if (desc) {
            JS_FreeCString(ctx, desc);
        }
        if (atom != JS_ATOM_NULL) {
            JS_FreeAtom(ctx, atom);
        }
    } else {
        cmsg = JS_ToCString(ctx, exc);
        if (!cmsg && JS_HasException(ctx)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
        out = gu_strdup(cmsg ? cmsg : "RangeError: out of memory");
        if (cmsg) {
            JS_FreeCString(ctx, cmsg);
        }
    }
    JS_FreeValue(ctx, exc);
    return out;
}

static int gu_fail(JSContext *ctx, char **err)
{
    if (err) {
        *err = gu_error_text(ctx);
    }
    return 1;
}

static int gu_interrupt(JSContext *ctx, void *opaque)
{
    QjsRun *run = (QjsRun *)opaque;
    (void)ctx;
    if (!run) {
        return 0;
    }
    return guQjsInterrupt(run->handle);
}

/* gu_module_normalize keeps the specifier verbatim: QuickJS must not join
   "skill:agentic_base" onto the importing file's path. Every import passes
   through here with its importer, so the Go side records the graph and
   refuses a cycle with the path that closes it instead of letting module
   instantiation fail later with an unexplained "not initialized". */
static char *gu_module_normalize(JSContext *ctx, const char *module_base_name,
                                 const char *module_name, void *opaque)
{
    QjsRun *run = (QjsRun *)opaque;
    char *err = NULL;

    if (run && guQjsModuleEdge(run->handle, module_base_name, module_name, &err) != 0) {
        JS_ThrowSyntaxError(ctx, "%s", err ? err : "import cycle");
        free(err);
        return NULL;
    }
    return js_strdup(ctx, module_name);
}

/* gu_module_loader compiles one imported module into the current context.
   QuickJS calls it while linking; the source comes from Go, so every module
   in the graph shares one VM, one deadline and one memory limit, exactly
   like a real ES module graph. */
static JSModuleDef *gu_module_loader(JSContext *ctx, const char *module_name, void *opaque)
{
    QjsRun *run = (QjsRun *)opaque;
    char *src = NULL, *err = NULL;
    size_t src_len = 0;
    JSValue compiled;
    JSModuleDef *m;

    if (!run) {
        JS_ThrowInternalError(ctx, "module sandbox is gone");
        return NULL;
    }
    if (guQjsModuleSource(run->handle, module_name, &src, &src_len, &err) != 0) {
        JS_ThrowInternalError(ctx, "%s", err ? err : "module not found");
        free(err);
        free(src);
        return NULL;
    }
    if (!src) {
        JS_ThrowInternalError(ctx, "module %s has no source", module_name);
        return NULL;
    }
    compiled = JS_Eval(ctx, src, src_len, module_name,
                       JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(src);
    if (JS_IsException(compiled)) {
        return NULL; /* the pending exception carries the parse error */
    }
    if (JS_VALUE_GET_TAG(compiled) != JS_TAG_MODULE) {
        JS_FreeValue(ctx, compiled);
        JS_ThrowInternalError(ctx, "module %s did not compile to a module", module_name);
        return NULL;
    }
    /* The context keeps its own reference while the graph is instantiated. */
    m = (JSModuleDef *)JS_VALUE_GET_PTR(compiled);
    JS_FreeValue(ctx, compiled);
    return m;
}

QjsRun *qjs_new(uintptr_t handle, const char *prelude, char **err)
{
    QjsRun *run;
    JSValue global, script, snapshot;
    JSRuntime *rt;
    JSContext *ctx;

    if (err) {
        *err = NULL;
    }
    run = (QjsRun *)calloc(1, sizeof(*run));
    if (!run) {
        if (err) {
            *err = gu_strdup("out of memory");
        }
        return NULL;
    }
    run->handle = handle;
    run->snapshot_fn = JS_UNDEFINED;
    rt = JS_NewRuntime();
    if (!rt) {
        free(run);
        if (err) {
            *err = gu_strdup("could not create the QuickJS runtime");
        }
        return NULL;
    }
    run->rt = rt;
    JS_UpdateStackTop(rt);
    JS_SetMemoryLimit(rt, GU_MEMORY_LIMIT);
    JS_SetMaxStackSize(rt, GU_MAX_STACK);
    JS_SetInterruptHandler(rt, gu_interrupt, run);
    /* Raw context: only the intrinsics a plain-data skill module needs.
       Base objects carry Object/Array/String/Number/Math; JSON is needed by
       the snapshot, Promise is required by the module machinery, RegExp,
       BigInt and Map/Set keep ordinary authoring comfortable. */
    ctx = JS_NewContextRaw(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        free(run);
        if (err) {
            *err = gu_strdup("could not create the QuickJS context");
        }
        return NULL;
    }
    run->ctx = ctx;
    JS_AddIntrinsicBaseObjects(ctx);
    JS_AddIntrinsicRegExp(ctx);
    JS_AddIntrinsicJSON(ctx);
    JS_AddIntrinsicPromise(ctx);
    JS_AddIntrinsicBigInt(ctx);
    JS_AddIntrinsicMapSet(ctx);
    /* The eval intrinsic is the only way to compile source at all (every
       parse entry point funnels through ctx->eval_internal), so the host
       enables it to compile trusted code — and the prelude immediately
       removes every JS-visible path to it: the `eval` global, `Function`
       and the derived function constructors. Skill code can therefore
       never compile new code. */
    JS_AddIntrinsicEval(ctx);
    JS_SetContextOpaque(ctx, run);

    /* One module graph per sandbox: imports link into this same context. */
    JS_SetModuleLoaderFunc(rt, gu_module_normalize, gu_module_loader, run);

    if (prelude) {
        script = JS_Eval(ctx, prelude, strlen(prelude), "<skill sandbox>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(script)) {
            if (err) {
                *err = gu_error_text(ctx);
            }
            JS_FreeValue(ctx, script);
            qjs_free_run(run);
            return NULL;
        }
        JS_FreeValue(ctx, script);
    }

    global = JS_GetGlobalObject(ctx);
    snapshot = JS_GetPropertyStr(ctx, global, "__gu_snapshot");
    JS_FreeValue(ctx, global);
    if (!JS_IsFunction(ctx, snapshot)) {
        JS_FreeValue(ctx, snapshot);
        if (err) {
            *err = gu_strdup("skill sandbox did not install __gu_snapshot");
        }
        qjs_free_run(run);
        return NULL;
    }
    run->snapshot_fn = snapshot;
    return run;
}

void qjs_free_run(QjsRun *run)
{
    if (!run) {
        return;
    }
    if (run->ctx) {
        JS_FreeValue(run->ctx, run->snapshot_fn);
        JS_FreeContext(run->ctx);
    }
    if (run->rt) {
        JS_FreeRuntime(run->rt);
    }
    free(run);
}

void qjs_free_str(char *s)
{
    free(s);
}

/* qjs_eval_module evaluates one ES module graph and returns the snapshot of
   the root module's default export. Imports resolve through the Go loader. */
int qjs_eval_module(QjsRun *run, const char *name, const char *src, size_t srclen, char **out_json, char **err)
{
    JSContext *ctx;
    JSValue mod, result, ns, def, args[1], json;
    JSModuleDef *m;
    JSPromiseStateEnum state;
    const char *cstr;
    size_t len = 0;

    if (out_json) {
        *out_json = NULL;
    }
    if (err) {
        *err = NULL;
    }
    if (!run || !run->ctx) {
        if (err) {
            *err = gu_strdup("no module sandbox");
        }
        return 1;
    }
    JS_UpdateStackTop(run->rt);
    ctx = run->ctx;
    mod = JS_Eval(ctx, src, srclen, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(mod)) {
        return gu_fail(ctx, err);
    }
    if (JS_VALUE_GET_TAG(mod) != JS_TAG_MODULE) {
        JS_FreeValue(ctx, mod);
        if (err) {
            *err = gu_strdup("module did not compile");
        }
        return 1;
    }
    m = (JSModuleDef *)JS_VALUE_GET_PTR(mod);
    result = JS_EvalFunction(ctx, mod); /* consumes mod */
    if (JS_IsException(result)) {
        return gu_fail(ctx, err);
    }
    state = JS_PromiseState(ctx, result);
    if (state == JS_PROMISE_REJECTED) {
        JSValue exc = JS_PromiseResult(ctx, result);
        JS_Throw(ctx, exc);
        JS_FreeValue(ctx, result);
        return gu_fail(ctx, err);
    }
    if (state != JS_PROMISE_FULFILLED) {
        JS_FreeValue(ctx, result);
        if (err) {
            *err = gu_strdup("module did not evaluate synchronously (top-level await is not supported)");
        }
        return 1;
    }
    JS_FreeValue(ctx, result);

    ns = JS_GetModuleNamespace(ctx, m);
    if (JS_IsException(ns)) {
        return gu_fail(ctx, err);
    }
    def = JS_GetPropertyStr(ctx, ns, "default");
    JS_FreeValue(ctx, ns);
    if (JS_IsException(def)) {
        return gu_fail(ctx, err);
    }
    if (JS_IsUndefined(def) || JS_IsFunction(ctx, def)) {
        JS_FreeValue(ctx, def);
        if (err) {
            *err = gu_strdup("module must export default with the skill object");
        }
        return 1;
    }

    args[0] = def;
    json = JS_Call(ctx, run->snapshot_fn, JS_UNDEFINED, 1, args);
    JS_FreeValue(ctx, def);
    if (JS_IsException(json)) {
        return gu_fail(ctx, err);
    }
    cstr = JS_ToCStringLen(ctx, &len, json);
    JS_FreeValue(ctx, json);
    if (!cstr) {
        return gu_fail(ctx, err);
    }
    if (len > GU_MAX_SNAPSHOT_BYTES) {
        JS_FreeCString(ctx, cstr);
        if (err) {
            *err = gu_strdup("skill description is too large");
        }
        return 1;
    }
    if (out_json) {
        *out_json = (char *)malloc(len + 1);
        if (!*out_json) {
            JS_FreeCString(ctx, cstr);
            if (err) {
                *err = gu_strdup("out of memory");
            }
            return 1;
        }
        memcpy(*out_json, cstr, len);
        (*out_json)[len] = '\0';
    }
    JS_FreeCString(ctx, cstr);
    return 0;
}

/* =========================================================================
 * Full Script Runtime (QjsRuntime) for exec_script and --js
 * ========================================================================= */

extern int guQjsRtInterrupt(uintptr_t handle);
extern void guQjsRtExit(uintptr_t handle, int code);
extern int guQjsRtWrite(uintptr_t handle, int fd, const uint8_t *buf, size_t len);
extern int guQjsRtHostCall(uintptr_t handle, const char *op,
                           const char *args_json, size_t args_len,
                           const uint8_t *in_bin, size_t in_bin_len,
                           char **out_json, size_t *out_json_len,
                           uint8_t **out_bin, size_t *out_bin_len,
                           int *has_bin, char **out_err);
extern int guQjsRtModuleNormalize(uintptr_t handle, const char *base_name,
                                  const char *module_name,
                                  char **out_resolved, char **out_err);
extern int guQjsRtModuleLoad(uintptr_t handle, const char *module_name,
                             char **out_src, size_t *out_src_len,
                             char **out_file_url, char **out_filename,
                             char **out_dirname, char **out_err);

#define RT_DEFAULT_MEMORY_LIMIT (512 * 1024 * 1024)
#define RT_MAX_STACK (2 * 1024 * 1024)

typedef struct {
    JSValue promise;
    JSValue reason;
} QjsUnhandledEntry;

typedef struct {
    int32_t id;
    JSContext *ctx;
    int *alive_flag;
    int may_have_jobs;
} QjsVmContextEntry;

typedef struct {
    char *name;
    JSModuleDef *m;
    int has_tla;
    int state; /* 0 = compiled, 1 = evaluating, 2 = evaluated */
} QjsEsmEntry;

static void rt_vm_pin_finalizer(JSRuntime *rt, JSValue val)
{
    int *flag = (int *)JS_GetOpaque(val, JS_GetClassID(val));
    (void)rt;
    if (flag) {
        *flag = 0;
    }
}

static JSClassDef rt_vm_pin_class_def = {
    "VmContextPin",
    .finalizer = rt_vm_pin_finalizer,
};

struct QjsRuntime {
    uintptr_t handle;
    JSRuntime *rt;
    JSContext *ctx;
    QjsVmContextEntry *vm_ctxs;
    size_t vm_ctxs_len;
    size_t vm_ctxs_cap;
    QjsEsmEntry *esm_mods;
    size_t esm_mods_len;
    size_t esm_mods_cap;
    int esm_graph_has_tla;
    JSClassID vm_pin_class_id;
    JSAtom vm_pin_atom;
    JSValue dispatch_fn;
    JSValue after_microtasks_fn;
    JSValue check_loop_fn;
    JSValue unhandled_rejection_fn;
    JSValue uncaught_exception_fn;
    JSValue require_fn;
    JSValue cjs_main_args;
    JSValue promise_hook_fn;
    JSValue main_promise;
    QjsUnhandledEntry *unhandled;
    size_t unhandled_head;
    size_t unhandled_len;
    size_t unhandled_cap;
    int exited;
    int in_uncaught;
    int vm_interrupted;
    int in_promise_hook;
};

static void rt_compact_unhandled(QjsRuntime *r)
{
    if (!r) {
        return;
    }
    while (r->unhandled_head < r->unhandled_len &&
           JS_IsUndefined(r->unhandled[r->unhandled_head].promise)) {
        r->unhandled_head++;
    }
    while (r->unhandled_len > r->unhandled_head &&
           JS_IsUndefined(r->unhandled[r->unhandled_len - 1].promise)) {
        r->unhandled_len--;
    }
    if (r->unhandled_head >= r->unhandled_len) {
        r->unhandled_head = 0;
        r->unhandled_len = 0;
        return;
    }
    if (r->unhandled_len >= 64) {
        size_t write_idx = 0;
        size_t i;
        for (i = r->unhandled_head; i < r->unhandled_len; i++) {
            if (!JS_IsUndefined(r->unhandled[i].promise)) {
                if (write_idx != i) {
                    r->unhandled[write_idx] = r->unhandled[i];
                }
                write_idx++;
            }
        }
        r->unhandled_head = 0;
        r->unhandled_len = write_idx;
    }
}

static void rt_promise_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                         JSValueConst reason, bool is_handled,
                                         void *opaque)
{
    QjsRuntime *r = (QjsRuntime *)opaque;
    size_t i;
    void *p_ptr;

    if (!r || !r->ctx || !ctx) {
        return;
    }
    p_ptr = JS_VALUE_GET_PTR(promise);
    if (!is_handled) {
        rt_compact_unhandled(r);
        if (r->unhandled_len == r->unhandled_cap) {
            size_t next_cap = r->unhandled_cap == 0 ? 8 : r->unhandled_cap * 2;
            QjsUnhandledEntry *next = (QjsUnhandledEntry *)realloc(
                r->unhandled, next_cap * sizeof(QjsUnhandledEntry));
            if (!next) {
                return;
            }
            r->unhandled = next;
            r->unhandled_cap = next_cap;
        }
        r->unhandled[r->unhandled_len].promise = JS_DupValue(ctx, promise);
        r->unhandled[r->unhandled_len].reason = JS_DupValue(ctx, reason);
        r->unhandled_len++;
    } else {
        for (i = r->unhandled_len; i > r->unhandled_head; i--) {
            size_t idx = i - 1;
            if (!JS_IsUndefined(r->unhandled[idx].promise) &&
                JS_VALUE_GET_PTR(r->unhandled[idx].promise) == p_ptr) {
                JS_FreeValue(ctx, r->unhandled[idx].promise);
                JS_FreeValue(ctx, r->unhandled[idx].reason);
                r->unhandled[idx].promise = JS_UNDEFINED;
                r->unhandled[idx].reason = JS_UNDEFINED;
                if (idx + 1 == r->unhandled_len) {
                    r->unhandled_len--;
                } else if (idx == r->unhandled_head) {
                    r->unhandled_head++;
                }
                rt_compact_unhandled(r);
                return;
            }
        }
        if (!r->exited && JS_IsFunction(r->ctx, r->unhandled_rejection_fn)) {
            JSValue uargs[3] = {
                JS_UNDEFINED,
                JS_DupValue(r->ctx, promise),
                JS_TRUE,
            };
            JSValue ures = JS_Call(r->ctx, r->unhandled_rejection_fn, JS_UNDEFINED, 3, uargs);
            JS_FreeValue(r->ctx, uargs[1]);
            if (JS_IsException(ures)) {
                JS_FreeValue(r->ctx, JS_GetException(r->ctx));
            } else {
                JS_FreeValue(r->ctx, ures);
            }
        }
    }
}

static void rt_remove_unhandled(QjsRuntime *r, JSValueConst promise)
{
    size_t i;
    void *p_ptr;
    if (!r || !r->ctx || JS_IsUndefined(promise)) {
        return;
    }
    p_ptr = JS_VALUE_GET_PTR(promise);
    for (i = r->unhandled_len; i > r->unhandled_head; i--) {
        size_t idx = i - 1;
        if (!JS_IsUndefined(r->unhandled[idx].promise) &&
            JS_VALUE_GET_PTR(r->unhandled[idx].promise) == p_ptr) {
            JS_FreeValue(r->ctx, r->unhandled[idx].promise);
            JS_FreeValue(r->ctx, r->unhandled[idx].reason);
            r->unhandled[idx].promise = JS_UNDEFINED;
            r->unhandled[idx].reason = JS_UNDEFINED;
            if (idx + 1 == r->unhandled_len) {
                r->unhandled_len--;
            } else if (idx == r->unhandled_head) {
                r->unhandled_head++;
            }
            rt_compact_unhandled(r);
            return;
        }
    }
}

static int rt_has_unhandled(QjsRuntime *r)
{
    size_t i;
    if (!r) {
        return 0;
    }
    for (i = r->unhandled_head; i < r->unhandled_len; i++) {
        if (!JS_IsUndefined(r->unhandled[i].promise)) {
            return 1;
        }
    }
    r->unhandled_head = 0;
    r->unhandled_len = 0;
    return 0;
}

static void rt_delete_global_prop(JSContext *ctx, JSValueConst global, const char *name)
{
    JSAtom atom = JS_NewAtom(ctx, name);
    if (atom != JS_ATOM_NULL) {
        JS_DeleteProperty(ctx, global, atom, 0);
        JS_FreeAtom(ctx, atom);
    }
}

static int rt_interrupt(JSContext *ctx, void *opaque)
{
    QjsRuntime *r = (QjsRuntime *)opaque;
    (void)ctx;
    if (!r) {
        return 0;
    }
    if (r->exited) {
        return 1;
    }
    if (guQjsRtInterrupt(r->handle) != 0) {
        r->vm_interrupted = 1;
        return 1;
    }
    return 0;
}

static void rt_promise_hook(JSContext *ctx, JSPromiseHookType type,
                            JSValueConst promise, JSValueConst parent_promise,
                            void *opaque)
{
    QjsRuntime *r = (QjsRuntime *)opaque;
    if (!r || !r->ctx || ctx != r->ctx || r->in_promise_hook || r->exited) {
        return;
    }
    if (!JS_IsFunction(ctx, r->promise_hook_fn)) {
        return;
    }
    r->in_promise_hook = 1;
    {
        JSValue args[3] = {
            JS_NewInt32(ctx, (int32_t)type),
            JS_DupValue(ctx, promise),
            JS_DupValue(ctx, parent_promise),
        };
        JSValue res = JS_Call(ctx, r->promise_hook_fn, JS_UNDEFINED, 3, args);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
        JS_FreeValue(ctx, args[2]);
        if (JS_IsException(res)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        } else {
            JS_FreeValue(ctx, res);
        }
    }
    r->in_promise_hook = 0;
}

static int rt_try_recover(QjsRuntime *r, char **err)
{
    if (!r || !r->ctx) {
        if (err) {
            *err = gu_strdup("runtime is closed");
        }
        return 1;
    }
    if (r->exited) {
        JSValue exc = JS_GetException(r->ctx);
        JS_FreeValue(r->ctx, exc);
        return 0;
    }
    if (!r->in_uncaught && guQjsRtInterrupt(r->handle) == 0 &&
        JS_IsFunction(r->ctx, r->uncaught_exception_fn)) {
        JSValue exc = JS_GetException(r->ctx);
        r->in_uncaught = 1;
        JSValue ures = JS_Call(r->ctx, r->uncaught_exception_fn, JS_UNDEFINED, 1, &exc);
        r->in_uncaught = 0;
        if (r->exited) {
            JS_FreeValue(r->ctx, ures);
            JS_FreeValue(r->ctx, exc);
            return 0;
        }
        if (!JS_IsException(ures)) {
            int handled = JS_ToBool(r->ctx, ures);
            JS_FreeValue(r->ctx, ures);
            if (handled > 0) {
                JS_FreeValue(r->ctx, exc);
                return 0;
            }
            JS_Throw(r->ctx, exc);
        } else {
            JS_FreeValue(r->ctx, exc);
        }
    }
    if (err) {
        *err = gu_error_text(r->ctx);
    } else {
        JSValue exc = JS_GetException(r->ctx);
        JS_FreeValue(r->ctx, exc);
    }
    return 1;
}

static int rt_fail(QjsRuntime *r, char **err)
{
    if (rt_try_recover(r, err) == 0) {
        return qjs_rt_pump(r, err);
    }
    return 1;
}

/* Extracts a pointer + length from an ArrayBuffer, TypedArray, or DataView
   without throwing a JS exception if val is none of those.
   Caller must JS_FreeValue(ctx, *keepalive) after consuming the returned bytes. */
static const uint8_t *rt_extract_bytes(JSContext *ctx, JSValueConst val, size_t *out_len, JSValue *keepalive)
{
    size_t byte_offset = 0, byte_length = 0, ab_size = 0;
    JSValue ab;
    uint8_t *ab_ptr;

    *out_len = 0;
    *keepalive = JS_UNDEFINED;
    if (JS_IsUndefined(val) || JS_IsNull(val) || !JS_IsObject(val)) {
        return NULL;
    }
    if (JS_IsArrayBuffer(val)) {
        ab_ptr = JS_GetArrayBuffer(ctx, out_len, val);
        if (!ab_ptr && JS_HasException(ctx)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
        return ab_ptr;
    }
    if (JS_GetTypedArrayType(val) >= 0) {
        ab = JS_GetTypedArrayBuffer(ctx, val, &byte_offset, &byte_length, NULL);
        if (JS_IsException(ab)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            return NULL;
        }
        ab_ptr = JS_GetArrayBuffer(ctx, &ab_size, ab);
        if (!ab_ptr && JS_HasException(ctx)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
        if (!ab_ptr || byte_offset + byte_length > ab_size) {
            JS_FreeValue(ctx, ab);
            return NULL;
        }
        *keepalive = ab;
        *out_len = byte_length;
        return ab_ptr + byte_offset;
    }
    ab = JS_GetPropertyStr(ctx, val, "buffer");
    if (JS_IsException(ab)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return NULL;
    }
    if (JS_IsArrayBuffer(ab)) {
        JSValue off_val = JS_GetPropertyStr(ctx, val, "byteOffset");
        JSValue len_val = JS_GetPropertyStr(ctx, val, "byteLength");
        uint64_t off64 = 0, len64 = 0;
        int ok = !JS_IsException(off_val) && !JS_IsException(len_val) &&
                 JS_ToIndex(ctx, &off64, off_val) == 0 &&
                 JS_ToIndex(ctx, &len64, len_val) == 0;
        JS_FreeValue(ctx, off_val);
        JS_FreeValue(ctx, len_val);
        if (!ok) {
            if (JS_HasException(ctx)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
            }
            JS_FreeValue(ctx, ab);
            return NULL;
        }
        ab_ptr = JS_GetArrayBuffer(ctx, &ab_size, ab);
        if (!ab_ptr && JS_HasException(ctx)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
        byte_offset = (size_t)off64;
        byte_length = (size_t)len64;
        if (!ab_ptr || byte_offset + byte_length > ab_size) {
            JS_FreeValue(ctx, ab);
            return NULL;
        }
        *keepalive = ab;
        *out_len = byte_length;
        return ab_ptr + byte_offset;
    }
    JS_FreeValue(ctx, ab);
    return NULL;
}

/* __qjs_host_call(op, jsonArgs, binData) */
static JSValue js_rt_host_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    const char *op_str = NULL;
    const char *json_str = NULL;
    size_t json_len = 0;
    const uint8_t *in_bin = NULL;
    size_t in_bin_len = 0;
    JSValue bin_keepalive = JS_UNDEFINED;
    char *out_json = NULL;
    size_t out_json_len = 0;
    uint8_t *out_bin = NULL;
    size_t out_bin_len = 0;
    int has_bin = 0;
    char *out_err = NULL;
    int rc;
    JSValue ret = JS_UNDEFINED;

    (void)this_val;
    if (!r) {
        return JS_ThrowInternalError(ctx, "runtime is gone");
    }
    if (argc < 1 || !JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "__qjs_host_call requires an operation string");
    }
    op_str = JS_ToCString(ctx, argv[0]);
    if (!op_str) {
        return JS_EXCEPTION;
    }
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        json_str = JS_ToCStringLen(ctx, &json_len, argv[1]);
        if (!json_str) {
            JS_FreeCString(ctx, op_str);
            return JS_EXCEPTION;
        }
    }
    if (argc >= 3) {
        in_bin = rt_extract_bytes(ctx, argv[2], &in_bin_len, &bin_keepalive);
    }

    rc = guQjsRtHostCall(r->handle, op_str,
                         json_str ? json_str : "", json_len,
                         in_bin, in_bin_len,
                         &out_json, &out_json_len,
                         &out_bin, &out_bin_len,
                         &has_bin, &out_err);

    JS_FreeValue(ctx, bin_keepalive);
    JS_FreeCString(ctx, op_str);
    if (json_str) {
        JS_FreeCString(ctx, json_str);
    }

    if (rc != 0) {
        JSValue err_obj = JS_NewError(ctx);
        if (JS_IsObject(err_obj)) {
            JS_DefinePropertyValueStr(ctx, err_obj, "message", JS_NewString(ctx, out_err ? out_err : "host call failed"), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
            if (out_json && out_json_len > 0) {
                JS_SetPropertyStr(ctx, err_obj, "code", JS_NewStringLen(ctx, out_json, out_json_len));
            }
        }
        free(out_err);
        free(out_json);
        free(out_bin);
        return JS_Throw(ctx, err_obj);
    }

    free(out_err);
    if (has_bin && out_json) {
        ret = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, ret, "json", JS_NewStringLen(ctx, out_json, out_json_len));
        JS_SetPropertyStr(ctx, ret, "bin", JS_NewUint8ArrayCopy(ctx, out_bin ? out_bin : (const uint8_t *)"", out_bin ? out_bin_len : 0));
    } else if (has_bin) {
        ret = JS_NewUint8ArrayCopy(ctx, out_bin ? out_bin : (const uint8_t *)"", out_bin ? out_bin_len : 0);
    } else if (out_json) {
        ret = JS_NewStringLen(ctx, out_json, out_json_len);
    }

    free(out_json);
    free(out_bin);
    return ret;
}

/* __qjs_write_fd(fd, data) */
static JSValue js_rt_write_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    int32_t fd = 1;
    const char *str = NULL;
    size_t len = 0;
    const uint8_t *bin = NULL;
    JSValue bin_keepalive = JS_UNDEFINED;

    (void)this_val;
    if (!r || argc < 2) {
        return JS_FALSE;
    }
    if (JS_ToInt32(ctx, &fd, argv[0]) < 0) {
        return JS_EXCEPTION;
    }
    if (JS_IsString(argv[1])) {
        str = JS_ToCStringLen(ctx, &len, argv[1]);
        if (!str) {
            return JS_EXCEPTION;
        }
        guQjsRtWrite(r->handle, (int)fd, (const uint8_t *)str, len);
        JS_FreeCString(ctx, str);
        return JS_TRUE;
    }
    bin = rt_extract_bytes(ctx, argv[1], &len, &bin_keepalive);
    if (bin) {
        guQjsRtWrite(r->handle, (int)fd, bin, len);
        JS_FreeValue(ctx, bin_keepalive);
        return JS_TRUE;
    }
    JS_FreeValue(ctx, bin_keepalive);
    str = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!str) {
        return JS_EXCEPTION;
    }
    guQjsRtWrite(r->handle, (int)fd, (const uint8_t *)str, len);
    JS_FreeCString(ctx, str);
    return JS_TRUE;
}

/* __qjs_exit(code) */
static JSValue js_rt_exit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    int32_t code = 0;
    JSValue exc;

    (void)this_val;
    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        if (JS_ToInt32(ctx, &code, argv[0]) < 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            code = 1;
        }
    }
    if (r) {
        r->exited = 1;
        guQjsRtExit(r->handle, (int)code);
    }
    exc = JS_NewInternalError(ctx, "__qjs_exit__");
    JS_SetUncatchableError(ctx, exc);
    return JS_Throw(ctx, exc);
}

/* __qjs_eval_cjs(code, filename) -> returns compiled wrapper function */
static JSValue js_rt_eval_cjs(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *code = NULL;
    size_t code_len = 0;
    const char *filename = "<cjs>";
    int free_file = 0;
    const char *prefix = "(function (exports, require, module, __filename, __dirname) { ";
    const char *suffix = "\n});";
    size_t pre_len, suf_len, total_len;
    char *buf;
    JSValue fn;

    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "__qjs_eval_cjs requires code");
    }
    code = JS_ToCStringLen(ctx, &code_len, argv[0]);
    if (!code) {
        return JS_EXCEPTION;
    }
    if (argc >= 2 && JS_IsString(argv[1])) {
        filename = JS_ToCString(ctx, argv[1]);
        free_file = 1;
    }
    const char *code_ptr = code;
    if (code_len >= 3 && (unsigned char)code_ptr[0] == 0xEF &&
        (unsigned char)code_ptr[1] == 0xBB && (unsigned char)code_ptr[2] == 0xBF) {
        code_ptr += 3;
        code_len -= 3;
    }
    pre_len = strlen(prefix);
    suf_len = strlen(suffix);
    total_len = pre_len + code_len + suf_len;
    buf = (char *)malloc(total_len + 1);
    if (!buf) {
        JS_FreeCString(ctx, code);
        if (free_file && filename) {
            JS_FreeCString(ctx, filename);
        }
        return JS_ThrowOutOfMemory(ctx);
    }
    memcpy(buf, prefix, pre_len);
    memcpy(buf + pre_len, code_ptr, code_len);
    if (code_len >= 2 && buf[pre_len] == '#' && buf[pre_len + 1] == '!') {
        buf[pre_len] = '/';
        buf[pre_len + 1] = '/';
    }
    memcpy(buf + pre_len + code_len, suffix, suf_len);
    buf[total_len] = '\0';

    fn = JS_Eval(ctx, buf, total_len, filename ? filename : "<cjs>", JS_EVAL_TYPE_GLOBAL);
    free(buf);
    JS_FreeCString(ctx, code);
    if (free_file && filename) {
        JS_FreeCString(ctx, filename);
    }
    return fn;
}

/* __qjs_eval_script(code, filename) */
static JSValue js_rt_eval_script(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    const char *code = NULL;
    size_t code_len = 0;
    const char *filename = "<eval>";
    int free_file = 0;
    int prev_intr = 0;
    JSValue res;

    (void)this_val;
    if (argc < 1) {
        return JS_UNDEFINED;
    }
    code = JS_ToCStringLen(ctx, &code_len, argv[0]);
    if (!code) {
        return JS_EXCEPTION;
    }
    if (argc >= 2 && JS_IsString(argv[1])) {
        filename = JS_ToCString(ctx, argv[1]);
        free_file = 1;
    }
    if (r) {
        prev_intr = r->vm_interrupted;
        r->vm_interrupted = 0;
    }
    res = JS_Eval(ctx, code, code_len, filename ? filename : "<eval>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(res)) {
        if (r && r->vm_interrupted && guQjsRtInterrupt(r->handle) == 0) {
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
            res = JS_ThrowPlainError(ctx, "__qjs_vm_timeout__");
        }
    }
    if (r) {
        r->vm_interrupted = prev_intr;
    }
    JS_FreeCString(ctx, code);
    if (free_file && filename) {
        JS_FreeCString(ctx, filename);
    }
    return res;
}

/* __qjs_eval_in_context(code, sandboxObj, filename, ctxId) */
static void rt_sweep_vm_ctxs(QjsRuntime *r)
{
    size_t i, write_idx = 0;
    int idle;
    if (!r || !r->rt) {
        return;
    }
    idle = (!JS_IsJobPending(r->rt) && !rt_has_unhandled(r));
    if (idle) {
        for (i = 0; i < r->vm_ctxs_len; i++) {
            r->vm_ctxs[i].may_have_jobs = 0;
        }
    }
    for (i = 0; i < r->vm_ctxs_len; i++) {
        int ctx_idle = (idle || !r->vm_ctxs[i].may_have_jobs);
        int dead_pin = (ctx_idle && r->vm_ctxs[i].alive_flag != NULL && *(r->vm_ctxs[i].alive_flag) == 0);
        int dead_anon = (ctx_idle && r->vm_ctxs[i].id == 0 && r->vm_ctxs[i].alive_flag == NULL);
        if (dead_pin || dead_anon) {
            if (r->vm_ctxs[i].ctx) {
                JS_FreeContext(r->vm_ctxs[i].ctx);
                r->vm_ctxs[i].ctx = NULL;
            }
            if (r->vm_ctxs[i].alive_flag) {
                free(r->vm_ctxs[i].alive_flag);
                r->vm_ctxs[i].alive_flag = NULL;
            }
            continue;
        }
        if (write_idx != i) {
            r->vm_ctxs[write_idx] = r->vm_ctxs[i];
        }
        write_idx++;
    }
    r->vm_ctxs_len = write_idx;
}

static JSValue js_rt_eval_in_context(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    const char *code = NULL;
    size_t code_len = 0;
    const char *filename = "evalmachine.<anonymous>";
    int free_file = 0;
    int32_t ctx_id = 0;
    int reused = 0;
    int keep_ctx = 0;
    size_t found_idx = 0;
    JSContext *vctx = NULL;
    JSValue vglobal, res;
    JSPropertyEnum *tab = NULL;
    uint32_t tab_len = 0, i;
    int has_sandbox = (argc >= 2 && JS_IsObject(argv[1]));

    (void)this_val;
    if (!r || !r->rt) {
        return JS_ThrowInternalError(ctx, "runtime is gone");
    }
    if (argc < 1) {
        return JS_UNDEFINED;
    }
    code = JS_ToCStringLen(ctx, &code_len, argv[0]);
    if (!code) {
        return JS_EXCEPTION;
    }
    if (argc >= 3 && JS_IsString(argv[2])) {
        filename = JS_ToCString(ctx, argv[2]);
        free_file = 1;
    }
    if (argc >= 4 && JS_IsNumber(argv[3])) {
        JS_ToInt32(ctx, &ctx_id, argv[3]);
    }
    if (ctx_id > 0) {
        for (i = 0; i < r->vm_ctxs_len; i++) {
            if (r->vm_ctxs[i].id == ctx_id && r->vm_ctxs[i].ctx != NULL &&
                (r->vm_ctxs[i].alive_flag == NULL || *(r->vm_ctxs[i].alive_flag) != 0)) {
                vctx = r->vm_ctxs[i].ctx;
                found_idx = i;
                reused = 1;
                keep_ctx = 1;
                break;
            }
        }
    }
    if (!vctx) {
        if (r->vm_ctxs_len >= 64 && (r->vm_ctxs_len % 64) == 0) {
            JS_RunGC(r->rt);
            rt_sweep_vm_ctxs(r);
        }
        if (r->vm_ctxs_len >= 4096) {
            JS_RunGC(r->rt);
            rt_sweep_vm_ctxs(r);
            if (r->vm_ctxs_len >= 4096) {
                JS_FreeCString(ctx, code);
                if (free_file && filename) {
                    JS_FreeCString(ctx, filename);
                }
                return JS_ThrowRangeError(ctx, "maximum VM context limit (4096) exceeded");
            }
        }
        if (r->vm_ctxs_len == r->vm_ctxs_cap) {
            size_t next_cap = r->vm_ctxs_cap == 0 ? 16 : r->vm_ctxs_cap * 2;
            QjsVmContextEntry *next = (QjsVmContextEntry *)realloc(
                r->vm_ctxs, next_cap * sizeof(QjsVmContextEntry));
            if (!next) {
                JS_FreeCString(ctx, code);
                if (free_file && filename) {
                    JS_FreeCString(ctx, filename);
                }
                return JS_ThrowOutOfMemory(ctx);
            }
            r->vm_ctxs = next;
            r->vm_ctxs_cap = next_cap;
        }
        vctx = JS_NewContext(r->rt);
        if (!vctx) {
            JS_FreeCString(ctx, code);
            if (free_file && filename) {
                JS_FreeCString(ctx, filename);
            }
            return JS_ThrowOutOfMemory(ctx);
        }
        JS_SetContextOpaque(vctx, r);
        found_idx = r->vm_ctxs_len++;
        r->vm_ctxs[found_idx].id = -1;
        r->vm_ctxs[found_idx].ctx = vctx;
        r->vm_ctxs[found_idx].alive_flag = NULL;
        r->vm_ctxs[found_idx].may_have_jobs = 1;
        if (ctx_id > 0) {
            keep_ctx = 1;
        }
        vglobal = JS_GetGlobalObject(vctx);
        if (JS_GetOwnPropertyNames(vctx, &tab, &tab_len, vglobal,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
            for (i = 0; i < tab_len; i++) {
                JS_DeleteProperty(vctx, vglobal, tab[i].atom, 0);
            }
            JS_FreePropertyEnum(vctx, tab, tab_len);
            tab = NULL;
            tab_len = 0;
        }
        {
            JSValue mglobal = JS_GetGlobalObject(ctx);
            JSValue mconsole = JS_GetPropertyStr(ctx, mglobal, "console");
            if (JS_IsObject(mconsole)) {
                JS_DefinePropertyValueStr(vctx, vglobal, "console", mconsole,
                                          JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
            } else {
                JS_FreeValue(ctx, mconsole);
            }
            JS_FreeValue(ctx, mglobal);
        }
    } else {
        vglobal = JS_GetGlobalObject(vctx);
    }

    int copy_failed = 0;
    JSPropertyEnum *init_tab = NULL;
    uint32_t init_len = 0;
    JSValue *init_vals = NULL;
    int *init_flags = NULL;

    if (has_sandbox) {
        int is_proxy_sb = JS_IsProxy(argv[1]);
        if (JS_GetOwnPropertyNames(ctx, &tab, &tab_len, argv[1],
                                   JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) == 0) {
            for (i = 0; i < tab_len; i++) {
                if (tab[i].atom == r->vm_pin_atom) {
                    continue;
                }
                JSPropertyDescriptor desc;
                memset(&desc, 0, sizeof(desc));
                int gop = JS_GetOwnProperty(ctx, &desc, argv[1], tab[i].atom);
                if (gop < 0) {
                    copy_failed = 1;
                    break;
                }
                if (gop == 0) {
                    continue;
                }
                if ((desc.flags & JS_PROP_GETSET) != 0 && !is_proxy_sb) {
                    if (JS_IsObject(desc.getter) || JS_IsObject(desc.setter)) {
                        keep_ctx = 1;
                    }
                    JS_FreeValue(ctx, desc.value);
                    int def_flags = (desc.flags & (JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE)) | JS_PROP_CONFIGURABLE;
                    if (JS_DefinePropertyGetSet(vctx, vglobal, tab[i].atom, desc.getter, desc.setter, def_flags) < 0) {
                        JSValue vexc = JS_GetException(vctx);
                        if (JS_IsObject(vexc)) {
                            keep_ctx = 1;
                        }
                        JS_Throw(ctx, vexc);
                        copy_failed = 1;
                        break;
                    }
                } else {
                    JSValue val;
                    JS_FreeValue(ctx, desc.getter);
                    JS_FreeValue(ctx, desc.setter);
                    if (is_proxy_sb) {
                        JS_FreeValue(ctx, desc.value);
                        val = JS_GetProperty(ctx, argv[1], tab[i].atom);
                        if (JS_IsException(val)) {
                            copy_failed = 1;
                            break;
                        }
                    } else {
                        val = desc.value;
                    }
                    if (JS_IsObject(val)) {
                        keep_ctx = 1;
                    }
                    int def_flags = (desc.flags & JS_PROP_C_W_E) | JS_PROP_CONFIGURABLE;
                    if (JS_DefinePropertyValue(vctx, vglobal, tab[i].atom, val, def_flags) < 0) {
                        JSValue vexc = JS_GetException(vctx);
                        if (JS_IsObject(vexc)) {
                            keep_ctx = 1;
                        }
                        JS_Throw(ctx, vexc);
                        copy_failed = 1;
                        break;
                    }
                }
            }
            JS_FreePropertyEnum(ctx, tab, tab_len);
            tab = NULL;
            tab_len = 0;
        } else {
            copy_failed = 1;
        }

        if (!copy_failed) {
            if (JS_GetOwnPropertyNames(vctx, &init_tab, &init_len, vglobal,
                                       JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) == 0 && init_len > 0) {
                init_vals = (JSValue *)malloc(init_len * sizeof(JSValue));
                init_flags = (int *)calloc(init_len, sizeof(int));
                if (init_vals && init_flags) {
                    for (i = 0; i < init_len; i++) {
                        JSPropertyDescriptor d;
                        memset(&d, 0, sizeof(d));
                        init_vals[i] = JS_UNDEFINED;
                        if (JS_GetOwnProperty(vctx, &d, vglobal, init_tab[i].atom) > 0) {
                            init_flags[i] = d.flags;
                            if ((d.flags & JS_PROP_GETSET) == 0) {
                                init_vals[i] = d.value;
                            } else {
                                JS_FreeValue(vctx, d.value);
                            }
                            JS_FreeValue(vctx, d.getter);
                            JS_FreeValue(vctx, d.setter);
                        } else if (JS_HasException(vctx)) {
                            JS_FreeValue(vctx, JS_GetException(vctx));
                        }
                    }
                } else {
                    free(init_vals);
                    init_vals = NULL;
                    free(init_flags);
                    init_flags = NULL;
                }
            }
        }
    }

    int prev_intr = r->vm_interrupted;
    int was_vm_intr = 0;
    if (copy_failed) {
        res = JS_EXCEPTION;
    } else {
        JSValue orig_vproto = JS_UNDEFINED;
        if (has_sandbox && JS_IsProxy(argv[1])) {
            keep_ctx = 1;
            orig_vproto = JS_GetPrototype(vctx, vglobal);
            JS_SetPrototype(vctx, vglobal, argv[1]);
        }
        r->vm_interrupted = 0;
        res = JS_Eval(vctx, code, code_len, filename ? filename : "evalmachine.<anonymous>", JS_EVAL_TYPE_GLOBAL);
        was_vm_intr = r->vm_interrupted;
        r->vm_interrupted = prev_intr;
        if (!JS_IsUndefined(orig_vproto)) {
            JS_SetPrototype(vctx, vglobal, orig_vproto);
            JS_FreeValue(vctx, orig_vproto);
        }
    }

    if (!copy_failed && has_sandbox && !JS_IsException(res)) {
        int is_proxy_sb = JS_IsProxy(argv[1]);
        int sb_extensible = JS_IsExtensible(ctx, argv[1]);
        if (sb_extensible < 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            sb_extensible = 0;
        }
        if (JS_GetOwnPropertyNames(vctx, &tab, &tab_len, vglobal,
                                   JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) == 0) {
            for (i = 0; i < tab_len; i++) {
                if (tab[i].atom == r->vm_pin_atom) {
                    continue;
                }
                JSPropertyDescriptor vdesc;
                memset(&vdesc, 0, sizeof(vdesc));
                int vgop = JS_GetOwnProperty(vctx, &vdesc, vglobal, tab[i].atom);
                if (vgop < 0) {
                    JS_FreeValue(vctx, JS_GetException(vctx));
                    continue;
                }
                if (vgop == 0) {
                    continue;
                }
                int was_init = 0;
                int unchanged = 0;
                if (init_tab && init_vals && init_flags) {
                    uint32_t j;
                    for (j = 0; j < init_len; j++) {
                        if (init_tab[j].atom == tab[i].atom) {
                            was_init = 1;
                            if ((vdesc.flags & JS_PROP_GETSET) != 0 && (init_flags[j] & JS_PROP_GETSET) != 0) {
                                unchanged = 1;
                            } else if ((vdesc.flags & JS_PROP_GETSET) == 0 && (init_flags[j] & JS_PROP_GETSET) == 0) {
                                if (JS_IsSameValue(vctx, vdesc.value, init_vals[j]) &&
                                    (vdesc.flags & JS_PROP_ENUMERABLE) == (init_flags[j] & JS_PROP_ENUMERABLE)) {
                                    unchanged = 1;
                                }
                            }
                            break;
                        }
                    }
                }
                if (unchanged) {
                    JS_FreeValue(vctx, vdesc.value);
                    JS_FreeValue(vctx, vdesc.getter);
                    JS_FreeValue(vctx, vdesc.setter);
                    continue;
                }
                if ((vdesc.flags & JS_PROP_GETSET) != 0) {
                    if (JS_IsObject(vdesc.getter) || JS_IsObject(vdesc.setter)) {
                        keep_ctx = 1;
                    }
                    JS_FreeValue(vctx, vdesc.value);
                    int def_rc = JS_DefinePropertyGetSet(ctx, argv[1], tab[i].atom, vdesc.getter, vdesc.setter, vdesc.flags & JS_PROP_C_W_E);
                    if (def_rc < 0) {
                        JS_FreeValue(ctx, JS_GetException(ctx));
                    }
                    continue;
                }
                JS_FreeValue(vctx, vdesc.getter);
                JS_FreeValue(vctx, vdesc.setter);
                JSValue val = vdesc.value;
                if (JS_IsObject(val)) {
                    keep_ctx = 1;
                }
                if (is_proxy_sb) {
                    if (JS_SetProperty(ctx, argv[1], tab[i].atom, val) < 0) {
                        JS_FreeValue(vctx, res);
                        res = JS_EXCEPTION;
                        copy_failed = 1;
                        break;
                    }
                } else {
                    JSPropertyDescriptor sdesc;
                    memset(&sdesc, 0, sizeof(sdesc));
                    int sgop = JS_GetOwnProperty(ctx, &sdesc, argv[1], tab[i].atom);
                    if (sgop > 0) {
                        int has_setter = !JS_IsUndefined(sdesc.setter);
                        JS_FreeValue(ctx, sdesc.value);
                        JS_FreeValue(ctx, sdesc.getter);
                        JS_FreeValue(ctx, sdesc.setter);
                        if ((sdesc.flags & JS_PROP_GETSET) != 0) {
                            if (has_setter) {
                                if (JS_SetProperty(ctx, argv[1], tab[i].atom, val) < 0) {
                                    JS_FreeValue(ctx, JS_GetException(ctx));
                                }
                            } else {
                                JS_FreeValue(ctx, val);
                            }
                        } else if ((sdesc.flags & JS_PROP_WRITABLE) != 0 || (sdesc.flags & JS_PROP_CONFIGURABLE) != 0) {
                            int target_flags = ((sdesc.flags & JS_PROP_CONFIGURABLE) != 0)
                                ? (vdesc.flags & JS_PROP_C_W_E)
                                : (sdesc.flags & JS_PROP_C_W_E);
                            if (JS_DefinePropertyValue(ctx, argv[1], tab[i].atom, val, target_flags) < 0) {
                                JS_FreeValue(ctx, JS_GetException(ctx));
                            }
                        } else {
                            JS_FreeValue(ctx, val);
                        }
                    } else {
                        if (sgop < 0) {
                            JS_FreeValue(ctx, JS_GetException(ctx));
                        }
                        if (sb_extensible) {
                            int def_flags = was_init ? (vdesc.flags & JS_PROP_C_W_E) : (vdesc.flags & JS_PROP_C_W_E);
                            if (JS_DefinePropertyValue(ctx, argv[1], tab[i].atom, val, def_flags) < 0) {
                                JS_FreeValue(ctx, JS_GetException(ctx));
                            }
                        } else {
                            JS_FreeValue(ctx, val);
                        }
                    }
                }
            }
            JS_FreePropertyEnum(vctx, tab, tab_len);
            tab = NULL;
            tab_len = 0;
        } else {
            JSValue vexc = JS_GetException(vctx);
            if (JS_IsObject(vexc)) {
                keep_ctx = 1;
            }
            JS_FreeValue(vctx, res);
            res = JS_EXCEPTION;
            JS_Throw(ctx, vexc);
            copy_failed = 1;
        }
    }

    if (init_tab) {
        if (init_vals) {
            for (i = 0; i < init_len; i++) {
                JS_FreeValue(vctx, init_vals[i]);
            }
            free(init_vals);
        }
        if (init_flags) {
            free(init_flags);
        }
        JS_FreePropertyEnum(vctx, init_tab, init_len);
    }

    JSValue exc_pin_target = JS_UNDEFINED;
    if (!copy_failed && JS_IsException(res)) {
        JSValue exc = JS_GetException(vctx);
        int is_intr = (was_vm_intr && guQjsRtInterrupt(r->handle) == 0);
        if (is_intr) {
            JS_FreeValue(vctx, exc);
            JS_ThrowPlainError(ctx, "__qjs_vm_timeout__");
        } else {
            if (JS_IsObject(exc)) {
                keep_ctx = 1;
                exc_pin_target = JS_DupValue(ctx, exc);
            }
            JS_Throw(ctx, exc);
        }
    } else if (!JS_IsException(res) && JS_IsObject(res)) {
        keep_ctx = 1;
    }
    int has_pending = (JS_IsJobPending(r->rt) || rt_has_unhandled(r));
    if (has_pending) {
        keep_ctx = 1;
        if (reused && found_idx < r->vm_ctxs_len) {
            r->vm_ctxs[found_idx].may_have_jobs = 1;
        }
    }

    JS_FreeValue(vctx, vglobal);
    if (!reused) {
        size_t slot_idx = r->vm_ctxs_len;
        for (i = 0; i < r->vm_ctxs_len; i++) {
            if (r->vm_ctxs[i].ctx == vctx) {
                slot_idx = i;
                break;
            }
        }
        if (keep_ctx && slot_idx < r->vm_ctxs_len) {
            int *alive_flag = NULL;
            if (r->vm_pin_atom != JS_ATOM_NULL && r->vm_pin_class_id != 0) {
                alive_flag = (int *)malloc(sizeof(int));
                if (alive_flag) {
                    JSValue saved_exc = JS_UNDEFINED;
                    int had_exc = JS_HasException(ctx);
                    if (had_exc) {
                        saved_exc = JS_GetException(ctx);
                    }
                    JSValue pin;
                    *alive_flag = 1;
                    pin = JS_NewObjectClass(ctx, r->vm_pin_class_id);
                    if (!JS_IsException(pin)) {
                        int pinned = 0;
                        int def_rc;
                        JS_SetOpaque(pin, alive_flag);
                        if (has_sandbox && JS_IsObject(argv[1])) {
                            def_rc = JS_DefinePropertyValue(ctx, argv[1], r->vm_pin_atom, JS_DupValue(ctx, pin), 0);
                            if (def_rc < 0) {
                                JS_FreeValue(ctx, JS_GetException(ctx));
                            } else if (def_rc > 0) {
                                pinned = 1;
                            }
                        } else if (!JS_IsException(res) && JS_IsObject(res)) {
                            def_rc = JS_DefinePropertyValue(ctx, res, r->vm_pin_atom, JS_DupValue(ctx, pin), 0);
                            if (def_rc < 0) {
                                JS_FreeValue(ctx, JS_GetException(ctx));
                            } else if (def_rc > 0) {
                                pinned = 1;
                            }
                        } else if (JS_IsObject(exc_pin_target)) {
                            def_rc = JS_DefinePropertyValue(ctx, exc_pin_target, r->vm_pin_atom, JS_DupValue(ctx, pin), 0);
                            if (def_rc < 0) {
                                JS_FreeValue(ctx, JS_GetException(ctx));
                            } else if (def_rc > 0) {
                                pinned = 1;
                            }
                        }
                        JS_FreeValue(ctx, pin);
                        if (!pinned) {
                            free(alive_flag);
                            alive_flag = NULL;
                        }
                    } else {
                        JS_FreeValue(ctx, JS_GetException(ctx));
                        free(alive_flag);
                        alive_flag = NULL;
                    }
                    if (had_exc) {
                        JS_Throw(ctx, saved_exc);
                    }
                }
            }
            r->vm_ctxs[slot_idx].id = ctx_id;
            r->vm_ctxs[slot_idx].ctx = vctx;
            r->vm_ctxs[slot_idx].alive_flag = alive_flag;
            r->vm_ctxs[slot_idx].may_have_jobs = has_pending;
        } else {
            if (slot_idx < r->vm_ctxs_len) {
                if (slot_idx + 1 < r->vm_ctxs_len) {
                    memmove(&r->vm_ctxs[slot_idx], &r->vm_ctxs[slot_idx + 1],
                            (r->vm_ctxs_len - slot_idx - 1) * sizeof(QjsVmContextEntry));
                }
                r->vm_ctxs_len--;
            }
            JS_FreeContext(vctx);
        }
    }
    JS_FreeValue(ctx, exc_pin_target);
    JS_FreeCString(ctx, code);
    if (free_file && filename) {
        JS_FreeCString(ctx, filename);
    }
    return res;
}

static QjsEsmEntry *rt_find_esm(QjsRuntime *r, const char *name)
{
    size_t i;
    if (!r || !name || !*name) {
        return NULL;
    }
    for (i = 0; i < r->esm_mods_len; i++) {
        if (r->esm_mods[i].name && strcmp(r->esm_mods[i].name, name) == 0) {
            return &r->esm_mods[i];
        }
    }
    return NULL;
}

static QjsEsmEntry *rt_register_esm(QjsRuntime *r, const char *name, JSModuleDef *m, int has_tla, int state)
{
    QjsEsmEntry *existing;
    if (!r || !name || !*name) {
        return NULL;
    }
    existing = rt_find_esm(r, name);
    if (existing) {
        if (m) {
            existing->m = m;
        }
        if (has_tla) {
            existing->has_tla = 1;
        }
        if (state > existing->state) {
            existing->state = state;
        }
        return existing;
    }
    if (r->esm_mods_len == r->esm_mods_cap) {
        size_t next_cap = r->esm_mods_cap == 0 ? 16 : r->esm_mods_cap * 2;
        QjsEsmEntry *next = (QjsEsmEntry *)realloc(r->esm_mods, next_cap * sizeof(QjsEsmEntry));
        if (!next) {
            return NULL;
        }
        r->esm_mods = next;
        r->esm_mods_cap = next_cap;
    }
    r->esm_mods[r->esm_mods_len].name = gu_strdup(name);
    r->esm_mods[r->esm_mods_len].m = m;
    r->esm_mods[r->esm_mods_len].has_tla = has_tla;
    r->esm_mods[r->esm_mods_len].state = state;
    r->esm_mods_len++;
    return &r->esm_mods[r->esm_mods_len - 1];
}

static JSValue js_rt_esm_mark_done(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv,
                                   int magic, JSValue *func_data)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    const char *mname = NULL;
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    if (r && func_data && JS_IsString(func_data[0])) {
        mname = JS_ToCString(ctx, func_data[0]);
        if (mname) {
            QjsEsmEntry *entry = rt_find_esm(r, mname);
            if (entry) {
                entry->state = 2;
            }
            JS_FreeCString(ctx, mname);
        }
    }
    return JS_UNDEFINED;
}

static int rt_is_ident_char(unsigned char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || c == '_' || c == '$';
}

/* Scans syntactically valid ES module source to detect top-level await. */
static int rt_source_has_tla(const char *src, size_t len)
{
    size_t i = 0;
    int brace_depth = 0;
    int paren_depth = 0;
    int fn_brace_stack[128];
    int fn_brace_top = 0;
    int fn_expr_brace[128];
    int fn_expr_paren[128];
    int fn_expr_top = 0;
    int pending_fn_body = 0;
    int after_dot = 0;
    int in_import_export_spec = 0;
    int can_be_regex = 1;

    while (i < len) {
        unsigned char c = (unsigned char)src[i];
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            i++;
            continue;
        }
        if (c == '/' && i + 1 < len && src[i + 1] == '/') {
            i += 2;
            while (i < len && src[i] != '\n') i++;
            continue;
        }
        if (c == '/' && i + 1 < len && src[i + 1] == '*') {
            i += 2;
            while (i + 1 < len && !(src[i] == '*' && src[i + 1] == '/')) i++;
            if (i + 1 < len) i += 2;
            else i = len;
            continue;
        }
        if (c == '/' && can_be_regex) {
            int in_class = 0;
            i++;
            while (i < len) {
                unsigned char rc = (unsigned char)src[i];
                if (rc == '\\') {
                    i += 2;
                    continue;
                }
                if (rc == '[') {
                    in_class = 1;
                    i++;
                    continue;
                }
                if (rc == ']') {
                    in_class = 0;
                    i++;
                    continue;
                }
                if (rc == '/' && !in_class) {
                    i++;
                    while (i < len && rt_is_ident_char((unsigned char)src[i])) i++;
                    break;
                }
                if (rc == '\n' || rc == '\r') {
                    break;
                }
                i++;
            }
            after_dot = 0;
            can_be_regex = 0;
            continue;
        }
        if (c == '\'' || c == '"' || c == '`') {
            unsigned char q = c;
            i++;
            while (i < len) {
                if (src[i] == '\\') {
                    i += 2;
                    continue;
                }
                if (src[i] == (char)q) {
                    i++;
                    break;
                }
                i++;
            }
            after_dot = 0;
            can_be_regex = 0;
            continue;
        }
        if (c == '.') {
            after_dot = 1;
            can_be_regex = 0;
            i++;
            continue;
        }
        if (c == '(') {
            paren_depth++;
            if (pending_fn_body == 1) {
                int p = 1;
                i++;
                while (i < len && p > 0) {
                    if (src[i] == '/' && i + 1 < len && src[i + 1] == '/') {
                        i += 2;
                        while (i < len && src[i] != '\n') i++;
                        continue;
                    }
                    if (src[i] == '/' && i + 1 < len && src[i + 1] == '*') {
                        i += 2;
                        while (i + 1 < len && !(src[i] == '*' && src[i + 1] == '/')) i++;
                        if (i + 1 < len) i += 2;
                        else i = len;
                        continue;
                    }
                    if (src[i] == '\'' || src[i] == '"' || src[i] == '`') {
                        char q = src[i++];
                        while (i < len) {
                            if (src[i] == '\\') { i += 2; continue; }
                            if (src[i] == q) { i++; break; }
                            i++;
                        }
                        continue;
                    }
                    if (src[i] == '(') p++;
                    else if (src[i] == ')') p--;
                    i++;
                }
                paren_depth--;
                pending_fn_body = 2;
                after_dot = 0;
                can_be_regex = 0;
                continue;
            }
            after_dot = 0;
            can_be_regex = 1;
            i++;
            continue;
        }
        if (c == ')') {
            while (fn_expr_top > 0 && paren_depth <= fn_expr_paren[fn_expr_top - 1] &&
                   brace_depth <= fn_expr_brace[fn_expr_top - 1]) {
                fn_expr_top--;
            }
            if (paren_depth > 0) paren_depth--;
            after_dot = 0;
            can_be_regex = 0;
            i++;
            continue;
        }
        if (c == '{') {
            if (pending_fn_body > 0) {
                if (fn_brace_top < 128) {
                    fn_brace_stack[fn_brace_top++] = brace_depth;
                }
                pending_fn_body = 0;
            }
            brace_depth++;
            after_dot = 0;
            can_be_regex = 1;
            i++;
            continue;
        }
        if (c == '}') {
            if (brace_depth > 0) brace_depth--;
            in_import_export_spec = 0;
            while (fn_brace_top > 0 && fn_brace_stack[fn_brace_top - 1] == brace_depth) {
                fn_brace_top--;
            }
            while (fn_expr_top > 0 && brace_depth < fn_expr_brace[fn_expr_top - 1]) {
                fn_expr_top--;
            }
            after_dot = 0;
            can_be_regex = 1;
            i++;
            continue;
        }
        if (c == ';' || c == ',') {
            while (fn_expr_top > 0 && paren_depth == fn_expr_paren[fn_expr_top - 1] &&
                   brace_depth == fn_expr_brace[fn_expr_top - 1]) {
                fn_expr_top--;
            }
            after_dot = 0;
            can_be_regex = 1;
            i++;
            continue;
        }
        if (c == '=' && i + 1 < len && src[i + 1] == '>') {
            i += 2;
            while (i < len && (src[i] == ' ' || src[i] == '\t' || src[i] == '\r' || src[i] == '\n')) i++;
            if (i < len && src[i] == '{') {
                pending_fn_body = 2;
            } else if (pending_fn_body > 0) {
                if (fn_expr_top < 128) {
                    fn_expr_brace[fn_expr_top] = brace_depth;
                    fn_expr_paren[fn_expr_top] = paren_depth;
                    fn_expr_top++;
                }
                pending_fn_body = 0;
            }
            after_dot = 0;
            can_be_regex = 1;
            continue;
        }
        if (rt_is_ident_char(c)) {
            size_t start = i;
            size_t tok_len;
            while (i < len && rt_is_ident_char((unsigned char)src[i])) i++;
            tok_len = i - start;
            can_be_regex = 0;
            if (!after_dot) {
                if ((tok_len == 6 && memcmp(src + start, "import", 6) == 0) ||
                    (tok_len == 6 && memcmp(src + start, "export", 6) == 0)) {
                    size_t k = i;
                    while (k < len && (src[k] == ' ' || src[k] == '\t' || src[k] == '\r' || src[k] == '\n')) k++;
                    if (k < len && src[k] == '{') {
                        in_import_export_spec = 1;
                    }
                    can_be_regex = 1;
                } else if (tok_len == 5 && memcmp(src + start, "async", 5) == 0) {
                    pending_fn_body = 1;
                } else if (tok_len == 8 && memcmp(src + start, "function", 8) == 0) {
                    pending_fn_body = 1;
                } else if (tok_len == 5 && memcmp(src + start, "await", 5) == 0 && !in_import_export_spec) {
                    size_t k = i;
                    while (k < len && (src[k] == ' ' || src[k] == '\t' || src[k] == '\r' || src[k] == '\n')) k++;
                    if (k >= len || src[k] != ':') {
                        if (fn_brace_top == 0 && fn_expr_top == 0) {
                            return 1;
                        }
                    }
                    can_be_regex = 1;
                } else if ((tok_len == 6 && memcmp(src + start, "return", 6) == 0) ||
                           (tok_len == 5 && memcmp(src + start, "throw", 5) == 0) ||
                           (tok_len == 4 && memcmp(src + start, "case", 4) == 0) ||
                           (tok_len == 6 && memcmp(src + start, "delete", 6) == 0) ||
                           (tok_len == 4 && memcmp(src + start, "void", 4) == 0) ||
                           (tok_len == 6 && memcmp(src + start, "typeof", 6) == 0) ||
                           (tok_len == 10 && memcmp(src + start, "instanceof", 10) == 0) ||
                           (tok_len == 2 && memcmp(src + start, "in", 2) == 0) ||
                           (tok_len == 2 && memcmp(src + start, "of", 2) == 0) ||
                           (tok_len == 3 && memcmp(src + start, "new", 3) == 0) ||
                           (tok_len == 5 && memcmp(src + start, "yield", 5) == 0) ||
                           (tok_len == 7 && memcmp(src + start, "default", 7) == 0) ||
                           (tok_len == 4 && memcmp(src + start, "else", 4) == 0) ||
                           (tok_len == 2 && memcmp(src + start, "do", 2) == 0)) {
                    can_be_regex = 1;
                }
            }
            after_dot = 0;
            continue;
        }
        if ((c == '+' || c == '-') && i + 1 < len && src[i + 1] == (char)c) {
            after_dot = 0;
            i += 2;
            continue;
        }
        can_be_regex = (c != ']');
        after_dot = 0;
        i++;
    }
    return 0;
}

static JSValue rt_compile_esm_with_hooks(JSContext *ctx, const char *buf, size_t code_len, const char *mod_name)
{
    const char *suffix = "\n;import.meta.__done&&import.meta.__done();";
    size_t suf_len = strlen(suffix);
    char *wbuf = (char *)malloc(code_len + suf_len + 1);
    JSValue compiled;
    if (!wbuf) {
        return JS_Eval(ctx, buf, code_len, mod_name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    }
    memcpy(wbuf, buf, code_len);
    memcpy(wbuf + code_len, suffix, suf_len);
    wbuf[code_len + suf_len] = '\0';
    compiled = JS_Eval(ctx, wbuf, code_len + suf_len, mod_name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(wbuf);
    if (JS_IsException(compiled)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_Eval(ctx, buf, code_len, mod_name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    }
    return compiled;
}

static void rt_extract_err_code(const char *err, char *code_buf, size_t cap)
{
    size_t i = 0;
    if (err && strncmp(err, "ERR_", 4) == 0) {
        while (err[i] && err[i] != ':' && err[i] != ' ' && i + 1 < cap) {
            char c = err[i];
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
                code_buf[i++] = c;
            } else {
                break;
            }
        }
        if (i > 4 && err[i] == ':') {
            code_buf[i] = '\0';
            return;
        }
    }
    snprintf(code_buf, cap, "%s", "ERR_MODULE_NOT_FOUND");
}

static JSValue rt_throw_code_error(JSContext *ctx, const char *code, const char *msg)
{
    JSValue err_obj = JS_NewPlainError(ctx, "%s", msg ? msg : code);
    if (JS_IsObject(err_obj)) {
        JS_SetPropertyStr(ctx, err_obj, "code", JS_NewString(ctx, code));
    }
    return JS_Throw(ctx, err_obj);
}

static void rt_set_import_meta(JSContext *ctx, QjsRuntime *r, JSModuleDef *m,
                               const char *url, const char *filename,
                               const char *dirname, int is_main)
{
    JSValue meta = JS_GetImportMeta(ctx, m);
    if (JS_IsException(meta)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }
    if (JS_IsObject(meta)) {
        if (url) {
            JS_DefinePropertyValueStr(ctx, meta, "url", JS_NewString(ctx, url), JS_PROP_C_W_E);
        }
        if (filename) {
            JS_DefinePropertyValueStr(ctx, meta, "filename", JS_NewString(ctx, filename), JS_PROP_C_W_E);
            {
                JSValue mname_val = JS_NewString(ctx, filename);
                JSValue done_fn = JS_NewCFunctionData(ctx, js_rt_esm_mark_done, 0, 0, 1, &mname_val);
                JS_FreeValue(ctx, mname_val);
                if (!JS_IsException(done_fn)) {
                    JS_DefinePropertyValueStr(ctx, meta, "__done", done_fn, 0);
                } else {
                    JS_FreeValue(ctx, JS_GetException(ctx));
                }
            }
        }
        if (dirname) {
            JS_DefinePropertyValueStr(ctx, meta, "dirname", JS_NewString(ctx, dirname), JS_PROP_C_W_E);
        }
        JS_DefinePropertyValueStr(ctx, meta, "main", JS_NewBool(ctx, is_main != 0), JS_PROP_C_W_E);
        if (r && JS_IsFunction(ctx, r->require_fn)) {
            JS_DefinePropertyValueStr(ctx, meta, "__require", JS_DupValue(ctx, r->require_fn), 0);
            {
                JSValue make_res = JS_GetPropertyStr(ctx, r->require_fn, "makeMetaResolve");
                if (JS_IsFunction(ctx, make_res)) {
                    JSValue farg = filename ? JS_NewString(ctx, filename) : JS_UNDEFINED;
                    JSValue res_fn = JS_Call(ctx, make_res, r->require_fn, 1, &farg);
                    JS_FreeValue(ctx, farg);
                    if (!JS_IsException(res_fn)) {
                        JS_DefinePropertyValueStr(ctx, meta, "resolve", res_fn, JS_PROP_C_W_E);
                    } else {
                        JS_FreeValue(ctx, JS_GetException(ctx));
                    }
                } else if (JS_IsException(make_res)) {
                    JS_FreeValue(ctx, JS_GetException(ctx));
                }
                JS_FreeValue(ctx, make_res);
            }
        }
    }
    JS_FreeValue(ctx, meta);
}

/* __qjs_require_esm(code, filename, fileURL, dirname) -> returns module namespace */
static JSValue js_rt_require_esm(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    const char *code = NULL, *filename = "<esm>", *file_url = NULL, *dirname = NULL;
    size_t code_len = 0;
    int free_file = 0, free_url = 0, free_dir = 0;
    char *buf = NULL;
    JSValue compiled, eval_res, ns;
    JSModuleDef *m;
    JSPromiseStateEnum st;
    QjsEsmEntry *existing = NULL;
    int self_tla = 0;

    (void)this_val;
    if (!r || !r->rt) {
        return JS_ThrowInternalError(ctx, "runtime is gone");
    }
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "__qjs_require_esm requires code");
    }
    if (argc >= 2 && JS_IsString(argv[1])) {
        filename = JS_ToCString(ctx, argv[1]);
        free_file = 1;
    }
    existing = rt_find_esm(r, filename);
    if (existing && existing->m) {
        if (existing->has_tla) {
            if (free_file && filename) JS_FreeCString(ctx, filename);
            return rt_throw_code_error(ctx, "ERR_REQUIRE_ASYNC_MODULE",
                "require() cannot be used on an ESM graph with top-level await. Use import() instead.");
        }
        if (existing->state == 2) {
            ns = JS_GetModuleNamespace(ctx, existing->m);
            if (free_file && filename) JS_FreeCString(ctx, filename);
            return ns;
        }
        if (existing->state == 1) {
            if (free_file && filename) JS_FreeCString(ctx, filename);
            return rt_throw_code_error(ctx, "ERR_REQUIRE_CYCLE_MODULE",
                "Cannot require() ES Module in a cycle.");
        }
        existing->state = 1;
        eval_res = JS_EvalFunction(ctx, JS_DupValue(ctx, JS_MKPTR(JS_TAG_MODULE, existing->m)));
        if (free_file && filename) JS_FreeCString(ctx, filename);
        if (JS_IsException(eval_res)) {
            return JS_EXCEPTION;
        }
        st = JS_PromiseState(ctx, eval_res);
        if (st == JS_PROMISE_REJECTED) {
            JSValue reason = JS_PromiseResult(ctx, eval_res);
            rt_remove_unhandled(r, eval_res);
            JS_FreeValue(ctx, eval_res);
            return JS_Throw(ctx, reason);
        }
        if (st == JS_PROMISE_PENDING) {
            existing->has_tla = 1;
            rt_remove_unhandled(r, eval_res);
            JS_FreeValue(ctx, eval_res);
            return rt_throw_code_error(ctx, "ERR_REQUIRE_ASYNC_MODULE",
                "require() cannot be used on an ESM graph with top-level await. Use import() instead.");
        }
        rt_remove_unhandled(r, eval_res);
        JS_FreeValue(ctx, eval_res);
        if (existing->state != 2) {
            existing->state = 0;
            return rt_throw_code_error(ctx, "ERR_REQUIRE_CYCLE_MODULE",
                "Cannot require() ES Module in a cycle.");
        }
        return JS_GetModuleNamespace(ctx, existing->m);
    }

    code = JS_ToCStringLen(ctx, &code_len, argv[0]);
    if (!code) {
        if (free_file && filename) JS_FreeCString(ctx, filename);
        return JS_EXCEPTION;
    }
    if (argc >= 3 && JS_IsString(argv[2])) {
        file_url = JS_ToCString(ctx, argv[2]);
        free_url = 1;
    }
    if (argc >= 4 && JS_IsString(argv[3])) {
        dirname = JS_ToCString(ctx, argv[3]);
        free_dir = 1;
    }
    buf = (char *)malloc(code_len + 1);
    if (!buf) {
        JS_FreeCString(ctx, code);
        if (free_file && filename) JS_FreeCString(ctx, filename);
        if (free_url && file_url) JS_FreeCString(ctx, file_url);
        if (free_dir && dirname) JS_FreeCString(ctx, dirname);
        return JS_ThrowOutOfMemory(ctx);
    }
    if (code_len >= 3 && (unsigned char)code[0] == 0xEF &&
        (unsigned char)code[1] == 0xBB && (unsigned char)code[2] == 0xBF) {
        memcpy(buf, code + 3, code_len - 3);
        code_len -= 3;
    } else {
        memcpy(buf, code, code_len);
    }
    buf[code_len] = '\0';
    if (code_len >= 2 && buf[0] == '#' && buf[1] == '!') {
        buf[0] = '/';
        buf[1] = '/';
    }
    JS_FreeCString(ctx, code);

    self_tla = rt_source_has_tla(buf, code_len);
    compiled = rt_compile_esm_with_hooks(ctx, buf, code_len, filename ? filename : "<esm>");
    free(buf);
    if (JS_IsException(compiled)) {
        if (free_file && filename) JS_FreeCString(ctx, filename);
        if (free_url && file_url) JS_FreeCString(ctx, file_url);
        if (free_dir && dirname) JS_FreeCString(ctx, dirname);
        return JS_EXCEPTION;
    }
    if (JS_VALUE_GET_TAG(compiled) != JS_TAG_MODULE) {
        JS_FreeValue(ctx, compiled);
        if (free_file && filename) JS_FreeCString(ctx, filename);
        if (free_url && file_url) JS_FreeCString(ctx, file_url);
        if (free_dir && dirname) JS_FreeCString(ctx, dirname);
        return JS_ThrowInternalError(ctx, "module did not compile to a module");
    }
    m = (JSModuleDef *)JS_VALUE_GET_PTR(compiled);
    rt_set_import_meta(ctx, r, m, file_url, filename, dirname, 0);
    existing = rt_register_esm(r, filename, m, self_tla, 0);
    if (free_file && filename) JS_FreeCString(ctx, filename);
    if (free_url && file_url) JS_FreeCString(ctx, file_url);
    if (free_dir && dirname) JS_FreeCString(ctx, dirname);

    r->esm_graph_has_tla = self_tla;
    if (JS_ResolveModule(ctx, compiled) < 0) {
        JS_FreeValue(ctx, compiled);
        return JS_EXCEPTION;
    }
    if (r->esm_graph_has_tla) {
        if (existing) {
            existing->has_tla = 1;
        }
        JS_FreeValue(ctx, compiled);
        return rt_throw_code_error(ctx, "ERR_REQUIRE_ASYNC_MODULE",
            "require() cannot be used on an ESM graph with top-level await. Use import() instead.");
    }

    if (existing) {
        existing->state = 1;
    }
    eval_res = JS_EvalFunction(ctx, compiled);
    if (JS_IsException(eval_res)) {
        return JS_EXCEPTION;
    }
    st = JS_PromiseState(ctx, eval_res);
    if (st == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx, eval_res);
        rt_remove_unhandled(r, eval_res);
        JS_FreeValue(ctx, eval_res);
        return JS_Throw(ctx, reason);
    }
    if (st == JS_PROMISE_PENDING) {
        if (existing) {
            existing->has_tla = 1;
        }
        rt_remove_unhandled(r, eval_res);
        JS_FreeValue(ctx, eval_res);
        return rt_throw_code_error(ctx, "ERR_REQUIRE_ASYNC_MODULE",
            "require() cannot be used on an ESM graph with top-level await. Use import() instead.");
    }
    rt_remove_unhandled(r, eval_res);
    JS_FreeValue(ctx, eval_res);
    if (existing) {
        existing->state = 2;
    }
    ns = JS_GetModuleNamespace(ctx, m);
    return ns;
}

static JSValue js_rt_is_proxy(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) {
        return JS_FALSE;
    }
    return JS_NewBool(ctx, JS_IsProxy(argv[0]));
}

static JSValue js_rt_set_promise_hook(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRuntime *r = (QjsRuntime *)JS_GetContextOpaque(ctx);
    (void)this_val;
    if (!r || !r->rt) {
        return JS_UNDEFINED;
    }
    JS_FreeValue(ctx, r->promise_hook_fn);
    if (argc >= 1 && JS_IsFunction(ctx, argv[0])) {
        r->promise_hook_fn = JS_DupValue(ctx, argv[0]);
        JS_SetPromiseHook(r->rt, rt_promise_hook, r);
    } else {
        r->promise_hook_fn = JS_UNDEFINED;
        JS_SetPromiseHook(r->rt, NULL, NULL);
    }
    return JS_UNDEFINED;
}

static char *rt_module_normalize(JSContext *ctx, const char *module_base_name,
                                 const char *module_name, void *opaque)
{
    QjsRuntime *r = (QjsRuntime *)opaque;
    char *resolved = NULL;
    char *err = NULL;
    char *ret = NULL;

    if (!r) {
        JS_ThrowInternalError(ctx, "runtime is gone");
        return NULL;
    }
    if (ctx != r->ctx) {
        JS_ThrowTypeError(ctx, "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING: A dynamic import callback was not specified.");
        return NULL;
    }
    if (guQjsRtModuleNormalize(r->handle, module_base_name ? module_base_name : "",
                               module_name ? module_name : "", &resolved, &err) != 0) {
        char code_buf[64];
        rt_extract_err_code(err, code_buf, sizeof(code_buf));
        rt_throw_code_error(ctx, code_buf, err ? err : "ERR_MODULE_NOT_FOUND: cannot resolve module");
        free(err);
        free(resolved);
        return NULL;
    }
    ret = js_strdup(ctx, resolved ? resolved : module_name);
    free(resolved);
    free(err);
    return ret;
}

static JSModuleDef *rt_module_loader(JSContext *ctx, const char *module_name, void *opaque)
{
    QjsRuntime *r = (QjsRuntime *)opaque;
    char *src = NULL;
    size_t src_len = 0;
    char *file_url = NULL;
    char *filename = NULL;
    char *dirname = NULL;
    char *err = NULL;
    JSValue compiled;
    JSModuleDef *m;
    QjsEsmEntry *existing;
    int self_tla = 0;

    if (!r) {
        JS_ThrowInternalError(ctx, "runtime is gone");
        return NULL;
    }
    if (ctx != r->ctx) {
        JS_ThrowTypeError(ctx, "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING: A dynamic import callback was not specified.");
        return NULL;
    }
    existing = rt_find_esm(r, module_name);
    if (existing && existing->m) {
        if (existing->has_tla) {
            r->esm_graph_has_tla = 1;
        }
        return existing->m;
    }
    if (guQjsRtModuleLoad(r->handle, module_name, &src, &src_len,
                          &file_url, &filename, &dirname, &err) != 0) {
        char code_buf[64];
        rt_extract_err_code(err, code_buf, sizeof(code_buf));
        rt_throw_code_error(ctx, code_buf, err ? err : "ERR_MODULE_NOT_FOUND: module not found");
        free(src);
        free(file_url);
        free(filename);
        free(dirname);
        free(err);
        return NULL;
    }
    free(err);
    if (!src) {
        free(file_url);
        free(filename);
        free(dirname);
        JS_ThrowInternalError(ctx, "module %s has no source", module_name);
        return NULL;
    }
    if (src_len >= 3 && (unsigned char)src[0] == 0xEF &&
        (unsigned char)src[1] == 0xBB && (unsigned char)src[2] == 0xBF) {
        memmove(src, src + 3, src_len - 3);
        src_len -= 3;
        src[src_len] = '\0';
    }
    if (src_len >= 2 && src[0] == '#' && src[1] == '!') {
        src[0] = '/';
        src[1] = '/';
    }
    self_tla = rt_source_has_tla(src, src_len);
    if (self_tla) {
        r->esm_graph_has_tla = 1;
    }
    compiled = rt_compile_esm_with_hooks(ctx, src, src_len, module_name);
    free(src);
    if (JS_IsException(compiled)) {
        free(file_url);
        free(filename);
        free(dirname);
        return NULL;
    }
    if (JS_VALUE_GET_TAG(compiled) != JS_TAG_MODULE) {
        JS_FreeValue(ctx, compiled);
        free(file_url);
        free(filename);
        free(dirname);
        JS_ThrowInternalError(ctx, "module %s did not compile to a module", module_name);
        return NULL;
    }
    m = (JSModuleDef *)JS_VALUE_GET_PTR(compiled);
    rt_set_import_meta(ctx, r, m, file_url, filename ? filename : module_name, dirname, 0);
    rt_register_esm(r, module_name, m, self_tla, 0);
    if (filename && strcmp(filename, module_name) != 0) {
        rt_register_esm(r, filename, m, self_tla, 0);
    }
    free(file_url);
    free(filename);
    free(dirname);
    JS_FreeValue(ctx, compiled);
    return m;
}

QjsRuntime *qjs_rt_new(uintptr_t handle, size_t memory_limit,
                       const char *prelude, size_t prelude_len, char **err)
{
    QjsRuntime *r;
    JSRuntime *rt;
    JSContext *ctx;
    JSValue global, script;

    if (err) {
        *err = NULL;
    }
    r = (QjsRuntime *)calloc(1, sizeof(*r));
    if (!r) {
        if (err) {
            *err = gu_strdup("out of memory");
        }
        return NULL;
    }
    r->handle = handle;
    r->dispatch_fn = JS_UNDEFINED;
    r->after_microtasks_fn = JS_UNDEFINED;
    r->check_loop_fn = JS_UNDEFINED;
    r->unhandled_rejection_fn = JS_UNDEFINED;
    r->uncaught_exception_fn = JS_UNDEFINED;
    r->require_fn = JS_UNDEFINED;
    r->cjs_main_args = JS_UNDEFINED;
    r->promise_hook_fn = JS_UNDEFINED;
    r->main_promise = JS_UNDEFINED;

    rt = JS_NewRuntime();
    if (!rt) {
        free(r);
        if (err) {
            *err = gu_strdup("could not create QuickJS runtime");
        }
        return NULL;
    }
    r->rt = rt;
    JS_UpdateStackTop(rt);
    JS_SetMemoryLimit(rt, memory_limit > 0 ? memory_limit : RT_DEFAULT_MEMORY_LIMIT);
    JS_SetMaxStackSize(rt, RT_MAX_STACK);
    JS_SetInterruptHandler(rt, rt_interrupt, r);
    JS_SetHostPromiseRejectionTracker(rt, rt_promise_rejection_tracker, r);
    JS_SetModuleLoaderFunc(rt, rt_module_normalize, rt_module_loader, r);

    ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        free(r);
        if (err) {
            *err = gu_strdup("could not create QuickJS context");
        }
        return NULL;
    }
    r->ctx = ctx;
    JS_SetContextOpaque(ctx, r);

    global = JS_GetGlobalObject(ctx);
    JS_NewClassID(rt, &r->vm_pin_class_id);
    JS_NewClass(rt, r->vm_pin_class_id, &rt_vm_pin_class_def);
    {
        JSValue sym = JS_Eval(ctx, "Symbol('vm_pin')", 16, "<vm>", JS_EVAL_TYPE_GLOBAL);
        if (!JS_IsException(sym)) {
            r->vm_pin_atom = JS_ValueToAtom(ctx, sym);
            if (r->vm_pin_atom == JS_ATOM_NULL && JS_HasException(ctx)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
            } else {
                JSValue set_rc = JS_DupValue(ctx, sym);
                if (JS_SetPropertyStr(ctx, global, "__qjs_vm_pin_sym", set_rc) < 0 && JS_HasException(ctx)) {
                    JS_FreeValue(ctx, JS_GetException(ctx));
                }
            }
        } else {
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
        JS_FreeValue(ctx, sym);
    }
    JS_SetPropertyStr(ctx, global, "__qjs_host_call",
                      JS_NewCFunction(ctx, js_rt_host_call, "__qjs_host_call", 3));
    JS_SetPropertyStr(ctx, global, "__qjs_write_fd",
                      JS_NewCFunction(ctx, js_rt_write_fd, "__qjs_write_fd", 2));
    JS_SetPropertyStr(ctx, global, "__qjs_exit",
                      JS_NewCFunction(ctx, js_rt_exit, "__qjs_exit", 1));
    JS_SetPropertyStr(ctx, global, "__qjs_eval_cjs",
                      JS_NewCFunction(ctx, js_rt_eval_cjs, "__qjs_eval_cjs", 2));
    JS_SetPropertyStr(ctx, global, "__qjs_eval_script",
                      JS_NewCFunction(ctx, js_rt_eval_script, "__qjs_eval_script", 2));
    JS_SetPropertyStr(ctx, global, "__qjs_eval_in_context",
                      JS_NewCFunction(ctx, js_rt_eval_in_context, "__qjs_eval_in_context", 3));
    JS_SetPropertyStr(ctx, global, "__qjs_require_esm",
                      JS_NewCFunction(ctx, js_rt_require_esm, "__qjs_require_esm", 4));
    JS_SetPropertyStr(ctx, global, "__qjs_set_promise_hook",
                      JS_NewCFunction(ctx, js_rt_set_promise_hook, "__qjs_set_promise_hook", 1));
    JS_SetPropertyStr(ctx, global, "__qjs_is_proxy",
                      JS_NewCFunction(ctx, js_rt_is_proxy, "__qjs_is_proxy", 1));
    JS_FreeValue(ctx, global);

    if (prelude && prelude_len > 0) {
        script = JS_Eval(ctx, prelude, prelude_len, "<runtime prelude>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(script)) {
            if (err) {
                *err = gu_error_text(ctx);
            }
            JS_FreeValue(ctx, script);
            qjs_rt_free(r);
            return NULL;
        }
        JS_FreeValue(ctx, script);
    }

    global = JS_GetGlobalObject(ctx);
    r->dispatch_fn = JS_GetPropertyStr(ctx, global, "__qjs_dispatch");
    r->after_microtasks_fn = JS_GetPropertyStr(ctx, global, "__qjs_after_microtasks");
    r->check_loop_fn = JS_GetPropertyStr(ctx, global, "__qjs_check_loop");
    r->unhandled_rejection_fn = JS_GetPropertyStr(ctx, global, "__qjs_unhandled_rejection");
    r->uncaught_exception_fn = JS_GetPropertyStr(ctx, global, "__qjs_uncaught_exception");
    r->require_fn = JS_GetPropertyStr(ctx, global, "__qjs_require");
    r->cjs_main_args = JS_GetPropertyStr(ctx, global, "__qjs_cjs_main_args");
    rt_delete_global_prop(ctx, global, "__qjs_dispatch");
    rt_delete_global_prop(ctx, global, "__qjs_after_microtasks");
    rt_delete_global_prop(ctx, global, "__qjs_check_loop");
    rt_delete_global_prop(ctx, global, "__qjs_unhandled_rejection");
    rt_delete_global_prop(ctx, global, "__qjs_uncaught_exception");
    rt_delete_global_prop(ctx, global, "__qjs_require");
    rt_delete_global_prop(ctx, global, "__qjs_cjs_main_args");
    rt_delete_global_prop(ctx, global, "__qjs_require_esm");
    rt_delete_global_prop(ctx, global, "__qjs_set_promise_hook");
    rt_delete_global_prop(ctx, global, "__qjs_is_proxy");
    rt_delete_global_prop(ctx, global, "__qjs_builtins");
    JS_FreeValue(ctx, global);

    return r;
}

int qjs_rt_pump(QjsRuntime *r, char **err)
{
    JSContext *ctx;
    JSContext *pctx = NULL;
    int rc;

    if (err) {
        *err = NULL;
    }
    if (!r || !r->ctx) {
        return 1;
    }
    if (r->exited) {
        return 0;
    }
    JS_UpdateStackTop(r->rt);
    ctx = r->ctx;

pump_loop:
    for (;;) {
        if (r->exited) {
            return 0;
        }
        if (JS_IsFunction(ctx, r->after_microtasks_fn)) {
            JSValue job_pending = JS_NewBool(ctx, JS_IsJobPending(r->rt));
            JSValue tick_res = JS_Call(ctx, r->after_microtasks_fn, JS_UNDEFINED, 1, &job_pending);
            JS_FreeValue(ctx, job_pending);
            if (JS_IsException(tick_res)) {
                if (rt_try_recover(r, err) == 0) {
                    continue;
                }
                return 1;
            }
            int had_work = JS_ToBool(ctx, tick_res);
            JS_FreeValue(ctx, tick_res);
            if (had_work > 0) {
                continue;
            }
        }
        if (r->exited) {
            return 0;
        }
        if (JS_IsJobPending(r->rt)) {
            while (JS_IsJobPending(r->rt)) {
                int has_hook = JS_IsFunction(ctx, r->promise_hook_fn);
                if (has_hook) {
                    rt_promise_hook(ctx, (JSPromiseHookType)4, JS_UNDEFINED, JS_UNDEFINED, r);
                }
                rc = JS_ExecutePendingJob(r->rt, &pctx);
                if (has_hook) {
                    rt_promise_hook(ctx, (JSPromiseHookType)5, JS_UNDEFINED, JS_UNDEFINED, r);
                }
                if (rc < 0) {
                    if (rt_try_recover(r, err) == 0) {
                        continue;
                    }
                    return 1;
                }
                if (r->exited) {
                    return 0;
                }
            }
            continue;
        }
        break;
    }

    if (!JS_IsUndefined(r->main_promise)) {
        JSPromiseStateEnum st = JS_PromiseState(ctx, r->main_promise);
        if (st == JS_PROMISE_REJECTED) {
            JSValue reason = JS_PromiseResult(ctx, r->main_promise);
            rt_remove_unhandled(r, r->main_promise);
            JS_FreeValue(ctx, r->main_promise);
            r->main_promise = JS_UNDEFINED;
            if (r->exited) {
                JS_FreeValue(ctx, reason);
                return 0;
            }
            JS_Throw(ctx, reason);
            if (rt_try_recover(r, err) == 0) {
                goto pump_loop;
            }
            return 1;
        } else if (st == JS_PROMISE_FULFILLED) {
            rt_remove_unhandled(r, r->main_promise);
            JS_FreeValue(ctx, r->main_promise);
            r->main_promise = JS_UNDEFINED;
        }
    }

    while (r->unhandled_head < r->unhandled_len) {
        QjsUnhandledEntry entry;
        size_t pick = r->unhandled_head;
        while (pick < r->unhandled_len && JS_IsUndefined(r->unhandled[pick].promise)) {
            pick++;
        }
        r->unhandled_head = pick;
        if (pick >= r->unhandled_len) {
            r->unhandled_head = 0;
            r->unhandled_len = 0;
            break;
        }
        if (!JS_IsUndefined(r->main_promise) &&
            JS_VALUE_GET_PTR(r->unhandled[pick].promise) == JS_VALUE_GET_PTR(r->main_promise)) {
            size_t next_pick = pick + 1;
            while (next_pick < r->unhandled_len && JS_IsUndefined(r->unhandled[next_pick].promise)) {
                next_pick++;
            }
            if (next_pick >= r->unhandled_len) {
                break;
            }
            entry = r->unhandled[next_pick];
            r->unhandled[next_pick].promise = JS_UNDEFINED;
            r->unhandled[next_pick].reason = JS_UNDEFINED;
        } else {
            entry = r->unhandled[pick];
            r->unhandled[pick].promise = JS_UNDEFINED;
            r->unhandled[pick].reason = JS_UNDEFINED;
            r->unhandled_head = pick + 1;
            if (r->unhandled_head >= r->unhandled_len) {
                r->unhandled_head = 0;
                r->unhandled_len = 0;
            }
        }

        if (r->exited) {
            JS_FreeValue(ctx, entry.promise);
            JS_FreeValue(ctx, entry.reason);
            return 0;
        }
        if (JS_IsFunction(ctx, r->unhandled_rejection_fn)) {
            JSValue uargs[2] = { entry.reason, entry.promise };
            JSValue ures = JS_Call(ctx, r->unhandled_rejection_fn, JS_UNDEFINED, 2, uargs);
            if (JS_IsException(ures)) {
                JS_FreeValue(ctx, entry.promise);
                JS_FreeValue(ctx, entry.reason);
                if (rt_try_recover(r, err) == 0) {
                    goto pump_loop;
                }
                return 1;
            }
            int handled = JS_ToBool(ctx, ures);
            JS_FreeValue(ctx, ures);
            if (handled > 0) {
                JS_FreeValue(ctx, entry.promise);
                JS_FreeValue(ctx, entry.reason);
                goto pump_loop;
            }
        }
        JS_FreeValue(ctx, entry.promise);
        JS_Throw(ctx, entry.reason);
        if (rt_try_recover(r, err) == 0) {
            goto pump_loop;
        }
        return 1;
    }

    if (!JS_IsJobPending(r->rt) && !rt_has_unhandled(r)) {
        size_t vi;
        for (vi = 0; vi < r->vm_ctxs_len; vi++) {
            r->vm_ctxs[vi].may_have_jobs = 0;
        }
        if (r->vm_ctxs_len >= 64) {
            rt_sweep_vm_ctxs(r);
        }
    }

    return 0;
}

static int rt_has_suffix(const char *s, const char *suffix)
{
    size_t slen, suflen;
    if (!s || !suffix) {
        return 0;
    }
    slen = strlen(s);
    suflen = strlen(suffix);
    if (slen < suflen) {
        return 0;
    }
    return memcmp(s + slen - suflen, suffix, suflen) == 0;
}

static JSValue rt_compile_cjs_main(JSContext *ctx, const char *code, size_t code_len, const char *filename)
{
    const char *prefix = "(async function (exports, require, module, __filename, __dirname) { ";
    const char *suffix = "\n})";
    size_t pre_len = strlen(prefix);
    size_t suf_len = strlen(suffix);
    size_t total_len = pre_len + code_len + suf_len;
    char *wbuf = (char *)malloc(total_len + 1);
    JSValue fn;
    if (!wbuf) {
        return JS_ThrowOutOfMemory(ctx);
    }
    memcpy(wbuf, prefix, pre_len);
    memcpy(wbuf + pre_len, code, code_len);
    memcpy(wbuf + pre_len + code_len, suffix, suf_len);
    wbuf[total_len] = '\0';
    fn = JS_Eval(ctx, wbuf, total_len, filename ? filename : "<eval>", JS_EVAL_TYPE_GLOBAL);
    free(wbuf);
    return fn;
}

int qjs_rt_eval(QjsRuntime *r, const char *filename, const char *src,
                size_t srclen, int is_esm, char **err)
{
    JSContext *ctx;
    char *buf;
    int is_module = 0;
    JSValue result = JS_UNDEFINED;

    if (err) {
        *err = NULL;
    }
    if (!r || !r->ctx) {
        if (err) {
            *err = gu_strdup("no runtime");
        }
        return 1;
    }
    JS_UpdateStackTop(r->rt);
    ctx = r->ctx;
    buf = (char *)malloc(srclen + 1);
    if (!buf) {
        if (err) {
            *err = gu_strdup("out of memory");
        }
        return 1;
    }
    if (srclen >= 3 && (unsigned char)src[0] == 0xEF &&
        (unsigned char)src[1] == 0xBB && (unsigned char)src[2] == 0xBF) {
        memcpy(buf, src + 3, srclen - 3);
        srclen -= 3;
    } else {
        memcpy(buf, src, srclen);
    }
    buf[srclen] = '\0';
    if (srclen >= 2 && buf[0] == '#' && buf[1] == '!') {
        buf[0] = '/';
        buf[1] = '/';
    }

    JSValue precompiled_mod = JS_UNDEFINED;
    JSValue precompiled_cjs_fn = JS_UNDEFINED;
    if (is_esm > 0 || rt_has_suffix(filename, ".mjs")) {
        is_module = 1;
    } else if (is_esm == 0 || rt_has_suffix(filename, ".cjs")) {
        is_module = 0;
    } else {
        JSValue probe = rt_compile_cjs_main(ctx, buf, srclen, filename);
        if (JS_IsException(probe)) {
            JSValue orig_exc = JS_GetException(ctx);
            JSValue mprobe = rt_compile_esm_with_hooks(ctx, buf, srclen, filename);
            if (!JS_IsException(mprobe)) {
                precompiled_mod = mprobe;
                JS_FreeValue(ctx, orig_exc);
                is_module = 1;
            } else {
                JS_FreeValue(ctx, JS_GetException(ctx));
                JS_Throw(ctx, orig_exc);
                free(buf);
                return rt_fail(r, err);
            }
        } else {
            precompiled_cjs_fn = probe;
            is_module = 0;
        }
    }

    if (is_module) {
        int main_tla = rt_source_has_tla(buf, srclen);
        JSValue global = JS_GetGlobalObject(ctx);
        {
            JSValue req_obj = JS_GetPropertyStr(ctx, global, "require");
            if (JS_IsObject(req_obj)) {
                JSValue cache_obj = JS_GetPropertyStr(ctx, req_obj, "cache");
                if (JS_IsObject(cache_obj) && filename) {
                    rt_delete_global_prop(ctx, cache_obj, filename);
                }
                JS_FreeValue(ctx, cache_obj);
                JS_SetPropertyStr(ctx, req_obj, "main", JS_UNDEFINED);
            }
            JS_FreeValue(ctx, req_obj);
        }
        rt_delete_global_prop(ctx, global, "require");
        rt_delete_global_prop(ctx, global, "module");
        rt_delete_global_prop(ctx, global, "exports");
        rt_delete_global_prop(ctx, global, "__dirname");
        rt_delete_global_prop(ctx, global, "__filename");
        JS_FreeValue(ctx, global);

        JSValue mod = !JS_IsUndefined(precompiled_mod)
            ? precompiled_mod
            : rt_compile_esm_with_hooks(ctx, buf, srclen, filename);
        free(buf);
        if (JS_IsException(mod)) {
            return rt_fail(r, err);
        }
        if (JS_VALUE_GET_TAG(mod) == JS_TAG_MODULE) {
            JSModuleDef *m = (JSModuleDef *)JS_VALUE_GET_PTR(mod);
            char *file_url = NULL, *fn = NULL, *dn = NULL, *merr = NULL;
            if (guQjsRtModuleLoad(r->handle, "__main_meta__", NULL, NULL,
                                  &file_url, &fn, &dn, &merr) == 0) {
                rt_set_import_meta(ctx, r, m, file_url, fn ? fn : filename, dn, 1);
                if (fn) {
                    rt_register_esm(r, fn, m, main_tla, 1);
                    if (JS_IsFunction(ctx, r->require_fn)) {
                        JSValue cache_obj = JS_GetPropertyStr(ctx, r->require_fn, "cache");
                        if (JS_IsObject(cache_obj)) {
                            rt_delete_global_prop(ctx, cache_obj, fn);
                        }
                        JS_FreeValue(ctx, cache_obj);
                    }
                }
            }
            if (filename) {
                rt_register_esm(r, filename, m, main_tla, 1);
            }
            free(file_url);
            free(fn);
            free(dn);
            free(merr);
        }
        result = JS_EvalFunction(ctx, mod);
    } else {
        JSValue global = JS_GetGlobalObject(ctx);
        rt_delete_global_prop(ctx, global, "require");
        rt_delete_global_prop(ctx, global, "module");
        rt_delete_global_prop(ctx, global, "exports");
        rt_delete_global_prop(ctx, global, "__dirname");
        rt_delete_global_prop(ctx, global, "__filename");
        JS_FreeValue(ctx, global);

        JSValue fn = !JS_IsUndefined(precompiled_cjs_fn)
            ? precompiled_cjs_fn
            : rt_compile_cjs_main(ctx, buf, srclen, filename);
        free(buf);
        if (JS_IsException(fn)) {
            return rt_fail(r, err);
        }
        {
            JSValue cargs[5];
            int k;
            for (k = 0; k < 5; k++) {
                cargs[k] = JS_IsObject(r->cjs_main_args)
                    ? JS_GetPropertyUint32(ctx, r->cjs_main_args, (uint32_t)k)
                    : JS_UNDEFINED;
            }
            result = JS_Call(ctx, fn, cargs[0], 5, cargs);
            for (k = 0; k < 5; k++) {
                JS_FreeValue(ctx, cargs[k]);
            }
            JS_FreeValue(ctx, fn);
        }
    }

    if (JS_IsException(result)) {
        return rt_fail(r, err);
    }
    if (!JS_IsUndefined(r->main_promise)) {
        rt_remove_unhandled(r, r->main_promise);
        JS_FreeValue(ctx, r->main_promise);
    }
    r->main_promise = result;
    return qjs_rt_pump(r, err);
}

int qjs_rt_dispatch(QjsRuntime *r, int32_t id, int32_t kind,
                    const char *json, size_t json_len,
                    const uint8_t *bin, size_t bin_len, char **err)
{
    JSContext *ctx;
    JSValue args[4];
    JSValue res;

    if (err) {
        *err = NULL;
    }
    if (!r || !r->ctx) {
        return 1;
    }
    if (r->exited) {
        return 0;
    }
    JS_UpdateStackTop(r->rt);
    ctx = r->ctx;
    if (!JS_IsFunction(ctx, r->dispatch_fn)) {
        return qjs_rt_pump(r, err);
    }
    args[0] = JS_NewInt32(ctx, id);
    args[1] = JS_NewInt32(ctx, kind);
    args[2] = json ? JS_NewStringLen(ctx, json, json_len) : JS_NULL;
    args[3] = bin ? JS_NewUint8ArrayCopy(ctx, bin, bin_len) : JS_NULL;

    res = JS_Call(ctx, r->dispatch_fn, JS_UNDEFINED, 4, args);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[2]);
    JS_FreeValue(ctx, args[3]);
    if (JS_IsException(res)) {
        return rt_fail(r, err);
    }
    JS_FreeValue(ctx, res);
    return qjs_rt_pump(r, err);
}

int qjs_rt_check_loop(QjsRuntime *r, int32_t phase, int32_t *out_val, char **err)
{
    JSContext *ctx;
    JSValue args[2], res;
    int32_t v = 0;
    int32_t unsettled = 0;

    if (out_val) {
        *out_val = 0;
    }
    if (err) {
        *err = NULL;
    }
    if (!r || !r->ctx) {
        return 1;
    }
    if (r->exited) {
        return 0;
    }
    JS_UpdateStackTop(r->rt);
    ctx = r->ctx;
    if (!JS_IsFunction(ctx, r->check_loop_fn)) {
        return 0;
    }
    if (!JS_IsUndefined(r->main_promise) &&
        JS_PromiseState(ctx, r->main_promise) == JS_PROMISE_PENDING) {
        unsettled = 1;
    }
    args[0] = JS_NewInt32(ctx, phase);
    args[1] = JS_NewInt32(ctx, unsettled);
    res = JS_Call(ctx, r->check_loop_fn, JS_UNDEFINED, 2, args);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    if (JS_IsException(res)) {
        return rt_fail(r, err);
    }
    JS_ToInt32(ctx, &v, res);
    JS_FreeValue(ctx, res);
    if (phase != 2) {
        if (qjs_rt_pump(r, err) != 0) {
            return 1;
        }
        if (phase == 1 && v == 0 && !r->exited) {
            int32_t unsettled_after = 0;
            if (!JS_IsUndefined(r->main_promise) &&
                JS_PromiseState(ctx, r->main_promise) == JS_PROMISE_PENDING) {
                unsettled_after = 1;
            }
            args[0] = JS_NewInt32(ctx, 0);
            args[1] = JS_NewInt32(ctx, unsettled_after);
            res = JS_Call(ctx, r->check_loop_fn, JS_UNDEFINED, 2, args);
            JS_FreeValue(ctx, args[0]);
            JS_FreeValue(ctx, args[1]);
            if (JS_IsException(res)) {
                return rt_fail(r, err);
            }
            JS_ToInt32(ctx, &v, res);
            JS_FreeValue(ctx, res);
        }
    }
    if (out_val) {
        *out_val = v;
    }
    return 0;
}

void qjs_rt_free(QjsRuntime *r)
{
    size_t i;
    if (!r) {
        return;
    }
    if (r->ctx) {
        for (i = r->unhandled_head; i < r->unhandled_len; i++) {
            JS_FreeValue(r->ctx, r->unhandled[i].promise);
            JS_FreeValue(r->ctx, r->unhandled[i].reason);
        }
        if (r->vm_pin_atom != JS_ATOM_NULL) {
            JS_FreeAtom(r->ctx, r->vm_pin_atom);
            r->vm_pin_atom = JS_ATOM_NULL;
        }
        JS_FreeValue(r->ctx, r->dispatch_fn);
        JS_FreeValue(r->ctx, r->after_microtasks_fn);
        JS_FreeValue(r->ctx, r->check_loop_fn);
        JS_FreeValue(r->ctx, r->unhandled_rejection_fn);
        JS_FreeValue(r->ctx, r->uncaught_exception_fn);
        JS_FreeValue(r->ctx, r->require_fn);
        JS_FreeValue(r->ctx, r->cjs_main_args);
        JS_FreeValue(r->ctx, r->promise_hook_fn);
        JS_FreeValue(r->ctx, r->main_promise);
        JS_FreeContext(r->ctx);
        r->ctx = NULL;
    }
    for (i = 0; i < r->vm_ctxs_len; i++) {
        if (r->vm_ctxs[i].ctx) {
            JS_FreeContext(r->vm_ctxs[i].ctx);
            r->vm_ctxs[i].ctx = NULL;
        }
    }
    if (r->rt) {
        JS_FreeRuntime(r->rt);
        r->rt = NULL;
    }
    for (i = 0; i < r->vm_ctxs_len; i++) {
        free(r->vm_ctxs[i].alive_flag);
    }
    for (i = 0; i < r->esm_mods_len; i++) {
        free(r->esm_mods[i].name);
    }
    free(r->esm_mods);
    free(r->vm_ctxs);
    free(r->unhandled);
    free(r);
}
