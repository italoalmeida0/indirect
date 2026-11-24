import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { transformAsync } from "@babel/core";
import solidPreset from "babel-preset-solid";
import tsPreset from "@babel/preset-typescript";
import {
  VOICE_SAMPLE_RATE,
  StreamingResampler16k,
  computeRms,
  concatFloat32,
  preprocessAudioForAsr,
} from "../web/src/indirect-code/voice/audio-dsp";
import {
  decodeParakeetTokens,
  insertTranscriptAtSelection,
  isAtSentenceStart,
  parseParakeetVocab,
  postProcessTranscript,
} from "../web/src/indirect-code/voice/postprocess";
import type {
  CreateVoiceControllerOptions,
  VoiceWorkerLike,
  createVoiceController as CreateVoiceControllerFn,
} from "../web/src/indirect-code/voice/useVoice";
import type {
  VoiceAuroraHandlers,
  VoiceController,
  VoiceState,
  VoiceWorkerIn,
  VoiceWorkerOut,
  VoiceWorkletOut,
} from "../web/src/indirect-code/voice/types";
import type {
  BackNavigationOptions,
  HistoryAdapter,
  NavLayerActions,
  NavProjectionState,
  createBackNavigation as CreateBackNavigationFn,
  projectNavLayers as ProjectNavLayersFn,
} from "../web/src/indirect-code/hooks/useBackNavigation";

// ---------------------------------------------------------------------------
// Helpers for deterministic DSP signal generation
// ---------------------------------------------------------------------------

function makeSine(freqHz: number, sampleRate: number, numSamples: number, amp = 0.5): Float32Array {
  const out = new Float32Array(numSamples);
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < numSamples; i++) {
    out[i] = amp * Math.sin(w * i);
  }
  return out;
}

function makeMultiTone(sampleRate: number, numSamples: number): Float32Array {
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    out[i] =
      0.35 * Math.sin(2 * Math.PI * 310 * t) +
      0.25 * Math.sin(2 * Math.PI * 1450 * t) +
      0.15 * Math.sin(2 * Math.PI * 3200 * t);
  }
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let maxD = 0;
  for (let i = 0; i < len; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

function flushMicrotasks(turns = 6): Promise<void> {
  return (async () => {
    for (let i = 0; i < turns; i++) {
      await Promise.resolve();
    }
  })();
}

// ===========================================================================
// 1. Audio DSP (`audio-dsp.ts`)
// ===========================================================================

describe("voice audio-dsp", () => {
  test("computeRms & concatFloat32 handle empty, DC, sine, and multi-chunk arrays", () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
    expect(computeRms(new Float32Array([0.5, 0.5, 0.5, 0.5]))).toBeCloseTo(0.5, 6);
    expect(computeRms(new Float32Array([-0.25, -0.25]))).toBeCloseTo(0.25, 6);

    const sine = makeSine(400, VOICE_SAMPLE_RATE, VOICE_SAMPLE_RATE, 0.4);
    expect(computeRms(sine)).toBeCloseTo(0.4 / Math.SQRT2, 3);

    expect(concatFloat32([]).length).toBe(0);
    expect(concatFloat32([new Float32Array(0), new Float32Array(0)]).length).toBe(0);
    const joined = concatFloat32([
      new Float32Array([1, 2]),
      new Float32Array(0),
      new Float32Array([3, 4, 5]),
    ]);
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5]);
  });

  test("StreamingResampler16k rejects invalid sample rates", () => {
    for (const bad of [0, -16000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => new StreamingResampler16k(bad)).toThrow(RangeError);
    }
  });

  test("StreamingResampler16k chunked vs monolithic exact continuity at 8/16/24/44.1/48/96 kHz", () => {
    const rates = [8_000, 16_000, 24_000, 44_100, 48_000, 96_000];
    const irregularSizes = [73, 128, 317, 1024, 509, 17, 2048];

    for (const rate of rates) {
      const durationSec = 0.25;
      const totalIn = Math.round(rate * durationSec);
      const signal = makeMultiTone(rate, totalIn);

      // Monolithic pass
      const mono = new StreamingResampler16k(rate);
      const monoMain = mono.process(signal);
      const monoTail = mono.flush();
      const monoFull = concatFloat32([monoMain, monoTail]);

      // Irregular chunked pass
      const chunked = new StreamingResampler16k(rate);
      const pieces: Float32Array[] = [];
      let offset = 0;
      let sizeIdx = 0;
      while (offset < signal.length) {
        const len = Math.min(irregularSizes[sizeIdx % irregularSizes.length]!, signal.length - offset);
        pieces.push(chunked.process(signal.subarray(offset, offset + len)));
        offset += len;
        sizeIdx++;
      }
      pieces.push(chunked.flush());
      const chunkedFull = concatFloat32(pieces);

      const expectedLen = Math.ceil((totalIn * VOICE_SAMPLE_RATE) / rate);
      expect(monoFull.length).toBe(expectedLen);
      expect(chunkedFull.length).toBe(monoFull.length);
      expect(maxAbsDiff(monoFull, chunkedFull)).toBeLessThan(1e-6);

      // 16 kHz passthrough returns a distinct copy, not the same reference
      if (rate === VOICE_SAMPLE_RATE) {
        expect(monoMain).not.toBe(signal);
        expect(monoTail.length).toBe(0);
      }
    }
  });

  test("StreamingResampler16k anti-aliasing stopband rejection above 8 kHz and passband preservation", () => {
    // Passband 1 kHz tone at 48 kHz -> 16 kHz preserves energy
    const passIn = makeSine(1_000, 48_000, 24_000, 0.5);
    const passResampler = new StreamingResampler16k(48_000);
    const passOut = concatFloat32([passResampler.process(passIn), passResampler.flush()]);
    const passSteady = passOut.subarray(400, passOut.length - 400);
    expect(computeRms(passSteady)).toBeGreaterThan(0.32); // 0.5/sqrt(2) ≈ 0.3536

    // Stopband tones above 8 kHz Nyquist must be attenuated > 60 dB (RMS < 1e-3)
    const stopCases: Array<[number, number]> = [
      [44_100, 11_000],
      [48_000, 12_000],
      [96_000, 20_000],
    ];
    for (const [rate, freq] of stopCases) {
      const stopIn = makeSine(freq, rate, Math.round(rate * 0.4), 0.8);
      const r = new StreamingResampler16k(rate);
      const out = concatFloat32([r.process(stopIn), r.flush()]);
      const steady = out.subarray(400, out.length - 400);
      const rmsIn = computeRms(stopIn);
      const rmsOut = computeRms(steady);
      const attenDb = 20 * Math.log10(Math.max(rmsOut, 1e-12) / rmsIn);
      expect(attenDb).toBeLessThan(-60);
    }
  });

  test("StreamingResampler16k reset() and flush() restore clean initial state", () => {
    const sig = makeMultiTone(48_000, 4800);
    const r = new StreamingResampler16k(48_000);
    r.process(sig.subarray(0, 1200));
    r.reset();

    const afterReset = concatFloat32([r.process(sig), r.flush()]);
    const fresh = new StreamingResampler16k(48_000);
    const expected = concatFloat32([fresh.process(sig), fresh.flush()]);

    expect(afterReset.length).toBe(expected.length);
    expect(maxAbsDiff(afterReset, expected)).toBeLessThan(1e-6);
    // Double flush on empty buffer returns empty array
    expect(r.flush().length).toBe(0);
  });

  test("preprocessAudioForAsr rejects short clips, silence, and sub-80Hz rumble; trims speech with 180/220ms pad", () => {
    // Short input (< 5 frames = 1600 samples)
    const shortRes = preprocessAudioForAsr(makeSine(440, VOICE_SAMPLE_RATE, 1200, 0.2));
    expect(shortRes.hadSpeech).toBe(false);
    expect(shortRes.audio.length).toBe(0);

    // Pure silence
    const silentRes = preprocessAudioForAsr(new Float32Array(VOICE_SAMPLE_RATE));
    expect(silentRes.hadSpeech).toBe(false);
    expect(silentRes.audio.length).toBe(0);

    // Sub-threshold noise (< 0.009 peak RMS)
    const quietNoise = makeSine(440, VOICE_SAMPLE_RATE, VOICE_SAMPLE_RATE, 0.004);
    expect(preprocessAudioForAsr(quietNoise).hadSpeech).toBe(false);

    // 80 Hz HPF strongly attenuates low-frequency 8 Hz rumble
    const rumble = makeSine(8, VOICE_SAMPLE_RATE, VOICE_SAMPLE_RATE, 0.05);
    const rumbleRes = preprocessAudioForAsr(rumble);
    expect(rumbleRes.hadSpeech).toBe(false);

    // 1.0s silence + 0.5s 440Hz speech + 1.0s silence -> trims to 0.5s + 180ms pre + 220ms post = 0.9s
    const lead = new Float32Array(16_000);
    const speech = makeSine(440, VOICE_SAMPLE_RATE, 8_000, 0.15);
    const trail = new Float32Array(16_000);
    const clip = concatFloat32([lead, speech, trail]);
    const res = preprocessAudioForAsr(clip);
    expect(res.hadSpeech).toBe(true);
    const outMs = (res.audio.length / VOICE_SAMPLE_RATE) * 1000;
    // 180ms pre + 500ms speech + 220ms post = 900ms (±20ms frame quantization)
    expect(outMs).toBeGreaterThanOrEqual(860);
    expect(outMs).toBeLessThanOrEqual(940);
    // ~1600ms of silence removed (2500ms - 900ms)
    expect(res.trimmedMs).toBeGreaterThanOrEqual(1540);
    expect(res.trimmedMs).toBeLessThanOrEqual(1660);
  });

  test("preprocessAudioForAsr clamps RMS normalization gain to [0.55, 7.5] and soft-limits ceiling <= 0.99", () => {
    // Quiet speech (rms ~ 0.011): 0.11 / 0.011 = 10 -> clamped to 7.5 (gainDb ≈ 17.5 dB)
    const quiet = makeSine(500, VOICE_SAMPLE_RATE, 16_000, 0.0155);
    const quietRes = preprocessAudioForAsr(quiet);
    expect(quietRes.hadSpeech).toBe(true);
    expect(quietRes.gainDb).toBeCloseTo(20 * Math.log10(7.5), 1);

    // Loud speech (rms ~ 0.5): 0.11 / 0.5 = 0.22 -> clamped to 0.55 (gainDb ≈ -5.19 dB)
    const loud = makeSine(500, VOICE_SAMPLE_RATE, 16_000, 0.7);
    const loudRes = preprocessAudioForAsr(loud);
    expect(loudRes.hadSpeech).toBe(true);
    expect(loudRes.gainDb).toBeCloseTo(20 * Math.log10(0.55), 1);

    // Extreme peaks: amplitude 3.0 -> even at min gain 0.55 raw peak is 1.65 > 0.85 knee -> tanh ceiling <= 0.99
    const hot = makeSine(500, VOICE_SAMPLE_RATE, 16_000, 3.0);
    const hotRes = preprocessAudioForAsr(hot);
    expect(hotRes.hadSpeech).toBe(true);
    let peak = 0;
    for (let i = 0; i < hotRes.audio.length; i++) {
      const a = Math.abs(hotRes.audio[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.85);
    expect(peak).toBeLessThanOrEqual(0.99);
  });
});

