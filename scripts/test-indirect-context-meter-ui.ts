/**
 * Real Chromium visual, shader, motion, and responsive interaction E2E gate
 * for the Animated Context & Usable Auto-Compact Meter Popover (`ComposerFooter` + `ContextUsageMeter`).
 *
 * Verifies at 2x Retina (`deviceScaleFactor: 2`):
 *   1) Desktop `1440×900` (Dark & Light):
 *      - Opening incandescent frontier sweep (~200ms mid-sweep canvas pixel verification + count-up)
 *      - Settled diamond lattice (`(col + row) % 2 === 0`) + exact usable context math (`63.6K usable left`)
 *      - Hovering every bar segment (`Input`, `Cache`, `Output`, `Reasoning`) + `Usable` + `Reserve` zones
 *      - Zero vertical layout shift (`0.00px` height delta) across subtitle morphs
 *      - 2D `createGlide` spring pill physical translation across rows & columns
 *      - Replay scan trigger, Settings modal handoff (`FloatMenu` closes first), and `Escape` close
 *   2) Mobile `360×780` & `390×844` (`hasTouch: true, isMobile: true`, Dark & Light):
 *      - Zero horizontal overflow (`rect.left >= 4 && rect.right <= vw - 4`)
 *      - Touch tap to pin spotlight & second tap to unpin on both telemetry cells and `<canvas>` zones
 *      - Browser `goBack()` (`useBackNavigation` `"menu:usage"` layer) closes popover cleanly in 1 step
 *   3) Edge Cases:
 *      - `autoCompactPercent = 0` (Auto-compact Off)
 *      - `used > usableLimit` (Auto-compact armed warning state)
 *      - `window = 0` (Context limit not configured)
 *      - `!activeUsage()` (Empty session with no usage telemetry yet)
 *
 * Optional showcase export:
 *   SHOWCASE_OUT_DIR=/path/to/dir bun scripts/test-indirect-context-meter-ui.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, promises as fs, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIR = path.join(ROOT, "dist");
if (!existsSync(path.join(DIST_DIR, "index.html"))) {
  throw new Error("dist/index.html missing — run `bun run build:web` first.");
}

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
};

const HOST_ID = "host-ctx-meter";
const NOW = Date.now();

interface MockScenario {
  modelContext: number;
  autoCompactThreshold: number;
  configRevision: string;
  usedTokens: number | null;
  windowTokens: number;
  compactionCount: number;
  usage: {
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cost_usd: number;
    cost_input_usd: number;
    cost_cache_usd: number;
    cost_output_usd: number;
  } | null;
}

const DEFAULT_USAGE: NonNullable<MockScenario["usage"]> = {
  input_tokens: 28_400,
  cache_read_tokens: 46_000,
  cache_write_tokens: 6_000,
  output_tokens: 16_000,
  reasoning_tokens: 6_200,
  cost_usd: 0.42,
  cost_input_usd: 0.09,
  cost_cache_usd: 0.07,
  cost_output_usd: 0.26,
};

let scenario: MockScenario = {
  modelContext: 200_000,
  autoCompactThreshold: 80,
  configRevision: "rev-1",
  usedTokens: 96_400,
  windowTokens: 200_000,
  compactionCount: 2,
  usage: { ...DEFAULT_USAGE },
};

function resetScenario() {
  scenario = {
    modelContext: 200_000,
    autoCompactThreshold: 80,
    configRevision: `rev-${Date.now()}`,
    usedTokens: 96_400,
    windowTokens: 200_000,
    compactionCount: 2,
    usage: { ...DEFAULT_USAGE },
  };
}

function buildModels() {
  return [
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "Anthropic",
      upstreamModel: "claude-sonnet-4-6",
      context: scenario.modelContext,
      output: 65_536,
      owned_by: "anthropic",
      supported_efforts: ["low", "medium", "high", "max"],
      default_effort: "high",
    },
  ];
}

function buildConfigDoc() {
  return {
    id: "daemon",
    hostId: HOST_ID,
    revision: scenario.configRevision,
    name: "studio-workstation",
    lastSelection: {
      model: "claude-sonnet-4-6",
      effort: "high",
      mode: "agentic",
      access: "ask",
      skills: [{ name: "build" }],
    },
    settings: {
      mid_turn_send: "queue",
      auto_compact_threshold: scenario.autoCompactThreshold,
      no_auto_title: false,
      jail_by_default: false,
      insecure_tls: false,
    },
    skills: {
      build: {
        name: "build",
        description: "Full agentic software engineering & verification",
        mode: "agentic",
        usable: "always",
        approvalMode: "ask",
        builtin: true,
        enabled: true,
      },
    },
    skillErrors: {},
  };
}

function buildSessionRecord() {
  return {
    id: "s-main",
    hostId: HOST_ID,
    cwd: "/Users/italo/dev/indirect",
    title: "Context window telemetry & usable compaction meter",
    model: "claude-sonnet-4-6",
    status: "idle",
    pinned: true,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 30_000,
    approvalMode: "ask",
    options: {
      effort: "high",
      mode: "agentic",
      skills: [{ name: "build" }],
      access: "ask",
    },
    skills: {
      build: { priority: 0, active: true, usable: "inherit" },
    },
    turn: null,
    todos: [],
    todosOpen: false,
    question: null,
    pendingApproval: null,
    queue: [],
    bgTasks: [],
    attachments: [],
    context:
      scenario.usedTokens === null
        ? null
        : {
            usedTokens: scenario.usedTokens,
            windowTokens: scenario.windowTokens,
            model: "claude-sonnet-4-6",
            estimated: false,
          },
    usage: scenario.usage,
    compaction:
      scenario.compactionCount > 0
        ? {
            previousSummary: "Earlier architectural exploration folded into summary.",
            count: scenario.compactionCount,
            keepFrom: 1,
          }
        : null,
    fileBalloons: [],
    messages: [
      {
        id: "m-u-1",
        role: "user",
        turnIndex: 1,
        createdAt: NOW - 120_000,
        content: [
          {
            type: "text",
            text: "Inspect context token segments, cache hit efficiency, and usable headroom before auto-compaction.",
          },
        ],
      },
      {
        id: "m-a-1",
        role: "assistant",
        turnIndex: 2,
        createdAt: NOW - 95_000,
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "text",
            text: "Ready — open the Conversation context popover in the composer footer to inspect live segments and usable auto-compact headroom.",
          },
        ],
      },
    ],
  };
}

const activeSockets = new Set<any>();
function broadcastWS(payload: Record<string, unknown>) {
  const frame = JSON.stringify({ hostId: HOST_ID, ...payload });
  for (const ws of activeSockets) {
    try {
      ws.send(frame);
    } catch {}
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/api/indirect-code/ws") {
      return srv.upgrade(req) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (p === "/api/indirect-code/hosts") {
      return Response.json({
        success: true,
        hosts: [
          {
            id: HOST_ID,
            name: "studio-workstation",
            hostname: "workstation.local",
            os: "linux",
            arch: "amd64",
            version: "v0.9.5",
            status: "online",
            lastSeenAt: Date.now(),
          },
        ],
      });
    }
    if (p === "/api/me/models") return Response.json({ success: true, models: buildModels() });
    if (p === "/api/keys") return Response.json({ success: true, keys: [] });
    if (p === "/api/auth/refresh") {
      return Response.json({
        success: true,
        accessToken: "mock-token",
        refreshToken: "mock-refresh",
        user: {
          id: "u-1",
          email: "italo@indirect.dev",
          name: "Italo",
          role: "admin",
          hasPassword: true,
          googleLinked: false,
          totpEnabled: true,
          status: "active",
          createdAt: NOW - 86_400_000 * 30,
        },
      });
    }
    if (p.startsWith("/api/")) return Response.json({ success: true });

    const relPath = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    const diskPath = path.join(DIST_DIR, relPath);
    if (existsSync(diskPath)) {
      const ext = path.extname(diskPath).toLowerCase();
      return new Response(Bun.file(diskPath), {
        headers: { "Content-Type": MIME_MAP[ext] || "application/octet-stream" },
      });
    }
    return new Response(Bun.file(path.join(DIST_DIR, "index.html")), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
  websocket: {
    open(ws) {
      activeSockets.add(ws);
      ws.send(JSON.stringify({ type: "hello", hosts: [{ id: HOST_ID, status: "online" }] }));
    },
    close(ws) {
      activeSockets.delete(ws);
    },
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const hid = msg.hostId || HOST_ID;
      if (msg.type === "pull") {
        const items =
          msg.collection === "projects"
            ? [
                {
                  id: "proj-indirect",
                  name: "indirect",
                  path: "/Users/italo/dev/indirect",
                  createdAt: NOW - 86_400_000 * 10,
                  protected: false,
                  collapsed: false,
                  folderStatus: "available",
                },
              ]
            : msg.collection === "sessions"
              ? [
                  {
                    id: "s-main",
                    hostId: HOST_ID,
                    cwd: "/Users/italo/dev/indirect",
                    title: "Context window telemetry & usable compaction meter",
                    model: "claude-sonnet-4-6",
                    status: "idle",
                    pinned: true,
                    createdAt: NOW - 3_600_000,
                    updatedAt: NOW - 30_000,
                    lastTurnEndedAt: NOW - 30_000,
                    todosOpen: false,
                    approvalMode: "ask",
                    options: {
                      effort: "high",
                      mode: "agentic",
                      skills: [{ name: "build" }],
                      access: "ask",
                    },
                  },
                ]
              : msg.collection === "config"
                ? [buildConfigDoc()]
                : [];
        ws.send(
          JSON.stringify({
            type: "pull-response",
            id: msg.id,
            hostId: hid,
            collection: msg.collection,
            items,
          }),
        );
        return;
      }
      if (msg.type === "get_session") {
        ws.send(
          JSON.stringify({
            type: "session_data",
            hostId: hid,
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            session: buildSessionRecord(),
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
            workspace: { status: "available", path: "/Users/italo/dev/indirect" },
          }),
        );
        return;
      }
      if (msg.type === "daemon_update_check") {
        ws.send(
          JSON.stringify({
            type: "daemon_update",
            hostId: hid,
            current: "v0.9.5",
            available: "v0.9.5",
            checkedAt: Date.now(),
            autoUpdate: true,
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

interface ViewportSpec {
  key: string;
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
  ua: string;
}

async function createAuthedContext(
  browser: any,
  vp: ViewportSpec,
  theme: "dark" | "light",
) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    userAgent: vp.ua,
    colorScheme: theme,
  });
  await context.addInitScript(
    ({ hostId, themeMode }) => {
      localStorage.setItem(
        "cache_code_session",
        JSON.stringify({
          accessToken: "mock-token",
          refreshToken: "mock-refresh",
          user: {
            id: "u-1",
            email: "italo@indirect.dev",
            name: "Italo",
            role: "admin",
            hasPassword: true,
            googleLinked: false,
            totpEnabled: true,
            status: "active",
            createdAt: Date.now() - 86_400_000 * 30,
          },
        }),
      );
      localStorage.setItem("llmgw-theme", themeMode);
      localStorage.setItem("llmgw-rc-active-host", hostId);
      localStorage.setItem(`llmgw-rc-session:${hostId}`, "s-main");
    },
    { hostId: HOST_ID, themeMode: theme },
  );
  return context;
}

async function inspectCanvasSweep(page: any) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-context-bar] canvas");
    const sub = document.querySelector<HTMLElement>("[data-context-subtitle]");
    const fig = document.querySelector<HTMLElement>("[data-context-primary-figure]");
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const w = canvas.width;
    const h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;

    // Occupied span is 0..0.482 of width; compare early-occupied [0.03..0.22] vs tail-occupied [0.36..0.46]
    let earlyBright = 0;
    let tailBright = 0;
    let hotPeakPixels = 0;

    for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.8); y++) {
      for (let x = Math.floor(w * 0.02); x < Math.floor(w * 0.47); x++) {
        const idx = (y * w + x) * 4;
        const r = data[idx]!;
        const g = data[idx + 1]!;
        const b = data[idx + 2]!;
        const a = data[idx + 3]!;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const isLit = a > 65 && chroma > 26;
        if (isLit) {
          if (x < w * 0.24) earlyBright++;
          if (x >= w * 0.36 && x <= w * 0.465) tailBright++;
        }
        if (lum > 205 && a > 120) hotPeakPixels++;
      }
    }
    return {
      w,
      h,
      earlyBright,
      tailBright,
      hotPeakPixels,
      subState: sub?.getAttribute("data-subtitle-state") || "",
      figText: fig?.textContent?.trim() || "",
    };
  });
}

async function inspectCanvasBorders(page: any) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-context-bar] canvas");
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const w = canvas.width;
    const h = canvas.height;
    const d = ctx.getImageData(0, 0, w, h).data;

    const px = (x: number, y: number) => {
      const cx = Math.max(0, Math.min(w - 1, Math.round(x)));
      const cy = Math.max(0, Math.min(h - 1, Math.round(y)));
      const i = (cy * w + cx) * 4;
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      const a = d[i + 3]!;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return { r, g, b, a, chroma, lum };
    };

    const midY = Math.floor(h / 2);

    // Outer 1px track border at physical x=1 vs x=w-2
    const leftOuter = px(1, midY);
    const rightOuter = px(w - 2, midY);

    // Recessed moat at physical x=3 vs x=w-4 (between outer border [0..2) and inner capsule [5..8))
    const leftMoat = px(3, midY);
    const rightMoat = px(w - 4, midY);

    // Peak chroma on leftmost capsule vertical border (physical x in [4..9])
    let leftCapMaxChroma = 0;
    let leftCapPeakX = 5;
    for (let x = 4; x <= 9; x++) {
      const c = px(x, midY).chroma;
      if (c > leftCapMaxChroma) {
        leftCapMaxChroma = c;
        leftCapPeakX = x;
      }
    }

    // Peak chroma on rightmost capsule vertical border (physical x in [w-10..w-5])
    let rightCapMaxChroma = 0;
    let rightCapPeakDist = 5;
    for (let dist = 4; dist <= 9; dist++) {
      const c = px(w - 1 - dist, midY).chroma;
      if (c > rightCapMaxChroma) {
        rightCapMaxChroma = c;
        rightCapPeakDist = dist;
      }
    }

    // Top-left & bottom-left curved arc check along concentric center (20, 20) at 45 deg
    // Center is (10*dpr, 10*dpr) = (20, 20), radius ~ 6.75*dpr = 13.5 -> 20 - 13.5*0.7071 ≈ 10.45
    let leftCornerChroma = 0;
    let rightCornerChroma = 0;
    for (const off of [9, 10, 11]) {
      leftCornerChroma = Math.max(leftCornerChroma, px(off, off).chroma, px(off, h - 1 - off).chroma);
      rightCornerChroma = Math.max(
        rightCornerChroma,
        px(w - 1 - off, off).chroma,
        px(w - 1 - off, h - 1 - off).chroma,
      );
    }

    // Rightmost occupied segment border around 48% width (physical x in [0.465*w .. 0.50*w])
    let occupiedRightWallChroma = 0;
    for (let x = Math.floor(w * 0.465); x <= Math.ceil(w * 0.5); x++) {
      occupiedRightWallChroma = Math.max(occupiedRightWallChroma, px(x, midY).chroma);
    }

    return {
      w,
      h,
      leftOuterLum: leftOuter.lum,
      rightOuterLum: rightOuter.lum,
      leftMoatChroma: leftMoat.chroma,
      rightMoatChroma: rightMoat.chroma,
      leftCapMaxChroma,
      leftCapPeakX,
      rightCapMaxChroma,
      rightCapPeakDist,
      leftCornerChroma,
      rightCornerChroma,
      occupiedRightWallChroma,
    };
  });
}

async function capturePopoverBase64(page: any, pad = 16): Promise<string> {
  const pop = page.locator("[data-floatmenu]").last();
  const box = await pop.boundingBox();
  assert(box, "expected visible [data-floatmenu] for screenshot crop");
  const vp = page.viewportSize()!;
  const clip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.min(vp.width - Math.max(0, Math.floor(box.x - pad)), Math.ceil(box.width + pad * 2)),
    height: Math.min(vp.height - Math.max(0, Math.floor(box.y - pad)), Math.ceil(box.height + pad * 2)),
  };
  const buf = await page.screenshot({ clip, type: "png" });
  return buf.toString("base64");
}

async function renderCompositeSheet(
  browser: any,
  title: string,
  subtitle: string,
  panels: Array<{ label: string; sub: string; base64: string }>,
  cols: number,
  bgTheme: "dark" | "light" = "dark",
): Promise<Buffer> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    const outB64 = await page.evaluate(
      async ({ sheetTitle, sheetSub, items, columnCount, mode }) => {
        const loadImg = (b64: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = `data:image/png;base64,${b64}`;
          });
        const imgs = await Promise.all(items.map((it) => loadImg(it.base64)));

        const pad = 44;
        const gapX = 32;
        const gapY = 32;
        const headerH = 108;
        const captionH = 56;

        const maxCardW = Math.max(...imgs.map((im) => im.width));
        const rows = Math.ceil(imgs.length / columnCount);
        const rowHeights: number[] = [];
        for (let r = 0; r < rows; r++) {
          let mh = 0;
          for (let c = 0; c < columnCount; c++) {
            const idx = r * columnCount + c;
            if (imgs[idx]) mh = Math.max(mh, imgs[idx]!.height);
          }
          rowHeights.push(mh);
        }

        const totalW = pad * 2 + columnCount * maxCardW + (columnCount - 1) * gapX;
        const totalH =
          pad +
          headerH +
          rowHeights.reduce((a, b) => a + b + captionH, 0) +
          (rows - 1) * gapY +
          pad;

        const canvas = document.createElement("canvas");
        canvas.width = totalW;
        canvas.height = totalH;
        const c2d = canvas.getContext("2d")!;

        const isDark = mode === "dark";
        c2d.fillStyle = isDark ? "rgb(17, 18, 21)" : "rgb(244, 245, 248)";
        c2d.fillRect(0, 0, totalW, totalH);

        c2d.fillStyle = isDark ? "rgb(244, 245, 247)" : "rgb(22, 24, 29)";
        c2d.font = "500 30px system-ui, -apple-system, sans-serif";
        c2d.fillText(sheetTitle, pad, pad + 34);

        c2d.fillStyle = isDark ? "rgb(154, 161, 172)" : "rgb(98, 104, 116)";
        c2d.font = "400 18px ui-monospace, SFMono-Regular, Menlo, monospace";
        c2d.fillText(sheetSub, pad, pad + 68);

        let curY = pad + headerH;
        for (let r = 0; r < rows; r++) {
          const rh = rowHeights[r]!;
          for (let c = 0; c < columnCount; c++) {
            const idx = r * columnCount + c;
            const im = imgs[idx];
            const meta = items[idx];
            if (!im || !meta) continue;
            const cellX = pad + c * (maxCardW + gapX);

            c2d.fillStyle = isDark ? "rgb(28, 30, 35)" : "rgb(255, 255, 255)";
            c2d.strokeStyle = isDark ? "rgb(48, 52, 60)" : "rgb(222, 225, 232)";
            c2d.lineWidth = 2;
            c2d.beginPath();
            c2d.roundRect(cellX, curY, maxCardW, captionH + rh + 16, 20);
            c2d.fill();
            c2d.stroke();

            c2d.fillStyle = isDark ? "rgb(236, 239, 244)" : "rgb(24, 26, 32)";
            c2d.font = "500 20px system-ui, -apple-system, sans-serif";
            c2d.fillText(meta.label, cellX + 20, curY + 28);

            c2d.fillStyle = isDark ? "rgb(142, 150, 162)" : "rgb(108, 114, 126)";
            c2d.font = "400 15px ui-monospace, SFMono-Regular, Menlo, monospace";
            c2d.fillText(meta.sub, cellX + 20, curY + 49);

            const drawX = cellX + Math.round((maxCardW - im.width) / 2);
            const drawY = curY + captionH + 8 + Math.round((rh - im.height) / 2);
            c2d.drawImage(im, drawX, drawY);
          }
          curY += captionH + rh + 16 + gapY;
        }

        return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
      },
      {
        sheetTitle: title,
        sheetSub: subtitle,
        items: panels,
        columnCount: cols,
        mode: bgTheme,
      },
    );
    return Buffer.from(outB64, "base64");
  } finally {
    await ctx.close();
  }
}

const showcaseDir = process.env.SHOWCASE_OUT_DIR?.trim() || "";
const { chromium } = await loadPlaywright();
const executablePath = await resolveChrome();
const browser = await chromium.launch({ executablePath, headless: true });

const pageErrors: string[] = [];

// Captured base64 crops for optional 2x Retina showcase sheets
const captures: Record<string, string> = {};

try {
  // ===========================================================================
  // 1. DESKTOP 1440×900 — DARK & LIGHT THEMES
  // ===========================================================================
  for (const theme of ["dark", "light"] as const) {
    console.log(`[context-meter-ui] Desktop 1440x900 (${theme}): sweep, settled, hover spotlights, glide, Escape...`);
    resetScenario();
    const context = await createAuthedContext(
      browser,
      { key: "1440x900", width: 1440, height: 900, isMobile: false, hasTouch: false, ua: DESKTOP_UA },
      theme,
    );
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => pageErrors.push(`desktop-${theme}: ${e.message}`));

    await page.goto(`${server.url}#/code`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-composer-footer] [data-menubtn]", { timeout: 15_000 });
    await page.waitForTimeout(250);

    const trigger = page.locator("[data-composer-footer] [data-menubtn]").first();
    await assert.doesNotReject(async () => {
      const txt = await trigger.textContent();
      assert(txt?.includes("96.4K (48%)"), `expected trigger label '96.4K (48%)', got '${txt}'`);
    });

    // Move cursor away from popover region before clicking so mid-sweep is unhovered
    await trigger.click();
    await page.waitForSelector("[data-context-meter]", { timeout: 5_000 });
    await page.waitForTimeout(160);

    const midSweepCanvas = await inspectCanvasSweep(page);
    assert(
      midSweepCanvas && midSweepCanvas.earlyBright > 40,
      `${theme}: expected active canvas pixels during mid-sweep, got ${JSON.stringify(midSweepCanvas)}`,
    );
    assert.equal(
      midSweepCanvas.subState,
      "sweep",
      `${theme}: expected 'sweep' subtitle state during opening scan, got '${midSweepCanvas.subState}'`,
    );
    assert.notEqual(
      midSweepCanvas.figText,
      "96.4K",
      `${theme}: expected primary figure counting up during mid-sweep, got '${midSweepCanvas.figText}'`,
    );
    captures[`desktop_${theme}_midsweep`] = await capturePopoverBase64(page);

    // Wait for 780ms sweep to settle completely
    await page.waitForTimeout(820);

    const settledCanvas = await inspectCanvasSweep(page);
    assert(
      settledCanvas && settledCanvas.tailBright > midSweepCanvas.tailBright,
      `${theme}: expected tail occupied pixels to fill in after sweep settles (${midSweepCanvas.tailBright} -> ${settledCanvas?.tailBright})`,
    );

    const settledCheck = await page.evaluate(() => {
      const pop = document.querySelector<HTMLElement>("[data-floatmenu]")!;
      const meter = document.querySelector<HTMLElement>("[data-context-meter]")!;
      const bar = document.querySelector<HTMLElement>("[data-context-bar]")!;
      const sub = document.querySelector<HTMLElement>("[data-context-subtitle]")!;
      const fig = document.querySelector<HTMLElement>("[data-context-primary-figure]")!;
      const pctHero = document.querySelector<HTMLElement>("[data-context-pct-hero]")!;
      const pr = pop.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      const sr = sub.getBoundingClientRect();
      const fr = fig.getBoundingClientRect();
      const pcr = pctHero.getBoundingClientRect();
      return {
        popW: pr.width,
        popH: pr.height,
        leftInset: br.left - pr.left,
        rightInset: pr.right - br.right,
        subH: sr.height,
        subState: sub.getAttribute("data-subtitle-state"),
        subText: sub.textContent?.trim() || "",
        figText: fig.textContent?.trim() || "",
        pctHeroText: pctHero.textContent?.trim() || "",
        pctHeroFontPx: parseFloat(getComputedStyle(pctHero).fontSize || "0"),
        pctGapFromTokens: pcr.left - fr.right,
        pctBaselineDelta: Math.abs(pcr.bottom - fr.bottom),
        meterText: meter.textContent || "",
        vwOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });

    assert.equal(settledCheck.figText, "96.4K", `${theme}: settled primary figure must equal '96.4K'`);
    assert.equal(settledCheck.pctHeroText, "48% full", `${theme}: hero pct label must equal '48% full'`);
    assert(
      settledCheck.pctHeroFontPx >= 14,
      `${theme}: expected hero '% full' fontSize >= 14px beside primary figure, got ${settledCheck.pctHeroFontPx}`,
    );
    assert(
      settledCheck.pctGapFromTokens > 0 && settledCheck.pctGapFromTokens <= 16 && settledCheck.pctBaselineDelta <= 6,
      `${theme}: expected '% full' horizontally adjacent on primary figure baseline, got gap=${settledCheck.pctGapFromTokens} baselineDelta=${settledCheck.pctBaselineDelta}`,
    );
    assert(settledCheck.meterText.includes("160K usable"), `${theme}: expected '160K usable' indicator`);
    assert.equal(settledCheck.subState, "idle:usable", `${theme}: expected idle:usable subtitle state`);
    assert(
      settledCheck.subText.includes("63.6K usable left") && settledCheck.subText.includes("60% of 160K (80% auto)"),
      `${theme}: unexpected settled subtitle '${settledCheck.subText}'`,
    );
    assert(
      Math.abs(settledCheck.leftInset - settledCheck.rightInset) <= 1,
      `${theme}: asymmetric bar insets ${settledCheck.leftInset} vs ${settledCheck.rightInset}`,
    );
    assert.equal(settledCheck.subH, 18, `${theme}: subtitle slot must stay fixed at 18px`);
    assert(settledCheck.vwOverflow <= 0, `${theme}: unexpected horizontal overflow ${settledCheck.vwOverflow}`);

    // Verify 4-sided concentric colored capsule borders + outer track symmetry on settled canvas
    const settledBorders = await inspectCanvasBorders(page);
    assert(settledBorders, `${theme}: expected canvas border pixel sample`);
    assert(
      Math.abs(settledBorders.leftOuterLum - settledBorders.rightOuterLum) <= 8,
      `${theme}: outer 1px track border luminance must match left vs right (${settledBorders.leftOuterLum} vs ${settledBorders.rightOuterLum})`,
    );
    assert(
      settledBorders.leftCapMaxChroma >= 38 && settledBorders.leftCornerChroma >= 26,
      `${theme}: leftmost Input segment must have unclipped curved colored border (wallChroma=${settledBorders.leftCapMaxChroma}, cornerChroma=${settledBorders.leftCornerChroma})`,
    );
    assert(
      settledBorders.leftMoatChroma < 18 && settledBorders.rightMoatChroma < 18,
      `${theme}: recessed moat between outer track and inner capsules must stay un-bled (${settledBorders.leftMoatChroma}, ${settledBorders.rightMoatChroma})`,
    );
    assert(
      settledBorders.occupiedRightWallChroma >= 35,
      `${theme}: rightmost occupied Reasoning segment must have complete right colored border (chroma=${settledBorders.occupiedRightWallChroma})`,
    );
    assert(
      settledBorders.rightCapMaxChroma >= 12 && settledBorders.rightCornerChroma >= 10,
      `${theme}: rightmost Auto-compact buffer capsule must have continuous curved right border at rest (${settledBorders.rightCapMaxChroma}, corner=${settledBorders.rightCornerChroma})`,
    );

    captures[`desktop_${theme}_settled`] = await capturePopoverBase64(page);

    // Hover across bar segments (Input -> Cache -> Output -> Reasoning) + Usable + Reserve
    const barBox = await page.locator("[data-context-bar]").boundingBox();
    assert(barBox, "expected [data-context-bar] bounding box");
    const cy = barBox.y + barBox.height / 2;

    // Occupied = 48.2% of innerW (~162px):
    // Input (28.4K / 96.2K = 29.5% -> ~0..48px), Cache (52K -> ~48..136px), Output net (9.8K -> ~136..152px), Reasoning (6.2K -> ~152..164px)
    // Usable (~164..270px), Reserve (~270..336px)
    const hoverPoints: Array<{ xRatio: number; expectedState: string; expectedText: string }> = [
      { xRatio: 0.06, expectedState: "zone:input", expectedText: "Uncached prompt" },
      { xRatio: 0.25, expectedState: "zone:cache", expectedText: "65% hit rate" },
      { xRatio: 0.42, expectedState: "zone:output", expectedText: "9.80K completion" },
      { xRatio: 0.47, expectedState: "zone:reasoning", expectedText: "Thinking tokens" },
      { xRatio: 0.64, expectedState: "zone:usable", expectedText: "40% left before 80% limit" },
      { xRatio: 0.9, expectedState: "zone:reserve", expectedText: "Reserved above 80%" },
    ];

    const glidePositions: Array<{ zone: string; x: number; y: number; opacity: number }> = [];

    for (const pt of hoverPoints) {
      await page.mouse.move(barBox.x + barBox.width * pt.xRatio, cy);
      await page.waitForTimeout(190);
      const stateSnap = await page.evaluate(() => {
        const pop = document.querySelector<HTMLElement>("[data-floatmenu]")!;
        const sub = document.querySelector<HTMLElement>("[data-context-subtitle]")!;
        const truncEl = sub.querySelector<HTMLElement>(".truncate");
        const glide = document.querySelector<HTMLElement>("[data-telemetry-glide]")!;
        const gr = glide.getBoundingClientRect();
        return {
          popH: pop.getBoundingClientRect().height,
          subH: sub.getBoundingClientRect().height,
          subState: sub.getAttribute("data-subtitle-state"),
          subText: sub.textContent?.trim() || "",
          subTruncated: truncEl ? truncEl.scrollWidth > truncEl.clientWidth + 1 : false,
          glideX: gr.left,
          glideY: gr.top,
          glideOpacity: parseFloat(getComputedStyle(glide).opacity || "0"),
        };
      });
      assert.equal(
        stateSnap.subState,
        pt.expectedState,
        `${theme}: hovering xRatio=${pt.xRatio} expected ${pt.expectedState}, got ${stateSnap.subState} ('${stateSnap.subText}')`,
      );
      assert(
        stateSnap.subText.includes(pt.expectedText),
        `${theme}: expected '${pt.expectedText}' in '${stateSnap.subText}'`,
      );
      assert.equal(
        stateSnap.subTruncated,
        false,
        `${theme}: subtitle must not truncate with '...' during ${pt.expectedState} ('${stateSnap.subText}')`,
      );
      assert.equal(stateSnap.subH, 18, `${theme}: zero vertical shift on subtitle during ${pt.expectedState}`);
      assert(
        Math.abs(stateSnap.popH - settledCheck.popH) < 0.5,
        `${theme}: popover height shifted during ${pt.expectedState} (${settledCheck.popH} -> ${stateSnap.popH})`,
      );
      assert(
        stateSnap.glideOpacity > 0.75,
        `${theme}: expected gliding pill visible (opacity > 0.75) during ${pt.expectedState}, got ${stateSnap.glideOpacity}`,
      );
      glidePositions.push({
        zone: pt.expectedState,
        x: stateSnap.glideX,
        y: stateSnap.glideY,
        opacity: stateSnap.glideOpacity,
      });

      if (pt.expectedState === "zone:cache") {
        captures[`desktop_${theme}_spot_cache`] = await capturePopoverBase64(page);
      } else if (pt.expectedState === "zone:usable") {
        captures[`desktop_${theme}_spot_usable`] = await capturePopoverBase64(page);
      } else if (pt.expectedState === "zone:reserve") {
        const reserveBorders = await inspectCanvasBorders(page);
        assert(
          reserveBorders && reserveBorders.rightCapMaxChroma >= 42 && reserveBorders.rightCornerChroma >= 28,
          `${theme}: spotlighted Auto-compact buffer must have luminous unclipped curved right border (${JSON.stringify(reserveBorders)})`,
        );
        captures[`desktop_${theme}_spot_reserve`] = await capturePopoverBase64(page);
      }
    }

    // Verify 2D glide moved across BOTH columns (X) and rows (Y)
    const xs = glidePositions.map((p) => p.x);
    const ys = glidePositions.map((p) => p.y);
    assert(Math.max(...xs) - Math.min(...xs) > 100, `${theme}: expected 2D glide horizontal span > 100px`);
    assert(Math.max(...ys) - Math.min(...ys) > 50, `${theme}: expected 2D glide vertical span > 50px across rows`);

    // Move mouse away -> resets to idle:usable
    await page.mouse.move(20, 20);
    await page.waitForTimeout(160);
    assert.equal(
      await page.locator("[data-context-subtitle]").getAttribute("data-subtitle-state"),
      "idle:usable",
      `${theme}: pointer leave should restore idle:usable`,
    );

    // Replay scan button restarts sweep
    await page.locator("[data-context-rescan]").click();
    await page.waitForTimeout(120);
    assert.equal(
      await page.locator("[data-context-subtitle]").getAttribute("data-subtitle-state"),
      "sweep",
      `${theme}: clicking replay button should trigger sweep state`,
    );

    // Escape closes FloatMenu cleanly and restores focus to trigger
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    assert.equal(await page.locator("[data-floatmenu]").count(), 0, `${theme}: Escape must close popover`);

    // Re-open and test Settings handoff (`Auto 80%` closes FloatMenu FIRST, then opens Settings modal)
    await trigger.click();
    await page.waitForSelector("[data-context-configure]", { timeout: 5_000 });
    await page.locator("[data-context-configure]").click();
    await page.waitForTimeout(200);
    assert.equal(
      await page.locator("[data-floatmenu]").count(),
      0,
      `${theme}: clicking Configure must close FloatMenu before opening SettingsModal`,
    );
    assert(
      await page.getByText("Runtime & messaging").isVisible(),
      `${theme}: clicking Configure must open SettingsModal to Runtime & messaging`,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    await context.close();
  }

  // ===========================================================================
  // 2. MOBILE 360×780 & 390×844 — TOUCH SPOTLIGHT & BACK-NAVIGATION
  // ===========================================================================
  const mobileSpecs: ViewportSpec[] = [
    { key: "360x780", width: 360, height: 780, isMobile: true, hasTouch: true, ua: IPHONE_UA },
    { key: "390x844", width: 390, height: 844, isMobile: true, hasTouch: true, ua: IPHONE_UA },
  ];

  for (const vp of mobileSpecs) {
    for (const theme of ["dark", "light"] as const) {
      console.log(`[context-meter-ui] Mobile ${vp.key} (${theme}): viewport bounds, touch spotlight toggle, goBack()...`);
      resetScenario();
      const context = await createAuthedContext(browser, vp, theme);
      const page = await context.newPage();
      page.on("pageerror", (e: Error) => pageErrors.push(`mobile-${vp.key}-${theme}: ${e.message}`));

      await page.goto(`${server.url}#/code`, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-composer-footer] [data-menubtn]", { timeout: 15_000 });
      await page.waitForTimeout(250);

      const triggerBox = await page.locator("[data-composer-footer] [data-menubtn]").first().boundingBox();
      assert(triggerBox, "expected mobile context trigger box");
      await page.touchscreen.tap(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
      await page.waitForSelector("[data-context-meter]", { timeout: 5_000 });
      await page.waitForTimeout(880);

      const bounds = await page.evaluate(() => {
        const pop = document.querySelector<HTMLElement>("[data-floatmenu]")!;
        const r = pop.getBoundingClientRect();
        const truncatedCells = [...pop.querySelectorAll<HTMLElement>("[data-telemetry-cell] span")].filter(
          (el) => el.scrollWidth > el.clientWidth + 2,
        ).length;
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
          vw: window.innerWidth,
          vh: window.innerHeight,
          docScrollW: document.documentElement.scrollWidth,
          truncatedCells,
        };
      });

      assert(
        bounds.left >= 4 && bounds.right <= bounds.vw - 4,
        `mobile ${vp.key} ${theme}: popover overflowed horizontal bounds (${bounds.left}..${bounds.right} in ${bounds.vw}px)`,
      );
      assert(bounds.docScrollW <= bounds.vw, `mobile ${vp.key} ${theme}: document horizontal scroll overflow`);
      assert.equal(bounds.truncatedCells, 0, `mobile ${vp.key} ${theme}: telemetry cell text truncated awkwardly`);

      captures[`mobile_${vp.key}_${theme}_settled`] = await capturePopoverBase64(page, 8);

      // Tap Cache cell once -> pins spotlight; tap same cell again -> unpins!
      const cacheCell = page.locator('[data-telemetry-cell="cache"]');
      const cBox = await cacheCell.boundingBox();
      assert(cBox, "expected cache telemetry cell box");
      await page.touchscreen.tap(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2);
      await page.waitForTimeout(200);
      assert.equal(await cacheCell.getAttribute("aria-pressed"), "true", `mobile ${vp.key}: 1st tap should pin cache`);
      assert.equal(
        await page.locator("[data-context-subtitle]").getAttribute("data-subtitle-state"),
        "zone:cache",
        `mobile ${vp.key}: 1st tap should morph subtitle to zone:cache`,
      );

      captures[`mobile_${vp.key}_${theme}_touch_spot`] = await capturePopoverBase64(page, 8);

      await page.touchscreen.tap(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2);
      await page.waitForTimeout(200);
      assert.equal(await cacheCell.getAttribute("aria-pressed"), "false", `mobile ${vp.key}: 2nd tap should unpin cache`);
      assert.equal(
        await page.locator("[data-context-subtitle]").getAttribute("data-subtitle-state"),
        "idle:usable",
        `mobile ${vp.key}: 2nd tap should restore idle:usable`,
      );

      // Tap directly on Reserve zone of `<canvas>` bar via touch
      const bBox = await page.locator("[data-context-bar]").boundingBox();
      assert(bBox, "expected mobile bar box");
      await page.touchscreen.tap(bBox.x + bBox.width * 0.9, bBox.y + bBox.height / 2);
      await page.waitForTimeout(180);
      assert.equal(
        await page.locator("[data-context-subtitle]").getAttribute("data-subtitle-state"),
        "zone:reserve",
        `mobile ${vp.key}: tapping reserve zone on bar should pin zone:reserve`,
      );

      // Browser Back (`useBackNavigation` "menu:usage" layer) closes popover in 1 step!
      await page.goBack();
      await page.waitForTimeout(220);
      assert.equal(
        await page.locator("[data-floatmenu]").count(),
        0,
        `mobile ${vp.key} ${theme}: browser goBack() must close usageOpen in 1 step`,
      );
      assert(
        await page.locator("[data-composer-footer]").isVisible(),
        `mobile ${vp.key} ${theme}: conversation composer remains active after closing usageOpen`,
      );

      await context.close();
    }
  }

  // ===========================================================================
  // 3. EDGE CASES: AUTO-COMPACT OFF (0), ARMED (>80%), WINDOW=0, NO USAGE YET
  // ===========================================================================
  console.log("[context-meter-ui] Edge cases: autoCompact=0 (Off), armed (>usableLimit), window=0, and !activeUsage()...");
  {
    resetScenario();
    const context = await createAuthedContext(
      browser,
      { key: "390x844", width: 390, height: 844, isMobile: true, hasTouch: true, ua: IPHONE_UA },
      "dark",
    );
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => pageErrors.push(`edge-cases: ${e.message}`));

    await page.goto(`${server.url}#/code`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-composer-footer] [data-menubtn]", { timeout: 15_000 });
    await page.waitForTimeout(250);

    const openPopover = async () => {
      const btn = page.locator("[data-composer-footer] [data-menubtn]").first();
      const box = await btn.boundingBox();
      assert(box);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector("[data-context-meter]", { timeout: 5_000 });
      await page.waitForTimeout(880);
    };

    // Edge Case A: Armed state (used 172.4K > 160K usable limit at 80%)
    scenario.usedTokens = 172_400;
    scenario.compactionCount = 0;
    broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
    await page.waitForTimeout(200);
    await openPopover();

    const armedSnap = await page.evaluate(() => ({
      subState: document.querySelector("[data-context-subtitle]")?.getAttribute("data-subtitle-state"),
      subText: document.querySelector("[data-context-subtitle]")?.textContent?.trim() || "",
      usableCell: document.querySelector('[data-telemetry-cell="usable"]')?.textContent?.trim() || "",
      footerText: document.querySelector("[data-context-footer-strip]")?.textContent?.trim() || "",
    }));
    assert.equal(armedSnap.subState, "idle:armed");
    assert(armedSnap.subText.includes("Auto-compact armed") && armedSnap.subText.includes("+12.4K over 160K"));
    assert(armedSnap.usableCell.includes("Armed"));
    assert(armedSnap.footerText.includes("Compacts next step"));

    captures.mobile_390x844_dark_armed = await capturePopoverBase64(page, 8);
    await page.goBack();
    await page.waitForTimeout(180);

    // Edge Case A2: 100% Full (`200K of 200K`) — symmetric left & right curved colored capsule borders
    scenario.usedTokens = 200_000;
    broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
    await page.waitForTimeout(200);
    await openPopover();

    const fullSnap = await page.evaluate(() => ({
      figText: document.querySelector("[data-context-primary-figure]")?.textContent?.trim() || "",
      pctText: document.querySelector("[data-context-pct-hero]")?.textContent?.trim() || "",
    }));
    assert.equal(fullSnap.figText, "200K");
    assert.equal(fullSnap.pctText, "100% full");

    const fullBorders = await inspectCanvasBorders(page);
    assert(fullBorders, "expected 100% full canvas border inspection");
    assert(
      fullBorders.leftCapMaxChroma >= 40 &&
        fullBorders.rightCapMaxChroma >= 40 &&
        fullBorders.leftCornerChroma >= 28 &&
        fullBorders.rightCornerChroma >= 28,
      `100% full: both far-left and far-right colored capsule borders must be crisp & unclipped (${JSON.stringify(fullBorders)})`,
    );
    assert(
      Math.abs(fullBorders.leftCapPeakX - fullBorders.rightCapPeakDist) <= 1,
      `100% full: left vs right colored border inset must be symmetric within 1 physical px (${fullBorders.leftCapPeakX} vs ${fullBorders.rightCapPeakDist})`,
    );

    captures.mobile_390x844_dark_100pct = await capturePopoverBase64(page, 8);
    await page.goBack();
    await page.waitForTimeout(180);

    // Edge Case B: Auto-compact Off (autoCompactThreshold = 0)
    scenario.usedTokens = 96_400;
    scenario.autoCompactThreshold = 0;
    scenario.configRevision = "rev-off";
    broadcastWS({ type: "change", collection: "config" });
    broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
    await page.waitForTimeout(450);
    await openPopover();

    const offSnap = await page.evaluate(() => ({
      subState: document.querySelector("[data-context-subtitle]")?.getAttribute("data-subtitle-state"),
      subText: document.querySelector("[data-context-subtitle]")?.textContent?.trim() || "",
      reserveCount: document.querySelectorAll('[data-telemetry-cell="reserve"]').length,
      footerText: document.querySelector("[data-context-footer-strip]")?.textContent?.trim() || "",
    }));
    assert.equal(offSnap.subState, "idle:off");
    assert(offSnap.subText.includes("104K free") && offSnap.subText.includes("Auto-compact off"));
    assert.equal(offSnap.reserveCount, 0, "reserve cell must be hidden when auto-compact is Off");
    assert(offSnap.footerText.includes("Auto-compact off") && offSnap.footerText.includes("Configure"));
    await page.goBack();
    await page.waitForTimeout(180);

    // Edge Case C: !activeUsage() & empty session context (no turns run yet)
    scenario.autoCompactThreshold = 80;
    scenario.configRevision = "rev-on";
    scenario.usedTokens = null;
    scenario.usage = null;
    broadcastWS({ type: "change", collection: "config" });
    broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
    await page.waitForTimeout(450);
    // Clear sessionUsage via reload on clean empty session
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("[data-composer-footer] [data-menubtn]", { timeout: 15_000 });
    await page.waitForTimeout(250);
    await openPopover();

    const emptySnap = await page.evaluate(() => ({
      fig: document.querySelector("[data-context-primary-figure]")?.textContent?.trim(),
      subText: document.querySelector("[data-context-subtitle]")?.textContent?.trim() || "",
      meterText: document.querySelector("[data-context-meter]")?.textContent || "",
    }));
    assert.equal(emptySnap.fig, "Context —");
    assert(emptySnap.subText.includes("160K usable") && emptySnap.subText.includes("Auto-compact at 80%"));
    assert(
      emptySnap.meterText.includes("No usage reported yet. Run a turn to inspect input, cache, and output tokens."),
    );
    await page.goBack();
    await page.waitForTimeout(180);

    // Edge Case D: window = 0 (Context limit not configured)
    scenario.modelContext = 0;
    scenario.windowTokens = 0;
    scenario.usedTokens = 42_000;
    scenario.usage = { ...DEFAULT_USAGE };
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("[data-composer-footer] [data-menubtn]", { timeout: 15_000 });
    await page.waitForTimeout(250);
    await openPopover();

    const noWinSnap = await page.evaluate(() => ({
      subState: document.querySelector("[data-context-subtitle]")?.getAttribute("data-subtitle-state"),
      subText: document.querySelector("[data-context-subtitle]")?.textContent?.trim() || "",
      meterText: document.querySelector("[data-context-meter]")?.textContent || "",
    }));
    assert.equal(noWinSnap.subState, "idle:no-window");
    assert(noWinSnap.subText.includes("Context limit not configured. Latest request + response."));
    assert(!noWinSnap.meterText.includes("NaN") && !noWinSnap.meterText.includes("Infinity"));

    await context.close();
  }

  // ===========================================================================
  // 4. OPTIONAL 2X RETINA SHOWCASE CONTACT SHEETS
  // ===========================================================================
  if (showcaseDir) {
    mkdirSync(showcaseDir, { recursive: true });
    console.log(`[context-meter-ui] Rendering 4 2x Retina showcase contact sheets to ${showcaseDir}...`);

    const sheet1 = await renderCompositeSheet(
      browser,
      "Context & Usable Auto-Compact Meter — Opening Sweep & Settled Lattice (Dark 2x)",
      "780ms incandescent shockwave (both parities lit) -> settled (col+row)%2===0 diamond lattice + 80% usable reticle",
      [
        {
          label: "Mid-Sweep (~190ms) — Incandescent Frontier Shockwave",
          sub: "Live token count-up · radial bloom · 100% dense leading pixel wall",
          base64: captures.desktop_dark_midsweep!,
        },
        {
          label: "Settled Overview — Usable Context & 80% Reticle",
          sub: "96.4K of 200K window · 63.6K usable left (60% of 160K) · 40K reserve buffer",
          base64: captures.desktop_dark_settled!,
        },
      ],
      2,
      "dark",
    );
    writeFileSync(path.join(showcaseDir, "context_meter_sweep_and_settled_dark.png"), sheet1);

    const sheet2 = await renderCompositeSheet(
      browser,
      "Bidirectional Segment, Usable Headroom & Auto-Compact Buffer Spotlights (2x)",
      "1.5px luminous segment frames · 0.28x sibling dimming · 130ms blurred subtitle morph · 2D createGlide spring pill",
      [
        {
          label: "Dark — Hovering Cache Segment (65% Hit Rate)",
          sub: "zone:cache · 52.0K cached · 2D gliding pill synced",
          base64: captures.desktop_dark_spot_cache!,
        },
        {
          label: "Dark — Hovering Usable Free Headroom",
          sub: "zone:usable · 63.6K left (40% before 80% auto-compact)",
          base64: captures.desktop_dark_spot_usable!,
        },
        {
          label: "Dark — Hovering Auto-Compact Reserve Buffer",
          sub: "zone:reserve · 40.0K reserved above 80% · zero truncation",
          base64: captures.desktop_dark_spot_reserve!,
        },
        {
          label: "Light — Hovering Cache Segment Spotlight",
          sub: "High-contrast jewel LED lattice · zero washout",
          base64: captures.desktop_light_spot_cache!,
        },
      ],
      2,
      "dark",
    );
    writeFileSync(path.join(showcaseDir, "context_meter_hover_spotlights.png"), sheet2);

    const sheet3 = await renderCompositeSheet(
      browser,
      "Light Theme Optical Tuning — Jewel-Plasma Sweep, Settled & Reserve Spotlight (2x)",
      "Saturated jewel plasma backdrop prevents white-on-white washout while preserving crisp LED matrix contrast",
      [
        {
          label: "Light Mid-Sweep — Jewel Plasma Frontier",
          sub: "Localized saturated backdrop + crisp jewel core",
          base64: captures.desktop_light_midsweep!,
        },
        {
          label: "Light Settled — Usable Context Overview",
          sub: "63.6K usable left · 160K usable reticle",
          base64: captures.desktop_light_settled!,
        },
        {
          label: "Light — Auto-Compact Buffer Spotlight",
          sub: "Amber reticle + living socket shimmer",
          base64: captures.desktop_light_spot_reserve!,
        },
      ],
      3,
      "light",
    );
    writeFileSync(path.join(showcaseDir, "context_meter_light_theme.png"), sheet3);

    const sheet4 = await renderCompositeSheet(
      browser,
      "Mobile Touch Viewports (360×780 & 390×844) — Pin, Armed & 100% Full Symmetry (2x)",
      "Zero horizontal overflow · zero truncation · symmetric 100% left/right curved borders · Back closes in 1 step",
      [
        {
          label: "360×780 Dark — Settled (344px Popover)",
          sub: "96.4K · 48% full hero · 0px overflow",
          base64: captures.mobile_360x780_dark_settled!,
        },
        {
          label: "360×780 Light — Touch-Pinned Cache Spotlight",
          sub: "aria-pressed=true · 2nd tap unpins cleanly",
          base64: captures.mobile_360x780_light_touch_spot!,
        },
        {
          label: "390×844 Dark — Auto-Compact Armed (>80%)",
          sub: "172K · 86% full (+12.4K over 160K limit)",
          base64: captures.mobile_390x844_dark_armed!,
        },
        {
          label: "390×844 Dark — 100% Full (200K / 200K)",
          sub: "Symmetric unclipped left & right curved capsule borders",
          base64: captures.mobile_390x844_dark_100pct!,
        },
      ],
      2,
      "dark",
    );
    writeFileSync(path.join(showcaseDir, "context_meter_mobile_360_390.png"), sheet4);
    console.log("[context-meter-ui] Saved all 4 2x Retina showcase PNGs.");
  }

  assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join("; ")}`);
  console.log("PASS: Animated Context & Usable Auto-Compact Meter E2E (desktop, mobile 360/390, dark/light, edge cases)");
} finally {
  await browser.close();
  server.stop(true);
}
