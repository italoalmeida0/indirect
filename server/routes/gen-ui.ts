import { existsSync, readFileSync } from "fs";

import { err, json, readJsonBody } from "../http";
import {
  buildPreviewDocument,
  buildWidgetDocument,
  makeScriptNonce,
  widgetCSP,
  widgetNetCSP,
  withIdiomorph,
} from "../../web/src/indirect-code/components/generative-ui/widget-doc";
import { IDIOMORPH_JS } from "../../web/src/indirect-code/components/generative-ui/idiomorph-inline";
import { createHash } from "crypto";

/**
 * Generative UI widget documents.
 *
 * The gateway CSP is frame-src allowlist-only and forbids inline frames, so
 * sandboxed widget documents are served as real same-origin documents:
 *
 *  POST /api/indirect-code/gen-ui/widgets      -> store a widget, get its URL
 *  GET  /api/indirect-code/gen-ui/widgets/:id  -> the widget document (CSP header)
 *  GET  /api/indirect-code/gen-ui/preview      -> the streaming preview shell
 *
 * Security contract (two independent layers):
 *  - every response carries `Content-Security-Policy: sandbox allow-scripts;
 *    default-src 'none'; ...` — the CSP `sandbox` directive applies even when
 *    the document is opened at top level, so the widget always runs in an
 *    opaque origin (network limited to http(s) images, plus https/esm.sh
 *    when the widget opts into `net`);
 *  - widget ids are sha256(content): unguessable and deduplicated. No auth is
 *    required to fetch a widget (iframes cannot send headers) and a widget
 *    document is inert without its exact content hash.
 *
 * The store is an in-memory LRU: transcripts re-upload their widgets on load
 * (the DSL lives in the message markdown), so nothing needs to survive a
 * restart. Bounded at WIDGET_STORE_MAX docs / WIDGET_STORE_MAX_BYTES.
 */

const WIDGET_STORE_MAX = 400;
const WIDGET_STORE_MAX_BYTES = 64 * 1024 * 1024;

type WidgetEntry = { id: string; html: string; bytes: number; net: boolean };
const widgets = new Map<string, WidgetEntry>();
let widgetsBytes = 0;

/** Content-addressed id: identical widget content maps to one document. */
function widgetContentId(parts: {
  theme: string; html: string; css: string; js: string; stateJSON: string; initialHeight: number;
  libs: string[]; net: boolean;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.theme, parts.html, parts.css, parts.js, parts.stateJSON, parts.initialHeight, parts.libs, parts.net]))
    .digest("hex");
}

function putWidget(id: string, html: string, net: boolean): WidgetEntry {
  const existing = widgets.get(id);
  if (existing) {
    // Refresh LRU position.
    widgets.delete(id);
    widgets.set(id, existing);
    return existing;
  }
  const entry: WidgetEntry = { id, html, bytes: html.length, net };
  widgets.set(id, entry);
  widgetsBytes += entry.bytes;
  while (widgets.size > WIDGET_STORE_MAX || widgetsBytes > WIDGET_STORE_MAX_BYTES) {
    const oldest = widgets.entries().next().value as [string, WidgetEntry] | undefined;
    if (!oldest) break;
    widgets.delete(oldest[0]);
    widgetsBytes -= oldest[1].bytes;
  }
  return entry;
}

/**
 * Widget libraries (d3, gsap, chart.js, three) are inlined into widget
 * documents so they work offline (scripts are nonce-only; esm.sh is the
 * `net` opt-in escape hatch for anything else). Sources come from the
 * vendored build output, falling back to node_modules for dev checkouts.
 * Cached per library; a missing library is simply omitted.
 */
const LIB_CANDIDATES: Record<string, string[]> = {
  d3: ["dist/vendor/gen-ui/d3.min.js", "web/public/vendor/gen-ui/d3.min.js", "node_modules/d3/dist/d3.min.js"],
  gsap: ["dist/vendor/gen-ui/gsap.min.js", "web/public/vendor/gen-ui/gsap.min.js"],
  chart: ["dist/vendor/gen-ui/chart.min.js", "web/public/vendor/gen-ui/chart.min.js"],
  three: ["dist/vendor/gen-ui/three.min.js", "web/public/vendor/gen-ui/three.min.js"],
  map: ["dist/vendor/gen-ui/leaflet.js", "web/public/vendor/gen-ui/leaflet.js", "node_modules/leaflet/dist/leaflet.js"],
};

const LIB_CSS_CANDIDATES: Record<string, string[]> = {
  map: ["dist/vendor/gen-ui/map.css", "web/public/vendor/gen-ui/map.css"],
};
const libSourceCache = new Map<string, string | null>();
function libSource(name: string): string | null {
  if (libSourceCache.has(name)) return libSourceCache.get(name)!;
  let source: string | null = null;
  for (const p of LIB_CANDIDATES[name] ?? []) {
    try {
      if (existsSync(p)) {
        source = readFileSync(p, "utf8");
        break;
      }
    } catch {
      // keep looking
    }
  }
  libSourceCache.set(name, source);
  return source;
}

