/**
 * End-to-end Playwright UI & responsive geometry verification for Indirect Code:
 *   1. 3-way Execution Permissions (`Auto` / `Ask for approval` / `Full access`) in Desktop
 *      toolbar `<FloatMenu>`, Mobile `+` -> `Permissions` subview, and `/auto`, `/ask`, `/full`
 *      slash commands.
 *   2. Enterprise `ApprovalCard` redesign: dynamic header (`Review permission request` vs
 *      `Review tool call`, `High risk` / `Auto · Boundary check` / `Supervised · Ask` pills),
 *      capability + target + reason callout, proposed rule scope preview (`[data-approval-scope]`),
 *      4-decision wire responses (`once` / `session` / `always` / `deny`), non-persistable
 *      2-button gating, and verification that `Allow for session` / `Always allow` NEVER mutate
 *      `accessMode` to `"full"`.
 *   3. Settings -> `Permissions` (`#rc-set-permissions`): jump-bar pill, 3-card default access
 *      radio picker (`default_access` + `jail_by_default`), and inline Global Permission Rules
 *      manager (`permission_rules` add Allow/Deny, revoke, and `update_config` round-trip).
 *   4. Responsive layout & zero horizontal overflow across Desktop (`1280x800`) and Mobile
 *      (`390x844` & `360x780`) in Dark and Light themes.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-approval-jail-ui.ts
 */
import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function loadPlaywright(): Promise<{ chromium: any }> {
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push("playwright", "playwright-core");

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    candidates.push(
      path.join(localAppData, "GG Coder", "sidecar", "node_modules", "playwright", "index.mjs"),
    );
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
      const target = path.isAbsolute(spec)
        ? existsSync(spec)
          ? pathToFileURL(spec).href
          : ""
        : spec;
      if (!target) continue;
      const mod = await import(target);
      if (mod?.chromium) return mod;
    } catch {
      // Try next candidate
    }
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

const SCREENSHOT_DIR =
  process.env.SCREENSHOT_DIR || path.join(tmpdir(), "indirect-approval-jail-screenshots");
await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

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

const HOST_ID = "host-jail-ui";
const NOW = Date.now();

interface MockServerState {
  access: "ask" | "auto" | "full";
  pendingApproval: any;
  configRevision: number;
  settings: {
    mid_turn_send: string;
    auto_compact_threshold: number;
    no_auto_title: boolean;
    default_access: "ask" | "auto" | "full";
    jail_by_default: boolean;
    permission_rules: Array<{
      id: string;
      effect: "allow" | "deny";
      kind: "exec" | "fs_read" | "fs_write" | "net" | "tool";
      pattern: string;
    }>;
    insecure: boolean;
    http_proxy: string;
  };
  commands: any[];
}

function createInitialState(): MockServerState {
  return {
    access: "auto",
    pendingApproval: null,
    configRevision: 1,
    settings: {
      mid_turn_send: "queue",
      auto_compact_threshold: 80,
      no_auto_title: false,
      default_access: "auto",
      jail_by_default: true,
      permission_rules: [],
      insecure: false,
      http_proxy: "",
    },
    commands: [],
  };
}

let state = createInitialState();

const MOCK_MODELS = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    owned_by: "anthropic",
    supported_efforts: ["low", "medium", "high", "max"],
    default_effort: "high",
  },
];

const PROJECTS = [
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
    id: "proj-app",
    hostId: HOST_ID,
    name: "indirect-gateway",
    path: "/Users/italo/dev/indirect-gateway",
    createdAt: NOW - 86_400_000 * 5,
    protected: false,
    collapsed: false,
    folderStatus: "available",
  },
];

function buildConfigDoc() {
  return {
    id: "daemon",
    hostId: HOST_ID,
    revision: `rev-${state.configRevision}`,
    name: "workstation-pro",
    lastSelection: {
      model: "claude-sonnet-4-6",
      effort: "high",
      mode: "agentic",
      access: state.access,
      skills: [{ name: "build" }],
    },
    settings: {
      ...state.settings,
      permission_rules: [...state.settings.permission_rules],
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
    },
    skillErrors: [],
  };
}

