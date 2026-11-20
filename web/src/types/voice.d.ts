/**
 * Minimal ambient declarations for AudioWorkletGlobalScope and Screen Wake Lock
 * used by the Indirect Code voice subsystem (tsconfig keeps DOM lib only).
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;

interface WakeLockSentinel extends EventTarget {
  readonly released: boolean;
  release(): Promise<void>;
}
