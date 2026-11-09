# packages/qjs — QuickJS late link

QuickJS powers two distinct, isolated execution modes in Indirect Code:
1. **Skill sandbox (`EvalModule`)**: pure, zero-I/O evaluation of skill `.js` modules (see `packages/skills`).
2. **Script runtime (`RunScript`)**: full Node.js / WinterCG Web / shell (`$`) runtime for the `exec_script` agent tool and `--js` CLI role.

The engine is **not built here**: `lib/<platform>/libquickjs.a` holds a prebuilt static archive
per shipped platform, and the `link_<os>_<arch>.go` files select it through
cgo `LDFLAGS`. Nothing in this repo compiles QuickJS source; `shim.c` is the
only C we compile, and it is thin.

```
lib/quickjs.h                     engine header (quickjs-ng)
lib/<platform>/libquickjs.a       prebuilt engine: quickjs.o, libregexp.o,
                                  libunicode.o, dtoa.o
lib/<platform>/libresolv.a        (macOS only) tiny Mach-O archive defining
                                  res_9_* — see "Cross links" below
lib/macos_frameworks/*.framework  stub .tbd descriptors for the frameworks
                                  Go's crypto/x509 links on darwin
lib/macos_link_stubs/<platform>/  resolver stub used by cross links
shim.c / shim.h                   C bridge for both modes (pure skill sandbox
                                  AND full script runtime + event loop pump)
prelude.js                        skill sandbox JS surface: no host API at all,
                                  only the plain-data snapshot boundary and the
                                  removal of the dynamic-code surface
qjs.go / qjs_export.go            Go side of the skill sandbox bridge
runtime_prelude.js                script runtime JS surface: Node.js core
                                  builtins, WinterCG Web globals, CJS require,
                                  and the $ shell tagged template
runtime.go / runtime_host.go      Go side of the script runtime: event loop,
                                  ESM/CJS loader, JailRoots path guard, and
                                  native Go host ops (fs, crypto, zlib, http,
                                  https, net, dns, child_process, os, process)
```

Platform keys: `x86_64_linux_musl`, `aarch64_linux_musl`, `x86_64_macos`,
`aarch64_macos`, `x86_64_windows_gnu`, `aarch64_windows_gnu`.

## How a skill module runs (`EvalModule`)

One `EvalModule` call is one module graph:

1. `qjs_new` creates the runtime and context, evaluates `prelude.js`, and
   installs `JS_SetModuleLoaderFunc` with `gu_module_normalize` /
   `gu_module_loader`.
2. The root module is compiled as an ES module (`JS_EVAL_TYPE_MODULE`) and
   evaluated. Every `import` it performs is normalized **verbatim** (never
   joined onto a path) and answered by the Go side:
   - `guQjsModuleEdge(handle, base, name)` records the import graph and
     refuses the edge that would close a cycle (`a -> b -> a`);
   - `guQjsModuleSource(handle, name)` asks the loader for that module's
     source, which is compiled into the **same** context.
   So a graph shares one VM, one deadline and one memory limit, and
   `import base from "skill:agentic_base"` is an ordinary ES module import —
   the skill composes with spread and concatenation in JavaScript, and Go
   never merges skill objects.
3. Only `skill:<name>` resolves. `node:fs`, a bare package name, a relative
   or absolute path and a `skill:` name containing a path separator are
   rejected with the reason; there is no filesystem in the sandbox to reach.
4. The default export of the ROOT module crosses the snapshot boundary as
   plain JSON data (functions, symbols, class instances, accessors, cycles
   and non-finite numbers are refused, with a size budget).

## How the script runtime runs (`RunScript`)

`RunScript(ctx, ScriptOptions)` creates an isolated `qjs_rt` instance (`qjs_rt_new`) that is completely separate from `EvalModule`:

