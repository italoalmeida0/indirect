/** Pure audio DSP utilities for 16 kHz mono speech recognition.
 * Zero DOM dependencies so every stage is deterministic and unit-testable.
 */

export const VOICE_SAMPLE_RATE = 16_000;

const SINC_HALF_ZERO_CROSSINGS = 8;
const SINC_TABLE_OVERSAMPLE = 64;
const ANTI_ALIAS_CUTOFF_HZ = 7_200;

const HPF_CUTOFF_HZ = 80;
const VAD_FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const VAD_MIN_FRAMES = 5;
const VAD_MIN_PEAK_RMS = 0.009;
const VAD_MIN_ACTIVE_FRAMES = 4;
const VAD_FLOOR_RMS = 0.008;
const VAD_PEAK_RATIO = 0.09;
const VAD_PRE_PAD_FRAMES = 9; // 180 ms
const VAD_POST_PAD_FRAMES = 11; // 220 ms
const NORM_TARGET_RMS = 0.11;
const NORM_MIN_GAIN = 0.55;
const NORM_MAX_GAIN = 7.5;
const LIMITER_KNEE = 0.85;
const LIMITER_HEADROOM = 0.14; // ceiling = 0.85 + 0.14 = 0.99

export interface AudioPreprocessResult {
  audio: Float32Array;
  rmsIn: number;
  rmsOut: number;
  gainDb: number;
  /** Duration of leading/trailing silence removed by VAD trimming, in milliseconds. */
  trimmedMs: number;
  hadSpeech: boolean;
}

export function computeRms(samples: Float32Array): number {
  const len = samples.length;
  if (len === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / len);
}

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    total += chunks[i]!.length;
  }
  if (total === 0) return new Float32Array(0);
  const out = new Float32Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Stateful streaming anti-aliased resampler to 16 kHz mono.
 *
 * Uses a precomputed Blackman-windowed sinc FIR kernel (cutoff ~7.2 kHz before
 * decimation) with continuous fractional phase across arbitrary chunk sizes,
 * eliminating aliasing and block-boundary phase jitter at 44.1 / 48 / 96 kHz.
 * Input already at 16 kHz passes straight through without filtering latency.
 */
export class StreamingResampler16k {
  readonly inputSampleRate: number;
  readonly outputSampleRate = VOICE_SAMPLE_RATE;

  private readonly passthrough: boolean;
  private readonly ratio: number;
  private readonly halfWidth: number;
  private readonly kernelTable: Float32Array;

  private buf: Float32Array;
  private bufLen: number;
  private totalInputSamples: number;
  private droppedInputSamples: number;
  private outputSampleIndex: number;

