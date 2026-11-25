import { err, hasControlCharacters, isTrustedProxy, json, readJsonBody } from "../http";
import { requireAuth } from "../auth";
import { db } from "../db";
import { sha256Hex } from "../crypto";
import { isBlockedAddress, safeExternalFetch, SafeFetchError } from "../safe-fetch";
import { runWidgetLint, WidgetLintBusyError } from "./widget-lint";
import { handleGenUiAiRoute } from "./gen-ui-ai";
import {
  buildJsxImportMap,
  buildJsxModuleBody,
  buildReactShimModule,
  buildWidgetDocument,
  makeScriptNonce,
  widgetCSP,
  type WidgetDocParams,
} from "../../web/src/indirect-code/components/generative-ui/widget-doc";
import { compileJsxModule } from "../../web/src/indirect-code/components/generative-ui/jsx-compile";
import { GEN_UI_LIB_FILES, LIB_MODULE_FILES, readVendorFile } from "./gen-ui-libs";
import { createHash } from "crypto";

export { isBlockedAddress };

/**
 * Generative UI widget documents (React TSX widgets only).
 *
 * The gateway CSP is frame-src allowlist-only and forbids inline frames, so
 * sandboxed widget documents are served as real same-origin documents:
 *
 *  POST /api/indirect-code/gen-ui/widgets       -> store a widget, get its URL
 *  GET  /api/indirect-code/gen-ui/widgets/:id   -> the widget document (CSP header)
 *  GET  /api/indirect-code/gen-ui/modules/:id   -> a stored widget module (ESM)
 *  GET  /api/indirect-code/gen-ui/lib/:file     -> vendored library modules (ESM)
 *  POST /api/indirect-code/gen-ui/lint          -> lint a widget source (daemon token)
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

type Entry<T> = { id: string; body: T; bytes: number };

function makeStore<T = string>(measure: (body: T) => number = (body) => (body as string).length) {
  const map = new Map<string, Entry<T>>();
  let bytes = 0;
  return {
    get(id: string): Entry<T> | undefined {
      const e = map.get(id);
      if (e) {
        // Refresh LRU position.
        map.delete(id);
        map.set(id, e);
      }
      return e;
    },
    put(id: string, body: T): Entry<T> {
      const existing = map.get(id);
      if (existing) {
        map.delete(id);
        map.set(id, existing);
        return existing;
      }
      const entry: Entry<T> = { id, body, bytes: measure(body) };
      map.set(id, entry);
      bytes += entry.bytes;
      while (map.size > STORE_MAX || bytes > STORE_MAX_BYTES) {
        const oldest = map.entries().next().value as [string, Entry<T>] | undefined;
        if (!oldest) break;
        map.delete(oldest[0]);
        bytes -= oldest[1].bytes;
      }
      return entry;
    },
    size: () => map.size,
  };
}

/** Stored widget: the document itself is rendered per request origin. */
type WidgetDoc = Omit<WidgetDocParams, "origin">;

const widgets = makeStore<WidgetDoc>(
  (doc) => doc.theme.length + doc.moduleUrl.length + doc.importMap.length + doc.stateJSON.length + doc.scriptNonce.length,
);
const modules = makeStore();

/** Content-addressed id: identical content maps to one entry. */
function contentId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Public origin of this deployment. CSP script sources must be absolute
 * (paths are rejected and `self` is meaningless in the widget's opaque
 * sandbox origin), so every CSP string is pinned to the origin the client
 * reached us on — with reverse-proxy headers honored exactly like
 * server/http.ts does for client IPs.
 */
