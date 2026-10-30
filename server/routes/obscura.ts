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
 *   2. `OBSCURA_ARCHIVE` (a local release archive, for air-gapped installs)
 *   3. `<repo>/.tools/obscura/obscura` (dev checkout)
 *   4. `<DATA_DIR>/obscura/obscura` (installed here)
 *   5. `obscura` on PATH
 *
 * When missing, the gateway downloads the PINNED `-stealth` release from
 * GitHub, verifies its SHA-256 against the table below, and unpacks the whole
 * archive (the release ships `obscura` plus a `obscura-worker` helper) into
 * DATA_DIR. There is NO fallback: without the browser the lint fails loudly
 * instead of quietly downgrading.
 *
 * Extraction is done in-process by server/archive.ts. It must NOT use
 * Bun.Archive: on Bun 1.3.x and 1.4.x that API rejects a valid ZIP with
 * "Unrecognized archive format", which is exactly the Windows release
 * format, so the automated install failed on Windows.
 */
import { existsSync, mkdirSync, chmodSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config";
import { archiveEntries, detectArchiveFormat } from "../archive";

/** Pinned release. Bumping the version requires refreshing the hashes; the
 *  verifier below refuses an asset whose digest does not match. */
export const OBSCURA_VERSION = "0.2.5";
const RELEASE_BASE = `https://github.com/h4ckf0r0day/obscura/releases/download/v${OBSCURA_VERSION}`;

interface ReleaseAsset {
  file: string;
  sha256: string;
  /** Primary executable inside the archive. */
  binary: string;
}

/**
 * SHA-256 of every published `-stealth` asset for the pinned version
 * (verified against the real downloads). A platform absent from this table
 * is refused instead of installed unverified.
 */
export const OBSCURA_ASSETS: Record<string, ReleaseAsset> = {
  "linux-x64": {
    file: "obscura-x86_64-linux-stealth.tar.gz",
    sha256: "d9175cf7573d0243fc303a6f1a3b68affc757af0b5549cacb018e9670988316c",
    binary: "obscura",
  },
  "linux-arm64": {
    file: "obscura-aarch64-linux-stealth.tar.gz",
    sha256: "e28ed5ff2dbabe8d820c7b1ef56e6005399aff15912c7774777719e66a021a32",
    binary: "obscura",
  },
  "darwin-x64": {
    file: "obscura-x86_64-macos-stealth.tar.gz",
    sha256: "95ace7af8bb3eecbaa6c64b4869be2eaf421b8ced0a25c3b9981e18f8e681de6",
    binary: "obscura",
  },
  "darwin-arm64": {
    file: "obscura-aarch64-macos-stealth.tar.gz",
    sha256: "9baab9b1d2e0862adb70ce2c81903b5a799bee026038130b9141fab597874100",
    binary: "obscura",
  },
  "win32-x64": {
    file: "obscura-x86_64-windows-stealth.zip",
    sha256: "33c15a57c2c09e1bd8738bbb5d757107bded9749827d4248b7234d4bb5ed7303",
    binary: "obscura.exe",
  },
};

export function obscuraPlatformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch === "arm64" ? "arm64" : "x64"}`;
}

function releaseAsset(): ReleaseAsset {
  const key = obscuraPlatformKey();
  const asset = OBSCURA_ASSETS[key];
  if (!asset) throw new Error(`obscura: unsupported platform ${key} (supported: ${Object.keys(OBSCURA_ASSETS).join(", ")})`);
  return asset;
}

function installDir(): string {
  return path.join(DATA_DIR, "obscura");
}

function candidatePaths(binary: string): string[] {
  return [path.resolve(import.meta.dir, "..", "..", ".tools", "obscura", binary), path.join(installDir(), binary)];
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
function probeBinary(binaryPath: string): void {
  let probe;
  try {
    probe = Bun.spawnSync([binaryPath, "--version"]);
  } catch (e) {
    throw new Error(
      `obscura at ${binaryPath} cannot start: ${e instanceof Error ? e.message : String(e)} — ` +
      `the release binary needs glibc (ld-linux). Run the gateway on a glibc base image ` +
      `(e.g. debian:slim), install gcompat on Alpine, or point OBSCURA_PATH at a working binary`,
      { cause: e },
    );
  }
  if (probe.exitCode !== 0) {
    throw new Error(
      `obscura at ${binaryPath} exited ${probe.exitCode} on --version: ` +
      `${probe.stderr.toString().trim().slice(0, 200)} — the release binary needs glibc; ` +
      `use a glibc base image (e.g. debian:slim), install gcompat on Alpine, or set OBSCURA_PATH`,
    );
  }
}

/** Accept an existing executable: probe, remember, return. */
function accept(binaryPath: string): string {
  probeBinary(binaryPath);
  resolved = binaryPath;
  return binaryPath;
}

function sha256(bytes: Uint8Array): string {
  return Bun.CryptoHasher.hash("sha256", new Uint8Array(bytes), "hex");
}

/**
 * Unpack every member of the archive into `dir`. The release ships more than
 * one executable (obscura + obscura-worker); extracting only the entry point
 * left a half-installed browser. Member paths are confined to `dir`.
 */
async function installArchive(raw: Uint8Array, dir: string, asset: ReleaseAsset): Promise<string> {
  if (detectArchiveFormat(raw) === null) throw new Error("obscura archive is not a zip, tar or tar.gz");
  const entries = archiveEntries(raw);
  if (entries.length === 0) throw new Error("obscura archive is empty");
  // Resolve once: DATA_DIR may be relative, and the confinement check below
  // compares absolute paths only.
  const root = path.resolve(dir);
  mkdirSync(root, { recursive: true });
  let installed = 0;
  for (const entry of entries) {
    const normalized = entry.name.replace(/\\/g, "/");
    if (normalized.endsWith("/")) continue;
    const target = path.resolve(root, normalized);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`obscura archive member escapes the install directory: ${entry.name}`);
    }
    const bytes = await entry.read();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    if (process.platform !== "win32") {
      try { chmodSync(target, 0o755); } catch {}
    }
    installed++;
  }
  if (installed === 0) throw new Error("obscura archive contained no files");
  const binaryPath = path.join(root, asset.binary);
  if (!existsSync(binaryPath)) throw new Error(`obscura archive did not contain ${asset.binary}`);
  return accept(binaryPath);
}

/** Read an operator-provided archive (air-gapped install), verifying nothing:
 *  the operator owns that file. */
async function installLocalArchive(archivePath: string): Promise<string> {
  const asset = releaseAsset();
  const raw = new Uint8Array(readFileSync(archivePath));
  console.log(`[gen-ui] installing obscura from ${archivePath}`);
  return installArchive(raw, installDir(), asset);
}

async function doEnsure(): Promise<string> {
  const asset = releaseAsset();
  const override = process.env.OBSCURA_PATH?.trim();
  if (override && existsSync(override)) return accept(override);

  const localArchive = process.env.OBSCURA_ARCHIVE?.trim();
  if (localArchive && existsSync(localArchive)) return installLocalArchive(localArchive);

  for (const candidate of candidatePaths(asset.binary)) {
    if (existsSync(candidate)) return accept(candidate);
  }

  // PATH lookup as the last static option (sync check only — spawn probe).
  const which = Bun.spawnSync([process.platform === "win32" ? "where" : "which", asset.binary]);
  if (which.exitCode === 0) {
    const found = which.stdout.toString().split(/\r?\n/)[0]!.trim();
    if (found && existsSync(found)) return accept(found);
  }

  const url = `${RELEASE_BASE}/${asset.file}`;
  const dir = installDir();
  mkdirSync(dir, { recursive: true });
  console.log(`[gen-ui] downloading obscura ${OBSCURA_VERSION} lint browser → ${dir}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`obscura download failed: HTTP ${res.status} from ${url}`);
  const packed = new Uint8Array(await res.arrayBuffer());
  const digest = sha256(packed);
  if (digest !== asset.sha256) {
    throw new Error(
      `obscura download failed integrity verification: expected sha256 ${asset.sha256}, got ${digest}. ` +
      `Refusing to install. Set OBSCURA_ARCHIVE to a trusted local archive or OBSCURA_PATH to a working binary.`,
    );
  }
  const binaryPath = await installArchive(packed, dir, asset);
  const files = readdirSync(dir).filter((name) => !name.startsWith("."));
  console.log(`[gen-ui] obscura ${OBSCURA_VERSION} ready (${(packed.length / 1_000_000).toFixed(0)} MB archive, ${files.length} files)`);
  return binaryPath;
}