  constructor(inputSampleRate: number) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
      throw new RangeError(`Invalid inputSampleRate: ${inputSampleRate}`);
    }
    this.inputSampleRate = inputSampleRate;
    this.passthrough = Math.abs(inputSampleRate - VOICE_SAMPLE_RATE) < 1e-6;
    this.ratio = inputSampleRate / VOICE_SAMPLE_RATE;

    if (this.passthrough) {
      this.halfWidth = 0;
      this.kernelTable = new Float32Array(0);
      this.buf = new Float32Array(0);
      this.bufLen = 0;
      this.totalInputSamples = 0;
      this.droppedInputSamples = 0;
      this.outputSampleIndex = 0;
      return;
    }

    const cutoffHz = Math.min(ANTI_ALIAS_CUTOFF_HZ, 0.45 * Math.min(inputSampleRate, VOICE_SAMPLE_RATE));
    const scale = Math.min(1, (2 * cutoffHz) / inputSampleRate);
    this.halfWidth = Math.max(4, Math.ceil(SINC_HALF_ZERO_CROSSINGS / scale));

    const tableLen = this.halfWidth * SINC_TABLE_OVERSAMPLE + 2;
    const table = new Float32Array(tableLen);
    for (let i = 0; i < tableLen; i++) {
      const dist = i / SINC_TABLE_OVERSAMPLE;
      if (dist >= this.halfWidth) {
        table[i] = 0;
        continue;
      }
      const x = Math.PI * scale * dist;
      const sinc = x < 1e-8 ? 1 : Math.sin(x) / x;
      const u = dist / this.halfWidth;
      const window = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      table[i] = scale * sinc * window;
    }
    this.kernelTable = table;

    this.buf = new Float32Array(Math.max(4096, this.halfWidth * 4));
    this.bufLen = this.halfWidth;
    this.totalInputSamples = 0;
    this.droppedInputSamples = 0;
    this.outputSampleIndex = 0;
  }

  reset(): void {
    if (this.passthrough) return;
    this.buf.fill(0, 0, this.halfWidth);
    this.bufLen = this.halfWidth;
    this.totalInputSamples = 0;
    this.droppedInputSamples = 0;
    this.outputSampleIndex = 0;
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    if (this.passthrough) return input.slice();

    this.appendToBuffer(input);
    this.totalInputSamples += input.length;

    const localPos0 = this.localPositionFor(this.outputSampleIndex);
    const limit = this.bufLen - this.halfWidth;
    if (localPos0 >= limit) {
      return new Float32Array(0);
    }

    const estOut = Math.floor((limit - localPos0) / this.ratio) + 2;
    const out = new Float32Array(Math.max(0, estOut));
    let outIdx = 0;

    while (true) {
      const localPos = this.localPositionFor(this.outputSampleIndex);
      if (localPos + this.halfWidth >= this.bufLen) break;
      out[outIdx++] = this.interpolateAt(localPos);
      this.outputSampleIndex++;
    }

    const nextLocalPos = this.localPositionFor(this.outputSampleIndex);
    const drop = Math.max(0, Math.floor(nextLocalPos) - this.halfWidth);
    if (drop > 0) {
      const remaining = this.bufLen - drop;
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufLen = remaining;
      this.droppedInputSamples += drop;
    }

    return outIdx === out.length ? out : out.subarray(0, outIdx).slice();
  }

  /** Flushes remaining filter-tail samples corresponding to already-fed input, then resets state. */
  flush(): Float32Array {
    if (this.passthrough) return new Float32Array(0);
    if (
      this.totalInputSamples === 0 ||
      this.outputSampleIndex * this.inputSampleRate >= this.totalInputSamples * VOICE_SAMPLE_RATE
    ) {
      this.reset();
      return new Float32Array(0);
    }

    const pad = new Float32Array(this.halfWidth + 1);
    this.appendToBuffer(pad);

    const remainingOut =
      Math.ceil((this.totalInputSamples * VOICE_SAMPLE_RATE) / this.inputSampleRate) -
      this.outputSampleIndex;
    const out = new Float32Array(Math.max(0, remainingOut + 1));
    let outIdx = 0;

    while (this.outputSampleIndex * this.inputSampleRate < this.totalInputSamples * VOICE_SAMPLE_RATE) {
      const localPos = this.localPositionFor(this.outputSampleIndex);
      if (localPos + this.halfWidth >= this.bufLen) break;
      out[outIdx++] = this.interpolateAt(localPos);
      this.outputSampleIndex++;
    }

    this.reset();
    return outIdx === out.length ? out : out.subarray(0, outIdx).slice();
  }

  private localPositionFor(outIndex: number): number {
    return this.halfWidth + (outIndex * this.inputSampleRate) / VOICE_SAMPLE_RATE - this.droppedInputSamples;
  }

  private appendToBuffer(chunk: Float32Array): void {
    const needed = this.bufLen + chunk.length;
    if (needed > this.buf.length) {
      let nextCap = Math.max(4096, this.buf.length * 2);
      while (nextCap < needed) nextCap *= 2;
      const grown = new Float32Array(nextCap);
      grown.set(this.buf.subarray(0, this.bufLen), 0);
      this.buf = grown;
    }
    this.buf.set(chunk, this.bufLen);
    this.bufLen = needed;
  }

  private interpolateAt(position: number): number {
    const center = Math.floor(position);
    const start = center - this.halfWidth + 1;
    const end = center + this.halfWidth;
    const table = this.kernelTable;
    const buf = this.buf;

    let acc = 0;
    let weightSum = 0;

    for (let k = start; k <= end; k++) {
      const dist = Math.abs(position - k);
      const t = dist * SINC_TABLE_OVERSAMPLE;
      const ti = t | 0;
      const tf = t - ti;
      const w0 = table[ti]!;
      const w = w0 + (table[ti + 1]! - w0) * tf;
      acc += buf[k]! * w;
      weightSum += w;
    }

    return weightSum > 1e-9 ? acc / weightSum : 0;
  }
}

/** Pre-inference speech conditioning pipeline (16 kHz mono):
 * 1. 1st-order 80 Hz high-pass filter
 * 2. 20 ms frame RMS VAD with 180 ms pre-pad / 220 ms post-pad edge trimming
 * 3. Active-frame RMS normalization to 0.11 with gain clamped to [0.55, 7.5]
 * 4. Soft tanh limiter above 0.85 (ceiling 0.99)
 */
