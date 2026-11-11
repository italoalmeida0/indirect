import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { useHost, useSession, useTranscriptCtx, useUI } from "../../ctx";
import { composerIsCollapsed } from "../../utils/composerState";
import { IndirectBrand } from "../IndirectBrand";

/** Minimize/restore the composer (input, toolbar, footer) and the whole
 *  task plan (short viewports). Lives in the turn-status row, so it is only
 *  reachable in an existing conversation — a new conversation (draftMode)
 *  never shows it. */
function ComposerCollapseToggle(props: { withHint: boolean }) {
  const s = useSession();
  const ui = useUI();
  const collapsed = () => ui.composerCollapsed();
  const label = () => (collapsed() ? "Show composer and tasks" : "Hide composer and tasks");
  return (
    <Show when={s.activeSessionId() && !s.draftMode() && !s.workspaceBlocked()}>
      <button
        type="button"
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={ui.toggleComposerCollapsed}
        aria-expanded={!collapsed()}
        aria-label={label()}
        data-rc-tip={label()}
        data-composer-collapse
        class={`shrink-0 p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer ${props.withHint ? "ml-auto" : ""}`}
      >
        <Iconify icon={collapsed() ? "lucide:chevron-up" : "lucide:chevron-down"} size={14} />
      </button>
    </Show>
  );
}

