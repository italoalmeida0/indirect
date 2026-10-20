#!/usr/bin/env bun
// scripts/build-indirect-all.ts — build the shipped daemon assets.
//
// ONE multi-call binary per platform (boot + worker roles, see
// cmd/daemon/main.go), six platforms, all cross-built from the current host
// through the pinned zig toolchain (scripts/indirect-zig.ts) because the
// daemon links the prebuilt QuickJS static libraries in
// indirect-code-daemon/packages/qjs/lib:
//
//   linux   x86_64/aarch64 *-linux-musl   -> static, glibc-free, tags musl,static
//   darwin  x86_64/aarch64 *-macos        -> Mach-O, framework stubs + dynamic_lookup
//   windows x86_64/aarch64 *-windows-gnu  -> PE/COFF MinGW ABI
//
// The .a files are NOT recompiled here (that is the point of the late-link
// scheme): QuickJS ships prebuilt per target and this script only drives the
// linker, so no QuickJS source or C compiler for it is required.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";
import { ensureZig, macosFrameworkDir } from "./indirect-zig";
import { verifyDaemonBinary } from "./verify-daemon-binary";

const ROOT = path.resolve(import.meta.dir, "..");
const DAEMON_DIR = path.join(ROOT, "indirect-code-daemon");
const OUT = path.join(DAEMON_DIR, "dist");
mkdirSync(OUT, { recursive: true });

// 1. Version resolution: env override -> CLI arg -> versions.json -> package.json -> 1.0.0
let version = process.env.INDIRECT_VERSION || process.argv[2];
if (!version) {
  const versionsJsonPath = path.join(OUT, "versions.json");
  try {
    const data = JSON.parse(readFileSync(versionsJsonPath, "utf-8"));
    version = data?.daemon?.version;
  } catch {}
}
if (!version) {
  const pkgPath = path.join(ROOT, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    version = pkg.version;
  } catch {}
}
version = (version || "1.0.0").replace(/^v/, "").trim();

console.log(`==> Building Indirect Code v${version}`);

const daemonLdflags = `-s -w -X main.Version=${version} -X main.launcherVersion=${version}`;

interface Target {
  goos: string;
  goarch: string;
  /** zig -target triple: selects the ABI the matching libquickjs.a was built for. */
  triple: string;
  /** Build tags: linux musl builds are statically linked against musl. */
  tags: string;
  /** Go linker mode: the prebuilt archive is a foreign object, so external. */
  linkmode: string;
}

const TARGETS: Target[] = [
  { goos: "linux", goarch: "amd64", triple: "x86_64-linux-musl", tags: "musl,static", linkmode: "external" },
  { goos: "linux", goarch: "arm64", triple: "aarch64-linux-musl", tags: "musl,static", linkmode: "external" },
  { goos: "darwin", goarch: "amd64", triple: "x86_64-macos", tags: "netgo", linkmode: "external" },
  { goos: "darwin", goarch: "arm64", triple: "aarch64-macos", tags: "netgo", linkmode: "external" },
  { goos: "windows", goarch: "amd64", triple: "x86_64-windows-gnu", tags: "", linkmode: "external" },
  { goos: "windows", goarch: "arm64", triple: "aarch64-windows-gnu", tags: "", linkmode: "external" },
];

const zig = await ensureZig();
const frameworkDir = macosFrameworkDir(DAEMON_DIR);

