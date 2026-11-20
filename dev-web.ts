/**
 * Frontend dev server.
 *  - Serves the SPA through Bun's HTML imports (with the tailwind/solid plugins
 *    from bunfig.toml) with full reload on change.
 *  - Proxies /api, /v1, /openai/v1 and /anthropic/v1 to the backend (default
 *    http://localhost:3000) so the dashboard talks to the real gateway during
 *    development.
 *
 * Usage: bun ./dev-web.ts 5700
 */
import { serve } from "bun";
import { existsSync } from "fs";
import path from "path";

import solidPlugin from "./plugins/solid-plugin";
import app from "./web/index.html";

const port = Number(Bun.argv[2] || 5700);
const API = process.env.GATEWAY_API || "http://localhost:3000";

/** Dev-only static files stay confined to the project root (no traversal,
 *  no dotfiles) — this server often listens on 0.0.0.0 on shared networks.
 *  Only frontend-ish directories are servable: server/, data/ (DB + .secret),
 *  scripts and friends must never be readable through the dev port. */
const DEV_ROOT = path.resolve(import.meta.dir);
const SERVABLE_DIRS = new Set(["web", "plugins", "dist"]);

/** Standalone worker/worklet entrypoints compiled on demand in dev (mirroring build.ts). */
const ortWasmOnlyPlugin: import("bun").BunPlugin = {
  name: "ort-wasm-only",
  setup(build) {
    const wasmEntry = path.join(DEV_ROOT, "node_modules", "onnxruntime-web", "dist", "ort.wasm.bundle.min.mjs");
    build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({ path: wasmEntry }));
  },
};

const DEV_WORKERS: Record<string, { entry: string; plugins?: import("bun").BunPlugin[] }> = {
  "/workers/history-worker.js": {
    entry: path.join(DEV_ROOT, "web", "src", "indirect-code", "transcript", "history-worker.ts"),
    plugins: [solidPlugin],
  },
  "/workers/voice-worker.js": {
    entry: path.join(DEV_ROOT, "web", "src", "indirect-code", "voice", "voice-worker.ts"),
    plugins: [ortWasmOnlyPlugin],
  },
  "/workers/voice-worklet.js": {
    entry: path.join(DEV_ROOT, "web", "src", "indirect-code", "voice", "voice-worklet.ts"),
  },
};

/** Strict allowlist for self-hosted ONNX Runtime Web WASM assets in dev. */
const DEV_ORT_ASSETS: Record<string, { file: string; contentType: string }> = {
  "/vendor/ort/ort-wasm-simd-threaded.wasm": {
    file: path.join(DEV_ROOT, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm"),
    contentType: "application/wasm",
  },
  "/vendor/ort/ort-wasm-simd-threaded.mjs": {
    file: path.join(DEV_ROOT, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.mjs"),
    contentType: "text/javascript; charset=utf-8",
  },
};
function resolveDevFile(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const normalized = path.normalize(decoded.replace(/^\/+/, ""));
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const segments = normalized.split(path.sep);
  if (segments.some((s) => s.startsWith("."))) return null;
  if (!SERVABLE_DIRS.has(segments[0]!)) {
    const pubFile = path.join(DEV_ROOT, "web", "public", normalized);
    if (pubFile.startsWith(path.join(DEV_ROOT, "web", "public") + path.sep)) {
      try {
        if (existsSync(pubFile)) return pubFile;
      } catch {}
    }
    return null;
  }
  const full = path.join(DEV_ROOT, normalized);
  if (!full.startsWith(DEV_ROOT + path.sep)) return null;
  return full;
}

const server = serve({
  routes: { "/": app },

  async fetch(req) {
    const url = new URL(req.url);

    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/openai/v1/") ||
      url.pathname.startsWith("/anthropic/v1/")
    ) {
      const upstream = new URL(url.pathname + url.search, API);
      const headers = new Headers(req.headers);
      headers.delete("host");
      try {
        return await fetch(upstream, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          // @ts-expect-error: Bun streaming upload
          duplex: "half",
        });
      } catch {
        return Response.json(
          { error: `dev proxy: backend unreachable at ${API} (is \`bun run dev\` running?)` },
          { status: 502 },
        );
      }
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const workerSpec = DEV_WORKERS[url.pathname];
      if (workerSpec) {
        if (!existsSync(workerSpec.entry)) return new Response("Not found", { status: 404 });
        try {
          const built = await Bun.build({
            entrypoints: [workerSpec.entry],
            target: "browser",
            minify: false,
            sourcemap: "none",
            ...(workerSpec.plugins ? { plugins: workerSpec.plugins } : {}),
          });
          if (!built.success || !built.outputs[0]) {
            console.error(`[dev-web] failed to bundle ${url.pathname}:`, built.logs);
            return new Response("Worker bundle failed", { status: 500 });
          }
          const code = await built.outputs[0].text();
          return new Response(req.method === "HEAD" ? null : code, {
            status: 200,
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        } catch (err) {
          console.error(`[dev-web] error bundling ${url.pathname}:`, err);
          return new Response("Internal server error", { status: 500 });
        }
      }

      const ortAsset = DEV_ORT_ASSETS[url.pathname];
      if (ortAsset) {
        const file = Bun.file(ortAsset.file);
        if (!(await file.exists())) return new Response("Not found", { status: 404 });
        return new Response(req.method === "HEAD" ? null : file, {
          status: 200,
          headers: {
            "Content-Type": ortAsset.contentType,
            "Cache-Control": "no-cache",
          },
        });
      }
    }

    // Push Service Worker lives at web/push-sw.js but must be served from
    // the site root (scope covers the whole dashboard), like build.ts does.
    const swPath = url.pathname === "/push-sw.js" ? "/web/push-sw.js" : url.pathname;
    const resolved = resolveDevFile(swPath);
    if (!resolved) return new Response("Not found", { status: 404 });
    try {
      const file = Bun.file(resolved);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file);
    } catch {
      return new Response("Internal server error", { status: 500 });
    }
  },

  development: { hmr: false, console: true },
  port,
});

console.log(`[dev-web] ${server.url}  (proxying /api,/v1,/openai/v1,/anthropic/v1 -> ${API})`);
