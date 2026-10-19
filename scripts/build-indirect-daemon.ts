#!/usr/bin/env bun
// scripts/build-indirect-daemon.ts — build the daemon for THIS host.
//
// Same late-link scheme as the release build (the QuickJS static archive in
// indirect-code-daemon/packages/qjs/lib), but only for the platform the
// developer is on, and through the pinned zig toolchain so a machine with no
// C compiler still builds. Output: indirect-code-daemon/bin/indirect-code.
//
// Use INDIRECT_DEBUG=1 to keep the Go build cache warm with symbols (no -s -w).
import path from "node:path";
import { mkdirSync } from "node:fs";
import { $ } from "bun";
import { ensureZig } from "./indirect-zig";

const ROOT = path.resolve(import.meta.dir, "..");
const DAEMON_DIR = path.join(ROOT, "indirect-code-daemon");
const OUT = path.join(DAEMON_DIR, "bin", "indirect-code" + (process.platform === "win32" ? ".exe" : ""));

// Host triple for the C toolchain. Linux links against glibc like every dev
// machine; the build tags that select musl are release-only, but the
// prebuilt archive itself is the musl one either way (same GNU ABI, and the
// release path is what ships).
function hostTriple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-macos`;
  if (process.platform === "win32") return `${arch}-windows-gnu`;
  if (process.platform === "linux") return `${arch}-linux-gnu`;
  throw new Error(`unsupported host platform ${process.platform}`);
}

const zig = await ensureZig();
const triple = hostTriple();
mkdirSync(path.join(DAEMON_DIR, "bin"), { recursive: true });

const version = process.env.INDIRECT_VERSION?.replace(/^v/, "") ?? "";
const ldflags = ["-s", "-w", version ? `-X main.Version=${version}` : ""].filter(Boolean).join(" ");

console.log(`==> building daemon for ${process.platform}/${process.arch} (zig target ${triple})`);
const result =
  await $`go build -trimpath -ldflags ${ldflags} -o ${OUT} ./cmd/daemon`
    .cwd(DAEMON_DIR)
    .env({ ...process.env, CGO_ENABLED: "1", CC: `${zig} cc -target ${triple}` })
    .nothrow();
if (result.exitCode !== 0) {
  console.error(result.stderr.toString());
  process.exit(result.exitCode);
}
console.log(`==> ${path.relative(ROOT, OUT)}`);
