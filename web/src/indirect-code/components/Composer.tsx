import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { useComposerCtx, useQueue, useSession, useTranscriptCtx, useUI } from "../ctx";
import { composerIsCollapsed } from "../utils/composerState";
import { ScrollOverlays } from "./composer/ScrollOverlays";
import { StatusBanners } from "./composer/StatusBanners";
import { ComposerInput } from "./composer/ComposerInput";
import { ToolbarContext } from "./composer/ToolbarContext";
import { ToolbarModel } from "./composer/ToolbarModel";
import { ToolbarSend } from "./composer/ToolbarSend";
import { ComposerFooter } from "./composer/ComposerFooter";
import { ComposerQueueShelf } from "./QueueCard";

export function Composer() {
  const c = useComposerCtx();
  const q = useQueue();
  const s = useSession();
  const t = useTranscriptCtx();
  const ui = useUI();
  // Short viewports: the whole composer (input, toolbar, footer) can be
  // minimized, leaving a single restore bar above. Never in a new conversation
  // or blocked workspace.
  const collapsed = () => composerIsCollapsed({
    composerCollapsed: ui.composerCollapsed(),
    draftMode: s.draftMode(),
    activeSessionId: s.activeSessionId(),
    workspaceBlocked: s.workspaceBlocked(),
  });
  const canCollapse = () =>
    Boolean(s.activeSessionId() && !s.draftMode() && !s.workspaceBlocked());
  const hasTurnRow = () =>
    Boolean(t.turnActivity() || t.compactingText?.());
  const hasQueueShelf = () =>
    Boolean(
      s.activeSessionId() &&
        !s.draftMode() &&
        (q.passiveItems?.(s.activeSessionId())?.length ?? 0) > 0,
    );
  // Minimized: the restore bar is the last thing on screen, so the wrapper
  // needs its own bottom breathing room (nothing below it to add any).
  const wrapperClass = () => s.draftMode()
    ? "rc-draft flex-1 min-h-0 overflow-y-auto flex flex-col px-4 sm:px-6 lg:px-8 py-10"
    : `rc-safe-bottom shrink-0 overflow-visible px-4 sm:px-6 lg:px-8 pt-2 bg-background relative z-20${collapsed() ? " pb-2" : ""}`;
  return (
<>

<Show when={!ui.historyView()}>
<div class={wrapperClass()} data-composer-shell>
  <ScrollOverlays />
  <div class={`w-full ${ui.convWidthClass()} mx-auto my-auto shrink-0`}>
  <StatusBanners />
    <Show when={!collapsed()}>
    <Show when={!s.workspaceBlocked()} fallback={
      <div role="status" class="rounded-panel border border-[color-mix(in_oklab,var(--warning)_26%,var(--border))] bg-warning-subtle px-3.5 py-2.5 text-xs text-fg-secondary" data-workspace-unavailable>
        <div class="flex items-center gap-2 font-medium text-fg text-sm">
          <Iconify icon="lucide:folder-x" size={15} class="text-warning shrink-0" />
          <span>{s.workspaceState() === "missing" ? "The project folder was deleted" : "The project folder is unavailable"}</span>
        </div>
        <p class="mt-1 text-xs text-fg-muted">{s.workspaceState() === "missing" ? "Recreate this folder on the host to continue this conversation." : "Restore access to this folder on the host to continue."}</p>
        <p class="mt-1 font-mono text-2xs text-fg-secondary break-all">{s.workspacePath()}</p>
        <div class="mt-2.5 flex items-center gap-2">
          <button type="button" onPointerDown={(e) => press(e.currentTarget)} onClick={s.checkWorkspace} class="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-1 min-h-8 [@media(pointer:coarse)]:min-h-11 text-xs font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer">Check again</button>
          <Show when={t.sessionStatus() === "running"}>
            <button type="button" onPointerDown={(e) => press(e.currentTarget)} onClick={t.cancelCurrentTurn} class="inline-flex items-center justify-center rounded-lg border border-[color-mix(in_oklab,var(--danger)_30%,var(--border))] bg-danger-subtle px-3 py-1 min-h-8 [@media(pointer:coarse)]:min-h-11 text-xs font-medium text-danger hover:opacity-90 transition-opacity cursor-pointer">Stop turn</button>
          </Show>
        </div>
      </div>
    }>
    <ComposerQueueShelf />
    <div
      data-queue-docked={hasQueueShelf() ? "true" : undefined}
      class="@container rc-composer relative z-10 flex flex-col data-[queue-docked=true]:rounded-t-none data-[queue-docked=true]:shadow-none data-[queue-docked=true]:border-border-strong data-[queue-docked=true]:border-t-border"
    >
    <ComposerInput />
    <div class="rc-composer-toolbar flex items-center justify-between gap-2 px-2.5 pt-1 pb-2.5">
      <div class="flex flex-1 min-w-0 flex-nowrap items-center gap-1 overflow-hidden text-xs text-fg-secondary">
      <ToolbarContext />
      <ToolbarModel />
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <Show when={canCollapse() && !hasTurnRow()}>
          <button
            type="button"
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={ui.toggleComposerCollapsed}
            aria-expanded={true}
            aria-label="Hide composer and tasks"
            data-rc-tip="Hide composer and tasks"
            data-composer-collapse
            class="ui-icon-button ui-icon-button-xs shrink-0 rounded-lg text-fg-muted"
          >
            <Iconify icon="lucide:chevron-down" size={14} />
          </button>
        </Show>
        <ToolbarSend />
      </div>
    </div>
    <input
      id="rc-file-input"
      type="file"
      class="hidden"
      multiple
      onChange={(e) => {
        c.handleFiles(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
      }}
     />
  </div>
    </Show>
    <ComposerFooter />
    </Show>
  </div>
</div>
</Show>
</>
  );
}