function requestOrigin(req: Request, server?: { requestIP(req: Request): { address: string } | null }): string {
  if (isTrustedProxy(req, server)) {
    const rawHost = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0]!.trim();
    const proto = (req.headers.get("x-forwarded-proto") || "https").split(",")[0]!.trim().toLowerCase();
    if (
      rawHost &&
      rawHost.length <= 255 &&
      !hasControlCharacters(rawHost) &&
      !/[\s/\\?#@]/.test(rawHost) &&
      (proto === "http" || proto === "https")
    ) {
      try {
        const parsed = new URL(`${proto}://${rawHost}/`);
        if (!parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash) {
          return parsed.origin;
        }
      } catch {}
    }
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

/* ---------------- vendored library modules ---------------- */

function libContentType(_file: string): string {
  return "text/javascript; charset=utf-8";
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

/* ---------------- image proxy ----------------
 *
 * Widgets load <img> through this endpoint (the runtime rewrites every
 * remote src): it bypasses hotlink protection (no referrer, gateway IP),
 * keeps one cached copy per URL, and lets the deliverable be ANALYZED
 * before it reaches the frame — the served content-type comes from the
 * binary signature, never from the upstream header, and a document-shaped
 * response (error page, HTML) is refused.
 *
 * SSRF is the flip side of fetching model-chosen URLs, so every hop is
 * validated: http(s) only, no credentials, hostnames/addresses checked
 * against loopback/RFC1918/link-local/metadata ranges (DNS resolved before
 * the request; redirects re-validated, max 3), 10s timeout, 8MB cap,
 * no cookies. Responses are served with nosniff + `CSP: sandbox` (a
 * top-level open can never execute, e.g. an SVG) + ACAO * (opaque-origin
 * widget frames need it for canvas/WebGL textures).
 */

const IMG_MAX_BYTES = 8 * 1024 * 1024;
const IMG_TIMEOUT_MS = 10_000;
const IMG_MAX_REDIRECTS = 3;
const IMG_MAX_CONCURRENT = 8;
const IMG_MAX_QUEUE = 24;

type ImgEntry = { bytes: Uint8Array; type: string };
const imgCache = new Map<string, ImgEntry>();
let imgCacheBytes = 0;
const inFlightImgs = new Map<string, Promise<ImgEntry>>();

let activeImgDownloads = 0;
const imgWaitQueue: Array<() => void> = [];

class ImgProxyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function acquireImgSlot(): Promise<() => void> {
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = imgWaitQueue.shift();
      if (next) {
        next();
      } else {
        activeImgDownloads = Math.max(0, activeImgDownloads - 1);
      }
    };
  };
  if (activeImgDownloads < IMG_MAX_CONCURRENT) {
    activeImgDownloads++;
    return Promise.resolve(makeRelease());
  }
  if (imgWaitQueue.length >= IMG_MAX_QUEUE) {
    return Promise.reject(new ImgProxyError(503, "image: too many concurrent downloads"));
  }
  return new Promise<() => void>((resolve) => {
    imgWaitQueue.push(() => resolve(makeRelease()));
  });
}

function putImage(url: string, entry: ImgEntry): void {
  const existing = imgCache.get(url);
  if (existing) {
    imgCache.delete(url);
    imgCache.set(url, existing);
    return;
  }
  imgCache.set(url, entry);
  imgCacheBytes += entry.bytes.byteLength;
  while (imgCache.size > 200 || imgCacheBytes > 32 * 1024 * 1024) {
    const oldest = imgCache.entries().next().value as [string, ImgEntry] | undefined;
    if (!oldest) break;
    imgCache.delete(oldest[0]);
    imgCacheBytes -= oldest[1].bytes.byteLength;
  }
}

/** Binary signature -> served content-type. The only truth for `is an image`. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes;
  const ascii = (start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(4, 4) === "ftyp" && /(?:avif|avis|heic|heix|mif1)/.test(ascii(8, 4))) return "image/avif";
  // SVG: text, may start with BOM / xml prolog / doctype before <svg.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 512)).replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/** Quick synchronous URL pre-check so obvious bad/blocked URLs never occupy a download slot. */
function precheckImageUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImgProxyError(400, "image: invalid url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ImgProxyError(400, "image: invalid url");
  }
  if (url.username || url.password) {
    throw new ImgProxyError(400, "image: invalid url");
  }
  if (isBlockedAddress(url.hostname)) {
    throw new ImgProxyError(403, "image: blocked address");
  }
}

/** Fetch one image URL with every hop validated, under the global concurrency cap. */
async function fetchImage(raw: string): Promise<ImgEntry> {
  precheckImageUrl(raw);
  const release = await acquireImgSlot();
  try {
    const res = await safeExternalFetch(raw, {
      maxBytes: IMG_MAX_BYTES,
      timeoutMs: IMG_TIMEOUT_MS,
      maxRedirects: IMG_MAX_REDIRECTS,
      headers: { accept: "image/*,*/*;q=0.5" },
    });
    const mime = sniffImageMime(res.bytes);
    if (!mime) throw new ImgProxyError(415, "image: not an image");
    return { bytes: res.bytes, type: mime };
  } finally {
    release();
  }
}

