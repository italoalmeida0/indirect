/**
 * Generative UI TSX compilation (server + tests only — do NOT import from
 * SPA-bundled code; this runs where Bun's native transpiler is available).
 *
 * The widget is plain React (JSX + TypeScript types allowed), compiled to a
 * single native ES module at document-build time with `Bun.Transpiler`
 * (loader "tsx"): types are stripped and JSX lowers to
 * `React.createElement` calls (classic pragma — the embedded runtime
 * installs the `React` global, so modules need no react import to render).
 *
 * `import`/`export` statements are KEPT (ESM is the widget module format):
 * the document carries an import map, so `react`, `react-dom` and
 * `react-dom/client` resolve to the embedded runtime shim module and
 * `d3`/`gsap`/`chart`/`three`/`leaflet` to the vendored library modules
 * served from /api/indirect-code/gen-ui/lib/. Anything else is rejected at
 * compile time (the widget CSP allows exactly those origins).
 *
 * The widget CSP has no 'unsafe-eval', so compilation happens here, never
 * inside the frame; the output is stored and served as a plain module script.
 */
import { enforceModelModule } from "./model-code";

const IMPORT_RE =
  /(?:^|[\s;}])(?:import\s*(?:[\w$*{},\s]*?from\s*)?|export\s*[\w$*{},\s]*?from\s*)["']([^"']+)["']/g;

/**
 * Shallow specifier scan used ONLY for the lib-global prelude below. The
 * real import audit is AST-based (model-code.ts: acorn parse, every static
 * and dynamic specifier checked as a literal — a regex cannot see
 * `import(u)`).
 */
function jsxBareSpecifiers(src: string): string[] {
  const out = new Set<string>();
  IMPORT_RE.lastIndex = 0;
  for (const m of src.matchAll(IMPORT_RE)) out.add(m[1]);
  return [...out];
}

export type JsxCompileResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

const transpiler = new Bun.Transpiler({
  loader: "tsx",
  // Explicit classic pragma: the widget runtime installs window.React as a
  // global before the module loads, so compiled calls work with or without a
  // react import in the source.
  tsconfig: JSON.stringify({ compilerOptions: { jsx: "react" } }),
});

/**
 * Lib globals a widget may use without importing. Widgets SHOULD import
 * (`import * as THREE from "three"`), but a model that reads the classic
 * global still works: a side-effect import is prepended so the module loads
 * and assigns its global. Detection is conservative (distinctive tokens and
 * known leaflet entry points only).
 */
const GLOBAL_USAGE: { specifier: string; pattern: RegExp }[] = [
  { specifier: "three", pattern: /\bTHREE\b/ },
  { specifier: "d3", pattern: /\bd3\s*\./ },
  { specifier: "gsap", pattern: /\bgsap\s*[.(]/ },
  { specifier: "chart", pattern: /\bChart\s*[.(]/ },
  { specifier: "leaflet", pattern: /\bL\s*\.\s*(?:map|marker|tileLayer|polyline|polygon|circle|circleMarker|latLng|icon|divIcon|featureGroup|layerGroup|geoJSON|control)\s*\(|\bwindow\s*\.\s*L\b/ },
  { specifier: "cannon-es", pattern: /\bCANNON\b/ },
  { specifier: "matter-js", pattern: /\bMatter\s*\./ },
];

/** Prepend side-effect imports for libs the code uses but never imports. */
function injectGlobalImports(code: string): string {
  const imported = new Set(jsxBareSpecifiers(code));
  const prelude: string[] = [];
  for (const { specifier, pattern } of GLOBAL_USAGE) {
    if (imported.has(specifier) || !pattern.test(code)) continue;
    prelude.push(`import ${JSON.stringify(specifier)};`);
  }
  return prelude.length ? prelude.join("\n") + "\n" + code : code;
}

/**
 * Compile the widget source to one ESM body. Imports of anything the widget
 * import map cannot resolve are a compile error — they would be dead weight
 * in the CSP-locked document (or, for esm.sh URLs, silently unusable outside
 * `net: true`).
 */
export function compileJsxModule(src: string): JsxCompileResult {
  let transformed: string;
  try {
    transformed = injectGlobalImports(transpiler.transformSync(src));
  } catch (err) {
    // Bun throws an AggregateError with structured position entries.
    const errors = (err as { errors?: { message?: string; position?: { line?: number } }[] }).errors;
    if (Array.isArray(errors) && errors.length) {
      const first = errors[0];
      const at = typeof first.position?.line === "number" ? ` (line ${first.position!.line})` : "";
      return { ok: false, error: `${first.message ?? "parse error"}${at}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // The model-code boundary: acorn parse -> import audit -> AST sanitizing
  // -> astring generate. Import validation lives there (a regex cannot see
  // `import(u)`); this returns the final module source or a compile error.
  return enforceModelModule(transformed);
}
