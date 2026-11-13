/**
 * Real-Chromium Browser & Mobile Hardware Back-Button (`popstate` / `window.history`)
 * + `Escape` / DS Layer Stack E2E gate (`390x844`, `360x780`, `1440x900`).
 *
 * Verifies all 11 back-navigation & layer scenarios:
 *   1) `#/ -> #/code` on mobile (`390x844`): starts in session (`sidebarOpen=false`) ->
 *      `page.goBack()` opens sidebar (`sidebarOpen=true`, stays on `#/code`) ->
 *      select another session (`sidebarOpen=false`) -> repeat 3x ->
 *      `page.goBack()` opens sidebar -> `page.goBack()` exits cleanly to `#/` in 1 press!
 *   2) Mobile in session -> open `SettingsModal` -> `page.goBack()` closes `SettingsModal`
 *      (still in session!) -> `page.goBack()` opens sidebar -> `page.goBack()` exits to `#/`.
 *   3) UI close parity (zero ghost entries): open `SettingsModal` -> close via `X` / scrim / `Escape` ->
 *      `page.goBack()` on mobile immediately opens sidebar, and on desktop immediately exits to `#/`!
 *   4) Mobile `+` sheet 3-level drilldown: open `+` -> `Claude Sonnet` (`effort`) ->
 *      `Switch model` (`model`) -> `page.goBack()` -> `effort` -> `page.goBack()` -> `main` ->
 *      drill into `Mode` -> `page.goBack()` -> `main` -> `page.goBack()` -> closes `+` sheet ->
 *      `page.goBack()` -> opens sidebar!
 *   5) `NewProjectModal` folder drilldown: open modal -> click 2 subfolders ->
 *      `page.goBack()` steps up folder 1 -> `page.goBack()` steps up folder 2 ->
 *      `page.goBack()` closes modal! Plus reopen -> click 2 subfolders -> click `X` ->
 *      `page.goBack()` has zero leftover entries!
 *   6) `PreviewModal` + `Limit preview` slicer drawer -> `page.goBack()` (and `Escape`)
 *      closes slicer first, then `PreviewModal`.
 *   7) `ConfirmModal` (session context menu -> Delete same-tick `replaceState`) ->
 *      `page.goBack()` cancels deletion (`session` still exists!).
 *   8) `HistoryView` (`Ctrl+K`) -> `page.goBack()` returns to chat; `selectionMode` ->
 *      `page.goBack()` exits selection mode; `editingQueueId` / `renamingId` / `editingMsgIdx` ->
 *      `page.goBack()` cancels edit/rename.
 *   9) Rapid triple `history.back()` during modal exit animations -> zero stuck `[inert]`
 *      or scroll-lock, lands cleanly on target state; `savingSettings` in-flight refuses Back!
 *  10) F5 `page.reload()` on mobile while in session (and with modal open) -> `page.goBack()`
 *      still opens sidebar first and next `page.goBack()` exits to `#/`; `page.goForward()`
 *      restores idempotent views and bounces ephemeral entries!
 *  11) Clicking `Back to gateway` link while history entries exist (and on zero-host `Onboarding`) ->
 *      lands on `#/` with zero stale `#/code` entries behind it; viewport resize (`390x844 <-> 1440x900`)
 *      reconciles `mobile-workspace` cleanly.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-back-nav-e2e.ts
 */
import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WS_ROOT = path.join(ROOT, "..");
const DIST_DIR = path.join(WS_ROOT, "dist");
if (!existsSync(path.join(DIST_DIR, "index.html"))) {
  throw new Error("dist/index.html missing — run `bun run build:web` first");
}

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const HOST_ID = "host-back-nav";
const NOW = Date.now();

interface MockServerState {
  hasHosts: boolean;
  deletedSessions: Set<string>;
  holdConfigSave: boolean;
  pendingConfigSaveWs: { ws: any; requestId: string; settings: any } | null;
  configRevision: number;
  queue: any[];
}

const serverState: MockServerState = {
  hasHosts: true,
  deletedSessions: new Set(),
  holdConfigSave: false,
  pendingConfigSaveWs: null,
  configRevision: 1,
  queue: [],
};

function resetServerState() {
  serverState.hasHosts = true;
  serverState.deletedSessions.clear();
  serverState.holdConfigSave = false;
  serverState.pendingConfigSaveWs = null;
  serverState.configRevision = 1;
  serverState.queue = [
    {
      id: "q-item-1",
      text: "Verify idempotency under 16 concurrent workers",
      attachmentIds: [],
      createdAt: NOW - 5_000,
    },
  ];
}

const FOLDER_TREE: Record<string, { path: string; parent: string; folders: Array<{ name: string; path: string }> }> = {
  "~": {
    path: "/Users/italo",
    parent: "/Users",
    folders: [{ name: "dev", path: "/Users/italo/dev" }],
  },
  "/Users/italo": {
    path: "/Users/italo",
    parent: "/Users",
    folders: [{ name: "dev", path: "/Users/italo/dev" }],
  },
  "/Users/italo/dev": {
    path: "/Users/italo/dev",
    parent: "/Users/italo",
    folders: [
      { name: "ledger-service", path: "/Users/italo/dev/ledger-service" },
      { name: "billing-worker", path: "/Users/italo/dev/billing-worker" },
    ],
  },
  "/Users/italo/dev/ledger-service": {
    path: "/Users/italo/dev/ledger-service",
    parent: "/Users/italo/dev",
    folders: [
      { name: "cmd", path: "/Users/italo/dev/ledger-service/cmd" },
      { name: "internal", path: "/Users/italo/dev/ledger-service/internal" },
    ],
  },
  "/Users/italo/dev/ledger-service/internal": {
    path: "/Users/italo/dev/ledger-service/internal",
    parent: "/Users/italo/dev/ledger-service",
    folders: [
      { name: "ledger", path: "/Users/italo/dev/ledger-service/internal/ledger" },
    ],
  },
  "/Users/italo/dev/ledger-service/internal/ledger": {
    path: "/Users/italo/dev/ledger-service/internal/ledger",
    parent: "/Users/italo/dev/ledger-service/internal",
    folders: [],
  },
};

