import { createMemo, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { useComposerCtx, useSession, useTranscriptCtx } from "../../ctx";

export function ToolbarSend() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  const isDraft = () => s.draftMode() || !s.activeSessionId();
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
          class="rc-composer-send relative h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center border border-[color-mix(in_oklab,var(--danger)_32%,var(--border))] bg-danger-subtle text-danger hover:bg-[color-mix(in_oklab,var(--danger)_18%,var(--surface))] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer [@media(pointer:coarse)]:after:content-[''] [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-1/2 [@media(pointer:coarse)]:after:h-11 [@media(pointer:coarse)]:after:w-11 [@media(pointer:coarse)]:after:-translate-1/2"
          data-rc-tip={t.turnActivity()?.status === "cancelling" ? "Stopping…" : "Stop"}
          aria-label={t.turnActivity()?.status === "cancelling" ? "Stopping turn" : "Stop"}
        >
          <span class="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
        </button>
      </Show>
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
        class="rc-composer-send relative h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center bg-fg text-background hover:opacity-90 active:opacity-80 disabled:bg-surface-muted disabled:text-fg-muted disabled:opacity-100 disabled:cursor-not-allowed transition-all cursor-pointer [@media(pointer:coarse)]:after:content-[''] [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-1/2 [@media(pointer:coarse)]:after:h-11 [@media(pointer:coarse)]:after:w-11 [@media(pointer:coarse)]:after:-translate-1/2"
        data-rc-tip={c.sending() ? "Uploading attachments..." : isDraft() ? "Start conversation" : "Send"}
        aria-label={isDraft() ? "Start conversation" : "Send"}
      >
        <Iconify icon="lucide:arrow-up" size={15} />
      </button>
    </div>
  );
}
