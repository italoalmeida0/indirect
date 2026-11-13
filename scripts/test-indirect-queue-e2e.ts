/**
 * scripts/test-indirect-queue-e2e.ts — full-stack Chromium + Go Daemon + Bun Gateway
 * E2E suite verifying mid-turn message queuing, whisper-quiet "Next step"
 * ("steer") staging, cancel-return-to-queue (`×`), passive reorder, same-turn steer
 * wire injection, host `mid_turn_send` settings persistence ("queue" / "steer" /
 * "interrupt"), force-interrupt partial thinking/text preservation, plain Stop
 * demotion, mobile `390x844` layout/touch targets, and WAL reload durability.
 *
 * Modes:
 *   1. Default deterministic gated mock upstream:
 *      bun scripts/test-indirect-queue-e2e.ts
 *   2. Optional live OpenRouter mode (requires OPENROUTER_API_KEY in env):
 *      OPENROUTER_API_KEY=... [OPENROUTER_MODEL=deepseek/deepseek-chat] bun scripts/test-indirect-queue-e2e.ts --live-openrouter
 *
 * Prerequisites: web dist/ built (`bun run build:web`), daemon binary built
 * (`bun run build:daemon`).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIVE_OPENROUTER = process.argv.includes("--live-openrouter");
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat").trim();

if (LIVE_OPENROUTER && !OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY environment variable is required for --live-openrouter mode");
  process.exit(2);
}

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
const MODEL = LIVE_OPENROUTER ? OPENROUTER_MODEL : "mock-queue-e2e-v1";

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
  turnTag: string;
  stepToolResults: number;
  userTexts: string[];
  messages: any[];
  aborted: boolean;
}

interface GateHandle {
  entered: Deferred<RecordedUpstreamCall>;
  release: Deferred<void>;
  aborted: Deferred<void>;
}

const activeGates = new Map<string, GateHandle>();
const upstreamCalls: RecordedUpstreamCall[] = [];
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

function findLatestTurnTag(messages: any[]): { tag: string; tagIdx: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const m = /\[TURN_TAG:([A-Z0-9_]+)\]/.exec(textOfMessage(messages[i]));
    if (m) return { tag: m[1]!, tagIdx: i };
  }
  return { tag: "", tagIdx: -1 };
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
  const respId = `chatcmpl-queue-${opts.callRecord.seq}`;
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

      // SSE comment padding ensures immediate TCP/HTTP chunk flush across OS loopback buffers before holding gate.
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
          usage: { prompt_tokens: 320, completion_tokens: 64, total_tokens: 384 },
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

async function handleLiveOpenRouterProxy(
  req: Request,
  rawBody: string,
  callRecord: RecordedUpstreamCall,
  gate?: GateHandle,
): Promise<Response> {
  const upstreamAbort = new AbortController();
  const onClientAbort = () => {
    callRecord.aborted = true;
    gate?.aborted.resolve();
    upstreamAbort.abort();
  };
  req.signal.addEventListener("abort", onClientAbort, { once: true });

  const upstreamResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: rawBody,
    signal: upstreamAbort.signal,
  });

  if (!upstreamResp.ok || !upstreamResp.body) {
    gate?.entered.resolve(callRecord);
    return new Response(await upstreamResp.text(), {
      status: upstreamResp.status,
      headers: { "content-type": upstreamResp.headers.get("content-type") || "application/json" },
    });
  }

  if (!gate) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: { "content-type": upstreamResp.headers.get("content-type") || "text/event-stream" },
    });
  }

  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const isTerminalSseBlock = (block: string) =>
    block.includes("data: [DONE]") ||
    /"finish_reason"\s*:\s*"(stop|tool_calls|length|content_filter)"/.test(block);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let gateTriggered = false;
      let sseBuf = "";
      let heldRemainder = "";
      const waitGate = async () => {
        if (gateTriggered) return;
        gateTriggered = true;
        controller.enqueue(encoder.encode(`: ${"f".repeat(2048)}\n\n`));
        gate.entered.resolve(callRecord);
        await Promise.race([gate.release.promise, gate.aborted.promise]);
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            if (!gateTriggered) {
              heldRemainder += sseBuf;
              sseBuf = "";
              await waitGate();
              if (!req.signal.aborted && heldRemainder) {
                controller.enqueue(encoder.encode(heldRemainder));
                heldRemainder = "";
              }
            } else if (sseBuf && !req.signal.aborted) {
              controller.enqueue(encoder.encode(sseBuf));
            }
            break;
          }
          if (!value || value.byteLength === 0) continue;
          if (gateTriggered) {
            controller.enqueue(value);
            continue;
          }
          sseBuf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let sepIdx: number;
          while ((sepIdx = sseBuf.indexOf("\n\n")) !== -1) {
            const block = sseBuf.slice(0, sepIdx + 2);
            sseBuf = sseBuf.slice(sepIdx + 2);
            if (!gateTriggered && isTerminalSseBlock(block)) {
              heldRemainder = block + sseBuf;
              sseBuf = "";
              await waitGate();
              if (req.signal.aborted) break;
              if (heldRemainder) {
                controller.enqueue(encoder.encode(heldRemainder));
                heldRemainder = "";
              }
              break;
            }
            controller.enqueue(encoder.encode(block));
            if (!gateTriggered && block.includes('"delta"')) {
              heldRemainder = sseBuf;
              sseBuf = "";
              await waitGate();
              if (req.signal.aborted) break;
              if (heldRemainder) {
                controller.enqueue(encoder.encode(heldRemainder));
                heldRemainder = "";
              }
              break;
            }
          }
          if (req.signal.aborted) break;
        }
      } catch {
        // aborted or closed
      } finally {
        if (!gateTriggered) gate.entered.resolve(callRecord);
        try {
          controller.close();
        } catch {}
        try {
          await reader.cancel();
        } catch {}
      }
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

    // Auxiliary title/compaction helper calls return immediately without touching turn gates.
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
        choices: [{ index: 0, message: { role: "assistant", content: "Queue E2E Session" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
      });
    }

    const finishReply = (id: string, text: string): StreamCompletion =>
      hasFinishTool
        ? { kind: "tool", id, name: "finish_entire_request", args: { final_message_to_user: text } }
        : { kind: "text", text };

    const { tag: turnTag, tagIdx } = findLatestTurnTag(messages);
    const stepToolResults =
      tagIdx >= 0 ? messages.slice(tagIdx + 1).filter((m) => m?.role === "tool").length : 0;
    const userTexts = messages.filter((m) => m?.role === "user").map(textOfMessage);
    const seq = ++upstreamSeq;
    const callRecord: RecordedUpstreamCall = {
      seq,
      turnTag,
      stepToolResults,
      userTexts,
      messages,
      aborted: false,
    };
    upstreamCalls.push(callRecord);

    const gateKey = `${turnTag}:step${stepToolResults}`;
    const gate = activeGates.get(gateKey) || activeGates.get(`${turnTag}:any`);
    if (gate) {
      activeGates.delete(gateKey);
      activeGates.delete(`${turnTag}:any`);
    }

    if (LIVE_OPENROUTER) {
      return handleLiveOpenRouterProxy(req, rawBody, callRecord, gate);
    }

    // Scenario 1: Step 0 reads notes.txt (gated); Step 1 receives steered M2 and finishes Turn 1 (gated).
    if (turnTag === "S1_TURN1") {
      if (stepToolResults === 0) {
        return buildGatedMockStream({
          req,
          model,
          callRecord,
          gate,
          thinkingPrefix: "Planning step 1 workspace read for S1_TURN1.",
          textPrefix: "Reading notes.txt before proceeding...",
          completion: {
            kind: "tool",
            id: `call_s1_read_${seq}`,
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
        thinkingPrefix: "Incorporating steered instructions into step 2.",
        textPrefix: "",
        completion: {
          kind: "tool",
          id: `call_s1_finish_${seq}`,
          name: "finish_entire_request",
          args: {
            final_message_to_user: "Completed Turn 1 after processing notes.txt and steered instructions.",
          },
        },
      });
    }

    // Scenario 2: Interrupt from QueueCard staged card while streaming thinking + text.
    if (turnTag === "S2_INTERRUPT_CARD") {
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "PARTIAL_THINKING_ALPHA_901: evaluating multi-step plan deeply.",
        textPrefix: "PARTIAL_TEXT_ALPHA_901: drafting initial response section before interrupt...",
        completion: finishReply(`call_s2_card_finish_${seq}`, "Uninterrupted S2_INTERRUPT_CARD completion."),
      });
    }

    // Scenario 2: Interrupt directly from Composer when host mid_turn_send="interrupt" while streaming thinking + text.
    if (turnTag === "S2_INTERRUPT_MENU") {
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "PARTIAL_THINKING_BETA_902: checking concurrency invariants.",
        textPrefix: "PARTIAL_TEXT_BETA_902: streaming live assistant commentary before menu interrupt...",
        completion: finishReply(`call_s2_menu_finish_${seq}`, "Uninterrupted S2_INTERRUPT_MENU completion."),
      });
    }

    // Scenario 2: Plain Stop while an item is staged in "Sending on next step".
    if (turnTag === "S2_PLAIN_STOP") {
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "Holding turn open for plain Stop verification.",
        textPrefix: "Working on S2_PLAIN_STOP...",
        completion: finishReply(`call_s2_stop_finish_${seq}`, "Unstopped S2_PLAIN_STOP completion."),
      });
    }

    // Scenario 3: Mobile 390x844 gated turn with staged + passive queue items.
    if (turnTag === "S3_MOBILE_QUEUE") {
      return buildGatedMockStream({
        req,
        model,
        callRecord,
        gate,
        thinkingPrefix: "Holding mobile turn open for 390x844 layout and reload inspection.",
        textPrefix: "Mobile turn active...",
        completion: finishReply(`call_s3_mob_finish_${seq}`, "Completed mobile turn."),
      });
    }

    // Default fast completion for drained queued messages / interrupting follow-up turns.
    const latestUser = userTexts[userTexts.length - 1] || "follow-up";
    return buildGatedMockStream({
      req,
      model,
      callRecord,
      gate,
      thinkingPrefix: "",
      textPrefix: "",
      completion: finishReply(`call_fast_finish_${seq}`, `Handled request: ${latestUser.slice(0, 80)}`),
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
const ADMIN_PW = "e2e-queue-suite-pass-1";
const procs: Array<{ kill: () => void }> = [];
const tempDirs: string[] = [];

async function boot() {
  const gwPort = Number(process.env.E2E_QUEUE_GW_PORT || (await pickFreePort()));
  const gwUrl = `http://127.0.0.1:${gwPort}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-queue-e2e-"));
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
        name: "queue-e2e-provider",
        openaiBaseUrl: UPSTREAM_URL,
        apiKey: LIVE_OPENROUTER ? OPENROUTER_API_KEY : "mock-queue-key",
        openaiAuthStyle: "bearer",
      }),
    })
  ).json();
  assert(provRes.success, `provider create failed: ${JSON.stringify(provRes)}`);
  const list: any = await (await fetch(`${gwUrl}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  const providerId = (list.providers || []).find((p: any) => p.name === "queue-e2e-provider")?.id;
  assert(providerId, "queue-e2e-provider id missing");

  const mkModel: any = await (
    await fetch(`${gwUrl}/api/admin/models`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: MODEL, providerId, upstreamModel: MODEL, contextLength: 128000 }),
    })
  ).json();
  assert(mkModel.success, `model create failed: ${JSON.stringify(mkModel)}`);

  const pair: any = await (
    await fetch(`${gwUrl}/api/indirect-code/pair`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` } })
  ).json();
  assert(pair.success && pair.connectUrl, "pairing failed");

  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-queue-d-"));
  tempDirs.push(daemonDir);
  const workDir = path.join(daemonDir, "workspace");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "notes.txt"), "Queue E2E workspace fixture\nLine 2: verified.\n", "utf8");

  let extraPath = process.env.PATH || "";
  if (process.platform === "win32") {
    const cachedUnish = path.join(homedir(), ".indirect-code", "external", "bin", "unish.exe");
    if (existsSync(cachedUnish)) {
      const destUnish = path.join(daemonDir, "external", "bin", "unish.exe");
      mkdirSync(path.dirname(destUnish), { recursive: true });
      copyFileSync(cachedUnish, destUnish);
      extraPath = `${path.dirname(destUnish)};${extraPath}`;
    }
    const gitBin = "C:\\Program Files\\Git\\bin";
    if (existsSync(gitBin)) {
      extraPath = `${gitBin};${extraPath}`;
    }
  }

  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "Queue E2E Host"],
    {
      cwd: WS,
      env: { ...process.env, HOME: daemonDir, PATH: extraPath },
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
    const h: any = await (await fetch(`${gwUrl}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
    const f = (h.hosts || []).find((x: any) => x.name === "Queue E2E Host" && x.status === "online");
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

  log("boot", `mode=${LIVE_OPENROUTER ? `live-openrouter(${MODEL})` : "gated-mock"} gw=${gwUrl} host=${hostId}`);
  return { gwUrl, jwt, login, hostId, ws, send, pullCollection, daemonDir, workDir, events };
}

async function createTestSession(
  ctx: Awaited<ReturnType<typeof boot>>,
  title: string,
  mode: "agentic" | "talk" = "agentic",
): Promise<string> {
  const created: any = await ctx.send({
    type: "create_session",
    cwd: ctx.workDir,
    title,
    model: MODEL,
    options:
      mode === "talk"
        ? { mode: "talk", access: "full", effort: "high", skills: [{ name: "talk" }] }
        : { mode: "agentic", access: "full", effort: "high", skills: [{ name: "build" }] },
  });
  const sid = created?.session?.id;
  assert(sid, `create_session failed for "${title}": ${JSON.stringify(created)}`);
  // Confirm the session is visible in the pull mirror before navigating UI.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pulled = await ctx.pullCollection("sessions");
    if ((pulled?.items || []).some((s: any) => s?.id === sid)) break;
    await Bun.sleep(80);
  }
  return sid;
}

async function selectSessionInUI(
  page: any,
  gwUrl: string,
  hostId: string,
  sessionId: string,
  title: string,
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

  // Select the matching sidebar list tab ("Projects" for agentic, "Talk" for talk).
  const segLabel = mode === "talk" ? "Talk" : "Projects";
  const segBtn = page.locator('[aria-label="Sidebar list view"] button', { hasText: segLabel }).first();
  await segBtn.waitFor({ state: "visible", timeout: 15000 });
  await segBtn.click();

  // Wait for SignalDB mirror to render the session row in the sidebar and click it.
  const entry = page.locator("aside").getByText(title, { exact: true }).first();
  await entry.waitFor({ state: "visible", timeout: 15000 });
  await entry.click();

  // Confirm activeSessionId is bound to sessionId and composer is in existing-session "Send" mode.
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

async function getPassiveQueueTexts(page: any): Promise<string[]> {
  return page.locator('[data-queue-passive] [data-queue-item-state="queue"]').evaluateAll((rows: HTMLElement[]) =>
    rows.map((row) => {
      const textEl = row.querySelector("[data-queue-item-text]") || row.querySelectorAll("span")[1];
      return (textEl?.textContent || "").trim();
    }),
  );
}

async function waitForPassiveQueueTexts(page: any, expected: string[], timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await getPassiveQueueTexts(page);
    if (last.length === expected.length && last.every((v, i) => v === expected[i])) return;
    await Bun.sleep(80);
  }
  assert.deepEqual(last, expected, `passive queue order mismatch after ${timeoutMs}ms`);
}

async function waitForSessionIdleAndEmptyQueue(
  ctx: Awaited<ReturnType<typeof boot>>,
  sessionId: string,
  timeoutMs = 30000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await ctx.send({ type: "get_session", sessionId });
    const status = snap?.session?.status;
    const qLen = Array.isArray(snap?.session?.queue) ? snap.session.queue.length : 0;
    if (status && status !== "running" && qLen === 0) return snap;
    await Bun.sleep(150);
  }
  const snap = await ctx.send({ type: "get_session", sessionId });
  throw new Error(
    `session ${sessionId} did not become idle with empty queue within ${timeoutMs}ms (status=${snap?.session?.status}, queue=${snap?.session?.queue?.length})`,
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
    await Bun.sleep(120);
  }
  const snap = await ctx.send({ type: "get_session", sessionId });
  throw new Error(`session ${sessionId} did not become idle within ${timeoutMs}ms (status=${snap?.session?.status})`);
}

try {
  const ctx = await boot();
  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const protocolErrors: string[] = [];

    page.on("pageerror", (e: Error) => pageErrors.push(String(e).slice(0, 400)));
    page.on("console", (m: any) => {
      if (m.type() === "error") consoleErrors.push(String(m.text()).slice(0, 400));
    });

    await page.addInitScript(
      ({ sess }: any) => {
        if (!localStorage.getItem("cache_code_session")) {
          localStorage.setItem("cache_code_session", JSON.stringify(sess));
        }
      },
      {
        sess: { accessToken: ctx.login.accessToken, refreshToken: ctx.login.refreshToken, user: ctx.login.user },
      },
    );

    const TURN_TIMEOUT = LIVE_OPENROUTER ? 60000 : 30000;

    // =========================================================================
    // SCENARIO 1: Desktop 1280x800 — Intermediate "Sending on next step" Staging
    //             + `×` Cancel Return-to-Queue + Reorder + Same-Turn Steer Wire Injection
    // =========================================================================
    log("scenario-1", "Desktop 1280x800: staging, × cancel return-to-queue, collapse/expand, reorder & steer injection");
    const s1Id = await createTestSession(ctx, "Queue Suite S1");
    await selectSessionInUI(page, ctx.gwUrl, ctx.hostId, s1Id, "Queue Suite S1");

    const s1Step0Gate = armGate("S1_TURN1:step0");

    await sendFromComposer(
      page,
      "[TURN_TAG:S1_TURN1] Use the read tool to read notes.txt first, then call finish_entire_request with a short summary.",
    );
    await s1Step0Gate.entered.promise;
    const s1Step1Gate = armGate("S1_TURN1:any");

    assert.equal(
      await page.locator("[data-composer-midturn-mode]").count(),
      0,
      "running composer must not render a mid-turn mode switcher pill",
    );
    const appNoticeDismiss = page.locator('button[aria-label="Dismiss notification"]');

    const M1 = "Queued alpha M1 — call finish_entire_request immediately acknowledging M1.";
    const M2 = "Steer beta M2 — include M2 in your summary and call finish_entire_request.";
    const M3 = "Queued gamma M3 — call finish_entire_request immediately acknowledging M3.";
    await sendFromComposer(page, M1);
    await sendFromComposer(page, M2);
    await sendFromComposer(page, M3);

    await waitForPassiveQueueTexts(page, [M1, M2, M3]);
    assert.equal(
      await page.locator("[data-composer-queue-shelf]").count(),
      1,
      "passive queue items must dock onto ComposerQueueShelf ([data-composer-queue-shelf])",
    );
    assert.equal(await page.locator("[data-queue-staged]").count(), 0, "Zone 1 should not exist before staging");
    assert.equal(await appNoticeDismiss.count(), 0, "queuing mid-turn must not stack a foreground appNotice toast");

    // Promote M2 ("queue-send-next") -> Zone 1 slim single-line "Next step", passive has [M1, M3]
    await page
      .locator('[data-queue-passive] [data-queue-item-state="queue"]')
      .nth(1)
      .locator('[data-action="queue-send-next"]')
      .click();

    const stagedSteer = page.locator('[data-queue-staged] [data-queue-item-state="steer"]');
    await stagedSteer.waitFor({ state: "visible", timeout: 10000 });
    const steerBox = await stagedSteer.boundingBox();
    const stagedWrapBox = await page.locator("[data-queue-staged]").boundingBox();
    assert(
      steerBox && steerBox.height > 0 && steerBox.height <= 46,
      `expected slim single-line [data-queue-item-state="steer"] height <= 46px on 1280x800, got ${steerBox?.height}`,
    );
    assert(
      stagedWrapBox && Math.abs(steerBox.x + steerBox.width - (stagedWrapBox.x + stagedWrapBox.width)) <= 2,
      `expected right-aligned Next step bubble at right edge of [data-queue-staged], got bubbleRight=${steerBox.x + steerBox.width} vs wrapRight=${stagedWrapBox ? stagedWrapBox.x + stagedWrapBox.width : "null"}`,
    );
    assert.equal(await appNoticeDismiss.count(), 0, "staging item must not stack a foreground appNotice toast");
    const stagedText = ((await stagedSteer.textContent()) || "").trim();
    assert(stagedText.includes("Next step"), `expected "Next step", got "${stagedText}"`);
    assert(stagedText.includes(M2), `expected staged item to contain "${M2}", got "${stagedText}"`);
    assert(
      await stagedSteer.locator('[data-action="queue-cancel-send"]').isVisible(),
      "expected × (queue-cancel-send) button on staged item",
    );
    await waitForPassiveQueueTexts(page, [M1, M3]);

    // Collapse passive queue -> Zone 1 ("Next step") MUST remain visible!
    await page.locator('[data-queue-passive] button[aria-label="Collapse queue"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-queue-passive] [data-queue-item-state="queue"]').length === 0,
      undefined,
      { timeout: 5000 },
    );
    assert(
      await stagedSteer.isVisible(),
      "Zone 1 (Next step) must remain visible when passive queue is collapsed",
    );

    // Re-expand passive queue
    await page.locator('[data-queue-passive] button[aria-label="Expand queue"]').click();
    await waitForPassiveQueueTexts(page, [M1, M3]);

    // Click × (`queue-cancel-send`) on M2 -> Zone 1 disappears and passive restores exact order [M1, M2, M3]!
    await stagedSteer.locator('[data-action="queue-cancel-send"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-queue-staged]").length === 0,
      undefined,
      { timeout: 8000 },
    );
    assert.equal(await appNoticeDismiss.count(), 0, "cancelling staged send must not stack a foreground appNotice toast");
    await waitForPassiveQueueTexts(page, [M1, M2, M3]);

    // Reorder passive items: move M1 down -> [M2, M1, M3]; move M3 up -> [M2, M3, M1]
    await page
      .locator('[data-queue-passive] [data-queue-item-state="queue"]')
      .nth(0)
      .locator('[data-action="queue-move-down"]')
      .click();
    await waitForPassiveQueueTexts(page, [M2, M1, M3]);

    await page
      .locator('[data-queue-passive] [data-queue-item-state="queue"]')
      .nth(2)
      .locator('[data-action="queue-move-up"]')
      .click();
    await waitForPassiveQueueTexts(page, [M2, M3, M1]);

    // Stage M2 again via queue-send-next -> Zone 1 has M2, passive has [M3, M1]
    await page
      .locator('[data-queue-passive] [data-queue-item-state="queue"]')
      .nth(0)
      .locator('[data-action="queue-send-next"]')
      .click();
    await stagedSteer.waitFor({ state: "visible", timeout: 8000 });
    await waitForPassiveQueueTexts(page, [M3, M1]);

    // Release Step 0 gate -> daemon executes `read` tool, consumes ONLY steered M2 in BeforeRequest,
    // and dispatches Step 1 of the SAME turn to the upstream!
    s1Step0Gate.release.resolve();
    const step1Call = await s1Step1Gate.entered.promise;

    const step1JoinedUsers = step1Call.userTexts.join("\n");
    assert(
      step1JoinedUsers.includes(M2),
      `expected steered message "${M2}" to be injected into Step 2 of the SAME turn on upstream wire, got userTexts=${JSON.stringify(step1Call.userTexts)}`,
    );
    assert(
      !step1JoinedUsers.includes(M3) && !step1JoinedUsers.includes(M1),
      `passive queued messages M3/M1 must NOT be injected mid-turn, got userTexts=${JSON.stringify(step1Call.userTexts)}`,
    );

    // While Step 2 of Turn 1 is still held open, Zone 1 is empty (consumed) and passive [M3, M1] still waits!
    await page.waitForFunction(
      () => document.querySelectorAll("[data-queue-staged]").length === 0,
      undefined,
      { timeout: 8000 },
    );
    await waitForPassiveQueueTexts(page, [M3, M1]);

    // Release Step 2 gate -> Turn 1 finishes, then passive [M3, M1] auto-drains in reordered order!
    const callIdxBeforeDrain = upstreamCalls.length;
    s1Step1Gate.release.resolve();
    const snapAfterS1 = await waitForSessionIdleAndEmptyQueue(ctx, s1Id, TURN_TIMEOUT);

    const drainedCalls = upstreamCalls.slice(callIdxBeforeDrain);
    const firstM3Idx = drainedCalls.findIndex((c) => c.userTexts.some((u) => u.includes(M3)));
    const firstM1Idx = drainedCalls.findIndex((c) => c.userTexts.some((u) => u.includes(M1)));
    assert(
      firstM3Idx >= 0,
      `expected reordered M3 to auto-drain after Turn 1, got userTexts=${JSON.stringify(drainedCalls.map((c) => c.userTexts.at(-1)))}`,
    );
    assert(
      firstM1Idx > firstM3Idx,
      `expected reordered M1 to auto-drain strictly after M3 (firstM3Idx=${firstM3Idx}, firstM1Idx=${firstM1Idx})`,
    );
    assert(
      !drainedCalls.slice(0, firstM3Idx + 1).some((c) => c.userTexts.some((u) => u.includes(M1))),
      "M1 must not appear in upstream calls before or during M3's first step",
    );
    const finalS1UserTexts = (snapAfterS1?.session?.messages || [])
      .filter((m: any) => m?.role === "user")
      .map((m: any) => textOfMessage(m));
    const msgM2Idx = finalS1UserTexts.findIndex((t: string) => t.includes(M2));
    const msgM3Idx = finalS1UserTexts.findIndex((t: string) => t.includes(M3));
    const msgM1Idx = finalS1UserTexts.findIndex((t: string) => t.includes(M1));
    assert(
      msgM2Idx >= 0 && msgM3Idx > msgM2Idx && msgM1Idx > msgM3Idx,
      `expected persisted session.messages user order M2 -> M3 -> M1, got indices [${msgM2Idx}, ${msgM3Idx}, ${msgM1Idx}]`,
    );

    assertNoPageErrors(pageErrors, consoleErrors, "Scenario 1");
    log("scenario-1", "PASSED: staging, collapse invariance, × return-to-queue, reorder, same-turn steer injection & ordered drain");

    // =========================================================================
    // SCENARIO 2: Desktop 1280x800 — Settings Default Mode (`mid_turn_send`) +
    //             Force Interrupt (`interrupt` card & host setting) + Plain Stop
    // =========================================================================
    log("scenario-2", "Desktop 1280x800: SettingsModal mid_turn_send=steer/interrupt, force interrupt & plain Stop demotion");
    const s2Id = await createTestSession(ctx, "Queue Suite S2", "talk");
    await selectSessionInUI(page, ctx.gwUrl, ctx.hostId, s2Id, "Queue Suite S2", "talk");

    const revBeforeSave = (await ctx.pullCollection("config"))?.items?.[0]?.revision;
    assert(revBeforeSave, "expected non-empty initial config revision in pull-response items[0]");

    // Open SettingsModal -> select "Send on next step" (`steer`) -> Save changes
    await page.locator('button[aria-label="Host & agent settings: Settings"]').click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    const steerRadio = dialog.locator('[data-midturn-radio="steer"]');
    await steerRadio.scrollIntoViewIfNeeded();
    await steerRadio.click();
    assert.equal(await steerRadio.getAttribute("aria-checked"), "true");

    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 15000 });
    // The "Settings saved on the host" notice lands on the daemon ack, which can
    // trail the dialog exit: wait for it briefly, dismiss it, and let it leave.
    if (await appNoticeDismiss.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
      await appNoticeDismiss.first().click();
      await appNoticeDismiss.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }

    // Assert config.json on disk & SignalDB/pull mirror reflect mid_turn_send: "steer" and new revision
    const diskConfig = JSON.parse(readFileSync(path.join(ctx.daemonDir, "config.json"), "utf8"));
    assert.equal(
      diskConfig?.settings?.mid_turn_send,
      "steer",
      `expected config.json settings.mid_turn_send="steer", got ${JSON.stringify(diskConfig?.settings)}`,
    );
    const pulledConfig = await ctx.pullCollection("config");
    const pulledConfigDoc = pulledConfig?.items?.[0];
    assert.equal(
      pulledConfigDoc?.settings?.mid_turn_send,
      "steer",
      `expected config pull settings.mid_turn_send="steer", got ${JSON.stringify(pulledConfig)}`,
    );
    assert.notEqual(
      pulledConfigDoc?.revision,
      revBeforeSave,
      "expected configRevision to advance after saving mid_turn_send",
    );

    // --- 2A: Start gated turn -> composer stages directly into Zone 1 -> click queue-interrupt-now ---
    const evStart2A = ctx.events.length;
    const s2CardGate = armGate("S2_INTERRUPT_CARD:step0");
    await sendFromComposer(page, "[TURN_TAG:S2_INTERRUPT_CARD] Analyze system architecture in detail.");
    await s2CardGate.entered.promise;

    assert.equal(
      await page.locator("[data-composer-midturn-mode]").count(),
      0,
      "composer must not render a mid-turn mode switcher pill while running",
    );

    if (!LIVE_OPENROUTER) {
      await page.waitForFunction(
        () => (document.body.textContent || "").includes("PARTIAL_TEXT_ALPHA_901"),
        undefined,
        { timeout: 10000 },
      );
    }

    const M_INT_1 = "Interrupt from staged card M_INT_1 — reply in one short sentence.";
    await sendFromComposer(page, M_INT_1);

    // Assert it landed directly in Zone 1 `[data-queue-item-state="steer"]` with `×` button and zero toast!
    await stagedSteer.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await appNoticeDismiss.count(), 0, `auto-staging into steer must not stack a foreground appNotice toast (found: ${await page.locator(".ui-toast-region").textContent().catch(() => "")})`);
    const steerBox2A = await stagedSteer.boundingBox();
    assert(
      steerBox2A && steerBox2A.height > 0 && steerBox2A.height <= 46,
      `expected slim single-line [data-queue-item-state="steer"] height <= 46px in 2A, got ${steerBox2A?.height}`,
    );
    assert(
      ((await stagedSteer.textContent()) || "").includes(M_INT_1),
      "message sent under host default 'steer' must land directly in Zone 1",
    );
    assert(
      await stagedSteer.locator('[data-action="queue-cancel-send"]').isVisible(),
      "staged item from composer must display × button",
    );

    // Click `[data-action="queue-interrupt-now"]` on Zone 1 card!
    await stagedSteer.locator('[data-action="queue-interrupt-now"]').click();
    assert.equal(await appNoticeDismiss.count(), 0, "interruptNow from staged row must not stack a foreground appNotice toast");
    await s2CardGate.aborted.promise;
    const snapAfter2A = await waitForSessionIdleAndEmptyQueue(ctx, s2Id, TURN_TIMEOUT);

    const errEvents2A = ctx.events
      .slice(evStart2A)
      .filter((e) => e?.type === "error" || /previous turn is still stopping/i.test(JSON.stringify(e)));
    assert.deepEqual(errEvents2A, [], `unexpected error events during interrupt 2A: ${JSON.stringify(errEvents2A)}`);

    if (!LIVE_OPENROUTER) {
      const serializedMsgs2A = JSON.stringify(snapAfter2A?.session?.messages || []);
      assert(
        serializedMsgs2A.includes("PARTIAL_THINKING_ALPHA_901"),
        "interrupted turn must preserve partial assistant thinking in persisted session messages",
      );
      assert(
        serializedMsgs2A.includes("PARTIAL_TEXT_ALPHA_901"),
        "interrupted turn must preserve partial assistant text in persisted session messages",
      );
      assert(
        await page.evaluate(() => (document.body.textContent || "").includes("PARTIAL_TEXT_ALPHA_901")),
        "interrupted turn partial assistant text must remain visible in Chromium transcript",
      );
    }
    assert(
      JSON.stringify(snapAfter2A?.session?.messages || []).includes(M_INT_1),
      "interrupting message M_INT_1 must execute immediately in a new turn",
    );

    // --- 2B: Direct host `mid_turn_send = "interrupt"` via SettingsModal (`[data-midturn-radio="interrupt"]`) ---
    await page.locator('button[aria-label="Host & agent settings: Settings"]').click();
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    const interruptRadioDesk = dialog.locator('[data-midturn-radio="interrupt"]');
    await interruptRadioDesk.scrollIntoViewIfNeeded();
    await interruptRadioDesk.click();
    assert.equal(await interruptRadioDesk.getAttribute("aria-checked"), "true");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 15000 });
    // The "Settings saved on the host" notice lands on the daemon ack, which can
    // trail the dialog exit: wait for it briefly, dismiss it, and let it leave.
    if (await appNoticeDismiss.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
      await appNoticeDismiss.first().click();
      await appNoticeDismiss.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }

    const diskConfigInt = JSON.parse(readFileSync(path.join(ctx.daemonDir, "config.json"), "utf8"));
    assert.equal(
      diskConfigInt?.settings?.mid_turn_send,
      "interrupt",
      `expected config.json settings.mid_turn_send="interrupt", got ${JSON.stringify(diskConfigInt?.settings)}`,
    );

    const evStart2B = ctx.events.length;
    const s2MenuGate = armGate("S2_INTERRUPT_MENU:step0");
    await sendFromComposer(page, "[TURN_TAG:S2_INTERRUPT_MENU] Stream live reasoning and commentary.");
    await s2MenuGate.entered.promise;

    assert.equal(await page.locator("[data-composer-midturn-mode]").count(), 0);
    if (!LIVE_OPENROUTER) {
      await page.waitForFunction(
        () => (document.body.textContent || "").includes("PARTIAL_TEXT_BETA_902"),
        undefined,
        { timeout: 10000 },
      );
    }

    const M_INT_2 = "Direct composer interrupt M_INT_2 — reply in one short sentence.";
    await sendFromComposer(page, M_INT_2);
    assert.equal(await appNoticeDismiss.count(), 0, "direct mid_turn_send=interrupt must not stack a foreground appNotice toast");

    await s2MenuGate.aborted.promise;
    const snapAfter2B = await waitForSessionIdleAndEmptyQueue(ctx, s2Id, TURN_TIMEOUT);

    const errEvents2B = ctx.events
      .slice(evStart2B)
      .filter((e) => e?.type === "error" || /previous turn is still stopping/i.test(JSON.stringify(e)));
    assert.deepEqual(errEvents2B, [], `unexpected error events during direct interrupt 2B: ${JSON.stringify(errEvents2B)}`);

    if (!LIVE_OPENROUTER) {
      const serializedMsgs2B = JSON.stringify(snapAfter2B?.session?.messages || []);
      assert(
        serializedMsgs2B.includes("PARTIAL_THINKING_BETA_902"),
        "direct-interrupted turn must preserve partial assistant thinking",
      );
      assert(
        serializedMsgs2B.includes("PARTIAL_TEXT_BETA_902"),
        "direct-interrupted turn must preserve partial assistant text",
      );
      assert(
        await page.evaluate(() => (document.body.textContent || "").includes("PARTIAL_TEXT_BETA_902")),
        "direct-interrupted partial assistant text must remain visible in Chromium transcript",
      );
    }
    assert(
      JSON.stringify(snapAfter2B?.session?.messages || []).includes(M_INT_2),
      "direct interrupt message M_INT_2 must start and complete its new turn immediately",
    );

    // Restore `[data-midturn-radio="steer"]` in SettingsModal before Scenario 2C
    await page.locator('button[aria-label="Host & agent settings: Settings"]').click();
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    await steerRadio.scrollIntoViewIfNeeded();
    await steerRadio.click();
    assert.equal(await steerRadio.getAttribute("aria-checked"), "true");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 15000 });
    // The "Settings saved on the host" notice lands on the daemon ack, which can
    // trail the dialog exit: wait for it briefly, dismiss it, and let it leave.
    if (await appNoticeDismiss.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
      await appNoticeDismiss.first().click();
      await appNoticeDismiss.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }

    // --- 2C: Plain Stop button while an item is staged in "Next step" ---
    const s2StopGate = armGate("S2_PLAIN_STOP:step0");
    await sendFromComposer(page, "[TURN_TAG:S2_PLAIN_STOP] Hold open for plain Stop demotion check.");
    await s2StopGate.entered.promise;

    const M_STOP_1 = "Demote on plain stop M_STOP_1 — reply in one short sentence.";
    await sendFromComposer(page, M_STOP_1);
    await stagedSteer.waitFor({ state: "visible", timeout: 10000 });

    const upstreamCountBeforeStop = upstreamCalls.length;
    await page.locator('button[aria-label="Stop"]').click();
    await s2StopGate.aborted.promise;
    const snapAfterStop = await waitForSessionIdle(ctx, s2Id, 20000);

    // Wait briefly while idle to verify the demoted item NEVER launches a new turn on plain Stop
    await Bun.sleep(650);
    assert.equal(
      upstreamCalls.length,
      upstreamCountBeforeStop,
      "plain Stop must NOT launch a new turn for a staged 'steer' item",
    );
    assert.equal(
      snapAfterStop?.session?.queue?.length,
      1,
      "staged item must remain in queue after plain Stop",
    );
    assert.equal(
      snapAfterStop?.session?.queue?.[0]?.delivery,
      "queue",
      "staged 'steer' item must demote to passive 'queue' on plain Stop",
    );

    await page.waitForFunction(
      () => document.querySelectorAll("[data-queue-staged]").length === 0,
      undefined,
      { timeout: 8000 },
    );
    await waitForPassiveQueueTexts(page, [M_STOP_1]);
    assert(
      ((await page.locator("[data-queue-passive]").textContent()) || "").includes("Paused, ready to send"),
      "passive queue while idle must show 'Paused, ready to send'",
    );

    // Clicking `[data-action="queue-send-idle"]` launches M_STOP_1 immediately!
    const idleSendBtn = page
      .locator('[data-queue-passive] [data-queue-item-state="queue"]')
      .first()
      .locator('[data-action="queue-send-idle"]');
    await idleSendBtn.waitFor({ state: "visible", timeout: 8000 });
    await idleSendBtn.click();

    const snapAfterIdleSend = await waitForSessionIdleAndEmptyQueue(ctx, s2Id, TURN_TIMEOUT);
    assert(
      JSON.stringify(snapAfterIdleSend?.session?.messages || []).includes(M_STOP_1),
      "clicking queue-send-idle must launch and complete M_STOP_1",
    );

    assertNoPageErrors(pageErrors, consoleErrors, "Scenario 2");
    log("scenario-2", "PASSED: host mid_turn_send=steer persistence, both interrupt paths, partial preservation & plain Stop demotion");

    // =========================================================================
    // SCENARIO 3: Mobile `390x844` Viewport & WAL Reload Durability
    // =========================================================================
    log("scenario-3", "Mobile 390x844: sidebar -> SettingsModal stacked cards, staged+passive touch boxes & WAL reload");
    await context.close();

    const s3Id = await createTestSession(ctx, "Queue Suite S3 Mobile");
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const mobilePage = await mobileContext.newPage();
    const mobilePageErrors: string[] = [];
    const mobileConsoleErrors: string[] = [];
    mobilePage.on("pageerror", (e: Error) => mobilePageErrors.push(String(e).slice(0, 400)));
    mobilePage.on("console", (m: any) => {
      if (m.type() === "error") mobileConsoleErrors.push(String(m.text()).slice(0, 400));
    });
    await mobilePage.addInitScript(
      ({ sess }: any) => {
        if (!localStorage.getItem("cache_code_session")) {
          localStorage.setItem("cache_code_session", JSON.stringify(sess));
        }
      },
      {
        sess: { accessToken: ctx.login.accessToken, refreshToken: ctx.login.refreshToken, user: ctx.login.user },
      },
    );

    await selectSessionInUI(mobilePage, ctx.gwUrl, ctx.hostId, s3Id, "Queue Suite S3 Mobile");
    await mobilePage.waitForTimeout(300);

    // Close mobile sidebar if selectSessionInUI opened or left it open, then explicitly test opening it
    const initCloseSidebar = mobilePage.locator('button[aria-label="Close sidebar"]').first();
    if ((await initCloseSidebar.count()) > 0 && (await initCloseSidebar.isVisible().catch(() => false))) {
      await initCloseSidebar.click();
      await mobilePage.waitForTimeout(250);
    }

    // Open mobile sidebar -> open SettingsModal
    const expandSidebarBtn = mobilePage.locator('button[aria-label="Expand sidebar"]').first();
    await expandSidebarBtn.waitFor({ state: "visible", timeout: 10000 });
    await expandSidebarBtn.click();
    await mobilePage.waitForTimeout(300);

    await mobilePage.locator('button[aria-label="Host & agent settings: Settings"]').click();
    const mobDialog = mobilePage.locator('[role="dialog"]');
    await mobDialog.waitFor({ state: "visible", timeout: 10000 });

    const queueRadio = mobDialog.locator('[data-midturn-radio="queue"]');
    const steerRadioMob = mobDialog.locator('[data-midturn-radio="steer"]');
    const interruptRadioMob = mobDialog.locator('[data-midturn-radio="interrupt"]');
    await queueRadio.scrollIntoViewIfNeeded();
    await mobilePage.waitForTimeout(200);

    const boxQ = await queueRadio.boundingBox();
    const boxS = await steerRadioMob.boundingBox();
    const boxI = await interruptRadioMob.boundingBox();
    assert(boxQ && boxS && boxI, "expected all 3 'While agent is working' radio cards to have bounding boxes on 390x844");
    assert(
      boxQ.y < boxS.y && boxS.y < boxI.y,
      `expected 3 'While agent is working' cards to stack vertically on 390x844, got y=[${boxQ.y}, ${boxS.y}, ${boxI.y}]`,
    );
    const settingsScrollW = await mobilePage.evaluate(() => document.documentElement.scrollWidth);
    assert(
      settingsScrollW <= 390,
      `SettingsModal on 390x844 overflowed horizontally: scrollWidth=${settingsScrollW}`,
    );

    await queueRadio.click();
    await mobDialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await mobDialog.waitFor({ state: "hidden", timeout: 15000 });

    // Close mobile sidebar drawer so main workspace is uncovered
    const closeSidebarBtn = mobilePage.locator('button[aria-label="Close sidebar"]').first();
    if ((await closeSidebarBtn.count()) > 0 && (await closeSidebarBtn.isVisible().catch(() => false))) {
      await closeSidebarBtn.click();
      await mobilePage.waitForTimeout(300);
    }

    // Start gated turn on 390x844 and populate 1 staged "steer" item + 2 passive "queue" items
    const s3Gate = armGate("S3_MOBILE_QUEUE:step0");
    await sendFromComposer(mobilePage, "[TURN_TAG:S3_MOBILE_QUEUE] Hold mobile turn open for queue layout verification.");
    await s3Gate.entered.promise;

    const UNBROKEN_200 = "https://indirect.example/queue/" + "x".repeat(175);
    const MOB_1 = `Mobile staged steer item #1 ${UNBROKEN_200}`;
    const MOB_2 = `Mobile passive queue item #2 ${UNBROKEN_200}`;
    const MOB_3 = "Mobile passive queue item #3";
    await sendFromComposer(mobilePage, MOB_1);
    await sendFromComposer(mobilePage, MOB_2);
    await sendFromComposer(mobilePage, MOB_3);
    await waitForPassiveQueueTexts(mobilePage, [MOB_1, MOB_2, MOB_3]);

    const mobStagedSteer = mobilePage.locator('[data-queue-staged] [data-queue-item-state="steer"]');
    assert.equal(await mobilePage.locator("[data-composer-midturn-mode]").count(), 0);

    // Stage MOB_1 so Zone 1 ("steer") and Zone 2 (2 passive items) are both visible simultaneously
    await mobilePage
      .locator('[data-queue-passive] [data-queue-item-state="queue"]')
      .nth(0)
      .locator('[data-action="queue-send-next"]')
      .click();
    await mobStagedSteer.waitFor({ state: "visible", timeout: 8000 });
    await waitForPassiveQueueTexts(mobilePage, [MOB_2, MOB_3]);

    const mobileQueueScrollW = await mobilePage.evaluate(() => document.documentElement.scrollWidth);
    assert(
      mobileQueueScrollW <= 390,
      `QueueCard + Composer on 390x844 overflowed horizontally: scrollWidth=${mobileQueueScrollW}`,
    );

    // Assert non-zero tappable bounding boxes WITHOUT hover for Zone 1 & Zone 2 controls
    const cancelSendBox = await mobStagedSteer.locator('[data-action="queue-cancel-send"]').boundingBox();
    const stagedInterruptBox = await mobStagedSteer.locator('[data-action="queue-interrupt-now"]').boundingBox();
    const firstPassiveRow = mobilePage.locator('[data-queue-passive] [data-queue-item-state="queue"]').first();
    const passiveSendNextBox = await firstPassiveRow.locator('[data-action="queue-send-next"]').boundingBox();
    const passiveInterruptBox = await firstPassiveRow.locator('[data-action="queue-interrupt-now"]').boundingBox();
    const passiveMoveDownBox = await firstPassiveRow.locator('[data-action="queue-move-down"]').boundingBox();

    for (const [label, b] of [
      ["staged queue-cancel-send (×)", cancelSendBox],
      ["staged queue-interrupt-now", stagedInterruptBox],
      ["passive queue-send-next", passiveSendNextBox],
      ["passive queue-interrupt-now", passiveInterruptBox],
      ["passive queue-move-down", passiveMoveDownBox],
    ] as const) {
      assert(b && b.width > 0 && b.height > 0, `expected ${label} to have non-zero bounding box without hover on 390x844`);
      assert(
        b.x >= 0 && b.x + b.width <= 390.5,
        `expected ${label} bounding box [${b.x}, ${b.x + b.width}] to fit within 390px viewport`,
      );
    }

    // Stop the active turn so all 3 items ([MOB_1, MOB_2, MOB_3]) rest durably in the WAL queue,
    // then reload the page (`mobilePage.reload()`) and verify WAL queue recovery + zero console/page errors!
    await mobilePage.locator('button[aria-label="Stop"]').click();
    await s3Gate.aborted.promise;
    await waitForSessionIdle(ctx, s3Id, 20000);
    await waitForPassiveQueueTexts(mobilePage, [MOB_1, MOB_2, MOB_3]);

    await mobilePage.reload({ waitUntil: "networkidle" });
    await mobilePage.waitForSelector("#rc-composer", { timeout: 20000 });
    await waitForPassiveQueueTexts(mobilePage, [MOB_1, MOB_2, MOB_3], 15000);

    const postReloadScrollW = await mobilePage.evaluate(() => document.documentElement.scrollWidth);
    assert(postReloadScrollW <= 390, `post-reload 390x844 scrollWidth=${postReloadScrollW} exceeded 390`);
    assert.deepEqual(protocolErrors, [], `protocol errors: ${protocolErrors.join(" | ")}`);
    assertNoPageErrors(mobilePageErrors, mobileConsoleErrors, "Scenario 3 (mobile 390x844 post-reload)");
    await mobileContext.close();

    log("scenario-3", "PASSED: 390x844 SettingsModal stack, non-hover touch boxes & WAL page.reload() durability");
    log("done", "ALL QUEUE FULL-STACK E2E SCENARIOS PASSED");
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
  await Bun.sleep(250);
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
