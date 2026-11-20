/** Standalone ES Module Web Worker compiled to `dist/workers/voice-worker.js`.
 * Downloads self-hosted Parakeet TDT v3 weights from the gateway, caches them in
 * IndexedDB, lazily loads `onnxruntime-web/wasm` after weights are ready,
 * initializes ONNX sessions sequentially to minimize peak RAM, and runs a serial
 * cancelable transcription queue.
 */
import { ParakeetModel } from "parakeet.js/parakeet";
import { JsPreprocessor } from "parakeet.js/mel";
import { VOICE_SAMPLE_RATE } from "./audio-dsp";
import { idbDeleteKeys, idbGet, idbPut, voiceCacheKey } from "./cache";
import { decodeParakeetTokens, parseParakeetVocab } from "./postprocess";
import type { VoiceLoadProgress, VoiceWorkerIn, VoiceWorkerOut } from "./types";

const MODEL_BASE_URL = "/api/indirect-code/voice/model/";

const ENCODER_FILE = "encoder-model.w2a8.onnx";
const DECODER_FILE = "decoder_joint-model.int8.onnx";
const VOCAB_FILE = "vocab.txt";

const MODEL_FILES = [
  { name: VOCAB_FILE, estimatedBytes: 94_000, contentType: "text/plain; charset=utf-8" },
  { name: DECODER_FILE, estimatedBytes: 18_200_000, contentType: "application/octet-stream" },
  { name: ENCODER_FILE, estimatedBytes: 189_890_000, contentType: "application/octet-stream" },
] as const;

const ESTIMATED_TOTAL_BYTES = 208_190_000;
const PROGRESS_THROTTLE_MS = 120;
const MAX_CANCELLED_SESSIONS = 60;
const MAX_SERVER_WARM_RETRIES = 300;
const DEFAULT_RETRY_AFTER_S = 2;

const ALL_CACHE_KEYS = [
  voiceCacheKey(ENCODER_FILE),
  voiceCacheKey(DECODER_FILE),
  voiceCacheKey(VOCAB_FILE),
];

interface WorkerGlobalScopeLike {
  postMessage(msg: VoiceWorkerOut, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<VoiceWorkerIn>) => void) | null;
}

const workerSelf = self as unknown as WorkerGlobalScopeLike;

interface WorkerParakeetTokenizer {
  id2token: string[];
  blankId: number;
  blankToken: string;
  decode(ids: number[]): string;
}

interface ParakeetModelCtorConfig {
  tokenizer: WorkerParakeetTokenizer;
  encoderSession: unknown;
  joinerSession: unknown;
  preprocessor: JsPreprocessor;
  ort: unknown;
  subsampling: number;
  windowStride: number;
  nMels: number;
}

interface OrtSessionLike {
  release?: () => Promise<void>;
}

interface ServerWarmingBody {
  error?: string;
  downloading?: boolean;
  progress?: { loaded?: number; total?: number };
}

interface FetchedFileEntry {
  name: string;
  key: string;
  blob: Blob | null;
  fromCache: boolean;
  persisted: boolean;
  size: number;
}

class VoiceLoadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = "VoiceLoadError";
    this.retryable = retryable;
  }
}

let model: ParakeetModel | null = null;
let compilingPromise: Promise<void> | null = null;
let lastThreads = 1;
let activeLoadId = 0;
let activeAbortController: AbortController | null = null;
let transcribeQueue: Promise<void> = Promise.resolve();
const cancelledSessions = new Set<number>();

