/**
 * Self-hosted Parakeet v3 voice model management & authenticated serving.
 *
 * The gateway downloads the 3 ONNX/vocab files from HuggingFace into
 * `<DATA_DIR>/voice-models/parakeet-tdt-0.6b-v3/` (mirroring obscura's boot
 * auto-download pattern) so the browser always fetches weights same-origin
 * from `/api/indirect-code/voice/model/:file` with zero HuggingFace runtime
 * dependency in the client CSP or network path.
 *
 * Guarantees:
 *  - Streaming writes straight to disk (never buffers ~190 MB in RAM).
 *  - Atomic `<file>.tmp.<pid>.<rand>` -> `rename` (never serves partial files).
 *  - Per-file single-flight deduplication across boot & concurrent requests.
 *  - Non-blocking boot; skipped automatically in test environments or when
 *    `INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD=1`.
 *  - Authenticated dashboard session (`requireAuth`) + strict filename allowlist.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { requireAuth } from "./auth";
import { DATA_DIR } from "./config";
import { ApiError, baseHeaders, err } from "./http";

export type VoiceModelKey = "encoder" | "decoder" | "vocab";

export interface VoiceModelFileState {
  key: VoiceModelKey;
  filename: string;
  status: "missing" | "downloading" | "ready" | "error";
  loaded: number;
  total: number;
  error: string | null;
}

export interface VoiceModelState {
  dir: string;
  ready: boolean;
  files: Record<VoiceModelKey, VoiceModelFileState>;
}

export interface VoiceModelBootstrapResult {
  dir: string;
  skipped: boolean;
  readyCount: number;
  totalCount: number;
}

export interface VoiceModelManagerOptions {
  dataDir?: string;
  fetchFn?: typeof fetch;
  authFn?: (req: Request) => Promise<unknown>;
  retryDelaysMs?: number[];
  errorCooldownMs?: number;
  skipBootstrap?: boolean;
  localDirs?: string[];
  logger?: Pick<Console, "log" | "warn">;
}

interface VoiceModelSpec {
  key: VoiceModelKey;
  filename: string;
  url: string;
  contentType: string;
  estimatedBytes: number;
}

const VOICE_MODEL_SUBDIR = path.join("voice-models", "parakeet-tdt-0.6b-v3");
const ROUTE_PREFIX = "/api/indirect-code/voice/model/";
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000];
const DEFAULT_ERROR_COOLDOWN_MS = 15_000;

const VOICE_MODEL_SPECS: readonly VoiceModelSpec[] = [
  {
    key: "encoder",
    filename: "encoder-model.w2a8.onnx",
    url: "https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-redux-onnx/resolve/main/w2a8/encoder-model.w2a8.onnx",
    contentType: "application/octet-stream",
    estimatedBytes: 189_890_000,
  },
  {
    key: "decoder",
    filename: "decoder_joint-model.int8.onnx",
    url: "https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-redux-onnx/resolve/main/int8/decoder_joint-model.int8.onnx",
    contentType: "application/octet-stream",
    estimatedBytes: 18_200_000,
  },
  {
    key: "vocab",
    filename: "vocab.txt",
    url: "https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-redux-onnx/resolve/main/vocab.txt",
    contentType: "text/plain; charset=utf-8",
    estimatedBytes: 94_000,
  },
];

// Download smallest files first during boot bootstrap so quick assets settle immediately.
const BOOTSTRAP_ORDER: readonly VoiceModelKey[] = ["vocab", "decoder", "encoder"];

const SPEC_BY_KEY = new Map<VoiceModelKey, VoiceModelSpec>(
  VOICE_MODEL_SPECS.map((s) => [s.key, s]),
);
const SPEC_BY_FILENAME = new Map<string, VoiceModelSpec>(
  VOICE_MODEL_SPECS.map((s) => [s.filename, s]),
);

class DownloadError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

function isTestDataDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  const repoTestDir = path.resolve(import.meta.dir, "..", "data", "test");
  if (resolved === repoTestDir || resolved.startsWith(repoTestDir + path.sep)) return true;
  const parts = resolved.split(path.sep).filter(Boolean);
  return parts.length >= 2 && parts[parts.length - 2] === "data" && parts[parts.length - 1] === "test";
}

function shouldSkipBootstrap(dataDir: string, explicitSkip?: boolean): boolean {
  if (explicitSkip !== undefined) return explicitSkip;
  const envSkip = process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD?.trim().toLowerCase();
  if (envSkip === "1" || envSkip === "true") return true;
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") return true;
  return isTestDataDir(dataDir);
}

function fileEtag(stats: { size: number; mtimeMs: number }): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

function etagMatches(ifNoneMatch: string | null, currentEtag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalize = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = normalize(currentEtag);
  for (const part of ifNoneMatch.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*" || normalize(trimmed) === target) return true;
  }
  return false;
}

function parseSingleByteRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1]!;
  const endRaw = match[2]!;
  if (startRaw === "" && endRaw === "") return "invalid";
  let start: number;
  let end: number;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    return "invalid";
  }
  return { start, end };
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validLocalFile(filePath: string): { path: string; size: number; mtimeMs: number } | null {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (!st.isFile() || st.size <= 0) return null;
    return { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export function createVoiceModelManager(options: VoiceModelManagerOptions = {}) {
  const dataDir = options.dataDir ?? DATA_DIR;
  const modelDir = path.join(dataDir, VOICE_MODEL_SUBDIR);
  const fetchFn = options.fetchFn ?? fetch;
  const authFn = options.authFn ?? requireAuth;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const errorCooldownMs = options.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS;
  const logger = options.logger ?? console;
  const localDirs = options.localDirs ?? [];

  const inFlight = new Map<VoiceModelKey, Promise<string>>();
  const activeTmpFiles = new Set<string>();
  const lastErrorAt = new Map<VoiceModelKey, number>();
  const controller = new AbortController();
  let bootstrapPromise: Promise<VoiceModelBootstrapResult> | null = null;
  let cleanedStaleTmps = false;

  const states = new Map<VoiceModelKey, VoiceModelFileState>();
  for (const spec of VOICE_MODEL_SPECS) {
    states.set(spec.key, {
      key: spec.key,
      filename: spec.filename,
      status: "missing",
      loaded: 0,
      total: spec.estimatedBytes,
      error: null,
    });
  }

  function resolveExistingFile(spec: VoiceModelSpec): { path: string; size: number; mtimeMs: number } | null {
    for (const dir of localDirs) {
      const hit = validLocalFile(path.join(dir, spec.filename));
      if (hit) return hit;
    }
    return validLocalFile(path.join(modelDir, spec.filename));
  }

  function refreshReadyState(spec: VoiceModelSpec): { path: string; size: number; mtimeMs: number } | null {
    const existing = resolveExistingFile(spec);
    if (existing) {
      const st = states.get(spec.key)!;
      st.status = "ready";
      st.loaded = existing.size;
      st.total = existing.size;
      st.error = null;
    }
    return existing;
  }

  function cleanStaleTempFiles(): void {
    if (cleanedStaleTmps) return;
    cleanedStaleTmps = true;
    if (!existsSync(modelDir)) return;
    try {
      for (const entry of readdirSync(modelDir)) {
        if (!entry.includes(".tmp.")) continue;
        const full = path.join(modelDir, entry);
        if (activeTmpFiles.has(full)) continue;
        try {
          rmSync(full, { force: true });
        } catch {}
      }
    } catch {}
  }

  async function downloadOnce(spec: VoiceModelSpec): Promise<string> {
    mkdirSync(modelDir, { recursive: true });
    const finalPath = path.join(modelDir, spec.filename);
    const tmpPath = path.join(modelDir, `${spec.filename}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`);
    const st = states.get(spec.key)!;

    activeTmpFiles.add(tmpPath);
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    let closed = false;
    try {
      const res = await fetchFn(spec.url, { redirect: "follow", signal: controller.signal });
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
        throw new DownloadError(`HTTP ${res.status}`, retryable);
      }

      const contentEncoding = res.headers.get("content-encoding");
      const rawLength = res.headers.get("content-length");
      const expectedLength =
        !contentEncoding && rawLength && /^\d+$/.test(rawLength.trim())
          ? Number(rawLength.trim())
          : 0;

      st.loaded = 0;
      st.total = expectedLength > 0 ? expectedLength : spec.estimatedBytes;

      fh = await open(tmpPath, "w");
      let loaded = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            await fh.write(value);
            loaded += value.byteLength;
            st.loaded = loaded;
            if (loaded > st.total) st.total = loaded;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      } else {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > 0) {
          await fh.write(bytes);
          loaded = bytes.byteLength;
          st.loaded = loaded;
          if (loaded > st.total) st.total = loaded;
        }
      }

      await fh.close();
      closed = true;

      if (loaded <= 0) {
        throw new DownloadError("empty response body", true);
      }
      if (expectedLength > 0 && loaded !== expectedLength) {
        throw new DownloadError(`truncated stream (${loaded}/${expectedLength} bytes)`, true);
      }

      renameSync(tmpPath, finalPath);
      activeTmpFiles.delete(tmpPath);

      const finalStat = statSync(finalPath);
      st.status = "ready";
      st.loaded = finalStat.size;
      st.total = finalStat.size;
      st.error = null;
      lastErrorAt.delete(spec.key);
      logger.log(
        `[voice-model] ready: ${spec.filename} (${(finalStat.size / 1_000_000).toFixed(2)} MB)`,
      );
      return finalPath;
    } catch (e) {
      if (fh && !closed) {
        try {
          await fh.close();
        } catch {}
      }
      try {
        rmSync(tmpPath, { force: true });
      } catch {}
      activeTmpFiles.delete(tmpPath);
      throw e;
    }
  }

  async function downloadWithRetry(spec: VoiceModelSpec): Promise<string> {
    const st = states.get(spec.key)!;
    const totalAttempts = retryDelaysMs.length + 1;
    let lastErr: unknown;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        if (attempt === 0) {
          logger.log(`[voice-model] downloading ${spec.filename} -> ${modelDir}`);
        }
        return await downloadOnce(spec);
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = e instanceof DownloadError ? e.retryable : !controller.signal.aborted;
        if (!retryable || attempt >= totalAttempts - 1 || controller.signal.aborted) {
          st.status = "error";
          st.loaded = 0;
          st.error = msg;
          lastErrorAt.set(spec.key, Date.now());
          logger.warn(`[voice-model] download failed for ${spec.filename}: ${msg}`);
          throw e;
        }
        const delayMs = retryDelaysMs[attempt] ?? 1_000;
        logger.warn(
          `[voice-model] retrying ${spec.filename} in ${delayMs}ms (attempt ${attempt + 1}/${totalAttempts}): ${msg}`,
        );
        await sleepAbortable(delayMs, controller.signal);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  function ensureFile(key: VoiceModelKey): Promise<string> {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) return Promise.reject(new Error(`unknown voice model key: ${key}`));

    cleanStaleTempFiles();
    const existing = refreshReadyState(spec);
    if (existing) return Promise.resolve(existing.path);

    const active = inFlight.get(key);
    if (active) return active;

    const st = states.get(key)!;
    st.status = "downloading";
    st.loaded = 0;
    st.total = spec.estimatedBytes;
    st.error = null;

    const promise = downloadWithRetry(spec).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  function startBootstrap(): Promise<VoiceModelBootstrapResult> {
    if (bootstrapPromise) return bootstrapPromise;

    if (shouldSkipBootstrap(dataDir, options.skipBootstrap)) {
      let readyCount = 0;
      for (const spec of VOICE_MODEL_SPECS) {
        if (refreshReadyState(spec)) readyCount++;
      }
      bootstrapPromise = Promise.resolve({
        dir: modelDir,
        skipped: true,
        readyCount,
        totalCount: VOICE_MODEL_SPECS.length,
      });
      return bootstrapPromise;
    }

    bootstrapPromise = (async () => {
      cleanStaleTempFiles();
      let readyCount = 0;
      for (const key of BOOTSTRAP_ORDER) {
        try {
          await ensureFile(key);
          readyCount++;
        } catch {
          // Error already logged and recorded on file state; continue bootstrapping remaining files.
        }
      }
      return {
        dir: modelDir,
        skipped: false,
        readyCount,
        totalCount: VOICE_MODEL_SPECS.length,
      };
    })();
    return bootstrapPromise;
  }

  function getState(): VoiceModelState {
    for (const spec of VOICE_MODEL_SPECS) {
      if (!inFlight.has(spec.key)) {
        const existing = refreshReadyState(spec);
        if (!existing && states.get(spec.key)!.status === "ready") {
          const st = states.get(spec.key)!;
          st.status = "missing";
          st.loaded = 0;
          st.total = spec.estimatedBytes;
        }
      }
    }

    const enc = { ...states.get("encoder")! };
    const dec = { ...states.get("decoder")! };
    const voc = { ...states.get("vocab")! };
    return {
      dir: modelDir,
      ready: enc.status === "ready" && dec.status === "ready" && voc.status === "ready",
      files: { encoder: enc, decoder: dec, vocab: voc },
    };
  }

  async function handleRoute(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(ROUTE_PREFIX)) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return null;

    try {
      await authFn(req);
    } catch (e) {
      if (e instanceof ApiError) return err(e.status, e.message, req, e.code);
      throw e;
    }

    // Strict allowlist on the raw segment: any slash, traversal, percent-encoding
    // or unknown name fails immediately without ever touching the filesystem.
    const rawFile = pathname.slice(ROUTE_PREFIX.length);
    const spec = SPEC_BY_FILENAME.get(rawFile);
    if (!spec) return err(404, "voice model file not found", req);

    const existing = refreshReadyState(spec);
    if (existing) {
      const headers = baseHeaders(req);
      const etag = fileEtag(existing);
      headers.set("Content-Type", spec.contentType);
      headers.set("Cache-Control", "public, max-age=86400");
      headers.set("Accept-Ranges", "bytes");
      headers.set("ETag", etag);

      if (etagMatches(req.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers });
      }

      if (req.method === "HEAD") {
        headers.set("Content-Length", String(existing.size));
        return new Response(null, { status: 200, headers });
      }

      const rangeHeader = req.headers.get("range");
      if (rangeHeader) {
        const parsed = parseSingleByteRange(rangeHeader, existing.size);
        if (parsed === "invalid") {
          headers.set("Content-Range", `bytes */${existing.size}`);
          return new Response(null, { status: 416, headers });
        }
        if (parsed) {
          headers.set("Content-Range", `bytes ${parsed.start}-${parsed.end}/${existing.size}`);
          headers.set("Content-Length", String(parsed.end - parsed.start + 1));
          return new Response(Bun.file(existing.path).slice(parsed.start, parsed.end + 1), {
            status: 206,
            headers,
          });
        }
      }

      headers.set("Content-Length", String(existing.size));
      return new Response(Bun.file(existing.path), { status: 200, headers });
    }

    // File not yet on disk: kick off or dedupe download unless inside error cooldown.
    const st = states.get(spec.key)!;
    const failedAt = lastErrorAt.get(spec.key);
    const inErrorCooldown =
      st.status === "error" && failedAt !== undefined && Date.now() - failedAt < errorCooldownMs;

    if (!inErrorCooldown && !inFlight.has(spec.key)) {
      void ensureFile(spec.key).catch(() => {});
    }

    const downloading = inFlight.has(spec.key) || st.status === "downloading";
    const headers = baseHeaders(req);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    headers.set("Retry-After", downloading ? "2" : String(Math.max(2, Math.ceil(errorCooldownMs / 1000))));
    const payload = {
      success: false,
      error: downloading
        ? "Voice model is still downloading on the server"
        : `Voice model download failed on the server: ${st.error || "unavailable"}`,
      downloading,
      progress: {
        loaded: st.loaded,
        total: st.total > 0 ? st.total : spec.estimatedBytes,
      },
    };
    return new Response(req.method === "HEAD" ? null : JSON.stringify(payload), {
      status: 503,
      headers,
    });
  }

  function shutdown(): void {
    controller.abort(new Error("voice model manager shutdown"));
    for (const tmpPath of activeTmpFiles) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {}
    }
    activeTmpFiles.clear();
  }

  return {
    modelDir,
    startBootstrap,
    ensureFile,
    getState,
    handleRoute,
    shutdown,
  };
}

let defaultManager: ReturnType<typeof createVoiceModelManager> | null = null;

function getDefaultManager(): ReturnType<typeof createVoiceModelManager> {
  if (!defaultManager) {
    const localDirs: string[] = [];
    const envDir = process.env.INDIRECT_VOICE_MODEL_DIR?.trim();
    if (envDir) localDirs.push(envDir);
    localDirs.push(path.resolve(import.meta.dir, "..", ".tools", VOICE_MODEL_SUBDIR));
    defaultManager = createVoiceModelManager({ localDirs });
  }
  return defaultManager;
}

export function startVoiceModelBootstrap(): Promise<VoiceModelBootstrapResult> {
  return getDefaultManager().startBootstrap();
}

export function ensureVoiceModelFile(key: VoiceModelKey): Promise<string> {
  return getDefaultManager().ensureFile(key);
}

export function getVoiceModelState(): VoiceModelState {
  return getDefaultManager().getState();
}

export function handleVoiceModelRoute(pathname: string, req: Request): Promise<Response | null> {
  return getDefaultManager().handleRoute(pathname, req);
}

export function shutdownVoiceModelManager(): void {
  defaultManager?.shutdown();
}
