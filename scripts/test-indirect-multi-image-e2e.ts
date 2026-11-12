/**
 * scripts/test-indirect-multi-image-e2e.ts — deterministic full-stack E2E suite
 * verifying multi-image ingestion, hysteresis Vision-to-Text digests, reactive
 * provider error shedding, and Chromium UI + WAL reload durability across:
 *   - Real compiled Go daemon (`indirect-code-daemon/bin/indirect-code[.exe]`)
 *   - Real Bun Gateway (`/anthropic/v1/messages` -> `gateway-ir.ts` -> OpenAI `/v1/chat/completions`)
 *   - Instrumented OpenAI Chat Completions mock upstream
 *   - Real headless Chromium (`1280x800` desktop + `page.reload()` + `390x844` mobile)
 *
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-multi-image-e2e.ts
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
import { deflateSync } from "node:zlib";

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
const MODEL = "mock-multi-image-v1";
const OCR_TOKEN = "OCR_BADGE_ALPHA_7741";

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

// ---------------------------------------------------------------------------
// Deterministic Pure-TS High-Res PNG & 24-bit BMP Generators + Wire Parsers
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
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
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function encodePatternedPng(width: number, height: number, seed: number, withAlpha: boolean): Buffer {
  const stride = 1 + width * 4;
  const raw = Buffer.allocUnsafe(height * stride);
  const s1 = (seed * 97 + 17) | 0;
  const s2 = (seed * 131 + 31) | 0;

  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter: None
    const yMix = Math.imul(y + s2, 2246822519);
    const baseG = (y * 255) / height;
    let p = rowOff + 1;
    for (let x = 0; x < width; x++) {
      if (withAlpha) {
        // Clean UI overlay geometry with genuine alpha transparency (compresses << 450 KiB so alpha PNG is preserved)
        const inCard = x >= 180 && x < width - 180 && y >= 140 && y < height - 140;
        raw[p] = inCard ? 36 : 0;
        raw[p + 1] = inCard ? ((x >> 4) & 1 ? 124 : 96) : 0;
        raw[p + 2] = inCard ? 218 : 0;
        raw[p + 3] = inCard ? (((x >> 6) ^ (y >> 6)) & 1 ? 255 : 160) : 0;
      } else {
        let h = Math.imul(x + s1, 2654435761) ^ yMix;
        h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
        const grain = h & 0x3f;
        raw[p] = (((x * 255) / width + seed * 23) & 0xc0) | grain;
        raw[p + 1] = ((baseG + ((h >>> 6) & 0x3f)) & 0xff);
        raw[p + 2] = ((((x ^ y) + seed * 41) & 0xc0) | ((h >>> 12) & 0x3f)) & 0xff;
        raw[p + 3] = 255;
      }
      p += 4;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = deflateSync(raw, { level: 1 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function encodePatternedBmp24(width: number, height: number, seed: number): Buffer {
  const rowStride = (width * 3 + 3) & ~3;
  const pixelBytes = rowStride * height;
  const buf = Buffer.alloc(54 + pixelBytes);

  // BITMAPFILEHEADER (14 bytes)
  buf.write("BM", 0, 2, "ascii");
  buf.writeUInt32LE(54 + pixelBytes, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y++) {
    const rowOff = 54 + y * rowStride;
    const yMix = Math.imul(y + seed * 53, 2246822519);
    let p = rowOff;
    for (let x = 0; x < width; x++) {
      const h = Math.imul(x + seed * 71, 2654435761) ^ yMix;
      buf[p] = ((x + y + (h & 0x1f)) & 0xff); // B
      buf[p + 1] = (((y >> 2) + ((h >>> 5) & 0x1f)) & 0xff); // G
      buf[p + 2] = (((x >> 2) + seed * 19 + ((h >>> 10) & 0x1f)) & 0xff); // R
      p += 3;
    }
  }
  return buf;
}

function parseDataUrlImageMeta(url: string): { mime: string; width: number; height: number; byteLen: number } {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
  assert(m, `expected valid base64 data:image/* URL on wire, got prefix "${url.slice(0, 48)}"`);
  const mime = m[1]!.toLowerCase();
  const raw = Buffer.from(m[2]!, "base64");

  if (mime === "image/png") {
    assert(raw.length >= 24 && raw[0] === 0x89 && raw[1] === 0x50, "invalid PNG header in wire image_url");
    return {
      mime,
      width: raw.readUInt32BE(16),
      height: raw.readUInt32BE(20),
      byteLen: raw.length,
    };
  }

  if (mime === "image/jpeg") {
    assert(raw.length >= 4 && raw[0] === 0xff && raw[1] === 0xd8, "invalid JPEG SOI in wire image_url");
    let pos = 2;
    while (pos + 9 < raw.length) {
      if (raw[pos] !== 0xff) {
        pos += 1;
        continue;
      }
      while (pos < raw.length && raw[pos] === 0xff) pos += 1;
      if (pos >= raw.length) break;
      const marker = raw[pos]!;
      pos += 1;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }
      if (pos + 2 > raw.length) break;
      const segLen = raw.readUInt16BE(pos);
      if (
        (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) &&
        pos + 7 <= raw.length
      ) {
        const height = raw.readUInt16BE(pos + 3);
        const width = raw.readUInt16BE(pos + 5);
        return { mime, width, height, byteLen: raw.length };
      }
      if (segLen < 2) break;
      pos += segLen;
    }
    throw new Error("JPEG SOF marker not found in wire image_url");
  }

  throw new Error(`unexpected wire image MIME "${mime}"`);
}

const KNOWN_CONSOLE_NOISE = [/Content Security Policy.*accounts\.google\.com/i, /gsi\/client/i];
function assertNoPageErrors(pageErrors: string[], consoleErrors: string[], where: string) {
  assert.deepEqual(pageErrors, [], `${where}: page errors: ${pageErrors.join(" | ")}`);
  const fresh = consoleErrors.filter((m) => !KNOWN_CONSOLE_NOISE.some((re) => re.test(m)));
  assert.deepEqual(fresh, [], `${where}: console errors: ${fresh.join(" | ")}`);
}

async function assertNoHorizontalOverflow(page: any, where: string, maxViewportWidth?: number) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    dims.scrollWidth <= dims.clientWidth,
    `${where}: horizontal overflow detected (scrollWidth=${dims.scrollWidth} > clientWidth=${dims.clientWidth})`,
  );
  if (maxViewportWidth !== undefined) {
    assert(
      dims.scrollWidth <= maxViewportWidth,
      `${where}: scrollWidth=${dims.scrollWidth} exceeded mobile viewport ${maxViewportWidth}`,
    );
  }
}

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function textOfMessage(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

type ToolCallSpec = { id: string; name: string; args: Record<string, unknown> };
type MockReply =
  | { kind: "text"; text: string; inTok?: number; outTok?: number }
  | { kind: "tools"; calls: ToolCallSpec[]; inTok?: number; outTok?: number };

let callSeq = 0;
function nextCallId(prefix: string): string {
  callSeq += 1;
  return `${prefix}_${callSeq}`;
}

function buildOpenAIResponse(model: string, stream: boolean, reply: MockReply): Response {
  const inTok = reply.inTok ?? 510;
  const outTok = reply.outTok ?? 88;
  const usage = {
    prompt_tokens: inTok,
    completion_tokens: outTok,
    total_tokens: inTok + outTok,
  };
  const respId = `chatcmpl-multi-img-${++callSeq}`;

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
      reply.calls.forEach((tc, idx) => {
        body += sseFrame({
          id: respId,
          object: "chat.completion.chunk",
          model,
          choices: [
            {
              index: 0,
              delta: {
                ...(idx === 0 ? { role: "assistant", content: null } : {}),
                tool_calls: [
                  {
                    index: idx,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
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
          tool_calls: reply.calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage,
  });
}

// ---------------------------------------------------------------------------
// Wire Telemetry State Recorded by Mock OpenAI Upstream
// ---------------------------------------------------------------------------
const wireAudit = {
  wireViolations: [] as string[],
  transcriberCalls: 0,
  compactionCalls: 0,
  parallelBatchContiguousVerified: false,
  opaqueJpegNormalizedCount: 0,
  transparentPngPreservedCount: 0,
  turn1LiveImages: -1,
  turn2LiveImages: -1,
  turn3PostHysteresisLiveImages: -1,
  turn3VisualDigestInjected: false,
  turn4LiveImages: -1,
  historySearchOutput: "",
  shedCapInjected: false,
  preShedCapLiveImages: -1,
  postShedCapLiveImages: -1,
  shedNoVisionInjected: false,
  preNoVisionLiveImages: -1,
  postNoVisionLiveImages: -1,
};

const BASE64_BLOB_RE = /[A-Za-z0-9+/]{512,}={0,2}/;

function inspectOpenAIWireMessages(messages: any[]) {
  const imageParts: Array<{ mime: string; width: number; height: number; byteLen: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;

    // 1. Assert role:"tool" messages NEVER carry base64 or JSON-stringified image blobs
    if (m.role === "tool") {
      const rawSerialized = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (
        rawSerialized.includes("data:image/") ||
        rawSerialized.includes('"image_url"') ||
        rawSerialized.includes("preview_data_url") ||
        BASE64_BLOB_RE.test(rawSerialized)
      ) {
        wireAudit.wireViolations.push(`role="tool" at idx=${i} leaked image/base64 payload: ${rawSerialized.slice(0, 180)}`);
      }
    }

    // 2. Assert parallel tool_calls keep role:"tool" responses strictly contiguous before hoisted user image message
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 1) {
      const k = m.tool_calls.length;
      let allContiguousTools = true;
      for (let off = 1; off <= k; off++) {
        if (messages[i + off]?.role !== "tool") {
          allContiguousTools = false;
          wireAudit.wireViolations.push(
            `parallel tool_calls (k=${k}) broken at idx=${i + off}: expected role="tool", got "${messages[i + off]?.role}"`,
          );
        }
      }
      if (allContiguousTools && k === 3 && messages[i + k + 1]?.role === "user") {
        const carrierParts = Array.isArray(messages[i + k + 1]?.content) ? messages[i + k + 1].content : [];
        if (carrierParts.some((p: any) => p?.type === "image_url")) {
          wireAudit.parallelBatchContiguousVerified = true;
        }
      }
    }

    // 3. Inspect every hoisted image_url part for <=1568px normalization & MIME format
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : String(part.image_url?.url || "");
          try {
            const meta = parseDataUrlImageMeta(url);
            imageParts.push(meta);
            if (meta.width > 1568 || meta.height > 1568) {
              wireAudit.wireViolations.push(
                `image_url at msg=${i} exceeded 1568px bound: ${meta.width}x${meta.height} (${meta.mime})`,
              );
            }
            if (meta.mime === "image/jpeg") wireAudit.opaqueJpegNormalizedCount += 1;
            if (meta.mime === "image/png") wireAudit.transparentPngPreservedCount += 1;
          } catch (err) {
            wireAudit.wireViolations.push(`image_url parse error at msg=${i}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }
  }

  return imageParts;
}

const mockUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) {
      return Response.json(
        { error: { message: `unexpected path ${url.pathname}`, type: "invalid_request_error" } },
        { status: 404 },
      );
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

    // 1. Vision-to-Text Transcriber call (triggered when live wire images > 6)
    if (systemText.includes("concise technical visual transcriber")) {
      wireAudit.transcriberCalls += 1;
      const digestBullets = [
        `- Visible OCR badge: \`${OCR_TOKEN}\` (frame #${wireAudit.transcriberCalls})`,
        "- Header status pill: `200 OK · latency 14ms`",
        "- Layout state: multi-column telemetry grid aligned cleanly",
      ].join("\n");
      return buildOpenAIResponse(model, stream, {
        kind: "text",
        text: digestBullets,
        inTok: 620,
        outTok: 85,
      });
    }

    // 2. Manual /compact checkpoint summarizer
    if (
      allText.includes("INTERNAL COMPACTION FORK") ||
      systemText.includes("context-checkpointing summarizer")
    ) {
      wireAudit.compactionCalls += 1;
      return buildOpenAIResponse(model, stream, {
        kind: "text",
        text: [
          "### Goal",
          "Audit all 10 high-resolution screenshots across PNG and BMP formats and verify OCR badges.",
          "",
          "### Progress",
          `- Read \`images/img-01.png\` through \`images/img-10-capture.bmp\` and verified \`${OCR_TOKEN}\`.`,
        ].join("\n"),
        inTok: 980,
        outTok: 120,
      });
    }

    // 3. Main agent turn requests: run wire invariants on every call
    const liveImageParts = inspectOpenAIWireMessages(messages);
    const liveImageCount = liveImageParts.length;

    // Locate the latest human turn prompt carrying [TURN_TAG:...] (skipping synthetic hoisted image user carriers)
    let promptIdx = -1;
    let turnTag = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "user") continue;
      const txt = textOfMessage(messages[i]);
      const m = /\[TURN_TAG:([A-Z0-9_]+)\]/.exec(txt);
      if (m) {
        promptIdx = i;
        turnTag = m[1]!;
        break;
      }
    }
    const assistantRoundsSincePrompt =
      promptIdx >= 0 ? messages.slice(promptIdx + 1).filter((m) => m?.role === "assistant").length : 0;

    if (turnTag === "T1_PARALLEL_3") {
      if (assistantRoundsSincePrompt === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tools",
          calls: [
            { id: nextCallId("call_r1"), name: "read", args: { path: "images/img-01.png" } },
            { id: nextCallId("call_r2"), name: "read", args: { path: "images/img-02.png" } },
            { id: nextCallId("call_r3"), name: "read", args: { path: "images/img-03.png" } },
          ],
        });
      }
      wireAudit.turn1LiveImages = liveImageCount;
      for (const p of liveImageParts) {
        if (p.mime !== "image/jpeg") {
          wireAudit.wireViolations.push(`T1 expected opaque PNG converted to image/jpeg, got ${p.mime}`);
        }
      }
      return buildOpenAIResponse(model, stream, {
        kind: "tools",
        calls: [
          {
            id: nextCallId("call_fin_t1"),
            name: "finish_entire_request",
            args: { final_message_to_user: "Inspected parallel batch img-01..03." },
          },
        ],
      });
    }

    if (turnTag === "T2_BATCH_4_TO_6") {
      if (assistantRoundsSincePrompt === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tools",
          calls: [
            { id: nextCallId("call_r4"), name: "read", args: { path: "images/img-04.png" } },
            { id: nextCallId("call_r5"), name: "read", args: { path: "images/img-05.png" } },
            { id: nextCallId("call_r6"), name: "read", args: { path: "images/img-06.png" } },
          ],
        });
      }
      wireAudit.turn2LiveImages = liveImageCount;
      return buildOpenAIResponse(model, stream, {
        kind: "tools",
        calls: [
          {
            id: nextCallId("call_fin_t2"),
            name: "finish_entire_request",
            args: { final_message_to_user: "Inspected batch img-04..06 (6 live images)." },
          },
        ],
      });
    }

    if (turnTag === "T3_HYSTERESIS_7TH") {
      if (assistantRoundsSincePrompt === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tools",
          calls: [{ id: nextCallId("call_r7"), name: "read", args: { path: "images/img-07.png" } }],
        });
      }
      wireAudit.turn3PostHysteresisLiveImages = liveImageCount;
      if (allText.includes("[Visual Digest —") && allText.includes(OCR_TOKEN)) {
        wireAudit.turn3VisualDigestInjected = true;
      }
      return buildOpenAIResponse(model, stream, {
        kind: "tools",
        calls: [
          {
            id: nextCallId("call_fin_t3"),
            name: "finish_entire_request",
            args: { final_message_to_user: "Read 7th image; hysteresis 6->3 and Visual Digest verified." },
          },
        ],
      });
    }

    if (turnTag === "T4_MIXED_8_TO_10") {
      if (assistantRoundsSincePrompt === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tools",
          calls: [
            { id: nextCallId("call_r8"), name: "read", args: { path: "images/img-08.png" } },
            { id: nextCallId("call_r9"), name: "read", args: { path: "images/img-09-alpha.png" } },
            { id: nextCallId("call_r10"), name: "read", args: { path: "images/img-10-capture.bmp" } },
          ],
        });
      }
      wireAudit.turn4LiveImages = liveImageCount;
      return buildOpenAIResponse(model, stream, {
        kind: "tools",
        calls: [
          {
            id: nextCallId("call_fin_t4"),
            name: "finish_entire_request",
            args: { final_message_to_user: "Inspected opaque PNG, transparent RGBA PNG, and 24-bit BMP." },
          },
        ],
      });
    }

    if (turnTag === "T5_HISTORY_SEARCH") {
      if (assistantRoundsSincePrompt === 0) {
        return buildOpenAIResponse(model, stream, {
          kind: "tools",
          calls: [
            {
              id: nextCallId("call_hist_ocr"),
              name: "session_history",
              args: { action: "search", query: OCR_TOKEN, include_live_tail: true },
            },
          ],
        });
      }
      const lastToolMsg = [...messages].reverse().find((m) => m?.role === "tool");
      wireAudit.historySearchOutput = textOfMessage(lastToolMsg);
      return buildOpenAIResponse(model, stream, {
        kind: "tools",
        calls: [
          {
            id: nextCallId("call_fin_t5"),
            name: "finish_entire_request",
            args: { final_message_to_user: `Confirmed ${OCR_TOKEN} via session_history BM25 search.` },
          },
        ],
      });
    }

    if (turnTag === "T6_REACTIVE_CAP_2") {
      if (!wireAudit.shedCapInjected) {
        wireAudit.shedCapInjected = true;
        wireAudit.preShedCapLiveImages = liveImageCount;
        return new Response(
          '{"error":{"message":"Too many images: 4 \\u003e 2","type":"invalid_request_error"}}',
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      wireAudit.postShedCapLiveImages = liveImageCount;
      return buildOpenAIResponse(model, stream, {
        kind: "tools",
        calls: [
          {
            id: nextCallId("call_fin_t6"),
            name: "finish_entire_request",
            args: { final_message_to_user: "Recovered cleanly after reactive image-count cap shedding (<=2)." },
          },
        ],
      });
    }

    if (turnTag === "T7_REACTIVE_NO_VISION") {
      if (!wireAudit.shedNoVisionInjected) {
        wireAudit.shedNoVisionInjected = true;
        wireAudit.preNoVisionLiveImages = liveImageCount;
        return new Response(
          '{"error":{"message":"This model does not support image input","type":"invalid_request_error"}}',
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      wireAudit.postNoVisionLiveImages = liveImageCount;
      return buildOpenAIResponse(model, stream, {
        kind: "tools",
        calls: [
          {
            id: nextCallId("call_fin_t7"),
            name: "finish_entire_request",
            args: { final_message_to_user: "Recovered cleanly in text-only mode with 0 live wire images." },
          },
        ],
      });
    }

    return buildOpenAIResponse(model, stream, {
      kind: "tools",
      calls: [
        {
          id: nextCallId("call_fin_fallback"),
          name: "finish_entire_request",
          args: { final_message_to_user: "Completed turn." },
        },
      ],
    });
  },
});

const MOCK_UPSTREAM_URL = `http://127.0.0.1:${mockUpstream.port}/v1`;
const GW_PORT = Number(process.env.E2E_MULTI_IMAGE_GW_PORT || 4629);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-multi-image-pass-1";
const procs: Array<{ kill: () => void }> = [];
const tempDirs: string[] = [];

async function boot() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-multi-img-"));
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
        name: "mock-multi-img-provider",
        openaiBaseUrl: MOCK_UPSTREAM_URL,
        apiKey: "mock-key",
        openaiAuthStyle: "bearer",
      }),
    })
  ).json();
  assert(provRes.success, `provider create failed: ${JSON.stringify(provRes)}`);
  const list: any = await (
    await fetch(`${GW}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })
  ).json();
  const providerId = (list.providers || []).find((p: any) => p.name === "mock-multi-img-provider")?.id;
  assert(providerId, "mock-multi-img-provider id missing");

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

  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-multi-img-d-"));
  tempDirs.push(daemonDir);
  const workDir = path.join(daemonDir, "workspace");
  const imgDir = path.join(workDir, "images");
  mkdirSync(imgDir, { recursive: true });

  if (process.platform === "win32") {
    const cachedUnish = path.join(homedir(), ".indirect-code", "external", "bin", "unish.exe");
    if (existsSync(cachedUnish)) {
      const destUnish = path.join(daemonDir, "external", "bin", "unish.exe");
      mkdirSync(path.dirname(destUnish), { recursive: true });
      copyFileSync(cachedUnish, destUnish);
    }
  }

  // Generate 10 workspace images:
  //   - 8 opaque 2200x1400 high-res PNGs (large noisy/patterned PNG -> small JPEG)
  //   - 1 transparent 1800x1200 RGBA PNG (alpha preserved as PNG <=1568px)
  //   - 1 2200x1400 24-bit uncompressed BMP (~9.24 MB -> small JPEG <=1568px)
  log("fixtures", "generating 8 opaque 2200x1400 PNGs, 1 transparent RGBA PNG, and 1 2200x1400 BMP");
  for (let idx = 1; idx <= 8; idx++) {
    const name = `img-0${idx}.png`;
    const pngBytes = encodePatternedPng(2200, 1400, idx, false);
    assert(pngBytes.length > 500_000, `expected high-res noisy PNG >500KB, got ${pngBytes.length}`);
    writeFileSync(path.join(imgDir, name), pngBytes);
  }
  const alphaPngBytes = encodePatternedPng(1800, 1200, 9, true);
  writeFileSync(path.join(imgDir, "img-09-alpha.png"), alphaPngBytes);
  const bmpBytes = encodePatternedBmp24(2200, 1400, 10);
  assert(bmpBytes.length > 9_000_000, `expected 2200x1400 24-bit BMP >9MB, got ${bmpBytes.length}`);
  writeFileSync(path.join(imgDir, "img-10-capture.bmp"), bmpBytes);

  const daemonEnvPath =
    process.platform === "win32"
      ? `${path.join(homedir(), ".indirect-code", "external", "bin")};C:\\Program Files\\Git\\bin;${process.env.PATH || ""}`
      : process.env.PATH || "";

  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "Multi-Image E2E Host"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir, PATH: daemonEnvPath }, stdout: "ignore", stderr: "ignore" },
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
    const h: any = await (
      await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })
    ).json();
    const f = (h.hosts || []).find((x: any) => x.name === "Multi-Image E2E Host" && x.status === "online");
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
    await Bun.sleep(200);
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

async function assertSingleScrollAndBoundedLayout(unit: any, label: string) {
  const layout = await unit.locator("[data-tool-body]").first().evaluate((el: HTMLElement) => {
    const nestedScrollers: string[] = [];
    for (const child of el.querySelectorAll<HTMLElement>("*")) {
      const cs = getComputedStyle(child);
      if (
        cs.overflowY === "auto" ||
        cs.overflowY === "scroll" ||
        cs.overflowX === "auto" ||
        cs.overflowX === "scroll"
      ) {
        nestedScrollers.push(
          `${child.tagName.toLowerCase()}.${(child.className || "").toString().slice(0, 48)}(ox=${cs.overflowX},oy=${cs.overflowY})`,
        );
      }
    }
    return {
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      nestedScrollers,
    };
  });
  assert(
    layout.scrollWidth <= layout.clientWidth + 1,
    `${label}: [data-tool-body] horizontal blowout detected (scrollWidth=${layout.scrollWidth} > clientWidth=${layout.clientWidth})`,
  );
  assert.equal(
    layout.nestedScrollers.length,
    0,
    `${label}: [data-tool-body] must be the single scroll surface, found nested scrollers: ${JSON.stringify(layout.nestedScrollers)}`,
  );
}

try {
  const ctx = await boot();

  const created: any = await ctx.send({
    type: "create_session",
    cwd: ctx.workDir,
    title: "Multi-Image E2E Suite",
    model: MODEL,
    options: { mode: "agentic", access: "full", skills: [{ name: "build" }] },
  });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");

  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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

    // Wait past the 300ms SignalDB mirror debounce so initial pull sees "Multi-Image E2E Suite",
    // and explicitly select the session in the sidebar if not already active BEFORE Turn 1 starts!
    await Bun.sleep(500);
    await page.goto(`${GW}/#/code`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const sidebarEntry = page.locator('text="Multi-Image E2E Suite"').first();
    await sidebarEntry.waitFor({ state: "visible", timeout: 15000 });
    await sidebarEntry.click();
    await page.waitForTimeout(600);

    // --- 1. 10 Multi-Format High-Res Image Reads + Hysteresis + Vision-to-Text Digest + session_history ---
    log("turn-1", "reading 3 high-res opaque PNGs in parallel (img-01..03)");
    await runTurn(ctx, sessionId, "[TURN_TAG:T1_PARALLEL_3] Read images/img-01.png, img-02.png, and img-03.png.");
    assert.equal(wireAudit.turn1LiveImages, 3, `expected 3 live wire images after Turn 1, got ${wireAudit.turn1LiveImages}`);
    assert(wireAudit.parallelBatchContiguousVerified, "expected contiguous assistant -> tool -> tool -> tool -> user on parallel batch");

    log("turn-2", "reading 3 more high-res opaque PNGs (img-04..06 -> 6 live wire images)");
    await runTurn(ctx, sessionId, "[TURN_TAG:T2_BATCH_4_TO_6] Read images/img-04.png, img-05.png, and img-06.png.");
    assert.equal(wireAudit.turn2LiveImages, 6, `expected 6 live wire images after Turn 2, got ${wireAudit.turn2LiveImages}`);
    assert.equal(wireAudit.transcriberCalls, 0, "expected 0 transcriber calls while <= 6 live wire images");

    log("turn-3", "reading 7th image (img-07.png) -> triggers 6->3 hysteresis + Vision-to-Text digest");
    await runTurn(ctx, sessionId, "[TURN_TAG:T3_HYSTERESIS_7TH] Read images/img-07.png.");
    assert(
      wireAudit.transcriberCalls >= 4,
      `expected >=4 Vision-to-Text transcription calls on 7->3 eviction, got ${wireAudit.transcriberCalls}`,
    );
    assert.equal(
      wireAudit.turn3PostHysteresisLiveImages,
      3,
      `expected live wire images evicted to hysteresis target 3, got ${wireAudit.turn3PostHysteresisLiveImages}`,
    );
    assert(
      wireAudit.turn3VisualDigestInjected,
      `expected [Visual Digest — ...] containing ${OCR_TOKEN} on wire after hysteresis eviction`,
    );

    log("turn-4", "reading remaining 3 formats: opaque PNG (img-08), transparent PNG (img-09-alpha), BMP (img-10-capture)");
    await runTurn(ctx, sessionId, "[TURN_TAG:T4_MIXED_8_TO_10] Read img-08.png, img-09-alpha.png, and img-10-capture.bmp.");
    assert.equal(wireAudit.turn4LiveImages, 6, `expected 6 live wire images after Turn 4, got ${wireAudit.turn4LiveImages}`);
    assert(wireAudit.transparentPngPreservedCount >= 1, "expected transparent RGBA PNG preserved as image/png on wire");
    assert(wireAudit.opaqueJpegNormalizedCount >= 8, "expected opaque PNGs and BMP normalized to image/jpeg on wire");

    log("turn-5", `searching session_history for digested visual token ${OCR_TOKEN}`);
    await runTurn(ctx, sessionId, `[TURN_TAG:T5_HISTORY_SEARCH] Search session_history for ${OCR_TOKEN}.`);
    assert(
      wireAudit.historySearchOutput.includes("Found") && wireAudit.historySearchOutput.includes(OCR_TOKEN),
      `expected session_history search to return digested visual hit for ${OCR_TOKEN}, got: ${wireAudit.historySearchOutput}`,
    );

    // --- 2. Reactive Upstream Provider Error Shedding (Zero Session Bricking) ---
    log("turn-6", 'injecting HTTP 400 "Too many images: 4 \\u003e 2" -> verifying in-turn shedding to <=2');
    await runTurn(ctx, sessionId, "[TURN_TAG:T6_REACTIVE_CAP_2] Continue audit under provider 2-image cap.");
    assert(wireAudit.shedCapInjected, "expected Turn 6 400 cap error injection");
    assert(wireAudit.preShedCapLiveImages >= 4, `expected >=4 live wire images before cap shed, got ${wireAudit.preShedCapLiveImages}`);
    assert(
      wireAudit.postShedCapLiveImages >= 1 && wireAudit.postShedCapLiveImages <= 2,
      `expected retry within Turn 6 with <=2 live wire images, got ${wireAudit.postShedCapLiveImages}`,
    );

    log("turn-7", 'injecting HTTP 400 "This model does not support image input" -> verifying 0-image retry');
    await runTurn(ctx, sessionId, "[TURN_TAG:T7_REACTIVE_NO_VISION] Continue audit under text-only model.");
    assert(wireAudit.shedNoVisionInjected, "expected Turn 7 400 vision-unsupported injection");
    assert(wireAudit.preNoVisionLiveImages >= 1, `expected >=1 live wire image before text-only shed, got ${wireAudit.preNoVisionLiveImages}`);
    assert.equal(
      wireAudit.postNoVisionLiveImages,
      0,
      `expected retry within Turn 7 with 0 image_url parts, got ${wireAudit.postNoVisionLiveImages}`,
    );

    // Assert zero wire invariant violations across ALL OpenAI requests
    assert.deepEqual(
      wireAudit.wireViolations,
      [],
      `OpenAI wire invariant violations:\n${wireAudit.wireViolations.join("\n")}`,
    );

    // Run /compact so CompactionBalloon visual digest chip is also verified in live Chromium UI!
    log("compact", "running /compact to verify CompactionBalloon visual digest count chip");
    ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
    const afterCompact = await waitForCompactionCount(ctx, sessionId, 1);
    assert(
      (afterCompact?.session?.compaction?.imageDigestCount ?? 0) >= 10,
      `expected lightweight imageDigestCount >= 10 on WS compaction payload, got ${JSON.stringify(afterCompact?.session?.compaction)}`,
    );
    assert.equal(
      afterCompact?.session?.compaction?.imageDigests,
      undefined,
      "WS compaction snapshot must omit raw imageDigests text map",
    );

    await page.waitForSelector('button:has-text("Context Compacted")', { timeout: 20000 });
    await page.waitForTimeout(600);

    // --- 3A. Real Chromium Desktop UI Inspection (Pre-Reload, 1280x800) ---
    log("ui-pre-reload", "inspecting live ImageReadCard (thumbnail, PNG->JPEG, dimensions, savings) at 1280x800");
    await loadAllOlderTurns(page);
    await expandAllTurnDisclosures(page);

    const visualDigestChip = page.locator("[data-compaction-visual-digests]").first();
    assert(await visualDigestChip.isVisible(), "expected [data-compaction-visual-digests] chip on CompactionBalloon");
    const chipText = ((await visualDigestChip.textContent()) || "").trim();
    const chipTip = (await visualDigestChip.getAttribute("data-rc-tip")) || "";
    assert(
      chipText === "10 visual digests cached" && chipTip.includes("text-only"),
      `unexpected CompactionBalloon visual digest chip: text="${chipText}", tip="${chipTip}"`,
    );

    const preRow = await ensureToolRowExpanded(page, "img-01.png");
    const preHeaderText = ((await preRow.header.textContent()) || "").trim();
    assert(
      preHeaderText.includes("Analyzed") && preHeaderText.includes("img-01.png"),
      `expected header summary "Analyzed img-01.png", got "${preHeaderText}"`,
    );
    assert(!/#L\d+/.test(preHeaderText), `image read header must NOT include #L1- suffix: "${preHeaderText}"`);

    const preCard = preRow.unit.locator("[data-tool-image-read]").first();
    assert(await preCard.isVisible(), "pre-reload: [data-tool-image-read] must be visible");
    assert.equal(
      await preCard.locator(".code-block, .rc-code").count(),
      0,
      "pre-reload: [data-tool-image-read] must contain zero .code-block / .rc-code elements",
    );

    const preCardText = ((await preCard.textContent()) || "").trim();
    assert(preCardText.includes("PNG → JPEG"), `pre-reload: expected "PNG → JPEG" in "${preCardText}"`);
    assert(
      /2200×1400\s*→\s*1568×\d+\s*px/.test(preCardText),
      `pre-reload: expected resized dimensions "2200×1400 → 1568×... px" in "${preCardText}"`,
    );
    const preSavings = ((await preCard.locator("[data-image-savings-badge]").textContent()) || "").trim();
    assert(/^-\d+%$/.test(preSavings), `pre-reload: expected "-...%" byte savings badge, got "${preSavings}"`);

    const liveImg = preCard.locator("[data-image-preview] img").first();
    assert(await liveImg.isVisible(), "pre-reload: expected live <img src='data:image/...'> thumbnail");
    const liveImgMetrics = await liveImg.evaluate((el: HTMLImageElement) => ({
      srcPrefix: (el.getAttribute("src") || "").slice(0, 22),
      complete: el.complete,
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
    }));
    assert(
      liveImgMetrics.srcPrefix.startsWith("data:image/") && liveImgMetrics.complete && liveImgMetrics.naturalWidth > 0,
      `pre-reload: live thumbnail failed to decode: ${JSON.stringify(liveImgMetrics)}`,
    );

    await assertSingleScrollAndBoundedLayout(preRow.unit, "pre-reload:img-01.png");
    await assertNoHorizontalOverflow(page, "pre-reload-desktop-1280x800");
    assertNoPageErrors(pageErrors, consoleErrors, "pre-reload-desktop");

    // --- 3B. Full Browser Reload Durability (`await page.reload()`) ---
    log("ui-reload", "executing page.reload() to verify WAL hydration ([data-image-icon-tile] + preserved stats + 0 broken <img>)");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('button:has-text("Context Compacted")', { timeout: 20000 });
    await page.waitForTimeout(800);

    await loadAllOlderTurns(page);
    await expandAllTurnDisclosures(page);

    const postRow = await ensureToolRowExpanded(page, "img-01.png");
    const postHeaderText = ((await postRow.header.textContent()) || "").trim();
    assert(
      postHeaderText.includes("Analyzed") && postHeaderText.includes("img-01.png") && !/#L\d+/.test(postHeaderText),
      `post-reload: header summary mismatch: "${postHeaderText}"`,
    );

    const postCard = postRow.unit.locator("[data-tool-image-read]").first();
    assert(await postCard.isVisible(), "post-reload: [data-tool-image-read] must be visible");
    assert(
      await postCard.locator("[data-image-icon-tile]").first().isVisible(),
      "post-reload: [data-image-icon-tile] must render after WAL reload",
    );
    assert.equal(
      await postCard.locator(".code-block, .rc-code").count(),
      0,
      "post-reload: [data-tool-image-read] must contain zero .code-block / .rc-code elements",
    );

    const postCardText = ((await postCard.textContent()) || "").trim();
    assert(postCardText.includes("PNG → JPEG"), `post-reload: expected "PNG → JPEG" preserved in "${postCardText}"`);
    assert(
      /2200×1400\s*→\s*1568×\d+\s*px/.test(postCardText),
      `post-reload: expected "2200×1400 → 1568×... px" preserved in "${postCardText}"`,
    );
    const postSavings = ((await postCard.locator("[data-image-savings-badge]").textContent()) || "").trim();
    assert.equal(postSavings, preSavings, "post-reload: byte savings badge must match pre-reload");

    const brokenImages = await page.evaluate(() => {
      const broken: string[] = [];
      for (const img of document.querySelectorAll<HTMLImageElement>("img")) {
        if (!img.complete || img.naturalWidth === 0) {
          broken.push(img.getAttribute("src")?.slice(0, 60) || "<empty-src>");
        }
      }
      return broken;
    });
    assert.deepEqual(brokenImages, [], `post-reload: found broken <img> elements: ${JSON.stringify(brokenImages)}`);

    await assertSingleScrollAndBoundedLayout(postRow.unit, "post-reload:img-01.png");
    await assertNoHorizontalOverflow(page, "post-reload-desktop-1280x800");
    assertNoPageErrors(pageErrors, consoleErrors, "post-reload-desktop");

    await context.close();

    // --- 3C. Mobile 390x844 Viewport Verification (touch mobile context matching index.html html.mobile) ---
    log("ui-mobile", "verifying 390x844 mobile viewport layout, scrollWidth <= 390, and zero nested scrollbars");
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
    mobilePage.on("pageerror", (e: Error) => mobilePageErrors.push(String(e).slice(0, 300)));
    mobilePage.on("console", (m: any) => {
      if (m.type() === "error") mobileConsoleErrors.push(String(m.text()).slice(0, 300));
    });
    await mobilePage.addInitScript(
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
    await mobilePage.goto(`${GW}/#/code`, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector('button:has-text("Context Compacted")', { timeout: 20000 });
    await mobilePage.waitForTimeout(600);

    await loadAllOlderTurns(mobilePage);
    await expandAllTurnDisclosures(mobilePage);

    const mobileRow = await ensureToolRowExpanded(mobilePage, "img-01.png");
    assert(
      await mobileRow.unit.locator("[data-tool-image-read]").first().isVisible(),
      "mobile: ImageReadCard must remain visible",
    );
    await assertSingleScrollAndBoundedLayout(mobileRow.unit, "mobile-390x844:img-01.png");

    const mobileSearchRow = await ensureToolRowExpanded(mobilePage, "Searched history");
    await assertSingleScrollAndBoundedLayout(mobileSearchRow.unit, "mobile-390x844:session_history");

    await assertNoHorizontalOverflow(mobilePage, "mobile-390x844", 390);
    assertNoPageErrors(mobilePageErrors, mobileConsoleErrors, "mobile-390x844");

    await mobileContext.close();
  } finally {
    await browser.close();
  }

  console.log("\n=== RESULT ===\nPASS: indirect multi-image hysteresis, reactive shedding, and Chromium WAL UI suite complete");
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
