import { Index, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { createShimmerStyle } from "../../../ds/motion/shimmer";
import { useHost, useSession, useTranscriptCtx, useUI } from "../../ctx";
import { composerIsCollapsed } from "../../utils/composerState";
import { IndirectBrand } from "../IndirectBrand";
import { NeuralMatrixLoader } from "../LiveIndicators";

/** Minimize/restore the composer (input, toolbar, footer) and the whole
 *  task plan (short viewports). Shown on the active turn-status row when
 *  expanded; when idle, the minimize icon lives inside `.rc-composer-toolbar`. */
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
        class={`inline-flex h-6 w-6 items-center justify-center shrink-0 rounded-md text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer ${props.withHint ? "ml-auto" : ""}`}
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
  const restoreLabel = () => "Show composer and tasks";
  const completedTodos = () => t.todos().filter((item) => item.status === "completed").length;
  const todoPercent = () => (t.todos().length ? Math.round((completedTodos() / t.todos().length) * 100) : 0);
  const compacting = () => Boolean(t.compactingText?.());
  const hasTurnRow = () => Boolean(t.turnActivity() || compacting());
  const isBusy = () => t.sessionStatus() === "running" || compacting();
  const turnShimmerStyle = createShimmerStyle(isBusy);
  const rawTurnLabel = () => t.turnLabel?.() || t.compactingText?.() || "";
  const turnPrimary = () => {
    const raw = rawTurnLabel();
    const sep = raw.indexOf(" · ");
    return sep >= 0 ? raw.slice(0, sep) : raw;
  };
  const turnElapsed = () => {
    const raw = rawTurnLabel();
    const sep = raw.indexOf(" · ");
    return sep >= 0 ? raw.slice(sep + 3) : "";
  };
  const cleanTurnHint = () => (t.turnHint() || "").replace(/`+/g, "").trim();
  return (
<>
<Show when={s.draftMode()}>
  <div class="mb-6">
    <IndirectBrand />
  </div>
</Show>
<Show when={s.activeSessionId() && collapsed()}>
  <button
    type="button"
    data-turn-status={hasTurnRow() ? "" : undefined}
    data-composer-collapse
    aria-expanded={false}
    aria-label={restoreLabel()}
    data-rc-tip={restoreLabel()}
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={ui.toggleComposerCollapsed}
    class="w-full flex items-center gap-2 rounded-panel border border-border bg-surface-subtle hover:bg-surface-muted px-3 py-1.5 text-xs text-fg-muted text-left transition-colors cursor-pointer min-w-0"
  >
    <Show
      when={hasTurnRow()}
      fallback={
        <>
          <Iconify icon="lucide:message-square" size={13} class="shrink-0 text-fg-muted" />
          <span class="font-medium text-fg-secondary truncate">Composer minimized</span>
          <Show when={t.todos().length > 0}>
            <span class="shrink-0 rounded-inner border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs tabular-nums text-fg-muted">
              {completedTodos()}/{t.todos().length}
            </span>
          </Show>
        </>
      }
    >
      <Show
        when={isBusy()}
        fallback={<Iconify icon="lucide:clock-3" size={13} class="shrink-0 text-fg-muted" />}
      >
        <NeuralMatrixLoader size={12} class="text-accent" />
      </Show>
      <span class={`shrink-0 font-medium ${isBusy() ? "ui-shimmer" : "text-fg-secondary"}`} style={turnShimmerStyle()}>{turnPrimary()}</span>
      <Show when={turnElapsed()}>
        <span class="shrink-0 text-fg-muted tabular-nums -ml-0.5">· {turnElapsed()}</span>
      </Show>
      <Show when={!compacting() && cleanTurnHint()}>
        <span class="min-w-0 flex-1 truncate whitespace-nowrap overflow-hidden font-mono text-2xs text-fg-muted">· {cleanTurnHint()}</span>
      </Show>
    </Show>
    <span class="ml-auto inline-flex items-center gap-1 shrink-0 text-2xs text-fg-muted">
      <Iconify icon="lucide:chevron-up" size={14} />
    </span>
  </button>
</Show>
<Show when={s.activeSessionId() && !collapsed() && hasTurnRow()}>
  <div role="status" data-turn-status class="mb-1.5 flex items-center gap-2 px-1 text-xs text-fg-muted min-w-0">
    <Show
      when={isBusy()}
      fallback={<Iconify icon="lucide:clock-3" size={13} class="shrink-0 text-fg-muted" />}
    >
      <NeuralMatrixLoader size={12} class="text-accent" />
    </Show>
    <span class={`shrink-0 font-medium ${isBusy() ? "ui-shimmer" : "text-fg-secondary"}`} style={turnShimmerStyle()}>{turnPrimary()}</span>
    <Show when={turnElapsed()}>
      <span class="shrink-0 text-fg-muted tabular-nums -ml-0.5">· {turnElapsed()}</span>
    </Show>
    <Show when={!compacting() && cleanTurnHint()}>
      <span class="min-w-0 flex-1 truncate whitespace-nowrap overflow-hidden font-mono text-2xs text-fg-muted">· {cleanTurnHint()}</span>
    </Show>
    <ComposerCollapseToggle withHint={compacting() || !cleanTurnHint()} />
  </div>
</Show>
<Show when={s.activeSessionId() && t.todos().length && !collapsed()}>
  <section aria-label="Task checklist" class="mb-2 rounded-panel border border-border bg-surface-subtle text-xs overflow-hidden">
    <button type="button" onPointerDown={(e) => press(e.currentTarget)} onClick={() => t.toggleTodosOpen()} aria-expanded={t.todosOpen()} class="w-full px-3 py-1.5 flex items-center gap-2 text-fg-secondary hover:bg-surface-muted transition-colors cursor-pointer">
      <Iconify icon="lucide:list-checks" size={13} class={completedTodos() === t.todos().length ? "text-success shrink-0" : "text-accent shrink-0"} />
      <span class="font-medium text-fg">Task plan</span>
      <span class="inline-flex items-center gap-1.5 rounded-inner border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs font-medium tabular-nums text-fg-secondary">
        <span>{completedTodos()}/{t.todos().length}</span>
        <span class="w-8 h-1 rounded-full bg-surface-muted overflow-hidden">
          <span
            class={`block h-full rounded-full transition-all duration-300 ${completedTodos() === t.todos().length ? "bg-success" : "bg-accent"}`}
            style={{ width: `${todoPercent()}%` }}
          />
        </span>
      </span>
      <span class="flex-1 truncate text-left text-fg-muted">{!t.todosOpen() ? (t.todos().find((item) => item.status === "in_progress")?.text || "").replace(/`+/g, "") : ""}</span>
      <Iconify icon="lucide:chevron-down" size={13} class={`shrink-0 text-fg-muted transition-transform duration-150 ${t.todosOpen() ? "rotate-180" : ""}`} />
    </button>
    <Show when={t.todosOpen()}><ol class="px-3 pb-2 pt-1.5 border-t border-border-subtle space-y-1.5 max-h-44 overflow-y-auto overscroll-contain">
      <Index each={t.todos()}>{(item) => {
        const todoBusy = () => item().status === "in_progress" && t.sessionStatus() === "running";
        const todoShimmerStyle = createShimmerStyle(todoBusy);
        return (
          <li class="flex items-start gap-2" data-todo-status={item().status}>
            <Iconify icon={item().status === "completed" ? "lucide:circle-check" : item().status === "in_progress" ? "lucide:circle-dot" : "lucide:circle"} size={13} class={`mt-0.5 shrink-0 ${item().status === "completed" ? "text-success" : item().status === "in_progress" ? "text-accent" : "text-fg-muted"}`} />
            <span class={item().status === "completed" ? "text-fg-muted line-through" : todoBusy() ? "ui-shimmer font-medium text-fg-secondary" : "text-fg"} style={todoShimmerStyle()}>{item().text}</span>
          </li>
        );
      }}</Index>
    </ol></Show>
  </section>