// ===========================================================================
// 2. Post-processing & SentencePiece Decoder (`postprocess.ts`)
// ===========================================================================

describe("voice postprocess & tokenizer", () => {
  test("parseParakeetVocab & decodeParakeetTokens preserve Portuguese accented spaces while tightening closing punctuation", () => {
    const vocabText = [
      "▁isso 1",
      "▁é 2",
      "▁ótimo 3",
      "▁, 4",
      "▁né 5",
      "▁? 6",
      "▁atenção 7",
      "▁à 8",
      "▁ação 9",
      "<blk> 42",
    ].join("\r\n");

    const parsed = parseParakeetVocab(vocabText);
    expect(parsed.blankId).toBe(42);
    expect(parsed.idToPiece[2]).toBe("▁é");

    const decoded1 = decodeParakeetTokens([42, 1, 2, 3, 4, 5, 6, 42, 999], parsed.idToPiece, parsed.blankId);
    expect(decoded1).toBe("isso é ótimo, né?");

    const decoded2 = decodeParakeetTokens([7, 8, 9], parsed.idToPiece, parsed.blankId);
    expect(decoded2).toBe("atenção à ação");

    // Default blankId fallback when <blk> is absent
    const noBlank = parseParakeetVocab("▁olá 0\n▁mundo 1\n");
    expect(noBlank.blankId).toBe(1024);
    expect(decodeParakeetTokens([0, 1024, 1], noBlank.idToPiece, noBlank.blankId)).toBe("olá mundo");
  });

  test("postProcessTranscript normalizes tech terms with zero false positives and contextual capitalization", () => {
    expect(
      postProcessTranscript(
        "build a rest api with type script, next js, solid js, postgre sql, graph ql, tailwind css, web workers and ci / cd",
      ),
    ).toBe(
      "Build a REST API with TypeScript, Next.js, SolidJS, PostgreSQL, GraphQL, Tailwind CSS, Web Workers and CI/CD",
    );

    expect(
      postProcessTranscript("check o-auth jwt json wasm onnx ssr apis and llms on git hub"),
    ).toBe("Check OAuth JWT JSON WASM ONNX SSR APIs and LLMs on GitHub");

    // Zero false positives on plain English "rest", accented Portuguese "domínio"/"apiário", and PT interjection "ui"
    expect(postProcessTranscript("take a rest and check the rest of it", { isSentenceStart: false })).toBe(
      "take a rest and check the rest of it",
    );
    expect(postProcessTranscript("configurar o domínio e o apiário", { isSentenceStart: false })).toBe(
      "configurar o domínio e o apiário",
    );
    expect(postProcessTranscript("ui, que susto!", { isSentenceStart: false })).toBe("ui, que susto!");
    expect(postProcessTranscript("ui, que susto!", { isSentenceStart: true })).toBe("Ui, que susto!");

    // Context-gated UI & RESTful still normalize properly
    expect(postProcessTranscript("update the voice ui and ui component for a restful service", { isSentenceStart: false })).toBe(
      "update the voice UI and UI component for a RESTful service",
    );
    expect(postProcessTranscript("review ui/ux polish", { isSentenceStart: false })).toBe("review UI/UX polish");

    // Contextual capitalization
    expect(postProcessTranscript("fix the bug", { isSentenceStart: true })).toBe("Fix the bug");
    expect(postProcessTranscript("fix the bug", { isSentenceStart: false })).toBe("fix the bug");
    expect(postProcessTranscript("   ")).toBe("");
  });

  test("isAtSentenceStart detects empty, newlines, and terminal punctuation accurately", () => {
    expect(isAtSentenceStart("")).toBe(true);
    expect(isAtSentenceStart("   \t")).toBe(true);
    expect(isAtSentenceStart("First line\n")).toBe(true);
    expect(isAtSentenceStart("Done. ")).toBe(true);
    expect(isAtSentenceStart('Wait!" ')).toBe(true);
    expect(isAtSentenceStart("Really? ")).toBe(true);
    expect(isAtSentenceStart("Hmm… ")).toBe(true);
    expect(isAtSentenceStart("Fix the ")).toBe(false);
    expect(isAtSentenceStart("Hello, ")).toBe(false);
    expect(isAtSentenceStart("foo:")).toBe(false);
  });

  test("insertTranscriptAtSelection handles empty, append, mid-sentence, selection replacement, and preserves reveal invariant", () => {
    const cases: Array<{
      current: string;
      start: number;
      end: number;
      transcript: string;
      expectedMerged: string;
      expectedCaret: number;
    }> = [
      {
        current: "",
        start: 0,
        end: 0,
        transcript: "Hello world",
        expectedMerged: "Hello world",
        expectedCaret: 11,
      },
      {
        current: "Existing draft",
        start: 14,
        end: 14,
        transcript: "with voice",
        expectedMerged: "Existing draft with voice",
        expectedCaret: 25,
      },
      {
        current: "Existing draft ",
        start: 15,
        end: 15,
        transcript: "with voice",
        expectedMerged: "Existing draft with voice",
        expectedCaret: 25,
      },
      {
        current: "Hello",
        start: 5,
        end: 5,
        transcript: ", world!",
        expectedMerged: "Hello, world!",
        expectedCaret: 13,
      },
      {
        current: "Fix bug now",
        start: 4,
        end: 4,
        transcript: "this nasty",
        expectedMerged: "Fix this nasty bug now",
        expectedCaret: 15,
      },
      {
        current: "Fix old bug",
        start: 4,
        end: 7,
        transcript: "new",
        expectedMerged: "Fix new bug",
        expectedCaret: 7,
      },
      {
        current: "Keep unchanged",
        start: 4,
        end: 4,
        transcript: "   ",
        expectedMerged: "Keep unchanged",
        expectedCaret: 4,
      },
    ];

    for (const tc of cases) {
      const res = insertTranscriptAtSelection(tc.current, tc.start, tc.end, tc.transcript);
      expect(res.merged).toBe(tc.expectedMerged);
      expect(res.caret).toBe(tc.expectedCaret);
      // Critical bloom-reveal alignment invariant:
      expect(res.prefix + res.words.join(" ") + res.suffix).toBe(res.merged);
    }
  });
});

// ===========================================================================
// 3 & 4. Client SolidJS Harness for `useVoice.ts` + `useBackNavigation.ts`
// ===========================================================================

let clientMod: {
  batch: typeof import("solid-js").batch;
  createRoot: typeof import("solid-js").createRoot;
  createSignal: typeof import("solid-js").createSignal;
  createVoiceController: typeof CreateVoiceControllerFn;
  createBackNavigation: typeof CreateBackNavigationFn;
  projectNavLayers: typeof ProjectNavLayersFn;
};

interface FakeTimerTask {
  id: number;
  at: number;
  interval?: number;
  fn: () => void;
  cleared: boolean;
}

class FakeClock {
  nowMs = 1_000;
  private nextId = 1;
  private timers = new Map<number, FakeTimerTask>();
  private frames = new Map<number, () => void>();

  now = () => this.nowMs;

  setTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.nowMs + Math.max(0, ms), fn, cleared: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (id: ReturnType<typeof setTimeout>): void => {
    const t = this.timers.get(id as unknown as number);
    if (t) {
      t.cleared = true;
      this.timers.delete(t.id);
    }
  };

  setIntervalFn = (fn: () => void, ms: number): ReturnType<typeof setInterval> => {
    const id = this.nextId++;
    this.timers.set(id, {
      id,
      at: this.nowMs + Math.max(1, ms),
      interval: Math.max(1, ms),
      fn,
      cleared: false,
    });
    return id as unknown as ReturnType<typeof setInterval>;
  };

  clearIntervalFn = (id: ReturnType<typeof setInterval>): void => {
    this.clearTimer(id as unknown as ReturnType<typeof setTimeout>);
  };

  scheduleFrame = (cb: () => void): number => {
    const id = this.nextId++;
    this.frames.set(id, cb);
    return id;
  };

  cancelFrame = (id: number): void => {
    this.frames.delete(id);
  };

  runFramesOnce(): void {
    const batch = Array.from(this.frames.entries());
    this.frames.clear();
    for (const [, cb] of batch) cb();
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      let next: FakeTimerTask | null = null;
      for (const task of this.timers.values()) {
        if (task.cleared || task.at > target) continue;
        if (!next || task.at < next.at || (task.at === next.at && task.id < next.id)) {
          next = task;
        }
      }
      if (!next) break;
      this.nowMs = next.at;
      if (next.interval !== undefined) {
        next.at = this.nowMs + next.interval;
      } else {
        this.timers.delete(next.id);
      }
      next.fn();
    }
    this.nowMs = target;
  }

  pendingTimersCount(): number {
    return this.timers.size;
  }

  pendingFramesCount(): number {
    return this.frames.size;
  }
}

