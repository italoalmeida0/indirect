/* shim.c is the C half of packages/qjs: it owns one QuickJS runtime plus
   context per module evaluation and exposes the three primitives the Go
   loader needs — create a sandbox, evaluate one ES module, tear down. The
   sandbox prelude (installed here, written in JS) owns require() and
   skill.extend(); module resolution, module evaluation and every limit live
   on the Go side, reached through the guQjsRequire/guQjsInterrupt exports.

   Nothing in this file re-implements QuickJS: it only wires the public API
   (no eval intrinsic, no host modules, no file or process access). */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "shim.h"

/* Exported by the Go side (package qjs). guQjsRequire resolves and
   evaluates one module on the loader's goroutine and answers with the JSON
   snapshot of its default export; guQjsInterrupt answers non-zero once the
   module deadline has passed. */
extern int guQjsRequire(uintptr_t handle, const char *name, char **out_json, char **out_err);
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

/* gu_js_require is the sandbox's require(): the Go loader resolves the name
   against the skill set (declared name first, then file stem), evaluates the
   target in its own fresh VM and answers with the snapshot of its default
   export. Each call materializes a NEW object tree, so callers may mutate
   the result freely — the cached snapshot and other skills never see it. */
static JSValue gu_js_require(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QjsRun *run;
    const char *name;
    char *json = NULL, *err = NULL;
    JSValue out;

    (void)this_val;
    run = (QjsRun *)JS_GetContextOpaque(ctx);
    if (!run) {
        return JS_ThrowInternalError(ctx, "module sandbox is gone");
    }
    if (argc < 1 || !JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "module name must be a string");
    }
    name = JS_ToCString(ctx, argv[0]);
    if (!name) {
        return JS_EXCEPTION;
    }
    if (guQjsRequire(run->handle, name, &json, &err) != 0) {
        JSValue exc = JS_ThrowInternalError(ctx, "%s", err ? err : "require failed");
        free(err);
        free(json);
        JS_FreeCString(ctx, name);
        return exc;
    }
    JS_FreeCString(ctx, name);
    if (!json) {
        return JS_ThrowInternalError(ctx, "require returned no module");
    }
    out = JS_ParseJSON(ctx, json, strlen(json), "<skill module>");
    free(json);
    return out;
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
       require and the snapshot, Promise is required by the module
       machinery, RegExp, BigInt and Map/Set keep ordinary authoring
       comfortable. */
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

    global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "require", JS_NewCFunction(ctx, gu_js_require, "require", 1));
    JS_FreeValue(ctx, global);

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

/* qjs_module_export evaluates one ES module and returns the snapshot of its
   default export. The module name is used for stack traces only; resolution
   happens through the Go loader. */
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
