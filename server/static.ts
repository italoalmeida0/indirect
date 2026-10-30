import { existsSync, statSync } from "fs";
import path from "path";

import { compressedAsset, negotiateEncoding } from "./compression";
import { baseHeaders } from "./http";

/**
 * Static file serving for the built dashboard (dist/). Hardened against path
 * traversal: the URL path is percent-decoded, normalized, and must stay inside
 * the static root; dotfiles and directories are never served directly.
 */

const STATIC_ROOT = path.resolve(process.env.STATIC_DIR || path.join(import.meta.dir, "..", "dist"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

const IMMUTABLE_EXT = new Set([".js", ".css", ".woff", ".woff2", ".png", ".jpg", ".webp", ".svg", ".ico"]);

/** Resolve a URL path to a file inside STATIC_ROOT, or null when unsafe/missing. */
export function resolveStaticFile(urlPath: string): { filePath: string; isHtml: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  // Strip leading slashes BEFORE normalizing so the path is always relative;
  // then it must remain confined to the static root.
  const stripped = decoded.replace(/^\/+/, "");
  const normalized = path.normalize(stripped);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const fullPath = path.join(STATIC_ROOT, normalized);
  if (!fullPath.startsWith(STATIC_ROOT + path.sep) && fullPath !== STATIC_ROOT) return null;

  const segments = normalized.split(path.sep);
  if (segments.some((s) => s.startsWith("."))) return null; // no dotfiles
  // Source maps are build artifacts, never dashboard assets — they would
  // publish the entire frontend source. Refuse to serve them even if they
  // end up in the static root.
  if (normalized.endsWith(".map")) return null;

  let finalPath = fullPath;
  if (!existsSync(finalPath) || statSync(finalPath).isDirectory()) {
    // SPA fallback: extension-less GET paths render the dashboard shell (never for missing /r/ release binaries).
    if (path.extname(normalized) === "" && !normalized.startsWith("r" + path.sep) && normalized !== "r") {
      const indexPath = path.join(STATIC_ROOT, "index.html");
      if (!existsSync(indexPath)) return null;
      finalPath = indexPath;
    } else {
      return null;
    }
  }

  return { filePath: finalPath, isHtml: finalPath.endsWith(".html") };
}

/** ETag over (size, mtime): the dashboard never rewrites an asset in place
 *  without touching it, and this needs no extra read of the file. */
function assetEtag(stats: { size: number; mtimeMs: number }): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

export function serveStatic(req: Request, urlPath: string): Response | null {
  if (!existsSync(STATIC_ROOT)) return null;
  const resolved = resolveStaticFile(urlPath === "/" ? "/index.html" : urlPath);
  if (!resolved) return null;

  const file = Bun.file(resolved.filePath);
  if (file.size === 0 && !resolved.isHtml) return null;

  let stats: { size: number; mtimeMs: number } | null = null;
  try {
    const raw = statSync(resolved.filePath);
    stats = { size: raw.size, mtimeMs: raw.mtimeMs };
  } catch {
    stats = null;
  }

  const headers = baseHeaders(req, resolved.isHtml);
  headers.set("Content-Type", MIME[path.extname(resolved.filePath).toLowerCase()] ?? "application/octet-stream");
  // Hashed build artifacts can be cached forever; HTML always revalidates.
  // The push Service Worker must never stick in cache: a stale SW keeps
  // rendering old notification shapes after deploys.
  const basename = path.basename(resolved.filePath);
  const isPushSw = basename === "push-sw.js";
  const isReleaseAsset = resolved.filePath.includes(path.sep + "r" + path.sep);

  const immutable = !resolved.isHtml && !isPushSw && !isReleaseAsset && IMMUTABLE_EXT.has(path.extname(resolved.filePath));
  headers.set(
    "Cache-Control",
    resolved.isHtml || isPushSw
      ? "no-cache"
      : isReleaseAsset
        ? "public, max-age=60, must-revalidate"
        : immutable
            ? "public, max-age=31536000, immutable"
            : "public, max-age=300",
  );
  // Precompressed variants exist for these bytes, so a shared cache must key
  // on the encoding.
  headers.set("Vary", "Accept-Encoding");
  if (stats) headers.set("ETag", assetEtag(stats));

  // Conditional request: a matching validator skips the body entirely. Only
  // for the shared-cacheable assets — HTML must always revalidate its content.
  if (!resolved.isHtml && stats) {
    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === assetEtag(stats!))) {
      return new Response(null, { status: 304, headers });
    }
  }

  // Range requests refer to the UNCOMPRESSED byte offsets; never compress them.
  if (resolved.isHtml || isPushSw || !req.headers.get("range")) {
    const encoding = negotiateEncoding(req.headers.get("accept-encoding"));
    if (encoding) {
      const body = compressedAsset(resolved.filePath, encoding);
      if (body) {
        headers.set("Content-Encoding", encoding);
        headers.set("Content-Length", String(body.length));
        // Bun otherwise applies its own encoding on top of ours.
        return new Response(body as unknown as BodyInit, { status: 200, headers });
      }
    }
  }

  return new Response(file, { status: 200, headers });
}
