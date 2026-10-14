/**
 * Vendored generative-ui lib modules (d3, gsap, chart, three, leaflet,
 * cannon-es, matter-js): one shared reader for the served widget docs
 * (gen-ui.ts) and the lint page (widget-lint.ts), so both resolve the same
 * single-file ESM bundles.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GEN_UI_LIB_FILES } from "../../scripts/vendor-gen-ui-libs";

export { GEN_UI_LIB_FILES };

/** Candidate roots for the vendored build output (gitignored artifacts). */
const VENDOR_DIRS = [
  path.resolve("web/public/vendor/gen-ui"),
  path.resolve("dist/vendor/gen-ui"),
];

export function readVendorFile(file: string): string | null {
  for (const dir of VENDOR_DIRS) {
    const p = path.join(dir, file);
    if (!p.startsWith(dir + path.sep)) return null; // no traversal
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Library module files the import map may reference (plus the react shim). */
export const LIB_MODULE_FILES = new Set<string>(Object.values(GEN_UI_LIB_FILES));

/**
 * The vendored lib specifiers a compiled module actually references
 * (static imports and the appended global prelude), keyed by specifier —
 * the lint page maps exactly these to local copies of the bundles.
 */
export function referencedLibModules(code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [spec, file] of Object.entries(GEN_UI_LIB_FILES)) {
    const quoted = `["']${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`;
    if (new RegExp(`(?:from\\s*|import\\s*(?:\\(\\s*)?)${quoted}`).test(code)) out.set(spec, file);
  }
  return out;
}
