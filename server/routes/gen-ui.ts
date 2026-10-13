import { existsSync, readFileSync } from "fs";
import path from "path";

import { err, json, readJsonBody } from "../http";
import {
  buildJsxImportMap,
  buildJsxModuleBody,
  buildReactShimModule,
  buildWidgetDocument,
  makeScriptNonce,
  widgetCSP,
} from "../../web/src/indirect-code/components/generative-ui/widget-doc";
import { compileJsxModule } from "../../web/src/indirect-code/components/generative-ui/jsx-compile";
import { GEN_UI_LIB_FILES } from "../../scripts/vendor-gen-ui-libs";
import { createHash } from "crypto";

/**
 * Generative UI widget documents (React `@jsx` widgets only).
 *
 * The gateway CSP is frame-src allowlist-only and forbids inline frames, so
 * sandboxed widget documents are served as real same-origin documents:
 *
 *  POST /api/indirect-code/gen-ui/widgets       -> store a widget, get its URL
 *  GET  /api/indirect-code/gen-ui/widgets/:id   -> the widget document (CSP header)
 *  GET  /api/indirect-code/gen-ui/modules/:id   -> a stored widget module (ESM)
 *  GET  /api/indirect-code/gen-ui/lib/:file     -> vendored library modules (ESM)
 *
 * A widget is one React component. Its source is compiled with the Bun
 * transpiler at doc build time (the sandbox has no 'unsafe-eval', so the
 * frame only ever runs plain JS) and stored as a standalone ES module; the
 * document references it through an import map together with the vendored
 * library modules — one shared, cacheable copy per library instead of an
 * inline copy per document. Broken sources are a 400 with the compiler
 * message — the widget never mounts half-working.
 *
 * Security contract (two independent layers):
 *  - every document carries `Content-Security-Policy: sandbox allow-scripts;
 *    default-src 'none'; ...` — the CSP `sandbox` directive applies even when
 *    the document is opened at top level, so the widget always runs in an
 *    opaque origin (network limited to http(s) images, https data and esm.sh
 *    libs). Module/lib responses are plain scripts fetched by that document:
 *    same-origin, immutable, and only ever loaded under a sandboxed
 *    document's import map;
 *  - widget and module ids are sha256(content): unguessable and
 *    deduplicated. No auth is required to fetch a widget (iframes cannot
 *    send headers) and a widget document is inert without its exact content
 *    hash.
 *
 * Stores are in-memory LRUs: transcripts re-upload their widgets on load
 * (the DSL lives in the message markdown), so nothing needs to survive a
 * restart. Bounded at STORE_MAX entries / STORE_MAX_BYTES.
 */

const STORE_MAX = 400;
const STORE_MAX_BYTES = 64 * 1024 * 1024;

type Entry = { id: string; body: string; bytes: number };

function makeStore() {
  const map = new Map<string, Entry>();
  let bytes = 0;
  return {
    get(id: string): Entry | undefined {
      const e = map.get(id);
      if (e) {
        // Refresh LRU position.
        map.delete(id);
        map.set(id, e);
      }
      return e;
    },
    put(id: string, body: string): Entry {
      const existing = map.get(id);
      if (existing) {
        map.delete(id);
        map.set(id, existing);
        return existing;
      }
      const entry: Entry = { id, body, bytes: body.length };
      map.set(id, entry);
      bytes += entry.bytes;
      while (map.size > STORE_MAX || bytes > STORE_MAX_BYTES) {
        const oldest = map.entries().next().value as [string, Entry] | undefined;
        if (!oldest) break;
        map.delete(oldest[0]);
        bytes -= oldest[1].bytes;
      }
      return entry;
    },
    size: () => map.size,
  };
}

const widgets = makeStore();
const modules = makeStore();

/** Content-addressed id: identical content maps to one entry. */
function contentId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/* ---------------- vendored library modules ---------------- */

/** Candidate roots for the vendored build output (gitignored artifacts). */
const VENDOR_DIRS = [
  path.resolve("web/public/vendor/gen-ui"),
  path.resolve("dist/vendor/gen-ui"),
];

function readVendorFile(file: string): string | null {
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
const LIB_MODULE_FILES = new Set<string>(Object.values(GEN_UI_LIB_FILES));
const LIB_CSS_FILES = new Set<string>(["map.css"]);

function libContentType(file: string): string {
  return file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
}

/** Cross-origin read is required: widget frames are opaque origins. */
function moduleHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  };
}

/** Inline stylesheet text for a lib (e.g. leaflet css with inlined images). */
function libCssSource(name: string): string | null {
  const file = GEN_UI_LIB_FILES[name] ? `${name}.css` : null;
  if (!file || !LIB_CSS_FILES.has(file)) return null;
  return readVendorFile(file);
}

