# packages/qjs — QuickJS late link

QuickJS runs the skill modules (see `packages/skills`). The engine is **not
built here**: `lib/<platform>/libquickjs.a` holds a prebuilt static archive
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
shim.c / shim.h                   the sandbox bridge (one runtime+context per
                                  module evaluation, interrupt handler,
                                  memory/stack caps, module loader callback)
prelude.js                        the JS surface: require(), skill.extend()
                                  and the plain-data snapshot boundary
qjs.go / qjs_export.go            Go side of the bridge
```

Platform keys: `x86_64_linux_musl`, `aarch64_linux_musl`, `x86_64_macos`,
`aarch64_macos`, `x86_64_windows_gnu`, `aarch64_windows_gnu`.

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
