/**
 * Real Chromium browser regression gate for the Indirect Code Voice System.
 *
 * Phase 1 — Focused Voice Flow Gate (isolated fixture with REAL production
 *   `baseHeaders(req, true)` CSP + `Permissions-Policy`, real compiled Tailwind
 *   CSS, and real `dist/workers/voice-worklet.js`).
 * Phase 2 — Full Production `dist/` SPA Responsive & Multi-Theme Gate across
 *   5 viewports (`360x780`, `390x844`, `768x1024` touch & desktop, `1440x900`)
 *   × 3 themes (`dark`, `light`, `high-contrast`).
 *
 * Usage:
 *   bun run build:web
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-voice-ui.ts
 */
import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
import solidPlugin from "../plugins/solid-plugin";

process.env.NODE_ENV = "production";
process.env.GATEWAY_SECRET = "voice-browser-test-secret-only-00000000";
process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD = "1";

const { baseHeaders } = await import("../server/http");
const { serveStatic } = await import("../server/static");

async function loadPlaywright(): Promise<{ chromium: any }> {
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push("playwright", "playwright-core");

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    candidates.push(path.join(localAppData, "GG Coder", "sidecar", "node_modules", "playwright", "index.mjs"));
    const npxRoot = path.join(localAppData, "npm-cache", "_npx");
    const npxDirs = await fs.readdir(npxRoot).catch(() => [] as string[]);
    for (const d of npxDirs) {
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright", "index.mjs"));
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright-core", "index.mjs"));
    }
  } else {
    const home = process.env.HOME || homedir();
    candidates.push("/tmp/pw/node_modules/playwright-core/index.mjs");
    const npxRoot = path.join(home, ".npm", "_npx");
    const npxDirs = await fs.readdir(npxRoot).catch(() => [] as string[]);
    for (const d of npxDirs) {
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright", "index.mjs"));
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright-core", "index.mjs"));
    }
  }

  for (const spec of candidates) {
    try {
      const target = path.isAbsolute(spec) ? (existsSync(spec) ? pathToFileURL(spec).href : "") : spec;
      if (!target) continue;
      const mod = await import(target);
      if (mod?.chromium) return mod;
    } catch {}
  }
  console.error("Playwright module not found: set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs");
  process.exit(2);
}

async function resolveChrome(): Promise<string | undefined> {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (process.platform === "win32") {
    const winCache = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
    const winDirs = (await fs.readdir(winCache).catch(() => [] as string[]))
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse();
    for (const d of winDirs) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const cand = path.join(winCache, d, sub, "chrome.exe");
        if (await fs.stat(cand).catch(() => null)) return cand;
      }
    }
    const winSystemBrowsers = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const cand of winSystemBrowsers) {
      if (await fs.stat(cand).catch(() => null)) return cand;
    }
  }
  return undefined;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WS_ROOT = path.join(SCRIPT_DIR, "..");
const DIST_DIR = path.join(WS_ROOT, "dist");

