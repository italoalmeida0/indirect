#!/usr/bin/env bun
// scripts/vendor-toolchains.ts — download the pinned zig archives into
// scripts/toolchains/ so a build needs no network (offline machines, locked
// down CI, airplanes) without committing ~400 MB of toolchains to git.
//
// Usage:
//   bun run toolchains:vendor            # this host only
//   bun run toolchains:vendor --all      # all six hosts (400 MB)
//   bun run toolchains:vendor --list     # show what is pinned
//
// scripts/indirect-zig.ts prefers a vendored archive over the network, so
// running this once makes `bun run build:daemon:all` fully offline. The
// directory is gitignored: vendoring is per-machine, not per-repo.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { allHostZigs, archiveUrl, downloadArchive, hostZig, vendorDir } from "./indirect-zig";

const args = new Set(process.argv.slice(2));

if (args.has("--list") || args.has("-l")) {
  for (const h of allHostZigs()) {
    console.log(`${h.key.padEnd(16)} ${h.archive.padEnd(38)} ${h.sha256.slice(0, 12)}…  ${archiveUrl(h)}`);
  }
  process.exit(0);
}

const hosts = args.has("--all") ? allHostZigs() : [hostZig()];
const dir = vendorDir();
mkdirSync(dir, { recursive: true });

let total = 0;
for (const h of hosts) {
  const p = await downloadArchive(h, dir);
  total += statSync(p).size;
  console.log(`==> vendored ${h.archive}`);
}

console.log(`\n${hosts.length} archive(s) in ${dir}`);
console.log(`${(total / 1_048_576).toFixed(1)} MB ready for offline builds`);

// Show what is already there, so repeated runs make the cache visible.
const present = readdirSync(dir).filter((f) => !f.startsWith("."));
if (present.length > hosts.length) {
  console.log(`(${present.length} archives total on disk — pass --all to fetch the missing hosts)`);
}
