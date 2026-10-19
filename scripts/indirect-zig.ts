// scripts/indirect-zig.ts — the C toolchain provider for the daemon build.
//
// The daemon embeds QuickJS through prebuilt per-platform static libraries
// (indirect-code-daemon/packages/qjs/lib), so every target now needs a C
// linker driver: linux/darwin/windows alike, and the cross targets must
// produce the exact ABI each .a was compiled for (musl for linux, Mach-O
// for darwin, GNU for windows). Zig ships a complete cross toolchain plus
// every libc and is the one dependency that makes all six targets build
// reproducibly from any host, so it is pinned, checksum-verified and
// cached — never fetched twice.
//
// Resolution order: $ZIG (explicit path) -> `zig` on PATH -> cache ->
// download from ziglang.org into the cache.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import { $ } from "bun";

export const ZIG_VERSION = "0.17.0";

// Pinned per host platform: the tarball the official index lists for
// ziglang.org/download/0.17.0, with its published SHA256.
const DIST = `https://ziglang.org/download/${ZIG_VERSION}`;

interface HostZig {
  key: string;
  archive: string;
  sha256: string;
  // Runtime directory inside the archive (varies per platform naming).
  dir: string;
}

const HOSTS: Record<string, HostZig> = {
  "linux-x64": {
    key: "x86_64-linux",
    archive: `zig-x86_64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026",
    dir: `zig-x86_64-linux-${ZIG_VERSION}`,
  },
  "linux-arm64": {
    key: "aarch64-linux",
    archive: `zig-aarch64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8",
    dir: `zig-aarch64-linux-${ZIG_VERSION}`,
  },
  "darwin-x64": {
    key: "x86_64-macos",
    archive: `zig-x86_64-macos-${ZIG_VERSION}.tar.xz`,
    sha256: "4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6",
    dir: `zig-x86_64-macos-${ZIG_VERSION}`,
  },
  "darwin-arm64": {
    key: "aarch64-macos",
    archive: `zig-aarch64-macos-${ZIG_VERSION}.tar.xz`,
    sha256: "b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a",
    dir: `zig-aarch64-macos-${ZIG_VERSION}`,
  },
  "win32-x64": {
    key: "x86_64-windows",
    archive: `zig-x86_64-windows-${ZIG_VERSION}.zip`,
    sha256: "b5663f69581dcf391293fbf16c06cb80d81d806545ce618b4d0bab7f0eb8c428",
    dir: `zig-x86_64-windows-${ZIG_VERSION}`,
  },
  "win32-arm64": {
    key: "aarch64-windows",
    archive: `zig-aarch64-windows-${ZIG_VERSION}.zip`,
    sha256: "0a59d91fa1cb40cf068e9b0954434ce973500c7a2ea749f1e01af62cdab52d26",
    dir: `zig-aarch64-windows-${ZIG_VERSION}`,
  },
};

function hostKey(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform}-${arch}`;
}

function cacheRoot(): string {
  if (process.env.INDIRECT_TOOLCHAIN_DIR) return process.env.INDIRECT_TOOLCHAIN_DIR;
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local") : join(homedir(), ".cache"));
  return join(base, "indirect-code", "toolchains");
}

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

async function which(bin: string): Promise<string | null> {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not there: keep looking
      }
    }
  }
  return null;
}

let cached: string | null = null;

/**
 * ensureZig returns the path to the pinned zig binary, downloading and
 * verifying it into the toolchain cache when the machine has none.
 */
export async function ensureZig(): Promise<string> {
  if (cached) return cached;
  const explicit = process.env.ZIG;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`ZIG=${explicit} does not exist`);
    cached = explicit;
    return cached;
  }

  const host = HOSTS[hostKey()];
  if (!host) throw new Error(`no zig toolchain pinned for ${hostKey()}`);

  const dir = join(cacheRoot(), host.dir);
  const bin = join(dir, process.platform === "win32" ? "zig.exe" : "zig");
  if (existsSync(bin)) {
    cached = bin;
    return bin;
  }

  // A zig already on PATH is trusted only when it reports the pinned
  // version: cross targets depend on that exact toolchain.
  const onPath = await which("zig");
  if (onPath) {
    const res = await $`${onPath} version`.quiet().nothrow();
    if (res.exitCode === 0 && res.stdout.toString().trim() === ZIG_VERSION) {
      cached = onPath;
      return onPath;
    }
  }

  const archivePath = join(cacheRoot(), host.archive);
  mkdirSync(cacheRoot(), { recursive: true });
  console.log(`==> fetching zig ${ZIG_VERSION} (${host.key})`);
  if (!existsSync(archivePath) || sha256File(archivePath) !== host.sha256) {
    rmSync(archivePath, { force: true });
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${archivePath} ${`${DIST}/${host.archive}`}`;
  }
  const digest = sha256File(archivePath);
  if (digest !== host.sha256) {
    rmSync(archivePath, { force: true });
    throw new Error(`zig archive checksum mismatch: got ${digest}, want ${host.sha256}`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // tar (bsdtar on Windows/macOS, GNU tar on Linux) reads .tar.xz and .zip.
  await $`tar -xf ${archivePath} -C ${dir} --strip-components=1`;
  if (!existsSync(bin)) throw new Error(`zig extraction produced no ${bin}`);
  if (process.platform !== "win32") {
    await $`chmod +x ${bin}`;
  }
  console.log(`==> zig ${ZIG_VERSION} ready at ${bin}`);
  cached = bin;
  return cached;
}

// The two macOS frameworks Go's crypto/x509 links on darwin. Cross-linking
// from Linux has no SDK, so the stubs in the repo let the linker resolve
// `-framework CoreFoundation/Security`; because the Go link adds
// -Wl,-undefined,dynamic_lookup for darwin cross builds, the symbols are
// bound to the real frameworks at load time on macOS.
export function macosFrameworkDir(daemonDir: string): string {
  return join(daemonDir, "packages", "qjs", "lib", "macos_frameworks");
}

export function fileSizeMB(p: string): string {
  return (statSync(p).size / (1024 * 1024)).toFixed(1);
}
