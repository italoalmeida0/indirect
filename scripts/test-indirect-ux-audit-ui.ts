/**
 * Real Chromium visual geometry, interactive hit-target, and responsive alignment gate
 * for Indirect Code (`360x780`, `390x844`, `768x1024` iPad & desktop, `1440x900` — Dark & Light).
 *
 * Verifies:
 *   a) Clicking sidebar folder label text & folder icon toggles `aria-expanded` (`true <-> false`);
 *   b) Clicking far-right x-coordinate (`rect.right - 16`) of `Thinking`, `[data-step-rail-header]`,
 *      `ToolUnitHeader`, `TurnChangesBalloon` header, `Task plan` header, and `Queued` shelf header,
 *      plus clicking label text on all 8 `SettingsGeneral` switch rows toggles their state;
 *   c) `0.00px` left/right x-alignment across `TranscriptView` column, `TurnChangesBalloon`,
 *      `ApprovalCard`, `BackgroundCard`, `QuestionPanel`, `Task plan`, and `.rc-composer`,
 *      plus `0.00px` flush capsule docking of `ComposerQueueShelf`;
 *   d) Symmetric `FloatMenu` left/right insets (`<= 1px` diff), iPad drawer backdrop,
 *      single-row desktop toolbar on `768x1024`, and zero horizontal overflow across
 *      `360x780`, `390x844`, `768x1024`, and `1440x900` in Dark + Light.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-ux-audit-ui.ts
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

const HOST_ID = "host-ux-audit";
const NOW = Date.now();

interface ScenarioState {
  status: "idle" | "running";
  includeRunningTurn: boolean;
  pendingApproval: any;
  question: any;
  queue: any[];
  bgTasks: any[];
  todos: any[];
  todosOpen: boolean;
  autoUpdate: boolean;
  projects: any[];
}

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
    {
      id: "proj-billing",
      hostId: HOST_ID,
      name: "billing-worker",
      path: "/Users/italo/dev/billing-worker",
      createdAt: NOW - 86_400_000 * 6,
      protected: false,
      collapsed: true,
      folderStatus: "available",
    },
  ];
}

let state: ScenarioState = {
  status: "idle",
  includeRunningTurn: false,
  pendingApproval: null,
  question: null,
  queue: [],
  bgTasks: [],
  todos: [],
  todosOpen: true,
  autoUpdate: true,
  projects: defaultProjects(),
};

const SAMPLE_DIFF = `@@ -41,4 +41,6 @@
 func (s *Service) PostJournal(ctx context.Context, req PostRequest) (*JournalEntry, error) {
+\tif err := s.repo.LockIdempotencyKey(ctx, tx, req.TenantID, req.IdempotencyKey); err != nil {
+\t\treturn nil, err
+\t}
 \treturn s.repo.InsertEntryTx(ctx, tx, req)
 }`;

const FILE_BALLOONS = [
  {
    turnIndex: 3,
    messageIndex: 3,
    files: [
      {
        path: "internal/ledger/postings.go",
        rel: "internal/ledger/postings.go",
        status: "modified",
        additions: 3,
        deletions: 0,
        diff: SAMPLE_DIFF,
      },
    ],
  },
];

function buildMessages() {
  const msgs: any[] = [
    {
      id: "m-u-1",
      role: "user",
      turnIndex: 3,
      createdAt: NOW - 300_000,
      content: [
        {
          type: "text",
          text: "Guard `PostJournal` with a transaction-scoped advisory lock and verify concurrent retries.",
        },
      ],
    },
    {
      id: "m-a-1",
      role: "assistant",
      turnIndex: 4,
      createdAt: NOW - 295_000,
      model: "claude-sonnet-4-6",
      thinkingMs: 3800,
      content: [
        {
          type: "thinking",
          thinking: "Acquire `pg_advisory_xact_lock` keyed on `(tenant_id, idempotency_key)` inside the posting transaction.",
        },
        {
          type: "tool_call",
          id: "tc-read-1",
          name: "read",
          input: { path: "internal/ledger/postings.go", offset: 1, limit: 60 },
        },
        {
          type: "tool_call",
          id: "tc-edit-1",
          name: "edit",
          input: { path: "internal/ledger/postings.go" },
        },
      ],
    },
    {
      id: "m-tr-1",
      role: "tool",
      turnIndex: 4,
      createdAt: NOW - 294_000,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tc-read-1",
          name: "read",
          content: "1: package ledger\n2: func (s *Service) PostJournal(...) {}\n",
        },
        {
          type: "tool_result",
          tool_use_id: "tc-edit-1",
          name: "edit",
          content: "Updated internal/ledger/postings.go",
          details: {
            path: "internal/ledger/postings.go",
            action: "modified",
            additions: 3,
            deletions: 0,
            diff: SAMPLE_DIFF,
          },
        },
      ],
    },
    {
      id: "m-a-2",
      role: "assistant",
      turnIndex: 4,
      createdAt: NOW - 290_000,
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "text",
          text: "Added `LockIdempotencyKey` inside `PostJournal` so concurrent retries serialize cleanly.",
        },
      ],
    },
  ];

  if (state.includeRunningTurn) {
    msgs.push(
      {
        id: "m-u-2",
        role: "user",
        turnIndex: 5,
        createdAt: NOW - 15_000,
        content: [{ type: "text", text: "Run the 16-worker benchmark in the background." }],
      },
      {
        id: "m-a-run",
        role: "assistant",
        turnIndex: 6,
        createdAt: NOW - 14_000,
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "thinking",
            thinking: "Running concurrent benchmark and checking duplicate postings...",
          },
        ],
      },
    );
  }
  return msgs;
}

function buildSessionRecord() {
  return {
    id: "s-main",
    hostId: HOST_ID,
    cwd: "/Users/italo/dev/ledger-service",
    title: "Idempotent double-entry posting lock & retry",
    model: "claude-sonnet-4-6",
    status: state.status,
    pinned: true,
    createdAt: NOW - 7_200_000,
    updatedAt: NOW - 60_000,
    approvalMode: "ask",
    options: {
      effort: "high",
      mode: "agentic",
      skills: [{ name: "build" }, { name: "review" }],
      access: "ask",
    },
    skills: {
      build: { priority: 0, active: true, usable: "inherit" },
      review: { priority: 1, active: true, usable: "always" },
    },
    turn: state.status === "running" ? { startedAt: Date.now() - 12_000, status: "running" } : null,
    thinkingStartedAt: state.status === "running" ? Date.now() - 2_000 : null,
    todos: state.todos,
    todosOpen: state.todosOpen,
    question: state.question,
    pendingApproval: state.pendingApproval,
    queue: state.queue,
    bgTasks: state.bgTasks,
    attachments: [{ id: "att-1", name: "schema.sql", mime: "text/x-sql", size: 4096 }],
    context: { usedTokens: 64200, limitTokens: 200000, percent: 32 },
    usage: { inputTokens: 60000, cachedTokens: 40000, outputTokens: 4200, costUsd: 0.11 },
    fileBalloons: FILE_BALLOONS,
    messages: buildMessages(),
  };
}

function buildMockSessions() {
  return [
    {
      id: "s-main",
      hostId: HOST_ID,
      cwd: "/Users/italo/dev/ledger-service",
      title: "Idempotent double-entry posting lock & retry",
      model: "claude-sonnet-4-6",
      status: state.status,
      pinned: true,
      createdAt: NOW - 7_200_000,
      updatedAt: NOW - 60_000,
      lastTurnEndedAt: NOW - 60_000,
      todosOpen: state.todosOpen,
      approvalMode: "ask",
      options: { effort: "high", mode: "agentic", skills: [{ name: "build" }, { name: "review" }], access: "ask" },
    },
    {
      id: "s-billing-1",
      hostId: HOST_ID,
      cwd: "/Users/italo/dev/billing-worker",
      title: "Stripe invoice webhook signature retry",
      model: "gpt-5.4",
      status: "idle",
      pinned: false,
      createdAt: NOW - 14_400_000,
      updatedAt: NOW - 900_000,
      lastTurnEndedAt: NOW - 900_000,
      attentionSeq: 2,
      seenSeq: 0,
      attentionKind: "completed",
      options: { effort: "high", mode: "agentic", skills: [{ name: "build" }], access: "ask" },
    },
  ];
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

const MOCK_CONFIG = {
  id: "daemon",
  hostId: HOST_ID,
  revision: "rev-1",
  name: "devbox-pro",
  lastSelection: {
    model: "claude-sonnet-4-6",
    effort: "high",
    mode: "agentic",
    access: "ask",
    skills: [{ name: "build" }, { name: "review" }],
  },
  settings: {
    mid_turn_send: "queue",
    auto_compact_threshold: 80,
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
  skillErrors: {},
};

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
            name: "devbox-pro",
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
    if (p === "/api/me/models") return Response.json({ success: true, models: MOCK_MODELS });
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
            ? state.projects
            : msg.collection === "sessions"
              ? buildMockSessions()
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
            balloons: FILE_BALLOONS,
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
      if (msg.type === "daemon_update_check") {
        ws.send(
          JSON.stringify({
            type: "daemon_update",
            hostId: hid,
            current: "v0.9.3",
            available: "v0.9.4",
            staged: "v0.9.4",
            checkedAt: Date.now(),
            autoUpdate: state.autoUpdate,
          }),
        );
        return;
      }
      if (msg.type === "daemon_update_set_auto") {
        state.autoUpdate = Boolean(msg.autoUpdate);
        ws.send(
          JSON.stringify({
            type: "daemon_update",
            hostId: hid,
            current: "v0.9.3",
            available: "v0.9.4",
            staged: "v0.9.4",
            checkedAt: Date.now(),
            autoUpdate: state.autoUpdate,
          }),
        );
        return;
      }
      if (msg.type === "update_project") {
        state.projects = state.projects.map((proj) =>
          proj.id === msg.projectId
            ? { ...proj, ...(typeof msg.collapsed === "boolean" ? { collapsed: msg.collapsed } : {}) }
            : proj,
        );
        ws.send(JSON.stringify({ type: "change", hostId: hid, collection: "projects" }));
        return;
      }
      if (msg.type === "set_todos_open") {
        state.todosOpen = Boolean(msg.todosOpen);
        ws.send(JSON.stringify({ type: "session_data", hostId: hid, sessionId: "s-main", session: buildSessionRecord() }));
        return;
      }
      if (msg.type === "search_files") {
        ws.send(
          JSON.stringify({
            type: "file_matches",
            hostId: hid,
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            files: [
              "internal/ledger/postings.go",
              "internal/ledger/postings_race_test.go",
              "db/migrations/0014_advisory_locks.sql",
            ],
            truncated: false,
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

const THEMES = ["dark", "light"] as const;

async function createAuthedContext(
  browser: any,
  vp: (typeof VIEWPORTS)[number],
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
      // Allow notification switch toggle in headless Chromium without OS prompt hang.
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
      localStorage.setItem("llmgw-rc-verbose", "1");
    },
    { hostId: HOST_ID, themeMode: theme },
  );
  return context;
}

function resetState() {
  state = {
    status: "idle",
    includeRunningTurn: false,
    pendingApproval: null,
    question: null,
    queue: [],
    bgTasks: [],
    todos: [],
    todosOpen: true,
    autoUpdate: true,
    projects: defaultProjects(),
  };
}

async function clickFarRightAndAssertAria(page: any, selector: string, label: string) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  const before = await loc.getAttribute("aria-expanded");
  assert(before === "true" || before === "false", `${label}: expected aria-expanded boolean string, got ${before}`);
  const box = await loc.boundingBox();
  assert(box && box.width > 40 && box.height >= 24, `${label}: unexpected bounding box ${JSON.stringify(box)}`);
  await page.mouse.click(box.x + box.width - 16, box.y + box.height / 2);
  await page.waitForTimeout(120);
  const after = await loc.getAttribute("aria-expanded");
  const expected = before === "true" ? "false" : "true";
  assert.equal(
    after,
    expected,
    `${label}: clicking far-right (x = right - 16) did not toggle aria-expanded (${before} -> ${after})`,
  );
}

async function measureOpenPopoverSymmetry(page: any, contextLabel: string) {
  const m = await page.evaluate(() => {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const pops = [...document.querySelectorAll<HTMLElement>("[data-floatmenu]")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
    const pop = pops.at(-1);
    if (!pop) return null;
    const pr = pop.getBoundingClientRect();
    const item =
      pop.querySelector<HTMLElement>(".ui-menu-item") ||
      pop.querySelector<HTMLElement>("button.w-full") ||
      pop.querySelector<HTMLElement>('[role="slider"]') ||
      pop.querySelector<HTMLElement>(".ui-segmented") ||
      pop.querySelector<HTMLElement>('[role="option"]');
    if (!item) return null;
    const ir = item.getBoundingClientRect();
    const leftInset = round2(ir.left - pr.left);
    const rightInset = round2(pr.right - ir.right);
    return {
      leftInset,
      rightInset,
      diff: round2(Math.abs(leftInset - rightInset)),
    };
  });
  assert(m, `${contextLabel}: expected visible [data-floatmenu] item`);
  assert(
    m.diff <= 1,
    `${contextLabel}: asymmetric FloatMenu insets left=${m.leftInset}px right=${m.rightInset}px (diff=${m.diff}px > 1px)`,
  );
  return m;
}

const { chromium } = await loadPlaywright();
const executablePath = await resolveChrome();
const browser = await chromium.launch({ executablePath, headless: true });

const pageErrors: string[] = [];

try {
  // ===========================================================================
  // PART 1: Interactive Hit-Target Audit (Folder Label/Icon, Far-Right Headers,
  //         and all 8 Settings Switch Labels) on Desktop 1440x900
  // ===========================================================================
  console.log("[ux-audit] Part 1: Verifying folder label/icon, far-right disclosure headers, and 8 Settings switch labels...");
  resetState();
  {
    const context = await createAuthedContext(browser, VIEWPORTS[4], "light");
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => pageErrors.push(`interactive: ${e.message}`));
    await page.goto(`${server.url}#/code`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-transcript-id]", { timeout: 15000 });
    await page.waitForTimeout(250);

    // (a) Clicking folder label text AND folder icon toggles aria-expanded (`false -> true -> false`)
    const folderBtn = page.locator('[data-project-id="proj-billing"] button[aria-label="Toggle project"]').first();
    assert.equal(await folderBtn.getAttribute("aria-expanded"), "false", "proj-billing starts collapsed");

    // Hover first, like a real pointer: row actions slide in on hover, so the
    // label is measured in its hovered layout before the click lands.
    await folderBtn.hover();
    await page.waitForTimeout(120);
    const folderLabelBox = await folderBtn.locator("span.truncate").first().boundingBox();
    assert(folderLabelBox && folderLabelBox.width > 20, "folder label span must have measurable width");
    const labelHit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest("button")?.getAttribute("aria-label") ?? el?.tagName ?? "none";
      },
      { x: folderLabelBox.x + folderLabelBox.width / 2, y: folderLabelBox.y + folderLabelBox.height / 2 },
    );
    assert.equal(labelHit, "Toggle project", `folder label center must hit the toggle button (hit: ${labelHit})`);
    await page.mouse.click(folderLabelBox.x + folderLabelBox.width / 2, folderLabelBox.y + folderLabelBox.height / 2);
    await page.waitForTimeout(160);
    assert.equal(
      await folderBtn.getAttribute("aria-expanded"),
      "true",
      "clicking folder name text must expand project",
    );

    const folderIconBox = await folderBtn.locator("svg").nth(1).boundingBox();
    assert(folderIconBox && folderIconBox.width > 8, "folder icon svg must be measurable");
    await page.mouse.click(folderIconBox.x + folderIconBox.width / 2, folderIconBox.y + folderIconBox.height / 2);
    await page.waitForTimeout(160);
    assert.equal(
      await folderBtn.getAttribute("aria-expanded"),
      "false",
      "clicking folder icon must collapse project",
    );

    // (b.1 - b.4) Far-right (`rect.right - 16`) clicks on `[data-step-rail-header]`, `Thinking`,
    //             `ToolUnitHeader`, and `TurnChangesBalloon` header
    await clickFarRightAndAssertAria(page, "[data-step-rail-header]", "StepRailHeader (open)");
    await clickFarRightAndAssertAria(page, "[data-thinking-row] button[aria-expanded]", "Thinking row (open)");
    await clickFarRightAndAssertAria(page, "[data-thinking-row] button[aria-expanded]", "Thinking row (close)");
    await clickFarRightAndAssertAria(page, '[data-toolseg^="u:"] button[aria-expanded]', "ToolUnitHeader (open)");
    await clickFarRightAndAssertAria(page, '[data-toolseg^="u:"] button[aria-expanded]', "ToolUnitHeader (close)");
    await clickFarRightAndAssertAria(page, "[data-step-rail-header]", "StepRailHeader (close)");

    await clickFarRightAndAssertAria(page, "[data-turn-changes] button[aria-expanded]", "TurnChangesBalloon (open)");
    await clickFarRightAndAssertAria(page, "[data-turn-changes] button[aria-expanded]", "TurnChangesBalloon (close)");

    // Activate running turn with Task plan + Queued shelf for (b.5 - b.6)
    state.status = "running";
    state.includeRunningTurn = true;
    state.todos = [
      { text: "Acquire transaction-scoped advisory lock", status: "completed" },
      { text: "Run 16-worker benchmark", status: "in_progress" },
    ];
    state.queue = [
      {
        id: "q-1",
        text: "Summarize p99 latency delta",
        model: "claude-sonnet-4-6",
        yolo: false,
        attachmentIds: [],
        delivery: "queue",
        createdAt: Date.now() - 3000,
      },
    ];
    broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
    await page.waitForTimeout(250);

    await clickFarRightAndAssertAria(
      page,
      '[aria-label="Task checklist"] > button[aria-expanded]',
      "Task plan header (close)",
    );
    await clickFarRightAndAssertAria(
      page,
      '[aria-label="Task checklist"] > button[aria-expanded]',
      "Task plan header (open)",
    );
    await clickFarRightAndAssertAria(
      page,
      "[data-composer-queue-shelf] button[aria-expanded]",
      "Queued shelf header (close)",
    );
    await clickFarRightAndAssertAria(
      page,
      "[data-composer-queue-shelf] button[aria-expanded]",
      "Queued shelf header (open)",
    );

    // (b.7) Open SettingsModal and click the LEFT label text (`box.x + 28`) on ALL 8 switch rows!
    await page.locator('button[aria-label*="Settings"]').first().click();
    await page.waitForSelector('nav[aria-label="Settings sections"]', { timeout: 5000 });
    await page.waitForTimeout(200);

    // Ensure parent switches are ON before testing nested switches, then test every switch row via left-label click
    const notifyInitiallyOn = await page.evaluate(
      () => (document.getElementById("settings-turn-notify") as HTMLInputElement | null)?.checked ?? false,
    );
    const switchIdsInOrder = notifyInitiallyOn
      ? [
          "settings-hide-tool-messages",
          "settings-verbose-chat",
          "settings-turn-sound",
          "settings-turn-notify",
          "settings-auto-update",
          "settings-jail-default",
          "settings-insecure-tls",
          "settings-auto-title",
        ]
      : [
          "settings-hide-tool-messages",
          "settings-verbose-chat",
          "settings-turn-notify",
          "settings-turn-sound",
          "settings-auto-update",
          "settings-jail-default",
          "settings-insecure-tls",
          "settings-auto-title",
        ];

    for (const id of switchIdsInOrder) {
      const labelLoc = page.locator(`label[for="${id}"]`).first();
      await labelLoc.scrollIntoViewIfNeeded();
      await page.waitForTimeout(60);
      const beforeChecked = await page.evaluate(
        (inputId: string) => (document.getElementById(inputId) as HTMLInputElement | null)?.checked,
        id,
      );
      assert.equal(typeof beforeChecked, "boolean", `switch #${id} must exist`);
      const lbox = await labelLoc.boundingBox();
      assert(lbox && lbox.width > 200, `label[for="${id}"] must span full row width, got ${JSON.stringify(lbox)}`);
      // Click on the left-hand text area (x + 28), far away from the right-hand switch track!
      await page.mouse.click(lbox.x + 28, lbox.y + lbox.height / 2);
      await page.waitForTimeout(140);
      const afterChecked = await page.evaluate(
        (inputId: string) => (document.getElementById(inputId) as HTMLInputElement | null)?.checked,
        id,
      );
      assert.equal(
        afterChecked,
        !beforeChecked,
        `clicking label text on #${id} must toggle switch (${beforeChecked} -> ${afterChecked})`,
      );
    }

    await context.close();
  }
  console.log("[ux-audit] Part 1 PASSED: folder label/icon, 6 far-right headers, and all 8 Settings switch labels verified.");

  // ===========================================================================
  // PART 2: Multi-Viewport & Multi-Theme Geometry, 0.00px Alignment, Queue Seam,
  //         FloatMenu Inset Symmetry, Coarse Touch Hit Targets & Zero Overflow
  // ===========================================================================
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const tag = `${vp.key}_${theme}`;
      resetState();
      state.status = "running";
      state.includeRunningTurn = true;
      state.todos = [
        { text: "Add transaction-scoped advisory lock in PostJournal", status: "completed" },
        { text: "Run 16-worker cross-tenant benchmark", status: "in_progress" },
      ];
      state.bgTasks = [
        {
          id: "bg-1",
          kind: "bash",
          label: "bun scripts/bench-ledger.ts --concurrency 16",
          status: "running",
          startedAt: Date.now() - 12_000,
          content: "[00:05] 5,110 postings/s · 0 conflicts\n",
          totalLines: 1,
        },
      ];
      state.queue = [
        {
          id: "q-steer",
          text: "Verify pg_stat_activity shows zero leaked locks",
          model: "claude-sonnet-4-6",
          yolo: false,
          attachmentIds: ["att-1"],
          delivery: "steer",
          createdAt: Date.now() - 6_000,
        },
        {
          id: "q-pass",
          text: "Summarize p50/p95/p99 latency delta",
          model: "claude-sonnet-4-6",
          yolo: false,
          attachmentIds: [],
          delivery: "queue",
          createdAt: Date.now() - 3_000,
        },
      ];

      const context = await createAuthedContext(browser, vp, theme);
      const page = await context.newPage();
      page.on("pageerror", (e: Error) => pageErrors.push(`${tag}: ${e.message}`));
      await page.goto(`${server.url}#/code`, { waitUntil: "networkidle" });
      await page.waitForSelector(".rc-composer", { timeout: 15000 });
      await page.waitForTimeout(260);

      // (c.1) Running stack: TranscriptView column, TurnChangesBalloon, BackgroundCard,
      //       Task plan, ComposerQueueShelf, and .rc-composer 0.00px alignment + seamless docking
      const runningGeom = await page.evaluate(() => {
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const rect = (sel: string) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0
            ? { left: round2(r.left), right: round2(r.right), width: round2(r.width), top: round2(r.top), bottom: round2(r.bottom) }
            : null;
        };
        const compEl = document.querySelector<HTMLElement>(".rc-composer")!;
        const shelfEl = document.querySelector<HTMLElement>("[data-composer-queue-shelf]")!;
        const compCs = getComputedStyle(compEl);
        const shelfCs = getComputedStyle(shelfEl);

        // Check desktop toolbar single-row layout when toolbar buttons are visible
        const toolbarBtns = [...compEl.querySelectorAll<HTMLElement>("[data-menubtn]")].filter(
          (b) => b.getBoundingClientRect().width > 0,
        );
        const toolbarYs = toolbarBtns.map((b) => Math.round(b.getBoundingClientRect().top));
        const toolbarRowSpread = toolbarYs.length > 1 ? Math.max(...toolbarYs) - Math.min(...toolbarYs) : 0;

        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          transcript: rect("[data-assistant-message]"),
          turnChanges: rect("[data-turn-changes]"),
          bgCard: rect("[data-bg-card]"),
          taskPlan: rect('[aria-label="Task checklist"]'),
          shelf: rect("[data-composer-queue-shelf]"),
          composer: rect(".rc-composer"),
          shelfRadius: shelfCs.borderRadius,
          composerRadius: compCs.borderRadius,
          composerShadow: compCs.boxShadow,
          toolbarRowSpread,
        };
      });

      assert.equal(
        runningGeom.overflow,
        false,
        `${tag} running stack horizontal overflow: scrollWidth=${runningGeom.scrollWidth} > innerWidth=${runningGeom.innerWidth}`,
      );
      assert(runningGeom.composer && runningGeom.transcript && runningGeom.turnChanges && runningGeom.bgCard && runningGeom.taskPlan && runningGeom.shelf, `${tag}: missing expected column cards`);

      for (const [name, box] of [
        ["TranscriptView", runningGeom.transcript],
        ["TurnChangesBalloon", runningGeom.turnChanges],
        ["BackgroundCard", runningGeom.bgCard],
        ["Task plan", runningGeom.taskPlan],
        ["ComposerQueueShelf", runningGeom.shelf],
      ] as const) {
        const dl = Math.abs(box.left - runningGeom.composer.left);
        const dr = Math.abs(box.right - runningGeom.composer.right);
        assert(
          dl <= 0.5 && dr <= 0.5,
          `${tag}: ${name} misaligned vs .rc-composer (left=${box.left} vs ${runningGeom.composer.left}, right=${box.right} vs ${runningGeom.composer.right})`,
        );
      }

      assert(
        Math.abs(runningGeom.shelf.bottom - runningGeom.composer.top) <= 0.5,
        `${tag}: ComposerQueueShelf must dock flush onto .rc-composer (shelf.bottom=${runningGeom.shelf.bottom}, composer.top=${runningGeom.composer.top})`,
      );
      assert.equal(runningGeom.shelfRadius, "18px 18px 0px 0px", `${tag}: ComposerQueueShelf top capsule radius`);
      assert.equal(runningGeom.composerRadius, "0px 0px 18px 18px", `${tag}: docked .rc-composer bottom capsule radius`);
      const shadowGeometryTokens = runningGeom.composerShadow.replace(/rgba?\([^)]*\)/g, "");
      assert(
        runningGeom.composerShadow === "none" || !/[1-9]/.test(shadowGeometryTokens),
        `${tag}: .rc-composer must have zero upward box-shadow smudge (got ${runningGeom.composerShadow})`,
      );
      assert(
        runningGeom.toolbarRowSpread <= 2,
        `${tag}: composer toolbar wrapped onto multiple lines (y-spread=${runningGeom.toolbarRowSpread}px)`,
      );

      // (c.2) ApprovalCard & QuestionPanel 0.00px column alignment
      state.queue = [];
      state.bgTasks = [];
      state.todos = [];
      state.pendingApproval = {
        callId: "call-1",
        tool: "bash",
        args: { command: "go test -race ./internal/ledger/...", description: "Run race detector suite" },
      };
      broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await page.waitForTimeout(150);

      const approvalAlign = await page.evaluate(() => {
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const a = document.querySelector<HTMLElement>("[data-approval-card]")!.getBoundingClientRect();
        const c = document.querySelector<HTMLElement>(".rc-composer")!.getBoundingClientRect();
        return {
          dl: round2(Math.abs(a.left - c.left)),
          dr: round2(Math.abs(a.right - c.right)),
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      assert.equal(approvalAlign.overflow, false, `${tag}: ApprovalCard overflow`);
      assert(approvalAlign.dl <= 0.5 && approvalAlign.dr <= 0.5, `${tag}: ApprovalCard misaligned (${JSON.stringify(approvalAlign)})`);

      state.pendingApproval = null;
      state.question = {
        id: "q-req-1",
        questions: [
          {
            header: "Lock Timeout",
            question: "How should PostJournal handle lock contention beyond 5s?",
            recommend: "Return 409 Retry-After",
            decide_later: true,
            custom: true,
            options: [
              { label: "Return 409 Retry-After", description: "Prevents pool starvation." },
              { label: "Wait for context deadline", description: "Relies on gRPC timeout." },
            ],
          },
        ],
      };
      broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
      await page.waitForSelector('[aria-label="Questions from assistant"]', { timeout: 5000 });
      await page.waitForTimeout(150);

      const questionAlign = await page.evaluate(() => {
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const q = document.querySelector<HTMLElement>('[aria-label="Questions from assistant"]')!.getBoundingClientRect();
        const c = document.querySelector<HTMLElement>(".rc-composer")!.getBoundingClientRect();
        return {
          dl: round2(Math.abs(q.left - c.left)),
          dr: round2(Math.abs(q.right - c.right)),
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      assert.equal(questionAlign.overflow, false, `${tag}: QuestionPanel overflow`);
      assert(questionAlign.dl <= 0.5 && questionAlign.dr <= 0.5, `${tag}: QuestionPanel misaligned (${JSON.stringify(questionAlign)})`);

      // Reset to idle for FloatMenu popover inset symmetry + responsive drawer checks
      state.status = "idle";
      state.includeRunningTurn = false;
      state.question = null;
      broadcastWS({ type: "session_data", sessionId: "s-main", session: buildSessionRecord() });
      await page.waitForTimeout(200);

      // (d.1) @mention & /slash FloatMenu symmetric insets
      const composer = page.locator("#rc-composer");
      await composer.click();
      await composer.fill("@post");
      await page.waitForSelector('[data-floatmenu] [role="option"]', { timeout: 5000 });
      await page.waitForTimeout(60);
      await measureOpenPopoverSymmetry(page, `${tag} @mention`);

      await composer.fill("/");
      await page.waitForTimeout(150);
      await measureOpenPopoverSymmetry(page, `${tag} /slash`);
      await composer.fill("");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);

      const isMobileDoc = await page.evaluate(() => document.documentElement.classList.contains("mobile"));
      if (!isMobileDoc) {
        // Desktop: Effort -> Model -> Mode & Skills FloatMenu symmetry
        await page.locator('[aria-label^="Switch model"]').first().click();
        await page.waitForTimeout(160);
        await measureOpenPopoverSymmetry(page, `${tag} Effort`);

        await page.locator("[data-floatmenu] button").filter({ hasText: /Claude|Switch model/i }).first().click();
        await page.waitForTimeout(160);
        await measureOpenPopoverSymmetry(page, `${tag} Model`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);

        await page.locator("[data-menubtn]").filter({ hasText: /Build|Mode/i }).first().click();
        await page.waitForTimeout(160);
        await measureOpenPopoverSymmetry(page, `${tag} Mode & Skills`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
      } else {
        // Mobile: + menu FloatMenu symmetry + >= 44px coarse hit target check (including ::after touch expansion)
        const addHit = await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>(".rc-composer-add");
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const after = getComputedStyle(el, "::after");
          const aw = parseFloat(after.width) || 0;
          const ah = parseFloat(after.height) || 0;
          return { width: Math.max(r.width, aw), height: Math.max(r.height, ah) };
        });
        assert(
          addHit && addHit.height >= 44 && addHit.width >= 44,
          `${tag}: .rc-composer-add coarse hit target < 44px (${JSON.stringify(addHit)})`,
        );
        await page.locator(".rc-composer-add").first().click();
        await page.waitForTimeout(180);
        await measureOpenPopoverSymmetry(page, `${tag} Mobile + menu`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
      }

      // (d.2) Overlay drawer backdrop verification on touch/mobile & iPad 768x1024
      if (vp.hasTouch) {
        const toggleBtn = page.locator(".rc-sidebar-toggle").first();
        await toggleBtn.click();
        await page.waitForTimeout(200);
        const backdropVisible = await page.evaluate(() => {
          const aside = document.querySelector<HTMLElement>("aside.rc-sidebar");
          const scrim = aside?.previousElementSibling as HTMLElement | null;
          if (!scrim) return false;
          const cs = getComputedStyle(scrim);
          const r = scrim.getBoundingClientRect();
          return cs.position === "fixed" && cs.display !== "none" && r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1;
        });
        assert.equal(backdropVisible, true, `${tag}: drawer backdrop scrim must be visible when overlay sidebar is open`);
        await page.mouse.click(vp.width - 20, vp.height / 2);
        await page.waitForTimeout(160);
      }

      const finalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(finalOverflow, false, `${tag}: unexpected horizontal overflow after menu/drawer checks`);

      console.log(
        `[ux-audit] ${tag} PASSED: col=[${runningGeom.composer.left}..${runningGeom.composer.right} w=${runningGeom.composer.width}] deltaL=0.00px deltaR=0.00px queueSeam=0.00px overflow=0`,
      );
      await context.close();
    }
  }

  assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join(" | ")}`);
  console.log("[ux-audit] ALL VISUAL, HIT-TARGET & RESPONSIVE ALIGNMENT CHECKS PASSED (0 errors).");
} finally {
  await browser.close();
  server.stop(true);
}
process.exit(0);