function defaultProjects() {
  return [
    {
      id: "proj-home",
      hostId: HOST_ID,
      name: "Home",
      path: "/Users/italo",
      createdAt: NOW - 86_400_000 * 10,
      protected: true,
      collapsed: false,
      folderStatus: "available",
    },
    {
      id: "proj-ledger",
      hostId: HOST_ID,
      name: "ledger-service",
      path: "/Users/italo/dev/ledger-service",
      createdAt: NOW - 86_400_000 * 8,
      protected: false,
      collapsed: false,
      folderStatus: "available",
    },
  ];
}

function buildMockSessions() {
  const all = [
    {
      id: "s-main",
      hostId: HOST_ID,
      cwd: "/Users/italo/dev/ledger-service",
      title: "Idempotent double-entry posting lock",
      model: "claude-sonnet-4-6",
      status: "idle",
      pinned: true,
      createdAt: NOW - 7_200_000,
      updatedAt: NOW - 60_000,
      lastTurnEndedAt: NOW - 60_000,
      todosOpen: true,
      approvalMode: "ask",
      options: { effort: "high", mode: "agentic", skills: [{ name: "build" }], access: "ask" },
    },
    {
      id: "s-second",
      hostId: HOST_ID,
      cwd: "/Users/italo/dev/ledger-service",
      title: "Outbox relay backoff jitter audit",
      model: "gpt-5.4",
      status: "idle",
      pinned: false,
      createdAt: NOW - 14_400_000,
      updatedAt: NOW - 900_000,
      lastTurnEndedAt: NOW - 900_000,
      approvalMode: "ask",
      options: { effort: "high", mode: "agentic", skills: [{ name: "build" }], access: "ask" },
    },
  ];
  return all.filter((s) => !serverState.deletedSessions.has(s.id));
}

function buildSessionRecord(sessionId: string) {
  const isSecond = sessionId === "s-second";
  return {
    id: isSecond ? "s-second" : "s-main",
    hostId: HOST_ID,
    cwd: "/Users/italo/dev/ledger-service",
    title: isSecond ? "Outbox relay backoff jitter audit" : "Idempotent double-entry posting lock",
    model: isSecond ? "gpt-5.4" : "claude-sonnet-4-6",
    status: "idle",
    pinned: !isSecond,
    createdAt: NOW - 7_200_000,
    updatedAt: NOW - 60_000,
    approvalMode: "ask",
    options: { effort: "high", mode: "agentic", skills: [{ name: "build" }], access: "ask" },
    skills: {
      build: { priority: 0, active: true, usable: "inherit" },
    },
    turn: null,
    thinkingStartedAt: null,
    todos: [],
    todosOpen: true,
    question: null,
    pendingApproval: null,
    queue: isSecond ? [] : serverState.queue,
    bgTasks: [],
    attachments: [],
    context: { usedTokens: 32000, limitTokens: 200000, percent: 16 },
    usage: { inputTokens: 30000, cachedTokens: 12000, outputTokens: 2000, costUsd: 0.05 },
    fileBalloons: [],
    messages: [
      {
        id: `${sessionId}-u1`,
        role: "user",
        turnIndex: 1,
        createdAt: NOW - 300_000,
        content: [
          {
            type: "text",
            text: isSecond
              ? "Check exponential backoff jitter bounds in the outbox dispatcher."
              : "Guard PostJournal with a transaction-scoped advisory lock.",
          },
        ],
      },
      {
        id: `${sessionId}-a1`,
        role: "assistant",
        turnIndex: 2,
        createdAt: NOW - 290_000,
        model: isSecond ? "gpt-5.4" : "claude-sonnet-4-6",
        content: [
          {
            type: "text",
            text: isSecond
              ? "Verified full jitter bounds between 100ms and 15s."
              : "Added LockIdempotencyKey inside PostJournal so concurrent retries serialize cleanly.\n\n```generative_ui\nwidget_id: latency-chart\nplaceholder: Latency distribution\nstate: {}\n```",
          },
        ],
      },
    ],
  };
}

const MOCK_MODELS = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    owned_by: "anthropic",
    supported_efforts: ["low", "medium", "high", "max"],
    default_effort: "high",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    owned_by: "openai",
    supported_efforts: ["low", "medium", "high"],
    default_effort: "high",
  },
];

let configSettings = {
  mid_turn_send: "queue",
  auto_compact_threshold: 80,
  no_auto_title: false,
  jail_by_default: false,
  insecure_tls: false,
};

function buildConfigDoc() {
  return {
    id: "daemon",
    hostId: HOST_ID,
    revision: `rev-${serverState.configRevision}`,
    name: "devbox-pro",
    lastSelection: {
      model: "claude-sonnet-4-6",
      effort: "high",
      mode: "agentic",
      access: "ask",
      skills: [{ name: "build" }],
    },
    settings: { ...configSettings },
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
      plan: {
        name: "plan",
        description: "Read-only architectural investigation & step-by-step spec",
        mode: "agentic",
        usable: "always",
        approvalMode: "ask",
        builtin: true,
        enabled: true,
      },
      talk: {
        name: "talk",
        description: "Conversational Q&A with generative UI widgets",
        mode: "talk",
        usable: "always",
        approvalMode: "yolo",
        builtin: true,
        enabled: true,
      },
      review: {
        name: "review",
        description: "Strict diff & invariant review before landing commits",
        mode: "agentic",
        usable: "always",
        enabled: true,
      },
    },
    skillErrors: [],
  };
}

