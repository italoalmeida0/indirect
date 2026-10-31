// scripts/verify-release-dist.ts — shared release artifact validator.
//
// ONE multi-call artifact backs the whole release (see
// scripts/build-indirect-all.ts): the manifest has a single `daemon` field
// and dist/ ships six platform assets plus, optionally, the installer scripts
// (see AUXILIARY_ASSETS). This validator is the single source of truth for
// that contract; CI and the release workflow BOTH call it (it replaced two
// copied inline verifiers that had drifted apart — the release one still
// required the removed `launcher` manifest section, V2-005).
//
// Usage: bun scripts/verify-release-dist.ts [distDir] [expectedVersion]
//   distDir         defaults to indirect-code-daemon/dist
//   expectedVersion optional; when given, the manifest version AND the
//                   bytes stamped into every binary must match it.
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { verifyDaemonBinary } from "./verify-daemon-binary";

export const EXPECTED_PLATFORMS = [
  "linux-amd64",
  "linux-arm64",
  "darwin-amd64",
  "darwin-arm64",
  "windows-amd64",
  "windows-arm64",
] as const;

/**
 * Optional assets that ship beside the binaries and are checksummed the same
 * way, but are not daemon platform targets: the packaging step lists the
 * installer scripts in the same `assets` map. They are optional so a dist built
 * without them stays valid; when present they must be real files whose
 * checksums agree with both SHA256SUMS.txt and the manifest.
 */
export const AUXILIARY_ASSETS = ["install.sh", "install.ps1"] as const;

export class DistError extends Error {}

function bad(msg: string): never {
  throw new DistError(msg);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// verifyDist enforces the release contract. Throws DistError on any
// violation; returns a small report on success.
export function verifyDist(distDir: string, expectedVersion?: string) {
  if (!existsSync(distDir)) bad(`dist dir missing: ${distDir}`);

  // 1. Manifest: single-artifact contract (exactly the daemon field).
  const manifestPath = join(distDir, "versions.json");
  if (!existsSync(manifestPath)) bad("versions.json missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fields = Object.keys(manifest);
  if (fields.length !== 1 || fields[0] !== "daemon") {
    bad(`versions.json must have exactly one "daemon" field, got [${fields.join(", ")}]`);
  }
  const daemon = manifest.daemon;
  const version = String(daemon?.version ?? "");
  if (!version) bad("versions.json daemon.version missing");
  if (expectedVersion && version !== expectedVersion) {
    bad(`manifest version ${version} != expected ${expectedVersion}`);
  }

  // 2. Assets: exactly the six platform keys, pointing at real files.
  const assets: Record<string, string> = daemon.assets ?? {};
  for (const plat of EXPECTED_PLATFORMS) {
    const name = assets[plat];
    if (!name) bad(`manifest missing platform asset ${plat}`);
    const p = join(distDir, name);
    if (!existsSync(p) || !statSync(p).isFile()) bad(`asset file missing: ${name}`);
  }
  const extra = Object.keys(assets).filter((k) => !(EXPECTED_PLATFORMS as readonly string[]).includes(k) && !(AUXILIARY_ASSETS as readonly string[]).includes(k));
  if (extra.length) bad(`manifest has unexpected platforms: ${extra.join(", ")}`);
  const auxiliary = Object.keys(assets).filter((k) => (AUXILIARY_ASSETS as readonly string[]).includes(k));
  for (const key of auxiliary) {
    const name = assets[key]!;
    if (!existsSync(join(distDir, name)) || !statSync(join(distDir, name)).isFile()) bad(`auxiliary asset file missing: ${name}`);
  }

  // 3. Checksums: SHA256SUMS.txt and the manifest must agree with the
  //    real bytes of every shipped binary.
  const sumsPath = join(distDir, "SHA256SUMS.txt");
  if (!existsSync(sumsPath)) bad("SHA256SUMS.txt missing");
  const sums: Record<string, string> = {};
  for (const line of readFileSync(sumsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!m) bad(`unparseable SHA256SUMS line: ${JSON.stringify(line)}`);
    sums[m[2]] = m[1];
  }
  for (const plat of EXPECTED_PLATFORMS) {
    const name = assets[plat];
    const buf = readFileSync(join(distDir, name));
    const hash = sha256(buf);
    if (sums[name] !== hash) bad(`SHA256SUMS mismatch for ${name}`);
    if (daemon.sums?.[name] !== hash) bad(`versions.json sums mismatch for ${name}`);
    // Stamped version: the release binary must embed the release version
    // (build-indirect-all stamps it via ldflags on both role versions).
    if (expectedVersion && !buf.includes(Buffer.from(expectedVersion))) {
      bad(`${name} does not embed version ${expectedVersion} (stale binary?)`);
    }
  }
  for (const key of auxiliary) {
    const name = assets[key]!;
    const hash = sha256(readFileSync(join(distDir, name)));
    if (sums[name] !== hash) bad(`SHA256SUMS mismatch for ${name}`);
    if (daemon.sums?.[name] !== hash) bad(`versions.json sums mismatch for ${name}`);
  }
  // Every listed sum must match the file on disk (catches stale leftovers).
  for (const [name, hash] of Object.entries(sums)) {
    const p = join(distDir, name);
    if (!existsSync(p)) bad(`SHA256SUMS lists missing file: ${name}`);
    if (sha256(readFileSync(p)) !== hash) bad(`checksum mismatch for ${name}`);
  }
  const listedBinaries = Object.keys(sums).filter((n) => n.startsWith("indirect-code-"));
  const expectedSums = EXPECTED_PLATFORMS.length + auxiliary.length;
  if (listedBinaries.length !== expectedSums) {
    bad(`SHA256SUMS lists ${listedBinaries.length} files, want ${expectedSums}`);
  }

  return { version, assets, checked: EXPECTED_PLATFORMS.length };
}

/**
 * verifyDistBinaries inspects what is INSIDE the shipped artifacts: object
 * format and machine must match the platform, linux must stay statically
 * linked and glibc-free, darwin must carry the QuickJS engine as DEFINED
 * symbols with CoreFoundation/Security really linked, and windows must be the
 * right PE machine. Checksums and the manifest cannot tell a stale,
 * mis-linked or swapped binary from a good one, so this runs on artifacts a
 * build just produced — kept separate from verifyDist because a test dist
 * carries placeholder bytes, not real executables.
 */
export function verifyDistBinaries(distDir: string): void {
  const manifestPath = join(distDir, "versions.json");
  if (!existsSync(manifestPath)) bad("versions.json missing");
  const assets: Record<string, string> = JSON.parse(readFileSync(manifestPath, "utf8"))?.daemon?.assets ?? {};
  for (const plat of EXPECTED_PLATFORMS) {
    const name = assets[plat];
    if (!name) bad(`manifest missing platform asset ${plat}`);
    const [goos, goarch] = plat.split("-");
    try {
      verifyDaemonBinary(join(distDir, name), goos, goarch);
    } catch (e) {
      bad(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

if (import.meta.main) {
  const [, , distArg, versionArg] = process.argv;
  const distDir = distArg ?? "indirect-code-daemon/dist";
  try {
    const rep = verifyDist(distDir, versionArg);
    verifyDistBinaries(distDir);
    console.log(
      `verify-release-dist: OK v${rep.version} — ${rep.checked} platform assets verified (${distDir})`,
    );
  } catch (e) {
    if (e instanceof DistError) {
      console.error(`verify-release-dist: FAIL — ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