function post(msg: VoiceWorkerOut): void {
  workerSelf.postMessage(msg);
}

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError");
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfterSeconds(headerVal: string | null): number {
  if (!headerVal) return DEFAULT_RETRY_AFTER_S;
  const parsed = Number.parseInt(headerVal.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETRY_AFTER_S;
  return Math.max(1, Math.min(15, parsed));
}

async function fetchModelFile(
  fileSpec: (typeof MODEL_FILES)[number],
  opts: {
    authToken?: string;
    signal: AbortSignal;
    onFileProgress: (file: string, loaded: number, total: number, fromCache: boolean, force?: boolean) => void;
    onServerWarming: (loaded: number, total: number) => void;
  },
): Promise<FetchedFileEntry> {
  const { authToken, signal, onFileProgress, onServerWarming } = opts;
  const key = voiceCacheKey(fileSpec.name);

  const cached = await idbGet(key);
  if (cached) {
    onFileProgress(fileSpec.name, cached.size, cached.size, true, true);
    return {
      name: fileSpec.name,
      key,
      blob: null,
      fromCache: true,
      persisted: true,
      size: cached.size,
    };
  }

  if (signal.aborted) throw makeAbortError();

  const url = `${MODEL_BASE_URL}${encodeURIComponent(fileSpec.name)}`;
  const headers: Record<string, string> | undefined = authToken
    ? { Authorization: `Bearer ${authToken}` }
    : undefined;

  let resp: Response | null = null;
  for (let attempt = 0; attempt <= MAX_SERVER_WARM_RETRIES; attempt++) {
    if (signal.aborted) throw makeAbortError();

    const candidate = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers,
      signal,
    });

    if (candidate.status === 503) {
      let body: ServerWarmingBody | null = null;
      try {
        body = (await candidate.json()) as ServerWarmingBody | null;
      } catch {}

      if (body && body.downloading === false) {
        throw new VoiceLoadError(body.error || "Voice model is currently unavailable on the server.", true);
      }

      if (attempt >= MAX_SERVER_WARM_RETRIES) {
        throw new VoiceLoadError("Server took too long to prepare the voice model. Please try again.", true);
      }

      const serverLoaded =
        typeof body?.progress?.loaded === "number" && Number.isFinite(body.progress.loaded)
          ? Math.max(0, body.progress.loaded)
          : 0;
      const serverTotal =
        typeof body?.progress?.total === "number" && Number.isFinite(body.progress.total) && body.progress.total > 0
          ? body.progress.total
          : ESTIMATED_TOTAL_BYTES;
      onServerWarming(serverLoaded, serverTotal);

      const waitSec = parseRetryAfterSeconds(candidate.headers.get("retry-after"));
      await sleepAbortable(waitSec * 1000, signal);
      continue;
    }

    if (candidate.status === 401 || candidate.status === 403) {
      throw new VoiceLoadError("Sign in again to download the voice model.", false);
    }

    if (!candidate.ok) {
      throw new VoiceLoadError(`Failed to download ${fileSpec.name} (HTTP ${candidate.status}).`, true);
    }

    resp = candidate;
    break;
  }

  if (!resp) {
    throw new VoiceLoadError(`Failed to download ${fileSpec.name}.`, true);
  }

  const contentLengthHeader = resp.headers.get("content-length");
  const parsedLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : 0;
  const expectedBytes = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : fileSpec.estimatedBytes;
  const contentType = resp.headers.get("content-type") || fileSpec.contentType;

  onFileProgress(fileSpec.name, 0, expectedBytes, false, true);

  let blob: Blob;
  let loaded = 0;

  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    try {
      while (true) {
        if (signal.aborted) {
          await reader.cancel().catch(() => {});
          throw makeAbortError();
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value as Uint8Array<ArrayBuffer>);
          loaded += value.byteLength;
          onFileProgress(fileSpec.name, loaded, Math.max(expectedBytes, loaded), false, false);
        }
      }
    } catch (err) {
      try {
        await reader.cancel();
      } catch {}
      chunks.length = 0;
      throw err;
    }

    if (signal.aborted) {
      chunks.length = 0;
      throw makeAbortError();
    }

    if (parsedLength > 0 && loaded < parsedLength) {
      chunks.length = 0;
      throw new VoiceLoadError(`Incomplete download for ${fileSpec.name} (${loaded}/${parsedLength} bytes).`, true);
    }

    blob = new Blob(chunks, { type: contentType });
    // Release raw chunk references immediately to minimize peak RAM on mobile.
    chunks.length = 0;
  } else {
    const buf = await resp.arrayBuffer();
    if (signal.aborted) throw makeAbortError();
    loaded = buf.byteLength;
    if (parsedLength > 0 && loaded < parsedLength) {
      throw new VoiceLoadError(`Incomplete download for ${fileSpec.name} (${loaded}/${parsedLength} bytes).`, true);
    }
    blob = new Blob([buf], { type: contentType });
  }

  onFileProgress(fileSpec.name, loaded, Math.max(expectedBytes, loaded), false, true);

  if (signal.aborted) throw makeAbortError();

  const persisted = await idbPut(key, blob);
  return {
    name: fileSpec.name,
    key,
    // If persisted to IDB, drop the Blob reference until this file's sequential init step.
    blob: persisted ? null : blob,
    fromCache: false,
    persisted,
    size: blob.size,
  };
}

