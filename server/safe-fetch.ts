import { lookup } from "node:dns";

/**
 * Shared SSRF-safe external HTTP(S) fetch helper.
 *
 * Every hop (initial URL and each manual redirect) is validated against:
 *  - allowed scheme (`http:` / `https:` by default) and absence of credentials;
 *  - blocked IPv4/IPv6 ranges (loopback, RFC1918, CGNAT, link-local / cloud
 *    metadata, ULA, unspecified, multicast, documentation, embedded IPv4
 *    tunnels such as IPv4-mapped `::ffff:...`, IPv4-compatible, NAT64, 6to4);
 *  - blocked local hostname suffixes (`localhost`, `.local`, `.internal`, ...);
 *  - DNS resolution (`dns.lookup(..., { all: true })`), rejecting if empty or
 *    if any returned address is blocked.
 *
 * Response bodies are streamed chunk-by-chunk with an upfront Content-Length
 * guard and immediate abort once `maxBytes` is exceeded — never buffering an
 * unbounded upstream response in memory.
 */

export type SafeFetchErrorCode =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "blocked"
  | "dns"
  | "redirects"
  | "too_large"
  | "http_status"
  | "timeout"
  | "aborted"
  | "network";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  readonly status?: number;

  constructor(message: string, code: SafeFetchErrorCode, status?: number) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
    this.status = status;
  }
}

export function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Parse an IPv6 literal into its 8 16-bit hextets, or null if invalid.
 * Trailing dotted-quad IPv4 suffixes (e.g. `::ffff:127.0.0.1`) are folded into
 * the low two hextets so canonical WHATWG URL forms (`[::ffff:7f00:1]`) and
 * raw DNS outputs go through the exact same policy checks.
 */
function parseIPv6Literal(host: string): number[] | null {
  let s = host;
  const tail = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    if (!tail.index) return null; // bare dotted quad: not an IPv6 literal
    const oct = tail[1]!.split(".").map(Number);
    if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((oct[0]! << 8) | oct[1]!).toString(16);
    const lo = ((oct[2]! << 8) | oct[3]!).toString(16);
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

/**
 * True when `ip` is a blocked (non-public / internal / special-use) or
 * malformed IPv4/IPv6 literal. Fails closed on unparseable input.
 */
export function isBlockedIp(ip: string): boolean {
  const h = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (!h) return true;
  if (isIPv4Literal(h)) {
    const oct = h.split(".").map(Number);
    if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = oct as [number, number, number, number];
    return (
      a === 0 || // "this network" (0.0.0.0/8)
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT (100.64.0.0/10)
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 192 && b === 0) || // IETF protocol assignments / TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) || // benchmarking (198.18.0.0/15)
      a >= 224 // multicast + reserved + broadcast
    );
  }
  if (h.includes(":")) {
    const words = parseIPv6Literal(h);
    if (!words) return true; // malformed literal: fail closed
    const [w0, w1, w2, w3, w4, w5, w6, w7] = words as [
      number, number, number, number, number, number, number, number,
    ];
    const embedded = () => isBlockedIp(ipv4FromHextets(w6, w7));
    // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 (deprecated).
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) return embedded();
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
      return w6 === 0 && w7 <= 1 ? true : embedded(); // :: / ::1 or embedded IPv4
    }
    // NAT64 well-known prefix 64:ff9b::/96.
    if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return embedded();
    // 6to4 2002::/16 carries the IPv4 destination in bits 16-47.
    if (w0 === 0x2002) return isBlockedIp(ipv4FromHextets(w1, w2));
    // Only global unicast (2000::/3) is permitted; loopback, unspecified,
    // link-local (fe80::/10), site-local, ULA (fc00::/7), multicast (ff00::/8)
    // and every other reserved range stay blocked.
    if ((w0 & 0xe000) !== 0x2000) return true;
    // 2001:db8::/32 is documentation-only (not routable).
    if (w0 === 0x2001 && w1 === 0x0db8) return true;
    return false;
  }
  return true;
}

/**
 * True for any IP literal or hostname that outbound server-side fetches must
 * never reach (blocked IPs plus local/internal hostname suffixes).
 */
export function isBlockedAddress(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!.replace(/\.+$/, "");
  if (!h) return true;
  if (isIPv4Literal(h) || h.includes(":")) return isBlockedIp(h);
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  );
}

/** Resolve all A and AAAA records for `host` via the OS resolver. */
export function lookupAllIps(host: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs.map((a) => a.address));
    });
  });
}

export interface ValidateExternalUrlOptions {
  allowedProtocols?: readonly string[];
  lookup?: (host: string) => Promise<string[]>;
}

/**
 * Validate scheme, absence of embedded credentials, hostname/IP policy, and
 * DNS resolution for a single external URL hop.
 */
export async function validateExternalUrl(
  raw: string,
  opts: ValidateExternalUrlOptions = {},
): Promise<{ url: URL; ips: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid url", "invalid_url");
  }
  const allowedProtocols = opts.allowedProtocols ?? ["http:", "https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new SafeFetchError("unsupported scheme", "scheme");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("credentials in url", "credentials");
  }
  const host = url.hostname;
  const bare = host.replace(/^\[|\]$/g, "").split("%")[0]!;
  const allowLoopbackTest =
    (process.env.NODE_ENV || "production") === "test" &&
    process.env.SAFE_FETCH_ALLOW_LOOPBACK === "true" &&
    (bare === "127.0.0.1" || bare === "::1" || bare.toLowerCase() === "localhost");
  if (allowLoopbackTest) {
    return { url, ips: [bare === "localhost" ? "127.0.0.1" : bare] };
  }
  if (isBlockedAddress(host)) {
    throw new SafeFetchError("blocked host", "blocked");
  }
  if (isIPv4Literal(bare) || bare.includes(":")) {
    if (isBlockedIp(bare)) throw new SafeFetchError("blocked address", "blocked");
    return { url, ips: [bare] };
  }
  const lookupFn = opts.lookup ?? lookupAllIps;
  let ips: string[];
  try {
    ips = await lookupFn(bare.replace(/\.+$/, ""));
  } catch {
    throw new SafeFetchError("unresolvable host", "dns");
  }
  if (!ips.length || ips.some((ip) => isBlockedIp(ip))) {
    throw new SafeFetchError("blocked address", "blocked");
  }
  return { url, ips };
}