function finishHeldConfigSave() {
  const pending = serverState.pendingConfigSaveWs;
  if (!pending) return;
  serverState.pendingConfigSaveWs = null;
  serverState.configRevision++;
  configSettings = { ...configSettings, ...pending.settings };
  const rev = `rev-${serverState.configRevision}`;
  pending.ws.send(
    JSON.stringify({
      type: "config_updated",
      success: true,
      hostId: HOST_ID,
      requestId: pending.requestId,
      revision: rev,
    }),
  );
  pending.ws.send(JSON.stringify({ type: "change", hostId: HOST_ID, collection: "config" }));
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
        hosts: serverState.hasHosts
          ? [
              {
                id: HOST_ID,
                name: "devbox-pro",
                hostname: "workstation.local",
                os: "linux",
                arch: "amd64",
                version: "v0.9.4",
                status: "online",
                lastSeenAt: Date.now(),
              },
            ]
          : [],
      });
    }
    if (p === "/api/indirect-code/pair") {
      return Response.json({
        success: true,
        token: "pair-tok-test",
        expiresAt: Date.now() + 900_000,
        connectUrl: `http://127.0.0.1:${srv.port}/pair/pair-tok-test`,
      });
    }
    if (p === "/api/me/models") return Response.json({ success: true, models: MOCK_MODELS });
    if (p === "/api/keys") return Response.json({ success: true, keys: [] });
    if (p === "/api/me/usage" || p === "/api/usage") {
      return Response.json({
        success: true,
        summary: { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        series: [],
        byModel: [],
        byKey: [],
      });
    }
    if (p === "/api/me/limits") {
      return Response.json({ success: true, plan: null });
    }
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
    if (p === "/api/indirect-code/gen-ui/widgets") {
      return Response.json({ url: "/mock-widget.html" });
    }
    if (p === "/mock-widget.html") {
      return new Response("<!doctype html><html><body><div>Latency Widget</div></body></html>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (p.startsWith("/api/")) return Response.json({ success: true, items: [], data: [] });

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
      ws.send(
        JSON.stringify({
          type: "hello",
          hosts: serverState.hasHosts ? [{ id: HOST_ID, status: "online" }] : [],
        }),
      );
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
            ? defaultProjects()
            : msg.collection === "sessions"
              ? buildMockSessions()
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
            session: buildSessionRecord(msg.sessionId),
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
            workspace: { status: "available", path: "/Users/italo/dev/ledger-service" },
          }),
        );
        return;
      }
      if (msg.type === "browse_folders") {
        const entry =
          FOLDER_TREE[msg.path] ?? {
            path: msg.path || "/Users/italo",
            parent: "/Users",
            folders: [],
          };
        ws.send(
          JSON.stringify({
            type: "folders",
            hostId: hid,
            requestId: msg.requestId,
            path: entry.path,
            parent: entry.parent,
            folders: entry.folders,
          }),
        );
        return;
      }
      if (msg.type === "delete_session") {
        serverState.deletedSessions.add(msg.sessionId);
        ws.send(JSON.stringify({ type: "change", hostId: hid, collection: "sessions" }));
        return;
      }
      if (msg.type === "update_config") {
        if (serverState.holdConfigSave) {
          serverState.pendingConfigSaveWs = {
            ws,
            requestId: msg.requestId,
            settings: msg.settings || {},
          };
          return;
        }
        serverState.configRevision++;
        configSettings = { ...configSettings, ...(msg.settings || {}) };
        ws.send(
          JSON.stringify({
            type: "config_updated",
            success: true,
            hostId: hid,
            requestId: msg.requestId,
            revision: `rev-${serverState.configRevision}`,
          }),
        );
        ws.send(JSON.stringify({ type: "change", hostId: hid, collection: "config" }));
        return;
      }
      if (msg.type === "daemon_update_check") {
        ws.send(
          JSON.stringify({
            type: "daemon_update",
            hostId: hid,
            current: "v0.9.4",
            available: "v0.9.4",
            staged: "",
            checkedAt: Date.now(),
            autoUpdate: true,
          }),
        );
        return;
      }
      if (msg.type === "get_widget") {
        ws.send(
          JSON.stringify({
            type: "widget_data",
            hostId: hid,
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            widgetId: msg.widgetId,
            widget: {
              id: msg.widgetId,
              source: "export default function LatencyWidget() { return <div>Latency Widget</div>; }",
              updatedAt: NOW,
            },
          }),
        );
        return;
      }
      if (msg.type === "search_files") {
        ws.send(
          JSON.stringify({
            type: "file_matches",
            hostId: hid,
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            files: ["internal/ledger/postings.go"],
            truncated: false,
          }),
        );
      }
    },
  },
});

const BASE_URL = `http://127.0.0.1:${server.port}`;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

async function createAuthedContext(
  browser: any,
  opts: { width: number; height: number; isMobile: boolean; sessionId?: string },
) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 2,
    isMobile: opts.isMobile,
    hasTouch: opts.isMobile,
    userAgent: opts.isMobile ? IPHONE_UA : DESKTOP_UA,
    colorScheme: "dark",
  });
  await context.addInitScript(
    ({ hostId, initialSid }) => {
      try {
        Object.defineProperty(window, "Notification", {
          configurable: true,
          value: class MockNotification {
            static permission = "granted";
            static requestPermission() {
              return Promise.resolve("granted");
            }
          },
        });
      } catch {}
      if (!sessionStorage.getItem("__test_bootstrapped")) {
        sessionStorage.setItem("__test_bootstrapped", "1");
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
        localStorage.setItem("llmgw-theme", "dark");
        localStorage.setItem("llmgw-rc-active-host", hostId);
        if (initialSid) {
          localStorage.setItem(`llmgw-rc-session:${hostId}`, initialSid);
        }
      }
    },
    { hostId: HOST_ID, initialSid: opts.sessionId ?? "s-main" },
  );
  return context;
}