async function consumeBlob(entry: FetchedFileEntry): Promise<Blob> {
  if (entry.blob) {
    const b = entry.blob;
    entry.blob = null;
    return b;
  }
  const cached = await idbGet(entry.key);
  if (!cached) {
    throw new VoiceLoadError(`Cached voice asset missing: ${entry.name}`, true);
  }
  return cached;
}

async function loadModel(loadId: number, authToken?: string): Promise<void> {
  if (model) {
    post({
      type: "ready",
      loadId,
      fromCache: true,
      cachedInMemory: true,
      threads: lastThreads,
    });
    return;
  }

  if (activeAbortController) {
    try {
      activeAbortController.abort();
    } catch {}
  }

  activeLoadId = loadId;

  if (compilingPromise) {
    post({
      type: "progress",
      loadId,
      progress: {
        loaded: ESTIMATED_TOTAL_BYTES,
        total: ESTIMATED_TOTAL_BYTES,
        pct: 99,
        stage: "warming",
      },
      message: "Warming up voice engine...",
    });
    try {
      await compilingPromise;
      if (model && loadId === activeLoadId) {
        post({ type: "ready", loadId, fromCache: true, threads: lastThreads });
      }
      return;
    } catch {
      // Previous compilation failed; continue with a fresh load.
    }
  }

  const ac = new AbortController();
  activeAbortController = ac;
  const t0 = performance.now();

  const fileProgress = new Map<string, { loaded: number; total: number }>();
  for (const spec of MODEL_FILES) {
    fileProgress.set(spec.name, { loaded: 0, total: spec.estimatedBytes });
  }

  let hadNetworkDownload = false;
  let lastProgressEmit = 0;

  const emitProgress = (progress: VoiceLoadProgress, message?: string, force = false) => {
    if (ac.signal.aborted || loadId !== activeLoadId) return;
    const now = performance.now();
    if (!force && now - lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    lastProgressEmit = now;
    post({ type: "progress", loadId, progress, message });
  };

  const onFileProgress = (
    file: string,
    loaded: number,
    total: number,
    fromCache: boolean,
    force = false,
  ) => {
    if (!fromCache) hadNetworkDownload = true;
    fileProgress.set(file, { loaded, total });
    if (!hadNetworkDownload) return;

    let sumLoaded = 0;
    let sumTotal = 0;
    for (const v of fileProgress.values()) {
      sumLoaded += v.loaded;
      sumTotal += v.total;
    }
    const estTotal = Math.max(sumTotal, ESTIMATED_TOTAL_BYTES);
    const pct = Math.min(99, (sumLoaded / estTotal) * 100);
    emitProgress(
      { loaded: sumLoaded, total: estTotal, pct, stage: "downloading" },
      "Downloading voice model...",
      force,
    );
  };

  const onServerWarming = (loaded: number, total: number) => {
    const estTotal = Math.max(total, ESTIMATED_TOTAL_BYTES);
    const pct = estTotal > 0 ? Math.min(99, (loaded / estTotal) * 100) : 0;
    emitProgress(
      { loaded, total: estTotal, pct, stage: "server-warming" },
      "Server preparing voice model...",
      true,
    );
  };

  try {
    const fetched = new Map<string, FetchedFileEntry>();
    for (const spec of MODEL_FILES) {
      const entry = await fetchModelFile(spec, {
        authToken,
        signal: ac.signal,
        onFileProgress,
        onServerWarming,
      });
      fetched.set(spec.name, entry);
    }

    if (ac.signal.aborted || loadId !== activeLoadId) {
      throw makeAbortError();
    }

    const encoderEntry = fetched.get(ENCODER_FILE)!;
    const decoderEntry = fetched.get(DECODER_FILE)!;
    const vocabEntry = fetched.get(VOCAB_FILE)!;
    const totalBytes = encoderEntry.size + decoderEntry.size + vocabEntry.size;

    emitProgress(
      {
        loaded: totalBytes,
        total: Math.max(totalBytes, ESTIMATED_TOTAL_BYTES),
        pct: 99,
        stage: "initializing",
      },
      hadNetworkDownload ? "Initializing voice engine..." : "Loading voice from cache...",
      true,
    );

    compilingPromise = (async () => {
      // Lazy dynamic import ONLY after the 3 weight files are ready.
      const ortMod = await import("onnxruntime-web/wasm");
      const ort = ((ortMod as { default?: unknown }).default ?? ortMod) as typeof ortMod;

      ort.env.wasm.wasmPaths = "/vendor/ort/";
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;
      ort.env.wasm.numThreads =
        globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined"
          ? Math.min(4, navigator.hardwareConcurrency || 2)
          : 1;
      lastThreads = ort.env.wasm.numThreads;

      const sessionOpts = {
        executionProviders: ["wasm"] as string[],
        graphOptimizationLevel: "all" as const,
        executionMode: "parallel" as const,
        enableCpuMemArena: true,
        enableMemPattern: true,
        logSeverityLevel: 2 as const,
      };

      let encoderSession: OrtSessionLike | null = null;
      let joinerSession: OrtSessionLike | null = null;
      let tokenizer: WorkerParakeetTokenizer;

      try {
        // Sequential ONNX session creation to stay below mobile RAM ceilings.
        let encBlob: Blob | null = await consumeBlob(encoderEntry);
        let encBytes: Uint8Array | null = new Uint8Array(await encBlob.arrayBuffer());
        encBlob = null;
        encoderSession = (await ort.InferenceSession.create(encBytes, sessionOpts)) as OrtSessionLike;
        encBytes = null;

        let decBlob: Blob | null = await consumeBlob(decoderEntry);
        let decBytes: Uint8Array | null = new Uint8Array(await decBlob.arrayBuffer());
        decBlob = null;
        joinerSession = (await ort.InferenceSession.create(decBytes, sessionOpts)) as OrtSessionLike;
        decBytes = null;

        let vocabBlob: Blob | null = await consumeBlob(vocabEntry);
        const vocabText = await vocabBlob.text();
        vocabBlob = null;
        const parsed = parseParakeetVocab(vocabText);
        if (parsed.idToPiece.length < 10) {
          throw new Error("Voice vocabulary file is empty or invalid.");
        }
        tokenizer = {
          id2token: parsed.idToPiece,
          blankId: parsed.blankId,
          blankToken: "<blk>",
          decode: (ids: number[]) => decodeParakeetTokens(ids, parsed.idToPiece, parsed.blankId),
        };
      } catch (sessionErr) {
        if (encoderSession?.release) {
          await encoderSession.release().catch(() => {});
        }
        if (joinerSession?.release) {
          await joinerSession.release().catch(() => {});
        }
        if (encoderEntry.fromCache || decoderEntry.fromCache || vocabEntry.fromCache) {
          await idbDeleteKeys(ALL_CACHE_KEYS);
          throw new VoiceLoadError(
            "Cached voice model appeared corrupted and was cleared — click again to re-download.",
            true,
          );
        }
        throw sessionErr;
      }

      emitProgress(
        {
          loaded: totalBytes,
          total: Math.max(totalBytes, ESTIMATED_TOTAL_BYTES),
          pct: 99,
          stage: "warming",
        },
        "Warming up voice engine...",
        true,
      );

      const preprocessor = new JsPreprocessor({ nMels: 128 });
      const ParakeetModelCtor = ParakeetModel as unknown as new (
        cfg: ParakeetModelCtorConfig,
      ) => ParakeetModel;
      const builtModel = new ParakeetModelCtor({
        tokenizer,
        encoderSession,
        joinerSession,
        preprocessor,
        ort,
        subsampling: 8,
        windowStride: 0.01,
        nMels: 128,
      });

      // 1-second silence warmup compiles WASM kernels before first real utterance.
      await builtModel.transcribe(new Float32Array(VOICE_SAMPLE_RATE), VOICE_SAMPLE_RATE, {
        enableProfiling: false,
      });
      model = builtModel;
    })();

    try {
      await compilingPromise;
    } finally {
      compilingPromise = null;
    }

    post({
      type: "ready",
      loadId,
      abortedByCaller: ac.signal.aborted || loadId !== activeLoadId,
      loadTimeMs: performance.now() - t0,
      fromCache: !hadNetworkDownload,
      threads: lastThreads,
    });
  } catch (err) {
    if (isAbortError(err)) {
      post({ type: "load_aborted", loadId });
    } else {
      const retryable = err instanceof VoiceLoadError ? err.retryable : true;
      post({
        type: "error",
        phase: "load",
        loadId,
        error: errorMessage(err),
        retryable,
      });
    }
  } finally {
    if (activeAbortController === ac) {
      activeAbortController = null;
    }
  }
}

function abortLoad(): void {
  if (activeAbortController) {
    try {
      activeAbortController.abort();
    } catch {}
    activeAbortController = null;
  }
  activeLoadId++;
}

function cancelSession(sessionGen: number): void {
  cancelledSessions.add(sessionGen);
  if (cancelledSessions.size > MAX_CANCELLED_SESSIONS) {
    const oldest = cancelledSessions.values().next().value;
    if (oldest !== undefined) cancelledSessions.delete(oldest);
  }
}

function enqueueTranscribe(job: Extract<VoiceWorkerIn, { type: "transcribe" }>): void {
  transcribeQueue = transcribeQueue.then(async () => {
    if (cancelledSessions.has(job.sessionGen)) {
      post({ type: "transcribe_cancelled", jobId: job.jobId, sessionGen: job.sessionGen });
      return;
    }
    if (!model) {
      post({
        type: "error",
        phase: "transcribe",
        jobId: job.jobId,
        sessionGen: job.sessionGen,
        error: "Voice engine is not loaded.",
      });
      return;
    }

    const t0 = performance.now();
    try {
      const res = await model.transcribe(job.audio, VOICE_SAMPLE_RATE, {
        enableProfiling: false,
      });
      if (cancelledSessions.has(job.sessionGen)) {
        post({ type: "transcribe_cancelled", jobId: job.jobId, sessionGen: job.sessionGen });
        return;
      }
      post({
        type: "transcribe_done",
        jobId: job.jobId,
        sessionGen: job.sessionGen,
        chunkIdx: job.chunkIdx,
        isFinal: job.isFinal,
        text: (res?.utterance_text || "").trim(),
        latencyMs: performance.now() - t0,
        audioDurationS: job.audio.length / VOICE_SAMPLE_RATE,
      });
    } catch (err) {
      post({
        type: "error",
        phase: "transcribe",
        jobId: job.jobId,
        sessionGen: job.sessionGen,
        error: errorMessage(err),
      });
    }
  });
}

workerSelf.onmessage = (ev: MessageEvent<VoiceWorkerIn>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "load":
      void loadModel(msg.loadId, msg.authToken);
      break;
    case "abort_load":
      abortLoad();
      break;
    case "cancel_session":
      cancelSession(msg.sessionGen);
      break;
    case "transcribe":
      enqueueTranscribe(msg);
      break;
  }
};

post({ type: "worker_ready" });