export function preprocessAudioForAsr(raw16k: Float32Array): AudioPreprocessResult {
  const rmsIn = computeRms(raw16k);
  const rawMs = (raw16k.length / VOICE_SAMPLE_RATE) * 1000;

  if (raw16k.length < VAD_FRAME_SAMPLES * VAD_MIN_FRAMES) {
    return {
      audio: new Float32Array(0),
      rmsIn,
      rmsOut: 0,
      gainDb: 0,
      trimmedMs: rawMs,
      hadSpeech: false,
    };
  }

  // 1. 1st-order 80 Hz high-pass filter
  const rc = 1 / (2 * Math.PI * HPF_CUTOFF_HZ);
  const dt = 1 / VOICE_SAMPLE_RATE;
  const alpha = rc / (rc + dt);
  const hp = new Float32Array(raw16k.length);
  for (let i = 1; i < raw16k.length; i++) {
    hp[i] = alpha * (hp[i - 1]! + raw16k[i]! - raw16k[i - 1]!);
  }

  // 2. 20 ms frame RMS VAD
  const numFrames = Math.floor(hp.length / VAD_FRAME_SAMPLES);
  if (numFrames < VAD_MIN_FRAMES) {
    return {
      audio: new Float32Array(0),
      rmsIn,
      rmsOut: 0,
      gainDb: 0,
      trimmedMs: rawMs,
      hadSpeech: false,
    };
  }

  const frameRms = new Float32Array(numFrames);
  let maxRms = 0;
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const start = f * VAD_FRAME_SAMPLES;
    for (let j = 0; j < VAD_FRAME_SAMPLES; j++) {
      const v = hp[start + j]!;
      sum += v * v;
    }
    const r = Math.sqrt(sum / VAD_FRAME_SAMPLES);
    frameRms[f] = r;
    if (r > maxRms) maxRms = r;
  }

  if (maxRms < VAD_MIN_PEAK_RMS) {
    return {
      audio: new Float32Array(0),
      rmsIn,
      rmsOut: 0,
      gainDb: 0,
      trimmedMs: rawMs,
      hadSpeech: false,
    };
  }

  const speechThresh = Math.max(VAD_FLOOR_RMS, maxRms * VAD_PEAK_RATIO);
  let firstActive = -1;
  let lastActive = -1;
  let activeEnergySum = 0;
  let activeCount = 0;

  for (let f = 0; f < numFrames; f++) {
    const r = frameRms[f]!;
    if (r >= speechThresh) {
      if (firstActive === -1) firstActive = f;
      lastActive = f;
      activeEnergySum += r * r;
      activeCount++;
    }
  }

  if (firstActive === -1 || activeCount < VAD_MIN_ACTIVE_FRAMES) {
    return {
      audio: new Float32Array(0),
      rmsIn,
      rmsOut: 0,
      gainDb: 0,
      trimmedMs: rawMs,
      hadSpeech: false,
    };
  }

  const startSample = Math.max(0, (firstActive - VAD_PRE_PAD_FRAMES) * VAD_FRAME_SAMPLES);
  const endSample = Math.min(hp.length, (lastActive + 1 + VAD_POST_PAD_FRAMES) * VAD_FRAME_SAMPLES);
  const trimmed = hp.slice(startSample, endSample);

  // 3. Active-frame RMS normalization
  const activeRms = Math.sqrt(activeEnergySum / Math.max(1, activeCount));
  const gain = Math.min(NORM_MAX_GAIN, Math.max(NORM_MIN_GAIN, NORM_TARGET_RMS / Math.max(activeRms, 1e-5)));
  const gainDb = 20 * Math.log10(gain);

  // 4. Soft tanh limiter above 0.85 (ceiling 0.99)
  for (let i = 0; i < trimmed.length; i++) {
    let s = trimmed[i]! * gain;
    const abs = Math.abs(s);
    if (abs > LIMITER_KNEE) {
      s = Math.sign(s) * (LIMITER_KNEE + LIMITER_HEADROOM * Math.tanh((abs - LIMITER_KNEE) / LIMITER_HEADROOM));
    }
    trimmed[i] = s;
  }

  const rmsOut = computeRms(trimmed);
  const trimmedMs = ((raw16k.length - trimmed.length) / VOICE_SAMPLE_RATE) * 1000;

  return {
    audio: trimmed,
    rmsIn,
    rmsOut,
    gainDb,
    trimmedMs,
    hadSpeech: true,
  };
}
