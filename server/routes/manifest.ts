import { existsSync, readFileSync } from "fs";
import path from "path";

import { PUBLIC_URL, IS_PROD } from "../config";
import { baseHeaders, hasControlCharacters, isTrustedProxy } from "../http";

const STATIC_ROOT = path.resolve(process.env.STATIC_DIR || path.join(import.meta.dir, "..", "..", "dist"));
const PUB_DIR = path.resolve(path.join(import.meta.dir, "..", "..", "web", "public"));

type PeerServer = { requestIP(req: Request): { address: string } | null };

function safeForwardedOrigin(protoRaw: string, hostRaw: string): string | null {
  const proto = protoRaw.split(",")[0]!.trim().toLowerCase();
  if (proto !== "http" && proto !== "https") return null;
  const host = hostRaw.split(",")[0]!.trim();
  if (!host || host.length > 255 || hasControlCharacters(host) || /[\s/\\?#@]/.test(host)) return null;
  try {
    const parsed = new URL(`${proto}://${host}/`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    if (!parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Determine the public origin of the incoming request.
 * Honors x-forwarded-proto and x-forwarded-host ONLY when the request comes
 * from a configured trusted proxy (`isTrustedProxy(req, server)`), falling back
 * to the request URL origin or configured PUBLIC_URL.
 */
export function getRequestOrigin(req: Request, url: URL, server?: PeerServer): string {
  if (isTrustedProxy(req, server)) {
    const rawHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host || "";
    const rawProto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "") || "https";
    const forwarded = safeForwardedOrigin(rawProto, rawHost);
    if (forwarded) return forwarded;
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.host) {
    return url.origin;
  }
  return PUBLIC_URL.replace(/\/+$/, "");
}

let cachedTemplate: Record<string, any> | null = null;

function loadTemplate(): Record<string, any> {
  if (IS_PROD && cachedTemplate) return cachedTemplate;

  for (const p of [path.join(STATIC_ROOT, "manifest.webmanifest"), path.join(PUB_DIR, "manifest.webmanifest")]) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw);
        if (IS_PROD) cachedTemplate = parsed;
        return parsed;
      } catch {}
    }
  }

  const fallback: Record<string, any> = {
    name: "Indirect",
    short_name: "Indirect",
    description: "LLM API gateway with a personal dashboard and a Code agent workspace.",
    id: "/",
    start_url: "/#/code",
    scope: "/",
    display: "standalone",
    lang: "en-US",
    theme_color: "#111315",
    background_color: "#111315",
    display_override: ["window-controls-overlay"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  if (IS_PROD) cachedTemplate = fallback;
  return fallback;
}

/**
 * Deliver the PWA web app manifest dynamically tailored to the host origin.
 * Sets explicit absolute URLs for `id`, `scope`, and `start_url` using the request's
 * base domain so browsers (Chrome, Edge, Android WebAPK) associate the PWA directly
 * with the base origin and do not display out-of-scope / domain warning notifications.
 */
export function handleManifestRoute(req: Request, url: URL, server?: PeerServer): Response {
  const origin = getRequestOrigin(req, url, server);
  const base = loadTemplate();

  const startPath = typeof base.start_url === "string" ? base.start_url : "/#/code";
  const scopePath = typeof base.scope === "string" ? base.scope : "/";

  const manifest = {
    ...base,
    id: `${origin}/`,
    scope: `${origin}${scopePath.startsWith("/") ? scopePath : "/" + scopePath}`,
    start_url: `${origin}${startPath.startsWith("/") ? startPath : "/" + startPath}`,
  };

  const headers = baseHeaders(req);
  headers.set("Content-Type", "application/manifest+json; charset=utf-8");
  headers.set("Cache-Control", "no-cache");

  return new Response(JSON.stringify(manifest, null, 2), { status: 200, headers });
}
