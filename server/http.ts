import { BlockList, isIP } from "node:net";
import { ALLOWED_ORIGINS, TRUST_PROXY, TRUSTED_PROXY_CIDRS } from "./config";
import { currentFinancialPolicyHeader } from "./request-context";

/**
 * HTTP plumbing shared by every route: security headers, CORS, body guards,
 * client-IP resolution, and the `{success, ...}` API envelope.
 */

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function corsOriginFor(req?: Request): string | null {
  if (!req || ALLOWED_ORIGINS.length === 0) return null;
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

export function baseHeaders(req?: Request, isHtml = false): Headers {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isHtml) {
    // Google GSI button needs accounts.google.com scripts/frames; everything
    // else is self-hosted. No 'unsafe-inline' — the inline scripts we ship in
    // index.html (touch-device flag + theme init, both before first paint) are
    // allowlisted by their sha256 hashes. If index.html's inline scripts
    // change, recompute: sha256 base64 of each exact textContent.
    h.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client 'sha256-irJfLmBsOF5THDLD+AWwo/3Pyl3T7p4Nke5b1WhBAu4=' 'sha256-udweQu0/QO+buA7Ub3sQ33gElcVLpH0v6ZhZe9H8LB8='",
        // 'self' hosts sandboxed Generative UI widget documents
        // (/api/indirect-code/gen-ui/widgets/:id, CSP-sandboxed themselves).
        "frame-src 'self' https://accounts.google.com/gsi/",
        "connect-src 'self' https://accounts.google.com/gsi/ https://api.iconify.design",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  }
  const cors = corsOriginFor(req);
  if (cors) {
    h.set("Access-Control-Allow-Origin", cors);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
    h.set("Access-Control-Expose-Headers", "Retry-After, X-Request-Id, X-Gateway-Usage, X-Gateway-Queue, X-Financial-Policy");
    h.set("Access-Control-Max-Age", "600");
  }
  return h;
}

export function json(data: unknown, init: { status?: number; req?: Request } = {}): Response {
  const h = baseHeaders(init.req);
  h.set("Content-Type", "application/json; charset=utf-8");
  const policyHeader = currentFinancialPolicyHeader();
  if (policyHeader) h.set("X-Financial-Policy", policyHeader);
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers: h });
}

export function ok(data: Record<string, unknown> = {}, req?: Request): Response {
  return json({ success: true, ...data }, { req });
}

export function err(status: number, message: string, req?: Request, code?: string): Response {
  return json({ success: false, error: message, ...(code ? { code } : {}) }, { status, req });
}

/**
 * Headers every 429 must carry, shared by the dashboard envelope and the
 * protocol envelopes in server/proxy.
 *
 * Retry-After is the contract clients back off on (integer seconds >= 1).
 * X-Gateway-Queue reports the admission queue depth so a rejection says
 * whether capacity is exhausted or merely busy; it is exposed for CORS in
 * baseHeaders alongside Retry-After.
 */
export function applyRateLimitHeaders(response: Response, retryAfter: number, queueDepth?: number): Response {
  response.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfter))));
  if (queueDepth !== undefined) response.headers.set("X-Gateway-Queue", String(queueDepth));
  return response;
}

export function rateLimitError(message: string, retryAfter: number, req?: Request, queueDepth?: number): Response {
  return applyRateLimitHeaders(err(429, message, req), retryAfter, queueDepth);
}

type PeerServer = { requestIP(req: Request): { address: string } | null };
const trustedProxies = new BlockList();
for (const entry of TRUSTED_PROXY_CIDRS) {
  const pieces = entry.split("/");
  const address = pieces[0]!;
  const version = isIP(address);
  const prefix = pieces.length === 1 ? (version === 4 ? 32 : 128) : /^\d+$/.test(pieces[1]!) ? Number(pieces[1]) : NaN;
  if (!version || pieces.length > 2 || !Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
    throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${entry}`);
  }
  trustedProxies.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");
}
const requestIps = new WeakMap<Request, string>();

function canonicalIp(value: string): string | null {
  const address = value.trim();
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  // URL canonicalization collapses equivalent IPv6 spellings into one bucket.
  let normalized: string;
  try { normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1); }
  catch { return null; }
  const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function trustedAddress(address: string): boolean {
  const normalized = canonicalIp(address);
  return !!normalized && trustedProxies.check(normalized, isIP(normalized) === 4 ? "ipv4" : "ipv6");
}

/** A forwarded header is trusted only from an explicitly configured peer. */
export function isTrustedProxy(req: Request, server?: PeerServer): boolean {
  const peer = server?.requestIP(req)?.address;
  return TRUST_PROXY && !!peer && trustedAddress(peer);
}

export function clientIp(req: Request, server?: PeerServer): string {
  if (!server) return requestIps.get(req) ?? "unknown";
  const peer = canonicalIp(server.requestIP(req)?.address ?? "") ?? "unknown";
  let result = peer;
  if (TRUST_PROXY && trustedAddress(peer)) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",");
      const chain = parts.length <= 32 ? parts.map(canonicalIp) : [];
      if (chain.length && chain.every((address) => address !== null)) {
        // Ignore addresses supplied to an untrusted hop to the left.
        for (let i = chain.length - 1; i >= 0 && trustedAddress(result); i--) result = chain[i]!;
      }
    } else {
      const forwarded = req.headers.get("cf-connecting-ip") || req.headers.get("true-client-ip") || req.headers.get("x-real-ip");
      if (forwarded) result = canonicalIp(forwarded) ?? peer;
    }
  }
  requestIps.set(req, result);
  return result;
}

/**
 * Parse a JSON object body with a hard byte cap. Content-Length is checked
 * first (cheap) and the actual body second (chunked transfers lie).
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) throw new ApiError(413, "payload too large");

  const ctype = req.headers.get("content-type") || "";
  if (!ctype.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "content-type must be application/json");
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new ApiError(413, "payload too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/** Small validation helpers — deliberately boring, no schema lib. */
export const v = {
  str(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string | null {
    const val = body[key];
    if (val === undefined || val === null || val === "") {
      if (opts.optional) return null;
      throw new ApiError(400, `${key} is required`);
    }
    if (typeof val !== "string") throw new ApiError(400, `${key} must be a string`);
    const min = opts.min ?? 0;
    const max = opts.max ?? 512;
    if (val.length < min) throw new ApiError(400, `${key} is too short`);
    if (val.length > max) throw new ApiError(400, `${key} is too long`);
    return val;
  },

  int(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number | null {
    const val = body[key];
    if (val === undefined || val === null || val === "") {
      if (opts.optional) return null;
      throw new ApiError(400, `${key} is required`);
    }
    const n = typeof val === "string" && /^\d+$/.test(val) ? Number(val) : val;
    if (typeof n !== "number" || !Number.isInteger(n)) throw new ApiError(400, `${key} must be an integer`);
    if (opts.min !== undefined && n < opts.min) throw new ApiError(400, `${key} is too small`);
    if (opts.max !== undefined && n > opts.max) throw new ApiError(400, `${key} is too large`);
    return n;
  },

  email(body: Record<string, unknown>, key: string): string {
    const val = v.str(body, key, { min: 3, max: 254 })!;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val)) throw new ApiError(400, `${key} must be a valid email`);
    return val.toLowerCase();
  },
};
