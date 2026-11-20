// Prevent spawned gateway instances (e.g. test/indirect-code.test.ts running in
// NODE_ENV=production) from triggering real HuggingFace voice-model downloads
// during bare `bun test`.
process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD ??= "1";

// Bun test preload: warm the btdby4-wasm token estimator before any test
// file runs. Counters are synchronous after init; without this, the first
// countTextTokens() call would throw "not initialized".
import { initTokenEstimator } from "../server/tokens";

await initTokenEstimator();