1. `qjs_rt_new` creates a fresh QuickJS runtime and context, installs the host promise rejection tracker and ESM module loader (`rt_module_normalize` / `rt_module_loader`), evaluates `runtime_prelude.js`, captures internal dispatch hooks in C (`fn_dispatch`, `fn_check_loop`, `fn_after_microtasks`, `fn_unhandled_rejection`, `fn_uncaught_exception`, `fn_require`, `builtins_obj`), and deletes the internal `__qjs_*` dispatch/lifecycle hooks from `globalThis` before user code runs.
2. User code is evaluated as an ES module (with top-level `await`, `import`, `import.meta.url`/`dirname`/`filename`, plus CJS `require`/`__dirname`/`__filename` globals), with a classic-script fallback if the snippet is not module syntax; in `--js -p` mode, the expression is wrapped in an `async` IIFE and printed to stdout.
3. A single-threaded Go/C event loop drains microtasks (`JS_ExecutePendingJob`), `process.nextTick`, unhandled promise rejections, and asynchronous completions from Go worker goroutines (timers, `fetch`, `http`/`https` servers, `net` sockets/servers, `child_process`, `$` commands) via `qjs_rt_dispatch` until no active handles remain or `process.exit()` / context cancellation occurs.
4. When `ScriptOptions.JailRoots` is non-empty (set by the `exec_script` tool unless `/unjail` is active), `checkPath` canonicalizes paths and symlinks and confines all host-level filesystem ops, module resolution (including `package.json` and `node_modules` walks), and `process.chdir` to the allowed roots, while `ScriptOptions.ReadOnlyRoots` rejects mutating filesystem and shell operations inside read-only roots (such as the project workspace during `plan` or `learning` sessions). When jailed, `child_process` and `$` commands run inside a Go-controlled POSIX shell evaluator (supporting built-in POSIX utilities, jailed `.sh`/`.js` scripts, `node` via `--js` with inherited `JailRoots`/`ReadOnlyRoots`, and argument-sanitized `git` with hooks/fsmonitor disabled) and `checkSpawnReqPaths` inspects both command lines and piped stdin before execution. `crypto.subtle` supports `SHA-1`/`256`/`384`/`512`, `HMAC`, `AES-GCM`/`CBC`/`CTR`, `PBKDF2`, `HKDF`, `ECDSA` (`P-256`/`384`/`521`), `Ed25519`, `RSASSA-PKCS1-v1_5`, `RSA-PSS`, and `RSA-OAEP` (and rejects unsupported algorithms with `NotSupportedError`). `node:vm` provides an isolated QuickJS global realm (`JS_NewContext`, with dynamic `import()` disabled unless a callback is supplied) for script evaluation within the same runtime, separate from the pure `EvalModule` skill sandbox.
5. The multi-call binary exposes this runtime to the agent via the `runner` (`Spec.Kind == "exec_script"`) and to child processes via `indirect-code --js [-e|-p|file.js|-]`.

## Regenerating the archives

Build quickjs-ng once per target with the ABI named in the directory
(linux: musl; darwin: Mach-O; windows: MinGW) and drop the resulting
`libquickjs.a` in place. Two details matter:

1. **macOS archives must be 8-byte aligned.** The Apple linker rejects an
   archive whose members are not 8-byte aligned
   (`64-bit mach-o member 'x.o/' not 8-byte aligned`), and archives produced
   by a GNU/BSD `ar` do not necessarily satisfy that. Repack them with:

   ```
   zig ar rcs --format=darwin lib/<platform>/libquickjs.a quickjs.o libregexp.o libunicode.o dtoa.o
   ```

2. **Do not add a table of contents by hand.** `ar s`/`ranlib` writes the
   `__.SYMDEF` member; the linker needs it.

## Cross links (building all six targets from one host)

`scripts/build-indirect-all.ts` cross-links every target with the pinned zig
toolchain. Two darwin-only shims exist because that toolchain is not macOS:

- Go's `crypto/x509` links `-framework CoreFoundation -framework Security` and
  the darwin `internal/syscall/unix` package always adds `-lresolv`, so the
  linker must be able to FIND those names. `lib/macos_frameworks/*.tbd` and
  `lib/macos_link_stubs/*/libresolv.a` provide them without an SDK, and
  `-Wl,-undefined,dynamic_lookup` defers symbol binding to load time, where
  the real frameworks and libSystem provide everything. No symbol is taken
  from those stubs: nothing on darwin references the `res_9_*` entry points,
  so the archive member is never pulled in (the shipped Mach-O has no
  undefined engine or resolver symbols — `scripts/verify-daemon-binary.ts`
  checks exactly that).

On macOS itself those paths resolve to the real SDK files and the flags are
inert.
