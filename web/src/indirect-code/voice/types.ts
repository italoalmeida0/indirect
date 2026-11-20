export type VoiceState = "idle" | "starting" | "loading" | "listening" | "thinking";

export interface VoiceLoadProgress {
  loaded: number;
  total: number;
  pct: number;
  stage: "downloading" | "server-warming" | "initializing" | "warming";
}

export interface VoiceRevealState {
  prefix: string;
  words: string[];
  suffix: string;
  scrollTop: number;
  active: boolean;
}

export interface VoiceAuroraHandlers {
  setMode: (mode: "idle" | "loading" | "listening" | "thinking") => void;
  setProgress: (pct: number) => void;
  feedAudio: (analyser: AnalyserNode, rms: number) => void;
  clearAudio: () => void;
}

export type VoiceWorkletIn = { type: "flush" };

export interface VoiceWorkletOut {
  pcm: Float32Array;
  rms: number;
}

export type VoiceWorkerIn =
  | { type: "load"; loadId: number; authToken?: string }
  | { type: "abort_load" }
  | { type: "cancel_session"; sessionGen: number }
  | {
      type: "transcribe";
      jobId: number;
      sessionGen: number;
      chunkIdx: number;
      isFinal: boolean;
      audio: Float32Array;
    };

export type VoiceWorkerOut =
  | { type: "worker_ready" }
  | { type: "progress"; loadId: number; progress: VoiceLoadProgress; message?: string }
  | {
      type: "ready";
      loadId: number;
      fromCache: boolean;
      cachedInMemory?: boolean;
      abortedByCaller?: boolean;
      loadTimeMs?: number;
      threads: number;
    }
  | { type: "load_aborted"; loadId: number }
  | {
      type: "transcribe_done";
      jobId: number;
      sessionGen: number;
      chunkIdx: number;
      isFinal: boolean;
      text: string;
      latencyMs: number;
      audioDurationS: number;
    }
  | { type: "transcribe_cancelled"; jobId: number; sessionGen: number }
  | {
      type: "error";
      phase: "load" | "transcribe";
      error: string;
      loadId?: number;
      jobId?: number;
      sessionGen?: number;
      retryable?: boolean;
    };

export interface VoiceController {
  state: () => VoiceState;
  isIdle: () => boolean;
  isActive: () => boolean;
  supported: () => boolean;
  modelReady: () => boolean;
  statusText: () => string;
  statusMeta: () => string;
  downloadProgress: () => number;
  reveal: () => VoiceRevealState | null;
  errorMessage: () => string | null;
  energy: () => number;
  registerAurora: (handlers: VoiceAuroraHandlers) => () => void;
  start: () => void;
  confirm: () => void;
  cancel: () => void;
  clearReveal: () => void;
  captureSelection: (el: HTMLTextAreaElement | null) => void;
  setComposerElement: (el: HTMLElement | null) => void;
}
