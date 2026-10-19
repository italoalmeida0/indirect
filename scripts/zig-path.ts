#!/usr/bin/env bun
// scripts/zig-path.ts — print the pinned zig path, downloading it when the
// machine has none. Used by CI to export CC for the cgo-enabled daemon jobs
// (see scripts/indirect-zig.ts for the pin and cache layout).
import { ensureZig } from "./indirect-zig";

console.log(await ensureZig());
