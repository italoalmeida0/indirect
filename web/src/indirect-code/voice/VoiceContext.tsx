import { createContext, useContext, type JSX } from "solid-js";
import type { VoiceController } from "./types";

const NOOP = () => {};

const IDLE_VOICE_FALLBACK: VoiceController = {
  state: () => "idle",
  isIdle: () => true,
  isActive: () => false,
  supported: () => true,
  modelReady: () => false,
  statusText: () => "",
  statusMeta: () => "",
  downloadProgress: () => 0,
  reveal: () => null,
  errorMessage: () => null,
  energy: () => 0,
  registerAurora: () => NOOP,
  start: NOOP,
  confirm: NOOP,
  cancel: NOOP,
  clearReveal: NOOP,
  captureSelection: NOOP,
  setComposerElement: NOOP,
};

export const VoiceCtx = createContext<VoiceController>(IDLE_VOICE_FALLBACK);

export function useVoice(): VoiceController {
  return useContext(VoiceCtx);
}

export function VoiceProvider(props: { value: VoiceController; children: JSX.Element }) {
  return <VoiceCtx.Provider value={props.value}>{props.children}</VoiceCtx.Provider>;
}