/* ---------------- routes ---------------- */

export async function handleGenUiRoute(
  path: string,
  req: Request,
  _url: URL,
): Promise<Response | null> {
  if (path === "/api/indirect-code/gen-ui/widgets" && req.method === "POST") {
    const body = await readJsonBody(req, 2_500_000);
    const theme: "dark" | "light" = body?.theme === "light" ? "light" : "dark";
    const jsx = typeof body?.jsx === "string" ? body.jsx : "";
    const stateJSON = typeof body?.stateJSON === "string" ? body.stateJSON : "{}";
    if (!jsx.trim()) return err(400, "empty widget", req);
    const total = jsx.length + stateJSON.length;
    if (total > 1_500_000) return err(413, "widget too large", req);
    // The source compiles here, at doc build time: the widget sandbox has no
    // 'unsafe-eval', so it only ever runs plain JS.
    const compiled = compileJsxModule(jsx);
    if (!compiled.ok) return err(400, `invalid jsx: ${compiled.error}`, req);
    const libs = Array.isArray(body?.libs)
      ? (body.libs as unknown[]).filter((l): l is string => typeof l === "string").slice(0, 4)
      : ["d3"];

    // The compiled widget lives as its own module: identical source shares
    // one module entry, and the document stays tiny.
    const moduleBody = buildJsxModuleBody(compiled.code);
    const moduleId = contentId([moduleBody]);
    modules.put(moduleId, moduleBody);
    const moduleUrl = `/api/indirect-code/gen-ui/modules/${moduleId}`;

    const id = contentId([theme, moduleId, stateJSON, libs]);
    const existing = widgets.get(id);
    if (existing) {
      return json({ success: true, id: existing.id, url: `/api/indirect-code/gen-ui/widgets/${existing.id}` }, { req });
    }
    const nonce = makeScriptNonce();
    const importMap = buildJsxImportMap({
      react: "/api/indirect-code/gen-ui/lib/react-shim.js",
      libs: Object.fromEntries(
        libs
          .filter((name) => GEN_UI_LIB_FILES[name])
          .map((name) => [name, `/api/indirect-code/gen-ui/lib/${GEN_UI_LIB_FILES[name]}`]),
      ),
    });
    const doc = buildWidgetDocument({
      theme,
      moduleUrl,
      importMap,
      stateJSON,
      scriptNonce: nonce,
      libCss: libs.includes("map") ? libCssSource("map") ?? undefined : undefined,
    });
    const entry = widgets.put(id, doc);
    return json({ success: true, id: entry.id, url: `/api/indirect-code/gen-ui/widgets/${entry.id}` }, { req });
  }

  const widgetMatch = /^\/api\/indirect-code\/gen-ui\/widgets\/([0-9a-f]{64})$/.exec(path);
  if (widgetMatch && req.method === "GET") {
    const entry = widgets.get(widgetMatch[1]);
    if (!entry) return err(404, "widget not found", req);
    // The nonce lives in the stored document: the CSP header must carry the
    // same value (the doc is immutable, so it can be re-derived on read).
    const nonceMatch = /script-src 'nonce-([0-9a-f]{32})'/.exec(entry.body);
    const nonce = nonceMatch?.[1] || "";
    return new Response(entry.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": widgetCSP(nonce),
        "x-content-type-options": "nosniff",
      },
    });
  }

  const moduleMatch = /^\/api\/indirect-code\/gen-ui\/modules\/([0-9a-f]{64})$/.exec(path);
  if (moduleMatch && req.method === "GET") {
    const entry = modules.get(moduleMatch[1]);
    if (!entry) return err(404, "module not found", req);
    return new Response(entry.body, { headers: moduleHeaders("text/javascript; charset=utf-8") });
  }

  const libMatch = /^\/api\/indirect-code\/gen-ui\/lib\/([\w.-]+)$/.exec(path);
  if (libMatch && req.method === "GET") {
    const file = libMatch[1];
    if (file === "react-shim.js") {
      return new Response(buildReactShimModule(), { headers: moduleHeaders("text/javascript; charset=utf-8") });
    }
    if (!LIB_MODULE_FILES.has(file) && !LIB_CSS_FILES.has(file)) return err(404, "unknown lib", req);
    const source = readVendorFile(file);
    if (source == null) return err(404, "lib not vendored (run build)", req);
    return new Response(source, { headers: moduleHeaders(libContentType(file)) });
  }

  // Anything else under the gen-ui namespace is a 404, not an unhandled
  // route (the namespace is self-contained).
  if (path.startsWith("/api/indirect-code/gen-ui/")) return err(404, "not found", req);

  return null;
}

/** Test hook: widget/module store sizes (bounded LRUs). */
export function genUiStoreSize(): number {
  return widgets.size();
}
