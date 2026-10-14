/**
 * Obscura lint browser management (server side).
 *
 * The widget lint runs model-authored code in a REAL browser process —
 * Obscura (https://github.com/h4ckf0r0day/obscura), a headless browser
 * whose pages have no `process`, no `require` and no gateway access. That
 * isolation is the point: the old happy-dom worker ran untrusted code in
 * the gateway's own JS context (env vars, fs, sockets).
 *
 * The binary is resolved in order:
 *
 *   1. `OBSCURA_PATH` (explicit override)
 *   2. `<repo>/.tools/obscura/obscura` (dev checkout)
 *   3. `<DATA_DIR>/obscura/obscura` (downloaded here on demand)
 *   4. `obscura` on PATH
 *
 * When missing, the gateway downloads the `-stealth` release tarball from
 * GitHub (a plain fetch + Bun.gunzipSync + Bun.Archive — no external tools)
 * and installs the binary into DATA_DIR. There is NO fallback: without the
 * browser the lint fails loudly instead of quietly downgrading.
 */
import { existsSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config";

const RELEASE_BASE = "https://github.com/h4ckf0r0day/obscura/releases/latest/download";

/** The stealth build: same lint behavior, and the fingerprint features stay
 * available if the gateway ever grows browser-backed features (deep search
 * and friends) on top of the same binary. */
function releaseAsset(): { url: string; binary: string } {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const platform = process.platform; // linux | darwin | win32
  if (platform === "win32") {
    return { url: `${RELEASE_BASE}/obscura-${arch}-windows-stealth.zip`, binary: "obscura.exe" };
  }
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`obscura: unsupported platform ${platform}`);
  }
  const os = platform === "darwin" ? "macos" : "linux";
  return { url: `${RELEASE_BASE}/obscura-${arch}-${os}-stealth.tar.gz`, binary: "obscura" };
}

function candidatePaths(binary: string): string[] {
  const repoLocal = path.resolve(import.meta.dir, "..", "..", ".tools", "obscura", binary);
  return [repoLocal, path.join(DATA_DIR, "obscura", binary)];
}

let resolved: string | null = null;
let ensurePromise: Promise<string> | null = null;

/** Finds (or downloads) the obscura binary. Cached per process. */
export function ensureObscuraBrowser(): Promise<string> {
  if (resolved && existsSync(resolved)) return Promise.resolve(resolved);
  if (!ensurePromise) {
    ensurePromise = doEnsure().catch((e) => {
      ensurePromise = null; // retry on the next lint
      throw e;
    });
  }
  return ensurePromise;
}

/**
 * The binary must actually EXECUTE (not just exist): a glibc build on a
 * musl/distroless image fails at posix_spawn with a bare ENOENT. Probe once
 * so the failure says what to fix instead of surfacing inside a lint.
 */
function probeBinary(path: string): void {
  let probe;
  try {
    probe = Bun.spawnSync([path, "--version"]);
  } catch (e) {
    throw new Error(
      `obscura at ${path} cannot start: ${e instanceof Error ? e.message : String(e)} — ` +
      `the release binary needs glibc (ld-linux). Run the gateway on a glibc base image ` +
      `(e.g. debian:slim), install gcompat on Alpine, or point OBSCURA_PATH at a working binary`,
      { cause: e },
    );
  }
  if (probe.exitCode !== 0) {
    throw new Error(
      `obscura at ${path} exited ${probe.exitCode} on --version: ` +
      `${probe.stderr.toString().trim().slice(0, 200)} — the release binary needs glibc; ` +
      `use a glibc base image (e.g. debian:slim), install gcompat on Alpine, or set OBSCURA_PATH`,
    );
  }
}

async function doEnsure(): Promise<string> {
  const override = process.env.OBSCURA_PATH?.trim();
  const { binary } = releaseAsset();
  if (override && existsSync(override)) {
    probeBinary(override);
    resolved = override;
    return resolved;
  }
  for (const p of candidatePaths(binary)) {
    if (existsSync(p)) {
      probeBinary(p);
      resolved = p;
      return resolved;
    }
  }
  // PATH lookup as the last static option (sync check only — spawn probe).
  const which = Bun.spawnSync([process.platform === "win32" ? "where" : "which", "obscura"]);
  if (which.exitCode === 0) {
    const found = which.stdout.toString().split("\n")[0].trim();
    if (found && existsSync(found)) {
      probeBinary(found);
      resolved = found;
      return resolved;
    }
  }

  // Download into DATA_DIR (writable everywhere: docker, nix, bare metal).
  const { url, binary: bin } = releaseAsset();
  const dir = path.join(DATA_DIR, "obscura");
  const target = path.join(dir, bin);
  mkdirSync(dir, { recursive: true });
  console.log(`[gen-ui] downloading obscura lint browser → ${target}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`obscura download failed: HTTP ${res.status} from ${url}`);
  const packed = new Uint8Array(await res.arrayBuffer());
  let bytes: Uint8Array;
  if (url.endsWith(".zip")) {
    bytes = await extractFromArchive(packed, bin);
  } else {
    bytes = await extractFromArchive(Bun.gunzipSync(packed), bin);
  }
  writeFileSync(target, bytes);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  probeBinary(target);
  resolved = target;
  console.log(`[gen-ui] obscura ready (${(bytes.length / 1_000_000).toFixed(0)} MB)`);
  return resolved;
}

/** Pulls one member out of a tar/zip archive using Bun's native Archive. */
async function extractFromArchive(raw: Uint8Array, binary: string): Promise<Uint8Array> {
  const archive = new Bun.Archive(raw);
  const files = await archive.files();
  for (const [name, file] of files) {
    if (name === binary || name.endsWith("/" + binary) || path.basename(name) === binary) {
      return new Uint8Array(await file.arrayBuffer());
    }
  }
  throw new Error(`obscura archive has no ${binary} (found: ${[...files.keys()].join(", ")})`);
}
