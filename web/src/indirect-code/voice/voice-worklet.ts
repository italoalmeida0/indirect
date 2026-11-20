/** Standalone AudioWorklet processor compiled to `dist/workers/voice-worklet.js`.
 * Batches mono render quantums (typically 128 samples) into 1024-sample Float32
 * blocks and transfers ownership back to the main thread with precomputed RMS.
 */
import type { VoiceWorkletIn, VoiceWorkletOut } from "./types";

const BLOCK_SIZE = 1024;

function blockRms(samples: Float32Array): number {
  const len = samples.length;
  if (len === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / len);
}

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(BLOCK_SIZE);
  private offset = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<VoiceWorkletIn>) => {
      if (ev.data && ev.data.type === "flush") {
        this.flushPartial();
      }
    };
  }

  private emitBuffer(pcm: Float32Array): void {
    const msg: VoiceWorkletOut = { pcm, rms: blockRms(pcm) };
    this.port.postMessage(msg, [pcm.buffer]);
  }

  private flushPartial(): void {
    if (this.offset <= 0) return;
    const tail = this.buffer.slice(0, this.offset);
    this.offset = 0;
    this.emitBuffer(tail);
  }

  override process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    let srcOffset = 0;
    while (srcOffset < channel.length) {
      const take = Math.min(BLOCK_SIZE - this.offset, channel.length - srcOffset);
      this.buffer.set(channel.subarray(srcOffset, srcOffset + take), this.offset);
      this.offset += take;
      srcOffset += take;

      if (this.offset === BLOCK_SIZE) {
        const ready = this.buffer;
        this.buffer = new Float32Array(BLOCK_SIZE);
        this.offset = 0;
        this.emitBuffer(ready);
      }
    }

    return true;
  }
}

registerProcessor("indirect-voice-capture", VoiceCaptureProcessor);
