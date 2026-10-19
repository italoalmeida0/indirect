/* shim.h declares the C half of the QuickJS host used by packages/qjs.
   One QjsRun owns one runtime plus one context and evaluates exactly one ES
   module (a skill file): the Go side answers module resolution, module
   source and require() through exported callbacks, and the prelude installs
   the sandbox surface (require, skill.extend, __gu_snapshot). */
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

#endif /* INDIRECT_QJS_SHIM_H */