export interface SafeExternalFetchOptions extends ValidateExternalUrlOptions {
  /** Maximum response body bytes to read before aborting (default 5 MiB). */
  maxBytes?: number;
  /** End-to-end request + redirect + body timeout in ms (default 15s). */
  timeoutMs?: number;
  /** Maximum manual redirect hops (default 3). */
  maxRedirects?: number;
  /** Optional caller abort signal propagated to fetch and stream reads. */
  signal?: AbortSignal;
  /** Optional request headers (credentials are always omitted). */
  headers?: HeadersInit;
  /** Optional fetch implementation (defaults to `globalThis.fetch`). */
  fetchImpl?: typeof fetch;
}

export interface SafeExternalFetchResult {
  bytes: Uint8Array;
  contentType: string;
  status: number;
  url: string;
  headers: Headers;
}

function abortReasonToError(reason: unknown, fallbackCode: "timeout" | "aborted"): SafeFetchError {
  if (reason instanceof SafeFetchError) return reason;
  return new SafeFetchError(
    fallbackCode === "timeout" ? "request timed out" : "request aborted",
    fallbackCode,
  );
}

/**
 * Fetch an external URL safely: validates every hop (including manual
 * redirects) against SSRF IP/DNS rules, honors caller abort + timeout, and
 * streams the response body with a strict byte ceiling.
 */
export async function safeExternalFetch(
  rawUrl: string,
  opts: SafeExternalFetchOptions = {},
): Promise<SafeExternalFetchResult> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;

  if (opts.signal?.aborted) {
    throw new SafeFetchError("request aborted", "aborted");
  }

  const ctrl = new AbortController();
  const onCallerAbort = () => {
    ctrl.abort(new SafeFetchError("request aborted", "aborted"));
  };
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          ctrl.abort(new SafeFetchError("request timed out", "timeout"));
        }, timeoutMs)
      : null;

  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (ctrl.signal.aborted) {
        throw abortReasonToError(ctrl.signal.reason, opts.signal?.aborted ? "aborted" : "timeout");
      }

      const { url } = await validateExternalUrl(current, {
        allowedProtocols: opts.allowedProtocols,
        lookup: opts.lookup,
      });

      if (ctrl.signal.aborted) {
        throw abortReasonToError(ctrl.signal.reason, opts.signal?.aborted ? "aborted" : "timeout");
      }

      let res: Response;
      try {
        res = await fetchFn(url.toString(), {
          redirect: "manual",
          signal: ctrl.signal,
          credentials: "omit",
          headers: opts.headers,
        });
      } catch {
        if (ctrl.signal.aborted) {
          throw abortReasonToError(ctrl.signal.reason, opts.signal?.aborted ? "aborted" : "timeout");
        }
        throw new SafeFetchError("network request failed", "network");
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try {
          await res.body?.cancel();
        } catch {}
        if (!loc || hop === maxRedirects) {
          throw new SafeFetchError("too many redirects", "redirects");
        }
        try {
          current = new URL(loc, url).toString();
        } catch {
          throw new SafeFetchError("invalid redirect url", "invalid_url");
        }
        continue;
      }

      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {}
        throw new SafeFetchError(`upstream ${res.status}`, "http_status", res.status);
      }

      const clHeader = res.headers.get("content-length");
      if (clHeader !== null && clHeader.trim() !== "") {
        const declaredLen = Number(clHeader);
        if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
          try {
            await res.body?.cancel();
          } catch {}
          ctrl.abort(new SafeFetchError("response too large", "too_large"));
          throw new SafeFetchError("response too large", "too_large");
        }
      }

      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        let finished = false;
        try {
          for (;;) {
            if (ctrl.signal.aborted) {
              throw abortReasonToError(ctrl.signal.reason, opts.signal?.aborted ? "aborted" : "timeout");
            }
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              break;
            }
            if (!value || value.byteLength === 0) continue;
            size += value.byteLength;
            if (size > maxBytes) {
              const tooLarge = new SafeFetchError("response too large", "too_large");
              ctrl.abort(tooLarge);
              throw tooLarge;
            }
            chunks.push(value);
          }
        } catch (err) {
          if (err instanceof SafeFetchError) throw err;
          if (ctrl.signal.aborted) {
            throw abortReasonToError(ctrl.signal.reason, opts.signal?.aborted ? "aborted" : "timeout");
          }
          throw new SafeFetchError("network stream failed", "network");
        } finally {
          if (!finished) {
            try {
              await reader.cancel();
            } catch {}
          }
          try {
            reader.releaseLock();
          } catch {}
        }
      }

      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return {
        bytes,
        contentType: res.headers.get("content-type") || "",
        status: res.status,
        url: url.toString(),
        headers: res.headers,
      };
    }
    throw new SafeFetchError("too many redirects", "redirects");
  } finally {
    if (timer !== null) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}