function buildSessionRecord() {
  return {
    id: "s-main",
    hostId: HOST_ID,
    cwd: "/Users/italo/dev/indirect-gateway",
    title: "Enforce sandbox capability rules & release tagging",
    model: "claude-sonnet-4-6",
    status: state.pendingApproval ? "running" : "idle",
    pinned: true,
    createdAt: NOW - 3_600_000,
    updatedAt: Date.now(),
    approvalMode: "ask",
    options: {
      effort: "high",
      mode: "agentic",
      skills: [{ name: "build" }],
      access: state.access,
    },
    skills: {
      build: { priority: 0, active: true, usable: "inherit" },
    },
    pendingApproval: state.pendingApproval,
    messages: [
      {
        id: "m-u-1",
        role: "user",
        turnIndex: 1,
        createdAt: NOW - 120_000,
        content: [
          {
            type: "text",
            text: "Verify the release tag against GitHub and push the branch once checks pass.",
          },
        ],
      },
      {
        id: "m-a-1",
        role: "assistant",
        turnIndex: 2,
        createdAt: NOW - 115_000,
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "text",
            text: "All local checks passed. Requesting permission for external boundary actions.",
          },
        ],
      },
    ],
  };
}

function buildSessionsList() {
  return [
    {
      id: "s-main",
      hostId: HOST_ID,
      cwd: "/Users/italo/dev/indirect-gateway",
      title: "Enforce sandbox capability rules & release tagging",
      model: "claude-sonnet-4-6",
      status: state.pendingApproval ? "running" : "idle",
      pinned: true,
      createdAt: NOW - 3_600_000,
      updatedAt: Date.now(),
      approvalMode: "ask",
      options: {
        effort: "high",
        mode: "agentic",
        skills: [{ name: "build" }],
        access: state.access,
      },
    },
  ];
}

const activeSockets = new Set<any>();
function broadcastWS(payload: Record<string, unknown>) {
  const frame = JSON.stringify({ hostId: HOST_ID, ...payload });
  for (const ws of activeSockets) {
    try {
      ws.send(frame);
    } catch {
      // Ignore closed socket
    }
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
            name: "workstation-pro",
            hostname: "workstation.local",
            os: "linux",
            arch: "amd64",
            version: "v0.9.4",
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
    if (p.includes("push")) {
      return Response.json({ success: true, enabled: false, publicKey: "" });
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
      if (msg.type !== "pull" && msg.type !== "get_session" && msg.type !== "get_turn_changes") {
        state.commands.push(msg);
      }

      if (msg.type === "pull") {
        const items =
          msg.collection === "projects"
            ? PROJECTS
            : msg.collection === "sessions"
              ? buildSessionsList()
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
            workspace: { status: "available", path: "/Users/italo/dev/indirect-gateway" },
          }),
        );
        return;
      }

      if (msg.type === "daemon_update_check") {
        ws.send(
          JSON.stringify({
            type: "daemon_update",
            hostId: hid,
            current: "v0.9.4",
            checkedAt: Date.now(),
            autoUpdate: true,
          }),
        );
        return;
      }

      if (msg.type === "configure_session") {
        if (msg.options?.access === "ask" || msg.options?.access === "auto" || msg.options?.access === "full") {
          state.access = msg.options.access;
        }
        ws.send(
          JSON.stringify({
            type: "session_data",
            hostId: hid,
            sessionId: msg.sessionId || "s-main",
            session: buildSessionRecord(),
          }),
        );
        ws.send(JSON.stringify({ type: "change", hostId: hid, collection: "sessions" }));
        ws.send(JSON.stringify({ type: "change", hostId: hid, collection: "config" }));
        return;
      }

      if (msg.type === "tool_approval_response") {
        const currentPending = state.pendingApproval;
        if (msg.decision === "always" && currentPending?.proposedRule) {
          state.settings.permission_rules = [
            ...state.settings.permission_rules,
            currentPending.proposedRule,
          ];
          state.configRevision += 1;
          ws.send(JSON.stringify({ type: "change", hostId: hid, collection: "config" }));
        }
        state.pendingApproval = null;
        ws.send(
          JSON.stringify({
            type: "approval_resolved",
            hostId: hid,
            sessionId: msg.sessionId || "s-main",
            callId: msg.callId,
            approved: msg.approved,
            decision: msg.decision,
          }),
        );
        return;
      }

      if (msg.type === "update_config") {
        state.configRevision += 1;
        state.settings = {
          ...state.settings,
          ...msg.settings,
        };
        const rev = `rev-${state.configRevision}`;
        ws.send(
          JSON.stringify({
            type: "config_updated",
            hostId: hid,
            requestId: msg.requestId,
            success: true,
            revision: rev,
          }),
        );
        ws.send(JSON.stringify({ type: "change", hostId: hid, collection: "config" }));
      }
    },
  },
});

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