async function waitForHash(page: any, expected: string, label: string) {
  await page.waitForFunction(
    (h: string) => window.location.hash === h,
    expected,
    { timeout: 5000 },
  );
  const actual = await page.evaluate(() => window.location.hash);
  assert.equal(actual, expected, `${label}: expected hash ${expected}, got ${actual}`);
}

async function isSidebarOpen(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const aside = document.querySelector("aside.rc-sidebar");
    return Boolean(aside && !aside.hasAttribute("inert"));
  });
}

async function waitForSidebar(page: any, open: boolean, label: string) {
  await page.waitForFunction(
    (wantOpen: boolean) => {
      const aside = document.querySelector("aside.rc-sidebar");
      return Boolean(aside) && !aside!.hasAttribute("inert") === wantOpen;
    },
    open,
    { timeout: 5000 },
  );
  assert.equal(await isSidebarOpen(page), open, `${label}: sidebarOpen mismatch`);
}

async function assertNoInertOrScrollLockLeak(page: any, label: string) {
  const state = await page.evaluate(() => ({
    appInert: document.getElementById("app")?.hasAttribute("inert") ?? false,
    bodyOverflow: document.body.style.overflow,
  }));
  assert.equal(state.appInert, false, `${label}: #app[inert] leaked after layer close!`);
  assert.equal(state.bodyOverflow, "", `${label}: body scroll-lock leaked after layer close!`);
}

async function clickGatewayCodeLink(page: any) {
  await page
    .locator('a[href="#/code"]:visible, button[aria-label="Menu"]:visible')
    .first()
    .waitFor({ state: "visible", timeout: 8000 });
  const visibleLink = page.locator('a[href="#/code"]:visible').first();
  if ((await visibleLink.count()) === 0) {
    await page.locator('button[aria-label="Menu"]:visible').first().click();
    await visibleLink.waitFor({ state: "visible", timeout: 5000 });
  }
  await visibleLink.click();
}

async function enterCodeFromGateway(page: any) {
  await page.goto(`${BASE_URL}/#/`, { waitUntil: "domcontentloaded" });
  await clickGatewayCodeLink(page);
  await waitForHash(page, "#/code", "entered #/code from Gateway #/");
  await page.waitForSelector("#rc-composer", { timeout: 8000 });
  // Allow SignalDB pull & initial mobile-workspace pushState to settle
  await page.waitForTimeout(160);
}

const { chromium } = await loadPlaywright();
const executablePath = await resolveChrome();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

