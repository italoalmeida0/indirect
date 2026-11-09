/* shim.h declares the C half of the QuickJS host used by packages/qjs.
   One QjsRun owns one runtime plus one context and evaluates one ES module
   graph rooted at a skill file: imports (`import base from
   "skill:agentic_base"`) are resolved by the Go side through an exported
   callback and linked into that same context, and the prelude installs the
   snapshot boundary (__gu_snapshot). */
#ifndef INDIRECT_QJS_SHIM_H
#define INDIRECT_QJS_SHIM_H

#include <stddef.h>
#include <stdint.h>

typedef struct QjsRun QjsRun;

/* qjs_new creates the runtime and context for one module evaluation.
   handle identifies the Go-side evaluation state; prelude is the sandbox
   script evaluated before any module (may be NULL). On failure it returns
   NULL and stores a malloc'ed message in *err. */
QjsRun *qjs_new(uintptr_t handle, const char *prelude, char **err);

/* qjs_eval_module evaluates src as an ES module named name and returns the
   JSON snapshot of its default export in *out_json (malloc'ed). On failure
   it returns non-zero and stores a malloc'ed message in *err. */
int qjs_eval_module(QjsRun *run, const char *name, const char *src,
                    size_t srclen, char **out_json, char **err);

/* qjs_free_run releases the context and the runtime. */
void qjs_free_run(QjsRun *run);

/* qjs_free_str frees strings handed to Go by this shim. */
void qjs_free_str(char *s);

/* QjsRuntime owns one full script runtime (Node.js/Web/Shell surface) used by
   exec_script and --js. The restricted skill sandbox above (QjsRun) remains
   completely separate. */
typedef struct QjsRuntime QjsRuntime;

/* qjs_rt_new creates a script runtime with full intrinsics, native host call
   bridges, module loader, and evaluates runtime_prelude.js. */
QjsRuntime *qjs_rt_new(uintptr_t handle, size_t memory_limit,
                       const char *prelude, size_t prelude_len, char **err);

/* qjs_rt_eval evaluates an entry script (supporting both ES modules and
   top-level await global scripts). is_esm: 1 = force ESM, 0 = force CJS,
   -1 = auto-detect. Returns 0 on success, non-zero on error. */
int qjs_rt_eval(QjsRuntime *rt, const char *filename, const char *src,
                size_t srclen, int is_esm, char **err);

/* qjs_rt_pump drains the QuickJS microtask queue (JS_ExecutePendingJob) and
   checks whether the entry promise or an unhandled rejection failed.
   Returns 0 on ok, non-zero on error. */
int qjs_rt_pump(QjsRuntime *rt, char **err);

/* qjs_rt_dispatch invokes globalThis.__qjs_dispatch(id, kind, json, bin) for
   an async completion event from Go and drains microtasks. */
int qjs_rt_dispatch(QjsRuntime *rt, int32_t id, int32_t kind,
                    const char *json, size_t json_len,
                    const uint8_t *bin, size_t bin_len, char **err);

/* qjs_rt_check_loop invokes globalThis.__qjs_check_loop(phase) and drains
   microtasks. Returns the integer result via *out_val, and 0 on success or
   non-zero on uncaught JS exception. */
int qjs_rt_check_loop(QjsRuntime *rt, int32_t phase, int32_t *out_val, char **err);

/* qjs_rt_free releases all values, context, and runtime. */
void qjs_rt_free(QjsRuntime *rt);

#endif /* INDIRECT_QJS_SHIM_H */
