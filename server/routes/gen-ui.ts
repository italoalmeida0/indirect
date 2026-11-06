import { err, json, readJsonBody } from "../http";
import { isTrustedProxy } from "../http";
import { db } from "../db";
import { sha256Hex } from "../crypto";
import { runWidgetLint } from "./widget-lint";
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
import { lookup } from "node:dns";

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
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    const proto = (req.headers.get("x-forwarded-proto") || "https").split(",")[0].trim();
    if (host && (proto === "http" || proto === "https")) {
      try { return new URL(`${proto}://${host.split(",")[0]!.trim()}`).origin; } catch {}
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

type ImgEntry = { bytes: Uint8Array; type: string };
const imgCache = new Map<string, ImgEntry>();
let imgCacheBytes = 0;

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

function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * The 8 hextets of an IPv6 literal, or null when it is not one. A trailing
 * dotted quad (IPv4-mapped / IPv4-compatible / NAT64) is folded into the low
 * two groups: the WHATWG URL parser canonicalizes it to exactly that form
 * (`http://[::ffff:127.0.0.1]` -> hostname `[::ffff:7f00:1]`), which the
 * dotted-decimal check would never see.
 */
function parseIPv6Literal(host: string): number[] | null {
  let s = host;
  const tail = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    if (!tail.index) return null; // bare dotted quad: not an IPv6 literal
    const oct = tail[1].split(".").map(Number);
    if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((oct[0] << 8) | oct[1]).toString(16);
    const lo = ((oct[2] << 8) | oct[3]).toString(16);
    s = `${s.slice(0, tail.index)}:${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1) return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
  // "::" compresses at least one all-zero group.
  if (groups.length > 7) return null;
  return [
    ...head.map((g) => parseInt(g, 16)),
    ...new Array<number>(8 - groups.length).fill(0),
    ...rest.map((g) => parseInt(g, 16)),
  ];
}

function ipv4FromHextets(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** True for any address a widget must never reach through the proxy. */
export function isBlockedAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!h) return true;
  if (isIPv4Literal(h)) {
    const oct = h.split(".").map(Number);
    if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = oct;
    return (
      a === 0 || // "this network"
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 192 && b === 0) || // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast + reserved + broadcast
    );
  }
  if (h.includes(":")) {
    const words = parseIPv6Literal(h);
    if (!words) return true; // malformed literal: fail closed
    const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    // Addresses that carry an IPv4 target inside: check the target with the
    // IPv4 policy (loopback, RFC1918, metadata, …).
    const embedded = () => isBlockedAddress(ipv4FromHextets(w6, w7));
    // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 (deprecated).
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) return embedded();
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
      return w6 === 0 && w7 <= 1 ? true : embedded(); // :: / ::1 or the quad
    }
    // NAT64 well-known prefix 64:ff9b::/96.
    if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return embedded();
    // 6to4 2002::/16 carries the IPv4 destination in bits 16–47.
    if (w0 === 0x2002) return isBlockedAddress(ipv4FromHextets(w1, w2));
    // Only global unicast (2000::/3) leaves the box: loopback, unspecified,
    // link-local, site-local, ULA, multicast and every other reserved range
    // stay blocked.
    if ((w0 & 0xe000) !== 0x2000) return true;
    // 2001:db8::/32 is documentation-only (not routable).
    if (w0 === 0x2001 && w1 === 0x0db8) return true;
    return false;
  }
  // Hostname: obvious internal names never leave the box.
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  );
}

function lookupAll(host: string): Promise<{ address: string }[]> {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });
}

/** Validate scheme/host/IP policy for one hop of an image request. */
async function assertImageTarget(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported scheme");
  if (url.username || url.password) throw new Error("credentials in url");
  const host = url.hostname;
  if (isBlockedAddress(host)) throw new Error("blocked host");
  if (!isIPv4Literal(host) && !host.includes(":")) {
    let addrs: { address: string }[];
    try {
      addrs = await lookupAll(host);
    } catch {
      throw new Error("unresolvable host");
    }
    // Note: DNS rebinding TOCTOU is bounded by the fact the fetch follows
    // immediately and the cache key is the URL, not the address.
    if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) throw new Error("blocked address");
  }
  return url;
}

/** Fetch one image URL with every hop validated; returns the bytes. */
async function fetchImage(raw: string): Promise<ImgEntry> {
  let current = raw;
  for (let hop = 0; hop <= IMG_MAX_REDIRECTS; hop++) {
    const url = await assertImageTarget(current);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(IMG_TIMEOUT_MS),
      credentials: "omit",
      headers: { accept: "image/*,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      try {
        res.body?.cancel();
      } catch {}
      if (!loc || hop === IMG_MAX_REDIRECTS) throw new Error("too many redirects");
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    // The upstream content-type is advisory only — the binary signature is
    // the contract (an error page dressed as text/plain with PNG bytes still
    // has to be a real PNG to pass sniffImageMime below).
    const declaredLen = Number(res.headers.get("content-length") || 0);
    if (declaredLen > IMG_MAX_BYTES) {
      try {
        res.body?.cancel();
      } catch {}
      throw new Error("image too large");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > IMG_MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {}
          throw new Error("image too large");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    const mime = sniffImageMime(bytes);
    if (!mime) throw new Error("not an image");
    return { bytes, type: mime };
  }
  throw new Error("too many redirects");
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
      const res = await runWidgetLint({ id, source, test, state });
      return json(res, { req });
    } catch (e) {
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
    const body = await readJsonBody(req, 2_500_000);
    const theme: "dark" | "light" = body?.theme === "light" ? "light" : "dark";
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

    const id = contentId([theme, moduleId, stateJSON]);
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
      entry = await fetchImage(raw);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = /too large/.test(message)
        ? 413
        : /did not answer|not an image/.test(message)
          ? 415
          : /blocked (?:host|address)/.test(message)
            ? 403
            : 400;
      return err(status, `image: ${message}`, req);
    }
    putImage(raw, entry);
    return imageResponse(entry);
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

/** Test hook: image proxy cache size. */
export function genUiImageCacheSize(): number {
  return imgCache.size;
}
