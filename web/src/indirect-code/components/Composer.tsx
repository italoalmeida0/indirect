import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { useComposerCtx, useSession, useTranscriptCtx, useUI } from "../ctx";
import { composerIsCollapsed } from "../utils/composerState";
import { ScrollOverlays } from "./composer/ScrollOverlays";
import { StatusBanners } from "./composer/StatusBanners";
import { ComposerInput } from "./composer/ComposerInput";
import { ToolbarContext } from "./composer/ToolbarContext";
import { ToolbarModel } from "./composer/ToolbarModel";
import { ToolbarSend } from "./composer/ToolbarSend";
import { ComposerFooter } from "./composer/ComposerFooter";

export function Composer() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  const ui = useUI();
  // Short viewports: the whole composer (input, toolbar, footer) can be
  // minimized, leaving only the turn-status row + chevron above. Never in a
  // new conversation — there is nothing to minimize into.
  const collapsed = () => composerIsCollapsed({
    composerCollapsed: ui.composerCollapsed(),
    draftMode: s.draftMode(),
    activeSessionId: s.activeSessionId(),
    workspaceBlocked: s.workspaceBlocked(),
  });
  // Minimized: the status row is the last thing on screen, so the wrapper
  // needs its own bottom breathing room (nothing below it to add any).
  const wrapperClass = () => s.draftMode()
    ? "rc-draft flex-1 min-h-0 overflow-y-auto flex flex-col px-4 py-10"
    : `rc-safe-bottom min-h-0 overflow-y-auto px-4 pt-2 bg-background relative z-20${collapsed() ? " pb-2" : ""}`;
  return (
<>

<Show when={!ui.historyView()}>
<div class={wrapperClass()} data-composer-shell>
  <ScrollOverlays />
  <div class="w-full max-w-2xl mx-auto my-auto shrink-0">
  <StatusBanners />
    <Show when={!collapsed()}>
    <Show when={!s.workspaceBlocked()} fallback={
      <div role="status" class="rounded-panel border border-warning/35 bg-warning-subtle/40 px-4 py-3.5 text-sm text-fg-secondary shadow-resting" data-workspace-unavailable>
        <div class="flex items-center gap-2 font-medium text-fg">
          <Iconify icon="lucide:folder-x" size={17} class="text-warning shrink-0" />
          <span>{s.workspaceState() === "missing" ? "The project folder was deleted" : "The project folder is unavailable"}</span>
        </div>
        <p class="mt-1.5 text-xs text-fg-muted">{s.workspaceState() === "missing" ? "Recreate this folder on the host to continue this conversation." : "Restore access to this folder on the host to continue."}</p>
        <p class="mt-1 font-mono text-xs text-fg-secondary break-all">{s.workspacePath()}</p>
        <div class="mt-2.5 flex items-center gap-2">
          <button type="button" onClick={s.checkWorkspace} class="rounded-control border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer">Check again</button>
          <Show when={t.sessionStatus() === "running"}>
            <button type="button" onClick={t.cancelCurrentTurn} class="rounded-control border border-danger/35 bg-danger-subtle px-2.5 py-1 text-xs font-medium text-danger hover:opacity-90 transition-opacity cursor-pointer">Stop turn</button>
          </Show>
        </div>
      </div>
    }>
    <div class="rc-composer relative flex flex-col">
    <ComposerInput />
    <div class="rc-composer-toolbar flex items-end justify-between gap-2 px-2.5 py-2">
      <div class="flex flex-1 min-w-0 flex-wrap items-center gap-1 text-xs text-fg-secondary">
      <ToolbarContext />
      <ToolbarModel />
      </div>
      <ToolbarSend />
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
