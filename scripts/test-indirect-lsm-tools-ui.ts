/**
 * scripts/test-indirect-lsm-tools-ui.ts — deterministic full-stack Chromium UI
 * verification for LSM context management & context tools:
 *   - Foreground >20KB `bash` arrival spill (`[data-arrival-spill]`, stripped
 *     raw trailer, `[data-tool-footer]` "saved full output ... to brain")
 *   - Multi-era `CompactionBalloon` (`b1`, `b2`), Era Timeline expand/collapse,
 *     and `[data-compaction-boundary-caption]` with earlier turns above
 *   - `session_history` (`action: "search"`) BM25 hit cards, score badge,
 *     `<mark>` query highlights, message/era badges, hidden `recall: {...}` hints
 *   - `session_history` (`action: "recall"`) `"Verbatim history recall"`, `b1`,
 *     `"paginated"` badge (`max_chars: 800`), segmented `msg #` cards
 *   - `explore` subagent live in-flight header (`Exploring`, `[data-explore-step]`
 *     `step 1`/`step 2`, ticking `[data-tool-duration]`) + completed bespoke
 *     body (`[data-tool-context="explore"]`, `"Read-only investigation"`, task,
 *     `focus_paths` chips, turns/calls/token badges, `<StreamingMarkdown>` HTML)
 *   - Full browser reload durability (`await page.reload()`) from persisted WAL
 *     envelopes (`<tool_result ...attrs...>body</tool_result>`) without live
 *     transient `Details`
 *   - Zero `pageerror`s, zero console errors, and `scrollWidth <= clientWidth`
 *     across both `1280x840` desktop and `390x844` mobile viewports
 *
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-lsm-tools-ui.ts
 *
 * Prerequisites: web dist/ built (`bun run build:web`), daemon binary built
 * (`bun run build:daemon`).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
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
    } catch {
      // try next candidate
    }
  }
  console.error("Playwright module not found: set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs");
  process.exit(2);
}

const { chromium } = await loadPlaywright();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(ROOT, "..");
const MODEL = "mock-lsm-tools-v1";
const SPILL_DIAG_TOKEN = "SPILL_DIAG_771";
const EXPLORE_TASK = "Investigate router timeout constants and retry wiring across src/";
const EXPLORE_FOCUS_PATHS = ["src/router.ts", "src/service.ts"];

const daemonBin = path.join(
  WS,
  "indirect-code-daemon",
  "bin",
  process.platform === "win32" ? "indirect-code.exe" : "indirect-code",
);
if (!(await fs.stat(daemonBin).catch(() => null))) {
  console.error(`daemon binary missing (${daemonBin}): run bun run build:daemon first`);
  process.exit(2);
}
if (!(await fs.stat(path.join(WS, "dist", "index.html")).catch(() => null))) {
  console.error("web dist/ missing: run bun run build:web first");
  process.exit(2);
}

async function resolveChrome(): Promise<string> {
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
      if (cand && (await fs.stat(cand).catch(() => null))) return cand;
    }
  }
  const unixCache = path.join(process.env.HOME || homedir(), ".cache", "ms-playwright");
  const unixDirs = [
    ...new Set([
      ...(await fs.readdir(unixCache).catch(() => [] as string[]))
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .reverse(),
      "chromium-1243",
      "chromium-1234",
      "chromium-1228",
    ]),
  ];
  for (const d of unixDirs) {
    for (const c of [
      path.join(unixCache, d, "chrome-linux64", "chrome"),
      path.join(unixCache, d, "chrome-linux", "chrome"),
    ]) {
      if (await fs.stat(c).catch(() => null)) return c;
    }
  }
  for (const b of ["chromium", "chromium-browser", "google-chrome", "chrome", "msedge"]) {
    const found = Bun.which(b);
    if (found) return found;
  }
  console.error("no Chrome/Edge found: set CHROMIUM_PATH");
  process.exit(2);
}

const KNOWN_CONSOLE_NOISE = [/Content Security Policy.*accounts\.google\.com/i, /gsi\/client/i];
function assertNoPageErrors(pageErrors: string[], consoleErrors: string[], where: string) {
  assert.deepEqual(pageErrors, [], `${where}: page errors: ${pageErrors.join(" | ")}`);
  const fresh = consoleErrors.filter((m) => !KNOWN_CONSOLE_NOISE.some((re) => re.test(m)));
  assert.deepEqual(fresh, [], `${where}: console errors: ${fresh.join(" | ")}`);
}

async function assertNoHorizontalOverflow(page: any, where: string) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    dims.scrollWidth <= dims.clientWidth,
    `${where}: horizontal overflow detected (scrollWidth=${dims.scrollWidth} > clientWidth=${dims.clientWidth})`,
  );
}

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function textOfMessage(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : JSON.stringify(p)))
      .join("\n");
  }
  return "";
}

type MockReply =
  | { kind: "text"; text: string; inTok?: number; outTok?: number }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; inTok?: number; outTok?: number };

let callSeq = 0;
function nextCallId(prefix: string): string {
  callSeq += 1;
  return `${prefix}_${callSeq}`;
}

function buildOpenAIResponse(model: string, stream: boolean, reply: MockReply): Response {
  const inTok = reply.inTok ?? 420;
  const outTok = reply.outTok ?? 95;
  const usage = {
    prompt_tokens: inTok,
    completion_tokens: outTok,
    total_tokens: inTok + outTok,
  };
  const respId = `chatcmpl-mock-${callSeq + 1}`;

  if (stream) {
    const sseFrame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
    let body = "";
    if (reply.kind === "text") {
      body += sseFrame({
        id: respId,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
      body += sseFrame({
        id: respId,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }],
      });
      body += sseFrame({
        id: respId,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    } else {
      body += sseFrame({
        id: respId,
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: reply.id,
                  type: "function",
                  function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      body += sseFrame({
        id: respId,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      });
    }
    body += sseFrame({
      id: respId,
      object: "chat.completion.chunk",
      model,
      choices: [],
      usage,
    });
    body += "data: [DONE]\n\n";
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  if (reply.kind === "text") {
    return Response.json({
      id: respId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }],
      usage,
    });
  }
  return Response.json({
    id: respId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: reply.id,
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage,
  });
}

let compactSeq = 0;

// Deterministic OpenAI-compatible mock upstream driving main turns, /compact
// summarization forks, and the multi-step read-only `explore` subagent.
const mockUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) {
      return Response.json({ error: { message: `unexpected path ${url.pathname}`, type: "invalid_request_error" } }, { status: 404 });
    }
    const body: any = await req.json().catch(() => ({}));
    const model = String(body.model || MODEL);
    const stream = Boolean(body.stream);
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const systemText = messages
      .filter((m) => m?.role === "system")
      .map(textOfMessage)
      .join("\n");
    const allText = messages.map(textOfMessage).join("\n");

    // 1. Forked / standalone compaction summarizer: MUST return plain Markdown, zero tool calls.
    if (
      allText.includes("INTERNAL COMPACTION FORK") ||
      systemText.includes("context-checkpointing summarizer")
    ) {
      compactSeq += 1;
      const summaryMd = [
        "### Goal",
        `Maintain pipeline diagnostics and router retry invariants (checkpoint ${compactSeq}).`,
        "",
        "### Progress",
        "- Audited `src/service.ts` retry ceiling and `src/router.ts` timeout settings.",
        "- Captured full diagnostic stream to `brain/` and recorded exit-2 validation check.",
      ].join("\n");
      return buildOpenAIResponse(model, stream, {
        kind: "text",
        text: summaryMd,
        inTok: 1240,
        outTok: 165,
      });
    }

    // 2. Isolated read-only `explore` subagent: 2 tool steps (`search` -> `read`)
    //    with deliberate holds so Chromium observes live `step 1`/`step 2` badges
    //    and ticking `[data-tool-duration]` before rich Markdown synthesis lands.
    if (systemText.includes("isolated, read-only codebase and session-history research subagent")) {
      const subToolResults = messages.filter((m) => m?.role === "tool").length;
      if (subToolResults === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_exp_search"),
          name: "search",
          args: { pattern: "ROUTER_TIMEOUT_MS", path: "src" },
          inTok: 340,
          outTok: 48,
        });
      }
      if (subToolResults === 1) {
        await Bun.sleep(550);
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_exp_read"),
          name: "read",
          args: { path: "src/router.ts" },
          inTok: 490,
          outTok: 42,
        });
      }
      await Bun.sleep(1550);
      const synthesis = [
        "### Architecture Findings",
        "",
        "- `src/router.ts` defines `ROUTER_TIMEOUT_MS = 4500` for upstream request deadlines.",
        "- `src/service.ts` composes `createRouterConfig()` inside `dispatchWithRetry` (`MAX_RETRIES = 4`).",
        "- Read-only inspection confirmed deterministic error propagation across router hops.",
      ].join("\n");
      return buildOpenAIResponse(model, stream, {
        kind: "text",
        text: synthesis,
        inTok: 710,
        outTok: 155,
      });
    }

    // 3. Auxiliary no-tool helper calls (e.g. session title generator if ever invoked).
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return buildOpenAIResponse(model, stream, {
        kind: "text",
        text: "LSM Tools Verification",
        inTok: 60,
        outTok: 12,
      });
    }

    // 4. Main agentic turns routed deterministically via `[TURN_TAG:...]` in the latest user prompt.
    let turnTag = "";
    let lastTagIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "user") continue;
      const m = /\[TURN_TAG:([A-Z0-9_]+)\]/.exec(textOfMessage(messages[i]));
      if (m) {
        turnTag = m[1]!;
        lastTagIdx = i;
        break;
      }
    }
    const turnToolResults =
      lastTagIdx >= 0 ? messages.slice(lastTagIdx + 1).filter((m) => m?.role === "tool").length : 0;

    if (turnTag === "T1_SPILL_AND_OPS") {
      if (turnToolResults === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_bash_spill"),
          name: "bash",
          args: { command: "sleep 1 && cat pipeline_diag.log" },
        });
      }
      if (turnToolResults === 1) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_read_svc"),
          name: "read",
          args: { path: "src/service.ts" },
        });
      }
      if (turnToolResults === 2) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_edit_svc"),
          name: "edit",
          args: {
            path: "src/service.ts",
            old_string: "export const MAX_RETRIES = 2;",
            new_string: "export const MAX_RETRIES = 4;",
          },
        });
      }
      if (turnToolResults === 3) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_bash_fail"),
          name: "bash",
          args: { command: "echo 'simulated validation failure' >&2; exit 2" },
        });
      }
      return buildOpenAIResponse(model, stream, {
        kind: "tool",
        id: nextCallId("call_finish_t1"),
        name: "finish_entire_request",
        args: {
          final_message_to_user:
            "Captured full diagnostic output, updated `src/service.ts` retry ceiling, and recorded validation check.",
        },
      });
    }

    if (turnTag === "T2_ERA1_PAD") {
      if (turnToolResults === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_read_router"),
          name: "read",
          args: { path: "src/router.ts" },
        });
      }
      return buildOpenAIResponse(model, stream, {
        kind: "tool",
        id: nextCallId("call_finish_t2"),
        name: "finish_entire_request",
        args: { final_message_to_user: "Inspected `src/router.ts` timeout configuration." },
      });
    }

    if (
      turnTag === "T3_ERA1_PAD" ||
      turnTag === "T4_ERA2_STEP1" ||
      turnTag === "T5_ERA2_STEP2" ||
      turnTag === "T6_ERA2_STEP3"
    ) {
      if (turnToolResults === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId(`call_echo_${turnTag.toLowerCase()}`),
          name: "bash",
          args: { command: `echo checkpoint-${turnTag.toLowerCase()}` },
        });
      }
      return buildOpenAIResponse(model, stream, {
        kind: "tool",
        id: nextCallId(`call_finish_${turnTag.toLowerCase()}`),
        name: "finish_entire_request",
        args: { final_message_to_user: `Completed checkpoint ${turnTag}.` },
      });
    }

    if (turnTag === "T7_LIVE_CONTEXT_SUITE") {
      if (turnToolResults === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_hist_search"),
          name: "session_history",
          args: { action: "search", query: SPILL_DIAG_TOKEN },
        });
      }
      if (turnToolResults === 1) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_hist_recall"),
          name: "session_history",
          args: { action: "recall", block_id: "b1", max_chars: 800 },
        });
      }
      if (turnToolResults === 2) {
        return buildOpenAIResponse(model, stream, {
          kind: "tool",
          id: nextCallId("call_explore_arch"),
          name: "explore",
          args: {
            task: EXPLORE_TASK,
            focus_paths: EXPLORE_FOCUS_PATHS,
          },
        });
      }
      return buildOpenAIResponse(model, stream, {
        kind: "tool",
        id: nextCallId("call_finish_t7"),
        name: "finish_entire_request",
        args: {
          final_message_to_user:
            "Verified `SPILL_DIAG_771` via BM25 history search, recalled `b1` verbatim window, and completed read-only `explore` audit.",
        },
      });
    }

    return buildOpenAIResponse(model, stream, {
      kind: "tool",
      id: nextCallId("call_finish_fallback"),
      name: "finish_entire_request",
      args: { final_message_to_user: "Completed turn." },
    });
  },
});

const MOCK_UPSTREAM_URL = `http://127.0.0.1:${mockUpstream.port}/v1`;
const GW_PORT = Number(process.env.E2E_LSM_TOOLS_GW_PORT || 4627);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-lsm-tools-pass-1";
const procs: Array<{ kill: () => void }> = [];
const tempDirs: string[] = [];

async function boot() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-lsm-tools-"));
  tempDirs.push(dataDir);
  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: WS,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(GW_PORT),
      DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_URL: GW,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(gwProc);

  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${GW}/api/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 20000) throw new Error("gateway never came up");
    await Bun.sleep(150);
  }

  const login: any = await (
    await fetch(`${GW}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
    })
  ).json();
  assert(login.success, "admin login failed");
  const jwt = login.accessToken;
  const auth = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };

  const provRes: any = await (
    await fetch(`${GW}/api/admin/providers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mock-lsm-provider",
        openaiBaseUrl: MOCK_UPSTREAM_URL,
        apiKey: "mock-key",
        openaiAuthStyle: "bearer",
      }),
    })
  ).json();
  assert(provRes.success, `provider create failed: ${JSON.stringify(provRes)}`);
  const list: any = await (await fetch(`${GW}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  const providerId = (list.providers || []).find((p: any) => p.name === "mock-lsm-provider")?.id;
  assert(providerId, "mock-lsm-provider id missing");

  const mkModel: any = await (
    await fetch(`${GW}/api/admin/models`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: MODEL, providerId, upstreamModel: MODEL, contextLength: 128000 }),
    })
  ).json();
  assert(mkModel.success, `model create failed: ${JSON.stringify(mkModel)}`);

  const pair: any = await (
    await fetch(`${GW}/api/indirect-code/pair`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` } })
  ).json();
  assert(pair.success && pair.connectUrl, "pairing failed");

  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-lsm-tools-d-"));
  tempDirs.push(daemonDir);
  const workDir = path.join(daemonDir, "workspace");
  mkdirSync(path.join(workDir, "src"), { recursive: true });

  if (process.platform === "win32") {
    const cachedUnish = path.join(homedir(), ".indirect-code", "external", "bin", "unish.exe");
    if (existsSync(cachedUnish)) {
      const destUnish = path.join(daemonDir, "external", "bin", "unish.exe");
      mkdirSync(path.dirname(destUnish), { recursive: true });
      copyFileSync(cachedUnish, destUnish);
    }
  }

  // Seed workspace files: >25KB 600-line diagnostic log + TypeScript source files.
  const diagLines: string[] = [];
  for (let i = 1; i <= 600; i++) {
    if (i === 300) {
      diagLines.push(
        `[2026-11-12T00:10:00Z] [ERROR] ${SPILL_DIAG_TOKEN}: corrupted WAL frame header in partition-19`,
      );
    } else {
      diagLines.push(
        `[2026-11-12T00:09:${String(i % 60).padStart(2, "0")}Z] [INFO] worker-${String(i).padStart(3, "0")} streaming batch segment status=nominal bytes=4096`,
      );
    }
  }
  const diagPayload = diagLines.join("\n") + "\n";
  assert(
    Buffer.byteLength(diagPayload, "utf8") > 35000,
    `expected >35KB diagnostic fixture, got ${Buffer.byteLength(diagPayload, "utf8")} bytes`,
  );
  writeFileSync(path.join(workDir, "pipeline_diag.log"), diagPayload, "utf8");
  writeFileSync(
    path.join(workDir, "src", "router.ts"),
    [
      "export const ROUTER_TIMEOUT_MS = 4500;",
      "export function createRouterConfig() {",
      "  return { timeoutMs: ROUTER_TIMEOUT_MS, keepAlive: true };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(workDir, "src", "service.ts"),
    [
      'import { createRouterConfig } from "./router";',
      "export const MAX_RETRIES = 2;",
      "export function dispatchWithRetry() {",
      "  return { router: createRouterConfig(), retries: MAX_RETRIES };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "LSM Tools UI Host"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" },
  );
  procs.push(daemonProc);

  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/indirect-code/ws?token=${encodeURIComponent(jwt)}`);
  let reqId = 0;
  const pending = new Map<string, (v: any) => void>();
  let hostId = "";
  const send = (payload: any) => {
    payload.requestId = `r${++reqId}`;
    payload.hostId = hostId;
    ws.send(JSON.stringify(payload));
    return new Promise<any>((resolve) => {
      pending.set(payload.requestId, resolve);
      setTimeout(() => {
        if (pending.has(payload.requestId)) {
          pending.delete(payload.requestId);
          resolve(undefined);
        }
      }, 30000);
    });
  };
  const events: any[] = [];
  await new Promise<void>((res) => {
    ws.onopen = () => res();
  });
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.requestId && pending.has(msg.requestId)) {
        pending.get(msg.requestId)!(msg);
        pending.delete(msg.requestId);
        return;
      }
      events.push(msg);
    } catch {}
  };

  const start = Date.now();
  while (!hostId && Date.now() - start < 20000) {
    const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
    const f = (h.hosts || []).find((x: any) => x.name === "LSM Tools UI Host" && x.status === "online");
    if (f) hostId = f.id;
    else await Bun.sleep(250);
  }
  assert(hostId, "daemon host never came online");
  await send({ type: "config", settings: { auto_compact_threshold: 0 } });
  log("boot", `mock=${MOCK_UPSTREAM_URL} gw=${GW} host=${hostId}`);
  return { jwt, login, hostId, ws, send, daemonDir, workDir, events };
}

async function waitForTurnDone(ctx: any, sessionId: string, eventStart: number, timeoutMs = 45000) {
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(250);
    const finishedEv = ctx.events
      .slice(eventStart)
      .some((e: any) => e?.type === "turn_finished" && e?.sessionId === sessionId);
    if (finishedEv) {
      const data: any = await ctx.send({ type: "get_session", sessionId });
      const st = data?.session?.status;
      if (st && st !== "running") return data;
    }
    if (Date.now() - t0 >= timeoutMs) {
      const data: any = await ctx.send({ type: "get_session", sessionId });
      throw new Error(
        `turn timed out after ${timeoutMs}ms (status=${data?.session?.status}, msgs=${data?.session?.messages?.length})`,
      );
    }
  }
}

async function runTurn(ctx: any, sessionId: string, text: string) {
  const eventStart = ctx.events.length;
  ctx.ws.send(
    JSON.stringify({
      type: "prompt",
      hostId: ctx.hostId,
      sessionId,
      model: MODEL,
      yolo: true,
      text,
    }),
  );
  return waitForTurnDone(ctx, sessionId, eventStart);
}

async function waitForCompactionCount(ctx: any, sessionId: string, wantCount: number, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(250);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    if ((data?.session?.compaction?.count ?? 0) >= wantCount) return data;
    if (Date.now() - t0 >= timeoutMs) {
      throw new Error(`compaction count ${wantCount} did not land within ${timeoutMs}ms`);
    }
  }
}

async function loadAllOlderTurns(page: any) {
  for (let guard = 0; guard < 15; guard++) {
    const btn = page.locator('button:has-text("Load older turns")').first();
    if ((await btn.count()) === 0) break;
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click();
    await page.waitForTimeout(450);
  }
}

async function expandAllTurnDisclosures(page: any) {
  const aggs = page.locator('[data-assistant-message] button[class*="group/agg"][aria-expanded="false"]');
  const aggCount = await aggs.count();
  for (let i = 0; i < aggCount; i++) {
    const b = aggs.nth(0);
    if ((await b.count()) === 0) break;
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click();
    await page.waitForTimeout(120);
  }
  const subGroups = page.locator('[data-toolseg^="g:"] > button[aria-expanded="false"]');
  const grpCount = await subGroups.count();
  for (let i = 0; i < grpCount; i++) {
    const b = subGroups.nth(0);
    if ((await b.count()) === 0) break;
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click();
    await page.waitForTimeout(120);
  }
}

async function ensureToolRowExpanded(page: any, rowText: string) {
  const header = page.locator('div[class*="group/tool"]', { hasText: rowText }).first();
  assert((await header.count()) > 0, `expected tool header matching "${rowText}"`);
  await header.scrollIntoViewIfNeeded();
  const unit = header.locator("..");
  const isOpen = await header.evaluate((el: HTMLElement) => {
    const disc = el.nextElementSibling as HTMLElement | null;
    return Boolean(disc && disc.style.display !== "none");
  });
  if (!isOpen) {
    await header.click();
    await page.waitForTimeout(250);
  }
  const openAfter = await header.evaluate((el: HTMLElement) => {
    const disc = el.nextElementSibling as HTMLElement | null;
    return Boolean(disc && disc.style.display !== "none");
  });
  assert(openAfter, `tool row "${rowText}" should expand on click`);
  return { header, unit };
}

async function verifyAllFourExpandedTools(page: any, phaseLabel: string) {
  await loadAllOlderTurns(page);
  await expandAllTurnDisclosures(page);

  // 1. Spilled `bash` row (`sleep 1 && cat pipeline_diag.log`)
  const spillRow = await ensureToolRowExpanded(page, "pipeline_diag.log");
  const spillHeaderText = ((await spillRow.header.textContent()) || "").trim();
  const spillDuration = ((await spillRow.header.locator("[data-tool-duration]").textContent()) || "").trim();
  assert(/\d+s/.test(spillDuration), `${phaseLabel}: spilled bash header must show duration, got "${spillDuration}"`);

  const spillBanner = spillRow.unit.locator("[data-arrival-spill]");
  assert(await spillBanner.isVisible(), `${phaseLabel}: [data-arrival-spill] banner must be visible`);
  const spillBannerText = ((await spillBanner.textContent()) || "").trim();
  assert(
    /brain\/tool-.*\.log/.test(spillBannerText),
    `${phaseLabel}: [data-arrival-spill] must name brain/tool-*.log, got "${spillBannerText}"`,
  );
  assert(/600\s*lines/.test(spillBannerText), `${phaseLabel}: [data-arrival-spill] must show 600 lines, got "${spillBannerText}"`);
  assert(/KB/i.test(spillBannerText), `${phaseLabel}: [data-arrival-spill] must show KB size, got "${spillBannerText}"`);

  const spillUnitText = ((await spillRow.unit.textContent()) || "").trim();
  assert(spillUnitText.includes(SPILL_DIAG_TOKEN), `${phaseLabel}: spilled bash preview must preserve ${SPILL_DIAG_TOKEN}`);
  assert(
    !spillUnitText.includes("[Full output saved to"),
    `${phaseLabel}: CodeBlock stdout must strip raw "[Full output saved to ...]" trailer`,
  );

  const spillFooter = spillRow.unit.locator("[data-tool-footer]");
  assert(await spillFooter.isVisible(), `${phaseLabel}: spilled bash [data-tool-footer] must be visible`);
  const spillFooterText = ((await spillFooter.textContent()) || "").trim();
  assert(
    spillFooterText.includes("saved full output") && spillFooterText.includes("brain"),
    `${phaseLabel}: [data-tool-footer] must display saved full output to brain, got "${spillFooterText}"`,
  );

  // 2. `session_history` (`action: "search"`)
  const searchRow = await ensureToolRowExpanded(page, "Searched history");
  const searchHeaderText = ((await searchRow.header.textContent()) || "").trim();
  assert(
    /\d+\s*match/.test(searchHeaderText),
    `${phaseLabel}: session_history search header must show match count stat, got "${searchHeaderText}"`,
  );
  const searchCtx = searchRow.unit.locator('[data-tool-context="session-history"]');
  assert(await searchCtx.isVisible(), `${phaseLabel}: search [data-tool-context="session-history"] must be visible`);
  const searchBodyText = ((await searchCtx.textContent()) || "").trim();
  assert(searchBodyText.includes("BM25 history search"), `${phaseLabel}: search body must render BM25 header`);
  assert(/score\s+\d+\.\d{2}/.test(searchBodyText), `${phaseLabel}: search body must render BM25 score badge, got "${searchBodyText}"`);
  assert(/msg\s+#\d+/.test(searchBodyText), `${phaseLabel}: search body must render msg # badge, got "${searchBodyText}"`);
  assert(/era\s+b1/.test(searchBodyText), `${phaseLabel}: search body must render era b1 badge, got "${searchBodyText}"`);
  assert(
    !searchBodyText.includes("recall: {"),
    `${phaseLabel}: search body must hide raw recall: {...} JSON hints`,
  );
  const highlightedMarks = await searchCtx.locator("mark").allTextContents();
  assert(
    highlightedMarks.some((t: string) => t.toUpperCase().includes("SPILL_DIAG_771")),
    `${phaseLabel}: search body must highlight SPILL_DIAG_771 in <mark>, got ${JSON.stringify(highlightedMarks)}`,
  );

  // 3. `session_history` (`action: "recall"`)
  const recallRow = await ensureToolRowExpanded(page, "Recalled history");
  const recallHeaderText = ((await recallRow.header.textContent()) || "").trim();
  assert(
    recallHeaderText.includes("b1") && recallHeaderText.includes("paginated"),
    `${phaseLabel}: session_history recall header must show b1 + paginated stat, got "${recallHeaderText}"`,
  );
  const recallCtx = recallRow.unit.locator('[data-tool-context="session-history"]');
  assert(await recallCtx.isVisible(), `${phaseLabel}: recall [data-tool-context="session-history"] must be visible`);
  const recallBodyText = ((await recallCtx.textContent()) || "").trim();
  assert(
    recallBodyText.includes("Verbatim history recall"),
    `${phaseLabel}: recall body must show "Verbatim history recall", got "${recallBodyText}"`,
  );
  assert(recallBodyText.includes("era b1"), `${phaseLabel}: recall body must show era b1 badge`);
  assert(/chars/.test(recallBodyText), `${phaseLabel}: recall body must show char window label, got "${recallBodyText}"`);
  assert(recallBodyText.includes("paginated"), `${phaseLabel}: recall body must show "paginated" badge`);
  assert(/msg\s+#0/.test(recallBodyText), `${phaseLabel}: recall body must render segmented msg # cards, got "${recallBodyText}"`);

  // 4. `explore` subagent completed row
  const exploreRow = await ensureToolRowExpanded(page, "Explored");
  const exploreHeaderText = ((await exploreRow.header.textContent()) || "").trim();
  assert(
    /3\s*turns\s*·\s*2\s*calls/.test(exploreHeaderText),
    `${phaseLabel}: explore header must show "3 turns · 2 calls" stat, got "${exploreHeaderText}"`,
  );
  const exploreDuration = ((await exploreRow.header.locator("[data-tool-duration]").textContent()) || "").trim();
  assert(/^[1-9]\d*s$/.test(exploreDuration), `${phaseLabel}: explore header must show non-zero duration, got "${exploreDuration}"`);

  const exploreCtx = exploreRow.unit.locator('[data-tool-context="explore"]');
  assert(await exploreCtx.isVisible(), `${phaseLabel}: [data-tool-context="explore"] must be visible`);
  const exploreBodyText = ((await exploreCtx.textContent()) || "").trim();
  assert(exploreBodyText.includes("Read-only investigation"), `${phaseLabel}: explore body must show "Read-only investigation"`);
  assert(exploreBodyText.includes(EXPLORE_TASK), `${phaseLabel}: explore body must show full task description`);
  for (const fp of EXPLORE_FOCUS_PATHS) {
    assert(exploreBodyText.includes(fp), `${phaseLabel}: explore body must render focus_paths chip "${fp}"`);
  }
  assert(exploreBodyText.includes("3 turns"), `${phaseLabel}: explore body must show "3 turns" badge`);
  assert(exploreBodyText.includes("2 tool calls"), `${phaseLabel}: explore body must show "2 tool calls" badge`);
  assert(/\+\s*[\d.]+[KM]?\s*tok/i.test(exploreBodyText), `${phaseLabel}: explore body must show token usage badge, got "${exploreBodyText}"`);

  const h3Texts = await exploreCtx.locator("h3").allTextContents();
  const liCount = await exploreCtx.locator("li").count();
  const codeTexts = await exploreCtx.locator("code").allTextContents();
  assert(
    h3Texts.some((t: string) => t.includes("Architecture Findings")),
    `${phaseLabel}: explore StreamingMarkdown must render <h3> "Architecture Findings", got ${JSON.stringify(h3Texts)}`,
  );
  assert(liCount >= 3, `${phaseLabel}: explore StreamingMarkdown must render bullet <li> items, got ${liCount}`);
  assert(
    codeTexts.some((t: string) => t.includes("ROUTER_TIMEOUT_MS")),
    `${phaseLabel}: explore StreamingMarkdown must render inline <code>, got ${JSON.stringify(codeTexts)}`,
  );

  const exploreFooter = exploreRow.unit.locator("[data-tool-footer]");
  assert(await exploreFooter.isVisible(), `${phaseLabel}: explore [data-tool-footer] must be visible`);
  const exploreFooterText = ((await exploreFooter.textContent()) || "").trim();
  assert(/Took\s+\d/.test(exploreFooterText), `${phaseLabel}: explore footer must show Took duration, got "${exploreFooterText}"`);

  log(
    "ui",
    `${phaseLabel}: verified spilled bash (${spillDuration}), session_history search+recall, and explore (${exploreDuration})`,
  );
  return {
    spillHeaderText,
    spillDuration,
    spillFooterText,
    searchHeaderText,
    recallHeaderText,
    exploreHeaderText,
    exploreDuration,
    exploreFooterText,
  };
}

try {
  const ctx = await boot();

  const created: any = await ctx.send({
    type: "create_session",
    cwd: ctx.workDir,
    title: "LSM Tools UI Suite",
    model: MODEL,
    options: { mode: "agentic", access: "full", skills: [{ name: "build" }] },
  });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");

  // --- Phase A: Era 1 (>25KB arrival spill + read + edit + exit-2 command) + /compact #1 -> b1 ---
  log("phase", "running Era 1 turns + /compact #1 (b1)");
  await runTurn(ctx, sessionId, "[TURN_TAG:T1_SPILL_AND_OPS] Run pipeline diagnostics, update service retries, and verify.");
  await runTurn(ctx, sessionId, "[TURN_TAG:T2_ERA1_PAD] Inspect router configuration.");
  await runTurn(ctx, sessionId, "[TURN_TAG:T3_ERA1_PAD] Confirm Era 1 checkpoint.");

  const brainSessionDir = path.join(ctx.daemonDir, "brain", sessionId);
  const spillFiles = (await fs.readdir(brainSessionDir).catch(() => [] as string[])).filter((f) => /^tool-.*\.log$/.test(f));
  assert(spillFiles.length >= 1, `expected spilled tool-*.log in ${brainSessionDir}`);
  const spilledDiskBytes = await fs.readFile(path.join(brainSessionDir, spillFiles[0]!), "utf8");
  assert(Buffer.byteLength(spilledDiskBytes, "utf8") > 35000, "spilled brain/tool-*.log must contain full >35KB output");
  assert(spilledDiskBytes.includes(SPILL_DIAG_TOKEN), "spilled brain/tool-*.log must contain SPILL_DIAG_771");

  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
  const afterB1 = await waitForCompactionCount(ctx, sessionId, 1);
  assert.equal(afterB1?.session?.compaction?.blocks?.[0]?.id, "b1", "expected FoldBlock b1 after first /compact");

  // --- Phase A2: Era 2 turns + /compact #2 -> b2 alongside b1 ---
  log("phase", "running Era 2 turns + /compact #2 (b2)");
  await runTurn(ctx, sessionId, "[TURN_TAG:T4_ERA2_STEP1] Run Era 2 step 1.");
  await runTurn(ctx, sessionId, "[TURN_TAG:T5_ERA2_STEP2] Run Era 2 step 2.");
  await runTurn(ctx, sessionId, "[TURN_TAG:T6_ERA2_STEP3] Run Era 2 step 3.");

  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
  const afterB2 = await waitForCompactionCount(ctx, sessionId, 2);
  const blocks = afterB2?.session?.compaction?.blocks || [];
  assert.equal(blocks.length, 2, `expected 2 FoldBlocks (b1, b2), got ${blocks.length}`);
  assert.equal(blocks[0]?.id, "b1");
  assert.equal(blocks[1]?.id, "b2");
  log("phase", `compacted 2 eras: b1=[${blocks[0].startIdx}..${blocks[0].endIdx}) b2=[${blocks[1].startIdx}..${blocks[1].endIdx})`);

  // --- Phase B-H: Real Chromium Desktop (1280x840) + Mobile (390x844) ---
  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(String(e).slice(0, 300)));
    page.on("console", (m: any) => {
      if (m.type() === "error") consoleErrors.push(String(m.text()).slice(0, 300));
    });
    await page.addInitScript(
      ({ sess, hid, sid }: any) => {
        localStorage.setItem("cache_code_session", JSON.stringify(sess));
        localStorage.setItem(`llmgw-rc-session:${hid}`, sid);
      },
      {
        sess: { accessToken: ctx.login.accessToken, refreshToken: ctx.login.refreshToken, user: ctx.login.user },
        hid: ctx.hostId,
        sid: sessionId,
      },
    );

    await page.goto(`${GW}/#/code`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    if ((await page.locator('button:has-text("Context Compacted")').count()) === 0) {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
    }
    if ((await page.locator('button:has-text("Context Compacted")').count()) === 0) {
      const sessionEntry = page.locator('text="LSM Tools UI Suite"').first();
      if ((await sessionEntry.count()) > 0) {
        await sessionEntry.click();
      }
    }
    await page.waitForSelector('button:has-text("Context Compacted")', { timeout: 20000 });
    await page.waitForTimeout(600);

    // Trigger Live Turn 7 while desktop page is pinned at bottom so we observe
    // live `Exploring` header, `[data-explore-step]` (`step 1` & `step 2`), and
    // ticking `[data-tool-duration]` in real time!
    log("phase", "triggering live Turn 7 (session_history search + recall + live explore subagent)");
    const turn7EventStart = ctx.events.length;
    ctx.ws.send(
      JSON.stringify({
        type: "prompt",
        hostId: ctx.hostId,
        sessionId,
        model: MODEL,
        yolo: true,
        text: "[TURN_TAG:T7_LIVE_CONTEXT_SUITE] Search compacted history for SPILL_DIAG_771, recall block b1, and explore src/ router architecture.",
      }),
    );

    const observedSteps = new Set<string>();
    const observedDurations = new Set<string>();
    let sawLiveExploringVerb = false;

    const livePollStart = Date.now();
    while (Date.now() - livePollStart < 20000) {
      const snap = await page.evaluate(() => {
        const stepEl = document.querySelector("[data-explore-step]");
        if (!stepEl) return null;
        const row = stepEl.closest('div[class*="group/tool"]');
        const durEl = row?.querySelector("[data-tool-duration]");
        return {
          rowText: (row?.textContent || "").trim(),
          stepText: (stepEl.textContent || "").trim(),
          durText: (durEl?.textContent || "").trim(),
        };
      });
      if (snap) {
        if (snap.rowText.includes("Exploring")) sawLiveExploringVerb = true;
        if (snap.stepText) observedSteps.add(snap.stepText);
        if (snap.durText) observedDurations.add(snap.durText);
        if (
          sawLiveExploringVerb &&
          [...observedSteps].some((s) => /\bstep 1\b/i.test(s)) &&
          [...observedSteps].some((s) => /\bstep 2\b/i.test(s)) &&
          [...observedDurations].some((d) => /^[1-9]\d*s$/.test(d))
        ) {
          break;
        }
      }
      const doneAlready = ctx.events
        .slice(turn7EventStart)
        .some((e: any) => e?.type === "turn_finished" && e?.sessionId === sessionId);
      if (doneAlready) break;
      await Bun.sleep(90);
    }

    await waitForTurnDone(ctx, sessionId, turn7EventStart);
    await page.waitForTimeout(800);

    log(
      "live-explore",
      `verb=${sawLiveExploringVerb} steps=${JSON.stringify([...observedSteps])} durations=${JSON.stringify([...observedDurations])}`,
    );
    assert(sawLiveExploringVerb, "must observe live in-flight 'Exploring' tool row");
    assert(
      [...observedSteps].some((s) => /\bstep 1\b/i.test(s)) || [...observedSteps].some((s) => /\bstep 2\b/i.test(s)),
      `must observe live [data-explore-step] badge, got ${JSON.stringify([...observedSteps])}`,
    );
    assert(
      [...observedSteps].some((s) => /\bstep 2\b/i.test(s)),
      `must observe live [data-explore-step] progress reach step 2, got ${JSON.stringify([...observedSteps])}`,
    );
    assert(
      [...observedDurations].some((d) => /^[1-9]\d*s$/.test(d)),
      `must observe live ticking [data-tool-duration] >= 1s while Exploring is in-flight, got ${JSON.stringify([...observedDurations])}`,
    );

    // Load all older turns so earlier raw turns (Turn 1..6) sit directly above CompactionBalloon.
    await loadAllOlderTurns(page);

    // Verify CompactionBalloon + Boundary Caption + Era Timeline expand/collapse.
    const boundaryCaption = page.locator("[data-compaction-boundary-caption]").first();
    assert(await boundaryCaption.isVisible(), "[data-compaction-boundary-caption] must render visibly above CompactionBalloon");
    const captionText = ((await boundaryCaption.textContent()) || "").trim();
    assert(
      captionText.includes("Context boundary") && captionText.includes("session_history"),
      `boundary caption text mismatch: "${captionText}"`,
    );

    const compactPill = page.locator('button:has-text("Context Compacted")').first();
    await compactPill.scrollIntoViewIfNeeded();
    const pillText = ((await compactPill.textContent()) || "").trim();
    assert(/2\s*eras/.test(pillText), `CompactionBalloon pill must show '2 eras', got "${pillText}"`);
    assert.equal(await compactPill.getAttribute("aria-expanded"), "false", "CompactionBalloon should start collapsed");

    await compactPill.click();
    await page.waitForTimeout(350);
    assert.equal(await compactPill.getAttribute("aria-expanded"), "true", "CompactionBalloon should expand on click");

    // Expand all eras (`b1` and `b2`), verify metadata & zero raw tag leaks, then collapse cleanly.
    const expandAllBtn = page.locator('button:has-text("Expand all")').first();
    if ((await expandAllBtn.count()) > 0 && (await expandAllBtn.isVisible())) {
      await expandAllBtn.click();
      await page.waitForTimeout(250);
    }
    const compCheck = await page.evaluate(() => {
      const bodyText = document.body.textContent || "";
      const spans = [...document.querySelectorAll("span")].map((s) => (s.textContent || "").trim());
      return {
        hasB1: spans.includes("b1"),
        hasB2: spans.includes("b2"),
        hasModifiedService: spans.includes("service.ts"),
        hasSummaryLeak: /## Context Summary \(compacted\)/.test(bodyText),
        hasSystemReminderLeak: /<system-reminder>/.test(bodyText),
      };
    });
    assert(compCheck.hasB1 && compCheck.hasB2, `Era Timeline must show b1 and b2: ${JSON.stringify(compCheck)}`);
    assert(compCheck.hasModifiedService, "CompactionBalloon must display modified file chip service.ts");
    assert(!compCheck.hasSummaryLeak, "raw ## Context Summary header must not leak");
    assert(!compCheck.hasSystemReminderLeak, "raw <system-reminder> tag must not leak");

    await compactPill.click();
    await page.waitForTimeout(250);
    assert.equal(await compactPill.getAttribute("aria-expanded"), "false", "CompactionBalloon should collapse cleanly");

    // Verify all 4 bespoke tool bodies BEFORE reload (live hydrated session).
    const preReload = await verifyAllFourExpandedTools(page, "pre-reload-desktop");
    await assertNoHorizontalOverflow(page, "pre-reload-desktop-1280x840");
    assertNoPageErrors(pageErrors, consoleErrors, "pre-reload-desktop");

    // --- Phase G: Full Browser Reload Durability (`await page.reload()`) ---
    // Reloads purely from persisted disk WAL (`<tool_result ...attrs...>body</tool_result>`)
    // without transient in-memory `Details`.
    log("phase", "reloading page to verify persisted WAL durability without live transient Details");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("[data-transcript-id]", { timeout: 20000 });
    await page.waitForTimeout(1000);

    const postReload = await verifyAllFourExpandedTools(page, "post-reload-desktop");
    assert.equal(
      postReload.searchHeaderText,
      preReload.searchHeaderText,
      "session_history search header stat must match identically after reload",
    );
    assert.equal(
      postReload.recallHeaderText,
      preReload.recallHeaderText,
      "session_history recall header stat must match identically after reload",
    );
    assert.equal(
      postReload.exploreHeaderText,
      preReload.exploreHeaderText,
      "explore header stat + duration must match identically after reload",
    );
    assert.equal(
      postReload.spillFooterText,
      preReload.spillFooterText,
      "spilled bash footer facts must match identically after reload",
    );
    assert.equal(
      postReload.exploreFooterText,
      preReload.exploreFooterText,
      "explore footer facts must match identically after reload",
    );
    await assertNoHorizontalOverflow(page, "post-reload-desktop-1280x840");
    assertNoPageErrors(pageErrors, consoleErrors, "post-reload-desktop");

    // --- Phase H: Mobile Viewport Check (390x844) with all 4 bespoke bodies expanded ---
    log("phase", "verifying 390x844 mobile viewport layout & overflow integrity");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(450);
    await verifyAllFourExpandedTools(page, "post-reload-mobile-390x844");
    await assertNoHorizontalOverflow(page, "mobile-390x844");
    assertNoPageErrors(pageErrors, consoleErrors, "mobile-390x844");

    await context.close();
  } finally {
    await browser.close();
  }

  console.log("\n=== RESULT ===\nPASS: indirect LSM tools full-stack UI suite complete");
} catch (err) {
  console.error(`\n=== RESULT ===\nFAIL: ${err instanceof Error ? err.stack || err.message : err}`);
  process.exitCode = 1;
} finally {
  try {
    mockUpstream.stop(true);
  } catch {}
  for (const p of procs) {
    try {
      p.kill();
    } catch {}
  }
  await Bun.sleep(250);
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}
