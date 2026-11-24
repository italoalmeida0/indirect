import { batch, createSignal, getOwner, onCleanup } from "solid-js";
import { reducedMotion } from "../../ds/motion/reduced";
import {
  VOICE_SAMPLE_RATE,
  StreamingResampler16k,
  computeRms,
  concatFloat32,
  preprocessAudioForAsr,
} from "./audio-dsp";
import {
  insertTranscriptAtSelection,
  isAtSentenceStart,
  postProcessTranscript,
} from "./postprocess";
import type {
  VoiceAuroraHandlers,
  VoiceController,
  VoiceRevealState,
  VoiceState,
  VoiceWorkerIn,
  VoiceWorkerOut,
  VoiceWorkletOut,
} from "./types";

const WORKER_URL = "workers/voice-worker.js";
const WORKLET_URL = "workers/voice-worklet.js";
const WORKLET_PROCESSOR_NAME = "indirect-voice-capture";

const SPEECH_RMS_THRESHOLD = 0.013;
const PRECHUNK_MIN_SPEECH_SAMPLES = Math.round(3.5 * VOICE_SAMPLE_RATE);
const PRECHUNK_PAUSE_MS = 720;
const PRECHUNK_MAX_SEG_SAMPLES = 18 * VOICE_SAMPLE_RATE;

const DEFAULT_MIN_RECORDING_MS = 260;
const DEFAULT_MAX_RECORDING_MS = 300_000;
const DEFAULT_VISIBILITY_AUTOCONFIRM_MS = 400;
const DEFAULT_TIMER_INTERVAL_MS = 250;
const DEFAULT_WORKLET_FLUSH_WAIT_MS = 40;
const DEFAULT_MOBILE_IDLE_TERMINATE_MS = 10 * 60 * 1000;

export interface VoiceWorkerLike {
  postMessage: (msg: VoiceWorkerIn, transfer?: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((ev: MessageEvent<VoiceWorkerOut>) => void) | null;
  onerror: ((ev: Event | ErrorEvent) => void) | null;
}

export interface CreateVoiceControllerOptions {
  getHostId: () => string;
  getSessionId: () => string;
  getInputPrompt: () => string;
  setInputPrompt: (value: string) => void;
  setCaret?: (pos: number) => void;
  onBeforeStart?: () => void;
  onToast?: (message: string, kind?: "ok" | "err") => void;
  isMobile?: () => boolean;
  isReducedMotion?: () => boolean;
  getAuthToken?: () => string | undefined;
  getTextarea?: () => HTMLTextAreaElement | null;
  // Injectable factories for deterministic unit tests
  isSecureContext?: () => boolean;
  hasMediaDevices?: () => boolean;
  createWorker?: () => VoiceWorkerLike;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  createAudioWorkletNode?: (ctx: AudioContext, name: string) => AudioWorkletNode;
  requestWakeLock?: () => Promise<WakeLockSentinel | null>;
  now?: () => number;
  scheduleFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
  workletUrl?: string;
  workletFlushWaitMs?: number;
  mobileIdleTerminateMs?: number;
  minRecordingMs?: number;
  maxRecordingMs?: number;
  visibilityAutoConfirmMs?: number;
}

interface SavedSelection {
  hostId: string;
  sessionId: string;
  start: number;
  end: number;
}

interface PendingLoad {
  loadId: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface PendingJob {
  sessionGen: number;
  chunkIdx: number;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

interface ActiveCaptureSession {
  actionGen: number;
  sessionGen: number;
  startedAt: number;
  targetHostId: string;
  targetSessionId: string;
  selection: { start: number; end: number };
  stream: MediaStream;
  audioCtx: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  zeroGain: GainNode;
  workletNode: AudioWorkletNode | null;
  scriptProcessor: ScriptProcessorNode | null;
  resampler: StreamingResampler16k;
  segChunks: Float32Array[];
  segSamples: number;
  segSpeechSamples: number;
  segPauseMs: number;
  nextChunkIdx: number;
  dispatchedPromises: Promise<string>[];
  latestRms: number;
  wakeLock: WakeLockSentinel | null;
  timerInterval: ReturnType<typeof setInterval> | undefined;
  fftRafId: number | null;
  trackEndHandlers: Array<{ track: MediaStreamTrack; fn: () => void }>;
  ctxStateHandler: (() => void) | null;
  hardwareClosed: boolean;
  stopping: boolean;
}

function makeAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { name?: string }).name === "AbortError",
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function auroraModeFor(st: VoiceState): "idle" | "loading" | "listening" | "thinking" {
  return st === "starting" ? "loading" : st;
}

function defaultCreateAudioContext(): AudioContext {
  const win = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = typeof AudioContext !== "undefined" ? AudioContext : win.webkitAudioContext;
  if (!Ctor) {
    throw new Error("Web Audio API is not supported in this browser");
  }
  return new Ctor();
}

function defaultRequestWakeLock(): Promise<WakeLockSentinel | null> {
  if (typeof navigator === "undefined") return Promise.resolve(null);
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
  };
  if (!nav.wakeLock || typeof nav.wakeLock.request !== "function") {
    return Promise.resolve(null);
  }
  return nav.wakeLock.request("screen").catch(() => null);
}

function errorName(err: unknown): string {
  if (err && typeof err === "object" && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return "";
}

function formatMicError(err: unknown): string {
  const name = errorName(err);
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Microphone permission denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone found";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Microphone is busy or unavailable";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Could not start microphone";
}

export function createVoiceController(opts: CreateVoiceControllerOptions): VoiceController {
  const nowFn = opts.now ?? (() => Date.now());
  const setTimerFn = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimerFn = opts.clearTimer ?? ((id) => clearTimeout(id));
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((id) => clearInterval(id));
  const scheduleFrameFn =
    opts.scheduleFrame ??
    ((cb) =>
      typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(() => cb())
        : (setTimerFn(cb, 16) as unknown as number));
  const cancelFrameFn =
    opts.cancelFrame ??
    ((id) => {
      if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(id);
      } else {
        clearTimerFn(id as unknown as ReturnType<typeof setTimeout>);
      }
    });

  const workletUrl = opts.workletUrl ?? WORKLET_URL;
  const workletFlushWaitMs = opts.workletFlushWaitMs ?? DEFAULT_WORKLET_FLUSH_WAIT_MS;
  const mobileIdleTerminateMs = opts.mobileIdleTerminateMs ?? DEFAULT_MOBILE_IDLE_TERMINATE_MS;
  const minRecordingMs = opts.minRecordingMs ?? DEFAULT_MIN_RECORDING_MS;
  const maxRecordingMs = opts.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
  const visibilityAutoConfirmMs =
    opts.visibilityAutoConfirmMs ?? DEFAULT_VISIBILITY_AUTOCONFIRM_MS;

  const [state, setState] = createSignal<VoiceState>("idle");
  const [modelReady, setModelReady] = createSignal(false);
  const [statusText, setStatusText] = createSignal("");
  const [statusMeta, setStatusMeta] = createSignal("");
  const [downloadProgress, setDownloadProgress] = createSignal(0);
  const [reveal, setReveal] = createSignal<VoiceRevealState | null>(null);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [energy, setEnergy] = createSignal(0);

  const isIdle = () => state() === "idle";
  const isActive = () => state() !== "idle";

  let disposed = false;
  let actionGen = 0;
  let sessionGen = 0;
  let loadIdSeq = 0;
  let jobIdSeq = 0;
  let revealGen = 0;

  let worker: VoiceWorkerLike | null = null;
  let pendingLoad: PendingLoad | null = null;
  const pendingJobs = new Map<number, PendingJob>();
  let activeSession: ActiveCaptureSession | null = null;
  let auroraHandlers: VoiceAuroraHandlers | null = null;
  let savedSelection: SavedSelection | null = null;
  let composerElement: HTMLElement | null = null;

  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTerminateTimer: ReturnType<typeof setTimeout> | undefined;

  function checkSecureContext(): boolean {
    if (opts.isSecureContext) return opts.isSecureContext();
    return typeof window !== "undefined" && Boolean(window.isSecureContext);
  }

  function checkMediaDevices(): boolean {
    if (opts.hasMediaDevices) return opts.hasMediaDevices();
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function"
    );
  }

