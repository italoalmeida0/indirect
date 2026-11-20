import { createMemo, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { useComposerCtx, useSession, useTranscriptCtx } from "../../ctx";
import { useVoice } from "../../voice/VoiceContext";
import { VoiceWaveformIcon } from "../../voice/VoiceOverlays";

export function ToolbarSend() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  const voice = useVoice();
  const isDraft = () => s.draftMode?.() || !s.activeSessionId();
  const isPromptBlank = createMemo(() => {
    const raw = c.inputPrompt();
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) > 32) return false;
    }
    return true;
  });
  const hasSendableInput = createMemo(
    () => !isPromptBlank() || c.pendingAttachments().length > 0,
  );
  return (
    <div class="flex shrink-0 items-center gap-1.5">
      <Show when={t.sessionStatus() === "running"}>
        <button
          type="button"
          onPointerDown={(e) => {
            if (!e.currentTarget.disabled) press(e.currentTarget);
          }}
          onClick={t.cancelCurrentTurn}
          disabled={t.turnActivity()?.status === "cancelling"}
          class="rc-composer-stop relative h-7.5 w-7.5 shrink-0 rounded-full inline-flex items-center justify-center border border-[color-mix(in_oklab,var(--danger)_32%,var(--border))] bg-danger-subtle text-danger hover:bg-[color-mix(in_oklab,var(--danger)_18%,var(--surface))] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          data-rc-tip={t.turnActivity()?.status === "cancelling" ? "Stopping…" : "Stop"}
          aria-label={t.turnActivity()?.status === "cancelling" ? "Stopping turn" : "Stop"}
        >
          <span class="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
        </button>
      </Show>
      <Show
        when={voice.isActive()}
        fallback={
          <>
            <button
              type="button"
              ref={press}
              onPointerDown={() => {
                if (typeof document !== "undefined") {
                  const el = document.getElementById("rc-composer") as HTMLTextAreaElement | null;
                  voice.captureSelection(el);
                }
              }}
              onClick={() => voice.start()}
              disabled={s.creatingSession() || c.sending()}
              class="rc-composer-voice relative h-7.5 w-7.5 shrink-0 rounded-full inline-flex items-center justify-center cursor-pointer"
              data-rc-tip={voice.supported() ? "Voice input" : "Voice input (requires HTTPS)"}
              aria-label="Start voice input"
              aria-pressed="false"
            >
              <VoiceWaveformIcon size={16} />
            </button>
            <button
              type="button"
              onPointerDown={(e) => {
                if (!e.currentTarget.disabled) press(e.currentTarget);
              }}
              onClick={c.sendPrompt}
              disabled={
                s.creatingSession() ||
                c.sending() ||
                c.preparingAttachments() > 0 ||
                !c.activeModel() ||
                !hasSendableInput() ||
                (!s.activeSessionId() && !s.activeProject())
              }
              class="rc-composer-send relative h-7.5 w-7.5 shrink-0 rounded-full inline-flex items-center justify-center bg-fg text-background hover:opacity-90 active:opacity-80 disabled:bg-surface-muted disabled:text-fg-muted disabled:opacity-100 disabled:cursor-not-allowed transition-all cursor-pointer"
              data-rc-tip={c.sending() ? "Uploading attachments..." : isDraft() ? "Start conversation" : "Send"}
              aria-label={isDraft() ? "Start conversation" : "Send"}
            >
              <Iconify icon="lucide:arrow-up" size={15} />
            </button>
          </>
        }
      >
        <button
          type="button"
          ref={press}
          onClick={() => voice.cancel()}
          class="rc-composer-voice-cancel relative h-7.5 w-7.5 shrink-0 rounded-full inline-flex items-center justify-center cursor-pointer"
          data-rc-tip="Cancel voice"
          aria-label="Cancel voice input"
        >
          <Iconify icon="lucide:x" size={14} />
        </button>
        <button
          type="button"
          ref={press}
          onClick={() => voice.confirm()}
          disabled={voice.state() !== "listening"}
          class="rc-composer-voice-confirm relative h-7.5 w-7.5 shrink-0 rounded-full inline-flex items-center justify-center cursor-pointer"
          data-rc-tip="Confirm dictation"
          aria-label="Confirm dictation"
        >
          <Iconify icon="lucide:check" size={15} />
        </button>
      </Show>
    </div>
  );
}