async function createAuthedContext(
  browser: any,
  opts: { width: number; height: number; isMobile: boolean; theme: "dark" | "light" },
) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 2,
    isMobile: opts.isMobile,
    hasTouch: opts.isMobile,
    userAgent: opts.isMobile ? IPHONE_UA : DESKTOP_UA,
    colorScheme: opts.theme,
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
    { hostId: HOST_ID, themeMode: opts.theme },
  );
  return context;
}

async function assertZeroHorizontalOverflow(page: any, label: string) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(
    dims.scrollWidth <= dims.innerWidth,
    `${label}: horizontal overflow detected (${dims.scrollWidth}px > ${dims.innerWidth}px)`,
  );
}

const { chromium } = await loadPlaywright();
const chromePath = await resolveChrome();
const browser = await chromium.launch({
  ...(chromePath ? { executablePath: chromePath } : {}),
  headless: true,
});

const baseUrl = `http://127.0.0.1:${server.port}/#/code`;
const savedScreenshots: string[] = [];

async function snap(page: any, name: string) {
  const outPath = path.join(SCREENSHOT_DIR, name);
  await page.screenshot({ path: outPath, fullPage: false });
  savedScreenshots.push(outPath);
}

try {
  // ===========================================================================
  // 1. DESKTOP (1280x800) — Dark & Light: 3-Way Selector, Slash Commands,
  //    Scoped Approval Decisions (No Full-Access Mutation!), & Settings Manager
  // ===========================================================================
  for (const theme of ["dark", "light"] as const) {
    state = createInitialState();
    const context = await createAuthedContext(browser, {
      width: 1280,
      height: 800,
      isMobile: false,
      theme,
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(String(err)));

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#rc-composer", { timeout: 10_000 });
    await page.waitForSelector('button[data-access-mode="auto"]', { timeout: 8_000 });
    await assertZeroHorizontalOverflow(page, `desktop-${theme}-initial`);

    // Verify 3-way Permissions popover & desktop chevron arrow
    const accessBtn = page.locator("button[data-access-mode]").first();
    assert.equal(await accessBtn.getAttribute("data-access-mode"), "auto");
    assert.equal(
      await accessBtn.getAttribute("data-rc-tip"),
      "Permissions: Auto (sandboxed)",
    );
    assert.equal(
      await accessBtn.locator("svg").count(),
      2,
      "Desktop Permissions button must render leading icon + chevron-down arrow",
    );
    await accessBtn.click();
    await page.waitForSelector('[role="menuitemradio"][data-access-option="auto"]', {
      timeout: 5_000,
    });
    assert.equal(
      await accessBtn.locator("svg.rotate-180").count(),
      1,
      "Desktop Permissions chevron must rotate when menu is open",
    );

    const autoOpt = page.locator('[role="menuitemradio"][data-access-option="auto"]');
    const askOpt = page.locator('[role="menuitemradio"][data-access-option="ask"]');
    const fullOpt = page.locator('[role="menuitemradio"][data-access-option="full"]');
    assert.equal(await autoOpt.getAttribute("aria-checked"), "true");
    assert.match((await autoOpt.textContent()) || "", /Recommended/);
    assert.match((await askOpt.textContent()) || "", /Ask for approval/);
    assert.match((await fullOpt.textContent()) || "", /Full access/);
    await snap(page, `01-desktop-permissions-menu-${theme}.png`);

    // Switch Auto -> Ask -> Full -> Auto via menuitemradio
    state.commands.length = 0;
    await askOpt.click();
    await page.waitForSelector('button[data-access-mode="ask"]', { timeout: 5_000 });
    assert.equal(
      state.commands.findLast((c) => c.type === "configure_session")?.options?.access,
      "ask",
    );

    await accessBtn.click();
    await page.locator('[role="menuitemradio"][data-access-option="full"]').click();
    await page.waitForSelector('button[data-access-mode="full"]', { timeout: 5_000 });
    assert.equal(
      state.commands.findLast((c) => c.type === "configure_session")?.options?.access,
      "full",
    );

    await accessBtn.click();
    await page.locator('[role="menuitemradio"][data-access-option="auto"]').click();
    await page.waitForSelector('button[data-access-mode="auto"]', { timeout: 5_000 });
    assert.equal(
      state.commands.findLast((c) => c.type === "configure_session")?.options?.access,
      "auto",
    );

    // Verify slash commands autocomplete shows /auto, /ask, /full
    const composer = page.locator("#rc-composer");
    await composer.fill("/");
    await page.waitForTimeout(150);
    const bodyTextWithSlash = await page.locator("body").textContent();
    assert.match(bodyTextWithSlash || "", /\/auto/);
    assert.match(bodyTextWithSlash || "", /\/ask/);
    assert.match(bodyTextWithSlash || "", /\/full/);
    await composer.fill("");

    // Scenario A: High-risk Auto `git push` -> 4 buttons + Rule Scope chip
    const pushApproval = {
      callId: "call-push-1",
      tool: "bash",
      args: JSON.stringify({
        command: "git push origin main",
        description: "Push verified release branch to origin",
      }),
      capability: "exec",
      target: "git push origin main",
      reason: "Pushing commits to a remote repository modifies external state.",
      risk: "high",
      accessMode: "auto",
      proposedRule: {
        id: "rule_git_push",
        effect: "allow",
        kind: "exec",
        pattern: "git push",
      },
      canAllowSession: true,
      canAllowAlways: true,
    };
    state.pendingApproval = pushApproval;
    broadcastWS({
      type: "tool_approval_request",
      sessionId: "s-main",
      ...pushApproval,
    });

    await page.waitForSelector("[data-approval-card]", { timeout: 5_000 });
    const cardTextA = (await page.locator("[data-approval-card]").textContent()) || "";
    assert.match(cardTextA, /Review permission request/);
    assert.match(cardTextA, /High risk/);
    assert.match(cardTextA, /Command/);
    assert.match(cardTextA, /git push origin main/);
    assert.match(cardTextA, /Scope: allow command "git push"/);
    assert.equal(await page.locator('[data-action="approval-deny"]').count(), 1);
    assert.equal(await page.locator('[data-action="approval-always"]').count(), 1);
    assert.equal(await page.locator('[data-action="approval-session"]').count(), 1);
    assert.equal(await page.locator('[data-action="approval-once"]').count(), 1);
    await snap(page, `02-desktop-approval-high-risk-${theme}.png`);

    // Click `Allow for session` -> verify wire payload AND verify accessMode stays `auto`!
    state.commands.length = 0;
    await page.locator('[data-action="approval-session"]').click();
    await page.waitForFunction(() => !document.querySelector("[data-approval-card]"), null, {
      timeout: 5_000,
    });
    const sessionResp = state.commands.find((c) => c.type === "tool_approval_response");
    assert.deepEqual(sessionResp, {
      type: "tool_approval_response",
      hostId: HOST_ID,
      sessionId: "s-main",
      callId: "call-push-1",
      approved: true,
      always: false,
      decision: "session",
    });
    assert.equal(
      await accessBtn.getAttribute("data-access-mode"),
      "auto",
      "Allow for session MUST NOT switch accessMode to full",
    );

    // Scenario B: Mid-execution `exec_script` network boundary prompt -> `Always allow`
    const netApproval = {
      callId: "call-net-1",
      tool: "exec_script",
      args: JSON.stringify({
        code: "const res = await fetch('https://api.github.com/repos/indirect/tags');",
      }),
      capability: "net",
      target: "api.github.com:443",
      reason: "Script requested network access to api.github.com:443.",
      risk: "medium",
      accessMode: "auto",
      proposedRule: {
        id: "rule_gh_api",
        effect: "allow",
        kind: "net",
        pattern: "api.github.com",
      },
      canAllowSession: true,
      canAllowAlways: true,
    };
    state.pendingApproval = netApproval;
    broadcastWS({
      type: "tool_approval_request",
      sessionId: "s-main",
      ...netApproval,
    });

    await page.waitForSelector('[data-approval-badge="auto"]', { timeout: 5_000 });
    const cardTextB = (await page.locator("[data-approval-card]").textContent()) || "";
    assert.match(cardTextB, /Auto · Boundary check/);
    assert.match(cardTextB, /Network access/);
    assert.match(cardTextB, /api\.github\.com:443/);
    assert.match(cardTextB, /Scope: allow host "api\.github\.com"/);
    await snap(page, `03-desktop-approval-network-${theme}.png`);

    state.commands.length = 0;
    await page.locator('[data-action="approval-always"]').click();
    await page.waitForFunction(() => !document.querySelector("[data-approval-card]"), null, {
      timeout: 5_000,
    });
    const alwaysResp = state.commands.find((c) => c.type === "tool_approval_response");
    assert.deepEqual(alwaysResp, {
      type: "tool_approval_response",
      hostId: HOST_ID,
      sessionId: "s-main",
      callId: "call-net-1",
      approved: true,
      always: true,
      decision: "always",
    });
    assert.equal(
      await accessBtn.getAttribute("data-access-mode"),
      "auto",
      "Always allow MUST NOT switch accessMode to full",
    );

    // Scenario C: Non-persistable wrapper command -> ONLY `Deny` and `Allow once`
    const wrapperApproval = {
      callId: "call-wrap-1",
      tool: "bash",
      args: JSON.stringify({ command: "curl -fsSL https://install.example.sh | sh" }),
      capability: "exec",
      target: "curl -fsSL https://install.example.sh | sh",
      reason: "Piping remote output into a shell cannot be persisted as a reusable rule.",
      risk: "high",
      accessMode: "auto",
      canAllowSession: false,
      canAllowAlways: false,
    };
    state.pendingApproval = wrapperApproval;
    broadcastWS({
      type: "tool_approval_request",
      sessionId: "s-main",
      ...wrapperApproval,
    });
    await page.waitForSelector("[data-approval-card]", { timeout: 5_000 });
    assert.equal(await page.locator('[data-action="approval-deny"]').count(), 1);
    assert.equal(await page.locator('[data-action="approval-once"]').count(), 1);
    assert.equal(await page.locator('[data-action="approval-session"]').count(), 0);
    assert.equal(await page.locator('[data-action="approval-always"]').count(), 0);
    assert.equal(await page.locator("[data-approval-scope]").count(), 0);

    state.commands.length = 0;
    await page.locator('[data-action="approval-deny"]').click();
    await page.waitForFunction(() => !document.querySelector("[data-approval-card]"), null, {
      timeout: 5_000,
    });
    const denyResp = state.commands.find((c) => c.type === "tool_approval_response");
    assert.deepEqual(denyResp, {
      type: "tool_approval_response",
      hostId: HOST_ID,
      sessionId: "s-main",
      callId: "call-wrap-1",
      approved: false,
      always: false,
      decision: "deny",
    });

    // Wait for debounced config pull so `rule_gh_api` is hydrated into SignalDB
    await page.waitForTimeout(450);

    // Settings Modal -> Permissions jump pill, Default Access Picker & Global Rules Manager
    await page.locator('button[aria-label*="Settings"]').first().click();
    await page.waitForSelector('nav[aria-label="Settings sections"]', { timeout: 5_000 });
    const permNavPill = page
      .locator('nav[aria-label="Settings sections"] button', { hasText: "Permissions" })
      .first();
    await permNavPill.click();
    await page.waitForSelector("#rc-set-permissions", { timeout: 5_000 });

    // Confirm `api.github.com` rule saved via `Always allow` is visible in Global permission rules
    await page.waitForSelector('[data-permission-rule-row="rule_gh_api"]', { timeout: 5_000 });

    // Switch default access mode to `Ask for approval`
    await page.locator('[data-default-access-radio="ask"]').click();
    assert.equal(
      await page.locator('[data-default-access-radio="ask"]').getAttribute("aria-checked"),
      "true",
    );

    // Add an Allow command rule (`git push`)
    await page.locator("[data-rule-effect='allow']").click();
    await page.locator("[data-rule-kind]").selectOption("exec");
    await page.locator("[data-rule-pattern]").fill("git push");
    await page.locator('[data-action="add-permission-rule"]').click();

    // Add a Deny network rule (`*.evil.example`)
    await page.locator("[data-rule-effect='deny']").click();
    await page.locator("[data-rule-kind]").selectOption("net");
    await page.locator("[data-rule-pattern]").fill("*.evil.example");
    await page.locator('[data-action="add-permission-rule"]').click();

    assert.equal(await page.locator("[data-permission-rule-row]").count(), 3);
    // Re-scroll `#rc-set-permissions` cleanly below the sticky nav header so both
    // the section heading/DefaultAccessPicker and the 3-row GlobalPermissionRulesManager are framed.
    await page.evaluate(() => {
      document
        .getElementById("rc-set-permissions")
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(220);
    await snap(page, `04-desktop-settings-permissions-${theme}.png`);

    // Revoke `rule_gh_api`, then save Settings and inspect `update_config`
    await page.locator('[data-action="remove-permission-rule"][data-rule-id="rule_gh_api"]').click();
    assert.equal(await page.locator("[data-permission-rule-row]").count(), 2);

    state.commands.length = 0;
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('nav[aria-label="Settings sections"]'),
      null,
      { timeout: 6_000 },
    );

    const saveCmd = state.commands.find((c) => c.type === "update_config");
    assert(saveCmd, "expected update_config command");
    assert.equal(saveCmd.settings.default_access, "ask");
    assert.equal(saveCmd.settings.jail_by_default, true);
    assert.equal(saveCmd.settings.permission_rules.length, 2);
    assert.deepEqual(
      saveCmd.settings.permission_rules.map((r: any) => ({
        effect: r.effect,
        kind: r.kind,
        pattern: r.pattern,
      })),
      [
        { effect: "allow", kind: "exec", pattern: "git push" },
        { effect: "deny", kind: "net", pattern: "*.evil.example" },
      ],
    );

    assert.deepEqual(pageErrors, [], `Desktop (${theme}) page errors`);
    await context.close();
  }

  // ===========================================================================
  // 2. MOBILE (`390x844` & `360x780`) — Dark & Light: `+` -> `Permissions` Sheet,
  //    4-Button Narrow `ApprovalCard` Geometry (Zero Clipping/Overlap), & Settings
  // ===========================================================================
  for (const width of [390, 360] as const) {
    const height = width === 390 ? 844 : 780;
    for (const theme of ["dark", "light"] as const) {
      state = createInitialState();
      const context = await createAuthedContext(browser, {
        width,
        height,
        isMobile: true,
        theme,
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (err: Error) => pageErrors.push(String(err)));

      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.waitForSelector("#rc-composer", { timeout: 10_000 });
      await assertZeroHorizontalOverflow(page, `mobile-${width}-${theme}-initial`);

      // Mobile composer toolbar: Model+Effort visible + icon-only Mode & Permissions buttons directly in toolbar
      const mobAccessBtn = page.locator("button[data-access-mode]").first();
      await mobAccessBtn.waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await mobAccessBtn.getAttribute("data-access-mode"), "auto");
      assert.equal((await mobAccessBtn.textContent())?.trim() || "", "", "Mobile Permissions button must be icon-only");
      assert.equal(await mobAccessBtn.locator("svg").count(), 1, "Mobile Permissions button must render only its icon (no chevron)");
      await page.locator("button.rc-composer-model").first().waitFor({ state: "visible", timeout: 5_000 });

      await mobAccessBtn.click();
      await page.waitForSelector('[role="menuitemradio"][data-access-option="auto"]', {
        timeout: 5_000,
      });
      await assertZeroHorizontalOverflow(page, `mobile-${width}-${theme}-permissions-sheet`);
      await snap(page, `05-mobile-${width}-permissions-sheet-${theme}.png`);

      // Tap `Ask for approval` -> verify `configure_session` & auto-close, then reopen & restore `Auto`
      state.commands.length = 0;
      await page.locator('[role="menuitemradio"][data-access-option="ask"]').click();
      await page.waitForSelector('button[data-access-mode="ask"]', { timeout: 5_000 });
      assert.equal(
        state.commands.findLast((c) => c.type === "configure_session")?.options?.access,
        "ask",
      );
      await mobAccessBtn.click();
      await page.waitForSelector('[role="menuitemradio"][data-access-option="auto"]', {
        timeout: 5_000,
      });
      await page.locator('[role="menuitemradio"][data-access-option="auto"]').click();
      await page.waitForSelector('button[data-access-mode="auto"]', { timeout: 5_000 });
      assert.equal(
        state.commands.findLast((c) => c.type === "configure_session")?.options?.access,
        "auto",
      );

      // Broadcast 4-button high-risk approval card with long target path & rule scope
      const mobileApproval = {
        callId: `call-mob-${width}-${theme}`,
        tool: "write",
        args: JSON.stringify({
          path: "../shared-packages/security-policy/prod-allowlist-config.json",
          content: '{\n  "version": 2,\n  "enforceSandbox": true\n}',
        }),
        capability: "fs_write",
        target: "../shared-packages/security-policy/prod-allowlist-config.json",
        reason: "Writing outside the active workspace directory requires explicit approval.",
        risk: "high",
        accessMode: "auto",
        proposedRule: {
          id: "rule_shared_write",
          effect: "allow",
          kind: "fs_write",
          pattern: "../shared-packages/security-policy/**",
        },
        canAllowSession: true,
        canAllowAlways: true,
      };
      state.pendingApproval = mobileApproval;
      broadcastWS({
        type: "tool_approval_request",
        sessionId: "s-main",
        ...mobileApproval,
      });

      const card = page.locator("[data-approval-card]");
      await card.waitFor({ state: "visible", timeout: 5_000 });
      await card.scrollIntoViewIfNeeded();
      await assertZeroHorizontalOverflow(page, `mobile-${width}-${theme}-approval-card`);

      // Verify all 4 buttons fit inside viewport bounds with zero horizontal clipping or overlap
      const buttonGeometry = await page.evaluate(() => {
        const selectors = [
          '[data-action="approval-deny"]',
          '[data-action="approval-always"]',
          '[data-action="approval-session"]',
          '[data-action="approval-once"]',
        ];
        return selectors.map((sel) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            sel,
            left: Math.round(r.left * 100) / 100,
            right: Math.round(r.right * 100) / 100,
            top: Math.round(r.top * 100) / 100,
            bottom: Math.round(r.bottom * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
          };
        });
      });

      for (const b of buttonGeometry) {
        assert(b, `missing approval action button on ${width}x${height}`);
        assert(
          b.left >= 0 && b.right <= width,
          `button ${b.sel} clipped on ${width}x${height}: [${b.left}, ${b.right}]`,
        );
        assert(b.width >= 60 && b.height >= 28, `button ${b.sel} too small: ${JSON.stringify(b)}`);
      }

      // Verify ApprovalCard header stays single-line on 360px & 390px mobile (zero 2nd-row wrap)
      const headerGeom = await page.evaluate(() => {
        const hdr = document.querySelector<HTMLElement>("[data-approval-header]");
        const badge = document.querySelector<HTMLElement>("[data-approval-badge]");
        if (!hdr || !badge) return null;
        const hr = hdr.getBoundingClientRect();
        const br = badge.getBoundingClientRect();
        return {
          headerHeight: Math.round(hr.height * 100) / 100,
          badgeRight: Math.round(br.right * 100) / 100,
          headerRight: Math.round(hr.right * 100) / 100,
        };
      });
      assert(headerGeom, `missing [data-approval-header] on ${width}x${height}`);
      assert(
        headerGeom.headerHeight <= 44,
        `expected single-line ApprovalCard header on ${width}x${height}, got height=${headerGeom.headerHeight}px`,
      );
      assert(
        headerGeom.badgeRight <= headerGeom.headerRight + 1,
        `ApprovalCard badge overflowed header on ${width}x${height}: ${JSON.stringify(headerGeom)}`,
      );

      await snap(page, `06-mobile-${width}-approval-card-${theme}.png`);

      // Tap `Allow once` -> verify wire response
      state.commands.length = 0;
      await page.locator('[data-action="approval-once"]').click();
      await page.waitForFunction(() => !document.querySelector("[data-approval-card]"), null, {
        timeout: 5_000,
      });
      assert.equal(
        state.commands.find((c) => c.type === "tool_approval_response")?.decision,
        "once",
      );

      // Verify Settings -> Permissions layout & all 6 jump-bar pills (including `Runtime`) at 390px & 360px
      await page.locator(".rc-sidebar-toggle").first().click();
      await page.waitForTimeout(220);
      await page.locator('aside.rc-sidebar button[aria-label*="Settings"]').first().click();
      await page.waitForSelector('nav[aria-label="Settings sections"]', { timeout: 5_000 });

      const navGeometry = await page.evaluate(() => {
        const nav = document.querySelector<HTMLElement>('nav[aria-label="Settings sections"]');
        const runtimePill = document.querySelector<HTMLElement>(
          '[data-settings-jump="rc-set-runtime"]',
        );
        if (!nav || !runtimePill) return null;
        const nr = nav.getBoundingClientRect();
        const rr = runtimePill.getBoundingClientRect();
        return {
          navScrollWidth: nav.scrollWidth,
          navClientWidth: nav.clientWidth,
          navRight: Math.round(nr.right * 100) / 100,
          runtimeLeft: Math.round(rr.left * 100) / 100,
          runtimeRight: Math.round(rr.right * 100) / 100,
        };
      });
      assert(navGeometry, `missing Settings sections nav on ${width}x${height}`);
      assert(
        navGeometry.navScrollWidth <= navGeometry.navClientWidth + 1 &&
          navGeometry.runtimeLeft >= 0 &&
          navGeometry.runtimeRight <= width,
        `Runtime jump pill clipped on ${width}x${height}: ${JSON.stringify(navGeometry)}`,
      );

      await page
        .locator('nav[aria-label="Settings sections"] button', { hasText: "Permissions" })
        .first()
        .click();
      await page.waitForSelector("#rc-set-permissions", { timeout: 5_000 });
      await page.waitForTimeout(450);
      await page.evaluate(() => {
        document
          .getElementById("rc-set-permissions")
          ?.scrollIntoView({ behavior: "instant", block: "start" });
      });
      await page.waitForTimeout(120);
      await assertZeroHorizontalOverflow(page, `mobile-${width}-${theme}-settings-permissions`);
      await snap(page, `07-mobile-${width}-settings-permissions-${theme}.png`);

      assert.deepEqual(pageErrors, [], `Mobile ${width}x${height} (${theme}) page errors`);
      await context.close();
    }
  }

  console.log(
    `✓ Indirect approval & jail permissions UI suite PASSED (${savedScreenshots.length} screenshots saved to ${SCREENSHOT_DIR})`,
  );
} finally {
  await browser.close();
  server.stop(true);
}