for (const target of TARGETS) {
  const ext = target.goos === "windows" ? ".exe" : "";
  const name = `indirect-code-${target.goos}-${target.goarch}${ext}`;
  const ldflags = `${daemonLdflags} -linkmode ${target.linkmode}`;
  const env: Record<string, string> = {
    ...process.env,
    CGO_ENABLED: "1",
    GOOS: target.goos,
    GOARCH: target.goarch,
    CC: `${zig} cc -target ${target.triple}`,
  };
  if (target.goos === "darwin") {
    // Go links crypto/x509's CoreFoundation/Security frameworks on darwin;
    // cross-linking has no SDK, so the repo's stub .tbd descriptors point at
    // the framework names and dynamic_lookup defers symbol binding to load
    // time on macOS (the real frameworks are there).
    env.CGO_LDFLAGS = `-F${frameworkDir} -Wl,-undefined,dynamic_lookup`;
  }
  console.log(`==> ${name} (multi-call: boot + worker)`);
  // -buildvcs=false: the artifacts are committed to the repo, so their bytes
  // must depend on SOURCE and toolchain only. With VCS stamping on, every
  // rebuild after a new commit rewrites the binaries (and marks them
  // vcs.modified=true), making "did the release change?" impossible to answer
  // and the committed dist churn on every unrelated commit. The version the
  // updater reads is stamped by -X main.Version below.
  const args = ["go", "build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags, "-o", path.join(OUT, name)];
  if (target.tags) args.push("-tags", target.tags);
  args.push("./cmd/daemon");
  const result = await $`${args}`.cwd(DAEMON_DIR).env(env).nothrow();
  if (result.exitCode !== 0) {
    console.error(result.stderr.toString());
    throw new Error(`build failed for ${name}`);
  }
  // The engine is linked late from a prebuilt archive: assert it actually
  // landed in the artifact, in the format and static flavor the platform
  // requires (see scripts/verify-daemon-binary.ts).
  const report = verifyDaemonBinary(path.join(OUT, name), target.goos, target.goarch);
  const extra =
    target.goos === "linux"
      ? "statically linked"
      : target.goos === "darwin"
        ? `${report.engineSymbols} engine symbols, frameworks: ${(report.dylibs ?? []).length}`
        : "PE";
  console.log(`    ok: ${report.format}/${report.machine} (${extra})`);
}

// 2. Prune any deprecated versioned copies and legacy launcher duplicates
// (the multi-call binary replaced the separate launcher artifact).
for (const fn of readdirSync(OUT)) {
  if (/-v\d+\.\d+\.\d+/.test(fn) || fn.startsWith("indirect-launcher-")) {
    rmSync(path.join(OUT, fn), { force: true });
    console.log(`pruned ${fn}`);
  }
}

// 3. Compute SHA256 sums natively
const sums: Record<string, string> = {};
const allFiles = readdirSync(OUT).sort();
const sumsLines: string[] = [];

for (const fn of allFiles) {
  if (fn.startsWith("indirect-code-") || fn.startsWith("indirect-launcher-")) {
    const content = readFileSync(path.join(OUT, fn));
    const hash = createHash("sha256").update(content).digest("hex");
    sums[fn] = hash;
    sumsLines.push(`${hash}  ${fn}`);
  }
}

writeFileSync(path.join(OUT, "SHA256SUMS.txt"), sumsLines.join("\n") + "\n");

// 4. Generate versions.json manifest. ONE artifact (the multi-call
// binary), ONE field: `daemon` carries the app assets — the update
// protocol has no separate launcher concept.
function getAssets(prefix: string) {
  const res: Record<string, string> = {};
  for (const fn of Object.keys(sums).sort()) {
    if (fn.startsWith(prefix + "-") && !fn.includes("-v")) {
      const key = fn.slice(prefix.length + 1).replace(/\.exe$/, "");
      res[key] = fn;
    }
  }
  return res;
}

const manifest = {
  daemon: {
    version,
    assets: getAssets("indirect-code"),
    sums,
  },
};

writeFileSync(path.join(OUT, "versions.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("==> versions.json:", version);

// 5. Sizes summary
console.log("==> sizes:");
for (const fn of readdirSync(OUT)) {
  const st = statSync(path.join(OUT, fn));
  const mb = (st.size / (1024 * 1024)).toFixed(1);
  console.log(`  ${fn.padEnd(45)} ${mb.padStart(6)} MB`);
}
