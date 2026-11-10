import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { useComposerCtx, useSession, useTranscriptCtx } from "../../ctx";

export function ToolbarSend() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
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
          class="h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center border border-danger/35 bg-danger-subtle text-danger hover:bg-danger/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
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
          s.creatingSession() || c.sending() || c.preparingAttachments() > 0 || !c.activeModel() ||
          (s.activeSessionId()
            ? !c.inputPrompt().trim() && c.pendingAttachments().length === 0
            : (!c.inputPrompt().trim() && c.pendingAttachments().length === 0) || !s.activeProject())
        }
        class="rc-composer-send h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center bg-fg text-background hover:opacity-90 active:opacity-80 disabled:bg-surface-muted disabled:text-fg-muted disabled:opacity-100 disabled:cursor-not-allowed transition-all cursor-pointer"
        data-rc-tip={c.sending() ? "Uploading attachments..." : !s.activeSessionId() ? "Start conversation" : "Send"}
        aria-label={!s.activeSessionId() ? "Start conversation" : "Send"}
      >
        <Iconify icon="lucide:arrow-up" size={15} />
      </button>
    </div>
  );
}
