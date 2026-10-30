import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

/**
 * Precompressed static asset cache.
 *
 * The dashboard bundle is ~4.7 MB of JavaScript. Serving it uncompressed
 * dominated first paint on slow links, and the previous static handler never
 * set Content-Encoding even when the client asked for it.
 *
 * Assets are compressed ONCE on first request and kept in an LRU bounded by
 * total bytes, so a restart does not pay for every file and a large dist/
 * cannot exhaust memory. Brotli wins on text (~22% smaller than gzip here);
 * gzip stays as the fallback for clients that do not advertise br.
 *
 * Only compressible types are eligible, and only above a size where the
 * encoding can pay for itself. Ranges are never served compressed, since the
 * byte offsets a client asks for refer to the uncompressed representation.
 */

/** Types whose payload is text and compresses well. */
const COMPRESSIBLE = new Set([
  ".js", ".mjs", ".css", ".html", ".json", ".svg", ".txt", ".map", ".webmanifest", ".wasm", ".xml",
]);

/** Below this, the encoding overhead and extra round of decoding is not worth it. */
const MIN_BYTES = 1024;

/** Total bytes the cache may hold across both encodings. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

export type Encoding = "br" | "gzip";

interface CacheEntry {
  bytes: Uint8Array;
  /** Source file identity: a rebuilt asset with the same path must not be
   *  served from a stale entry. */
  size: number;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

export function resetCompressionCache(): void {
  cache.clear();
  cacheBytes = 0;
}

/** True when the extension is worth compressing at all. */
export function isCompressible(extension: string): boolean {
  return COMPRESSIBLE.has(extension.toLowerCase());
}

/**
 * Pick the best encoding the client accepts. `br` is preferred when offered;
 * an explicit `identity` with a higher q-value wins over both.
 */
export function negotiateEncoding(acceptEncoding: string | null): Encoding | null {
  if (!acceptEncoding) return null;
  const accepted: Array<{ token: string; q: number }> = [];
  for (const part of acceptEncoding.split(",")) {
    const [rawToken, ...params] = part.trim().toLowerCase().split(";");
    const token = rawToken?.trim();
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (match) {
        const parsed = Number(match[1]);
        q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
      }
    }
    accepted.push({ token, q });
  }
  if (accepted.length === 0) return null;
  const qOf = (token: string) => {
    const exact = accepted.find((entry) => entry.token === token);
    if (exact) return exact.q;
    const wildcard = accepted.find((entry) => entry.token === "*");
    return wildcard ? wildcard.q : 0;
  };
  const br = qOf("br");
  const gzip = qOf("gzip");
  const best = Math.max(br, gzip);
  if (best <= 0) return null;
  // identity is acceptable unless the client lists it explicitly: a wildcard
  // must not be read as "prefer identity" (RFC 9110 §12.5.3), or every
  // `Accept-Encoding: *` client would receive uncompressed bytes.
  const explicitIdentity = accepted.find((entry) => entry.token === "identity");
  if (explicitIdentity && explicitIdentity.q > best) return null;
  return br >= gzip ? "br" : "gzip";
}

function compress(data: Uint8Array, encoding: Encoding): Uint8Array {
  // Level 11 is slow (~15s for the big chunk) but this runs once per file in
  // the background of a cold start; level 9 keeps the rest responsive.
  return encoding === "br"
    ? new Uint8Array(brotliCompressSync(new Uint8Array(data), {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: data.length > 512 * 1024 ? 9 : 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      }))
    : new Uint8Array(gzipSync(new Uint8Array(data), { level: 9 }));
}

function remember(key: string, entry: CacheEntry): void {
  cache.set(key, entry);
  cacheBytes += entry.bytes.length;
  // LRU-ish eviction: Map iteration order is insertion order, and hits are
  // re-inserted below, so evicting from the front removes the coldest entry.
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (evicted) cacheBytes -= evicted.bytes.length;
  }
}

/**
 * Compressed body for a file, or null when compression does not apply.
 * `filePath` must already be resolved and confined by the caller.
 */
export function compressedAsset(filePath: string, encoding: Encoding): Uint8Array | null {
  if (!isCompressible(path.extname(filePath))) return null;
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size < MIN_BYTES) return null;
  const key = `${encoding}:${filePath}`;
  const hit = cache.get(key);
  if (hit && hit.size === stats.size && hit.mtimeMs === stats.mtimeMs) {
    // Refresh recency for eviction.
    cache.delete(key);
    cache.set(key, hit);
    return hit.bytes;
  }
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(readFileSync(filePath));
  } catch {
    return null;
  }
  const bytes = compress(raw, encoding);
  // Never serve a "compressed" body that is not actually smaller.
  if (bytes.length >= raw.length) return null;
  remember(key, { bytes, size: stats.size, mtimeMs: stats.mtimeMs });
  return bytes;
}

/** Cache accounting for the readiness/metrics endpoint. */
export function compressionCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cacheBytes };
}

/** Exposed for tests that build a file without touching the real dist/. */
export const COMPRESSION_LIMITS = { MIN_BYTES, MAX_CACHE_BYTES };