  function supported(): boolean {
    return checkSecureContext() && checkMediaDevices();
  }

  function getTextarea(): HTMLTextAreaElement | null {
    if (opts.getTextarea) return opts.getTextarea();
    if (composerElement) {
      const local = composerElement.querySelector<HTMLTextAreaElement>("#rc-composer");
      if (local) return local;
    }
    if (typeof document === "undefined") return null;
    return document.getElementById("rc-composer") as HTMLTextAreaElement | null;
  }

  function clearRevealTimer(): void {
    if (revealTimer !== undefined) {
      clearTimerFn(revealTimer);
      revealTimer = undefined;
    }
  }

  function clearIdleTerminateTimer(): void {
    if (idleTerminateTimer !== undefined) {
      clearTimerFn(idleTerminateTimer);
      idleTerminateTimer = undefined;
    }
  }

  function scheduleMobileIdleTerminate(): void {
    clearIdleTerminateTimer();
    if (disposed || !worker || !modelReady()) return;
    if (!opts.isMobile?.()) return;
    idleTerminateTimer = setTimerFn(() => {
      idleTerminateTimer = undefined;
      if (disposed || state() !== "idle") return;
      terminateWorker();
    }, mobileIdleTerminateMs);
  }

  function clearReveal(): void {
    revealGen++;
    clearRevealTimer();
    if (reveal() !== null) {
      setReveal(null);
    }
  }

  function stopSessionTimersAndFft(sess: ActiveCaptureSession): void {
    if (sess.timerInterval !== undefined) {
      clearIntervalFn(sess.timerInterval);
      sess.timerInterval = undefined;
    }
    if (sess.fftRafId !== null) {
      cancelFrameFn(sess.fftRafId);
      sess.fftRafId = null;
    }
    auroraHandlers?.clearAudio();
    if (energy() !== 0) setEnergy(0);
  }

  function releaseWakeLock(sess: ActiveCaptureSession): void {
    const wl = sess.wakeLock;
    sess.wakeLock = null;
    if (wl && !wl.released) {
      void wl.release().catch(() => {});
    }
  }