try {
  // =========================================================================
  // SCENARIO 1, 2, 3 (Mobile), 4, 10: Mobile (390x844 & 360x780) Navigation
  // =========================================================================
  for (const vp of [
    { width: 390, height: 844, name: "390x844" },
    { width: 360, height: 780, name: "360x780" },
  ]) {
    resetServerState();
    const ctx = await createAuthedContext(browser, {
      width: vp.width,
      height: vp.height,
      isMobile: true,
    });
    const page = await ctx.newPage();

    // 1) #/ -> #/code on mobile: starts in session (sidebarOpen=false) ->
    //    goBack opens sidebar -> switch sessions 3x -> goBack opens sidebar ->
    //    goBack exits cleanly to #/ in ONE press!
    await enterCodeFromGateway(page);
    await waitForSidebar(page, false, `${vp.name} initial mobile session`);

    for (let round = 0; round < 3; round++) {
      await page.goBack();
      await waitForHash(page, "#/code", `${vp.name} round ${round + 1} stays on #/code`);
      await waitForSidebar(page, true, `${vp.name} round ${round + 1} opens sidebar`);

      const targetTitle =
        round % 2 === 0
          ? "Outbox relay backoff jitter audit"
          : "Idempotent double-entry posting lock";
      await page.getByText(targetTitle, { exact: false }).first().click();
      await waitForSidebar(page, false, `${vp.name} round ${round + 1} switched session`);
    }

    await page.goBack();
    await waitForSidebar(page, true, `${vp.name} back to mobile sidebar before exit`);
    await page.goBack();
    await waitForHash(page, "#/", `${vp.name} exits #/code cleanly to #/ in 1 press`);
    console.log(`✓ [${vp.name}] Scenario 1 passed: mobile session <-> sidebar loop-free + 1-press exit`);

    if (vp.width === 390) {
      // 2) Mobile in session -> open SettingsModal -> goBack closes SettingsModal ->
      //    goBack opens sidebar -> goBack exits to #/
      await clickGatewayCodeLink(page);
      await waitForHash(page, "#/code", "re-enter #/code");
      await page.waitForSelector("#rc-composer", { timeout: 8000 });
      await waitForSidebar(page, false, "mobile session restored");

      // Open sidebar via UI button, tap Settings
      await page.locator('button[aria-label="Expand sidebar"]:visible').first().click();
      await waitForSidebar(page, true, "opened sidebar for Settings");
      await page.locator('button[aria-label*="Settings"]').first().click();
      await page.locator('[role="dialog"][aria-label*="settings" i], [role="dialog"]:has-text("Host & agent settings")').first().waitFor({ state: "visible" });
      await waitForSidebar(page, false, "Settings closed mobile drawer");

      await page.goBack();
      await page.waitForFunction(
        () => !document.querySelector('[role="dialog"]:not([data-state="closing"]):not([data-floatmenu])'),
        null,
        { timeout: 3000 },
      );
      await assertNoInertOrScrollLockLeak(page, "mobile Settings goBack");
      await waitForSidebar(page, false, "still in session after Settings goBack");

      await page.goBack();
      await waitForSidebar(page, true, "opens sidebar after session goBack");
      await page.goBack();
      await waitForHash(page, "#/", "exits to #/ after sidebar goBack");
      console.log("✓ [390x844] Scenario 2 passed: mobile Settings -> session -> sidebar -> Gateway #/");

      // 3a) Mobile UI close parity: open SettingsModal -> close via X -> goBack immediately opens sidebar!
      await clickGatewayCodeLink(page);
      await waitForHash(page, "#/code", "re-enter #/code for Scenario 3");
      await page.waitForSelector("#rc-composer", { timeout: 8000 });
      await waitForSidebar(page, false, "mobile session active");

      await page.locator('button[aria-label="Expand sidebar"]:visible').first().click();
      await waitForSidebar(page, true, "sidebar open");
      await page.locator('button[aria-label*="Settings"]').first().click();
      const settingsDialog = page.locator('[role="dialog"]:has-text("Host & agent settings")').first();
      await settingsDialog.waitFor({ state: "visible" });

      // Close via Cancel button inside SettingsModal
      await settingsDialog.getByRole("button", { name: "Cancel" }).click();
      await page.waitForTimeout(120);
      await assertNoInertOrScrollLockLeak(page, "mobile Settings Cancel");

      // Single goBack MUST immediately open sidebar (zero dead press!)
      await page.goBack();
      await waitForSidebar(page, true, "mobile UI close parity: 1 goBack opens sidebar");
      // Tap session to return to workspace
      await page.getByText("Idempotent double-entry posting lock").first().click();
      await waitForSidebar(page, false, "back in session");
      console.log("✓ [390x844] Scenario 3 (mobile) passed: UI close leaves zero phantom history entries");

      // 4) Mobile `+` sheet 3-level drilldown: + -> Claude Sonnet (effort) -> Switch model (model) ->
      //    goBack -> effort -> goBack -> main -> Mode -> goBack -> main -> goBack -> closes + -> goBack -> sidebar!
      await page.locator("button.rc-composer-add").click();
      const plusDialog = page.locator('[data-floatmenu][aria-label="Add & Settings"]');
      await plusDialog.waitFor({ state: "visible" });

      await plusDialog.getByText("Claude Sonnet 4.6").click();
      await plusDialog.locator("[data-effort-picker]").waitFor({ state: "visible" });

      await plusDialog.locator("button[data-effort-model-btn]").click();
      await plusDialog.getByText("Select model", { exact: true }).waitFor({ state: "visible" });

      await page.goBack();
      await plusDialog.locator("[data-effort-picker]").waitFor({ state: "visible" });

      await page.goBack();
      await plusDialog.getByText("Configuration", { exact: true }).waitFor({ state: "visible" });

      // Also test Mode subview drilldown + Back
      await plusDialog.getByText("Mode", { exact: true }).click();
      await plusDialog.getByText("Mode & Skills", { exact: true }).waitFor({ state: "visible" });

      await page.goBack();
      await plusDialog.getByText("Configuration", { exact: true }).waitFor({ state: "visible" });

      await page.goBack();
      await page.waitForFunction(
        () => !document.querySelector('[data-floatmenu][aria-label="Add & Settings"]'),
        null,
        { timeout: 3000 },
      );

      await page.goBack();
      await waitForSidebar(page, true, "opens sidebar after closing + sheet");
      await page.getByText("Idempotent double-entry posting lock").first().click();
      await waitForSidebar(page, false, "back in session");
      console.log("✓ [390x844] Scenario 4 passed: mobile + sheet 3-level drilldown & Back unwinding");

      // 10) F5 page.reload() on mobile while in session (and with SettingsModal open!) + Forward restore/bounce
      await page.locator('button[aria-label="Expand sidebar"]:visible').first().click();
      await waitForSidebar(page, true, "open sidebar before reload test");
      await page.locator('button[aria-label*="Settings"]').first().click();
      await page.locator('[role="dialog"]:has-text("Host & agent settings")').first().waitFor({ state: "visible" });

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#rc-composer", { timeout: 8000 });
      await page.waitForTimeout(200);
      await waitForSidebar(page, false, "mobile session restored after F5 reload");

      await page.goBack();
      await waitForSidebar(page, true, "after F5 reload, 1st goBack opens sidebar");

      // Browser Forward from sidebar restores mobile-workspace!
      await page.goForward();
      await waitForSidebar(page, false, "goForward restores mobile-workspace");

      await page.goBack();
      await waitForSidebar(page, true, "goBack opens sidebar again");
      await page.goBack();
      await waitForHash(page, "#/", "after F5 reload, 2nd goBack exits cleanly to #/");
      console.log("✓ [390x844] Scenario 10 passed: F5 reload stale-bootId recovery + Forward restore");
    }

    await ctx.close();
  }

  // =========================================================================
  // SCENARIOS 3 (Desktop), 5, 6, 7, 8, 9, 11: Desktop (1440x900) & Resize
  // =========================================================================
  {
    resetServerState();
    const ctx = await createAuthedContext(browser, {
      width: 1440,
      height: 900,
      isMobile: false,
    });
    const page = await ctx.newPage();

    await enterCodeFromGateway(page);
    await waitForSidebar(page, true, "desktop sidebar open by default");

    // 3b) Desktop UI close parity (X, scrim, Escape): zero phantom history entries!
    await page.locator('button[aria-label*="Settings"]').first().click();
    const settingsDialog = page.locator('[role="dialog"]:has-text("Host & agent settings")').first();
    await settingsDialog.waitFor({ state: "visible" });

    // Close via X button
    await settingsDialog.locator('button[aria-label="Close dialog"], button[aria-label="Close"]').first().click();
    await page.waitForTimeout(120);
    await assertNoInertOrScrollLockLeak(page, "desktop Settings X close");

    // Open again and close via scrim click (top-left corner outside centered dialog)
    await page.locator('button[aria-label*="Settings"]').first().click();
    await settingsDialog.waitFor({ state: "visible" });
    await page.mouse.click(8, 8);
    await page.waitForTimeout(120);
    await assertNoInertOrScrollLockLeak(page, "desktop Settings scrim close");

    // Open again and close via Escape
    await page.locator('button[aria-label*="Settings"]').first().click();
    await settingsDialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    // Immediately at t=0ms (during 140ms exit animation!), #app[inert] MUST already be released!
    await assertNoInertOrScrollLockLeak(page, "desktop Settings Escape t=0ms synchronous inert release");
    await page.waitForTimeout(120);

    // Single goBack on desktop MUST exit directly to Gateway #/!
    await page.goBack();
    await waitForHash(page, "#/", "desktop UI close parity: 1 goBack exits to #/");

    // Re-enter #/code
    await clickGatewayCodeLink(page);
    await waitForHash(page, "#/code", "re-enter #/code on desktop");
    await page.waitForSelector("#rc-composer", { timeout: 8000 });
    await page.waitForTimeout(120);
    console.log("✓ [1440x900] Scenario 3 (desktop) passed: X / scrim / Escape leave zero phantom entries & release [inert] at t=0ms");

    // 5) NewProjectModal folder drilldown: open via menu -> click 2 subfolders ->
    //    goBack steps up folder 1 -> goBack steps up folder 2 -> goBack closes modal!
    //    Plus reopen -> click 2 subfolders -> click X -> goBack exits directly to #/!
    await page.locator('button[aria-label="Create new project"]').click();
    await page.locator('[data-floatmenu]').getByText("New project").click();
    const newProjDialog = page.getByRole("dialog", { name: "Select project folder" });
    await newProjDialog.waitFor({ state: "visible" });
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal"]').waitFor({ state: "visible" });

    // Drill folder 1: internal
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal"]').click();
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal/ledger"]').waitFor({ state: "visible" });

    // Drill folder 2: ledger
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal/ledger"]').click();
    await newProjDialog.getByText("No subdirectories here").waitFor({ state: "visible" });

    // goBack #1 -> back to /internal
    await page.goBack();
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal/ledger"]').waitFor({ state: "visible" });

    // goBack #2 -> back to /ledger-service
    await page.goBack();
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal"]').waitFor({ state: "visible" });

    // goBack #3 -> closes NewProjectModal!
    await page.goBack();
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"]:not([data-state="closing"]) [aria-label="Host folders"]'),
      null,
      { timeout: 3000 },
    );

    // Reopen, drill 2 subfolders, close via X -> 1 goBack exits to #/!
    await page.locator('button[aria-label="Create new project"]').click();
    await page.locator('[data-floatmenu]').getByText("New project").click();
    await newProjDialog.waitFor({ state: "visible" });
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal"]').click();
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal/ledger"]').click();
    await newProjDialog.getByText("No subdirectories here").waitFor({ state: "visible" });

    await newProjDialog.locator('button[aria-label="Close"]').click();
    await page.waitForTimeout(140);

    // Ephemeral Forward bounce check: goForward must bounce back and NOT leave a dead Back entry!
    await page.goForward().catch(() => {});
    await page.waitForTimeout(140);
    assert.equal(await page.evaluate(() => window.location.hash), "#/code", "stayed on #/code after Forward bounce");

    await page.goBack();
    await waitForHash(page, "#/", "NewProjectModal X close rewound all 3 steps cleanly");

    await clickGatewayCodeLink(page);
    await waitForHash(page, "#/code", "re-enter #/code after Scenario 5");
    await page.waitForSelector("#rc-composer", { timeout: 8000 });
    await page.waitForTimeout(120);
    console.log("✓ [1440x900] Scenario 5 passed: NewProjectModal multi-folder Back + X multi-step rewind + Forward bounce");

    // 6) PreviewModal + Limit preview slicer drawer -> goBack closes slicer first, then PreviewModal!
    await page.locator("#rc-file-input").setInputFiles({
      name: "migration.sql",
      mimeType: "text/plain",
      buffer: Buffer.from("SELECT pg_advisory_xact_lock(1, 2);\n".repeat(40), "utf8"),
    });
    const chipBtn = page.locator('button[aria-label="Preview migration.sql"]');
    await chipBtn.waitFor({ state: "visible" });
    await chipBtn.click();

    const previewDialog = page.locator('[role="dialog"]:has-text("migration.sql")').first();
    await previewDialog.waitFor({ state: "visible" });

    // Open Limit preview slicer drawer
    await previewDialog.locator('button[aria-label="Limit preview length"]').click();
    await previewDialog.getByText("128K context window share").waitFor({ state: "visible" });

    // goBack #1 closes slicer drawer while keeping PreviewModal open!
    await page.goBack();
    await page.waitForFunction(
      () => !document.body.textContent?.includes("128K context window share"),
      null,
      { timeout: 3000 },
    );
    assert.equal(await previewDialog.isVisible(), true, "PreviewModal stays open after slicer Back");

    // Re-open slicer and test Escape also closes slicer first!
    await previewDialog.locator('button[aria-label="Limit preview length"]').click();
    await previewDialog.getByText("128K context window share").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.body.textContent?.includes("128K context window share"),
      null,
      { timeout: 3000 },
    );
    assert.equal(await previewDialog.isVisible(), true, "PreviewModal stays open after slicer Escape");

    // goBack #2 closes PreviewModal!
    await page.goBack();
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"]:not([data-state="closing"]):not([data-floatmenu])'),
      null,
      { timeout: 3000 },
    );
    await page.locator('button[aria-label="Remove migration.sql"]').click();
    console.log("✓ [1440x900] Scenario 6 passed: PreviewModal + Limit slicer Back & Escape sub-layer unwinding");

    // 7) ConfirmModal (right-click session -> Delete same-tick replaceState) -> goBack cancels deletion!
    const secondRow = page.getByText("Outbox relay backoff jitter audit").first();
    await secondRow.click({ button: "right" });
    const sessionMenu = page.locator('[data-floatmenu][aria-label="Conversation actions"]');
    await sessionMenu.waitFor({ state: "visible" });
    await sessionMenu.getByRole("menuitem", { name: "Delete" }).click();

    const confirmDialog = page.locator('[role="dialog"]:has-text("Delete conversation?")').first();
    await confirmDialog.waitFor({ state: "visible" });

    // goBack cancels ConfirmModal — session still exists, and NO leftover menu:session entry!
    await page.goBack();
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"]:not([data-state="closing"]):not([data-floatmenu])'),
      null,
      { timeout: 3000 },
    );
    assert.equal(await secondRow.isVisible(), true, "session preserved after ConfirmModal Back");
    assert.equal(
      await page.locator('[data-floatmenu][aria-label="Conversation actions"]').count(),
      0,
      "sessionMenu stayed closed",
    );
    console.log("✓ [1440x900] Scenario 7 passed: sessionMenu -> Delete same-tick replaceState + ConfirmModal Back cancel");

    // 8) HistoryView (Ctrl+K), selectionMode, renamingId, editingQueueId -> goBack cancels each!
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Search conversations/i).waitFor({ state: "visible" });
    await page.goBack();
    await page.waitForSelector("#rc-composer", { timeout: 5000 });

    // selectionMode -> goBack exits selection mode
    await page.locator('button[aria-label="Select conversations"]').click();
    await page.locator('button[aria-label="Exit selection mode"]').waitFor({ state: "visible" });
    await page.goBack();
    await page.locator('button[aria-label="Select conversations"]').waitFor({ state: "visible" });

    // renamingId -> right-click session -> Rename -> goBack cancels rename
    await secondRow.click({ button: "right" });
    await sessionMenu.waitFor({ state: "visible" });
    await sessionMenu.getByRole("menuitem", { name: "Rename" }).click();
    const renameInput = page.locator("aside.rc-sidebar input").last();
    await renameInput.waitFor({ state: "visible" });
    await page.goBack();
    await page.waitForTimeout(80);
    assert.equal(await secondRow.isVisible(), true, "rename cancelled via Back");

    // editingQueueId -> click Edit on queued item -> goBack cancels queue edit (plus Escape test!)
    await page.locator("[data-composer-queue-shelf]").hover();
    const editQueueBtn = page.locator('button[aria-label="Edit queued message"]').first();
    await editQueueBtn.waitFor({ state: "visible" });
    await editQueueBtn.click();
    const queueSaveBtn = page.getByRole("button", { name: "Save", exact: true });
    await queueSaveBtn.waitFor({ state: "visible" });
    await page.goBack();
    await page.waitForFunction(
      () => !Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Save"),
      null,
      { timeout: 3000 },
    );

    // editingMsgIdx -> click Edit and resend on user message -> goBack cancels message edit!
    await page.getByText("Guard PostJournal with a transaction-scoped advisory lock.").hover();
    const editMsgBtn = page.locator('button[aria-label="Edit and resend"], button[data-rc-tip="Edit and resend"]').first();
    await editMsgBtn.click({ force: true });
    await page.locator("#rc-editing-msg").waitFor({ state: "visible" });
    await page.goBack();
    await page.locator("#rc-editing-msg").waitFor({ state: "hidden" });

    // GenerativeUiWidget fullscreen -> goBack exits fullscreen, and Escape exits fullscreen!
    const fsBtn = page.locator('button[aria-label="Fullscreen widget"], button[data-rc-tip="Fullscreen widget"]').first();
    await fsBtn.waitFor({ state: "visible", timeout: 5000 });
    await fsBtn.click();
    const exitFsBtn = page.locator('button[aria-label="Exit fullscreen"], button[data-rc-tip="Exit fullscreen"]').first();
    await exitFsBtn.waitFor({ state: "visible" });
    await page.goBack();
    await exitFsBtn.waitFor({ state: "hidden" });
    await assertNoInertOrScrollLockLeak(page, "after GenerativeUiWidget fullscreen Back");

    await fsBtn.click();
    await exitFsBtn.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await exitFsBtn.waitFor({ state: "hidden" });
    await assertNoInertOrScrollLockLeak(page, "after GenerativeUiWidget fullscreen Escape");

    // Desktop Effort -> Switch model -> goBack steps to Effort -> goBack closes Effort!
    await page.locator('button[aria-label^="Switch model:"]').click();
    await page.locator("[data-effort-picker]").waitFor({ state: "visible" });
    await page.locator("button[data-effort-model-btn]").click();
    await page.locator('[data-floatmenu][aria-label="Select model"]').waitFor({ state: "visible" });
    await page.goBack();
    await page.locator("[data-effort-picker]").waitFor({ state: "visible" });
    await page.goBack();
    await page.locator("[data-effort-picker]").waitFor({ state: "hidden" });

    console.log("✓ [1440x900] Scenario 8 passed: HistoryView, selectionMode, renamingId, editingQueueId, editingMsgIdx, GenerativeUiWidget fullscreen, and desktop Effort->Model Back unwinding");

    // 9) savingSettings refusal on Back + rapid triple history.back() during exit animations!
    serverState.holdConfigSave = true;
    await page.locator('button[aria-label*="Settings"]').first().click();
    await settingsDialog.waitFor({ state: "visible" });
    // Toggle a setting to enable Save changes
    await settingsDialog.getByText("Auto-generate conversation titles", { exact: false }).first().click();
    await settingsDialog.getByRole("button", { name: "Save changes" }).click();
    await settingsDialog.getByRole("button", { name: "Saving…" }).waitFor({ state: "visible" });

    // Attempt Back while savingSettings() === true -> refused & bounced back to modal:settings!
    await page.evaluate(() => history.back());
    await page.waitForTimeout(180);
    assert.equal(await settingsDialog.isVisible(), true, "SettingsModal refused Back while saving");
    assert.equal(await page.evaluate(() => (history.state as any)?.key), "modal:settings", "history cursor bounced back to modal:settings");

    // Complete save -> modal closes automatically and rewinds history
    serverState.holdConfigSave = false;
    finishHeldConfigSave();
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"]:not([data-state="closing"]):not([data-floatmenu])'),
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(140);
    await assertNoInertOrScrollLockLeak(page, "after held config save completed");

    // Rapid triple history.back() across 3 stacked layers (HistoryView + NewProjectModal + 1 drilled folder)
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Search conversations/i).waitFor({ state: "visible" });
    await page.locator('button[aria-label="Create new project"]').click();
    await page.locator('[data-floatmenu]').getByText("New project").click();
    await newProjDialog.waitFor({ state: "visible" });
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal"]').click();
    await newProjDialog.locator('button[data-folder-path="/Users/italo/dev/ledger-service/internal/ledger"]').waitFor({ state: "visible" });

    await page.evaluate(() => {
      history.back();
      history.back();
      history.back();
    });
    await page.waitForSelector("#rc-composer", { timeout: 5000 });
    await page.waitForTimeout(260);
    await assertNoInertOrScrollLockLeak(page, "after rapid triple history.back()");
    assert.equal(await page.evaluate(() => window.location.hash), "#/code", "landed on #/code root after triple Back");
    console.log("✓ [1440x900] Scenario 9 passed: savingSettings refusal + rapid triple history.back() with zero [inert] leak");

    // Viewport resize mid-modal (1440x900 -> 390x844 -> Back -> Back -> 1440x900)
    await page.locator('button[aria-label*="Settings"]').first().click();
    await settingsDialog.waitFor({ state: "visible" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    await page.goBack(); // closes SettingsModal
    await waitForSidebar(page, false, "mobile workspace underneath SettingsModal after resize");
    await page.goBack(); // opens mobile sidebar!
    await waitForSidebar(page, true, "mobile sidebar opened after resize Back");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);

    // 11) Clicking `Back to gateway` while multiple history entries exist -> lands on #/ with ZERO stale #/code entries!
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Search conversations/i).waitFor({ state: "visible" });
    await page.locator('aside.rc-sidebar a[href="#/"]').click();
    await waitForHash(page, "#/", "Back to gateway link landed on #/");
    await page.waitForTimeout(150);

    // Verify Forward does NOT re-enter any orphan #/code layer behind Gateway (or if #/code is forward, #/ has nothing behind it)
    const stateAtGateway = await page.evaluate(() => history.state);
    assert.equal(stateAtGateway?.__ic, undefined, "Gateway #/ entry is clean (not an #/code state)");

    await ctx.close();
    console.log("✓ [1440x900] Scenario 11 passed: viewport resize + Back to gateway clean unwind");
  }

  // =========================================================================
  // ZERO-HOST ONBOARDING: Back steps pairing card -> hero CTA -> Gateway #/,
  // plus Onboarding `<- Back to gateway` link!
  // =========================================================================
  {
    resetServerState();
    serverState.hasHosts = false;
    const ctx = await createAuthedContext(browser, {
      width: 390,
      height: 844,
      isMobile: true,
    });
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/#/`, { waitUntil: "domcontentloaded" });
    await clickGatewayCodeLink(page);
    await waitForHash(page, "#/code", "entered zero-host Onboarding");

    await page.getByText("Ready to pair workstation").waitFor({ state: "visible", timeout: 8000 });
    await page.waitForTimeout(120);

    // Back #1 clears pairing card -> shows Connect a host hero CTA!
    await page.goBack();
    await page.getByRole("button", { name: "Connect a host" }).waitFor({ state: "visible" });

    // Back #2 exits #/code to #/!
    await page.goBack();
    await waitForHash(page, "#/", "Onboarding exited to #/");

    // Re-enter Onboarding, wait for pairing card, and click subtle `Back to gateway` link!
    await clickGatewayCodeLink(page);
    await page.getByText("Ready to pair workstation").waitFor({ state: "visible", timeout: 8000 });
    await page.waitForTimeout(120);
    await page.locator('a[href="#/"]:has-text("Back to gateway")').click();
    await waitForHash(page, "#/", "Onboarding Back to gateway link unwound cleanly");

    await ctx.close();
    console.log("✓ [390x844] Onboarding zero-host pairing step + Back to gateway link passed");
  }

  console.log("\nALL 11 LIVE-CHROMIUM BACK-NAVIGATION & LAYER STACK SCENARIOS PASSED!");
} finally {
  await browser.close();
  server.stop(true);
}
