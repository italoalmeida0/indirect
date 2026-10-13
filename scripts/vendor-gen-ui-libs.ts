/**
 * Vendors the widget libraries used by generative_ui widgets into
 * web/public/vendor/gen-ui/ so the sandboxed widget iframe can inline them
 * without any network access (CSP default-src 'none').
 *
 * d3 is copied verbatim (the version pinned in package.json — the same one
 * the gateway charts use). three, gsap and chart.js have no single-file
 * browser dist, so they are bundled to IIFE globals (THREE / gsap / Chart)
 * from the tiny entrypoints in scripts/gen-ui-libs/.
 *
 * Run via `bun run vendor:gen-ui` or automatically from build.ts. The
 * outputs are build artifacts (gitignored): every run regenerates them from
 * node_modules.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(ROOT, "web", "public", "vendor", "gen-ui");

/** Libraries copied as-is: name -> source path. */
const COPIED: { name: string; from: string }[] = [
  { name: "d3.min.js", from: path.join(ROOT, "node_modules", "d3", "dist", "d3.min.js") },
  { name: "leaflet.js", from: path.join(ROOT, "node_modules", "leaflet", "dist", "leaflet.js") },
];

/**
 * Stylesheets inlined into widgets: url(images/...) references are rewritten
 * to data URIs so the sandbox (img-src data: blob:) can render them offline.
 */
const STYLED: { name: string; from: string; imagesDir: string }[] = [
  {
    name: "map.css",
    from: path.join(ROOT, "node_modules", "leaflet", "dist", "leaflet.css"),
    imagesDir: path.join(ROOT, "node_modules", "leaflet", "dist", "images"),
  },
];

/**
 * Libraries bundled to an IIFE global via scripts/gen-ui-libs/entry-<name>.ts
 * (each entry assigns the module to globalThis.<global>).
 */
const BUNDLED: { name: string; global: string }[] = [
  { name: "gsap.min.js", global: "gsap" },
  { name: "chart.min.js", global: "Chart" },
  { name: "three.min.js", global: "THREE" },
];

/** Every library file the widget runtime may inline, in injection order. */
export const GEN_UI_LIB_FILES = [
  ...COPIED.map((l) => l.name),
  ...BUNDLED.map((l) => l.name),
];

export const GEN_UI_LIB_CSS_FILES = STYLED.map((l) => l.name);

function inlineStyle(lib: (typeof STYLED)[number]): void {
  if (!existsSync(lib.from)) {
    console.warn(`[vendor-gen-ui] missing ${lib.from}, skipping ${lib.name}`);
    return;
  }
  const css = readFileSync(lib.from, "utf8").replace(
    /url\((["']?)images\/([^)"']+)\1\)/g,
    (_m, _q, file: string) => {
      try {
        const data = readFileSync(path.join(lib.imagesDir, file)).toString("base64");
        const mime = file.endsWith(".svg") ? "image/svg+xml" : "image/png";
        return `url(data:${mime};base64,${data})`;
      } catch {
        return "url(about:blank)";
      }
    },
  );
  Bun.write(path.join(outDir, lib.name), css);
  console.log(`[vendor-gen-ui] ${lib.name} (${(css.length / 1024).toFixed(0)} KB, images inlined)`);
}

async function bundleLib(lib: { name: string; global: string }): Promise<void> {
  const entry = path.join(ROOT, "scripts", "gen-ui-libs", `entry-${lib.name.split(".")[0]}.ts`);
  if (!existsSync(entry)) {
    console.warn(`[vendor-gen-ui] missing entry ${entry}, skipping ${lib.name}`);
    return;
  }
  const tmpOut = path.join(ROOT, "node_modules", ".gen-ui-build");
  rmSync(tmpOut, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [entry],
    format: "iife",
    target: "browser",
    minify: true,
    naming: { entry: "[name].iife.js" },
    outdir: tmpOut,
  });
  if (!result.success) {
    console.warn(`[vendor-gen-ui] bundle failed for ${lib.name}:`, result.logs);
    return;
  }
  const bundled = await Bun.file(result.outputs[0].path).text();
  // Sanity: the IIFE must close itself and assign its global.
  if (!/\}\)\(\);\s*$/.test(bundled)) {
    console.warn(`[vendor-gen-ui] ${lib.name}: unexpected bundle tail, skipping`);
    return;
  }
  if (!bundled.includes(`globalThis.${lib.global}=`) && !bundled.includes(`globalThis.${lib.global} =`)) {
    console.warn(`[vendor-gen-ui] ${lib.name}: global ${lib.global} not assigned, skipping`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  Bun.write(path.join(outDir, lib.name), bundled);
  console.log(`[vendor-gen-ui] ${lib.name} (${(bundled.length / 1024).toFixed(0)} KB, IIFE ${lib.global})`);
  rmSync(tmpOut, { recursive: true, force: true });
}

export async function vendorGenUiLibs(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const lib of COPIED) {
    if (!existsSync(lib.from)) {
      console.warn(`[vendor-gen-ui] missing ${lib.from} (run bun install?)`);
      continue;
    }
    copyFileSync(lib.from, path.join(outDir, lib.name));
    const size = readFileSync(path.join(outDir, lib.name)).length;
    console.log(`[vendor-gen-ui] ${lib.name} (${(size / 1024).toFixed(0)} KB)`);
  }
  for (const lib of BUNDLED) await bundleLib(lib);
  for (const lib of STYLED) inlineStyle(lib);
}

if (import.meta.main) await vendorGenUiLibs();
