/**
 * Vendors the widget libraries used by generative_ui widgets into
 * web/public/vendor/gen-ui/ as ES modules, so widget documents can import
 * them by URL (served through /api/indirect-code/gen-ui/lib/) instead of
 * inlining a copy per document. One cached, shared file per library — the
 * widget sandbox stays offline-capable (CSP default-src 'none'; lib modules
 * are the only script sources besides the document nonce).
 *
 * d3 and leaflet have ESM-friendly packages; three, gsap and chart.js are
 * bundled to single-file ESM from the tiny entrypoints in
 * scripts/gen-ui-libs/ (each entry also assigns the classic global —
 * globalThis.d3 / gsap / Chart / THREE / L — for widget code that reads the
 * global instead of importing).
 *
 * Run via `bun run vendor:gen-ui` or automatically from build.ts. The
 * outputs are build artifacts (gitignored): every run regenerates them from
 * node_modules.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(ROOT, "web", "public", "vendor", "gen-ui");

/**
 * Stylesheets inlined into widgets: url(images/...) references are rewritten
 * to data URIs so the sandbox (img-src data: blob:) can render them offline.
 */
/**
 * Stylesheets embedded INTO a lib module (the module injects a <style> on
 * import): url(images/...) references are rewritten to data URIs so the
 * sandbox (img-src data: blob:) can render them offline. Embedding keeps the
 * widget doc CSS-free — `import * as L from "leaflet"` brings its style.
 */
const STYLED: { jsName: string; from: string; imagesDir: string }[] = [
  {
    jsName: "leaflet.js",
    from: path.join(ROOT, "node_modules", "leaflet", "dist", "leaflet.css"),
    imagesDir: path.join(ROOT, "node_modules", "leaflet", "dist", "images"),
  },
];

/**
 * Libraries bundled to single-file ESM via scripts/gen-ui-libs/entry-<name>.ts
 * (each entry re-exports the package and assigns globalThis.<global>).
 */
const BUNDLED: { name: string; entry: string; global: string }[] = [
  { name: "d3.js", entry: "entry-d3.ts", global: "d3" },
  { name: "gsap.js", entry: "entry-gsap.ts", global: "gsap" },
  { name: "chart.js", entry: "entry-chart.ts", global: "Chart" },
  { name: "three.js", entry: "entry-three.ts", global: "THREE" },
  { name: "leaflet.js", entry: "entry-map.ts", global: "L" },
  { name: "cannon-es.js", entry: "entry-cannon.ts", global: "CANNON" },
  { name: "matter-js.js", entry: "entry-matter.ts", global: "Matter" },
];

/**
 * Every library module file the widget runtime may import, keyed by the
 * import specifier widget code writes (`import * as THREE from "three"`).
 * The import map maps these specifiers to the served module files.
 */
export const GEN_UI_LIB_FILES: Record<string, string> = {
  d3: "d3.js",
  gsap: "gsap.js",
  chart: "chart.js",
  three: "three.js",
  leaflet: "leaflet.js",
  "cannon-es": "cannon-es.js",
  cannon: "cannon-es.js",
  "matter-js": "matter-js.js",
  matter: "matter-js.js",
};

function inlineStyle(lib: (typeof STYLED)[number]): string {
  if (!existsSync(lib.from)) {
    console.warn(`[vendor-gen-ui] missing ${lib.from}, skipping style for ${lib.jsName}`);
    return "";
  }
  return readFileSync(lib.from, "utf8").replace(
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
}

/** Style-injection snippet appended to a lib module (runs on import). */
function styleInjection(css: string): string {
  if (!css) return "";
  return (
    "\n;(() => {\n" +
    '  const s = document.createElement("style");\n' +
    `  s.textContent = ${JSON.stringify(css)};\n` +
    "  (document.head || document.documentElement).appendChild(s);\n" +
    "})();\n"
  );
}

async function bundleLib(lib: { name: string; entry: string; global: string }): Promise<void> {
  const dest = path.join(outDir, lib.name);
  try {
    const entry = path.join(ROOT, "scripts", "gen-ui-libs", lib.entry);
    if (!existsSync(entry)) {
      console.warn(`[vendor-gen-ui] missing entry ${entry}, skipping ${lib.name}`);
      return;
    }
    const tmpOut = path.join(ROOT, "node_modules", ".gen-ui-build");
    rmSync(tmpOut, { recursive: true, force: true });
    const result = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      target: "browser",
      minify: true,
      naming: { entry: "[name].esm.js" },
      outdir: tmpOut,
    });
    if (!result.success) {
      console.warn(`[vendor-gen-ui] bundle failed for ${lib.name}:`, result.logs);
      if (existsSync(dest)) {
        console.log(`[vendor-gen-ui] keeping existing committed ${lib.name}`);
      }
      return;
    }
    const bundled = await Bun.file(result.outputs[0].path).text();
    // Sanity: the module must close itself and expose its global.
    if (!/\bexport\s*\{/.test(bundled) && !/\bexport\s+default\b/.test(bundled)) {
      console.warn(`[vendor-gen-ui] ${lib.name}: no exports in bundle, skipping`);
      return;
    }
    if (!bundled.includes(`globalThis.${lib.global}=`) && !bundled.includes(`globalThis.${lib.global} =`)) {
      console.warn(`[vendor-gen-ui] ${lib.name}: global ${lib.global} not assigned, skipping`);
      return;
    }
    mkdirSync(outDir, { recursive: true });
    const styled = STYLED.find((s) => s.jsName === lib.name);
    const extra = styled ? styleInjection(inlineStyle(styled)) : "";
    Bun.write(dest, bundled + extra);
    console.log(
      `[vendor-gen-ui] ${lib.name} (${((bundled.length + extra.length) / 1024).toFixed(0)} KB, ESM ${lib.global}${extra ? " + css" : ""})`,
    );
    rmSync(tmpOut, { recursive: true, force: true });
  } catch (err) {
    if (existsSync(dest)) {
      console.warn(`[vendor-gen-ui] error bundling ${lib.name}, keeping existing committed file:`, err);
    } else {
      console.warn(`[vendor-gen-ui] error bundling ${lib.name}:`, err);
    }
  }
}

export async function vendorGenUiLibs(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const lib of BUNDLED) await bundleLib(lib); // styles embed here
}

if (import.meta.main) await vendorGenUiLibs();