</Show>
<Show when={h.activeHost() && (h.connectionState() !== "connected" || h.activeHost()?.status !== "online")}>
  <div class="rc-delayed-banner">
    <div role="status" class="mb-2 rounded-panel border border-[color-mix(in_oklab,var(--warning)_26%,var(--border))] bg-warning-subtle px-3.5 py-2.5 text-xs text-fg flex items-start gap-2.5">
      <Iconify icon="lucide:unplug" size={14} class="text-warning shrink-0 mt-0.5" />
      <div class="flex-1 min-w-0">
        <p class="font-medium text-fg">{typeof navigator !== "undefined" && !navigator.onLine ? "Network offline" : h.connectionState() !== "connected" ? "Reconnecting to the gateway…" : `${h.activeHost()?.name || "Host"} is offline`}</p>
        <p class="mt-0.5 text-fg-secondary">{typeof navigator !== "undefined" && !navigator.onLine ? "Check your internet connection to continue." : h.connectionState() !== "connected" ? "Restoring connection to gateway…" : "Start the daemon on this host to continue."}</p>
      </div>
      <button type="button" onPointerDown={(e) => press(e.currentTarget)} onClick={h.reconnect || h.loadHosts} class="shrink-0 inline-flex items-center justify-center rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer">Retry</button>
    </div>
  </div>
</Show>
</>
  );
}