  function teardownCaptureHardware(sess: ActiveCaptureSession): void {
    stopSessionTimersAndFft(sess);
    releaseWakeLock(sess);

    if (sess.hardwareClosed) return;
    sess.hardwareClosed = true;

    for (const { track, fn } of sess.trackEndHandlers) {
      try {
        track.removeEventListener("ended", fn);
      } catch {}
    }
    sess.trackEndHandlers.length = 0;

    if (sess.ctxStateHandler) {
      try {
        sess.audioCtx.removeEventListener("statechange", sess.ctxStateHandler);
      } catch {}
      sess.ctxStateHandler = null;
    }

    if (sess.workletNode) {
      try {
        sess.workletNode.port.onmessage = null;
        sess.workletNode.disconnect();
      } catch {}
      sess.workletNode = null;
    }

    if (sess.scriptProcessor) {
      try {
        sess.scriptProcessor.onaudioprocess = null;
        sess.scriptProcessor.disconnect();
      } catch {}
      sess.scriptProcessor = null;
    }

    try {
      sess.source.disconnect();
    } catch {}
    try {
      sess.analyser.disconnect();
    } catch {}
    try {
      sess.zeroGain.disconnect();
    } catch {}

    try {
      for (const track of sess.stream.getTracks()) {
        track.stop();
      }
    } catch {}

    try {
      if (sess.audioCtx.state !== "closed") {
        void sess.audioCtx.close().catch(() => {});
      }
    } catch {}
  }

  function rejectPendingJobsForSession(sGen: number, err: Error): void {
    for (const [id, job] of pendingJobs.entries()) {
      if (job.sessionGen === sGen) {
        pendingJobs.delete(id);
        job.reject(err);
      }
    }
  }

  function rejectAllPendingJobs(err: Error): void {
    for (const [id, job] of pendingJobs.entries()) {
      pendingJobs.delete(id);
      job.reject(err);
    }
  }

  function resetToIdle(resetOpts?: { keepReveal?: boolean }): void {
    if (activeSession) {
      const sess = activeSession;
      activeSession = null;
      teardownCaptureHardware(sess);
    }
    batch(() => {
      setState("idle");
      setStatusText("");
      setStatusMeta("");
      setEnergy(0);
      if (!resetOpts?.keepReveal && reveal() !== null) {
        revealGen++;
        clearRevealTimer();
        setReveal(null);
      }
    });
    auroraHandlers?.clearAudio();
    auroraHandlers?.setMode("idle");
    scheduleMobileIdleTerminate();
  }

  function terminateWorker(): void {
    clearIdleTerminateTimer();
    const w = worker;
    worker = null;
    setModelReady(false);
    if (pendingLoad) {
      const cur = pendingLoad;
      pendingLoad = null;
      cur.reject(makeAbortError());
    }
    rejectAllPendingJobs(makeAbortError());
    if (w) {
      try {
        w.onmessage = null;
        w.onerror = null;
        w.terminate();
      } catch {}
    }
  }

