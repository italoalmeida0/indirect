// scripts/indirect-zig.ts — the C toolchain provider for the daemon build.
//
// The daemon embeds QuickJS through prebuilt per-platform static libraries
// (indirect-code-daemon/packages/qjs/lib), so every target needs a C toolchain
// whose ABI matches that archive (musl for linux, Mach-O for darwin, GNU for
// windows). Zig ships all of them plus every libc, which makes the six
// targets build reproducibly from any host, so it is PINNED here
// (version + per-host SHA256) instead of whatever happens to be installed.
//
// Resolution order, first hit wins:
//
//   1. $ZIG                      explicit path to a zig binary
//   2. vendored archive          <repo>/scripts/toolchains/<archive>
//                                (`bun run toolchains:vendor` prefetches;
//                                the directory is gitignored on purpose —
//                                see "Why not commit them" below)
//   3. toolchain cache           ~/.cache/indirect-code/toolchains/<dir>
//   4. zig on PATH               accepted only if `zig version` matches
//   5. download                  ziglang.org, checksum-verified, into the
//                                cache (same shape as the Obscura browser
//                                download: fetch + local extraction)
//
// "Why not commit them": the six host archives total ~400 MB (the Windows
// build alone is 95 MB, right at GitHub's per-file limit), they would live in
// git history forever and slow every clone, and CI downloads them once per
// cache key anyway. Vendoring locally is one command and stays out of git.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

export const ZIG_VERSION = "0.17.0";

const DIST = `https://ziglang.org/download/${ZIG_VERSION}`;

export interface HostZig {
  /** ziglang.org host key, e.g. "x86_64-linux". */
  key: string;
  archive: string;
  sha256: string;
  /** Directory the archive extracts to (its single top-level entry). */
  dir: string;
  /** Path of the compiler inside that directory. */
  bin: string;
}

function host(name: string, ext: "tar.xz" | "zip"): HostZig {
  const dir = `zig-${name}-${ZIG_VERSION}`;
  return {
    key: name,
    archive: `${dir}.${ext}`,
    sha256: "",
    dir,
    bin: join(dir, name.includes("windows") ? "zig.exe" : "zig"),
  };
}

// Published SHA256 from ziglang.org/download/index.json for 0.17.0.
const HOSTS: Record<string, HostZig> = {
  "linux-x64": { ...host("x86_64-linux", "tar.xz"), sha256: "1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026" },
  "linux-arm64": { ...host("aarch64-linux", "tar.xz"), sha256: "9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8" },
  "darwin-x64": { ...host("x86_64-macos", "tar.xz"), sha256: "4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6" },
  "darwin-arm64": { ...host("aarch64-macos", "tar.xz"), sha256: "b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a" },
  "win32-x64": { ...host("x86_64-windows", "zip"), sha256: "b5663f69581dcf391293fbf16c06cb80d81d806545ce618b4d0bab7f0eb8c428" },
  "win32-arm64": { ...host("aarch64-windows", "zip"), sha256: "0a59d91fa1cb40cf068e9b0954434ce973500c7a2ea749f1e01af62cdab52d26" },
};