class MockVoiceWorker implements VoiceWorkerLike {
  sent: VoiceWorkerIn[] = [];
  terminated = false;
  onmessage: ((ev: MessageEvent<VoiceWorkerOut>) => void) | null = null;
  onerror: ((ev: Event | ErrorEvent) => void) | null = null;

  postMessage(msg: VoiceWorkerIn, _transfer?: Transferable[]): void {
    this.sent.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: VoiceWorkerOut): void {
    this.onmessage?.({ data: msg } as MessageEvent<VoiceWorkerOut>);
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

interface MockAudioEnv {
  sampleRate: number;
  useWorklet: boolean;
  workletAddModuleThrows: boolean;
  workletAddedUrls: string[];
  workletFlushCalls: number;
  tracksStopped: number;
  ctxClosed: number;
  ctxState: AudioContextState;
  resumeKeepsSuspended: boolean;
  wakeLockReleased: number;
  emitWorkletBlock: (pcm: Float32Array, rms?: number) => void;
  emitScriptBlock: (pcm: Float32Array) => void;
  endTrack: () => void;
  getUserMediaCalls: number;
  nextGetUserMediaError: Error | null;
  holdGetUserMedia: boolean;
  releaseGetUserMedia: () => void;
  createOptions: () => Partial<CreateVoiceControllerOptions>;
}

function createMockAudioEnv(overrides?: {
  sampleRate?: number;
  useWorklet?: boolean;
  ctxState?: AudioContextState;
  resumeKeepsSuspended?: boolean;
}): MockAudioEnv {
  let workletPortOnMessage: ((ev: MessageEvent<VoiceWorkletOut>) => void) | null = null;
  let scriptOnAudioProcess: ((ev: AudioProcessingEvent) => void) | null = null;
  let trackEndListener: (() => void) | null = null;
  let heldResolve: ((s: MediaStream) => void) | null = null;

  const env: MockAudioEnv = {
    sampleRate: overrides?.sampleRate ?? 48_000,
    useWorklet: overrides?.useWorklet ?? true,
    workletAddModuleThrows: false,
    workletAddedUrls: [],
    workletFlushCalls: 0,
    tracksStopped: 0,
    ctxClosed: 0,
    ctxState: overrides?.ctxState ?? "running",
    resumeKeepsSuspended: overrides?.resumeKeepsSuspended ?? false,
    wakeLockReleased: 0,
    getUserMediaCalls: 0,
    nextGetUserMediaError: null,
    holdGetUserMedia: false,
    emitWorkletBlock(pcm, rms) {
      workletPortOnMessage?.({
        data: { pcm, rms: rms ?? computeRms(pcm) },
      } as MessageEvent<VoiceWorkletOut>);
    },
    emitScriptBlock(pcm) {
      scriptOnAudioProcess?.({
        inputBuffer: { getChannelData: () => pcm },
      } as unknown as AudioProcessingEvent);
    },
    endTrack() {
      trackEndListener?.();
    },
    releaseGetUserMedia() {
      if (heldResolve) {
        const r = heldResolve;
        heldResolve = null;
        r(makeStream());
      }
    },
    createOptions() {
      return {
        getUserMedia: () => {
          env.getUserMediaCalls++;
          if (env.nextGetUserMediaError) {
            const err = env.nextGetUserMediaError;
            env.nextGetUserMediaError = null;
            return Promise.reject(err);
          }
          if (env.holdGetUserMedia) {
            return new Promise<MediaStream>((resolve) => {
              heldResolve = resolve;
            });
          }
          return Promise.resolve(makeStream());
        },
        createAudioContext: () => makeAudioContext(),
        createAudioWorkletNode: (_ctx, _name) => {
          const node = {
            port: {
              get onmessage() {
                return workletPortOnMessage;
              },
              set onmessage(fn: ((ev: MessageEvent<VoiceWorkletOut>) => void) | null) {
                workletPortOnMessage = fn;
              },
              postMessage: (msg: unknown) => {
                if (msg && typeof msg === "object" && (msg as { type?: string }).type === "flush") {
                  env.workletFlushCalls++;
                }
              },
            },
            connect: () => {},
            disconnect: () => {},
          };
          return node as unknown as AudioWorkletNode;
        },
        requestWakeLock: async () => {
          const sentinel = {
            released: false,
            type: "screen",
            release: async () => {
              sentinel.released = true;
              env.wakeLockReleased++;
            },
            onrelease: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          };
          return sentinel as unknown as WakeLockSentinel;
        },
      };
    },
  };

  function makeStream(): MediaStream {
    const track = {
      stop: () => {
        env.tracksStopped++;
      },
      addEventListener: (ev: string, fn: () => void) => {
        if (ev === "ended") trackEndListener = fn;
      },
      removeEventListener: (ev: string, fn: () => void) => {
        if (ev === "ended" && trackEndListener === fn) trackEndListener = null;
      },
    };
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
  }

  function makeAudioContext(): AudioContext {
    let localState: AudioContextState = env.ctxState;
    const stateListeners = new Set<() => void>();
    const ctx: any = {
      sampleRate: env.sampleRate,
      get state() {
        return localState;
      },
      destination: {},
      resume: async () => {
        if (!env.resumeKeepsSuspended) {
          localState = "running";
        }
      },
      close: async () => {
        localState = "closed";
        env.ctxClosed++;
      },
      addEventListener: (ev: string, fn: () => void) => {
        if (ev === "statechange") stateListeners.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        if (ev === "statechange") stateListeners.delete(fn);
      },
      createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
      createAnalyser: () => ({
        fftSize: 256,
        smoothingTimeConstant: 0.65,
        frequencyBinCount: 128,
        getByteFrequencyData: (arr: Uint8Array) => arr.fill(80),
        connect: () => {},
        disconnect: () => {},
      }),
      createGain: () => ({
        gain: { value: 1 },
        connect: () => {},
        disconnect: () => {},
      }),
      audioWorklet: env.useWorklet
        ? {
            addModule: async (url: string) => {
              env.workletAddedUrls.push(url);
              if (env.workletAddModuleThrows) {
                throw new Error("worklet blocked");
              }
            },
          }
        : undefined,
      createScriptProcessor: (_bufSize: number, _inCh: number, _outCh: number) => ({
        get onaudioprocess() {
          return scriptOnAudioProcess;
        },
        set onaudioprocess(fn: ((ev: AudioProcessingEvent) => void) | null) {
          scriptOnAudioProcess = fn;
        },
        connect: () => {},
        disconnect: () => {},
      }),
    };
    return ctx as AudioContext;
  }

  return env;
}

function makeMockTextarea(initialValue = "") {
  let value = initialValue;
  let selectionStart = initialValue.length;
  let selectionEnd = initialValue.length;
  let focusCalls = 0;
  let blurCalls = 0;
  return {
    get value() {
      return value;
    },
    set value(v: string) {
      value = v;
    },
    get selectionStart() {
      return selectionStart;
    },
    set selectionStart(n: number) {
      selectionStart = n;
    },
    get selectionEnd() {
      return selectionEnd;
    },
    set selectionEnd(n: number) {
      selectionEnd = n;
    },
    scrollTop: 12,
    focus: () => {
      focusCalls++;
    },
    blur: () => {
      blurCalls++;
    },
    setSelectionRange: (s: number, e: number) => {
      selectionStart = s;
      selectionEnd = e;
    },
    get focusCalls() {
      return focusCalls;
    },
    get blurCalls() {
      return blurCalls;
    },
  };
}

function createVoiceHarness(overrides?: {
  initialPrompt?: string;
  hostId?: string;
  sessionId?: string;
  authToken?: string;
  isMobile?: boolean;
  isReducedMotion?: boolean;
  isSecureContext?: boolean;
  hasMediaDevices?: boolean;
  audio?: Partial<Parameters<typeof createMockAudioEnv>[0]>;
  workletFlushWaitMs?: number;
  mobileIdleTerminateMs?: number;
}) {
  const clock = new FakeClock();
  const audio = createMockAudioEnv(overrides?.audio);
  const workers: MockVoiceWorker[] = [];
  const toasts: Array<{ message: string; kind?: "ok" | "err" }> = [];
  const auroraEvents: Array<{ type: string; value?: unknown }> = [];
  const textarea = makeMockTextarea(overrides?.initialPrompt ?? "");

  let hostId = overrides?.hostId ?? "host-1";
  let sessionId = overrides?.sessionId ?? "sess-1";
  let prompt = overrides?.initialPrompt ?? "";
  let caret = prompt.length;
  let isMobileVal = overrides?.isMobile ?? false;
  let reducedVal = overrides?.isReducedMotion ?? false;
  let secureVal = overrides?.isSecureContext ?? true;
  let mediaVal = overrides?.hasMediaDevices ?? true;
  let beforeStartCount = 0;

  let voice!: VoiceController;
  let dispose!: () => void;

  clientMod.createRoot((d) => {
    dispose = d;
    voice = clientMod.createVoiceController({
      getHostId: () => hostId,
      getSessionId: () => sessionId,
      getInputPrompt: () => prompt,
      setInputPrompt: (v) => {
        prompt = v;
        textarea.value = v;
      },
      setCaret: (p) => {
        caret = p;
      },
      onBeforeStart: () => {
        beforeStartCount++;
      },
      onToast: (message, kind) => {
        toasts.push({ message, kind });
      },
      isMobile: () => isMobileVal,
      isReducedMotion: () => reducedVal,
      getAuthToken: () => overrides?.authToken ?? "bearer-secret-token",
      getTextarea: () => textarea as unknown as HTMLTextAreaElement,
      isSecureContext: () => secureVal,
      hasMediaDevices: () => mediaVal,
      createWorker: () => {
        const w = new MockVoiceWorker();
        workers.push(w);
        return w;
      },
      ...audio.createOptions(),
      now: clock.now,
      scheduleFrame: clock.scheduleFrame,
      cancelFrame: clock.cancelFrame,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      workletFlushWaitMs: overrides?.workletFlushWaitMs ?? 20,
      mobileIdleTerminateMs: overrides?.mobileIdleTerminateMs ?? 10 * 60 * 1000,
    });
  });

  const aurora: VoiceAuroraHandlers = {
    setMode: (mode) => auroraEvents.push({ type: "mode", value: mode }),
    setProgress: (pct) => auroraEvents.push({ type: "progress", value: pct }),
    feedAudio: (_analyser, rms) => auroraEvents.push({ type: "audio", value: rms }),
    clearAudio: () => auroraEvents.push({ type: "clearAudio" }),
  };
  const unbindAurora = voice.registerAurora(aurora);

  return {
    voice,
    clock,
    audio,
    workers,
    currentWorker: () => workers[workers.length - 1]!,
    toasts,
    auroraEvents,
    textarea,
    getPrompt: () => prompt,
    setPrompt: (v: string) => {
      prompt = v;
      textarea.value = v;
    },
    getCaret: () => caret,
    setHostId: (h: string) => {
      hostId = h;
    },
    setSessionId: (s: string) => {
      sessionId = s;
    },
    setMobile: (m: boolean) => {
      isMobileVal = m;
    },
    setReducedMotion: (r: boolean) => {
      reducedVal = r;
    },
    setSecureContext: (s: boolean) => {
      secureVal = s;
    },
    setHasMediaDevices: (m: boolean) => {
      mediaVal = m;
    },
    getBeforeStartCount: () => beforeStartCount,
    unbindAurora,
    dispose,
  };
}

// Track global snapshot to guarantee zero leaked global DOM mutations
const initialGlobals = {
  hasWindow: "window" in globalThis,
  hasDocument: "document" in globalThis,
  hasLocalStorage: "localStorage" in globalThis,
};

let renderVoiceSsr!: (opts?: {
  withProvider?: boolean;
  voiceState?: VoiceState;
  statusText?: string;
  statusMeta?: string;
  downloadProgress?: number;
  revealWords?: string[];
  sessionStatus?: "idle" | "running";
  draftMode?: boolean;
  inputPrompt?: string;
}) => { toolbarHtml: string; composerHtml: string };

beforeAll(async () => {
  // 1) Client SolidJS bundle for reactive hooks (`useVoice` + `useBackNavigation`)
  const solidClientPath = join(process.cwd(), "node_modules", "solid-js", "dist", "solid.js");
  const clientEntryPath = join(
    process.cwd(),
    "web",
    "src",
    "indirect-code",
    "__client_voice_test_entry__.ts",
  );
  const clientBuild = await Bun.build({
    entrypoints: [clientEntryPath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "solid-client-voice-test-harness",
        setup(build) {
          build.onResolve({ filter: /__client_voice_test_entry__\.ts$/ }, () => ({
            path: clientEntryPath,
          }));
          build.onLoad({ filter: /__client_voice_test_entry__\.ts$/ }, () => ({
            contents: `
              export { batch, createRoot, createSignal } from "solid-js";
              export { createVoiceController } from "./voice/useVoice";
              export { createBackNavigation, projectNavLayers } from "./hooks/useBackNavigation";
            `,
            loader: "ts",
          }));
          build.onResolve({ filter: /^solid-js$/ }, () => ({
            path: solidClientPath,
          }));
        },
      },
    ],
  });
  if (!clientBuild.success || clientBuild.outputs.length === 0) {
    throw new Error(`Failed to bundle client voice harness: ${JSON.stringify(clientBuild.logs)}`);
  }
  const clientJs = await clientBuild.outputs[0]!.text();
  clientMod = await import(
    `data:text/javascript;base64,${Buffer.from(clientJs, "utf8").toString("base64")}`
  );

  // 2) SSR SolidJS bundle for `<Composer />`, `<ToolbarSend />`, and `<VoiceProvider />`
  const icDir = join(process.cwd(), "web", "src", "indirect-code");
  const ssrEntryPath = join(icDir, "__ssr_voice_ui_entry__.tsx");

  const ssrBuild = await Bun.build({
    entrypoints: [ssrEntryPath],
    target: "bun",
    format: "esm",
    external: ["solid-js", "solid-js/web", "@floating-ui/dom"],
    plugins: [
      {
        name: "voice-ui-ssr-test-plugin",
        setup(build) {
          build.onResolve({ filter: /__ssr_voice_ui_entry__\.tsx$/ }, () => ({
            path: ssrEntryPath,
          }));
          build.onLoad({ filter: /__ssr_voice_ui_entry__\.tsx$/ }, async () => {
            const entryCode = `
              import { renderToString } from "solid-js/web";
              import { RemoteCodeProvider } from "./ctx";
              import { Composer } from "./components/Composer";
              import { ToolbarSend } from "./components/composer/ToolbarSend";
              import { VoiceProvider } from "./voice/VoiceContext";

              function makeRemoteProps(opts = {}) {
                const sessionStatus = opts.sessionStatus || "idle";
                const draftMode = Boolean(opts.draftMode);
                const inputPrompt = opts.inputPrompt ?? "Draft text";
                return {
                  host: {
                    activeHost: () => ({ id: "h1", name: "Host", status: "online" }),
                    activeHostId: () => "h1",
                    hosts: () => [{ id: "h1", name: "Host", status: "online" }],
                    connectionState: () => "connected",
                    wsOpen: () => true,
                    send: () => {},
                  },
                  session: {
                    activeSessionId: () => (draftMode ? "" : "s1"),
                    activeSession: () => (draftMode ? null : { id: "s1", model: "claude-sonnet", status: sessionStatus, cwd: "/repo" }),
                    activeProject: () => ({ id: "p1", name: "proj", path: "/repo" }),
                    currentProject: () => ({ id: "p1", name: "proj", path: "/repo" }),
                    projects: () => [{ id: "p1", name: "proj", path: "/repo" }],
                    creatingSession: () => false,
                    draftMode: () => draftMode,
                    workspaceBlocked: () => false,
                    workspaceState: () => "available",
                    workspacePath: () => "/repo",
                    checkWorkspace: () => {},
                    setNewProjectModal: () => {},
                    openNewProjectModal: () => {},
                    pickProject: () => {},
                    setProjectMenuOpen: () => {},
                    projectMenuOpen: () => false,
                  },
                  transcript: {
                    sessionStatus: () => sessionStatus,
                    messages: () => [],
                    isAtBottom: () => true,
                    pinAtBottom: () => {},
                    reloadLatest: () => {},
                    historyHasNewer: () => false,
                    turnActivity: () => (sessionStatus === "running" ? { startedAt: 1, status: "running" } : null),
                    compactingText: () => "",
                    cancelCurrentTurn: () => {},
                    todos: () => [],
                    todosOpen: () => false,
                    toggleTodosOpen: () => {},
                    pendingApproval: () => null,
                    question: () => null,
                    activeQuestion: () => null,
                    turnClock: () => 0,
                    transcriptScroll: { isPinned: () => true, scrollToBottom: () => {} },
                  },
                  turnChanges: {
                    balloons: () => [],
                  },
                  composer: {
                    activeModel: () => "claude-sonnet",
                    activeModelName: () => "Claude Sonnet",
                    sending: () => false,
                    preparingAttachments: () => 0,
                    inputPrompt: () => inputPrompt,
                    setInputPrompt: () => {},
                    pendingAttachments: () => [],
                    removePendingAttachment: () => {},
                    handleFiles: () => {},
                    sendPrompt: () => {},
                    slashMatches: () => [],
                    slashIndex: () => 0,
                    setSlashIndex: () => {},
                    pickSlash: () => {},
                    dismissSlash: () => {},
                    mentions: {
                      open: () => false,
                      matches: () => [],
                      index: () => 0,
                      setFocused: () => {},
                      setCaret: () => {},
                      keyDown: () => false,
                      pick: () => {},
                      begin: () => {},
                    },
                    effort: () => "high",
                    effortPreviewing: () => false,
                    agentMode: () => "build",
                    setAgentMode: () => {},
                    configureSession: () => {},
                    selectedSkills: () => ["build"],
                    skillUsables: () => ({}),
                    syncSkills: () => {},
                    accessMode: () => "auto",
                    setAccessMode: () => {},
                    isFullAccess: () => false,
                    addContextOpen: () => false,
                    setAddContextOpen: () => {},
                    addContextSubView: () => "main",
                    setAddContextSubView: () => {},
                    modeMenuOpen: () => false,
                    setModeMenuOpen: () => {},
                    accessMenuOpen: () => false,
                    setAccessMenuOpen: () => {},
                    activeContext: () => ({ percent: 12, label: "24k / 200k (12%)", tokensLabel: "24k / 200k" }),
                    effortPickerBody: () => null,
                    modelPickerBody: () => null,
                  },
                  queue: {
                    queueOf: () => [],
                    stagedItems: () => [],
                    passiveItems: () => [],
                    queueCollapsed: () => ({}),
                  },
                  background: {
                    jobs: () => [],
                    sessionJobs: () => [],
                    running: () => [],
                    output: () => ({}),
                    clock: () => 0,
                  },
                  modal: {
                    previewPending: () => {},
                    openStoredPreview: () => {},
                    savedSkills: () => ({}),
                    skillsLoaded: () => false,
                    skillErrors: () => [],
                  },
                  ui: {
                    isMobile: () => false,
                    historyView: () => false,
                    composerCollapsed: () => false,
                    toggleComposerCollapsed: () => {},
                    convWidthClass: () => "max-w-3xl",
                    verboseChat: () => false,
                    hideToolMessages: () => false,
                    closeMenus: () => {},
                    effortMenuOpen: () => false,
                    setEffortMenuOpen: () => {},
                    modelMenuOpen: () => false,
                    setModelMenuOpen: () => {},
                    modelFromEffort: () => false,
                    setModelFromEffort: () => {},
                    usageOpen: () => false,
                    setUsageOpen: () => {},
                  },
                };
              }

              function makeMockVoice(opts = {}) {
                const st = opts.voiceState || "idle";
                const reveal = opts.revealWords?.length
                  ? { prefix: "Hi ", words: opts.revealWords, suffix: "", scrollTop: 0, active: true }
                  : null;
                return {
                  state: () => st,
                  isIdle: () => st === "idle",
                  isActive: () => st !== "idle",
                  supported: () => true,
                  modelReady: () => st !== "loading",
                  statusText: () => opts.statusText ?? (st === "listening" ? "Listening..." : st === "loading" ? "Downloading voice model..." : st === "thinking" ? "Transcribing..." : ""),
                  statusMeta: () => opts.statusMeta ?? (st === "listening" ? "0:03" : st === "loading" ? "42%" : ""),
                  downloadProgress: () => opts.downloadProgress ?? (st === "loading" ? 42 : 0),
                  reveal: () => reveal,
                  errorMessage: () => null,
                  energy: () => 0,
                  registerAurora: () => () => {},
                  start: () => {},
                  confirm: () => {},
                  cancel: () => {},
                  clearReveal: () => {},
                  captureSelection: () => {},
                  setComposerElement: () => {},
                };
              }

              export function renderVoiceSsr(opts = {}) {
                const props = makeRemoteProps(opts);
                const toolbarHtml = renderToString(() =>
                  opts.withProvider ? (
                    <RemoteCodeProvider {...props}>
                      <VoiceProvider value={makeMockVoice(opts)}>
                        <ToolbarSend />
                      </VoiceProvider>
                    </RemoteCodeProvider>
                  ) : (
                    <RemoteCodeProvider {...props}>
                      <ToolbarSend />
                    </RemoteCodeProvider>
                  ),
                );
                const composerHtml = renderToString(() =>
                  opts.withProvider ? (
                    <RemoteCodeProvider {...props}>
                      <VoiceProvider value={makeMockVoice(opts)}>
                        <Composer />
                      </VoiceProvider>
                    </RemoteCodeProvider>
                  ) : (
                    <RemoteCodeProvider {...props}>
                      <Composer />
                    </RemoteCodeProvider>
                  ),
                );
                return { toolbarHtml, composerHtml };
              }
            `;
            const transformed = await transformAsync(entryCode, {
              filename: ssrEntryPath,
              presets: [[solidPreset, { generate: "ssr", hydratable: false }]],
              babelrc: false,
              configFile: false,
            });
            return { contents: transformed?.code ?? entryCode, loader: "js" };
          });

          build.onResolve({ filter: /^virtual:icons$/ }, () => ({
            path: "virtual:icons",
            namespace: "virtual-icons",
          }));
          build.onLoad({ filter: /.*/, namespace: "virtual-icons" }, () => ({
            contents: "export const registry = {}; export const icons = {}; export default registry;",
            loader: "js",
          }));
          build.onResolve({ filter: /^sortablejs$/ }, () => ({
            path: "sortablejs",
            namespace: "ssr-sortable-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "ssr-sortable-stub" }, () => ({
            contents: "export default class Sortable { static create() { return { destroy() {} }; } }",
            loader: "js",
          }));
          build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));

          build.onLoad({ filter: /web[\\/]src[\\/]ui\.tsx$/ }, async (args) => {
            const uiStub = `
              export const accent = () => "teal";
              export const theme = () => "dark";
              export const themeMode = () => "dark";
              export function Badge(props: any) { return <span data-ui-badge>{props.children}</span>; }
              export function Btn(props: any) { return <button type="button">{props.children}</button>; }
              export async function copyWithToast() { return false; }
            `;
            const out = await transformAsync(uiStub, {
              filename: args.path,
              presets: [
                [solidPreset, { generate: "ssr", hydratable: false }],
                [tsPreset, { isTSX: true, allExtensions: true }],
              ],
              babelrc: false,
              configFile: false,
            });
            return { contents: out?.code ?? uiStub, loader: "js" };
          });

          build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
            if (
              args.path.endsWith("__ssr_voice_ui_entry__.tsx") ||
              /[\\/]web[\\/]src[\\/]ui\.tsx$/.test(args.path)
            ) {
              return undefined;
            }
            const code = await readFile(args.path, "utf8");
            const out = await transformAsync(code, {
              filename: args.path,
              presets: [
                [solidPreset, { generate: "ssr", hydratable: false }],
                [tsPreset, { isTSX: true, allExtensions: true }],
              ],
              sourceMaps: false,
              babelrc: false,
              configFile: false,
            });
            return { contents: out?.code ?? code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!ssrBuild.success || ssrBuild.outputs.length === 0) {
    throw new Error(`Failed to bundle SSR voice harness: ${JSON.stringify(ssrBuild.logs)}`);
  }
  const ssrJs = await ssrBuild.outputs[0]!.text();
  // Temporarily hide any partial DOM stubs left by unrelated earlier test files
  // in the same `bun test` process so SSR bundle module init sees a clean server env.
  const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const prevWinDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (prevDocDesc) delete (globalThis as Record<string, unknown>).document;
  if (prevWinDesc) delete (globalThis as Record<string, unknown>).window;
  let ssrMod: { renderVoiceSsr: typeof renderVoiceSsr };
  try {
    ssrMod = await import(
      `data:text/javascript;base64,${Buffer.from(ssrJs, "utf8").toString("base64")}`
    );
  } finally {
    if (prevDocDesc) Object.defineProperty(globalThis, "document", prevDocDesc);
    if (prevWinDesc) Object.defineProperty(globalThis, "window", prevWinDesc);
  }
  renderVoiceSsr = ssrMod.renderVoiceSsr;
});

afterAll(() => {
  expect("window" in globalThis).toBe(initialGlobals.hasWindow);
  expect("document" in globalThis).toBe(initialGlobals.hasDocument);
  expect("localStorage" in globalThis).toBe(initialGlobals.hasLocalStorage);
});

describe("createVoiceController (`useVoice.ts`)", () => {
  test("full lifecycle (idle -> loading -> listening -> thinking -> idle) with AudioWorklet, authToken, and all 4 progress stages", async () => {
    const h = createVoiceHarness({ authToken: "tok-voice-123", initialPrompt: "" });
    expect(h.voice.state()).toBe("idle");
    expect(h.voice.isIdle()).toBe(true);
    expect(h.voice.supported()).toBe(true);

    h.voice.start();
    expect(h.getBeforeStartCount()).toBe(1);
    expect(h.textarea.blurCalls).toBe(1);
    expect(h.voice.state()).toBe("loading");
    expect(h.voice.isActive()).toBe(true);

    const w = h.currentWorker();
    expect(w.sent.length).toBe(1);
    expect(w.sent[0]).toEqual({ type: "load", loadId: 1, authToken: "tok-voice-123" });

    // All 4 load progress stages
    w.emit({
      type: "progress",
      loadId: 1,
      progress: { stage: "server-warming", loaded: 20, total: 100, pct: 20 },
    });
    expect(h.voice.statusText()).toBe("Preparing voice…");
    expect(h.voice.statusMeta()).toBe("20%");
    expect(h.voice.downloadProgress()).toBe(20);

    w.emit({
      type: "progress",
      loadId: 1,
      progress: { stage: "downloading", loaded: 100 * 1024 * 1024, total: 200 * 1024 * 1024, pct: 50 },
    });
    expect(h.voice.statusText()).toBe("Downloading voice model…");
    expect(h.voice.statusMeta()).toBe("50% · 100/200 MB");
    expect(h.voice.downloadProgress()).toBe(50);

    w.emit({
      type: "progress",
      loadId: 1,
      progress: { stage: "initializing", loaded: 200, total: 200, pct: 95 },
    });
    expect(h.voice.statusText()).toBe("Preparing voice engine…");
    expect(h.voice.statusMeta()).toBe("Almost ready");

    w.emit({
      type: "progress",
      loadId: 1,
      progress: { stage: "warming", loaded: 200, total: 200, pct: 99 },
    });
    expect(h.voice.statusText()).toBe("Preparing voice engine…");
    expect(h.voice.statusMeta()).toBe("Almost ready");

    // Ready -> opens mic & worklet -> listening
    w.emit({ type: "ready", loadId: 1, fromCache: false, threads: 1 });
    await flushMicrotasks();

    expect(h.voice.modelReady()).toBe(true);
    expect(h.voice.state()).toBe("listening");
    expect(h.voice.statusText()).toBe("Listening…");
    expect(h.voice.statusMeta()).toBe("0:00");
    expect(h.audio.workletAddedUrls).toEqual(["workers/voice-worklet.js"]);

    // Feed 500ms of 440Hz audio at 48 kHz and advance clock past 260ms guard
    const block = makeSine(440, 48_000, 24_000, 0.25);
    h.audio.emitWorkletBlock(block);
    h.clock.runFramesOnce();
    expect(h.voice.energy()).toBeGreaterThan(0);
    expect(h.auroraEvents.some((e) => e.type === "audio")).toBe(true);

    h.clock.advance(1_100);
    expect(h.voice.statusMeta()).toBe("0:01");

    // Confirm -> thinking -> flush worklet -> teardown mic immediately -> dispatch transcribe
    h.voice.confirm();
    expect(h.voice.state()).toBe("thinking");
    expect(h.voice.statusText()).toBe("Transcribing…");
    expect(h.audio.workletFlushCalls).toBe(1);

    h.clock.advance(25);
    await flushMicrotasks();

    // Hardware released BEFORE inference completes
    expect(h.audio.tracksStopped).toBe(1);
    expect(h.audio.ctxClosed).toBe(1);
    expect(h.audio.wakeLockReleased).toBe(1);

    const transcribeMsg = w.sent.find((m) => m.type === "transcribe");
    expect(transcribeMsg).toBeDefined();
    if (!transcribeMsg || transcribeMsg.type !== "transcribe") throw new Error("missing transcribe");
    expect(transcribeMsg.isFinal).toBe(true);
    expect(transcribeMsg.chunkIdx).toBe(0);
    // 24000 samples @ 48 kHz -> ~8000 samples @ 16 kHz
    expect(transcribeMsg.audio.length).toBeGreaterThan(6_500);
    expect(transcribeMsg.audio.length).toBeLessThan(8_500);

    w.emit({
      type: "transcribe_done",
      jobId: transcribeMsg.jobId,
      sessionGen: transcribeMsg.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "hello type script",
      latencyMs: 42,
      audioDurationS: 0.5,
    });
    await flushMicrotasks();

    expect(h.voice.state()).toBe("idle");
    expect(h.getPrompt()).toBe("Hello TypeScript");
    expect(h.getCaret()).toBe("Hello TypeScript".length);
    expect(h.voice.reveal()?.active).toBe(true);
    expect(h.voice.reveal()?.words).toEqual(["Hello", "TypeScript"]);

    // After bloom timer completes, reveal clears and desktop textarea is focused
    h.clock.advance(1_000);
    expect(h.voice.reveal()).toBeNull();
    expect(h.textarea.focusCalls).toBe(1);

    h.dispose();
  });

  test("ScriptProcessorNode fallback path when AudioWorklet is unavailable or addModule fails", async () => {
    const h = createVoiceHarness({ audio: { useWorklet: true, sampleRate: 48_000 } });
    h.audio.workletAddModuleThrows = true;

    h.voice.start();
    const w = h.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();

    expect(h.voice.state()).toBe("listening");
    // Feed 0.4s speech via ScriptProcessorNode
    h.audio.emitScriptBlock(makeSine(440, 48_000, 19_200, 0.25));
    h.clock.advance(450);

    h.voice.confirm();
    await flushMicrotasks();

    expect(h.audio.workletFlushCalls).toBe(0);
    const job = w.sent.find((m) => m.type === "transcribe");
    expect(job).toBeDefined();
    if (!job || job.type !== "transcribe") throw new Error("missing job");

    w.emit({
      type: "transcribe_done",
      jobId: job.jobId,
      sessionGen: job.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "fallback works",
      latencyMs: 12,
      audioDurationS: 0.4,
    });
    await flushMicrotasks();

    expect(h.getPrompt()).toBe("Fallback works");
    expect(h.voice.state()).toBe("idle");
    h.dispose();

    // Also when audioWorklet is completely absent (undefined)
    const h2 = createVoiceHarness({ audio: { useWorklet: false, sampleRate: 44_100 } });
    h2.voice.start();
    const w2 = h2.currentWorker();
    w2.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();
    expect(h2.voice.state()).toBe("listening");
    expect(h2.audio.workletAddedUrls.length).toBe(0);
    h2.audio.emitScriptBlock(makeSine(440, 44_100, 17_640, 0.25));
    h2.clock.advance(450);
    h2.voice.confirm();
    await flushMicrotasks();
    const job2 = w2.sent.find((m) => m.type === "transcribe")!;
    if (job2.type !== "transcribe") throw new Error("missing job2");
    w2.emit({
      type: "transcribe_done",
      jobId: job2.jobId,
      sessionGen: job2.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "no worklet api works",
      latencyMs: 11,
      audioDurationS: 0.4,
    });
    await flushMicrotasks();
    expect(h2.getPrompt()).toBe("No worklet API works");
    h2.dispose();
  });

  test("synchronous idle -> starting double-click race guard ignores duplicate start()", async () => {
    const h = createVoiceHarness();
    // 1) Guard while loading
    h.voice.start();
    h.voice.start();
    expect(h.currentWorker().sent.filter((m) => m.type === "load").length).toBe(1);

    h.currentWorker().emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();
    h.voice.cancel();
    expect(h.voice.state()).toBe("idle");
    expect(h.voice.modelReady()).toBe(true);

    // 2) Guard during synchronous idle -> starting while awaiting getUserMedia
    const prevCalls = h.audio.getUserMediaCalls;
    h.audio.holdGetUserMedia = true;
    h.voice.start();
    expect(h.voice.state()).toBe("starting");
    h.voice.start(); // second click while awaiting getUserMedia -> ignored!
    expect(h.audio.getUserMediaCalls).toBe(prevCalls + 1);

    h.audio.releaseGetUserMedia();
    await flushMicrotasks();
    expect(h.voice.state()).toBe("listening");
    h.dispose();
  });

  test("insecure context emits HTTPS/localhost toast and stays idle without spawning worker", () => {
    const h = createVoiceHarness({ isSecureContext: false });
    expect(h.voice.supported()).toBe(false);

    h.voice.start();
    expect(h.voice.state()).toBe("idle");
    expect(h.workers.length).toBe(0);
    expect(h.audio.getUserMediaCalls).toBe(0);
    expect(h.toasts).toEqual([{ message: "Voice input requires HTTPS or localhost", kind: "err" }]);
    expect(h.voice.errorMessage()).toBe("Voice input requires HTTPS or localhost");
    h.dispose();
  });

  test("48 kHz -> 16 kHz resampling + pause pre-chunking (>=3.5s speech + >=720ms pause) + out-of-order chunk merge 0..N-1", async () => {
    const h = createVoiceHarness({ audio: { sampleRate: 48_000 } });
    h.voice.start();
    const w = h.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();

    // Feed 3.7s of 440Hz speech at 48 kHz in 1024-sample worklet blocks
    const speechBlock = makeSine(440, 48_000, 1024, 0.25);
    const silenceBlock = new Float32Array(1024);
    for (let i = 0; i < 175; i++) {
      h.audio.emitWorkletBlock(speechBlock);
    }
    // Feed 800ms of silence -> triggers pre-chunk #0 automatically!
    for (let i = 0; i < 40; i++) {
      h.audio.emitWorkletBlock(silenceBlock, 0);
    }

    const jobsAfterPause = w.sent.filter((m) => m.type === "transcribe");
    expect(jobsAfterPause.length).toBe(1);
    const job0 = jobsAfterPause[0]!;
    if (job0.type !== "transcribe") throw new Error("expected transcribe");
    expect(job0.chunkIdx).toBe(0);
    expect(job0.isFinal).toBe(false);
    // ~3.7s speech @ 16kHz + VAD padding (~60k samples)
    expect(job0.audio.length).toBeGreaterThan(50_000);
    expect(job0.audio.length).toBeLessThan(70_000);

    // Speak second phrase (1.0s) and confirm
    for (let i = 0; i < 48; i++) {
      h.audio.emitWorkletBlock(speechBlock);
    }
    h.clock.advance(5_500);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();

    const allJobs = w.sent.filter((m) => m.type === "transcribe");
    expect(allJobs.length).toBe(2);
    const job1 = allJobs[1]!;
    if (job1.type !== "transcribe") throw new Error("expected transcribe");
    expect(job1.chunkIdx).toBe(1);
    expect(job1.isFinal).toBe(true);

    // Resolve OUT OF ORDER: chunk 1 arrives BEFORE chunk 0!
    w.emit({
      type: "transcribe_done",
      jobId: job1.jobId,
      sessionGen: job1.sessionGen,
      chunkIdx: 1,
      isFinal: true,
      text: "second chunk",
      latencyMs: 15,
      audioDurationS: 1.0,
    });
    await flushMicrotasks();
    expect(h.voice.state()).toBe("thinking"); // still awaiting chunk 0

    w.emit({
      type: "transcribe_done",
      jobId: job0.jobId,
      sessionGen: job0.sessionGen,
      chunkIdx: 0,
      isFinal: false,
      text: "first chunk",
      latencyMs: 30,
      audioDurationS: 3.7,
    });
    await flushMicrotasks();

    expect(h.voice.state()).toBe("idle");
    expect(h.getPrompt()).toBe("First chunk second chunk");
    h.dispose();
  });

  test("<260ms accidental tap guard cancels cleanly and emits guidance toast", async () => {
    const h = createVoiceHarness();
    h.voice.start();
    const w = h.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();

    h.audio.emitWorkletBlock(makeSine(440, 48_000, 4800, 0.25));
    h.clock.advance(120); // < 260ms
    h.voice.confirm();

    expect(h.voice.state()).toBe("idle");
    expect(w.sent.some((m) => m.type === "transcribe")).toBe(false);
    expect(h.toasts.at(-1)).toEqual({ message: "Hold or speak a bit longer", kind: "ok" });
    expect(h.audio.tracksStopped).toBe(1);
    h.dispose();
  });

  test("partial and total chunk failures surface errors instead of silent drops", async () => {
    const h = createVoiceHarness({ audio: { sampleRate: 48_000 } });
    h.voice.start();
    const w = h.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();

    // 1) Partial failure: pre-chunk #0 succeeds, final chunk #1 fails
    const speechBlock = makeSine(440, 48_000, 1024, 0.25);
    const silenceBlock = new Float32Array(1024);
    for (let i = 0; i < 175; i++) h.audio.emitWorkletBlock(speechBlock);
    for (let i = 0; i < 40; i++) h.audio.emitWorkletBlock(silenceBlock, 0);
    for (let i = 0; i < 40; i++) h.audio.emitWorkletBlock(speechBlock);
    h.clock.advance(5_000);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();

    const [j0, j1] = w.sent.filter((m) => m.type === "transcribe");
    if (!j0 || j0.type !== "transcribe" || !j1 || j1.type !== "transcribe") throw new Error("missing jobs");

    w.emit({
      type: "transcribe_done",
      jobId: j0.jobId,
      sessionGen: j0.sessionGen,
      chunkIdx: 0,
      isFinal: false,
      text: "kept portion",
      latencyMs: 20,
      audioDurationS: 3.6,
    });
    w.emit({
      type: "error",
      phase: "transcribe",
      jobId: j1.jobId,
      sessionGen: j1.sessionGen,
      error: "ORT OOM on tail chunk",
    });
    await flushMicrotasks();

    expect(h.voice.state()).toBe("idle");
    expect(h.getPrompt()).toBe("Kept portion");
    expect(h.toasts.some((t) => t.kind === "err" && t.message === "Part of your recording could not be transcribed")).toBe(true);

    // 2) Total failure: single chunk fails -> error toast, draft unchanged
    h.setPrompt("Untouched draft");
    h.toasts.length = 0;
    h.voice.start();
    await flushMicrotasks();
    for (let i = 0; i < 30; i++) h.audio.emitWorkletBlock(speechBlock);
    h.clock.advance(600);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();

    const j2 = w.sent.filter((m) => m.type === "transcribe").at(-1)!;
    if (j2.type !== "transcribe") throw new Error("missing j2");
    w.emit({
      type: "error",
      phase: "transcribe",
      jobId: j2.jobId,
      sessionGen: j2.sessionGen,
      error: "Decoder inference crashed",
    });
    await flushMicrotasks();

    expect(h.voice.state()).toBe("idle");
    expect(h.getPrompt()).toBe("Untouched draft");
    expect(h.voice.errorMessage()).toBe("Decoder inference crashed");
    expect(h.toasts.at(-1)).toEqual({ message: "Decoder inference crashed", kind: "err" });
    h.dispose();
  });

  test("cancel() aborts mid-loading, mid-listening, and mid-thinking cleanly", async () => {
    const h = createVoiceHarness({ initialPrompt: "Keep draft" });

    // Mid-loading
    h.voice.start();
    const w = h.currentWorker();
    expect(h.voice.state()).toBe("loading");
    h.voice.cancel();
    expect(h.voice.state()).toBe("idle");
    expect(w.sent.some((m) => m.type === "abort_load")).toBe(true);
    expect(h.getPrompt()).toBe("Keep draft");

    // Mid-listening
    h.voice.start();
    const load2 = w.sent.filter((m) => m.type === "load").at(-1)!;
    if (load2.type !== "load") throw new Error("missing load2");
    w.emit({ type: "ready", loadId: load2.loadId, fromCache: true, threads: 1 });
    await flushMicrotasks();
    expect(h.voice.state()).toBe("listening");

    h.voice.cancel();
    expect(h.voice.state()).toBe("idle");
    expect(h.audio.tracksStopped).toBe(1);
    expect(h.audio.ctxClosed).toBe(1);
    expect(w.sent.some((m) => m.type === "cancel_session")).toBe(true);
    expect(h.getPrompt()).toBe("Keep draft");

    // Mid-thinking
    h.voice.start();
    await flushMicrotasks();
    h.audio.emitWorkletBlock(makeSine(440, 48_000, 24_000, 0.25));
    h.clock.advance(500);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();
    expect(h.voice.state()).toBe("thinking");
    const txJob = w.sent.filter((m) => m.type === "transcribe").at(-1)!;
    if (txJob.type !== "transcribe") throw new Error("missing txJob");

    h.voice.cancel();
    expect(h.voice.state()).toBe("idle");
    // Late transcribe_done must be completely ignored
    w.emit({
      type: "transcribe_done",
      jobId: txJob.jobId,
      sessionGen: txJob.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "stale leak",
      latencyMs: 10,
      audioDurationS: 0.5,
    });
    await flushMicrotasks();
    expect(h.getPrompt()).toBe("Keep draft");
    h.dispose();
  });

  test("session or host switch drops in-flight transcript and never leaks into another session's draft", async () => {
    const h = createVoiceHarness({ hostId: "host-a", sessionId: "sess-a", initialPrompt: "Session A" });
    h.voice.start();
    const w = h.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();

    h.audio.emitWorkletBlock(makeSine(440, 48_000, 24_000, 0.25));
    h.clock.advance(500);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();
    const job = w.sent.find((m) => m.type === "transcribe")!;
    if (job.type !== "transcribe") throw new Error("missing job");

    // Switch session BEFORE worker replies (even without explicit cancel())
    h.setSessionId("sess-b");
    h.setPrompt("Session B draft");

    w.emit({
      type: "transcribe_done",
      jobId: job.jobId,
      sessionGen: job.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "dictated in session A",
      latencyMs: 10,
      audioDurationS: 0.5,
    });
    await flushMicrotasks();

    expect(h.voice.state()).toBe("idle");
    expect(h.getPrompt()).toBe("Session B draft");

    // Repeat for host switch
    h.voice.start();
    await flushMicrotasks();
    h.audio.emitWorkletBlock(makeSine(440, 48_000, 24_000, 0.25));
    h.clock.advance(500);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();
    const job2 = w.sent.filter((m) => m.type === "transcribe").at(-1)!;
    if (job2.type !== "transcribe") throw new Error("missing job2");

    h.setHostId("host-b");
    h.setPrompt("Host B draft");
    w.emit({
      type: "transcribe_done",
      jobId: job2.jobId,
      sessionGen: job2.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "dictated on host A",
      latencyMs: 10,
      audioDurationS: 0.5,
    });
    await flushMicrotasks();

    expect(h.voice.state()).toBe("idle");
    expect(h.getPrompt()).toBe("Host B draft");
    h.dispose();
  });

  test("iOS user-gesture expiry after first model download recovers cleanly and allows immediate second tap", async () => {
    const h = createVoiceHarness();
    const notAllowed = new Error("Permission expired");
    notAllowed.name = "NotAllowedError";
    h.audio.nextGetUserMediaError = notAllowed;

    h.voice.start();
    const w = h.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: false, threads: 1 });
    await flushMicrotasks();

    // Soft recovery: NOT an error toast; model stays loaded
    expect(h.voice.state()).toBe("idle");
    expect(h.voice.modelReady()).toBe(true);
    expect(h.toasts.at(-1)).toEqual({ message: "Voice ready — tap the mic to start", kind: "ok" });

    // Second tap skips model load and enters listening directly
    h.voice.start();
    await flushMicrotasks();
    expect(h.voice.state()).toBe("listening");
    expect(w.sent.filter((m) => m.type === "load").length).toBe(1);

    // Contrast: real NotAllowedError when model is ALREADY ready surfaces error toast
    h.voice.cancel();
    const realDenied = new Error("User denied mic");
    realDenied.name = "NotAllowedError";
    h.audio.nextGetUserMediaError = realDenied;
    h.voice.start();
    await flushMicrotasks();
    expect(h.voice.state()).toBe("idle");
    expect(h.toasts.at(-1)).toEqual({ message: "Microphone permission denied", kind: "err" });

    h.dispose();

    // Suspended AudioContext after first model load also recovers softly on iOS
    const hs = createVoiceHarness({
      audio: { ctxState: "suspended", resumeKeepsSuspended: true },
    });
    hs.voice.start();
    hs.currentWorker().emit({ type: "ready", loadId: 1, fromCache: false, threads: 1 });
    await flushMicrotasks();
    expect(hs.voice.state()).toBe("idle");
    expect(hs.voice.modelReady()).toBe(true);
    expect(hs.toasts.at(-1)).toEqual({ message: "Voice ready — tap the mic to start", kind: "ok" });
    hs.dispose();
  });

  test("word bloom reveal, clearReveal(), reducedMotion skipping bloom, mobile no-autofocus, 10-min mobile idle termination, and onCleanup teardown", async () => {
    // 1) clearReveal() + reducedMotion skipping bloom
    const h = createVoiceHarness({ isReducedMotion: false, isMobile: false });
    h.voice.start();
    let w = h.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();

    h.audio.emitWorkletBlock(makeSine(440, 48_000, 24_000, 0.25));
    h.clock.advance(500);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();
    let job = w.sent.filter((m) => m.type === "transcribe").at(-1)!;
    if (job.type !== "transcribe") throw new Error("missing job");
    w.emit({
      type: "transcribe_done",
      jobId: job.jobId,
      sessionGen: job.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "bloom words here",
      latencyMs: 10,
      audioDurationS: 0.5,
    });
    await flushMicrotasks();

    expect(h.voice.reveal()?.active).toBe(true);
    expect(h.voice.reveal()?.words).toEqual(["Bloom", "words", "here"]);
    h.voice.clearReveal();
    expect(h.voice.reveal()).toBeNull();

    // 2) reducedMotion skips bloom AND focuses desktop textarea
    h.setReducedMotion(true);
    h.setPrompt("");
    h.voice.start();
    await flushMicrotasks();
    h.audio.emitWorkletBlock(makeSine(440, 48_000, 24_000, 0.25));
    h.clock.advance(500);
    h.voice.confirm();
    h.clock.advance(25);
    await flushMicrotasks();
    job = w.sent.filter((m) => m.type === "transcribe").at(-1)!;
    if (job.type !== "transcribe") throw new Error("missing job");
    w.emit({
      type: "transcribe_done",
      jobId: job.jobId,
      sessionGen: job.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "no bloom under reduced motion",
      latencyMs: 10,
      audioDurationS: 0.5,
    });
    await flushMicrotasks();
    expect(h.voice.reveal()).toBeNull();
    expect(h.textarea.focusCalls).toBe(1);

    // Desktop does NOT terminate idle worker after 10 min
    h.clock.advance(11 * 60 * 1000);
    expect(w.terminated).toBe(false);
    expect(h.voice.modelReady()).toBe(true);
    h.dispose();

    // 3) Mobile: does NOT auto-focus textarea & terminates worker after 10 min idle
    const hm = createVoiceHarness({ isMobile: true, isReducedMotion: true });
    hm.voice.start();
    w = hm.currentWorker();
    w.emit({ type: "ready", loadId: 1, fromCache: true, threads: 1 });
    await flushMicrotasks();

    hm.audio.emitWorkletBlock(makeSine(440, 48_000, 24_000, 0.25));
    hm.clock.advance(500);
    hm.voice.confirm();
    hm.clock.advance(25);
    await flushMicrotasks();
    job = w.sent.filter((m) => m.type === "transcribe").at(-1)!;
    if (job.type !== "transcribe") throw new Error("missing job");
    w.emit({
      type: "transcribe_done",
      jobId: job.jobId,
      sessionGen: job.sessionGen,
      chunkIdx: 0,
      isFinal: true,
      text: "mobile dictation",
      latencyMs: 10,
      audioDurationS: 0.5,
    });
    await flushMicrotasks();

    expect(hm.getPrompt()).toBe("Mobile dictation");
    expect(hm.textarea.focusCalls).toBe(0); // mobile must not pop up virtual keyboard

    // Advance 9m59s -> worker still alive; advance 2s more -> terminated!
    hm.clock.advance(10 * 60 * 1000 - 1_000);
    expect(w.terminated).toBe(false);
    hm.clock.advance(2_000);
    expect(w.terminated).toBe(true);
    expect(hm.voice.modelReady()).toBe(false);

    // 4) onCleanup teardown while actively listening releases mic, AudioContext, WakeLock, worker, timers
    hm.voice.start();
    const w2 = hm.currentWorker();
    const loadMsg = w2.sent.find((m) => m.type === "load")!;
    if (loadMsg.type !== "load") throw new Error("missing load");
    w2.emit({ type: "ready", loadId: loadMsg.loadId, fromCache: true, threads: 1 });
    await flushMicrotasks();
    expect(hm.voice.state()).toBe("listening");

    const stoppedBefore = hm.audio.tracksStopped;
    const closedBefore = hm.audio.ctxClosed;
    hm.dispose();

    expect(hm.audio.tracksStopped).toBe(stoppedBefore + 1);
    expect(hm.audio.ctxClosed).toBe(closedBefore + 1);
    expect(w2.terminated).toBe(true);
    expect(hm.clock.pendingTimersCount()).toBe(0);
    expect(hm.clock.pendingFramesCount()).toBe(0);
  });
});

// ===========================================================================
// 4. Back Navigation `mode:voice` Layer (`useBackNavigation.ts`)
// ===========================================================================

describe("useBackNavigation mode:voice top-priority layer", () => {
  function baseState(overrides: Partial<NavProjectionState> = {}): NavProjectionState {
    return {
      hostsCount: 1,
      hasPairingData: false,
      overlaySidebar: true,
      updating: false,
      sidebarOpen: false,
      historyView: false,
      selectionMode: false,
      renamingId: null,
      editingMsgIdx: null,
      editingQueueId: null,
      fullscreenWidget: false,
      showConfigModal: false,
      showNewProjectModal: false,
      folderNavDepth: 0,
      showPairModal: false,
      hasPreviewFile: false,
      showPreviewSlicer: false,
      hasChoiceModal: false,
      hasConfirmModal: false,
      modeMenuOpen: false,
      accessMenuOpen: false,
      hostMenuOpen: false,
      newProjectMenuOpen: false,
      addContextOpen: false,
      isMobile: true,
      addContextSubView: "main",
      effortMenuOpen: false,
      modelMenuOpen: false,
      modelFromEffort: false,
      projectMenuOpen: false,
      usageOpen: false,
      hasSessionMenu: false,
      hasProjectMenu: false,
      mentionsOpen: false,
      editMentionsOpen: false,
      slashOpen: false,
      voiceActive: false,
      ...overrides,
    };
  }

  function noopActions(overrides: Partial<NavLayerActions> = {}): NavLayerActions {
    const noop = () => {};
    return {
      clearPairingData: noop,
      openSidebar: noop,
      closeSidebar: noop,
      closeHistoryView: noop,
      openHistoryView: noop,
      exitSelectionMode: noop,
      cancelRename: noop,
      cancelEditMsg: noop,
      cancelEditQueue: noop,
      closeFullscreenWidget: noop,
      closeSettingsModal: () => true,
      openSettingsModal: () => true,
      closeNewProjectModal: noop,
      stepBackNewProjectFolder: noop,
      closePairModal: noop,
      closePreviewModal: noop,
      closePreviewSlicer: noop,
      cancelChoiceModal: noop,
      cancelConfirmModal: noop,
      closeModeMenu: noop,
      closeAccessMenu: noop,
      closeHostMenu: noop,
      closeNewProjectMenu: noop,
      closeAddContextMenu: noop,
      setAddContextSubView: noop,
      closeEffortMenu: noop,
      closeModelMenu: noop,
      closeModelAndEffortMenus: noop,
      stepBackModelToEffort: noop,
      closeProjectPickerMenu: noop,
      closeUsageMenu: noop,
      closeSessionContextMenu: noop,
      closeProjectActionsMenu: noop,
      dismissMentions: noop,
      dismissEditMentions: noop,
      dismissSlash: noop,
      ...overrides,
    };
  }

  test("projectNavLayers places mode:voice above menus, modals, and mobile-workspace", () => {
    let voiceCancelled = 0;
    const layers = clientMod.projectNavLayers(
      baseState({ showConfigModal: true, slashOpen: true, voiceActive: true }),
      noopActions({
        cancelVoice: () => {
          voiceCancelled++;
        },
      }),
    );
    expect(layers.map((l) => l.key)).toEqual([
      "mobile-workspace",
      "modal:settings",
      "menu:slash",
      "mode:voice",
    ]);
    layers.at(-1)!.pop();
    expect(voiceCancelled).toBe(1);

    // Without cancelVoice callback, layer is omitted safely
    const withoutCb = clientMod.projectNavLayers(baseState({ voiceActive: true }), noopActions());
    expect(withoutCb.some((l) => l.key === "mode:voice")).toBe(false);
  });

  test("hardware Back cancels active voice first without dismissing underlying layers", () => {
    const entries: Array<{ url: string; hash: string; state: unknown }> = [
      { url: "http://localhost/#/code", hash: "#/code", state: null },
    ];
    let idx = 0;
    const listeners = new Set<(e: PopStateEvent) => void>();
    const history: HistoryAdapter = {
      getState: () => entries[idx]?.state ?? null,
      getHref: () => entries[idx]?.url ?? "http://localhost/#/code",
      getHash: () => entries[idx]?.hash ?? "#/code",
      pushState: (data, _u, url) => {
        entries.splice(idx + 1);
        entries.push({ url: url ?? "http://localhost/#/code", hash: "#/code", state: structuredClone(data) });
        idx = entries.length - 1;
      },
      replaceState: (data, _u, url) => {
        entries[idx] = { url: url ?? "http://localhost/#/code", hash: "#/code", state: structuredClone(data) };
      },
      go: (delta) => {
        idx = Math.max(0, Math.min(entries.length - 1, idx + delta));
      },
      replaceLocation: () => {},
      addPopStateListener: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };

    let dispose!: () => void;
    let voiceActiveGetter!: () => boolean;
    let sidebarOpenGetter!: () => boolean;
    let setVoiceActive!: (v: boolean) => void;

    clientMod.createRoot((d) => {
      dispose = d;
      const [voiceActive, _setVoiceActive] = clientMod.createSignal(false);
      const [sidebarOpen, setSidebarOpen] = clientMod.createSignal(false);
      voiceActiveGetter = voiceActive;
      sidebarOpenGetter = sidebarOpen;
      setVoiceActive = _setVoiceActive;

      const opts: BackNavigationOptions = {
        readState: () => baseState({ sidebarOpen: sidebarOpen(), voiceActive: voiceActive() }),
        actions: noopActions({
          openSidebar: () => setSidebarOpen(true),
          closeSidebar: () => setSidebarOpen(false),
          cancelVoice: () => _setVoiceActive(false),
        }),
        history,
        bootId: "voice-back-test",
      };
      clientMod.createBackNavigation(opts);
    });

    // Stack: [0: root, 1: mobile-workspace]
    expect(idx).toBe(1);
    setVoiceActive(true);
    // Stack: [0: root, 1: mobile-workspace, 2: mode:voice]
    expect(idx).toBe(2);
    expect((history.getState() as { key?: string }).key).toBe("mode:voice");

    // Simulate hardware Back
    idx = 1;
    for (const fn of listeners) fn({ state: structuredClone(history.getState()) } as PopStateEvent);
    expect(voiceActiveGetter()).toBe(false);
    expect(sidebarOpenGetter()).toBe(false); // underlying mobile workspace untouched!

    dispose();
  });
});

// ===========================================================================
// 5. SSR Safety (`VoiceContext` + `<Composer />` + `<ToolbarSend />`)
// ===========================================================================

describe("Voice SSR safety", () => {
  test("renders <ToolbarSend /> and <Composer /> cleanly WITHOUT <VoiceProvider> (idle fallback)", () => {
    const { toolbarHtml, composerHtml } = renderVoiceSsr({ withProvider: false });
    expect(toolbarHtml).toContain("rc-composer-voice");
    expect(toolbarHtml).toContain("rc-voice-bars-svg");
    expect(toolbarHtml).toContain('aria-label="Start voice input"');
    expect(toolbarHtml).not.toContain(" title=");

    expect(composerHtml).toContain('data-voice-state="idle"');
    expect(composerHtml).not.toContain('data-voice-active="true"');
    expect(composerHtml).not.toContain("rc-voice-ambient");
    expect(composerHtml).toContain("rc-voice-aurora-canvas");
    expect(composerHtml).not.toContain(" title=");
  });

  test("renders <ToolbarSend /> and <Composer /> cleanly WITH <VoiceProvider> across loading, listening, thinking, and reveal", () => {
    const loading = renderVoiceSsr({
      withProvider: true,
      voiceState: "loading",
      statusText: "Downloading voice model...",
      statusMeta: "42% · 84/200 MB",
    });
    expect(loading.toolbarHtml).toContain("rc-composer-voice-cancel");
    expect(loading.toolbarHtml).toContain("rc-composer-voice-confirm");
    expect(loading.toolbarHtml).toContain("disabled");
    expect(loading.composerHtml).toContain('data-voice-active="true"');
    expect(loading.composerHtml).toContain('data-voice-state="loading"');
    expect(loading.composerHtml).toContain("rc-voice-ambient");
    expect(loading.composerHtml).toContain("Downloading voice model...");
    expect(loading.composerHtml).not.toContain("data-composer-collapse");

    const listening = renderVoiceSsr({
      withProvider: true,
      voiceState: "listening",
      statusText: "Listening...",
      statusMeta: "0:03",
    });
    expect(listening.composerHtml).toContain("rc-voice-live-dot");
    expect(listening.composerHtml).toContain("0:03");
    expect(listening.composerHtml).toContain('data-voice-state="listening"');

    const thinking = renderVoiceSsr({
      withProvider: true,
      voiceState: "thinking",
      statusText: "Transcribing...",
      statusMeta: "",
    });
    expect(thinking.composerHtml).toContain("Transcribing...");
    expect(thinking.composerHtml).toContain('data-voice-state="thinking"');

    const revealing = renderVoiceSsr({
      withProvider: true,
      voiceState: "idle",
      revealWords: ["Hello", "TypeScript"],
    });
    expect(revealing.composerHtml).toContain("rc-voice-word-bloom");
    expect(revealing.composerHtml).toContain("Hello");
    expect(revealing.composerHtml).toContain("TypeScript");
  });
});
