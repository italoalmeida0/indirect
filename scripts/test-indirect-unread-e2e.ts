/**
 * scripts/test-indirect-unread-e2e.ts — full-stack multi-device Playwright E2E
 * suite verifying cross-device unread/attention watermarks ("bolinha") and live
 * status grammars across independent BrowserContexts (`pcContext` 1280x800,
 * `mobileContext` 390x844, and `lateDeviceContext` opened after ack) backed by
 * a real Bun Gateway + real Go Daemon + deterministic gated mock upstream.
 *
 * Scenarios:
 *   1. Mid-turn approval (`running + unread` -> view on PC -> `0ms` optimistic
 *      flip to `RadialSpokeSpinner`, daemon mirror sync to Mobile, and fresh
 *      `lateDeviceContext` joining with `RadialSpokeSpinner` and zero `UnreadDot`).
 *      Covers `SessionSidebar`, collapsed Project folder roll-up, `HistoryView`
 *      (`Ctrl+K`), and Mobile `SidebarToggle` corner badge (`data-sidebar-unread-badge`).
 *   2. Turn completion (`idle + unread` -> window `blur` protection on PC ->
 *      Talk tab unread dot -> view on Mobile -> clears to empty across Mobile,
 *      PC + `document.title`, and fresh `lateDeviceContext`).
 *   3. User-initiated Stop (`[■]` `SessionStopButton` in sidebar without opening
 *      the session -> stops cleanly with zero `UnreadDot`).
 *   4. Simultaneous live status grammar & unread verification (+ optional 2x DPI
 *      screenshot capture via `--screenshots-dir <dir>` or `SCREENSHOTS_DIR`).
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

function resolveScreenshotsDir(): string {
  const idx = process.argv.indexOf("--screenshots-dir");
  if (idx >= 0 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]!);
  if (process.env.SCREENSHOTS_DIR) return path.resolve(process.env.SCREENSHOTS_DIR);
  return "";
}

const SCREENSHOTS_DIR = resolveScreenshotsDir();

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
const MODEL = "mock-unread-e2e-v1";

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

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (val: T) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (val: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface RecordedUpstreamCall {
  seq: number;
  scenarioKey: string;
  stepToolResults: number;
  userTexts: string[];
  aborted: boolean;
}

interface GateHandle {
  entered: Deferred<RecordedUpstreamCall>;
  release: Deferred<void>;
  aborted: Deferred<void>;
}

const activeGates = new Map<string, GateHandle>();
let upstreamSeq = 0;

function armGate(gateKey: string): GateHandle {
  const handle: GateHandle = {
    entered: createDeferred<RecordedUpstreamCall>(),
    release: createDeferred<void>(),
    aborted: createDeferred<void>(),
  };
  activeGates.set(gateKey, handle);
  return handle;
}

function sseFrame(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseDone(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

function classifyScenario(messages: any[]): { key: string; userIdx: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const text = textOfMessage(messages[i]);
    const tagMatch = /\[TURN_TAG:([A-Z0-9_]+)\]/.exec(text);
    if (tagMatch) return { key: tagMatch[1]!, userIdx: i };
    if (text.includes("Start the dev watcher in the background")) {
      return { key: "GRAMMAR_S1", userIdx: i };
    }
    if (text.includes("Run migration dry-run inspection")) {
      return { key: "STOP_S3", userIdx: i };
    }
    if (text.includes("Rotate signing key configuration")) {
      return { key: "BG_UNREAD_S2", userIdx: i };
    }
    if (text.includes("Summarize API gateway latency targets")) {
      return { key: "TALK_UNREAD_S4", userIdx: i };
    }
  }
  return { key: "DEFAULT", userIdx: -1 };
}

type StreamCompletion =
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string };

function buildGatedMockStream(opts: {
  req: Request;
  model: string;
  callRecord: RecordedUpstreamCall;
  gate?: GateHandle;
  thinkingPrefix?: string;
  textPrefix?: string;
  completion: StreamCompletion;
}): Response {
  const respId = `chatcmpl-unread-${opts.callRecord.seq}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      const onAbort = () => {
        opts.callRecord.aborted = true;
        opts.gate?.aborted.resolve();
        safeClose();
      };
      if (opts.req.signal.aborted) {
        onAbort();
        return;
      }
      opts.req.signal.addEventListener("abort", onAbort, { once: true });

      safeEnqueue(
        sseFrame({
          id: respId,
          object: "chat.completion.chunk",
          model: opts.model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }),
      );

      if (opts.thinkingPrefix) {
        safeEnqueue(
          sseFrame({
            id: respId,
            object: "chat.completion.chunk",
            model: opts.model,
            choices: [{ index: 0, delta: { reasoning_content: opts.thinkingPrefix }, finish_reason: null }],
          }),
        );
      }

      if (opts.textPrefix) {
        safeEnqueue(
          sseFrame({
            id: respId,
            object: "chat.completion.chunk",
            model: opts.model,
            choices: [{ index: 0, delta: { content: opts.textPrefix }, finish_reason: null }],
          }),
        );
      }

      // Flush SSE chunk across loopback before pausing at gate.
      safeEnqueue(new TextEncoder().encode(`: ${"f".repeat(2048)}\n\n`));

      if (opts.gate) {
        opts.gate.entered.resolve(opts.callRecord);
        await Promise.race([opts.gate.release.promise, opts.gate.aborted.promise]);
      }

      if (closed || opts.req.signal.aborted) {
        safeClose();
        return;
      }

      if (opts.completion.kind === "tool") {
        safeEnqueue(
          sseFrame({
            id: respId,
            object: "chat.completion.chunk",
            model: opts.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: opts.completion.id,
                      type: "function",
                      function: {
                        name: opts.completion.name,
                        arguments: JSON.stringify(opts.completion.args),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
        safeEnqueue(
          sseFrame({
            id: respId,
            object: "chat.completion.chunk",
            model: opts.model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          }),
        );
      } else {
        if (opts.completion.text) {
          safeEnqueue(
            sseFrame({
              id: respId,
              object: "chat.completion.chunk",
              model: opts.model,
              choices: [{ index: 0, delta: { content: opts.completion.text }, finish_reason: null }],
            }),
          );
        }
        safeEnqueue(
          sseFrame({
            id: respId,
            object: "chat.completion.chunk",
            model: opts.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        );
      }

      safeEnqueue(
        sseFrame({
          id: respId,
          object: "chat.completion.chunk",
          model: opts.model,
          choices: [],
          usage: { prompt_tokens: 280, completion_tokens: 52, total_tokens: 332 },
        }),
      );
      safeEnqueue(sseDone());
      safeClose();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

const upstreamServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) {
      return Response.json(
        { error: { message: `unexpected path ${url.pathname}`, type: "invalid_request_error" } },
        { status: 404 },
      );
    }

    const rawBody = await req.text();
    const body: any = rawBody ? JSON.parse(rawBody) : {};
    const model = String(body.model || MODEL);
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const toolsList: any[] = Array.isArray(body.tools) ? body.tools : [];
    const hasFinishTool = toolsList.some(
      (t: any) => (t?.function?.name || t?.name) === "finish_entire_request",
    );
    const sysText = messages
      .filter((m) => m?.role === "system")
      .map(textOfMessage)
      .join("\n");

    if (
      toolsList.length === 0 &&
      (sysText.includes("short title") ||
        sysText.includes("context-checkpointing summarizer") ||
        messages.some((m) => textOfMessage(m).includes("INTERNAL COMPACTION FORK")))
    ) {
      return Response.json({
        id: `chatcmpl-aux-${++upstreamSeq}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "Unread E2E Session" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 32, completion_tokens: 6, total_tokens: 38 },
      });
    }

    const finishReply = (id: string, text: string): StreamCompletion =>
      hasFinishTool
        ? { kind: "tool", id, name: "finish_entire_request", args: { final_message_to_user: text } }
        : { kind: "text", text };

    const { key: scenarioKey, userIdx } = classifyScenario(messages);
    const stepToolResults =
      userIdx >= 0 ? messages.slice(userIdx + 1).filter((m) => m?.role === "tool").length : 0;
    const userTexts = messages.filter((m) => m?.role === "user").map(textOfMessage);
    const seq = ++upstreamSeq;
    const callRecord: RecordedUpstreamCall = {
      seq,
      scenarioKey,
      stepToolResults,
      userTexts,
      aborted: false,
    };

    const gateKey = `${scenarioKey}:step${stepToolResults}`;
    const gate = activeGates.get(gateKey) || activeGates.get(`${scenarioKey}:any`);
    if (gate) {
      activeGates.delete(gateKey);
      activeGates.delete(`${scenarioKey}:any`);
    }

    // Scenario 1: Step 0 calls `read` (pauses on approval in `ask` mode); Step 1 completes.
    if (scenarioKey === "APPROVAL_S2") {
      if (stepToolResults === 0) {
        return buildGatedMockStream({
          req,
          model,
          callRecord,
          gate,
          thinkingPrefix: "Checking token rotation configuration in notes.txt...",
          completion: {
            kind: "tool",
            id: `call_s2_read_${seq}`,
            name: "read",
            args: { path: "notes.txt" },
          },
        });
      }
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "Verified notes.txt; preparing completion report.",
        completion: finishReply(
          `call_s2_finish_${seq}`,
          "Token rotation audit completed cleanly after permission approval.",
        ),
      });
    }

    // Scenario 2B: Blur test completion on Session 2.
    if (scenarioKey === "BLUR_S2") {
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "Validating JWKS rotation window...",
        completion: finishReply(
          `call_s2_blur_finish_${seq}`,
          "JWKS rotation window validated while desktop window was unfocused.",
        ),
      });
    }

    // Scenario 3: Sidebar Stop button test on Session 3.
    if (scenarioKey === "STOP_S3") {
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "Running dry-run schema inspection...",
        textPrefix: "",
        completion: finishReply(`call_s3_stop_${seq}`, "Unstopped completion."),
      });
    }

    // Scenario 4: Live grammar + unread showcase on Session 1.
    // Step 0 launches `bun dev-watch.js` via `bash` (detaches after 1s into BackgroundCard);
    // Step 1 holds open with streaming reasoning + assistant commentary while `▾ Ran 1 command` shimmers!
    if (scenarioKey === "GRAMMAR_S1") {
      if (stepToolResults === 0) {
        return buildGatedMockStream({
          req,
          model,
          callRecord,
          gate,
          thinkingPrefix: "Starting local dev watcher in background before verifying sync watermarks.",
          completion: {
            kind: "tool",
            id: `call_s1_bash_${seq}`,
            name: "bash",
            args: {
              command: "bun dev-watch.js",
              description: "Start background dev watcher",
            },
          },
        });
      }
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "Auditing SignalDB attention watermarks and cross-device optimistic pruning.",
        textPrefix:
          "Background dev watcher is online at `http://127.0.0.1:5700`. Verifying cross-device `attentionSeq` / `seenSeq` convergence across connected clients…",
        completion: finishReply(`call_s1_grammar_done_${seq}`, "Architecture verification completed."),
      });
    }

    const latestUser = userTexts[userTexts.length - 1] || "request";
    return buildGatedMockStream({
      req,
      model,
      callRecord,
      gate,
      completion: finishReply(
        `call_default_${seq}`,
        `Completed update for: ${latestUser.slice(0, 90)}`,
      ),
    });
  },
});

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const p = probe.port;
  probe.stop(true);
  return p;
}

const UPSTREAM_URL = `http://127.0.0.1:${upstreamServer.port}/v1`;
const ADMIN_PW = "e2e-unread-suite-pass-1";
const procs: Array<{ kill: () => void }> = [];
const tempDirs: string[] = [];

async function boot() {
  const gwPort = Number(process.env.E2E_UNREAD_GW_PORT || (await pickFreePort()));
  const gwUrl = `http://127.0.0.1:${gwPort}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-unread-e2e-"));
  tempDirs.push(dataDir);

  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: WS,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(gwPort),
      DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_URL: gwUrl,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(gwProc);

  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${gwUrl}/api/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 20000) throw new Error("gateway never came up");
    await Bun.sleep(150);
  }

  const login: any = await (
    await fetch(`${gwUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
    })
  ).json();
  assert(login.success, "admin login failed");
  const jwt = login.accessToken;
  const auth = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };

  const provRes: any = await (
    await fetch(`${gwUrl}/api/admin/providers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "unread-e2e-provider",
        openaiBaseUrl: UPSTREAM_URL,
        apiKey: "mock-unread-key",
        openaiAuthStyle: "bearer",
      }),
    })
  ).json();
  assert(provRes.success, `provider create failed: ${JSON.stringify(provRes)}`);
  const list: any = await (
    await fetch(`${gwUrl}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })
  ).json();
  const providerId = (list.providers || []).find((p: any) => p.name === "unread-e2e-provider")?.id;
  assert(providerId, "unread-e2e-provider id missing");

  const mkModel: any = await (
    await fetch(`${gwUrl}/api/admin/models`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: MODEL, providerId, upstreamModel: MODEL, contextLength: 128000 }),
    })
  ).json();
  assert(mkModel.success, `model create failed: ${JSON.stringify(mkModel)}`);

  const pair: any = await (
    await fetch(`${gwUrl}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    })
  ).json();
  assert(pair.success && pair.connectUrl, "pairing failed");

  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-unread-d-"));
  tempDirs.push(daemonDir);
  const workDir = path.join(daemonDir, "indirect-app");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "notes.txt"), "Auth rotation interval: 15m\nJWKS cache TTL: 5m\n", "utf8");
  writeFileSync(
    path.join(workDir, "dev-watch.js"),
    `console.log("[vite] dev server ready at http://127.0.0.1:5700");\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 60000);\n`,
    "utf8",
  );

  let extraPath = process.env.PATH || "";
  const bunBinDir = path.dirname(process.execPath);
  if (bunBinDir) {
    extraPath = `${bunBinDir}${path.delimiter}${extraPath}`;
  }
  if (process.platform === "win32") {
    const cachedUnish = path.join(homedir(), ".indirect-code", "external", "bin", "unish.exe");
    if (existsSync(cachedUnish)) {
      const destUnish = path.join(daemonDir, "external", "bin", "unish.exe");
      mkdirSync(path.dirname(destUnish), { recursive: true });
      copyFileSync(cachedUnish, destUnish);
      extraPath = `${path.dirname(destUnish)};${extraPath}`;
    }
    for (const g of ["C:\\Program Files\\Git\\bin", "C:\\Program Files\\Git\\usr\\bin"]) {
      if (existsSync(g)) extraPath = `${g};${extraPath}`;
    }
  }

  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "Workstation Pro"],
    {
      cwd: WS,
      env: {
        ...process.env,
        HOME: daemonDir,
        PATH: extraPath,
        ICD_AUTOBG_AFTER: "1s",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  procs.push(daemonProc);

  const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/api/indirect-code/ws?token=${encodeURIComponent(jwt)}`);
  let reqId = 0;
  const pending = new Map<string, (v: any) => void>();
  const pendingPulls = new Map<string, (v: any) => void>();
  let hostId = "";
  const events: any[] = [];

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
      }, 30000).unref();
    });
  };

  const pullCollection = (collection: string) => {
    const id = `pull_${++reqId}`;
    ws.send(JSON.stringify({ type: "pull", id, hostId, collection }));
    return new Promise<any>((resolve) => {
      pendingPulls.set(id, resolve);
      setTimeout(() => {
        if (pendingPulls.has(id)) {
          pendingPulls.delete(id);
          resolve(undefined);
        }
      }, 15000).unref();
    });
  };

  await new Promise<void>((res) => {
    ws.onopen = () => res();
  });
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      events.push(msg);
      if (msg.type === "pull-response" && msg.id && pendingPulls.has(msg.id)) {
        pendingPulls.get(msg.id)!(msg);
        pendingPulls.delete(msg.id);
        return;
      }
      if (msg.requestId && pending.has(msg.requestId)) {
        pending.get(msg.requestId)!(msg);
        pending.delete(msg.requestId);
      }
    } catch {}
  };

  const start = Date.now();
  while (!hostId && Date.now() - start < 20000) {
    const h: any = await (
      await fetch(`${gwUrl}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })
    ).json();
    const f = (h.hosts || []).find((x: any) => x.name === "Workstation Pro" && x.status === "online");
    if (f) hostId = f.id;
    else await Bun.sleep(250);
  }
  assert(hostId, "daemon host never came online");

  const initPull = await pullCollection("config");
  const initCfg = await send({
    type: "update_config",
    expectedRevision: initPull?.items?.[0]?.revision,
    settings: {
      auto_compact_threshold: 80,
      no_auto_title: true,
      jail_by_default: false,
      insecure: false,
      http_proxy: "",
      mid_turn_send: "queue",
    },
  });
  assert(initCfg?.success, `initial update_config failed: ${JSON.stringify(initCfg)}`);

  // Register `workDir` (`indirect-app`) as a real project so collapsible folder roll-ups are active!
  const projCreated = await send({
    type: "create_project",
    path: workDir,
  });
  const projectId = String(projCreated?.project?.id || "");
  assert(projectId, `create_project failed: ${JSON.stringify(projCreated)}`);

  const projDeadline = Date.now() + 5000;
  while (Date.now() < projDeadline) {
    const pulled = await pullCollection("projects");
    if ((pulled?.items || []).some((p: any) => p?.id === projectId)) break;
    await Bun.sleep(80);
  }

  log("boot", `gw=${gwUrl} host=${hostId} project=${projectId}`);
  return { gwUrl, jwt, login, hostId, projectId, ws, send, pullCollection, daemonDir, workDir, events };
}

async function createTestSession(
  ctx: Awaited<ReturnType<typeof boot>>,
  title: string,
  opts: { mode?: "agentic" | "talk"; access?: "full" | "ask" } = {},
): Promise<string> {
  const mode = opts.mode ?? "agentic";
  const access = opts.access ?? "full";
  const created: any = await ctx.send({
    type: "create_session",
    cwd: mode === "talk" ? "" : ctx.workDir,
    title,
    model: MODEL,
    options:
      mode === "talk"
        ? { mode: "talk", access: "full", effort: "high", skills: [{ name: "talk" }] }
        : { mode: "agentic", access, effort: "high", skills: [{ name: "build" }] },
  });
  const sid = created?.session?.id;
  assert(sid, `create_session failed for "${title}": ${JSON.stringify(created)}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pulled = await ctx.pullCollection("sessions");
    if ((pulled?.items || []).some((s: any) => s?.id === sid)) break;
    await Bun.sleep(80);
  }
  return sid;
}

async function setPageFocused(cdp: any, page: any, focused: boolean) {
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: focused });
  await page.evaluate((f: boolean) => {
    window.dispatchEvent(new Event(f ? "focus" : "blur"));
  }, focused);
}

async function attachAuthInit(page: any, login: any) {
  await page.addInitScript(
    ({ sess }: any) => {
      if (!localStorage.getItem("cache_code_session")) {
        localStorage.setItem("cache_code_session", JSON.stringify(sess));
      }
    },
    {
      sess: { accessToken: login.accessToken, refreshToken: login.refreshToken, user: login.user },
    },
  );
}

async function selectSessionInUI(
  page: any,
  gwUrl: string,
  hostId: string,
  sessionId: string,
  mode: "agentic" | "talk" = "agentic",
) {
  if (!page.url().startsWith(gwUrl)) {
    await page.goto(`${gwUrl}/#/code`, { waitUntil: "networkidle" });
  }
  await page.waitForSelector("#rc-composer", { timeout: 20000 });

  // Open sidebar if collapsed/closed (e.g. on mobile).
  const expandBtn = page.locator('button[aria-label="Expand sidebar"]').first();
  if ((await expandBtn.count()) > 0 && (await expandBtn.isVisible().catch(() => false))) {
    await expandBtn.click();
    await page.waitForTimeout(250);
  }

  const segLabel = mode === "talk" ? "Talk" : "Projects";
  const segBtn = page.locator('[aria-label="Sidebar list view"] button', { hasText: segLabel }).first();
  await segBtn.waitFor({ state: "visible", timeout: 15000 });
  await segBtn.click();

  const row = page.locator(`aside [data-session-id="${sessionId}"]`).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.click();

  await page.waitForFunction(
    ({ hid, sid }: { hid: string; sid: string }) => {
      const sendBtn = document.querySelector("button.rc-composer-send");
      const label = sendBtn?.getAttribute("aria-label") || "";
      const stored = localStorage.getItem(`llmgw-rc-session:${hid}`);
      return stored === sid && label === "Send";
    },
    { hid: hostId, sid: sessionId },
    { timeout: 15000 },
  );
}

async function sendFromComposer(page: any, text: string) {
  const composer = page.locator("#rc-composer");
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(
    () => {
      const el = document.getElementById("rc-composer") as HTMLTextAreaElement | null;
      return Boolean(el && !el.disabled);
    },
    undefined,
    { timeout: 15000 },
  );
  await composer.fill(text);
  const sendBtn = page.locator("button.rc-composer-send");
  await page.waitForFunction(
    () => {
      const b = document.querySelector("button.rc-composer-send") as HTMLButtonElement | null;
      return Boolean(b && !b.disabled);
    },
    undefined,
    { timeout: 10000 },
  );
  await sendBtn.click();
  await page.waitForFunction(
    () => {
      const el = document.getElementById("rc-composer") as HTMLTextAreaElement | null;
      return Boolean(el && el.value === "");
    },
    undefined,
    { timeout: 15000 },
  );
}

async function waitForSessionIdle(
  ctx: Awaited<ReturnType<typeof boot>>,
  sessionId: string,
  timeoutMs = 20000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await ctx.send({ type: "get_session", sessionId });
    const status = snap?.session?.status;
    if (status && status !== "running") return snap;
    await Bun.sleep(100);
  }
  const snap = await ctx.send({ type: "get_session", sessionId });
  throw new Error(`session ${sessionId} did not become idle within ${timeoutMs}ms (status=${snap?.session?.status})`);
}

async function waitForEvent(
  events: any[],
  fromIdx: number,
  pred: (ev: any) => boolean,
  label: string,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.slice(fromIdx).find(pred);
    if (found) return found;
    await Bun.sleep(60);
  }
  throw new Error(`Timed out waiting for event: ${label}`);
}

async function stitchMobileSideBySide(
  browser: any,
  closedPng: Buffer,
  openPng: Buffer,
  outPath: string,
) {
  const stitchCtx = await browser.newContext({
    viewport: { width: 804, height: 868 },
    deviceScaleFactor: 2,
  });
  try {
    const stitchPage = await stitchCtx.newPage();
    const b64Closed = closedPng.toString("base64");
    const b64Open = openPng.toString("base64");
    await stitchPage.setContent(
      `<!doctype html>
<html>
<head>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 804px;
    height: 868px;
    background: #09090b;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 12px;
    overflow: hidden;
  }
  .frame {
    width: 390px;
    height: 844px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.12);
    flex-shrink: 0;
  }
  .frame img {
    display: block;
    width: 390px;
    height: 844px;
  }
</style>
</head>
<body>
  <div class="frame"><img src="data:image/png;base64,${b64Closed}" alt="Closed mobile drawer" /></div>
  <div class="frame"><img src="data:image/png;base64,${b64Open}" alt="Open mobile drawer" /></div>
</body>
</html>`,
      { waitUntil: "load" },
    );
    await stitchPage.screenshot({ path: outPath });
  } finally {
    await stitchCtx.close();
  }
}

try {
  const ctx = await boot();
  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    // =========================================================================
    // Create PC (1280x800 @ 2x DPI) & Mobile (390x844 @ 2x DPI) BrowserContexts
    // =========================================================================
    const pcContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const pcPage = await pcContext.newPage();
    const pcCdp = await pcContext.newCDPSession(pcPage);
    const pcPageErrors: string[] = [];
    const pcConsoleErrors: string[] = [];
    pcPage.on("pageerror", (e: Error) => pcPageErrors.push(String(e).slice(0, 400)));
    pcPage.on("console", (m: any) => {
      if (m.type() === "error") pcConsoleErrors.push(String(m.text()).slice(0, 400));
    });
    await attachAuthInit(pcPage, ctx.login);

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const mobilePage = await mobileContext.newPage();
    const mobCdp = await mobileContext.newCDPSession(mobilePage);
    const mobPageErrors: string[] = [];
    const mobConsoleErrors: string[] = [];
    mobilePage.on("pageerror", (e: Error) => mobPageErrors.push(String(e).slice(0, 400)));
    mobilePage.on("console", (m: any) => {
      if (m.type() === "error") mobConsoleErrors.push(String(m.text()).slice(0, 400));
    });
    await attachAuthInit(mobilePage, ctx.login);

    // Seed sessions:
    // - Session 1: active viewed agentic session on PC & Mobile
    // - Session 2: `ask`-mode agentic session for mid-turn approval & completion sync
    // - Session 3: agentic session for sidebar `[■]` user-initiated Stop
    // - Session 4: Talk session for `Projects | Talk` segmented tab unread dot
    const s1Id = await createTestSession(ctx, "Live Architecture Audit", { mode: "agentic", access: "full" });
    const s2Id = await createTestSession(ctx, "Auth Token Rotation", { mode: "agentic", access: "ask" });
    const s3Id = await createTestSession(ctx, "Legacy Migration Dry-Run", { mode: "agentic", access: "full" });
    const s4TalkId = await createTestSession(ctx, "API Design Notes", { mode: "talk", access: "full" });

    await selectSessionInUI(pcPage, ctx.gwUrl, ctx.hostId, s1Id, "agentic");
    await setPageFocused(pcCdp, pcPage, true);

    await selectSessionInUI(mobilePage, ctx.gwUrl, ctx.hostId, s1Id, "agentic");
    await setPageFocused(mobCdp, mobilePage, true);

    // Ensure mobile drawer is closed after selecting Session 1.
    const mobCloseDrawerInit = mobilePage.locator('button[aria-label="Close sidebar"]').first();
    if ((await mobCloseDrawerInit.count()) > 0 && (await mobCloseDrawerInit.isVisible().catch(() => false))) {
      await mobCloseDrawerInit.click();
      await mobilePage.waitForTimeout(200);
    }

    assert.equal(await pcPage.title(), "Indirect Code");
    assert.equal(await mobilePage.locator("[data-sidebar-unread-badge]").count(), 0);

    // =========================================================================
    // SCENARIO 1: Mid-Turn Approval (`running + unread` -> view -> returns to
    //             `RadialSpokeSpinner` across PC, Mobile, and `lateDeviceContext`)
    // =========================================================================
    log("scenario-1", "Mid-turn approval: running+unread -> UnreadDot everywhere -> view on PC -> RadialSpokeSpinner everywhere");
    const evBeforeS2Approval = ctx.events.length;
    await ctx.send({
      type: "prompt",
      sessionId: s2Id,
      text: "[TURN_TAG:APPROVAL_S2] Inspect notes.txt and validate rotation interval.",
      model: MODEL,
      yolo: false,
      options: { mode: "agentic", access: "ask", effort: "high", skills: [{ name: "build" }] },
      attachmentIds: [],
    });

    const approvalEvt = await waitForEvent(
      ctx.events,
      evBeforeS2Approval,
      (e) => e.type === "tool_approval_request" && e.sessionId === s2Id,
      "tool_approval_request for Session 2",
    );
    assert(approvalEvt?.callId, "expected callId on tool_approval_request");

    const snapS2Awaiting = await ctx.send({ type: "get_session", sessionId: s2Id });
    assert.equal(snapS2Awaiting?.session?.status, "running");
    assert.equal(snapS2Awaiting?.session?.attentionKind, "approval");
    assert((snapS2Awaiting?.session?.attentionSeq ?? 0) > (snapS2Awaiting?.session?.seenSeq ?? 0));

    // 1A. PC assertions while viewing Session 1:
    // - Session 2 row in `SessionSidebar` shows `UnreadDot` ("Waiting for approval") and NOT `RadialSpokeSpinner`
    const pcS2Row = pcPage.locator(`aside [data-session-id="${s2Id}"]`);
    await pcS2Row.locator(`[data-session-unread="${s2Id}"] [data-indicator="unread-dot"]`).waitFor({
      state: "visible",
      timeout: 10000,
    });
    assert.equal(
      await pcS2Row.locator('[data-indicator="radial-spokes"]').count(),
      0,
      "PC Session 2 row must show UnreadDot instead of RadialSpokeSpinner when running+unread",
    );
    assert.equal(
      await pcS2Row.locator('[data-indicator="unread-dot"]').getAttribute("aria-label"),
      "Waiting for approval",
    );
    await pcPage.waitForFunction(() => document.title === "• Indirect Code", undefined, { timeout: 5000 });

    // - Collapsed Project folder roll-up shows `data-project-collapsed-status="unread"` + `UnreadDot`
    const pcProjToggle = pcPage.locator(`[data-project-id="${ctx.projectId}"] button[aria-label="Toggle project"]`);
    await pcProjToggle.click();
    const pcCollapsedBadge = pcPage.locator(
      `[data-project-id="${ctx.projectId}"] [data-project-collapsed-status="unread"]`,
    );
    await pcCollapsedBadge.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await pcCollapsedBadge.locator('[data-indicator="unread-dot"]').count(), 1);
    assert.equal(await pcCollapsedBadge.locator('[data-indicator="radial-spokes"]').count(), 0);
    // Re-expand Project folder
    await pcProjToggle.click();
    await pcS2Row.waitFor({ state: "visible", timeout: 5000 });

    // - `HistoryView` (`Ctrl+K`) shows `UnreadDot` (NOT `RadialSpokeSpinner`) on Session 2
    await pcPage.keyboard.press("Control+k");
    const pcHistoryRow = pcPage.locator(`[data-history-session-id="${s2Id}"]`);
    await pcHistoryRow.waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await pcHistoryRow.locator('[data-indicator="unread-dot"]').count(), 1);
    assert.equal(await pcHistoryRow.locator('[data-indicator="radial-spokes"]').count(), 0);
    await pcPage.locator('button[aria-label="Back to chat"]').click();
    await pcHistoryRow.waitFor({ state: "hidden", timeout: 5000 });

    // 1B. Mobile assertions while viewing Session 1:
    // - Closed drawer `SidebarToggle` shows corner unread badge (`data-sidebar-unread-badge`)
    await mobilePage.locator("[data-sidebar-unread-badge]").waitFor({ state: "visible", timeout: 10000 });
    // - Open mobile drawer -> `SessionSidebar` shows `UnreadDot` (NOT `RadialSpokeSpinner`) on Session 2
    await mobilePage.locator('button[aria-label="Expand sidebar"]').first().click();
    const mobS2Row = mobilePage.locator(`aside [data-session-id="${s2Id}"]`);
    await mobS2Row.locator(`[data-session-unread="${s2Id}"] [data-indicator="unread-dot"]`).waitFor({
      state: "visible",
      timeout: 8000,
    });
    assert.equal(
      await mobS2Row.locator('[data-indicator="radial-spokes"]').count(),
      0,
      "Mobile Session 2 row must show UnreadDot instead of RadialSpokeSpinner when running+unread",
    );

    // 1C. Click Session 2 on PC -> `0ms` optimistic flip to `RadialSpokeSpinner` on PC,
    //     daemon mirror sync to Mobile, and fresh `lateDeviceContext` joining with `RadialSpokeSpinner`!
    await setPageFocused(pcCdp, pcPage, true);
    await pcS2Row.click();

    // Immediate (0ms optimistic) check on PC:
    assert.equal(
      await pcS2Row.locator(`[data-session-unread="${s2Id}"]`).count(),
      0,
      "Clicking Session 2 on PC must clear UnreadDot optimistically (0ms)",
    );
    assert.equal(
      await pcS2Row.locator('[data-indicator="radial-spokes"]').count(),
      1,
      "Clicking running Session 2 on PC must immediately reveal RadialSpokeSpinner",
    );
    await pcPage.locator("[data-approval-card]").waitFor({ state: "visible", timeout: 10000 });
    await pcPage.waitForFunction(() => document.title === "Indirect Code", undefined, { timeout: 5000 });

    // Mobile drawer (still open!) syncs via daemon mirror (`mark_session_seen` -> `change` -> `pull sessions`):
    await mobS2Row.locator('[data-indicator="radial-spokes"]').waitFor({ state: "visible", timeout: 10000 });
    assert.equal(
      await mobS2Row.locator(`[data-session-unread="${s2Id}"]`).count(),
      0,
      "Mobile Session 2 row must flip from UnreadDot back to RadialSpokeSpinner via daemon mirror sync",
    );

    // Close mobile drawer -> `SidebarToggle` corner badge must now be gone!
    await mobilePage.locator('button[aria-label="Close sidebar"]').first().click();
    await mobilePage.waitForFunction(
      () => document.querySelectorAll("[data-sidebar-unread-badge]").length === 0,
      undefined,
      { timeout: 5000 },
    );

    // Fresh `lateDeviceContext` opened AFTER ack sees `RadialSpokeSpinner` and ZERO `UnreadDot`!
    const lateDeviceContext1 = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    try {
      const latePage1 = await lateDeviceContext1.newPage();
      await attachAuthInit(latePage1, ctx.login);
      await latePage1.goto(`${ctx.gwUrl}/#/code`, { waitUntil: "networkidle" });
      const lateS2Row = latePage1.locator(`aside [data-session-id="${s2Id}"]`);
      await lateS2Row.waitFor({ state: "visible", timeout: 15000 });
      await lateS2Row.locator('[data-indicator="radial-spokes"]').waitFor({ state: "visible", timeout: 10000 });
      assert.equal(
        await latePage1.locator('[data-indicator="unread-dot"]').count(),
        0,
        "lateDeviceContext opened after PC ack must show RadialSpokeSpinner with ZERO UnreadDot",
      );
    } finally {
      await lateDeviceContext1.close();
    }

    assertNoPageErrors(pcPageErrors, pcConsoleErrors, "Scenario 1 PC");
    assertNoPageErrors(mobPageErrors, mobConsoleErrors, "Scenario 1 Mobile");
    log("scenario-1", "PASSED: mid-turn approval UnreadDot -> 0ms PC ack -> Mobile & lateDevice RadialSpokeSpinner sync");

    // =========================================================================
    // SCENARIO 2: Turn Completion (`idle + unread` -> blur protection + Talk tab dot
    //             -> view on Mobile -> clears to empty everywhere)
    // =========================================================================
    log("scenario-2", "Turn completion: background finish + window blur protection + Talk tab dot -> Mobile ack clears everywhere");

    // 2A. Arm gate on Step 1 of Session 2, approve on PC, switch PC back to Session 1, then finish Session 2!
    const s2Step1Gate = armGate("APPROVAL_S2:step1");
    await pcPage.locator('[data-action="approval-once"]').click();
    await s2Step1Gate.entered.promise;

    await pcPage.locator(`aside [data-session-id="${s1Id}"]`).click();
    await pcPage.waitForFunction(
      ({ hid, sid }: { hid: string; sid: string }) => localStorage.getItem(`llmgw-rc-session:${hid}`) === sid,
      { hid: ctx.hostId, sid: s1Id },
      { timeout: 10000 },
    );

    s2Step1Gate.release.resolve();
    await waitForSessionIdle(ctx, s2Id, 15000);

    // Both PC & Mobile (viewing Session 1) must now show `UnreadDot` on idle Session 2!
    await pcS2Row.locator(`[data-session-unread="${s2Id}"] [data-indicator="unread-dot"]`).waitFor({
      state: "visible",
      timeout: 10000,
    });
    assert.equal(await pcS2Row.locator('[data-indicator="radial-spokes"]').count(), 0);
    await pcPage.waitForFunction(() => document.title === "• Indirect Code", undefined, { timeout: 5000 });
    await mobilePage.locator("[data-sidebar-unread-badge]").waitFor({ state: "visible", timeout: 10000 });

    // 2B. Test `window` `blur` protection on PC:
    // Select Session 2 on PC (clears unread), then BLUR PC while staying on Session 2,
    // and run `[TURN_TAG:BLUR_S2]`. Unfocused PC MUST NOT eat the unread dot!
    await setPageFocused(pcCdp, pcPage, true);
    await pcS2Row.click();
    await pcPage.waitForFunction(
      ({ sid }: { sid: string }) => document.querySelectorAll(`[data-session-unread="${sid}"]`).length === 0,
      { sid: s2Id },
      { timeout: 8000 },
    );
    await mobilePage.waitForFunction(
      () => document.querySelectorAll("[data-sidebar-unread-badge]").length === 0,
      undefined,
      { timeout: 10000 },
    );

    // Blur PC window while Session 2 remains selected on PC!
    await setPageFocused(pcCdp, pcPage, false);
    const blurGate = armGate("BLUR_S2:step0");
    await ctx.send({
      type: "prompt",
      sessionId: s2Id,
      text: "[TURN_TAG:BLUR_S2] Validate JWKS rotation window.",
      model: MODEL,
      yolo: true,
      options: { mode: "agentic", access: "full", effort: "high", skills: [{ name: "build" }] },
      attachmentIds: [],
    });
    await blurGate.entered.promise;
    blurGate.release.resolve();
    await waitForSessionIdle(ctx, s2Id, 15000);

    // Wait briefly to ensure unfocused PC does NOT auto-send `mark_session_seen`
    await Bun.sleep(450);
    const snapAfterBlur = await ctx.send({ type: "get_session", sessionId: s2Id });
    assert(
      (snapAfterBlur?.session?.attentionSeq ?? 0) > (snapAfterBlur?.session?.seenSeq ?? 0),
      `Unfocused (blurred) PC on Session 2 must NOT eat the unread watermark! got attentionSeq=${snapAfterBlur?.session?.attentionSeq}, seenSeq=${snapAfterBlur?.session?.seenSeq}`,
    );
    await pcS2Row.locator(`[data-session-unread="${s2Id}"] [data-indicator="unread-dot"]`).waitFor({
      state: "visible",
      timeout: 10000,
    });
    assert.equal(await pcPage.title(), "• Indirect Code");
    await mobilePage.locator("[data-sidebar-unread-badge]").waitFor({ state: "visible", timeout: 10000 });

    // Keep PC blurred on Session 2 so Mobile's ack is the sole source clearing PC's UnreadDot & title!
    // 2C. Complete a Talk session (`s4TalkId`) in the background and verify `Projects | Talk` tab dot on Mobile!
    await ctx.send({
      type: "prompt",
      sessionId: s4TalkId,
      text: "Summarize API gateway latency targets.",
      model: MODEL,
      yolo: true,
      options: { mode: "talk", access: "full", effort: "high", skills: [{ name: "talk" }] },
      attachmentIds: [],
    });
    await waitForSessionIdle(ctx, s4TalkId, 15000);

    // Open mobile drawer on `Projects` tab -> assert both Session 2 `UnreadDot` AND `Talk` segmented tab dot!
    await setPageFocused(mobCdp, mobilePage, true);
    await mobilePage.locator('button[aria-label="Expand sidebar"]').first().click();
    await mobS2Row.locator(`[data-session-unread="${s2Id}"] [data-indicator="unread-dot"]`).waitFor({
      state: "visible",
      timeout: 10000,
    });
    const mobTalkTabDot = mobilePage.locator(
      '[aria-label="Sidebar list view"] [aria-label="Unread talk conversations"]',
    );
    await mobTalkTabDot.waitFor({ state: "visible", timeout: 10000 });

    // View Talk session on Mobile first to clear Talk unread dot, then re-open drawer & tap Session 2 on Mobile!
    await mobilePage.locator('[aria-label="Sidebar list view"] button', { hasText: "Talk" }).first().click();
    const mobS4Row = mobilePage.locator(`aside [data-session-id="${s4TalkId}"]`);
    await mobS4Row.locator(`[data-session-unread="${s4TalkId}"] [data-indicator="unread-dot"]`).waitFor({
      state: "visible",
      timeout: 8000,
    });
    await mobS4Row.click(); // Selects s4TalkId and auto-closes mobile drawer -> marks s4TalkId seen!

    // Now open mobile drawer, switch back to `Projects` tab (Talk tab dot is now gone!), and tap Session 2 on Mobile!
    await mobilePage.locator('button[aria-label="Expand sidebar"]').first().click();
    await mobilePage.locator('[aria-label="Sidebar list view"] button', { hasText: "Projects" }).first().click();
    await mobilePage.waitForFunction(
      () =>
        document.querySelectorAll('[aria-label="Sidebar list view"] [aria-label="Unread talk conversations"]')
          .length === 0,
      undefined,
      { timeout: 8000 },
    );
    await mobS2Row.locator(`[data-session-unread="${s2Id}"] [data-indicator="unread-dot"]`).waitFor({
      state: "visible",
      timeout: 8000,
    });

    // Tap Session 2 on Mobile (`390x844`) -> auto-closes drawer and acknowledges Session 2!
    await mobS2Row.click();

    // Assert Mobile clears `SidebarToggle` badge and Session 2 row (zero dot, zero spinner):
    await mobilePage.waitForFunction(
      () => document.querySelectorAll("[data-sidebar-unread-badge]").length === 0,
      undefined,
      { timeout: 8000 },
    );
    await mobilePage.locator('button[aria-label="Expand sidebar"]').first().click();
    await mobS2Row.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await mobS2Row.locator('[data-indicator="unread-dot"]').count(), 0);
    assert.equal(await mobS2Row.locator('[data-indicator="radial-spokes"]').count(), 0);
    await mobilePage.locator('button[aria-label="Close sidebar"]').first().click();

    // Assert blurred PC clears Session 2 `UnreadDot` to empty AND restores `document.title === "Indirect Code"` via Mobile's ack!
    await pcPage.waitForFunction(
      ({ sid }: { sid: string }) => document.querySelectorAll(`[data-session-unread="${sid}"]`).length === 0,
      { sid: s2Id },
      { timeout: 10000 },
    );
    assert.equal(await pcS2Row.locator('[data-indicator="unread-dot"]').count(), 0);
    assert.equal(await pcS2Row.locator('[data-indicator="radial-spokes"]').count(), 0);
    await pcPage.waitForFunction(() => document.title === "Indirect Code", undefined, { timeout: 8000 });

    // Return PC to Session 1 and re-focus PC for Scenario 3
    await setPageFocused(pcCdp, pcPage, true);
    await pcPage.locator(`aside [data-session-id="${s1Id}"]`).click();
    await pcPage.waitForFunction(
      ({ hid, sid }: { hid: string; sid: string }) => localStorage.getItem(`llmgw-rc-session:${hid}`) === sid,
      { hid: ctx.hostId, sid: s1Id },
      { timeout: 10000 },
    );

    // Fresh `lateDeviceContext` opened AFTER Mobile ack shows ZERO `UnreadDot` anywhere!
    const lateDeviceContext2 = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    try {
      const latePage2 = await lateDeviceContext2.newPage();
      await attachAuthInit(latePage2, ctx.login);
      await latePage2.goto(`${ctx.gwUrl}/#/code`, { waitUntil: "networkidle" });
      await latePage2.locator(`aside [data-session-id="${s2Id}"]`).waitFor({ state: "visible", timeout: 15000 });
      assert.equal(
        await latePage2.locator('[data-indicator="unread-dot"]').count(),
        0,
        "lateDeviceContext opened after Mobile ack must show ZERO UnreadDot",
      );
      assert.equal(await latePage2.title(), "Indirect Code");
    } finally {
      await lateDeviceContext2.close();
    }

    assertNoPageErrors(pcPageErrors, pcConsoleErrors, "Scenario 2 PC");
    assertNoPageErrors(mobPageErrors, mobConsoleErrors, "Scenario 2 Mobile");
    log("scenario-2", "PASSED: completion UnreadDot, blur protection, Talk tab dot & Mobile ack clearing all devices");

    // =========================================================================
    // SCENARIO 3: User-Initiated Stop (`[■]` in Sidebar Without Opening Session 3)
    // =========================================================================
    log("scenario-3", "Sidebar SessionStopButton ([■]): stop background session without opening -> ZERO UnreadDot");
    const s3StopGate = armGate("STOP_S3:step0");
    await ctx.send({
      type: "prompt",
      sessionId: s3Id,
      text: "Run migration dry-run inspection against schema migrations.",
      model: MODEL,
      yolo: true,
      options: { mode: "agentic", access: "full", effort: "high", skills: [{ name: "build" }] },
      attachmentIds: [],
    });
    await s3StopGate.entered.promise;

    const pcS3Row = pcPage.locator(`aside [data-session-id="${s3Id}"]`);
    const pcS3StopBtn = pcS3Row.locator('button[aria-label="Stop turn"]');
    await pcS3StopBtn.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(
      await pcS3StopBtn.locator('[data-indicator="radial-spokes"]').count(),
      1,
      "Unhovered SessionStopButton must display RadialSpokeSpinner",
    );

    // Hover & click `[■]` without opening Session 3 (PC stays on Session 1!)
    await pcS3StopBtn.hover();
    await pcS3StopBtn.click();
    await s3StopGate.aborted.promise;
    const snapAfterS3Stop = await waitForSessionIdle(ctx, s3Id, 15000);

    // Wait past mirror debounce (300ms) so any pull update would have arrived
    await Bun.sleep(500);
    assert.equal(snapAfterS3Stop?.session?.turn?.status, "cancelled");
    assert.equal(
      snapAfterS3Stop?.session?.seenSeq,
      snapAfterS3Stop?.session?.attentionSeq,
      "User-initiated sidebar Stop must mark session seen (seenSeq === attentionSeq)",
    );
    assert.equal(await pcS3Row.locator('[data-indicator="unread-dot"]').count(), 0);
    assert.equal(await pcS3Row.locator('[data-indicator="radial-spokes"]').count(), 0);
    assert.equal(await pcPage.title(), "Indirect Code");
    assert.equal(
      await pcPage.evaluate((hid: string) => localStorage.getItem(`llmgw-rc-session:${hid}`), ctx.hostId),
      s1Id,
      "Clicking SessionStopButton in sidebar must NOT switch activeSessionId away from Session 1",
    );

    assertNoPageErrors(pcPageErrors, pcConsoleErrors, "Scenario 3 PC");
    log("scenario-3", "PASSED: sidebar Stop ([■]) cancelled Session 3 cleanly with ZERO UnreadDot");

    // =========================================================================
    // SCENARIO 4: Simultaneous Live Status Grammars + Unread States & 2x DPI Captures
    // =========================================================================
    log("scenario-4", "Simultaneous live grammars + 3 sidebar states (RadialSpokeSpinner / UnreadDot / Seen Idle)");

    // Ensure Mobile is viewing Session 3 (so Mobile is NOT viewing Session 2 or Session 4!)
    await selectSessionInUI(mobilePage, ctx.gwUrl, ctx.hostId, s3Id, "agentic");
    const mobCloseBeforeS4 = mobilePage.locator('button[aria-label="Close sidebar"]').first();
    if ((await mobCloseBeforeS4.count()) > 0 && (await mobCloseBeforeS4.isVisible().catch(() => false))) {
      await mobCloseBeforeS4.click();
      await mobilePage.waitForTimeout(200);
    }

    // Trigger unread completions in Session 2 (Projects) AND Session 4 (Talk) while PC views Session 1 and Mobile views Session 3!
    await ctx.send({
      type: "prompt",
      sessionId: s2Id,
      text: "Rotate signing key configuration and report fingerprint.",
      model: MODEL,
      yolo: true,
      options: { mode: "agentic", access: "full", effort: "high", skills: [{ name: "build" }] },
      attachmentIds: [],
    });
    await waitForSessionIdle(ctx, s2Id, 15000);

    await ctx.send({
      type: "prompt",
      sessionId: s4TalkId,
      text: "Summarize API gateway latency targets for Q4.",
      model: MODEL,
      yolo: true,
      options: { mode: "talk", access: "full", effort: "high", skills: [{ name: "talk" }] },
      attachmentIds: [],
    });
    await waitForSessionIdle(ctx, s4TalkId, 15000);

    // Start Session 1 live grammar turn on PC:
    // Step 0 runs `bun dev-watch.js` -> detaches after 1s into BackgroundCard (`ProcessEqualizer`);
    // Step 1 holds at `GRAMMAR_S1:step1` so `▾ Ran 1 command` shimmers + `Working` `NeuralMatrixLoader`!
    const grammarStep1Gate = armGate("GRAMMAR_S1:step1");
    await setPageFocused(pcCdp, pcPage, true);
    await sendFromComposer(
      pcPage,
      "Start the dev watcher in the background and verify cross-device unread sync watermarks.",
    );
    await grammarStep1Gate.entered.promise;

    // Queue 3 follow-ups and stage #1 into `Next step` bubble while keeping #2 & #3 in `ComposerQueueShelf` (`Queued` 2)!
    await sendFromComposer(pcPage, "Also verify reduced-motion fallbacks across dark and light themes");
    await sendFromComposer(pcPage, "Run Go daemon race detector suite after sync check");
    await sendFromComposer(pcPage, "Prepare release changelog summary");

    await pcPage
      .locator('[data-queue-passive] [data-queue-item-state="queue"]')
      .nth(0)
      .locator('[data-action="queue-send-next"]')
      .click();

    // Verify ALL simultaneous live grammars + 3 sidebar row states on Desktop (`1280x800`):
    await pcPage.locator('[data-step-rail-header] .ui-shimmer', { hasText: "Ran 1 command" }).waitFor({
      state: "visible",
      timeout: 10000,
    });
    await pcPage.locator('[data-bg-card] [data-indicator="process-equalizer"]').waitFor({
      state: "visible",
      timeout: 10000,
    });
    await pcPage.locator('[data-queue-staged] [data-queue-item-state="steer"]').waitFor({
      state: "visible",
      timeout: 10000,
    });
    await pcPage.locator("[data-composer-queue-shelf]").waitFor({ state: "visible", timeout: 10000 });
    await pcPage.locator('[data-turn-status] [data-indicator="neural-matrix"]').waitFor({
      state: "visible",
      timeout: 10000,
    });
    assert(
      ((await pcPage.locator("[data-turn-status]").textContent()) || "").includes("Working"),
      "Expected 'Working' status next to NeuralMatrixLoader",
    );

    // Sidebar 3-state simultaneous check on PC:
    // (a) Session 1 (active/seen running) -> RadialSpokeSpinner
    assert.equal(
      await pcPage.locator(`aside [data-session-id="${s1Id}"] [data-indicator="radial-spokes"]`).count(),
      1,
    );
    assert.equal(await pcPage.locator(`aside [data-session-id="${s1Id}"] [data-indicator="unread-dot"]`).count(), 0);
    // (b) Session 2 (unread background) -> UnreadDot
    assert.equal(await pcPage.locator(`aside [data-session-id="${s2Id}"] [data-indicator="unread-dot"]`).count(), 1);
    assert.equal(
      await pcPage.locator(`aside [data-session-id="${s2Id}"] [data-indicator="radial-spokes"]`).count(),
      0,
    );
    // (c) Session 3 (seen finished) -> clean empty state (zero dot, zero spinner)
    assert.equal(await pcPage.locator(`aside [data-session-id="${s3Id}"] [data-indicator="unread-dot"]`).count(), 0);
    assert.equal(
      await pcPage.locator(`aside [data-session-id="${s3Id}"] [data-indicator="radial-spokes"]`).count(),
      0,
    );
    // Zero legacy `loader-circle` spinners anywhere in live workspace!
    assert.equal(await pcPage.locator('[data-icon="lucide:loader-circle"]').count(), 0);

    if (SCREENSHOTS_DIR) {
      mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const desktopOut = path.join(SCREENSHOTS_DIR, "final_unread_and_grammar_desktop.png");
      await pcPage.screenshot({ path: desktopOut });
      log("screenshot", `Saved 2x DPI desktop capture -> ${desktopOut}`);

      // Mobile 2x DPI capture:
      // Frame 1: Closed drawer showing mobile header `SidebarToggle` corner unread dot (`data-sidebar-unread-badge`)
      await mobilePage.locator("[data-sidebar-unread-badge]").waitFor({ state: "visible", timeout: 10000 });
      const mobClosedBuf = Buffer.from(await mobilePage.screenshot());

      // Frame 2: Open mobile drawer showing `UnreadDot` (Session 2), `RadialSpokeSpinner` (Session 1),
      // clean seen finished row (Session 3), AND `Projects | Talk` unread dot!
      await mobilePage.locator('button[aria-label="Expand sidebar"]').first().click();
      await mobilePage.locator(`aside [data-session-id="${s1Id}"] [data-indicator="radial-spokes"]`).waitFor({
        state: "visible",
        timeout: 10000,
      });
      await mobilePage.locator(`aside [data-session-id="${s2Id}"] [data-indicator="unread-dot"]`).waitFor({
        state: "visible",
        timeout: 10000,
      });
      await mobilePage
        .locator('[aria-label="Sidebar list view"] [aria-label="Unread talk conversations"]')
        .waitFor({ state: "visible", timeout: 10000 });
      await mobilePage.waitForTimeout(250);
      const mobOpenBuf = Buffer.from(await mobilePage.screenshot());

      const mobileOut = path.join(SCREENSHOTS_DIR, "final_unread_mobile.png");
      await stitchMobileSideBySide(browser, mobClosedBuf, mobOpenBuf, mobileOut);
      log("screenshot", `Saved 2x DPI mobile capture -> ${mobileOut}`);
    }

    // Cleanly stop detached background task & active turn before tearing down temp dirs!
    const bgStopBtn = pcPage.locator("[data-bg-stop]").first();
    if ((await bgStopBtn.count()) > 0 && (await bgStopBtn.isVisible().catch(() => false))) {
      await bgStopBtn.click();
    }
    ctx.ws.send(JSON.stringify({ type: "cancel", hostId: ctx.hostId, sessionId: s1Id }));
    await grammarStep1Gate.aborted.promise;
    await waitForSessionIdle(ctx, s1Id, 15000);

    assertNoPageErrors(pcPageErrors, pcConsoleErrors, "Scenario 4 PC");
    assertNoPageErrors(mobPageErrors, mobConsoleErrors, "Scenario 4 Mobile");

    await pcContext.close();
    await mobileContext.close();

    log("scenario-4", "PASSED: simultaneous live grammars + 3 sidebar row states verified");
    log("done", "ALL CROSS-DEVICE UNREAD & LIVE GRAMMAR E2E SCENARIOS PASSED");
  } finally {
    try {
      ctx.ws.close();
    } catch {}
    await browser.close().catch(() => {});
  }
} finally {
  upstreamServer.stop(true);
  for (const p of procs) {
    try {
      p.kill();
    } catch {}
  }
  await Bun.sleep(400);
  for (const dir of tempDirs) {
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(500);
      }
    }
  }
}