function hostKey(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform}-${arch}`;
}

/** The pinned toolchain for this machine (throws on an unsupported host). */
export function hostZig(): HostZig {
  const h = HOSTS[hostKey()];
  if (!h) throw new Error(`no zig toolchain pinned for ${hostKey()} (supported: ${Object.keys(HOSTS).join(", ")})`);
  return h;
}

/** Every pinned host archive, for `bun run toolchains:vendor`. */
export function allHostZigs(): HostZig[] {
  return Object.values(HOSTS);
}

export function archiveUrl(h: HostZig): string {
  return `${DIST}/${h.archive}`;
}

function cacheRoot(): string {
  if (process.env.INDIRECT_TOOLCHAIN_DIR) return process.env.INDIRECT_TOOLCHAIN_DIR;
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : join(homedir(), ".cache"));
  return join(base, "indirect-code", "toolchains");
}

/** Where `toolchains:vendor` puts archives: in the repo, out of git. */
export function vendorDir(): string {
  return path.resolve(import.meta.dir, "toolchains");
}

export function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** PATH lookup by stat (no shell builtins, works on windows: .exe/.cmd). */
export function whichSync(bin: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Downloads one pinned host archive into `destDir`, verifying the checksum. */
export async function downloadArchive(h: HostZig, destDir: string): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const target = join(destDir, h.archive);
  if (isFile(target) && sha256File(target) === h.sha256) return target;
  rmSync(target, { force: true });

  const url = archiveUrl(h);
  console.log(`==> fetching zig ${ZIG_VERSION} (${h.key}) from ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`zig download failed: HTTP ${res.status} ${res.statusText} from ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== h.sha256) {
    throw new Error(`zig archive checksum mismatch for ${h.archive}: got ${digest}, want ${h.sha256}`);
  }
  mkdirSync(destDir, { recursive: true });
  writeFileSync(target, bytes);
  console.log(`==> verified ${(bytes.length / 1_000_000).toFixed(1)} MB (sha256 ${digest.slice(0, 12)}…)`);
  return target;
}

/**
 * Extracts `archive` into `destDir` with the single top-level directory
 * stripped, i.e. destDir becomes the zig root.
 *
 * tar handles .tar.xz everywhere (GNU tar on Linux, bsdtar on macOS and on
 * Windows 10+, which also reads .zip). The pure-TS zip reader is the fallback
 * for hosts where invoking tar fails — Bun.Archive in this Bun release reads
 * tar but not zip, so zip gets its own minimal reader rather than a silent
 * "unrecognized archive format" at the worst moment.
 */
export function extractArchive(archive: string, destDir: string): void {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  try {
    execFileSync("tar", ["-xf", archive, "-C", destDir, "--strip-components=1"], { stdio: "pipe" });
    return;
  } catch (e) {
    if (!archive.endsWith(".zip")) {
      throw new Error(
        `cannot extract ${archive}: tar failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); ` +
          `install tar/xz or set ZIG=<path to zig binary>`,
        { cause: e },
      );
    }
  }
  extractZip(archive, destDir);
}

/** Minimal zip reader: central directory + deflate/stored members, no deps. */
function extractZip(archive: string, destDir: string): void {
  const buf = readFileSync(archive);
  // End of central directory: scan backwards for the signature (max 64 KiB comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${archive}: no zip end-of-central-directory record`);
  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`${archive}: corrupt zip central directory`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`${archive}: corrupt zip local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    // Strip the archive's single top-level directory (zig-<host>-<ver>/).
    const rel = name.split("/").slice(1).join("/");
    if (!rel) continue;
    const outPath = join(destDir, rel);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
  }
}

/** Archive locations checked before downloading, in order. */
function archiveCandidates(h: HostZig): string[] {
  return [join(vendorDir(), h.archive), join(cacheRoot(), h.archive)];
}

let cached: string | null = null;

/**
 * ensureZig returns the path to the pinned zig binary for this host,
 * using the resolution order documented at the top of this file.
 */
export async function ensureZig(): Promise<string> {
  if (cached && isFile(cached)) return cached;
  const explicit = process.env.ZIG;
  if (explicit) {
    if (!isFile(explicit)) throw new Error(`ZIG=${explicit} does not exist`);
    return (cached = explicit);
  }

  const h = hostZig();
  const installDir = join(cacheRoot(), h.dir);
  const bin = join(installDir, path.basename(h.bin));
  if (isFile(bin)) return (cached = bin);

  // A zig on PATH is trusted only when it reports the pinned version: the
  // cross targets and the prebuilt archives depend on that exact toolchain.
  const onPath = whichSync("zig");
  if (onPath) {
    try {
      const out = execFileSync(onPath, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out === ZIG_VERSION) return (cached = onPath);
    } catch {
      // unusable install: fall through to the pinned copy
    }
  }

  let archive = archiveCandidates(h).find((p) => isFile(p) && sha256File(p) === h.sha256);
  if (!archive) archive = await downloadArchive(h, cacheRoot());

  extractArchive(archive, installDir);
  if (!isFile(bin)) throw new Error(`zig extraction produced no ${bin}`);
  console.log(`==> zig ${ZIG_VERSION} ready at ${bin}`);
  return (cached = bin);
}

// Stub .tbd descriptors for the two frameworks Go's crypto/x509 links on
// darwin (see indirect-code-daemon/packages/qjs/README.md).
export function macosFrameworkDir(daemonDir: string): string {
  return join(daemonDir, "packages", "qjs", "lib", "macos_frameworks");
}
