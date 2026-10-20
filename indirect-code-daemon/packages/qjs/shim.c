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
extern int guQjsModuleSource(uintptr_t handle, const char *name, char **out_src, char **out_err);
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
    if (JS_IsError(exc)) {
        msg = JS_GetPropertyStr(ctx, exc, "message");
        if (JS_IsString(msg)) {
            cmsg = JS_ToCString(ctx, msg);
        }
        stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (JS_IsString(stack)) {
            cstack = JS_ToCString(ctx, stack);
        }
        if (cstack && cmsg && strstr(cstack, cmsg)) {
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
    } else {
        cmsg = JS_ToCString(ctx, exc);
        out = gu_strdup(cmsg ? cmsg : "unknown error");
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
    JSValue compiled;
    JSModuleDef *m;

    if (!run) {
        JS_ThrowInternalError(ctx, "module sandbox is gone");
        return NULL;
    }
    if (guQjsModuleSource(run->handle, module_name, &src, &err) != 0) {
        JS_ThrowInternalError(ctx, "%s", err ? err : "module not found");
        free(err);
        free(src);
        return NULL;
    }
    if (!src) {
        JS_ThrowInternalError(ctx, "module %s has no source", module_name);
        return NULL;
    }
    compiled = JS_Eval(ctx, src, strlen(src), module_name,
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