  function handleWorkerMessage(ev: MessageEvent<VoiceWorkerOut>): void {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "worker_ready":
        break;

      case "progress": {
        if (!pendingLoad || msg.loadId !== pendingLoad.loadId) return;
        if (state() !== "loading") return;
        const p = msg.progress;
        const clampedPct = Number.isFinite(p.pct) ? Math.max(0, Math.min(100, p.pct)) : 0;
        const roundedPct = Math.round(clampedPct);
        batch(() => {
          setDownloadProgress(roundedPct);
          if (p.stage === "server-warming") {
            setStatusText("Preparing voice…");
            setStatusMeta(p.total > 0 ? `${roundedPct}%` : "");
          } else if (p.stage === "downloading") {
            const loadedMb = Math.round(Math.max(0, p.loaded) / (1024 * 1024));
            const totalMb = Math.max(1, Math.round(Math.max(0, p.total) / (1024 * 1024)));
            setStatusText("Downloading voice model…");
            setStatusMeta(`${roundedPct}% · ${loadedMb}/${totalMb} MB`);
          } else {
            setStatusText("Preparing voice engine…");
            setStatusMeta("Almost ready");
          }
        });
        auroraHandlers?.setProgress(clampedPct);
        break;
      }

      case "ready": {
        setModelReady(true);
        if (pendingLoad && msg.loadId === pendingLoad.loadId) {
          const cur = pendingLoad;
          pendingLoad = null;
          if (msg.abortedByCaller) {
            cur.reject(makeAbortError());
          } else {
            setDownloadProgress(100);
            auroraHandlers?.setProgress(100);
            cur.resolve();
          }
        } else if (state() === "idle") {
          scheduleMobileIdleTerminate();
        }
        break;
      }

      case "load_aborted": {
        if (pendingLoad && msg.loadId === pendingLoad.loadId) {
          const cur = pendingLoad;
          pendingLoad = null;
          cur.reject(makeAbortError());
        }
        break;
      }

      case "transcribe_done": {
        const job = pendingJobs.get(msg.jobId);
        if (!job) return;
        pendingJobs.delete(msg.jobId);
        if (job.sessionGen === msg.sessionGen) {
          job.resolve(msg.text || "");
        }
        break;
      }

      case "transcribe_cancelled": {
        const job = pendingJobs.get(msg.jobId);
        if (!job) return;
        pendingJobs.delete(msg.jobId);
        job.reject(makeAbortError());
        break;
      }

      case "error": {
        if (msg.phase === "load") {
          if (pendingLoad && (msg.loadId === undefined || msg.loadId === pendingLoad.loadId)) {
            const cur = pendingLoad;
            pendingLoad = null;
            cur.reject(new Error(msg.error || "Failed to load voice engine"));
          }
        } else if (msg.phase === "transcribe") {
          const err = new Error(msg.error || "Transcription failed");
          if (msg.jobId !== undefined) {
            const job = pendingJobs.get(msg.jobId);
            if (job) {
              pendingJobs.delete(msg.jobId);
              job.reject(err);
            }
          } else if (msg.sessionGen !== undefined) {
            rejectPendingJobsForSession(msg.sessionGen, err);
          } else {
            rejectAllPendingJobs(err);
          }
        }
        break;
      }
    }
  }

  function handleWorkerError(ev: Event | ErrorEvent): void {
    const msg =
      (ev && typeof ev === "object" && "message" in ev && typeof ev.message === "string" && ev.message) ||
      "Voice engine encountered an unexpected error";
    const crashErr = new Error(msg);
    const prevLoad = pendingLoad;
    pendingLoad = null;
    const w = worker;
    worker = null;
    setModelReady(false);
    clearIdleTerminateTimer();
    if (w) {
      try {
        w.onmessage = null;
        w.onerror = null;
        w.terminate();
      } catch {}
    }
    if (prevLoad) prevLoad.reject(crashErr);
    rejectAllPendingJobs(crashErr);

    if (!disposed && state() !== "idle") {
      actionGen++;
      setErrorMessage(msg);
      resetToIdle();
      opts.onToast?.(msg, "err");
    }
  }

  function ensureWorker(): VoiceWorkerLike {
    if (worker) return worker;
    const w = opts.createWorker
      ? opts.createWorker()
      : (new Worker(WORKER_URL, { type: "module" }) as unknown as VoiceWorkerLike);
    w.onmessage = handleWorkerMessage;
    w.onerror = handleWorkerError;
    worker = w;
    return w;
  }

  function ensureModelLoaded(): Promise<void> {
    if (modelReady() && worker) {
      return Promise.resolve();
    }
    let w: VoiceWorkerLike;
    try {
      w = ensureWorker();
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error("Could not start voice worker"),
      );
    }

    if (pendingLoad) {
      const prev = pendingLoad;
      pendingLoad = null;
      prev.reject(makeAbortError());
    }

    const loadId = ++loadIdSeq;
    const authToken = opts.getAuthToken?.();
    return new Promise<void>((resolve, reject) => {
      pendingLoad = { loadId, resolve, reject };
      try {
        w.postMessage({ type: "load", loadId, authToken });
      } catch (err) {
        if (pendingLoad?.loadId === loadId) pendingLoad = null;
        reject(err instanceof Error ? err : new Error("Failed to message voice worker"));
      }
    });
  }

  function dispatchSegment(sess: ActiveCaptureSession, isFinal: boolean): void {
    const raw = concatFloat32(sess.segChunks);
    sess.segChunks = [];
    sess.segSamples = 0;
    sess.segSpeechSamples = 0;
    sess.segPauseMs = 0;

    if (raw.length === 0) return;
    const pre = preprocessAudioForAsr(raw);
    if (!pre.hadSpeech || pre.audio.length === 0) return;

    const audio =
      pre.audio.byteOffset === 0 && pre.audio.byteLength === pre.audio.buffer.byteLength
        ? pre.audio
        : pre.audio.slice();
    const chunkIdx = sess.nextChunkIdx++;
    const jobId = ++jobIdSeq;

    const promise = new Promise<string>((resolve, reject) => {
      pendingJobs.set(jobId, {
        sessionGen: sess.sessionGen,
        chunkIdx,
        resolve,
        reject,
      });
    });
    // Prevent unhandled rejection if an intermediate pre-chunk fails before confirm() awaits it.
    promise.catch(() => {});
    sess.dispatchedPromises[chunkIdx] = promise;

    try {
      ensureWorker().postMessage(
        {
          type: "transcribe",
          jobId,
          sessionGen: sess.sessionGen,
          chunkIdx,
          isFinal,
          audio,
        },
        [audio.buffer],
      );
    } catch (err) {
      const job = pendingJobs.get(jobId);
      if (job) {
        pendingJobs.delete(jobId);
        job.reject(err instanceof Error ? err : new Error("Failed to send audio to voice engine"));
      }
    }
  }

  function onCapturedBlock(myGen: number, pcm: Float32Array, rms: number): void {
    const sess = activeSession;
    if (!sess || sess.actionGen !== myGen) return;

    sess.latestRms = Number.isFinite(rms) && rms > 0 ? rms : 0;
    const resampled = sess.resampler.process(pcm);
    if (resampled.length === 0) return;

    sess.segChunks.push(resampled);
    sess.segSamples += resampled.length;

    const blockMs = (resampled.length / VOICE_SAMPLE_RATE) * 1000;
    if (sess.latestRms >= SPEECH_RMS_THRESHOLD) {
      sess.segSpeechSamples += resampled.length;
      sess.segPauseMs = 0;
    } else if (sess.segSpeechSamples > 0) {
      sess.segPauseMs += blockMs;
    }

    if (sess.stopping) return;

    if (nowFn() - sess.startedAt >= maxRecordingMs) {
      confirm();
      return;
    }

    const pauseTriggered =
      sess.segSpeechSamples >= PRECHUNK_MIN_SPEECH_SAMPLES &&
      sess.segPauseMs >= PRECHUNK_PAUSE_MS;
    const maxLenTriggered = sess.segSamples >= PRECHUNK_MAX_SEG_SAMPLES;

    if (pauseTriggered || maxLenTriggered) {
      dispatchSegment(sess, false);
    }
  }

  function startFftPump(sess: ActiveCaptureSession): void {
    const pump = () => {
      sess.fftRafId = null;
      if (
        disposed ||
        state() !== "listening" ||
        activeSession !== sess ||
        sess.stopping ||
        sess.hardwareClosed
      ) {
        return;
      }
      auroraHandlers?.feedAudio(sess.analyser, sess.latestRms);
      const nextEnergy = Math.min(1, sess.latestRms * 8.2);
      if (Math.abs(nextEnergy - energy()) > 0.005) {
        setEnergy(nextEnergy);
      }
      sess.fftRafId = scheduleFrameFn(pump);
    };
    sess.fftRafId = scheduleFrameFn(pump);
  }

  function handleMicInterruption(sess: ActiveCaptureSession, reasonToast: string): void {
    if (disposed || activeSession !== sess || sess.stopping || state() !== "listening") return;
    const elapsed = nowFn() - sess.startedAt;
    if (elapsed >= visibilityAutoConfirmMs || sess.nextChunkIdx > 0) {
      confirm();
    } else {
      cancel();
      opts.onToast?.(reasonToast, "err");
    }
  }

  async function openMicStream(
    myGen: number,
    afterFirstLoad: boolean,
    targetHostId: string,
    targetSessionId: string,
    selection: { start: number; end: number },
  ): Promise<void> {
    if (afterFirstLoad && typeof document !== "undefined" && document.visibilityState === "hidden") {
      resetToIdle();
      opts.onToast?.("Voice ready — tap the mic to start", "ok");
      return;
    }

    let stream: MediaStream;
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };
      stream = opts.getUserMedia
        ? await opts.getUserMedia(constraints)
        : await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (disposed || myGen !== actionGen) return;
      const name = errorName(err);
      if (afterFirstLoad && (name === "NotAllowedError" || name === "InvalidStateError")) {
        resetToIdle();
        opts.onToast?.("Voice ready — tap the mic to start", "ok");
        return;
      }
      const msg = formatMicError(err);
      setErrorMessage(msg);
      resetToIdle();
      opts.onToast?.(msg, "err");
      return;
    }

    if (disposed || myGen !== actionGen) {
      try {
        for (const t of stream.getTracks()) t.stop();
      } catch {}
      return;
    }

    let audioCtx: AudioContext;
    try {
      audioCtx = opts.createAudioContext ? opts.createAudioContext() : defaultCreateAudioContext();
    } catch (err) {
      try {
        for (const t of stream.getTracks()) t.stop();
      } catch {}
      if (disposed || myGen !== actionGen) return;
      const msg = formatMicError(err);
      setErrorMessage(msg);
      resetToIdle();
      opts.onToast?.(msg, "err");
      return;
    }

    if (audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch {}
      if (disposed || myGen !== actionGen) {
        try {
          for (const t of stream.getTracks()) t.stop();
          void audioCtx.close().catch(() => {});
        } catch {}
        return;
      }
      if (audioCtx.state === "suspended") {
        try {
          for (const t of stream.getTracks()) t.stop();
          void audioCtx.close().catch(() => {});
        } catch {}
        resetToIdle();
        if (afterFirstLoad) {
          opts.onToast?.("Voice ready — tap the mic to start", "ok");
        } else {
          const msg = "Could not start audio capture — tap the mic again";
          setErrorMessage(msg);
          opts.onToast?.(msg, "err");
        }
        return;
      }
    }

    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    let zeroGain: GainNode;
    try {
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;
      zeroGain = audioCtx.createGain();
      zeroGain.gain.value = 0;
    } catch (err) {
      try {
        for (const t of stream.getTracks()) t.stop();
        void audioCtx.close().catch(() => {});
      } catch {}
      if (disposed || myGen !== actionGen) return;
      const msg = formatMicError(err);
      setErrorMessage(msg);
      resetToIdle();
      opts.onToast?.(msg, "err");
      return;
    }

    let workletNode: AudioWorkletNode | null = null;
    let scriptProcessor: ScriptProcessorNode | null = null;

    if (audioCtx.audioWorklet && typeof audioCtx.audioWorklet.addModule === "function") {
      try {
        await audioCtx.audioWorklet.addModule(workletUrl);
        if (disposed || myGen !== actionGen) {
          try {
            for (const t of stream.getTracks()) t.stop();
            void audioCtx.close().catch(() => {});
          } catch {}
          return;
        }
        const node = opts.createAudioWorkletNode
          ? opts.createAudioWorkletNode(audioCtx, WORKLET_PROCESSOR_NAME)
          : typeof AudioWorkletNode === "function"
            ? new AudioWorkletNode(audioCtx, WORKLET_PROCESSOR_NAME)
            : null;
        if (node) {
          node.port.onmessage = (ev: MessageEvent<VoiceWorkletOut>) => {
            const data = ev.data;
            if (!data || !(data.pcm instanceof Float32Array)) return;
            onCapturedBlock(myGen, data.pcm, data.rms);
          };
          source.connect(analyser);
          analyser.connect(node);
          node.connect(zeroGain);
          zeroGain.connect(audioCtx.destination);
          workletNode = node;
        }
      } catch {
        workletNode = null;
      }
    }

    if (!workletNode) {
      if (typeof audioCtx.createScriptProcessor !== "function") {
        try {
          for (const t of stream.getTracks()) t.stop();
          void audioCtx.close().catch(() => {});
        } catch {}
        if (disposed || myGen !== actionGen) return;
        const msg = "Audio capture is not supported in this browser";
        setErrorMessage(msg);
        resetToIdle();
        opts.onToast?.(msg, "err");
        return;
      }
      const proc = audioCtx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (ev: AudioProcessingEvent) => {
        const input = ev.inputBuffer.getChannelData(0);
        if (!input || input.length === 0) return;
        const copy = new Float32Array(input.length);
        copy.set(input);
        onCapturedBlock(myGen, copy, computeRms(copy));
      };
      source.connect(analyser);
      analyser.connect(proc);
      proc.connect(zeroGain);
      zeroGain.connect(audioCtx.destination);
      scriptProcessor = proc;
    }

    const mySessionGen = ++sessionGen;
    const sess: ActiveCaptureSession = {
      actionGen: myGen,
      sessionGen: mySessionGen,
      startedAt: nowFn(),
      targetHostId,
      targetSessionId,
      selection,
      stream,
      audioCtx,
      source,
      analyser,
      zeroGain,
      workletNode,
      scriptProcessor,
      resampler: new StreamingResampler16k(audioCtx.sampleRate || VOICE_SAMPLE_RATE),
      segChunks: [],
      segSamples: 0,
      segSpeechSamples: 0,
      segPauseMs: 0,
      nextChunkIdx: 0,
      dispatchedPromises: [],
      latestRms: 0,
      wakeLock: null,
      timerInterval: undefined,
      fftRafId: null,
      trackEndHandlers: [],
      ctxStateHandler: null,
      hardwareClosed: false,
      stopping: false,
    };

    activeSession = sess;

    // Interruption listeners (removed cleanly before intentional teardown)
    try {
      for (const track of stream.getAudioTracks()) {
        const fn = () => handleMicInterruption(sess, "Microphone disconnected");
        track.addEventListener("ended", fn);
        sess.trackEndHandlers.push({ track, fn });
      }
    } catch {}

    const onCtxState = () => {
      const st = audioCtx.state as string;
      if (st === "interrupted" || st === "closed") {
        handleMicInterruption(sess, "Recording interrupted");
      }
    };
    try {
      audioCtx.addEventListener("statechange", onCtxState);
      sess.ctxStateHandler = onCtxState;
    } catch {}

    batch(() => {
      setState("listening");
      setStatusText("Listening…");
      setStatusMeta("0:00");
    });
    auroraHandlers?.setMode("listening");

    // Live elapsed timer + 300s safety cap
    sess.timerInterval = setIntervalFn(() => {
      if (disposed || activeSession !== sess || sess.stopping || state() !== "listening") {
        if (sess.timerInterval !== undefined) {
          clearIntervalFn(sess.timerInterval);
          sess.timerInterval = undefined;
        }
        return;
      }
      const elapsed = nowFn() - sess.startedAt;
      setStatusMeta(formatElapsed(elapsed));
      if (elapsed >= maxRecordingMs) {
        confirm();
      }
    }, DEFAULT_TIMER_INTERVAL_MS);

    startFftPump(sess);

    // Feature-detected Screen Wake Lock (released in teardownCaptureHardware)
    const wakePromise = opts.requestWakeLock ? opts.requestWakeLock() : defaultRequestWakeLock();
    void wakePromise
      .then((sentinel) => {
        if (!sentinel) return;
        if (disposed || activeSession !== sess || sess.stopping || sess.hardwareClosed) {
          if (!sentinel.released) void sentinel.release().catch(() => {});
          return;
        }
        sess.wakeLock = sentinel;
      })
      .catch(() => {});
  }

  async function runStart(
    myGen: number,
    targetHostId: string,
    targetSessionId: string,
    selection: { start: number; end: number },
  ): Promise<void> {
    const hadModel = modelReady() && worker !== null;

    if (!hadModel) {
      batch(() => {
        setState("loading");
        setDownloadProgress(0);
        setStatusText("Preparing voice engine…");
        setStatusMeta("");
      });
      auroraHandlers?.setMode("loading");
      auroraHandlers?.setProgress(0);

      try {
        await ensureModelLoaded();
      } catch (err) {
        if (disposed || myGen !== actionGen) return;
        if (isAbortError(err)) {
          resetToIdle();
          return;
        }
        const msg = err instanceof Error ? err.message : "Failed to load voice model";
        setErrorMessage(msg);
        resetToIdle();
        opts.onToast?.(msg, "err");
        return;
      }

      if (disposed || myGen !== actionGen) return;
    }

    await openMicStream(myGen, !hadModel, targetHostId, targetSessionId, selection);
  }

  function start(): void {
    if (disposed || state() !== "idle") return;

    clearReveal();
    clearIdleTerminateTimer();

    if (!checkSecureContext()) {
      const msg = "Voice input requires HTTPS or localhost";
      setErrorMessage(msg);
      opts.onToast?.(msg, "err");
      return;
    }

    if (!checkMediaDevices()) {
      const msg = "Microphone access is not available in this browser";
      setErrorMessage(msg);
      opts.onToast?.(msg, "err");
      return;
    }

    const targetHostId = opts.getHostId();
    const targetSessionId = opts.getSessionId();
    const currentPrompt = opts.getInputPrompt();
    const textarea = getTextarea();

    let selStart = currentPrompt.length;
    let selEnd = currentPrompt.length;
    if (
      savedSelection &&
      savedSelection.hostId === targetHostId &&
      savedSelection.sessionId === targetSessionId
    ) {
      selStart = Math.max(0, Math.min(currentPrompt.length, savedSelection.start));
      selEnd = Math.max(selStart, Math.min(currentPrompt.length, savedSelection.end));
    } else if (textarea && typeof textarea.selectionStart === "number") {
      selStart = Math.max(0, Math.min(currentPrompt.length, textarea.selectionStart));
      const rawEnd = typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : selStart;
      selEnd = Math.max(selStart, Math.min(currentPrompt.length, rawEnd));
    }

    // Synchronous transition BEFORE first await to eliminate double-click races
    const myGen = ++actionGen;
    batch(() => {
      setErrorMessage(null);
      setEnergy(0);
      setState("starting");
      setStatusText("Starting microphone…");
      setStatusMeta("");
    });
    auroraHandlers?.setMode("loading");

    try {
      opts.onBeforeStart?.();
    } catch {}
    try {
      textarea?.blur();
    } catch {}

    void runStart(myGen, targetHostId, targetSessionId, { start: selStart, end: selEnd });
  }

  async function finishConfirm(sess: ActiveCaptureSession, myGen: number): Promise<void> {
    if (sess.workletNode) {
      try {
        sess.workletNode.port.postMessage({ type: "flush" });
      } catch {}
      if (workletFlushWaitMs > 0) {
        await new Promise<void>((resolve) => {
          setTimerFn(resolve, workletFlushWaitMs);
        });
      }
      if (disposed || myGen !== actionGen) {
        teardownCaptureHardware(sess);
        return;
      }
    }

    const tail = sess.resampler.flush();
    if (tail.length > 0) {
      sess.segChunks.push(tail);
      sess.segSamples += tail.length;
    }

    // Release mic & AudioContext immediately before awaiting WASM inference
    teardownCaptureHardware(sess);

    dispatchSegment(sess, true);

    if (sess.dispatchedPromises.length === 0) {
      if (disposed || myGen !== actionGen) return;
      resetToIdle();
      opts.onToast?.("No speech detected", "ok");
      return;
    }

    const results = await Promise.allSettled(sess.dispatchedPromises);
    if (disposed || myGen !== actionGen) return;

    const parts: string[] = [];
    let failedCount = 0;
    let firstError = "";

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") {
        const cleaned = (r.value || "").trim();
        if (cleaned) parts.push(cleaned);
      } else if (!isAbortError(r.reason)) {
        failedCount++;
        if (!firstError) {
          firstError =
            r.reason instanceof Error && r.reason.message
              ? r.reason.message
              : "Transcription failed";
        }
      }
    }

    if (failedCount > 0 && parts.length === 0) {
      const msg = firstError || "Transcription failed";
      setErrorMessage(msg);
      resetToIdle();
      opts.onToast?.(msg, "err");
      return;
    }

    if (failedCount > 0) {
      opts.onToast?.("Part of your recording could not be transcribed", "err");
    }

    // Verify target (hostId, sessionId) still matches before writing transcript
    if (
      opts.getHostId() !== sess.targetHostId ||
      opts.getSessionId() !== sess.targetSessionId
    ) {
      resetToIdle();
      return;
    }

    const currentText = opts.getInputPrompt();
    const selStart = Math.max(0, Math.min(currentText.length, sess.selection.start));
    const selEnd = Math.max(selStart, Math.min(currentText.length, sess.selection.end));
    const beforeCursor = currentText.slice(0, selStart);

    const rawJoined = parts.join(" ");
    const processed = postProcessTranscript(rawJoined, {
      isSentenceStart: isAtSentenceStart(beforeCursor),
    });

    if (!processed) {
      resetToIdle();
      opts.onToast?.("No speech detected", "ok");
      return;
    }

    const inserted = insertTranscriptAtSelection(currentText, selStart, selEnd, processed);
    const reduced = Boolean(opts.isReducedMotion ? opts.isReducedMotion() : reducedMotion());
    const useBloom = !reduced && inserted.words.length > 0;
    const myRevealGen = ++revealGen;
    clearRevealTimer();

    savedSelection = {
      hostId: sess.targetHostId,
      sessionId: sess.targetSessionId,
      start: inserted.caret,
      end: inserted.caret,
    };

    activeSession = null;
    batch(() => {
      opts.setInputPrompt(inserted.merged);
      opts.setCaret?.(inserted.caret);
      setState("idle");
      setStatusText("");
      setStatusMeta("");
      setEnergy(0);
      if (useBloom) {
        const el = getTextarea();
        setReveal({
          prefix: inserted.prefix,
          words: inserted.words,
          suffix: inserted.suffix,
          scrollTop: el ? el.scrollTop : 0,
          active: true,
        });
      } else if (reveal() !== null) {
        setReveal(null);
      }
    });
    auroraHandlers?.clearAudio();
    auroraHandlers?.setMode("idle");
    scheduleMobileIdleTerminate();

    const finishFocus = () => {
      if (disposed || myRevealGen !== revealGen || state() !== "idle") return;
      if (!opts.isMobile?.()) {
        const el = getTextarea();
        if (el) {
          try {
            el.focus();
            el.setSelectionRange(inserted.caret, inserted.caret);
          } catch {}
        }
      }
    };

    if (!useBloom) {
      queueMicrotask(finishFocus);
      return;
    }

    queueMicrotask(() => {
      if (disposed || myRevealGen !== revealGen || state() !== "idle") return;
      const el = getTextarea();
      const scrollTop = el ? el.scrollTop : 0;
      const cur = reveal();
      if (cur && cur.active && cur.scrollTop !== scrollTop) {
        setReveal({ ...cur, scrollTop });
      }
      const durationMs = Math.min(inserted.words.length * 34, 420) + 460;
      clearRevealTimer();
      revealTimer = setTimerFn(() => {
        revealTimer = undefined;
        if (disposed || myRevealGen !== revealGen) return;
        setReveal(null);
        finishFocus();
      }, durationMs);
    });
  }

  function confirm(): void {
    if (disposed || state() !== "listening" || !activeSession || activeSession.stopping) return;

    const sess = activeSession;
    const elapsedMs = nowFn() - sess.startedAt;
    if (elapsedMs < minRecordingMs && sess.nextChunkIdx === 0) {
      cancel();
      opts.onToast?.("Hold or speak a bit longer", "ok");
      return;
    }

    sess.stopping = true;
    stopSessionTimersAndFft(sess);

    batch(() => {
      setState("thinking");
      setStatusText("Transcribing…");
      setStatusMeta("");
      setEnergy(0);
    });
    auroraHandlers?.setMode("thinking");

    void finishConfirm(sess, sess.actionGen);
  }

  function cancel(): void {
    if (disposed) return;

    if (state() === "idle") {
      clearReveal();
      return;
    }

    const prevState = state();
    actionGen++;

    if (prevState === "loading") {
      if (worker) {
        try {
          worker.postMessage({ type: "abort_load" });
        } catch {}
      }
      if (pendingLoad) {
        const cur = pendingLoad;
        pendingLoad = null;
        cur.reject(makeAbortError());
      }
    }

    if (activeSession) {
      const sess = activeSession;
      activeSession = null;
      sess.stopping = true;
      if (worker) {
        try {
          worker.postMessage({ type: "cancel_session", sessionGen: sess.sessionGen });
        } catch {}
      }
      rejectPendingJobsForSession(sess.sessionGen, makeAbortError());
      teardownCaptureHardware(sess);
    }

    resetToIdle();
  }

  function captureSelection(el: HTMLTextAreaElement | null): void {
    if (!el || state() !== "idle" || reveal()?.active) return;
    const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
    savedSelection = {
      hostId: opts.getHostId(),
      sessionId: opts.getSessionId(),
      start,
      end,
    };
  }

  function registerAurora(handlers: VoiceAuroraHandlers): () => void {
    auroraHandlers = handlers;
    handlers.setProgress(downloadProgress());
    handlers.setMode(auroraModeFor(state()));
    return () => {
      if (auroraHandlers === handlers) {
        auroraHandlers = null;
      }
    };
  }

  function setComposerElement(el: HTMLElement | null): void {
    composerElement = el;
  }

  // Lifecycle listeners: visibilitychange + pagehide
  const onVisibilityChange = () => {
    if (disposed || typeof document === "undefined") return;
    if (document.visibilityState !== "hidden") return;
    if (state() === "listening" && activeSession && !activeSession.stopping) {
      const elapsed = nowFn() - activeSession.startedAt;
      if (elapsed >= visibilityAutoConfirmMs || activeSession.nextChunkIdx > 0) {
        confirm();
      } else {
        cancel();
      }
    } else if (state() === "starting") {
      cancel();
    }
  };

  const onPageHide = () => {
    if (disposed) return;
    actionGen++;
    clearReveal();
    if (activeSession) {
      const sess = activeSession;
      activeSession = null;
      sess.stopping = true;
      teardownCaptureHardware(sess);
    }
    terminateWorker();
    resetToIdle();
  };

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", onPageHide);
  }

  const cleanupAll = () => {
    if (disposed) return;
    disposed = true;
    actionGen++;
    revealGen++;
    clearRevealTimer();
    clearIdleTerminateTimer();
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", onPageHide);
    }
    if (activeSession) {
      const sess = activeSession;
      activeSession = null;
      sess.stopping = true;
      teardownCaptureHardware(sess);
    }
    terminateWorker();
    auroraHandlers = null;
    composerElement = null;
  };

  if (getOwner()) {
    onCleanup(cleanupAll);
  }

  return {
    state,
    isIdle,
    isActive,
    supported,
    modelReady,
    statusText,
    statusMeta,
    downloadProgress,
    reveal,
    errorMessage,
    energy,
    registerAurora,
    start,
    confirm,
    cancel,
    clearReveal,
    captureSelection,
    setComposerElement,
  };
}
