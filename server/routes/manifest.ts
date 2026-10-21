import { existsSync, readFileSync } from "fs";
import path from "path";

import { PUBLIC_URL, IS_PROD } from "../config";
import { baseHeaders } from "../http";

const STATIC_ROOT = path.resolve(process.env.STATIC_DIR || path.join(import.meta.dir, "..", "..", "dist"));
const PUB_DIR = path.resolve(path.join(import.meta.dir, "..", "..", "web", "public"));

/**
 * Determine the public origin of the incoming request.
 * Honors x-forwarded-proto and x-forwarded-host (when behind Caddy/Cloudflare/reverse proxy),
 * falling back to the URL or configured PUBLIC_URL.
 */
export function getRequestOrigin(req: Request, url: URL): string {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host || "").split(",")[0].trim();
  const proto = (req.headers.get("x-forwarded-proto") || (url.protocol.replace(":", "") || "https")).split(",")[0].trim();
  if (host) return `${proto}://${host}`.replace(/\/+$/, "");
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
export function handleManifestRoute(req: Request, url: URL): Response {
  const origin = getRequestOrigin(req, url);
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
