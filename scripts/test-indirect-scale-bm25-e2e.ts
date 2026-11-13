/**
 * scripts/test-indirect-scale-bm25-e2e.ts — full-stack Playwright E2E suite
 * verifying Indirect Code's lifetime-scale storage, BM25F full-text search,
 * seekable Cold Zstd `aroundMsgIdx` random-access jumps, CAS `get_blob` image
 * hydration, bi-directional history pagination, Frame-0 scroll anchoring, and
 * zero-reflow composer draft persistence across Desktop (1280x800) and Mobile
 * (390x844) BrowserContexts backed by a real Bun Gateway + real Go Daemon.
 *
 * Scenarios:
 *   a) Legacy `.jsonl` -> v2 Cold `.turns.zst` + `.fidx` + CAS `blobs/sha256/`
 *      + `search/` LSM-BM25F migration & on-disk proof (240 turns seeded before
 *      daemon boot with inline base64 PNGs, PT-BR diacritics, and agentic
 *      `finish_entire_request` completions).
 *   b) `Ctrl+K` `HistoryView` BM25F search: PT-BR accent-insensitive query
 *      (`"configuracao sessao"` -> `"configuração crítica da sessão anual"`)
 *      and Cold `.zst` agentic `finish_entire_request` query
 *      (`"postgres deadlock"` -> `assistant` field badge + ranked snippet).
 *   c) Cold-archive `aroundMsgIdx` jump + CAS `get_blob` -> `blob:` ObjectURL
 *      image hydration + `[data-raw-idx][data-highlighted="true"]` + `"Viewing
 *      older history · Jump to latest"` banner (`hasNewer: true`) + Frame-0
 *      anchored `beforeTurn` prepend + `afterTurn` append + `"Jump to latest"`
 *      tail re-anchor (`hasNewer: false`) on Desktop and Mobile.
 *   d) Composer single-line typing zero-reflow (`contain: layout style`, zero
 *      `height = "auto"` thrash) + `< 100ms` synchronous `localStorage` draft
 *      flush on session switch before the `250ms` debounce timer.
 *
 * Prerequisites: web dist/ built (`bun run build:web`), daemon binary built
 * (`bun run build:daemon`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
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
const MODEL = "mock-scale-bm25-v1";
const LEGACY_SESSION_ID = "sess_scale_legacy_v1";
const TOTAL_SEEDED_TURNS = 240;

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

// ---------------------------------------------------------------------------
// Deterministic pure-JS RGBA PNG encoder (zero external image dependencies)
// ---------------------------------------------------------------------------
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function makeLockGraphPng(width: number, height: number, seed = 18): Buffer {
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const px = rowOff + 1 + x * 4;
      const border = x < 2 || x >= width - 2 || y < 2 || y >= height - 2;
      const leftNode = x >= 22 && x <= 96 && y >= 28 && y <= height - 28;
      const rightNode = x >= width - 98 && x <= width - 22 && y >= 28 && y <= height - 28;
      const connector = y >= (height >> 1) - 3 && y <= (height >> 1) + 3 && x > 96 && x < width - 98;
      const grid = (x + seed) % 16 === 0 || (y + seed) % 16 === 0;

      let r = 18;
      let g = 21;
      let b = 28;
      if (border) {
        r = 63;
        g = 70;
        b = 86;
      } else if (leftNode) {
        const edge = x <= 24 || x >= 94 || y <= 30 || y >= height - 30;
        r = edge ? 56 : 24;
        g = edge ? 189 : 58;
        b = edge ? 248 : 92;
      } else if (rightNode) {
        const edge = x <= width - 96 || x >= width - 24 || y <= 30 || y >= height - 30;
        r = edge ? 52 : 20;
        g = edge ? 211 : 68;
        b = edge ? 153 : 54;
      } else if (connector) {
        r = 129;
        g = 140;
        b = 248;
      } else if (grid) {
        r = 25;
        g = 29;
        b = 38;
      }
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Seed 240-turn Legacy v1 `.jsonl` Session Before Daemon Boot
// ---------------------------------------------------------------------------
interface SeededLegacyInfo {
  jsonlPath: string;
  jsonlBytes: number;
  turn18PngBytes: Buffer;
  turn18PngSha256: string;
  turn60PngSha256: string;
}

function seedLegacyScaleSession(daemonDir: string, workDir: string): SeededLegacyInfo {
  const sessionsDir = path.join(daemonDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const jsonlPath = path.join(sessionsDir, `${LEGACY_SESSION_ID}.jsonl`);

  const turn18PngBytes = makeLockGraphPng(240, 120, 18);
  const turn18PngSha256 = createHash("sha256").update(turn18PngBytes).digest("hex");
  const turn18PngB64 = turn18PngBytes.toString("base64");

  const turn60PngBytes = makeLockGraphPng(180, 96, 60);
  const turn60PngSha256 = createHash("sha256").update(turn60PngBytes).digest("hex");
  const turn60PngB64 = turn60PngBytes.toString("base64");

  const baseEpochMs = Date.now() - 25 * 24 * 3600 * 1000; // 25 days ago for early history
  const lines: string[] = [];

  for (let turn = 1; turn <= TOTAL_SEEDED_TURNS; turn++) {
    const turnMs =
      turn <= 140
        ? baseEpochMs + turn * 60_000
        : Date.now() - (TOTAL_SEEDED_TURNS - turn + 1) * 30_000;
    const iso = (offsetMs: number) => new Date(turnMs + offsetMs).toISOString();

    let userText = `Turn #${turn} audit checkpoint for service module shard-${turn % 29} (marker TURN_${turn}_MARKER).`;
    let finishText = `Completed verification of shard-${turn % 29} invariants at turn #${turn} with zero regressions.`;

    if (turn === 1) {
      userText = "TURN_1_GENESIS_MARKER: Bootstrap ledger schema and deterministic lock hierarchy.";
      finishText = "TURN_1_GENESIS_COMPLETE: Initialized ledger schema baseline at Turn #1.";
    } else if (turn === 12) {
      userText =
        "Precisamos revisar a configuração crítica da sessão anual antes do fechamento contábil trimestral.";
      finishText =
        "Configuração crítica da sessão anual auditada e validada com sucesso nos módulos fiscais.";
    } else if (turn === 18) {
      userText =
        "Diagnose the intermittent lock contention during concurrent ledger settlement and attach the lock-ordering diagram.";
      finishText =
        "PostgreSQL deadlock resolved via deterministic lock ordering across accounts and ledger_entries.";
    } else if (turn === 36) {
      userText = "TURN_36_COLD_MARKER: Verify connection pool saturation recovery after failover.";
      finishText = "TURN_36_COLD_COMPLETE: Connection pool recovery verified at Turn #36.";
    } else if (turn === TOTAL_SEEDED_TURNS) {
      userText = "Verify live tail readiness on tiered v2 session storage.";
      finishText = `LIVE_TAIL_TURN_${TOTAL_SEEDED_TURNS}_ANCHOR: All ${TOTAL_SEEDED_TURNS} turns synchronized on tiered v2 storage.`;
    }

    const messages: any[] = [];
    messages.push({
      id: `u-${turn}`,
      role: "user",
      turnIndex: turn,
      time: iso(0),
      content: [{ text: userText }],
    });

    // Turns 1..45 carry two realistic `read` tool steps + `finish_entire_request`
    // (7 raw messages/turn) so centered `ReadAroundMsg` at Turn #18 (~±14 turns
    // for the 200-message window cap) has BOTH `hasOlder: true` (turns 1..3 above)
    // AND `hasNewer: true` (turns 33..240 below).
    const readSteps = turn <= 45 ? 2 : 1;
    for (let step = 1; step <= readSteps; step++) {
      const callId = `call_read_${turn}_${step}`;
      messages.push({
        id: `a-${turn}-r${step}`,
        role: "assistant",
        turnIndex: turn,
        time: iso(step * 400),
        content: [
          {
            id: callId,
            name: "read",
            arguments: { path: `pkg/ledger/shard_${turn}_${step}.go` },
          },
        ],
      });
      messages.push({
        id: `t-${turn}-r${step}`,
        role: "tool",
        turnIndex: turn,
        time: iso(step * 400 + 200),
        content: [
          {
            call_id: callId,
            content: [
              {
                text: `<tool_result tool="read" path="pkg/ledger/shard_${turn}_${step}.go" lines="1-4">\n1\tpackage ledger\n2\t// Turn ${turn} step ${step} lock acquisition order\n3\tconst ShardID = ${turn}\n</tool_result>`,
              },
            ],
            is_error: false,
            started_at: turnMs + step * 400,
            duration_ms: 12,
          },
        ],
      });
    }

    const finCallId = `call_fin_${turn}`;
    const finishContent: any[] = [
      {
        id: finCallId,
        name: "finish_entire_request",
        arguments: { final_message_to_user: finishText },
      },
    ];
    if (turn === 18) {
      finishContent.push({
        mime_type: "image/png",
        data: turn18PngB64,
      });
    } else if (turn === 60) {
      finishContent.push({
        mime_type: "image/png",
        data: turn60PngB64,
      });
    }

    messages.push({
      id: `a-${turn}-fin`,
      role: "assistant",
      turnIndex: turn,
      time: iso(2000),
      content: finishContent,
    });
    messages.push({
      id: `t-${turn}-fin`,
      role: "tool",
      turnIndex: turn,
      time: iso(2100),
      content: [
        {
          call_id: finCallId,
          content: [{ text: "ok" }],
          is_error: false,
          started_at: turnMs + 2000,
          duration_ms: 4,
        },
      ],
    });

    lines.push(
      JSON.stringify({
        v: 1,
        kind: "turn",
        turn,
        messages,
        usage: {
          input_tokens: turn * 180,
          output_tokens: turn * 45,
        },
      }),
    );
  }

  const nowMs = Date.now();
  lines.push(
    JSON.stringify({
      v: 1,
      kind: "meta",
      id: LEGACY_SESSION_ID,
      cwd: workDir,
      title: "Ledger Settlement & Scale Architecture",
      titleSource: "user",
      model: MODEL,
      status: "idle",
      options: {
        mode: "agentic",
        access: "full",
        effort: "high",
      },
      skills: { build: { priority: 1, active: true } },
      createdAt: baseEpochMs,
      updatedAt: nowMs,
      turnSeq: TOTAL_SEEDED_TURNS,
      attentionSeq: 1,
      seenSeq: 1,
      usage: {
        input_tokens: TOTAL_SEEDED_TURNS * 180,
        output_tokens: TOTAL_SEEDED_TURNS * 45,
      },
    }),
  );

  const payload = lines.join("\n") + "\n";
  writeFileSync(jsonlPath, payload, "utf8");
  return {
    jsonlPath,
    jsonlBytes: Buffer.byteLength(payload, "utf8"),
    turn18PngBytes,
    turn18PngSha256,
    turn60PngSha256,
  };
}

// ---------------------------------------------------------------------------
// Minimal deterministic mock LLM upstream
// ---------------------------------------------------------------------------
let upstreamSeq = 0;
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
    return Response.json({
      id: `chatcmpl-scale-${++upstreamSeq}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Scale E2E Session" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 },
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
const ADMIN_PW = "e2e-scale-bm25-pass-1";
const procs: Array<{ kill: () => void }> = [];
const tempDirs: string[] = [];

async function boot() {
  const gwPort = Number(process.env.E2E_SCALE_GW_PORT || (await pickFreePort()));
  const gwUrl = `http://127.0.0.1:${gwPort}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-scale-gw-"));
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
        name: "scale-e2e-provider",
        openaiBaseUrl: UPSTREAM_URL,
        apiKey: "mock-scale-key",
        openaiAuthStyle: "bearer",
      }),
    })
  ).json();
  assert(provRes.success, `provider create failed: ${JSON.stringify(provRes)}`);
  const list: any = await (
    await fetch(`${gwUrl}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })
  ).json();
  const providerId = (list.providers || []).find((p: any) => p.name === "scale-e2e-provider")?.id;
  assert(providerId, "scale-e2e-provider id missing");

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

  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-scale-d-"));
  tempDirs.push(daemonDir);
  const workDir = path.join(daemonDir, "ledger-service");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    path.join(workDir, "settlement.go"),
    "package ledger\n// Deterministic lock ordering by account ID\n",
    "utf8",
  );

  // Seed 240-turn legacy v1 `.jsonl` session BEFORE starting the Go daemon!
  const seeded = seedLegacyScaleSession(daemonDir, workDir);
  assert(existsSync(seeded.jsonlPath), "expected seeded legacy .jsonl before daemon boot");
  log(
    "seed",
    `Seeded ${TOTAL_SEEDED_TURNS}-turn legacy .jsonl (${(seeded.jsonlBytes / 1024).toFixed(1)} KiB, PNG sha256=${seeded.turn18PngSha256.slice(0, 12)}…)`,
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
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "Scale Host"],
    {
      cwd: WS,
      env: {
        ...process.env,
        HOME: daemonDir,
        PATH: extraPath,
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
    const f = (h.hosts || []).find((x: any) => x.name === "Scale Host" && x.status === "online");
    if (f) hostId = f.id;
    else await Bun.sleep(200);
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

  const projCreated = await send({
    type: "create_project",
    path: workDir,
  });
  const projectId = String(projCreated?.project?.id || "");
  assert(projectId, `create_project failed: ${JSON.stringify(projCreated)}`);

  // Create a lightweight companion session so we can test cross-session search jumps
  // into Cold `.zst` AND synchronous composer draft flushes on session switch.
  const createdCompanion = await send({
    type: "create_session",
    cwd: workDir,
    title: "Gateway Routing Notes",
    model: MODEL,
    options: { mode: "agentic", access: "full", effort: "high", skills: [{ name: "build" }] },
  });
  const companionSid = String(createdCompanion?.session?.id || "");
  assert(companionSid, `companion create_session failed: ${JSON.stringify(createdCompanion)}`);

  const syncDeadline = Date.now() + 8000;
  while (Date.now() < syncDeadline) {
    const pulled = await pullCollection("sessions");
    const ids = new Set((pulled?.items || []).map((s: any) => s?.id));
    if (ids.has(LEGACY_SESSION_ID) && ids.has(companionSid)) break;
    await Bun.sleep(100);
  }

  log("boot", `gw=${gwUrl} host=${hostId} project=${projectId} companion=${companionSid}`);
  return {
    gwUrl,
    jwt,
    login,
    hostId,
    projectId,
    companionSid,
    seeded,
    ws,
    send,
    pullCollection,
    daemonDir,
    workDir,
    events,
  };
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

async function selectSessionInUI(page: any, gwUrl: string, hostId: string, sessionId: string) {
  if (!page.url().startsWith(gwUrl)) {
    await page.goto(`${gwUrl}/#/code`, { waitUntil: "networkidle" });
  }
  await page.waitForSelector("#rc-composer", { timeout: 20000 });

  const expandBtn = page.locator('button[aria-label="Expand sidebar"]').first();
  if ((await expandBtn.count()) > 0 && (await expandBtn.isVisible().catch(() => false))) {
    await expandBtn.click();
    await page.waitForTimeout(250);
  }

  const segBtn = page.locator('[aria-label="Sidebar list view"] button', { hasText: "Projects" }).first();
  await segBtn.waitFor({ state: "visible", timeout: 15000 });
  await segBtn.click();

  const row = page.locator(`aside [data-session-id="${sessionId}"]`).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.click();

  await page.waitForFunction(
    ({ hid, sid }: { hid: string; sid: string }) => {
      const stored = localStorage.getItem(`llmgw-rc-session:${hid}`);
      return stored === sid;
    },
    { hid: hostId, sid: sessionId },
    { timeout: 15000 },
  );
}

try {
  if (SCREENSHOTS_DIR) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  const ctx = await boot();

  // ===========================================================================
  // STEP A: Legacy `.jsonl` -> v2 Cold `.zst` + `.fidx` + CAS + Search Disk Proof
  // ===========================================================================
  log("step-a", "Waiting for background search backfill + cold legacy .jsonl -> v2 .zst migration on disk...");
  const v2SessionDir = path.join(ctx.daemonDir, "sessions", LEGACY_SESSION_ID);
  const searchDir = path.join(ctx.daemonDir, "search");
  const blob18Path = path.join(
    ctx.daemonDir,
    "blobs",
    "sha256",
    ctx.seeded.turn18PngSha256.slice(0, 2),
    `${ctx.seeded.turn18PngSha256}.blob`,
  );
  const blob60Path = path.join(
    ctx.daemonDir,
    "blobs",
    "sha256",
    ctx.seeded.turn60PngSha256.slice(0, 2),
    `${ctx.seeded.turn60PngSha256}.blob`,
  );

  const diskDeadline = Date.now() + 15_000;
  let v2Files: string[] = [];
  let searchFiles: string[] = [];
  while (Date.now() < diskDeadline) {
    const migratedGone = !existsSync(ctx.seeded.jsonlPath);
    v2Files = existsSync(v2SessionDir) ? readdirSync(v2SessionDir) : [];
    searchFiles = existsSync(searchDir) ? readdirSync(searchDir) : [];
    const hasColdZst = v2Files.some((f) => /^seg-\d+\.turns\.zst$/.test(f));
    const hasColdFidx = v2Files.some((f) => /^seg-\d+\.fidx$/.test(f));
    const hasSearchSeg = searchFiles.some((f) => /^seg-\d+\.sidx$/.test(f));
    if (migratedGone && hasColdZst && hasColdFidx && existsSync(blob18Path) && hasSearchSeg) {
      break;
    }
    await Bun.sleep(150);
  }

  assert(!existsSync(ctx.seeded.jsonlPath), "legacy .jsonl must be removed after v2 migration");
  const zstSegments = v2Files.filter((f) => /^seg-\d+\.turns\.zst$/.test(f)).sort();
  const fidxSegments = v2Files.filter((f) => /^seg-\d+\.fidx$/.test(f)).sort();
  const warmSegments = v2Files.filter((f) => /^seg-\d+\.turns$/.test(f)).sort();

  assert(zstSegments.length >= 2, `expected >= 2 Cold .turns.zst segments for 140 aged turns, got: ${zstSegments.join(", ")}`);
  assert.equal(fidxSegments.length, zstSegments.length, "each Cold .turns.zst segment must have a companion .fidx frame table");
  assert(warmSegments.length >= 1, `expected Warm tail .turns segment for 100 recent turns, got: ${v2Files.join(", ")}`);
  assert(v2Files.includes("meta.json"), "expected v2 meta.json");
  assert(v2Files.includes("manifest.json"), "expected v2 manifest.json");
  assert(v2Files.includes("turn.idx"), "expected v2 turn.idx");

  assert(existsSync(blob18Path), `expected Turn #18 CAS blob on disk at ${blob18Path}`);
  assert(existsSync(blob60Path), `expected Turn #60 CAS blob on disk at ${blob60Path}`);
  assert.equal(
    statSync(blob18Path).size,
    ctx.seeded.turn18PngBytes.length,
    "CAS blob byte size must match original raw PNG bytes",
  );

  assert(searchFiles.includes("MANIFEST.json"), `expected search/MANIFEST.json, got: ${searchFiles.join(", ")}`);
  assert(
    searchFiles.some((f) => /^seg-\d+\.sidx$/.test(f)) && searchFiles.some((f) => /^seg-\d+\.sdoc$/.test(f)),
    `expected flushed LSM-BM25F .sidx/.sdoc segments in search/, got: ${searchFiles.join(", ")}`,
  );

  const totalColdZstBytes = zstSegments.reduce((acc, f) => acc + statSync(path.join(v2SessionDir, f)).size, 0);
  log(
    "step-a",
    `PASSED: legacy .jsonl migrated cleanly -> ${zstSegments.length} Cold .zst (${(totalColdZstBytes / 1024).toFixed(1)} KiB), ${fidxSegments.length} .fidx, ${warmSegments.length} Warm .turns, CAS blobs verified, search/ segments=${searchFiles.filter((f) => f.endsWith(".sidx")).length}`,
  );

  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    // =========================================================================
    // Create Desktop (1280x800 @ 2x DPI) & Mobile (390x844 @ 2x DPI) Contexts
    // =========================================================================
    const pcContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const pcPage = await pcContext.newPage();
    const pcPageErrors: string[] = [];
    const pcConsoleErrors: string[] = [];
    const pcWsFrames: string[] = [];
    pcPage.on("pageerror", (e: Error) => pcPageErrors.push(String(e).slice(0, 400)));
    pcPage.on("console", (m: any) => {
      if (m.type() === "error") pcConsoleErrors.push(String(m.text()).slice(0, 400));
    });
    pcPage.on("websocket", (ws: any) => {
      ws.on("framesent", (f: any) => {
        pcWsFrames.push(`OUT:${String(f.payload).slice(0, 180)}`);
        if (pcWsFrames.length > 30) pcWsFrames.shift();
      });
      ws.on("framereceived", (f: any) => {
        pcWsFrames.push(`IN:${String(f.payload).slice(0, 180)}`);
        if (pcWsFrames.length > 30) pcWsFrames.shift();
      });
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
    const mobPageErrors: string[] = [];
    const mobConsoleErrors: string[] = [];
    mobilePage.on("pageerror", (e: Error) => mobPageErrors.push(String(e).slice(0, 400)));
    mobilePage.on("console", (m: any) => {
      if (m.type() === "error") mobConsoleErrors.push(String(m.text()).slice(0, 400));
    });
    await attachAuthInit(mobilePage, ctx.login);

    // Start on `companionSid` so the Cold `.zst` session has never been loaded into browser memory!
    await selectSessionInUI(pcPage, ctx.gwUrl, ctx.hostId, ctx.companionSid);

    // =========================================================================
    // STEP B: BM25F `Ctrl+K` Search (`HistoryView`) — PT-BR Diacritics & Cold Agentic Completion
    // =========================================================================
    log("step-b", "Testing Ctrl+K HistoryView BM25F search (PT-BR diacritics + Cold .zst finish_entire_request)...");
    await pcPage.keyboard.press("Control+k");
    const searchInput = pcPage.locator('input[placeholder*="Search conversations"]').first();
    await searchInput.waitFor({ state: "visible", timeout: 10000 });

    // B1: Accent-insensitive PT-BR query ("configuracao sessao" -> matches "configuração crítica da sessão anual" at Turn #12)
    await searchInput.fill("configuracao sessao");
    const ptHit = pcPage.locator(`[data-history-hit-id="${LEGACY_SESSION_ID}"]`).first();
    await ptHit.waitFor({ state: "visible", timeout: 10000 });
    await pcPage.waitForFunction(
      (sid: string) => {
        const el = document.querySelector(`[data-history-hit-id="${sid}"]`);
        const txt = (el?.textContent || "").toLowerCase();
        return txt.includes("configuração") && txt.includes("sessão");
      },
      LEGACY_SESSION_ID,
      { timeout: 8000 },
    );
    const ptHitText = (await ptHit.innerText()).trim();
    assert(
      /user|assistant/.test(ptHitText),
      `expected field badge (user/assistant) on PT-BR BM25F hit, got: ${ptHitText}`,
    );

    // B2: Cold `.zst` agentic `finish_entire_request` query ("postgres deadlock" -> Turn #18 `assistant` field badge!)
    await searchInput.fill("postgres deadlock");
    await pcPage.waitForFunction(
      (sid: string) => {
        const el = document.querySelector(`[data-history-hit-id="${sid}"]`);
        const txt = el?.textContent || "";
        return (
          txt.includes("PostgreSQL deadlock resolved via deterministic lock ordering") &&
          txt.includes("assistant")
        );
      },
      LEGACY_SESSION_ID,
      { timeout: 8000 },
    );

    if (SCREENSHOTS_DIR) {
      const searchShot = path.join(SCREENSHOTS_DIR, "scale_bm25_search_desktop.png");
      await pcPage.screenshot({ path: searchShot });
      log("screenshot", `Saved ${searchShot}`);
    }
    assertNoPageErrors(pcPageErrors, pcConsoleErrors, "Step B Desktop Search");
    log("step-b", "PASSED: BM25F PT-BR diacritic folding + Cold .zst finish_entire_request hit & field badge verified");

    // =========================================================================
    // STEP C (Desktop): `aroundMsgIdx` Cold-Archive Jump + CAS `get_blob` Image + Bi-Directional Scroll
    // =========================================================================
    log("step-c-desktop", "Clicking Cold .zst Turn #18 search hit -> verifying aroundMsgIdx window, highlight, CAS blob image, and bi-directional scroll...");
    const jumpT0 = performance.now();
    await pcPage.locator(`[data-history-hit-id="${LEGACY_SESSION_ID}"]`).first().click();

    const jumpBanner = pcPage.locator("[data-history-jump-latest]");
    await jumpBanner.waitFor({ state: "visible", timeout: 10000 });
    await pcPage
      .waitForFunction(
        () => {
          const conv = document.querySelector('div[aria-label="Conversation"]');
          return Boolean(
            conv &&
              conv.textContent?.includes(
                "PostgreSQL deadlock resolved via deterministic lock ordering across accounts and ledger_entries.",
              ),
          );
        },
        undefined,
        { timeout: 10000 },
      )
      .catch(async (err: unknown) => {
        const snap = await pcPage.evaluate(() => {
          const conv = document.querySelector('div[aria-label="Conversation"]');
          const raws = Array.from(document.querySelectorAll("[data-raw-idx]")).map((e) =>
            e.getAttribute("data-raw-idx"),
          );
          return {
            raws,
            textHead: (conv?.textContent || "").slice(0, 500),
          };
        });
        throw new Error(`Step C1 text waitForFunction failed: ${JSON.stringify(snap)} :: ${err}`);
      });
    const jumpMs = Math.round(performance.now() - jumpT0);

    // C1: Highlighted `[data-raw-idx]` block is mounted & highlighted, and window is centered (neither Turn #1 nor Turn #240 mounted!)
    const highlightedBlock = pcPage.locator('[data-raw-idx][data-highlighted="true"]').first();
    await highlightedBlock.waitFor({ state: "visible", timeout: 5000 });
    const highlightedRawIdx = Number(await highlightedBlock.getAttribute("data-raw-idx"));
    assert(highlightedRawIdx > 50 && highlightedRawIdx < 200, `expected Cold Turn #18 rawIdx in (50..200), got ${highlightedRawIdx}`);

    const bannerText = await jumpBanner.innerText();
    assert(
      bannerText.includes("Viewing older history") && bannerText.includes("Jump to latest"),
      `unexpected jump banner text: ${bannerText}`,
    );

    const loadOlderBtn = pcPage.locator("button", { hasText: /Load older turns/i }).first();
    await loadOlderBtn.waitFor({ state: "visible", timeout: 5000 });

    const windowBoundsCheck = await pcPage.evaluate((tailMarker: string) => {
      const conv = document.querySelector('div[aria-label="Conversation"]');
      const txt = conv?.textContent || "";
      return {
        hasTurn1: txt.includes("TURN_1_GENESIS_MARKER"),
        hasTurn36: txt.includes("TURN_36_COLD_MARKER"),
        hasTail: txt.includes(tailMarker),
      };
    }, `LIVE_TAIL_TURN_${TOTAL_SEEDED_TURNS}_ANCHOR`);
    assert.equal(windowBoundsCheck.hasTurn1, false, "centered Cold window around Turn #18 must NOT mount Turn #1 initially");
    assert.equal(windowBoundsCheck.hasTurn36, false, "centered Cold window around Turn #18 must NOT mount Turn #36 initially");
    assert.equal(windowBoundsCheck.hasTail, false, "centered Cold window around Turn #18 must NOT mount live tail Turn #240");

    // C2: Verify CAS `blobSha256` image hydrated via `get_blob` -> `blob_data` into a `blob:` ObjectURL!
    await pcPage
      .waitForFunction(
        () => {
          const imgs = Array.from(
            document.querySelectorAll<HTMLImageElement>('div[aria-label="Conversation"] img'),
          );
          return imgs.some(
            (img) =>
              img.src.startsWith("blob:") &&
              img.complete &&
              img.naturalWidth === 240 &&
              img.naturalHeight === 120,
          );
        },
        undefined,
        { timeout: 10000 },
      )
      .catch(async (err: unknown) => {
        const snap = await pcPage.evaluate(() => {
          const conv = document.querySelector('div[aria-label="Conversation"]');
          const imgs = Array.from(
            document.querySelectorAll<HTMLImageElement>('div[aria-label="Conversation"] img'),
          ).map((img) => ({
            src: img.src.slice(0, 80),
            complete: img.complete,
            w: img.naturalWidth,
            h: img.naturalHeight,
          }));
          const loadingPlaceholders = Array.from(conv?.querySelectorAll("span") || [])
            .map((s) => s.textContent || "")
            .filter((t) => t.includes("Loading image") || t.includes("attached"));
          return { imgs, loadingPlaceholders };
        });
        throw new Error(`Step C2 blob img waitForFunction failed: ${JSON.stringify(snap)} :: ${err}`);
      });

    // Ensure the target block + hydrated diagram are cleanly centered in viewport for the verification screenshot.
    await pcPage.evaluate(() => {
      const img = Array.from(
        document.querySelectorAll<HTMLImageElement>('div[aria-label="Conversation"] img'),
      ).find((el) => el.src.startsWith("blob:"));
      img?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
    });
    await pcPage.waitForTimeout(80);

    if (SCREENSHOTS_DIR) {
      const jumpShot = path.join(SCREENSHOTS_DIR, "scale_cold_jump_banner_desktop.png");
      await pcPage.screenshot({ path: jumpShot });
      log("screenshot", `Saved ${jumpShot}`);
    }

    // C3: Scroll up & trigger `beforeTurn` ("Load older turns") -> verify Turn #1 prepends with ZERO two-phase height jump!
    await pcPage.evaluate(() => {
      const conv = document.querySelector<HTMLElement>('div[aria-label="Conversation"]');
      if (conv) conv.scrollTop = 0;
    });
    await loadOlderBtn.waitFor({ state: "visible", timeout: 5000 });

    const prependStability = await pcPage.evaluate(async () => {
      const conv = document.querySelector<HTMLElement>('div[aria-label="Conversation"]')!;
      // Scroll slightly down so a visible transcript block acts as the viewport reading anchor
      conv.scrollTop = 180;
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const containerTop = conv.getBoundingClientRect().top;
      const blocks = Array.from(conv.querySelectorAll<HTMLElement>("[data-transcript-id]"));
      const anchorEl = blocks.find((b) => b.getBoundingClientRect().bottom >= containerTop + 20)!;
      const anchorId = anchorEl.getAttribute("data-transcript-id")!;
      const beforeRelTop = anchorEl.getBoundingClientRect().top - containerTop;

      const btn = Array.from(conv.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("Load older turns"),
      )!;
      btn.click();

      // Wait until Turn #1 genesis marker lands in the DOM
      const deadline = performance.now() + 8000;
      while (performance.now() < deadline) {
        if ((conv.textContent || "").includes("TURN_1_GENESIS_MARKER")) break;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }

      const targetAfter0 = conv.querySelector<HTMLElement>(`[data-transcript-id="${anchorId}"]`)!;
      const relTopFrame0 = targetAfter0.getBoundingClientRect().top - conv.getBoundingClientRect().top;

      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const relTopFrame1 = targetAfter0.getBoundingClientRect().top - conv.getBoundingClientRect().top;

      await new Promise((r) => setTimeout(r, 120));
      const relTopSettled = targetAfter0.getBoundingClientRect().top - conv.getBoundingClientRect().top;

      return {
        hasTurn1: (conv.textContent || "").includes("TURN_1_GENESIS_MARKER"),
        beforeRelTop,
        relTopFrame0,
        relTopFrame1,
        relTopSettled,
        twoPhaseDriftPx: Math.abs(relTopSettled - relTopFrame0),
        anchorDriftPx: Math.abs(relTopFrame0 - beforeRelTop),
      };
    });

    assert.equal(prependStability.hasTurn1, true, "beforeTurn must prepend Cold Turn #1 into transcript");
    assert(
      prependStability.twoPhaseDriftPx <= 2,
      `expected zero two-phase height jump after Frame 0 markdown parse (drift=${prependStability.twoPhaseDriftPx}px)`,
    );
    assert(
      prependStability.anchorDriftPx <= 4,
      `expected viewport reading anchor preserved on prepend (drift=${prependStability.anchorDriftPx}px)`,
    );

    // C4: Scroll down (`afterTurn`) -> verify newer Cold turns beyond Turn #32 append cleanly while `hasNewer` stays true!
    await pcPage.evaluate(() => {
      const conv = document.querySelector<HTMLElement>('div[aria-label="Conversation"]');
      if (conv) {
        conv.scrollTop = conv.scrollHeight;
        conv.dispatchEvent(new Event("scroll"));
      }
    });
    await pcPage.waitForFunction(
      () => {
        const conv = document.querySelector('div[aria-label="Conversation"]');
        return Boolean(conv && conv.textContent?.includes("TURN_36_COLD_MARKER"));
      },
      undefined,
      { timeout: 10000 },
    );
    assert(await jumpBanner.isVisible(), "Viewing older history banner must remain visible while hasNewer is true");

    // C5: Click "Jump to latest" -> re-anchors at live tail Turn #240 and hides `hasNewer` banner!
    await jumpBanner.click();
    await jumpBanner.waitFor({ state: "hidden", timeout: 10000 });
    await pcPage.waitForFunction(
      (tailMarker: string) => {
        const conv = document.querySelector('div[aria-label="Conversation"]');
        return Boolean(conv && conv.textContent?.includes(tailMarker));
      },
      `LIVE_TAIL_TURN_${TOTAL_SEEDED_TURNS}_ANCHOR`,
      { timeout: 10000 },
    );

    // C6: Same-session Cold jump via `get_history { aroundMsgIdx }`: press Ctrl+K from the live tail,
    // search PT-BR `"configuracao sessao"`, click hit -> jumps back to Cold Turn #12!
    await pcPage.keyboard.press("Control+k");
    await searchInput.waitFor({ state: "visible", timeout: 8000 });
    await searchInput.fill("configuracao sessao");
    await pcPage.locator(`[data-history-hit-id="${LEGACY_SESSION_ID}"]`).first().waitFor({
      state: "visible",
      timeout: 8000,
    });
    await pcPage.locator(`[data-history-hit-id="${LEGACY_SESSION_ID}"]`).first().click();
    await jumpBanner.waitFor({ state: "visible", timeout: 10000 }).catch(async (err: unknown) => {
      const snap = await pcPage.evaluate(() => {
        const conv = document.querySelector('div[aria-label="Conversation"]');
        const raws = Array.from(document.querySelectorAll("[data-raw-idx]")).map((e) =>
          e.getAttribute("data-raw-idx"),
        );
        const histInput = document.querySelector('input[placeholder*="Search conversations"]');
        return {
          inHistoryView: Boolean(histInput),
          rawsHead: raws.slice(0, 6),
          rawsTail: raws.slice(-6),
          textHead: (conv?.textContent || "").slice(0, 300),
        };
      });
      throw new Error(
        `Step C6 jumpBanner waitFor failed: ${JSON.stringify(snap)} ws=${JSON.stringify(pcWsFrames.slice(-12))} :: ${err}`,
      );
    });
    await pcPage.waitForFunction(
      () => {
        const conv = document.querySelector('div[aria-label="Conversation"]');
        return Boolean(
          conv && conv.textContent?.includes("configuração crítica da sessão anual"),
        );
      },
      undefined,
      { timeout: 10000 },
    );
    await pcPage.locator('[data-raw-idx][data-highlighted="true"]').first().waitFor({
      state: "visible",
      timeout: 5000,
    });
    // Return to live tail before Step D
    await jumpBanner.click();
    await jumpBanner.waitFor({ state: "hidden", timeout: 10000 });

    assertNoPageErrors(pcPageErrors, pcConsoleErrors, "Step C Desktop Cold Jump & Scroll");
    log(
      "step-c-desktop",
      `PASSED: Cold .zst jump (${jumpMs}ms), [data-highlighted], CAS blob 240x120 ObjectURL, Frame-0 beforeTurn (drift=${prependStability.twoPhaseDriftPx.toFixed(2)}px), afterTurn, and Jump to latest verified`,
    );

    // =========================================================================
    // STEP C (Mobile 390x844): BM25F Search + Cold Jump + CAS Blob + Banner Screenshot
    // =========================================================================
    log("step-c-mobile", "Verifying Mobile (390x844) BM25F search, Cold .zst jump, CAS blob image, and banner...");
    await selectSessionInUI(mobilePage, ctx.gwUrl, ctx.hostId, ctx.companionSid);
    const mobCloseDrawer = mobilePage.locator('button[aria-label="Close sidebar"]').first();
    if ((await mobCloseDrawer.count()) > 0 && (await mobCloseDrawer.isVisible().catch(() => false))) {
      await mobCloseDrawer.click();
      await mobilePage.waitForTimeout(200);
    }

    await mobilePage.keyboard.press("Control+k");
    const mobSearchInput = mobilePage.locator('input[placeholder*="Search conversations"]').first();
    await mobSearchInput.waitFor({ state: "visible", timeout: 10000 });
    await mobSearchInput.fill("postgres deadlock");

    const mobHit = mobilePage.locator(`[data-history-hit-id="${LEGACY_SESSION_ID}"]`).first();
    await mobHit.waitFor({ state: "visible", timeout: 10000 });
    await mobilePage.waitForFunction(
      (sid: string) => {
        const el = document.querySelector(`[data-history-hit-id="${sid}"]`);
        const txt = el?.textContent || "";
        return (
          txt.includes("PostgreSQL deadlock resolved via deterministic lock ordering") &&
          txt.includes("assistant")
        );
      },
      LEGACY_SESSION_ID,
      { timeout: 8000 },
    );

    await mobHit.click();
    const mobJumpBanner = mobilePage.locator("[data-history-jump-latest]");
    await mobJumpBanner.waitFor({ state: "visible", timeout: 10000 });
    await mobilePage.locator('[data-raw-idx][data-highlighted="true"]').first().waitFor({
      state: "visible",
      timeout: 5000,
    });
    await mobilePage.waitForFunction(
      () => {
        const imgs = Array.from(
          document.querySelectorAll<HTMLImageElement>('div[aria-label="Conversation"] img'),
        );
        return imgs.some(
          (img) =>
            img.src.startsWith("blob:") &&
            img.complete &&
            img.naturalWidth === 240 &&
            img.naturalHeight === 120,
        );
      },
      undefined,
      { timeout: 10000 },
    );

    await mobilePage.evaluate(() => {
      const img = Array.from(
        document.querySelectorAll<HTMLImageElement>('div[aria-label="Conversation"] img'),
      ).find((el) => el.src.startsWith("blob:"));
      img?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
    });
    await mobilePage.waitForTimeout(80);

    // Verify no horizontal overflow on 390px mobile viewport
    const mobOverflow = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    assert.equal(mobOverflow, true, "Mobile 390x844 Cold jump view must not overflow horizontally");

    if (SCREENSHOTS_DIR) {
      const mobShot = path.join(SCREENSHOTS_DIR, "scale_cold_jump_mobile.png");
      await mobilePage.screenshot({ path: mobShot });
      log("screenshot", `Saved ${mobShot}`);
    }

    await mobJumpBanner.click();
    await mobJumpBanner.waitFor({ state: "hidden", timeout: 10000 });
    await mobilePage.waitForFunction(
      (tailMarker: string) => {
        const conv = document.querySelector('div[aria-label="Conversation"]');
        return Boolean(conv && conv.textContent?.includes(tailMarker));
      },
      `LIVE_TAIL_TURN_${TOTAL_SEEDED_TURNS}_ANCHOR`,
      { timeout: 10000 },
    );
    assertNoPageErrors(mobPageErrors, mobConsoleErrors, "Step C Mobile Cold Jump");
    log("step-c-mobile", "PASSED: Mobile 390x844 BM25F search, Cold jump, CAS blob image, and Jump to latest verified");

    // =========================================================================
    // STEP D: Composer Zero-Reflow & Immediate (< 100ms) Draft Flush on Session Switch
    // =========================================================================
    log("step-d", "Verifying Composer single-line zero-reflow + synchronous draft flush on < 100ms session switch...");
    const composer = pcPage.locator("#rc-composer");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.fill("");

    // Install style-mutation spy on `#rc-composer` to detect any `height = "auto"` thrash
    await pcPage.evaluate(() => {
      const el = document.getElementById("rc-composer") as HTMLTextAreaElement;
      const win = window as any;
      win.__composerHeightAutoWrites = 0;
      win.__composerHeights = [el.getBoundingClientRect().height];
      const styleDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style")!;
      const styleObj = styleDesc.get!.call(el) as CSSStyleDeclaration;
      const origSetProp = styleObj.setProperty.bind(styleObj);
      let currentHeight = styleObj.height;
      Object.defineProperty(styleObj, "height", {
        configurable: true,
        get() {
          return currentHeight;
        },
        set(v: string) {
          if (v === "auto") win.__composerHeightAutoWrites++;
          currentHeight = v;
          origSetProp("height", v);
        },
      });
      el.addEventListener("input", () => {
        win.__composerHeights.push(el.getBoundingClientRect().height);
      });
    });

    const containCss = await pcPage.evaluate(() => {
      const card = document.querySelector(".rc-composer");
      return card ? getComputedStyle(card).contain : "";
    });
    assert(
      containCss.includes("layout") && containCss.includes("style"),
      `expected .rc-composer contain: layout style, got "${containCss}"`,
    );

    const draftText = "Verify zero-reflow draft flush";
    await composer.focus();
    await pcPage.keyboard.type(draftText, { delay: 3 });

    // Immediately (< 100ms, well before the 250ms debounce timer!) click `companionSid` in sidebar!
    const switchStartMs = performance.now();
    await pcPage.locator(`aside [data-session-id="${ctx.companionSid}"]`).first().click();
    const switchClickElapsedMs = performance.now() - switchStartMs;
    assert(
      switchClickElapsedMs < 100,
      `expected session switch click within < 100ms of typing, took ${switchClickElapsedMs.toFixed(1)}ms`,
    );

    // Synchronously verify `localStorage` draft key for `LEGACY_SESSION_ID` was flushed IMMEDIATELY!
    const draftCheck = await pcPage.evaluate(
      ({ hid, legacySid }: { hid: string; legacySid: string }) => {
        const win = window as any;
        const heights: number[] = win.__composerHeights || [];
        const minH = Math.min(...heights);
        const maxH = Math.max(...heights);
        return {
          persistedDraft: localStorage.getItem(`llmgw-draft:${hid}:${legacySid}`),
          currentComposerValue: (document.getElementById("rc-composer") as HTMLTextAreaElement | null)?.value ?? "",
          autoWrites: Number(win.__composerHeightAutoWrites || 0),
          heightSpread: maxH - minH,
          samples: heights.length,
        };
      },
      { hid: ctx.hostId, legacySid: LEGACY_SESSION_ID },
    );

    assert.equal(
      draftCheck.autoWrites,
      0,
      `single-line composer typing must NEVER set style.height = "auto" (got ${draftCheck.autoWrites})`,
    );
    assert(
      draftCheck.heightSpread <= 0.5 && draftCheck.samples >= draftText.length,
      `expected constant single-line composer height across ${draftCheck.samples} keystrokes, spread=${draftCheck.heightSpread}px`,
    );
    assert.equal(
      draftCheck.persistedDraft,
      draftText,
      "debounced composer draft must flush synchronously to localStorage on immediate (<100ms) session switch",
    );
    assert.equal(draftCheck.currentComposerValue, "", "companion session composer must start empty");

    // Switch back to `LEGACY_SESSION_ID` and verify the flushed draft restores into `#rc-composer`!
    await pcPage.locator(`aside [data-session-id="${LEGACY_SESSION_ID}"]`).first().click();
    await pcPage.waitForFunction(
      (expected: string) => {
        const el = document.getElementById("rc-composer") as HTMLTextAreaElement | null;
        return el?.value === expected;
      },
      draftText,
      { timeout: 8000 },
    );

    assertNoPageErrors(pcPageErrors, pcConsoleErrors, "Step D Composer Zero-Reflow & Draft Flush");
    log(
      "step-d",
      `PASSED: single-line zero-reflow (0 height="auto" writes across ${draftCheck.samples} samples, contain="${containCss}") + synchronous ${switchClickElapsedMs.toFixed(1)}ms session-switch draft flush & restore`,
    );

    await pcContext.close();
    await mobileContext.close();
    log("all", "ALL SCALE + BM25F + COLD ZSTD + CAS BLOB + COMPOSER ZERO-JANK E2E CHECKS PASSED");
  } finally {
    await browser.close();
    ctx.ws.close();
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
process.exit(0);