const libCssCache = new Map<string, string | null>();
function libCssSource(name: string): string | null {
  if (libCssCache.has(name)) return libCssCache.get(name)!;
  let source: string | null = null;
  for (const p of LIB_CSS_CANDIDATES[name] ?? []) {
    try {
      if (existsSync(p)) {
        source = readFileSync(p, "utf8");
        break;
      }
    } catch {
      // keep looking
    }
  }
  libCssCache.set(name, source);
  return source;
}

/** Resolved library sources for a widget body (keyed by lib name). */
function resolveWidgetLibs(libs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of libs && libs.length ? libs : ["d3"]) {
    const source = libSource(name);
    if (source) out[name] = source;
  }
  return out;
}

/** Resolved library stylesheets (keyed by lib name). */
function resolveWidgetLibCss(libs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of libs && libs.length ? libs : ["d3"]) {
    const source = libCssSource(name);
    if (source) out[name] = source;
  }
  return out;
}

function widgetDocHeaders(nonce: string, net = false): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": net ? widgetNetCSP(nonce) : widgetCSP(nonce),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}

export async function handleGenUiRoute(
  path: string,
  req: Request,
  _url: URL,
): Promise<Response | null> {
  if (path === "/api/indirect-code/gen-ui/widgets" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, 2_000_000);
    } catch {
      return err(400, "invalid JSON body", req);
    }
    const theme: "dark" | "light" = body?.theme === "light" ? "light" : "dark";
    const html = typeof body?.html === "string" ? body.html : "";
    const css = typeof body?.css === "string" ? body.css : "";
    const js = typeof body?.js === "string" ? body.js : "";
    const stateJSON = typeof body?.stateJSON === "string" ? body.stateJSON : "{}";
    const initialHeight = Number(body?.initialHeight) || 320;
    if (!html && !css && !js) return err(400, "empty widget", req);
    const total = html.length + css.length + js.length + stateJSON.length;
    if (total > 1_500_000) return err(413, "widget too large", req);
    const height = Math.min(4000, Math.max(64, initialHeight));
    const libs = Array.isArray(body?.libs)
      ? (body.libs as unknown[]).filter((l): l is string => typeof l === "string").slice(0, 4)
      : ["d3"];
    const net = body?.net === true;
    const id = widgetContentId({ theme, html, css, js, stateJSON, initialHeight: height, libs, net });
    const existing = widgets.get(id);
    if (existing) {
      // Refresh LRU position; the document is deterministic per content.
      widgets.delete(id);
      widgets.set(id, existing);
      return json({ success: true, id: existing.id, url: `/api/indirect-code/gen-ui/widgets/${existing.id}` }, { req });
    }
    const nonce = makeScriptNonce();
    const doc = buildWidgetDocument({
      theme, html, css, stateJSON, js,
      initialHeight: height,
      scriptNonce: nonce,
      libs: resolveWidgetLibs(libs),
      libCss: resolveWidgetLibCss(libs),
      net,
    });
    const entry = putWidget(id, doc, net);
    return json({ success: true, id: entry.id, url: `/api/indirect-code/gen-ui/widgets/${entry.id}` }, { req });
  }

  const widgetMatch = /^\/api\/indirect-code\/gen-ui\/widgets\/([0-9a-f]{64})$/.exec(path);
  if (widgetMatch && req.method === "GET") {
    const entry = widgets.get(widgetMatch[1]);
    if (!entry) return err(404, "widget not found", req);
    // The doc is already a complete document: re-derive a nonce-agnostic CSP
    // is impossible (the nonce lives in the doc), so serve with the same CSP
    // string built into the doc header check: extract it from the stored doc.
    // `net` widgets get the opt-in https variant (the strict header would
    // override their meta otherwise).
    const nonceMatch = /script-src 'nonce-([0-9a-f]{32})'/.exec(entry.html);
    return new Response(entry.html, {
      headers: widgetDocHeaders(nonceMatch?.[1] || "", entry.net),
    });
  }

  if (path === "/api/indirect-code/gen-ui/preview" && req.method === "GET") {
    const nonce = makeScriptNonce();
    const theme: "dark" | "light" = _url.searchParams.get("theme") === "light" ? "light" : "dark";
    const doc = withIdiomorph(buildPreviewDocument({ theme, scriptNonce: nonce }), IDIOMORPH_JS);
    return new Response(doc, { headers: widgetDocHeaders(nonce) });
  }

  return null;
}

/** Exposed for black-box tests. */
export function genUiStoreSize(): number {
  return widgets.size;
}