function mapImageFetchError(e: unknown): { status: number; message: string } {
  if (e instanceof ImgProxyError) {
    return { status: e.status, message: e.message };
  }
  if (e instanceof SafeFetchError) {
    switch (e.code) {
      case "too_large":
        return { status: 413, message: "image: too large" };
      case "blocked":
        return { status: 403, message: "image: blocked address" };
      case "invalid_url":
      case "scheme":
      case "credentials":
        return { status: 400, message: "image: invalid url" };
      case "redirects":
        return { status: 400, message: "image: too many redirects" };
      case "http_status":
        return { status: 400, message: "image: upstream request failed" };
      default:
        return { status: 400, message: "image: fetch failed" };
    }
  }
  return { status: 400, message: "image: fetch failed" };
}

function imageResponse(entry: ImgEntry): Response {
  return new Response(entry.bytes as unknown as BodyInit, {
    headers: {
      "content-type": entry.type,
      "x-content-type-options": "nosniff",
      // Top-level open of the endpoint must never execute (SVG etc).
      "content-security-policy": "sandbox",
      // Opaque-origin widget frames need this for canvas / WebGL textures.
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=86400",
    },
  });
}

/* ---------------- routes ---------------- */

export async function handleGenUiRoute(
  path: string,
  req: Request,
  _url: URL,
  server?: { requestIP(req: Request): { address: string } | null },
): Promise<Response | null> {
  // Lint: the daemon validates widget sources here before showing them.
  // Auth is the daemon token (same surface as /api/indirect-code/models).
  if (path === "/api/indirect-code/gen-ui/lint" && req.method === "POST") {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    const host = db.prepare<{ id: string }, [string]>(
      `SELECT h.id FROM remote_hosts h JOIN users u ON u.id = h.user_id
       WHERE h.daemon_token_hash = ? AND u.status = 'active'`,
    ).get(sha256Hex(token));
    if (!host) return err(401, "unauthorized daemon token", req);
    const body = await readJsonBody(req, 2_500_000);
    const id = typeof body?.id === "string" ? body.id : "";
    const source = typeof body?.source === "string" ? body.source : "";
    const test = typeof body?.test === "string" ? body.test : "";
    const state = typeof body?.state === "string" ? body.state : "";
    if (!id.trim()) return err(400, "id is required", req);
    if (!source.trim()) return err(400, "empty widget source", req);
    if (source.length + test.length > 1_500_000) return err(413, "widget too large", req);
    try {
      const res = await runWidgetLint({ id, source, test, state, signal: req.signal });
      return json(res, { req });
    } catch (e) {
      if (e instanceof WidgetLintBusyError) {
        const resp = err(503, e.message, req);
        resp.headers.set("Retry-After", "2");
        return resp;
      }
      // Never surface an opaque 500: the lint is the model's feedback loop,
      // so an internal failure becomes a structured lint error with the real
      // message (the stack lands in the gateway log for us).
      console.error("[gen-ui] lint internal error:", e);
      return json({
        ok: false,
        errors: [{ phase: "compile", message: `internal lint error: ${e instanceof Error ? e.message : String(e)}` }],
        output: "",
        durationMs: 0,
      }, { req });
    }
  }

  if (path === "/api/indirect-code/gen-ui/widgets" && req.method === "POST") {
    await requireAuth(req);
    const body = await readJsonBody(req, 2_500_000);
    const theme: "dark" | "light" = body?.theme === "light" ? "light" : "dark";
    const VALID_ACCENTS = new Set(["neutral", "violet", "blue", "green", "amber", "orange", "coral", "rose"]);
    const accent = typeof body?.accent === "string" && VALID_ACCENTS.has(body.accent) ? body.accent : undefined;
    const jsx = typeof body?.jsx === "string" ? body.jsx : "";
    const stateJSON = typeof body?.stateJSON === "string" ? body.stateJSON.trim() || "{}" : "{}";
    try {
      JSON.parse(stateJSON);
    } catch {
      return err(400, "invalid stateJSON", req);
    }
    if (!jsx.trim()) return err(400, "empty widget", req);
    const total = jsx.length + stateJSON.length;
    if (total > 1_500_000) return err(413, "widget too large", req);
    // The source compiles here, at doc build time: the widget sandbox has no
    // 'unsafe-eval', so it only ever runs plain JS.
    const compiled = compileJsxModule(jsx);
    if (!compiled.ok) return err(400, `invalid jsx: ${compiled.error}`, req);
    // The compiled widget lives as its own module: identical source shares
    // one module entry, and the document stays tiny.
    const moduleBody = buildJsxModuleBody(compiled.code);
    const moduleId = contentId([moduleBody]);
    modules.put(moduleId, moduleBody);
    const moduleUrl = `/api/indirect-code/gen-ui/modules/${moduleId}`;

    const id = contentId(accent ? [theme, accent, moduleId, stateJSON] : [theme, moduleId, stateJSON]);
    const existing = widgets.get(id);
    if (existing) {
      return json({ success: true, id: existing.id, url: `/api/indirect-code/gen-ui/widgets/${existing.id}` }, { req });
    }
    const importMap = buildJsxImportMap({
      react: "/api/indirect-code/gen-ui/lib/react-shim.js",
      libs: Object.fromEntries(
        Object.entries(GEN_UI_LIB_FILES).map(([name, file]) => [
          name,
          `/api/indirect-code/gen-ui/lib/${file}`,
        ]),
      ),
    });
    // The document embeds the deployment origin in its CSP meta tag, so it
    // is rendered on GET (per request origin), never stored baked.
    const entry = widgets.put(id, {
      theme,
      accent,
      moduleUrl,
      importMap,
      stateJSON,
      scriptNonce: makeScriptNonce(),
    });
    return json({ success: true, id: entry.id, url: `/api/indirect-code/gen-ui/widgets/${entry.id}` }, { req });
  }

  const widgetMatch = /^\/api\/indirect-code\/gen-ui\/widgets\/([0-9a-f]{64})$/.exec(path);
  if (widgetMatch && req.method === "GET") {
    const entry = widgets.get(widgetMatch[1]);
    if (!entry) return err(404, "widget not found", req);
    // Header and <meta> CSP are both pinned to THIS request's origin: a
    // widget posted via one host and fetched via another (localhost vs
    // 127.0.0.1, LAN IP, reverse proxy) would otherwise intersect its
    // module loads away (the browser enforces both policies).
    const origin = requestOrigin(req, server);
    return new Response(buildWidgetDocument({ ...entry.body, origin }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The rendered document varies with the request origin, so shared
        // caches must not pin one origin's copy for everyone. Browsers still
        // cache it per URL (the URL host IS the origin).
        "cache-control": "private, max-age=31536000, immutable",
        "vary": "host",
        "content-security-policy": widgetCSP(entry.body.scriptNonce, origin),
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
    if (!LIB_MODULE_FILES.has(file)) return err(404, "unknown lib", req);
    const source = readVendorFile(file);
    if (source == null) return err(404, "lib not vendored (run build)", req);
    return new Response(source, { headers: moduleHeaders(libContentType(file)) });
  }

  if (path === "/api/indirect-code/gen-ui/img" && req.method === "GET") {
    const raw = _url.searchParams.get("u") || "";
    if (!raw || raw.length > 2048) return err(400, "missing url", req);
    const cached = imgCache.get(raw);
    if (cached) return imageResponse(cached);
    let entry: ImgEntry;
    try {
      const existing = inFlightImgs.get(raw);
      if (existing) {
        entry = await existing;
      } else {
        const pending = fetchImage(raw);
        inFlightImgs.set(raw, pending);
        try {
          entry = await pending;
          putImage(raw, entry);
        } finally {
          if (inFlightImgs.get(raw) === pending) inFlightImgs.delete(raw);
        }
      }
    } catch (e) {
      const mapped = mapImageFetchError(e);
      const resp = err(mapped.status, mapped.message, req);
      if (mapped.status === 503) resp.headers.set("Retry-After", "1");
      return resp;
    }
    return imageResponse(entry);
  }

  if (path.startsWith("/api/indirect-code/gen-ui/ai/")) {
    const viaAi = await handleGenUiAiRoute(path, req, _url, server);
    if (viaAi) return viaAi;
  }

  // Anything else under the gen-ui namespace is a 404, not an unhandled
  // route (the namespace is self-contained).
  if (path.startsWith("/api/indirect-code/gen-ui/")) return err(404, "not found", req);

  return null;
}

/** @test-hook Widget/module store sizes (bounded LRUs). */
export function genUiStoreSize(): number {
  return widgets.size();
}

/** @test-hook Image proxy cache size. */
export function genUiImageCacheSize(): number {
  return imgCache.size;
}