export function StatusBanners() {
  const s = useSession();
  const t = useTranscriptCtx();
  const h = useHost();
  const ui = useUI();
  /** Same effective predicate as the composer box: the persisted preference
   *  only bites in an existing, available conversation. */
  const collapsed = () => composerIsCollapsed({
    composerCollapsed: ui.composerCollapsed(),
    draftMode: s.draftMode(),
    activeSessionId: s.activeSessionId(),
    workspaceBlocked: s.workspaceBlocked(),
  });
  const completedTodos = () => t.todos().filter((item) => item.status === "completed").length;
  const todoPercent = () => (t.todos().length ? Math.round((completedTodos() / t.todos().length) * 100) : 0);
  return (
<>
<Show when={s.draftMode()}>
  <div class="mb-6">
    <IndirectBrand />
  </div>
</Show>
<Show when={s.activeSessionId() && t.turnActivity()}>
  <div role="status" data-turn-status class="mb-1.5 flex items-center gap-2 px-1 text-xs text-fg-muted min-w-0">
    <Iconify icon={t.sessionStatus() === "running" ? "lucide:loader-circle" : "lucide:clock-3"} size={13} class={t.sessionStatus() === "running" ? "animate-spin shrink-0 text-accent" : "shrink-0 text-fg-muted"} />
    <span class="shrink-0 font-medium text-fg-secondary">{t.turnLabel()}</span>
    <Show when={t.turnHint()}>{(hint) =>
      <span class="min-w-0 flex-1 truncate whitespace-nowrap overflow-hidden font-mono text-[11px] text-fg-muted">· {hint()}</span>
    }</Show>
    <ComposerCollapseToggle withHint={!t.turnHint()} />
  </div>
</Show>
{/* No turn row (idle conversation): the chevron still needs a home, so it
    rides its own right-aligned row. */}
<Show when={s.activeSessionId() && !t.turnActivity()}>
  <div class="mb-1 flex items-center justify-end px-1 text-xs text-fg-muted min-w-0">
    <ComposerCollapseToggle withHint={false} />
  </div>
</Show>
<Show when={s.activeSessionId() && t.todos().length && !collapsed()}>
  <section aria-label="Task checklist" class="mb-2 rounded-lg border border-border bg-surface-subtle text-xs overflow-hidden">
    <button type="button" onPointerDown={(e) => press(e.currentTarget)} onClick={() => t.toggleTodosOpen()} aria-expanded={t.todosOpen()} class="w-full px-3 py-1.5 flex items-center gap-2 text-fg-secondary hover:bg-surface-muted/60 transition-colors cursor-pointer">
      <Iconify icon="lucide:list-checks" size={13} class={completedTodos() === t.todos().length ? "text-success shrink-0" : "text-accent shrink-0"} />
      <span class="font-medium text-fg">Task plan</span>
      <span class="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-fg-secondary">
        <span>{completedTodos()}/{t.todos().length}</span>
        <span class="w-8 h-1 rounded-full bg-surface-muted overflow-hidden">
          <span
            class={`block h-full rounded-full transition-all duration-300 ${completedTodos() === t.todos().length ? "bg-success" : "bg-accent"}`}
            style={{ width: `${todoPercent()}%` }}
          />
        </span>
      </span>
      <span class="flex-1 truncate text-left text-fg-muted">{!t.todosOpen() ? t.todos().find((item) => item.status === "in_progress")?.text : ""}</span>
      <Iconify icon="lucide:chevron-down" size={13} class={`shrink-0 text-fg-muted transition-transform duration-150 ${t.todosOpen() ? "rotate-180" : ""}`} />
    </button>
    <Show when={t.todosOpen()}><ol class="px-3 pb-2 pt-1.5 border-t border-border-subtle space-y-1.5 max-h-44 overflow-y-auto">
      <For each={t.todos()}>{(item) => <li class="flex items-start gap-2" data-todo-status={item.status}>
        <Iconify icon={item.status === "completed" ? "lucide:circle-check" : item.status === "in_progress" ? t.sessionStatus() === "running" ? "lucide:loader-circle" : "lucide:circle-dot" : "lucide:circle"} size={13} class={`mt-0.5 shrink-0 ${item.status === "completed" ? "text-success" : item.status === "in_progress" ? (t.sessionStatus() === "running" ? "animate-spin text-accent" : "text-accent") : "text-fg-muted"}`} />
        <span class={item.status === "completed" ? "text-fg-muted line-through" : "text-fg"}>{item.text}</span>
      </li>}</For>
    </ol></Show>
  </section>
</Show>
<Show when={ui.appNotice()}>{(notice) =>
  <div role={notice().kind === "err" ? "alert" : "status"} class={`mb-2.5 flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs ${notice().kind === "err" ? "border-danger/35 bg-danger-subtle text-fg" : "border-border bg-surface-raised text-fg-secondary"}`}>
    <Iconify icon={notice().kind === "err" ? "lucide:circle-alert" : "lucide:check-circle-2"} size={14} class={`shrink-0 mt-0.5 ${notice().kind === "err" ? "text-danger" : "text-success"}`} />
    <span class="min-w-0 flex-1 break-words">{notice().message}</span>
    <button type="button" aria-label="Dismiss notification" data-rc-tip="Dismiss notification" onClick={() => ui.setAppNotice(null)} class="p-0.5 rounded text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"><Iconify icon="lucide:x" size={13} /></button>
  </div>
}</Show>
<Show when={h.activeHost() && (h.connectionState() !== "connected" || h.activeHost()?.status !== "online")}>
  <div class="rc-delayed-banner">
    <div role="status" class="mb-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-xs text-fg flex items-start gap-2.5">
      <Iconify icon="lucide:unplug" size={14} class="text-warning shrink-0 mt-0.5" />
      <div class="flex-1 min-w-0">
        <p class="font-medium text-fg">{typeof navigator !== "undefined" && !navigator.onLine ? "Network offline" : h.connectionState() !== "connected" ? "Reconnecting to the gateway…" : `${h.activeHost()?.name || "Host"} is offline`}</p>
        <p class="mt-0.5 text-fg-secondary">{typeof navigator !== "undefined" && !navigator.onLine ? "Check your internet connection to continue." : h.connectionState() !== "connected" ? "Restoring connection to gateway..." : "Start the daemon on this host to continue."}</p>
      </div>
      <button type="button" onPointerDown={(e) => press(e.currentTarget)} onClick={h.reconnect || h.loadHosts} class="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer">Retry</button>
    </div>
  </div>
</Show>
</>
  );
}
