import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApiError } from "../server/http";
import { serveStatic } from "../server/static";
import {
  createVoiceModelManager,
  ensureVoiceModelFile,
  getVoiceModelState,
  startVoiceModelBootstrap,
} from "../server/voice-model";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "indirect-voice-model-"));
  tempDirs.push(dir);
  return dir;
}

const silentLogger = {
  log: () => {},
  warn: () => {},
};

const VALID_TOKEN = "valid-session-token";
async function mockAuth(req: Request): Promise<{ user: { id: string } }> {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${VALID_TOKEN}`) {
    throw new ApiError(401, "missing bearer token");
  }
  return { user: { id: "u_test" } };
}

function authedReq(urlPath: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${VALID_TOKEN}`);
  return new Request(`http://127.0.0.1:3000${urlPath}`, { ...init, headers });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("Self-hosted voice model route & downloader", () => {
  test("enforces dashboard session auth (401 without valid bearer token)", async () => {
    const dir = makeTempDir();
    const mgr = createVoiceModelManager({
      dataDir: dir,
      authFn: mockAuth,
      skipBootstrap: true,
      logger: silentLogger,
    });

    const unauth = new Request("http://127.0.0.1:3000/api/indirect-code/voice/model/vocab.txt");
    const res = await mgr.handleRoute("/api/indirect-code/voice/model/vocab.txt", unauth);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("missing bearer token");

    const badToken = new Request("http://127.0.0.1:3000/api/indirect-code/voice/model/vocab.txt", {
      headers: { Authorization: "Bearer wrong" },
    });
    const res2 = await mgr.handleRoute("/api/indirect-code/voice/model/vocab.txt", badToken);
    expect(res2!.status).toBe(401);
  });

  test("rejects unknown filenames and path traversal attempts with 404", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "secret.txt"), "top-secret");
    const mgr = createVoiceModelManager({
      dataDir: dir,
      authFn: mockAuth,
      skipBootstrap: true,
      logger: silentLogger,
    });

    const badPaths = [
      "/api/indirect-code/voice/model/",
      "/api/indirect-code/voice/model/unknown.onnx",
      "/api/indirect-code/voice/model/../secret.txt",
      "/api/indirect-code/voice/model/..%2f..%2fsecret.txt",
      "/api/indirect-code/voice/model/w2a8/encoder-model.w2a8.onnx",
      "/api/indirect-code/voice/model/vocab.txt/extra",
      "/api/indirect-code/voice/model/vocab.txt%00",
    ];

    for (const p of badPaths) {
      const res = await mgr.handleRoute(p, authedReq(p));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(404);
      const body = (await res!.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    }

    // Non-matching path or non-GET/HEAD method returns null so router falls through.
    const unrelated = await mgr.handleRoute("/api/indirect-code/hosts", authedReq("/api/indirect-code/hosts"));
    expect(unrelated).toBeNull();
    const postReq = authedReq("/api/indirect-code/voice/model/vocab.txt", { method: "POST" });
    expect(await mgr.handleRoute("/api/indirect-code/voice/model/vocab.txt", postReq)).toBeNull();
  });

  test("returns 503 with Retry-After while downloading, deduplicates single-flight, and streams 200/HEAD/304/206 once ready", async () => {
    const dir = makeTempDir();
    const chunk1 = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const chunk2 = new Uint8Array([7, 8, 9, 10]);
    const totalLen = chunk1.byteLength + chunk2.byteLength;

    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    let firstChunkWritten!: () => void;
    const firstChunkReady = new Promise<void>((resolve) => {
      firstChunkWritten = resolve;
    });

    let fetchCalls = 0;
    const mockFetch = (async () => {
      fetchCalls++;
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          ctrl.enqueue(chunk1);
          firstChunkWritten();
          await secondChunkGate;
          ctrl.enqueue(chunk2);
          ctrl.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Length": String(totalLen) },
      });
    }) as unknown as typeof fetch;

    const mgr = createVoiceModelManager({
      dataDir: dir,
      fetchFn: mockFetch,
      authFn: mockAuth,
      retryDelaysMs: [10],
      skipBootstrap: true,
      logger: silentLogger,
    });

    const routePath = "/api/indirect-code/voice/model/encoder-model.w2a8.onnx";

    // First request triggers background download and returns 503 with Retry-After.
    const r1 = await mgr.handleRoute(routePath, authedReq(routePath));
    expect(r1!.status).toBe(503);
    expect(r1!.headers.get("Retry-After")).toBe("2");
    expect(r1!.headers.get("Cache-Control")).toBe("no-store");
    const j1 = (await r1!.json()) as {
      success: boolean;
      error: string;
      downloading: boolean;
      progress: { loaded: number; total: number };
    };
    expect(j1.success).toBe(false);
    expect(j1.downloading).toBe(true);
    expect(j1.error).toBe("Voice model is still downloading on the server");

    // Wait for first chunk to be streamed to temp file.
    await firstChunkReady;
    await Bun.sleep(20);

    // Final file must NOT exist yet (atomic rename only happens on completion).
    expect(existsSync(path.join(mgr.modelDir, "encoder-model.w2a8.onnx"))).toBe(false);
    const tmpFilesDuring = readdirSync(mgr.modelDir).filter((f) => f.includes(".tmp."));
    expect(tmpFilesDuring.length).toBe(1);

    // Concurrent HTTP request and direct ensureFile must dedupe to the single in-flight fetch.
    const [r2, ensurePromise] = [
      await mgr.handleRoute(routePath, authedReq(routePath)),
      mgr.ensureFile("encoder"),
    ];
    expect(r2!.status).toBe(503);
    const j2 = (await r2!.json()) as { downloading: boolean; progress: { loaded: number; total: number } };
    expect(j2.downloading).toBe(true);
    expect(j2.progress.loaded).toBe(chunk1.byteLength);
    expect(j2.progress.total).toBe(totalLen);
    expect(fetchCalls).toBe(1);

    // Release remainder of stream and await completion.
    releaseSecondChunk();
    const finalPath = await ensurePromise;
    expect(finalPath).toBe(path.join(mgr.modelDir, "encoder-model.w2a8.onnx"));
    expect(fetchCalls).toBe(1);

    // No temp files remain after atomic rename.
    const leftoverTmps = readdirSync(mgr.modelDir).filter((f) => f.includes(".tmp."));
    expect(leftoverTmps.length).toBe(0);

    // GET now returns 200 streaming exact bytes + caching headers.
    const r3 = await mgr.handleRoute(routePath, authedReq(routePath));
    expect(r3!.status).toBe(200);
    expect(r3!.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(r3!.headers.get("Content-Length")).toBe(String(totalLen));
    expect(r3!.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(r3!.headers.get("Accept-Ranges")).toBe("bytes");
    const etag = r3!.headers.get("ETag");
    expect(etag).toBeTruthy();
    const bytes = new Uint8Array(await r3!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // HEAD returns 200 with Content-Length and empty body.
    const rHead = await mgr.handleRoute(routePath, authedReq(routePath, { method: "HEAD" }));
    expect(rHead!.status).toBe(200);
    expect(rHead!.headers.get("Content-Length")).toBe(String(totalLen));
    expect(rHead!.headers.get("ETag")).toBe(etag);
    expect((await rHead!.arrayBuffer()).byteLength).toBe(0);

    // Conditional If-None-Match returns 304 Not Modified.
    const r304 = await mgr.handleRoute(
      routePath,
      authedReq(routePath, { headers: { "If-None-Match": etag! } }),
    );
    expect(r304!.status).toBe(304);
    expect(r304!.headers.get("ETag")).toBe(etag);

    // Range request returns 206 Partial Content.
    const r206 = await mgr.handleRoute(
      routePath,
      authedReq(routePath, { headers: { Range: "bytes=2-5" } }),
    );
    expect(r206!.status).toBe(206);
    expect(r206!.headers.get("Content-Range")).toBe(`bytes 2-5/${totalLen}`);
    expect(r206!.headers.get("Content-Length")).toBe("4");
    expect(Array.from(new Uint8Array(await r206!.arrayBuffer()))).toEqual([3, 4, 5, 6]);

    // Out-of-bounds range returns 416.
    const r416 = await mgr.handleRoute(
      routePath,
      authedReq(routePath, { headers: { Range: "bytes=999-1000" } }),
    );
    expect(r416!.status).toBe(416);
    expect(r416!.headers.get("Content-Range")).toBe(`bytes */${totalLen}`);
  });

  test("cleans up temp files on truncated stream and retries cleanly until ready", async () => {
    const dir = makeTempDir();
    let attempts = 0;
    const mockFetch = (async () => {
      attempts++;
      if (attempts === 1) {
        // Advertise 10 bytes, only send 3 -> must fail integrity check & unlink temp file.
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Length": "10" },
        });
      }
      return new Response("hello vocab\n", {
        status: 200,
        headers: { "Content-Length": "12" },
      });
    }) as unknown as typeof fetch;

    const mgr = createVoiceModelManager({
      dataDir: dir,
      fetchFn: mockFetch,
      authFn: mockAuth,
      retryDelaysMs: [5],
      skipBootstrap: true,
      logger: silentLogger,
    });

    const p = await mgr.ensureFile("vocab");
    expect(attempts).toBe(2);
    expect(existsSync(p)).toBe(true);
    expect(readdirSync(mgr.modelDir).filter((f) => f.includes(".tmp.")).length).toBe(0);

    const res = await mgr.handleRoute(
      "/api/indirect-code/voice/model/vocab.txt",
      authedReq("/api/indirect-code/voice/model/vocab.txt"),
    );
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res!.text()).toBe("hello vocab\n");
  });

  test("startBootstrap downloads all 3 files idempotently and skips network when skipBootstrap is true", async () => {
    const dir = makeTempDir();
    const fetchedUrls: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchedUrls.push(url);
      const payload = `mock-body:${url}`;
      return new Response(payload, {
        status: 200,
        headers: { "Content-Length": String(payload.length) },
      });
    }) as unknown as typeof fetch;

    const mgr = createVoiceModelManager({
      dataDir: dir,
      fetchFn: mockFetch,
      authFn: mockAuth,
      retryDelaysMs: [5],
      skipBootstrap: false,
      logger: silentLogger,
    });

    const [b1, b2] = await Promise.all([mgr.startBootstrap(), mgr.startBootstrap()]);
    expect(b1.skipped).toBe(false);
    expect(b1.readyCount).toBe(3);
    expect(b1.totalCount).toBe(3);
    expect(b2).toEqual(b1);
    expect(fetchedUrls.length).toBe(3);

    const state = mgr.getState();
    expect(state.ready).toBe(true);
    expect(state.files.encoder.status).toBe("ready");
    expect(state.files.decoder.status).toBe("ready");
    expect(state.files.vocab.status).toBe("ready");

    // Default process-level helpers skip network in test mode.
    const prevSkip = process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD;
    process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD = "1";
    try {
      const boot = await startVoiceModelBootstrap();
      expect(boot.skipped).toBe(true);
      const defaultState = getVoiceModelState();
      expect(defaultState.files.encoder.filename).toBe("encoder-model.w2a8.onnx");
      expect(typeof ensureVoiceModelFile).toBe("function");
    } finally {
      if (prevSkip === undefined) delete process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD;
      else process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD = prevSkip;
    }
  });

  test("surfaces downloading: false on 503 after permanent upstream failure and retries after cooldown", async () => {
    const dir = makeTempDir();
    let calls = 0;
    const mockFetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response("not found", { status: 404 });
      }
      return new Response("recovered-decoder", {
        status: 200,
        headers: { "Content-Length": "17" },
      });
    }) as unknown as typeof fetch;

    const mgr = createVoiceModelManager({
      dataDir: dir,
      fetchFn: mockFetch,
      authFn: mockAuth,
      retryDelaysMs: [],
      errorCooldownMs: 30,
      skipBootstrap: true,
      logger: silentLogger,
    });

    const routePath = "/api/indirect-code/voice/model/decoder_joint-model.int8.onnx";

    // Direct ensure rejects immediately on non-retryable 404 and records error state.
    await expect(mgr.ensureFile("decoder")).rejects.toThrow("HTTP 404");
    expect(calls).toBe(1);

    // Within cooldown, route returns 503 with downloading: false so clients don't spin forever.
    const rErr = await mgr.handleRoute(routePath, authedReq(routePath));
    expect(rErr!.status).toBe(503);
    const jErr = (await rErr!.json()) as { success: boolean; downloading: boolean; error: string };
    expect(jErr.success).toBe(false);
    expect(jErr.downloading).toBe(false);
    expect(jErr.error).toContain("HTTP 404");

    // After cooldown expires, a new request triggers a fresh download and succeeds.
    await Bun.sleep(45);
    const rRetry = await mgr.handleRoute(routePath, authedReq(routePath));
    expect(rRetry!.status).toBe(503);
    await mgr.ensureFile("decoder");
    expect(calls).toBe(2);

    const rOk = await mgr.handleRoute(routePath, authedReq(routePath));
    expect(rOk!.status).toBe(200);
    expect(await rOk!.text()).toBe("recovered-decoder");
  });

  test("static server serves /workers/* with no-cache + weak ETag (never immutable)", () => {
    const staticRoot = makeTempDir();
    mkdirSync(path.join(staticRoot, "workers"), { recursive: true });
    mkdirSync(path.join(staticRoot, "vendor", "ort"), { recursive: true });
    writeFileSync(path.join(staticRoot, "workers", "voice-worker.js"), "self.postMessage({ type: 'worker_ready' });\n");
    writeFileSync(path.join(staticRoot, "vendor", "ort", "ort-wasm-simd-threaded.wasm"), new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));

    const req = new Request("http://127.0.0.1:3000/workers/voice-worker.js");
    const res = serveStatic(req, "/workers/voice-worker.js", staticRoot);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(res!.headers.get("Cache-Control")).toBe("no-cache");
    const etag = res!.headers.get("ETag");
    expect(etag).toBeTruthy();

    const res304 = serveStatic(
      new Request("http://127.0.0.1:3000/workers/voice-worker.js", {
        headers: { "If-None-Match": etag! },
      }),
      "/workers/voice-worker.js",
      staticRoot,
    );
    expect(res304!.status).toBe(304);

    const wasmRes = serveStatic(
      new Request("http://127.0.0.1:3000/vendor/ort/ort-wasm-simd-threaded.wasm"),
      "/vendor/ort/ort-wasm-simd-threaded.wasm",
      staticRoot,
    );
    expect(wasmRes).not.toBeNull();
    expect(wasmRes!.status).toBe(200);
    expect(wasmRes!.headers.get("Content-Type")).toBe("application/wasm");
  });
});