const indexHtmlPath = path.join(DIST_DIR, "index.html");
if (!existsSync(indexHtmlPath)) {
  throw new Error("dist/index.html missing — run `bun run build:web` first");
}
const indexHtml = await fs.readFile(indexHtmlPath, "utf8");
const linkedCss = Array.from(indexHtml.matchAll(/<link\b[^>]*>/gi))
  .map((m) => m[0])
  .filter((tag) => /\brel=["']stylesheet["']/i.test(tag))
  .map((tag) => tag.match(/\bhref=["']\/?(assets\/[^"']+\.css)["']/i)?.[1])
  .find((href): href is string => Boolean(href && existsSync(path.join(DIST_DIR, href))));
const cssCandidates = Array.from(new Bun.Glob("assets/*.css").scanSync(DIST_DIR))
  .map((p) => p.replaceAll("\\", "/"))
  .sort();
const cssName =
  linkedCss ??
  cssCandidates.find((p) => p.startsWith("assets/boot-")) ??
  cssCandidates[0];
if (!cssName) {
  throw new Error("dist/assets/*.css missing — run `bun run build:web` first");
}
if (!existsSync(path.join(DIST_DIR, "workers", "voice-worklet.js"))) {
  throw new Error("dist/workers/voice-worklet.js missing — run `bun run build:web` first");
}

const fixtureBundle = await Bun.build({
  entrypoints: [path.join(WS_ROOT, "test", "fixtures", "indirect-voice-ui.tsx")],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!fixtureBundle.success) {
  throw new Error(`Failed to bundle voice fixture:\n${fixtureBundle.logs.join("\n")}`);
}

/**
 * Browser-side deterministic mock driver injected via `context.addInitScript`.
 * Mocks `getUserMedia`, `AudioContext` / `AudioWorkletNode` / `AnalyserNode`,
 * and ONLY `voice-worker.js` `Worker` instances (leaving `history-worker.js` real).
 */
function installVoiceBrowserMocks(opts: { autoReady: boolean; autoTranscript?: string }) {
  const OrigWorker = window.Worker;
  const OrigAudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  const state: {
    micMode: "ok" | "NotAllowedError" | "NotFoundError";
    autoReady: boolean;
    autoTranscript: string;
    workerSent: any[];
    activeWorker: any;
    workletOnMessage: ((ev: MessageEvent) => void) | null;
    workletUrlsLoaded: string[];
    workletFlushCalls: number;
    tracksStopped: number;
    ctxClosed: number;
    fftLevel: number;
  } = {
    micMode: "ok",
    autoReady: opts.autoReady,
    autoTranscript: opts.autoTranscript ?? "voice transcript from spa",
    workerSent: [],
    activeWorker: null,
    workletOnMessage: null,
    workletUrlsLoaded: [],
    workletFlushCalls: 0,
    tracksStopped: 0,
    ctxClosed: 0,
    fftLevel: 0,
  };

  class MockVoiceWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    terminated = false;

    constructor() {
      state.activeWorker = this;
      queueMicrotask(() => {
        this.emit({ type: "worker_ready" });
      });
    }

    emit(data: any) {
      if (this.terminated) return;
      this.onmessage?.({ data } as MessageEvent);
    }

    postMessage(msg: any) {
      if (this.terminated) return;
      const cloned =
        msg && msg.type === "transcribe"
          ? { ...msg, audioLen: msg.audio?.length ?? 0 }
          : structuredClone(msg);
      state.workerSent.push(cloned);
      if (state.autoReady && msg?.type === "load") {
        queueMicrotask(() => {
          this.emit({
            type: "ready",
            loadId: msg.loadId,
            fromCache: true,
            threads: 1,
          });
        });
      } else if (state.autoReady && msg?.type === "transcribe") {
        queueMicrotask(() => {
          this.emit({
            type: "transcribe_done",
            jobId: msg.jobId,
            sessionGen: msg.sessionGen,
            chunkIdx: msg.chunkIdx,
            isFinal: msg.isFinal,
            text: state.autoTranscript,
            latencyMs: 12,
            audioDurationS: (msg.audio?.length ?? 0) / 16000,
          });
        });
      }
    }

    terminate() {
      this.terminated = true;
      if (state.activeWorker === this) state.activeWorker = null;
    }
  }

  class MockAudioWorkletNode {
    port = {
      get onmessage() {
        return state.workletOnMessage;
      },
      set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        state.workletOnMessage = fn;
      },
      postMessage(msg: any) {
        if (msg?.type === "flush") state.workletFlushCalls++;
      },
    };
    connect() {}
    disconnect() {}
  }

  class MockAudioContext {
    sampleRate = 48000;
    state: AudioContextState = "running";
    destination = {};
    private listeners = new Map<string, Set<() => void>>();

    audioWorklet = {
      addModule: async (url: string) => {
        state.workletUrlsLoaded.push(String(url));
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch worklet ${url}: HTTP ${res.status}`);
        }
        const text = await res.text();
        if (!text.includes("indirect-voice-capture")) {
          throw new Error(`Unexpected worklet content from ${url}`);
        }
      },
    };

    resume = async () => {
      this.state = "running";
    };

    close = async () => {
      this.state = "closed";
      state.ctxClosed++;
    };

    addEventListener(ev: string, fn: () => void) {
      let set = this.listeners.get(ev);
      if (!set) {
        set = new Set();
        this.listeners.set(ev, set);
      }
      set.add(fn);
    }

    removeEventListener(ev: string, fn: () => void) {
      this.listeners.get(ev)?.delete(fn);
    }

    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }

    createAnalyser() {
      return {
        fftSize: 256,
        smoothingTimeConstant: 0.65,
        frequencyBinCount: 128,
        getByteFrequencyData(arr: Uint8Array) {
          arr.fill(state.fftLevel);
        },
        connect() {},
        disconnect() {},
      };
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {},
      };
    }
  }

  // Intercept ONLY voice-worker.js
  (window as any).Worker = function WrappedWorker(url: string | URL, workerOpts?: WorkerOptions) {
    const href = String(url);
    if (href.includes("voice-worker.js")) {
      return new MockVoiceWorker();
    }
    return new OrigWorker(url, workerOpts);
  };

  (window as any).AudioContext = MockAudioContext;
  (window as any).webkitAudioContext = MockAudioContext;
  (window as any).AudioWorkletNode = MockAudioWorkletNode;
  (window as any).__OrigAudioContext = OrigAudioContext;

  const mockMediaDevices = {
    getUserMedia: async () => {
      if (state.micMode === "NotAllowedError") {
        const e = new DOMException("Permission denied by user", "NotAllowedError");
        throw e;
      }
      if (state.micMode === "NotFoundError") {
        const e = new DOMException("Requested device not found", "NotFoundError");
        throw e;
      }
      const track = {
        kind: "audio",
        readyState: "live",
        stop: () => {
          track.readyState = "ended";
          state.tracksStopped++;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      };
    },
  };

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: mockMediaDevices,
  });

  (window as any).__voiceMock = {
    state,
    setMicMode(mode: "ok" | "NotAllowedError" | "NotFoundError") {
      state.micMode = mode;
    },
    setAutoReady(v: boolean) {
      state.autoReady = v;
    },
    setAutoTranscript(text: string) {
      state.autoTranscript = text;
    },
    emitProgress(loadId: number, stage: string, loaded: number, total: number, pct: number) {
      state.activeWorker?.emit({
        type: "progress",
        loadId,
        progress: { stage, loaded, total, pct },
      });
    },
    emitReady(loadId: number, fromCache = false) {
      state.activeWorker?.emit({
        type: "ready",
        loadId,
        fromCache,
        threads: 1,
      });
    },
    emitTranscribeDone(text: string) {
      const last = [...state.workerSent].reverse().find((m) => m.type === "transcribe");
      if (!last) throw new Error("No pending transcribe job in workerSent");
      state.activeWorker?.emit({
        type: "transcribe_done",
        jobId: last.jobId,
        sessionGen: last.sessionGen,
        chunkIdx: last.chunkIdx,
        isFinal: last.isFinal,
        text,
        latencyMs: 18,
        audioDurationS: 0.5,
      });
    },
    emitError(phase: "load" | "transcribe", error: string) {
      if (phase === "load") {
        const last = [...state.workerSent].reverse().find((m) => m.type === "load");
        state.activeWorker?.emit({ type: "error", phase: "load", loadId: last?.loadId, error });
      } else {
        const last = [...state.workerSent].reverse().find((m) => m.type === "transcribe");
        state.activeWorker?.emit({
          type: "error",
          phase: "transcribe",
          jobId: last?.jobId,
          sessionGen: last?.sessionGen,
          error,
        });
      }
    },
    emitSpeech(durationMs = 500, amplitude = 0.25) {
      state.fftLevel = Math.min(255, Math.round(amplitude * 640));
      const totalSamples = Math.round((48000 * durationMs) / 1000);
      const blockSize = 1024;
      let sent = 0;
      while (sent < totalSamples) {
        const n = Math.min(blockSize, totalSamples - sent);
        const pcm = new Float32Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const v = amplitude * Math.sin((2 * Math.PI * 440 * (sent + i)) / 48000);
          pcm[i] = v;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / n);
        state.workletOnMessage?.({ data: { pcm, rms } } as MessageEvent);
        sent += n;
      }
    },
    lastLoadId(): number {
      const last = [...state.workerSent].reverse().find((m) => m.type === "load");
      return last?.loadId ?? 0;
    },
    sentOfType(type: string) {
      return state.workerSent.filter((m) => m.type === type);
    },
    clearSent() {
      state.workerSent.length = 0;
    },
  };
}

// ===========================================================================
// Server 1: Phase 1 Focused Voice Fixture (Real `baseHeaders` + real worklet)
// ===========================================================================

const fixtureServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/bundle.js") {
      const h = baseHeaders(req, false);
      h.set("Content-Type", "text/javascript; charset=utf-8");
      return new Response(fixtureBundle.outputs[0], { headers: h });
    }
    if (pathname === "/app.css") {
      const h = baseHeaders(req, false);
      h.set("Content-Type", "text/css; charset=utf-8");
      return new Response(Bun.file(path.join(DIST_DIR, cssName)), { headers: h });
    }
    if (pathname === "/workers/voice-worklet.js" || pathname.startsWith("/assets/")) {
      const staticRes = serveStatic(req, pathname);
      if (staticRes) return staticRes;
      return new Response("Not found", { status: 404 });
    }
    const headers = baseHeaders(req, true);
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(
      '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/app.css" /></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
      { headers },
    );
  },
});

// ===========================================================================
// Server 2: Phase 2 Production `dist/` SPA + Mock Gateway WS/REST
// ===========================================================================

const HOST_ID = "host-voice-spa";
const NOW = Date.now();

const MOCK_MODELS = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    context_length: 200_000,
    owned_by: "anthropic",
    supported_efforts: ["low", "medium", "high", "max"],
    default_effort: "high",
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    context_length: 256_000,
    owned_by: "openai",
    supported_efforts: ["low", "medium", "high"],
    default_effort: "high",
  },
];

const MOCK_CONFIG = {
  id: "daemon",
  hostId: HOST_ID,
  revision: "rev-1",
  name: "devbox",
  lastSelection: {
    model: "claude-sonnet-4-6",
    effort: "high",
    mode: "agentic",
    access: "auto",
    skills: [{ name: "build" }],
  },
  settings: {
    mid_turn_send: "queue",
    auto_compact_threshold: 80,
    no_auto_title: false,
    jail_by_default: true,
    insecure_tls: false,
  },
  skills: {
    build: {
      name: "build",
      description: "Full coding mode",
      mode: "agentic",
      usable: "always",
      approvalMode: "ask",
      builtin: true,
      enabled: true,
    },
  },
  skillErrors: {},
};

let spaStatus: "idle" | "running" = "running";
let spaPromptCommands = 0;
let spaQueue: any[] = [];

function buildSpaSession() {
  return {
    id: "s-voice",
    hostId: HOST_ID,
    projectId: "proj-voice",
    title: "Voice Responsive Verification",
    cwd: "/repo/indirect",
    model: "claude-sonnet-4-6",
    status: spaStatus,
    pinned: false,
    createdAt: NOW - 600_000,
    updatedAt: Date.now(),
    approvalMode: "ask",
    options: { effort: "high", mode: "agentic", access: "auto", skills: [{ name: "build" }] },
    skills: { build: { priority: 0, active: true, usable: "inherit" } },
    turn: spaStatus === "running" ? { startedAt: Date.now() - 4000, status: "running" } : null,
    todos: [],
    todosOpen: false,
    queue: spaQueue,
    messages: [
      {
        id: "u-1",
        role: "user",
        turnIndex: 1,
        createdAt: NOW - 120_000,
        content: [{ type: "text", text: "Verify responsive voice composer layout." }],
      },
      {
        id: "a-1",
        role: "assistant",
        turnIndex: 1,
        createdAt: NOW - 110_000,
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Checking composer geometry across viewports and themes." }],
      },
    ],
    context: { usedTokens: 24_000, limitTokens: 200_000, percent: 12 },
    transcript: { stream: "voice-spa-1", seq: 2 },
  };
}

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

const spaServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/api/indirect-code/ws") {
      return srv.upgrade(req) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (pathname === "/api/indirect-code/hosts") {
      return Response.json({
        success: true,
        hosts: [
          {
            id: HOST_ID,
            name: "devbox",
            hostname: "workstation.local",
            os: "linux",
            arch: "amd64",
            version: "v0.9.3",
            status: "online",
            lastSeenAt: Date.now(),
          },
        ],
      });
    }
    if (pathname === "/api/me/models") return Response.json({ success: true, models: MOCK_MODELS });
    if (pathname === "/api/keys") return Response.json({ success: true, keys: [] });
    if (pathname === "/api/auth/refresh") {
      return Response.json({
        success: true,
        accessToken: "mock-voice-token",
        refreshToken: "mock-voice-refresh",
        user: {
          id: "u-1",
          email: "voice@indirect.dev",
          name: "Voice Test",
          role: "admin",
          hasPassword: true,
          googleLinked: false,
          totpEnabled: false,
          status: "active",
          createdAt: NOW - 86_400_000,
        },
      });
    }
    if (pathname.startsWith("/api/")) return Response.json({ success: true });

    const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const diskPath = path.join(DIST_DIR, relPath);
    if (existsSync(diskPath) && relPath !== "index.html") {
      const ext = path.extname(diskPath).toLowerCase();
      const headers = baseHeaders(req, false);
      headers.set("Content-Type", MIME_MAP[ext] || "application/octet-stream");
      if (pathname.startsWith("/workers/")) headers.set("Cache-Control", "no-cache");
      return new Response(Bun.file(diskPath), { headers });
    }
    const htmlHeaders = baseHeaders(req, true);
    htmlHeaders.set("Content-Type", "text/html; charset=utf-8");
    return new Response(Bun.file(path.join(DIST_DIR, "index.html")), { headers: htmlHeaders });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello", hosts: [{ id: HOST_ID, status: "online" }] }));
    },
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const hid = msg.hostId || HOST_ID;
      if (msg.type === "prompt") {
        spaPromptCommands++;
        ws.send(JSON.stringify({ type: "prompt_ack", hostId: hid, requestId: msg.requestId }));
        return;
      }
      if (msg.type === "pull") {
        const items =
          msg.collection === "projects"
            ? [
                {
                  id: "proj-voice",
                  hostId: HOST_ID,
                  name: "indirect",
                  path: "/repo/indirect",
                  createdAt: NOW - 86_400_000,
                  protected: false,
                  collapsed: false,
                  folderStatus: "available",
                },
              ]
            : msg.collection === "sessions"
              ? [
                  {
                    id: "s-voice",
                    hostId: HOST_ID,
                    projectId: "proj-voice",
                    title: "Voice Responsive Verification",
                    cwd: "/repo/indirect",
                    model: "claude-sonnet-4-6",
                    status: spaStatus,
                    pinned: false,
                    createdAt: NOW - 600_000,
                    updatedAt: Date.now(),
                    approvalMode: "ask",
                    options: { effort: "high", mode: "agentic", access: "auto", skills: [{ name: "build" }] },
                  },
                ]
              : msg.collection === "config"
                ? [MOCK_CONFIG]
                : [];
        ws.send(JSON.stringify({ type: "pull-response", id: msg.id, hostId: hid, collection: msg.collection, items }));
        return;
      }
      if (msg.type === "get_session") {
        ws.send(
          JSON.stringify({
            type: "session_data",
            hostId: hid,
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            session: buildSpaSession(),
          }),
        );
        return;
      }
      if (msg.type === "get_turn_changes") {
        ws.send(
          JSON.stringify({
            type: "turn_changes",
            hostId: hid,
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            balloons: [],
          }),
        );
        return;
      }
      if (msg.type === "check_workspace") {
        ws.send(
          JSON.stringify({
            type: "workspace_status",
            hostId: hid,
            requestId: msg.requestId,
            workspace: { status: "available", path: "/repo/indirect" },
          }),
        );
      }
    },
  },
});

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const VIEWPORTS = [
  { key: "360x780", width: 360, height: 780, isMobile: true, hasTouch: true, ua: IPHONE_UA },
  { key: "390x844", width: 390, height: 844, isMobile: true, hasTouch: true, ua: IPHONE_UA },
  { key: "768x1024-ipad", width: 768, height: 1024, isMobile: true, hasTouch: true, ua: IPAD_UA },
  { key: "768x1024-desk", width: 768, height: 1024, isMobile: false, hasTouch: false, ua: DESKTOP_UA },
  { key: "1440x900", width: 1440, height: 900, isMobile: false, hasTouch: false, ua: DESKTOP_UA },
] as const;

const THEMES = ["dark", "light", "high-contrast"] as const;

const { chromium } = await loadPlaywright();
const executablePath = await resolveChrome();
const browser = await chromium.launch({ executablePath, headless: true });

try {
  // =========================================================================
  // PHASE 1: Focused Voice Flow Gate (real CSP + Permissions-Policy + worklet)
  // =========================================================================
  console.log("[voice-ui] Phase 1: Running focused voice flow gate...");

  // Verify HTTP headers served for HTML and real voice-worklet.js
  const htmlHead = await fetch(fixtureServer.url.toString());
  assert.equal(htmlHead.status, 200);
  const pp = htmlHead.headers.get("permissions-policy") || "";
  const csp = htmlHead.headers.get("content-security-policy") || "";
  assert(pp.includes("microphone=(self)"), `Expected microphone=(self) in Permissions-Policy, got: ${pp}`);
  assert(csp.includes("worker-src 'self'"), `Expected worker-src 'self' in CSP, got: ${csp}`);

  const workletRes = await fetch(new URL("/workers/voice-worklet.js", fixtureServer.url));
  assert.equal(workletRes.status, 200, "dist/workers/voice-worklet.js must be served");
  assert.match(workletRes.headers.get("content-type") || "", /javascript/);
  assert.equal(workletRes.headers.get("cache-control"), "no-cache");

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(installVoiceBrowserMocks, { autoReady: false });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    page.on("console", (msg: any) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(fixtureServer.url.toString(), { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean((window as any).voiceFixture?.voice));
    await page.waitForSelector(".rc-composer-voice", { timeout: 5000 });

    // Real Chromium AudioWorklet CSP smoke check using OrigAudioContext
    const realWorkletCheck = await page.evaluate(async () => {
      const OrigAC = (window as any).__OrigAudioContext;
      if (!OrigAC) return { ok: true, skipped: true };
      const ctx = new OrigAC();
      try {
        await ctx.audioWorklet.addModule("/workers/voice-worklet.js");
        return { ok: true, skipped: false };
      } catch (err: any) {
        return { ok: false, error: String(err?.message || err) };
      } finally {
        await ctx.close().catch(() => {});
      }
    });
    assert.equal(
      realWorkletCheck.ok,
      true,
      `Real Chromium audioWorklet.addModule('/workers/voice-worklet.js') failed under production CSP: ${JSON.stringify(realWorkletCheck)}`,
    );

    // 1) Idle state assertions
    const idleCheck = await page.evaluate(() => {
      const composer = document.querySelector(".rc-composer")!;
      const canvas = document.querySelector(".rc-voice-aurora-canvas") as HTMLCanvasElement | null;
      const voiceBtn = document.querySelector(".rc-composer-voice") as HTMLButtonElement | null;
      const bars = voiceBtn?.querySelectorAll(".rc-voice-bars-svg rect").length ?? 0;
      const ambientCount = document.querySelectorAll(".rc-voice-ambient").length;
      const titled = composer.querySelectorAll("[title]").length;
      const collapseVisible = document.querySelectorAll("[data-composer-collapse]").length;
      return {
        auroraRunning: canvas?.dataset.auroraRunning,
        voiceBtnVisible: Boolean(voiceBtn && voiceBtn.getBoundingClientRect().width > 0),
        bars,
        ambientCount,
        titled,
        collapseVisible,
        voiceState: composer.getAttribute("data-voice-state"),
      };
    });
    assert.equal(idleCheck.ambientCount, 0, "Idle state must not mount .rc-voice-ambient");
    assert.equal(idleCheck.auroraRunning, "false", "Idle aurora must stay asleep (data-aurora-running=false)");
    assert.equal(idleCheck.voiceBtnVisible, true, ".rc-composer-voice must be visible when idle");
    assert.equal(idleCheck.bars, 5, ".rc-voice-bars-svg must render 5 waveform bars");
    assert.equal(idleCheck.titled, 0, "Composer/voice controls must have zero native title= attributes");
    assert.equal(idleCheck.collapseVisible, 1, "Collapse button must be visible while idle");
    assert.equal(idleCheck.voiceState, "idle");

    // 2) Full flow: idle -> loading -> listening -> thinking -> revealing -> idle (0% idle CPU)
    await page.locator(".rc-composer-voice").click();
    await page.waitForSelector(".rc-composer-voice-cancel", { timeout: 5000 });

    const loadingState = await page.evaluate(() => {
      const cancelBtn = document.querySelector(".rc-composer-voice-cancel") as HTMLButtonElement | null;
      const confirmBtn = document.querySelector(".rc-composer-voice-confirm") as HTMLButtonElement | null;
      const canvas = document.querySelector(".rc-voice-aurora-canvas") as HTMLCanvasElement | null;
      const ambient = document.querySelector(".rc-voice-ambient") as HTMLElement | null;
      const collapseCount = document.querySelectorAll("[data-composer-collapse]").length;
      const loadSent = (window as any).__voiceMock.sentOfType("load");
      return {
        cancelDisabled: cancelBtn?.disabled,
        confirmDisabled: confirmBtn?.disabled,
        auroraRunning: canvas?.dataset.auroraRunning,
        ambientMode: ambient?.dataset.voiceMode,
        collapseCount,
        loadCount: loadSent.length,
        authToken: loadSent[0]?.authToken,
      };
    });
    assert.equal(loadingState.cancelDisabled, false, "Cancel must be enabled during loading");
    assert.equal(loadingState.confirmDisabled, true, "Confirm must be disabled during loading");
    assert.equal(loadingState.auroraRunning, "true", "Aurora must animate during loading");
    assert.equal(loadingState.ambientMode, "loading");
    assert.equal(loadingState.collapseCount, 0, "Collapse button must be hidden while voice is active");
    assert.equal(loadingState.loadCount, 1);
    assert.equal(loadingState.authToken, "fixture-voice-token");

    // Step through progress stages
    await page.evaluate(() => {
      const m = (window as any).__voiceMock;
      m.emitProgress(m.lastLoadId(), "server-warming", 25, 100, 25);
    });
    assert.equal(await page.locator("[data-voice-status-overlay] .ui-shimmer").textContent(), "Preparing voice model on server...");
    assert.equal(await page.locator("[data-voice-status-meta]").textContent(), "25%");

    await page.evaluate(() => {
      const m = (window as any).__voiceMock;
      m.emitProgress(m.lastLoadId(), "downloading", 100 * 1024 * 1024, 200 * 1024 * 1024, 50);
    });
    assert.equal(await page.locator("[data-voice-status-overlay] .ui-shimmer").textContent(), "Downloading voice model...");
    assert.equal(await page.locator("[data-voice-status-meta]").textContent(), "50% · 100/200 MB");

    await page.evaluate(() => {
      const m = (window as any).__voiceMock;
      m.emitProgress(m.lastLoadId(), "initializing", 200, 200, 96);
    });
    assert.equal(await page.locator("[data-voice-status-overlay] .ui-shimmer").textContent(), "Preparing voice engine...");
    assert.equal(await page.locator("[data-voice-status-meta]").textContent(), "Almost ready");

    // Emit ready -> transitions to listening
    await page.evaluate(() => {
      const m = (window as any).__voiceMock;
      m.emitReady(m.lastLoadId(), false);
    });
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );

    const listeningCheck = await page.evaluate(() => {
      const confirmBtn = document.querySelector(".rc-composer-voice-confirm") as HTMLButtonElement | null;
      const dot = document.querySelector(".rc-voice-live-dot") as HTMLElement | null;
      const meta = document.querySelector("[data-voice-status-meta]")?.textContent ?? "";
      const canvas = document.querySelector(".rc-voice-aurora-canvas") as HTMLCanvasElement | null;
      const workletUrls = (window as any).__voiceMock.state.workletUrlsLoaded;
      return {
        confirmDisabled: confirmBtn?.disabled,
        dotVisible: Boolean(dot && dot.getBoundingClientRect().width > 0),
        meta,
        auroraRunning: canvas?.dataset.auroraRunning,
        workletUrls,
      };
    });
    assert.equal(listeningCheck.confirmDisabled, false, "Confirm must be enabled while listening");
    assert.equal(listeningCheck.dotVisible, true, ".rc-voice-live-dot must be visible while listening");
    assert.match(listeningCheck.meta, /^\d+:\d{2}$/, "Timer meta must show mm:ss while listening");
    assert.equal(listeningCheck.auroraRunning, "true");
    assert(
      listeningCheck.workletUrls.includes("workers/voice-worklet.js"),
      `Expected workers/voice-worklet.js loaded, got ${JSON.stringify(listeningCheck.workletUrls)}`,
    );

    // Emit speech and wait > 260ms, then click Confirm -> thinking
    await page.evaluate(() => (window as any).__voiceMock.emitSpeech(500, 0.28));
    await page.waitForTimeout(320);
    await page.locator(".rc-composer-voice-confirm").click();

    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "thinking",
      { timeout: 5000 },
    );
    assert.equal(await page.locator(".rc-composer-voice-confirm").isDisabled(), true, "Confirm must be disabled during thinking");
    assert.equal(await page.locator("[data-voice-status-overlay] .ui-shimmer").textContent(), "Transcribing...");

    // Wait for worklet flush + transcribe job dispatch
    await page.waitForFunction(() => (window as any).__voiceMock.sentOfType("transcribe").length === 1, { timeout: 5000 });

    // Emit transcript -> word bloom reveal + #rc-composer reconciliation
    await page.evaluate(() => {
      (window as any).__voiceMock.emitTranscribeDone("build a rest api with type script");
    });
    await page.waitForSelector(".rc-voice-word-bloom", { timeout: 5000 });

    const revealCheck = await page.evaluate(() => {
      const spans = [...document.querySelectorAll(".rc-voice-word-bloom")].map((s) => s.textContent);
      const val = (document.getElementById("rc-composer") as HTMLTextAreaElement).value;
      return { spans, val };
    });
    assert.deepEqual(revealCheck.spans, ["Build", "a", "REST", "API", "with", "TypeScript"]);
    assert.equal(revealCheck.val, "Build a REST API with TypeScript");

    // Wait for bloom reveal + aurora dissolve to finish -> data-aurora-running="false" (0% idle CPU!)
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector(".rc-voice-aurora-canvas") as HTMLCanvasElement | null;
        return (
          canvas?.dataset.auroraRunning === "false" &&
          document.querySelectorAll(".rc-voice-word-bloom").length === 0 &&
          document.querySelectorAll(".rc-voice-ambient").length === 0
        );
      },
      { timeout: 5000 },
    );
    assert.equal(await page.locator("[data-composer-collapse]").count(), 1, "Collapse button must reappear when idle");

    // 3) Enter anti-double-fire check
    await page.locator("#rc-composer").fill("Existing draft");
    await page.evaluate(() => {
      (window as any).voiceFixture.sendCount = 0;
      (window as any).__voiceMock.clearSent();
    });
    await page.locator(".rc-composer-voice").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );
    await page.evaluate(() => (window as any).__voiceMock.emitSpeech(500, 0.25));
    await page.waitForTimeout(320);

    // Press Enter while listening -> MUST confirm dictation and MUST NOT submit composer draft!
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as any).__voiceMock.sentOfType("transcribe").length === 1, { timeout: 5000 });
    await page.evaluate(() => (window as any).__voiceMock.emitTranscribeDone("with voice follow up"));
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
      { timeout: 5000 },
    );
    const enterResult = await page.evaluate(() => ({
      val: (document.getElementById("rc-composer") as HTMLTextAreaElement).value,
      sendCount: (window as any).voiceFixture.sendCount,
    }));
    assert.equal(enterResult.val, "Existing draft with voice follow up");
    assert.equal(enterResult.sendCount, 0, "Pressing Enter while listening must NOT submit the composer draft");

    // 4) Escape cancels cleanly in loading, listening, and thinking without losing draft text
    await page.locator("#rc-composer").fill("Preserve this draft");

    // 4a) Escape in listening
    await page.evaluate(() => (window as any).__voiceMock.clearSent());
    await page.locator(".rc-composer-voice").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
      { timeout: 5000 },
    );
    assert.equal(await page.locator("#rc-composer").inputValue(), "Preserve this draft");
    assert(
      await page.evaluate(() => (window as any).__voiceMock.sentOfType("cancel_session").length >= 1),
      "Escape during listening must send cancel_session",
    );

    // 4b) Escape in thinking
    await page.evaluate(() => (window as any).__voiceMock.clearSent());
    await page.locator(".rc-composer-voice").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );
    await page.evaluate(() => (window as any).__voiceMock.emitSpeech(500, 0.25));
    await page.waitForTimeout(320);
    await page.locator(".rc-composer-voice-confirm").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "thinking",
      { timeout: 5000 },
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
      { timeout: 5000 },
    );
    assert.equal(await page.locator("#rc-composer").inputValue(), "Preserve this draft");

    // 4c) Escape in loading (trigger fresh page load where modelReady is false)
    {
      const loadPage = await context.newPage();
      loadPage.on("pageerror", (e: Error) => pageErrors.push(`escape-loading: ${e.message}`));
      loadPage.on("console", (msg: any) => {
        if (msg.type() === "error") consoleErrors.push(`escape-loading: ${msg.text()}`);
      });
      await loadPage.goto(fixtureServer.url.toString(), { waitUntil: "networkidle" });
      await loadPage.waitForSelector(".rc-composer-voice", { timeout: 5000 });
      await loadPage.locator("#rc-composer").fill("Draft during load");
      await loadPage.locator(".rc-composer-voice").click();
      await loadPage.waitForFunction(
        () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "loading",
        { timeout: 5000 },
      );
      await loadPage.keyboard.press("Escape");
      await loadPage.waitForFunction(
        () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
        { timeout: 5000 },
      );
      assert.equal(await loadPage.locator("#rc-composer").inputValue(), "Draft during load");
      assert(
        await loadPage.evaluate(() => (window as any).__voiceMock.sentOfType("abort_load").length === 1),
        "Escape during loading must send abort_load",
      );
      await loadPage.close();
    }

    // 5) Error recovery: NotAllowedError + worker error recover to idle with visible toast & allow retry
    await page.evaluate(() => {
      (window as any).voiceFixture.clearToasts();
      (window as any).__voiceMock.setMicMode("NotAllowedError");
    });
    await page.locator(".rc-composer-voice").click();
    await page.waitForSelector('[data-voice-toast][data-toast-kind="err"]', { timeout: 5000 });
    assert.equal(
      await page.locator('[data-voice-toast][data-toast-kind="err"]').last().textContent(),
      "Microphone permission denied",
    );
    assert.equal(await page.locator(".rc-composer").getAttribute("data-voice-state"), "idle");

    // Retry after restoring mic permission -> succeeds cleanly!
    await page.evaluate(() => {
      (window as any).voiceFixture.clearToasts();
      (window as any).__voiceMock.setMicMode("ok");
      (window as any).__voiceMock.clearSent();
    });
    await page.locator(".rc-composer-voice").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );

    // Worker transcribe error -> recovers to idle with visible error toast & allows retry
    await page.evaluate(() => (window as any).__voiceMock.emitSpeech(500, 0.25));
    await page.waitForTimeout(320);
    await page.locator(".rc-composer-voice-confirm").click();
    await page.waitForFunction(() => (window as any).__voiceMock.sentOfType("transcribe").length === 1, { timeout: 5000 });
    await page.evaluate(() => (window as any).__voiceMock.emitError("transcribe", "WASM backend error"));
    await page.waitForSelector('[data-voice-toast][data-toast-kind="err"]', { timeout: 5000 });
    assert.equal(await page.locator('[data-voice-toast][data-toast-kind="err"]').last().textContent(), "WASM backend error");
    assert.equal(await page.locator(".rc-composer").getAttribute("data-voice-state"), "idle");

    // Subsequent retry succeeds cleanly
    await page.evaluate(() => (window as any).__voiceMock.clearSent());
    await page.locator(".rc-composer-voice").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
      { timeout: 5000 },
    );

    // 6) reducedMotion (`data-reduced-motion="reduce"` AND OS `prefers-reduced-motion: reduce`)
    await page.locator("#rc-composer").fill("");
    await page.evaluate(() => {
      (window as any).voiceFixture.setReducedMotionOverride(true);
      (window as any).__voiceMock.clearSent();
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.reducedMotion),
      "reduce",
      "setReducedMotionOverride(true) must set data-reduced-motion='reduce'",
    );
    await page.locator(".rc-composer-voice").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );
    const reducedListening = await page.evaluate(() => {
      const canvas = document.querySelector(".rc-voice-aurora-canvas") as HTMLCanvasElement | null;
      const ambient = document.querySelector(".rc-voice-ambient") as HTMLElement | null;
      return {
        auroraRunning: canvas?.dataset.auroraRunning,
        ambientDisplay: ambient ? getComputedStyle(ambient).display : "none",
      };
    });
    assert.equal(reducedListening.auroraRunning, "false", "reducedMotion must NOT spin aurora rAF");
    assert.equal(reducedListening.ambientDisplay, "none", "reducedMotion must hide .rc-voice-ambient");

    await page.evaluate(() => (window as any).__voiceMock.emitSpeech(500, 0.25));
    await page.waitForTimeout(320);
    await page.locator(".rc-composer-voice-confirm").click();
    await page.waitForFunction(() => (window as any).__voiceMock.sentOfType("transcribe").length === 1, { timeout: 5000 });
    await page.evaluate(() => (window as any).__voiceMock.emitTranscribeDone("reduced motion transcript"));
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
      { timeout: 5000 },
    );
    assert.equal(await page.locator("#rc-composer").inputValue(), "Reduced motion transcript");
    assert.equal(await page.locator(".rc-voice-word-bloom").count(), 0, "reducedMotion must skip word bloom");

    // Also test native OS prefers-reduced-motion media emulation
    await page.evaluate(() => (window as any).voiceFixture.setReducedMotionOverride(null));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".rc-composer-voice").click();
    await page.waitForFunction(
      () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
      { timeout: 5000 },
    );
    assert.equal(
      await page.evaluate(() => (document.querySelector(".rc-voice-aurora-canvas") as HTMLCanvasElement)?.dataset.auroraRunning),
      "false",
      "OS prefers-reduced-motion must NOT spin aurora rAF",
    );
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    assert.deepEqual(pageErrors, [], `Phase 1 pageerror: ${pageErrors.join(" | ")}`);
    assert.deepEqual(consoleErrors, [], `Phase 1 console.error: ${consoleErrors.join(" | ")}`);
    await context.close();
  }
  console.log("[voice-ui] Phase 1 PASSED: idle, full lifecycle, 0% idle CPU, Enter anti-double-fire, Escape x3, error recovery, reducedMotion, collapse guard, CSP/worklet.");

  // =========================================================================
  // PHASE 2: Full Production `dist/` SPA Responsive & Multi-Theme Gate
  // =========================================================================
  console.log("[voice-ui] Phase 2: Sweeping 5 viewports × 3 themes (dark/light/high-contrast) on production dist/ SPA...");

  const spaErrors: string[] = [];

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const tag = `${vp.key}_${theme}`;
      spaStatus = "running";
      spaPromptCommands = 0;
      spaQueue = [
        {
          id: "q-passive-1",
          text: "Run voice regression summary after turn finishes",
          model: "claude-sonnet-4-6",
          yolo: false,
          attachmentIds: [],
          delivery: "queue",
          createdAt: Date.now() - 2_000,
        },
      ];

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        userAgent: vp.ua,
        colorScheme: theme === "light" ? "light" : "dark",
      });

      await context.addInitScript(installVoiceBrowserMocks, {
        autoReady: true,
        autoTranscript: "dictated in production spa",
      });
      await context.addInitScript(
        ({ hostId, themeMode }) => {
          localStorage.setItem(
            "cache_code_session",
            JSON.stringify({
              accessToken: "mock-voice-token",
              refreshToken: "mock-voice-refresh",
              user: {
                id: "u-1",
                email: "voice@indirect.dev",
                name: "Voice Test",
                role: "admin",
                hasPassword: true,
                googleLinked: false,
                totpEnabled: false,
                status: "active",
                createdAt: Date.now() - 86_400_000,
              },
            }),
          );
          localStorage.setItem("llmgw-theme", themeMode);
          localStorage.setItem("llmgw-rc-active-host", hostId);
          localStorage.setItem(`llmgw-rc-session:${hostId}`, "s-voice");
        },
        { hostId: HOST_ID, themeMode: theme },
      );

      const page = await context.newPage();
      page.on("pageerror", (e: Error) => spaErrors.push(`${tag} pageerror: ${e.message}`));
      page.on("console", (msg: any) => {
        if (msg.type() === "error") spaErrors.push(`${tag} console.error: ${msg.text()}`);
      });

      await page.goto(`${spaServer.url}#/code`, { waitUntil: "networkidle" });
      await page.waitForSelector(".rc-composer-voice", { timeout: 15_000 });
      try {
        await page.waitForSelector("[data-composer-queue-shelf]", { timeout: 4_000 });
      } catch {
        // Under heavy CI load, IndexedDB `sessions.isReady()` can resolve before
        // the initial WebSocket handshake finishes, causing the page to fall back
        // to draft mode ("new"). Re-select `s-voice` once pulled.
        await page.evaluate((hid: string) => {
          localStorage.setItem(`llmgw-rc-session:${hid}`, "s-voice");
        }, HOST_ID);
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForSelector("[data-composer-queue-shelf]", { timeout: 15_000 });
      }
      await page.waitForTimeout(200);

      // Idle running-turn assertions (Stop + Voice + Send + docked QueueShelf)
      const parseColorAlpha = (bg: string): number => {
        const s = (bg || "").trim().toLowerCase();
        if (!s || s === "transparent") return 0;
        const slash = s.match(/\/\s*([\d.]+%?)\s*\)$/);
        if (slash) {
          const raw = slash[1]!;
          return raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
        }
        const rgba = s.match(/^rgba\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*([\d.]+%?)\s*\)$/);
        if (rgba) {
          const raw = rgba[1]!;
          return raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
        }
        return 1;
      };

      const idleGeom = await page.evaluate(() => {
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const comp = document.querySelector<HTMLElement>(".rc-composer")!;
        const shelf = document.querySelector<HTMLElement>("[data-composer-queue-shelf]")!;
        const toolbar = comp.querySelector<HTMLElement>(".rc-composer-toolbar")!;
        const modelBtn = toolbar.querySelector<HTMLElement>("button.rc-composer-model")!;
        const voiceBtn = toolbar.querySelector<HTMLElement>(".rc-composer-voice")!;
        const compR = comp.getBoundingClientRect();
        const shelfR = shelf.getBoundingClientRect();
        const modelR = modelBtn.getBoundingClientRect();

        const visibleBtns = [...toolbar.querySelectorAll<HTMLElement>("button")].filter(
          (b) => b.getBoundingClientRect().width > 0,
        );
        const centerYs = visibleBtns.map((b) => {
          const r = b.getBoundingClientRect();
          return r.top + r.height / 2;
        });
        const toolbarRowSpread = centerYs.length > 1 ? Math.max(...centerYs) - Math.min(...centerYs) : 0;

        const measureTouch = (el: HTMLElement | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const after = getComputedStyle(el, "::after");
          const aw = parseFloat(after.width) || 0;
          const ah = parseFloat(after.height) || 0;
          return {
            visualW: round2(r.width),
            visualH: round2(r.height),
            hitW: round2(Math.max(r.width, aw)),
            hitH: round2(Math.max(r.height, ah)),
          };
        };

        const measureControl = (el: HTMLElement | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || "none";
          return {
            width: round2(r.width),
            height: round2(r.height),
            bg: cs.backgroundColor,
            backdrop: bf,
            boxShadow: cs.boxShadow,
          };
        };

        const toolbarStyle = getComputedStyle(toolbar);
        const controls = {
          add: measureControl(toolbar.querySelector<HTMLElement>("button.rc-composer-add")),
          mode: measureControl(toolbar.querySelector<HTMLElement>('button[aria-label^="Agent mode and skills"]')),
          access: measureControl(toolbar.querySelector<HTMLElement>("button[data-access-mode]")),
          model: measureControl(modelBtn),
          stop: measureControl(toolbar.querySelector<HTMLElement>("button.rc-composer-stop")),
        };

        return {
          themeAttr: document.documentElement.dataset.theme,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          seamDiff: round2(Math.abs(shelfR.bottom - compR.top)),
          composerShadow: getComputedStyle(comp).boxShadow,
          toolbarBg: toolbarStyle.backgroundColor,
          toolbarBorderTop: toolbarStyle.borderTopWidth,
          toolbarRowSpread: round2(toolbarRowSpread),
          modelVisualWidth: round2(modelR.width),
          voiceTouch: measureTouch(voiceBtn),
          stopPresent: Boolean(toolbar.querySelector(".rc-composer-stop")),
          sendPresent: Boolean(toolbar.querySelector(".rc-composer-send")),
          controls,
        };
      });

      assert.equal(idleGeom.themeAttr, theme, `${tag}: expected data-theme="${theme}"`);
      assert.equal(
        idleGeom.overflow,
        false,
        `${tag}: idle horizontal overflow scrollWidth=${idleGeom.scrollWidth} > innerWidth=${idleGeom.innerWidth}`,
      );
      assert(idleGeom.seamDiff <= 0.5, `${tag}: ComposerQueueShelf seam diff=${idleGeom.seamDiff}px (>0.5px)`);
      const shadowGeom = idleGeom.composerShadow.replace(/rgba?\([^)]*\)/g, "");
      assert(
        idleGeom.composerShadow === "none" || !/[1-9]/.test(shadowGeom),
        `${tag}: idle .rc-composer must have box-shadow: none (got ${idleGeom.composerShadow})`,
      );
      assert.equal(parseColorAlpha(idleGeom.toolbarBg), 0, `${tag}: idle .rc-composer-toolbar must be transparent (got ${idleGeom.toolbarBg})`);
      assert.equal(idleGeom.toolbarBorderTop, "0px", `${tag}: idle .rc-composer-toolbar must have no border-top (got ${idleGeom.toolbarBorderTop})`);
      for (const name of ["add", "mode", "access", "model"] as const) {
        const ctrl = idleGeom.controls[name];
        assert(ctrl, `${tag}: idle toolbar control "${name}" missing`);
        assert.equal(parseColorAlpha(ctrl.bg), 0, `${tag}: idle "${name}" must be transparent (got ${ctrl.bg})`);
        assert.equal(ctrl.backdrop, "none", `${tag}: idle "${name}" must have backdrop-filter: none (got ${ctrl.backdrop})`);
        assert.equal(ctrl.boxShadow, "none", `${tag}: idle "${name}" must have box-shadow: none (got ${ctrl.boxShadow})`);
      }
      assert(idleGeom.toolbarRowSpread <= 2, `${tag}: idle toolbar wrapped (centerY spread=${idleGeom.toolbarRowSpread}px)`);
      assert.equal(idleGeom.stopPresent, true, `${tag}: Stop button must be present while turn is running`);
      assert.equal(idleGeom.sendPresent, true, `${tag}: Send button must be present while idle`);
      assert(
        idleGeom.modelVisualWidth >= 80,
        `${tag}: button.rc-composer-model visual width ${idleGeom.modelVisualWidth}px < 80px while running (Stop+Voice+Send)`,
      );
      if (vp.hasTouch) {
        assert(
          idleGeom.voiceTouch && idleGeom.voiceTouch.hitW >= 44 && idleGeom.voiceTouch.hitH >= 44,
          `${tag}: .rc-composer-voice touch hit target < 44x44px (${JSON.stringify(idleGeom.voiceTouch)})`,
        );
      }

      // Enter active voice (`listening`) and wait for the 240ms glass fade-in to settle
      await page.locator(".rc-composer-voice").click();
      await page.waitForFunction(
        () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
        { timeout: 8_000 },
      );
      await page.waitForTimeout(320);

      const activeGeom = await page.evaluate(() => {
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const comp = document.querySelector<HTMLElement>(".rc-composer")!;
        const toolbar = comp.querySelector<HTMLElement>(".rc-composer-toolbar")!;
        const canvas = comp.querySelector<HTMLCanvasElement>(".rc-voice-aurora-canvas")!;
        const ambient = document.querySelector<HTMLElement>(".rc-voice-ambient");
        const modelBtn = toolbar.querySelector<HTMLElement>("button.rc-composer-model")!;
        const cancelBtn = toolbar.querySelector<HTMLElement>(".rc-composer-voice-cancel");
        const confirmBtn = toolbar.querySelector<HTMLElement>(".rc-composer-voice-confirm");
        const compR = comp.getBoundingClientRect();

        const visibleBtns = [...toolbar.querySelectorAll<HTMLElement>("button")].filter(
          (b) => b.getBoundingClientRect().width > 0,
        );
        const centerYs = visibleBtns.map((b) => {
          const r = b.getBoundingClientRect();
          return r.top + r.height / 2;
        });
        const toolbarRowSpread = centerYs.length > 1 ? Math.max(...centerYs) - Math.min(...centerYs) : 0;

        const measureTouch = (el: HTMLElement | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const after = getComputedStyle(el, "::after");
          const aw = parseFloat(after.width) || 0;
          const ah = parseFloat(after.height) || 0;
          return {
            hitW: round2(Math.max(r.width, aw)),
            hitH: round2(Math.max(r.height, ah)),
          };
        };

        const measureControl = (el: HTMLElement | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || "none";
          return {
            width: round2(r.width),
            height: round2(r.height),
            bg: cs.backgroundColor,
            backdrop: bf,
            boxShadow: cs.boxShadow,
          };
        };

        const toolbarStyle = getComputedStyle(toolbar);
        const controls = {
          add: measureControl(toolbar.querySelector<HTMLElement>("button.rc-composer-add")),
          mode: measureControl(toolbar.querySelector<HTMLElement>('button[aria-label^="Agent mode and skills"]')),
          access: measureControl(toolbar.querySelector<HTMLElement>("button[data-access-mode]")),
          model: measureControl(modelBtn),
          stop: measureControl(toolbar.querySelector<HTMLElement>("button.rc-composer-stop")),
          cancel: measureControl(cancelBtn),
          confirm: measureControl(confirmBtn),
        };

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvasLogicalW = canvas.width / dpr;
        const expectedLogicalW = Math.max(280, Math.round(compR.width + 40));

        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          toolbarBg: toolbarStyle.backgroundColor,
          toolbarBorderTop: toolbarStyle.borderTopWidth,
          toolbarRowSpread: round2(toolbarRowSpread),
          modelVisualWidth: round2(modelBtn.getBoundingClientRect().width),
          canvasLogicalW: round2(canvasLogicalW),
          expectedLogicalW,
          canvasDiff: round2(Math.abs(canvasLogicalW - expectedLogicalW)),
          auroraRunning: canvas.dataset.auroraRunning,
          ambientDisplay: ambient ? getComputedStyle(ambient).display : "none",
          cancelTouch: measureTouch(cancelBtn),
          confirmTouch: measureTouch(confirmBtn),
          controls,
        };
      });

      assert.equal(
        activeGeom.overflow,
        false,
        `${tag}: active voice horizontal overflow scrollWidth=${activeGeom.scrollWidth} > innerWidth=${activeGeom.innerWidth}`,
      );
      assert.equal(parseColorAlpha(activeGeom.toolbarBg), 0, `${tag}: active .rc-composer-toolbar must stay transparent (got ${activeGeom.toolbarBg})`);
      assert.equal(activeGeom.toolbarBorderTop, "0px", `${tag}: active .rc-composer-toolbar must have no border-top (got ${activeGeom.toolbarBorderTop})`);
      assert(activeGeom.toolbarRowSpread <= 2, `${tag}: active voice toolbar wrapped (spread=${activeGeom.toolbarRowSpread}px)`);
      assert(
        activeGeom.modelVisualWidth >= 80,
        `${tag}: active voice button.rc-composer-model visual width ${activeGeom.modelVisualWidth}px < 80px`,
      );

      // Verify frosted glass backing (dark/light) or opaque surface (high-contrast) + 0px layout jitter vs idle
      for (const name of ["add", "mode", "access", "model", "stop"] as const) {
        const before = idleGeom.controls[name]!;
        const after = activeGeom.controls[name];
        assert(after, `${tag}: active toolbar control "${name}" missing`);
        const dw = Math.abs(after.width - before.width);
        const dh = Math.abs(after.height - before.height);
        assert(
          dw <= 0.05 && dh <= 0.05,
          `${tag}: "${name}" layout jitter on voice toggle: idle=${before.width}x${before.height} vs active=${after.width}x${after.height}`,
        );
        const alpha = parseColorAlpha(after.bg);
        if (theme === "high-contrast") {
          assert.equal(alpha, 1, `${tag}: high-contrast active "${name}" must have opaque surface (got ${after.bg})`);
          assert.equal(after.backdrop, "none", `${tag}: high-contrast active "${name}" must have backdrop-filter: none (got ${after.backdrop})`);
        } else {
          assert(
            alpha >= 0.5 && alpha < 0.99,
            `${tag}: ${theme} active "${name}" must have translucent frosted background (alpha=${alpha}, bg=${after.bg})`,
          );
          assert(
            after.backdrop.includes("blur("),
            `${tag}: ${theme} active "${name}" must have backdrop-filter blur(...) (got ${after.backdrop})`,
          );
        }
        if (name !== "stop") {
          assert(
            after.boxShadow.includes("inset"),
            `${tag}: active "${name}" must draw hairline via inset box-shadow (got ${after.boxShadow})`,
          );
        }
      }
      for (const name of ["cancel", "confirm"] as const) {
        const ctrl = activeGeom.controls[name];
        assert(ctrl, `${tag}: active voice button "${name}" missing`);
        const alpha = parseColorAlpha(ctrl.bg);
        if (theme === "high-contrast") {
          assert.equal(alpha, 1, `${tag}: high-contrast "${name}" must have opaque surface (got ${ctrl.bg})`);
          assert.equal(ctrl.backdrop, "none", `${tag}: high-contrast "${name}" must have backdrop-filter: none (got ${ctrl.backdrop})`);
        } else {
          assert(alpha >= 0.5, `${tag}: ${theme} "${name}" must have non-transparent glass surface (alpha=${alpha}, bg=${ctrl.bg})`);
          assert(ctrl.backdrop.includes("blur("), `${tag}: ${theme} "${name}" must have backdrop-filter blur(...) (got ${ctrl.backdrop})`);
        }
      }

      assert(
        activeGeom.canvasDiff <= 1,
        `${tag}: ResizeObserver aurora canvas width mismatch (logical=${activeGeom.canvasLogicalW} vs expected=${activeGeom.expectedLogicalW})`,
      );
      assert.equal(activeGeom.auroraRunning, "true", `${tag}: aurora must run during active listening`);
      if (theme === "high-contrast") {
        assert.equal(activeGeom.ambientDisplay, "none", `${tag}: high-contrast must hide blurred .rc-voice-ambient`);
      }
      if (vp.hasTouch) {
        assert(
          activeGeom.cancelTouch && activeGeom.cancelTouch.hitW >= 44 && activeGeom.cancelTouch.hitH >= 44,
          `${tag}: .rc-composer-voice-cancel touch hit target < 44x44px (${JSON.stringify(activeGeom.cancelTouch)})`,
        );
        assert(
          activeGeom.confirmTouch && activeGeom.confirmTouch.hitW >= 44 && activeGeom.confirmTouch.hitH >= 44,
          `${tag}: .rc-composer-voice-confirm touch hit target < 44x44px (${JSON.stringify(activeGeom.confirmTouch)})`,
        );
      }

      // On desktop dark, also prove real IndirectCodePage.tsx Enter confirms without submitting draft
      if (vp.key === "1440x900" && theme === "dark") {
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
          { timeout: 5_000 },
        );
        await page.locator("#rc-composer").fill("SPA draft");
        spaPromptCommands = 0;
        await page.locator(".rc-composer-voice").click();
        await page.waitForFunction(
          () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "listening",
          { timeout: 5_000 },
        );
        await page.evaluate(() => (window as any).__voiceMock.emitSpeech(500, 0.25));
        await page.waitForTimeout(320);
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
          { timeout: 5_000 },
        );
        assert.equal(await page.locator("#rc-composer").inputValue(), "SPA draft dictated in production spa");
        assert.equal(spaPromptCommands, 0, "Production SPA Enter while listening must NOT send a WS prompt");
      } else {
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          () => document.querySelector(".rc-composer")?.getAttribute("data-voice-state") === "idle",
          { timeout: 5_000 },
        );
      }

      // Wait for glass fade-out transition to finish and verify toolbar controls return cleanly to transparent
      await page.waitForFunction(
        () => {
          const toolbar = document.querySelector<HTMLElement>(".rc-composer-toolbar");
          if (!toolbar) return false;
          const sels = [
            "button.rc-composer-add",
            'button[aria-label^="Agent mode and skills"]',
            "button[data-access-mode]",
            "button.rc-composer-model",
          ];
          return sels.every((sel) => {
            const el = toolbar.querySelector<HTMLElement>(sel);
            if (!el) return false;
            const cs = getComputedStyle(el);
            const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || "none";
            return cs.backgroundColor === "rgba(0, 0, 0, 0)" && bf === "none" && cs.boxShadow === "none";
          });
        },
        { timeout: 2_000 },
      );

      console.log(
        `[voice-ui] ${tag} PASSED: modelW=${activeGeom.modelVisualWidth}px seam=${idleGeom.seamDiff}px canvas=${activeGeom.canvasLogicalW}px glass=${theme === "high-contrast" ? "opaque" : "frosted"} jitter=0px overflow=0`,
      );
      await context.close();
    }
  }

  assert.deepEqual(spaErrors, [], `Phase 2 SPA errors: ${spaErrors.join(" | ")}`);
  console.log("PASS: Voice UI Phase 1 (focused flow + CSP/worklet) & Phase 2 (5 viewports × 3 themes on dist/ SPA) all passed with 0 errors.");
} finally {
  await browser.close();
  fixtureServer.stop(true);
  spaServer.stop(true);
}
process.exit(0);
