import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { useBackground, useUI } from "../ctx";
import type { SessionBgTask } from "../hooks/useBackground";
import { elapsedLabel } from "../utils/format";
import { Icon as Iconify } from "../../components/icon";
import { CodeBlock, ShellCmd } from "./CodeBlock";
import { ProcessEqualizer } from "./LiveIndicators";
import { followTail, recordToolScroll, restoreToolScroll } from "../utils/scrollMemory";

/** Middle-truncated one-line command for the card row. */
function shortLabel(cmd: string, max = 64) {
  const one = cmd.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const head = Math.ceil((max - 3) / 2);
  const tail = max - 3 - head;
  return `${one.slice(0, head)}...${one.slice(one.length - tail)}`;
}

function taskState(status: string) {
  switch (status) {
    case "running": return { label: "Running", icon: "lucide:terminal", color: "text-accent" };
    case "done": return { label: "Completed", icon: "lucide:circle-check", color: "text-success" };
    case "error": return { label: "Failed", icon: "lucide:circle-x", color: "text-danger" };
    case "cancelled": return { label: "Cancelled", icon: "lucide:circle-slash", color: "text-fg-muted" };
    default: return { label: "Stopped", icon: "lucide:circle-stop", color: "text-fg-muted" };
  }
}

function exitBadgeTone(code: number) {
  if (code === 0) return "border-border text-fg-muted bg-surface-subtle";
  if (code === 130 || code === 143) return "border-[color-mix(in_oklab,var(--warning)_32%,var(--border))] text-warning bg-warning-subtle";
  return "border-[color-mix(in_oklab,var(--danger)_32%,var(--border))] text-danger bg-danger-subtle";
}

/**
 * Background tasks card (below the transcript, above the queue).
 *
 * Session-global tasks (daemon BgTasks): one row per bash/exec_script task of
 * the open session. The daemon status determines the running/archive split
 * on every client; archiving never changes or deletes a task. Both views
 * start with the three newest tasks and retain access to their logs.
 */
export function BackgroundCard(props: { contextKey?: string }) {
  const bg = useBackground();
  const ui = useUI();
  const [showArchived, setShowArchived] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [open, setOpen] = createSignal<Record<string, boolean>>({});
  const [recentlyFinished, setRecentlyFinished] = createSignal<Record<string, number>>({});
  let prevStatuses = new Map<string, string>();
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const tasks = createMemo(() => bg.sessionJobs()
    .filter((j) => j.kind === "bash" || j.kind === "exec_script" || j.kind === "python")
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)));
  const running = createMemo(() => tasks().filter((j) => j.status === "running"));
  const archived = createMemo(() => tasks().filter((j) => j.status !== "running"));
  const activeTasks = createMemo(() => tasks().filter((j) => j.status === "running" || !!recentlyFinished()[j.id]));
  const selected = createMemo(() => showArchived() ? archived() : activeTasks());
  const visible = createMemo(() => expanded() ? selected() : selected().slice(0, 3));

  createEffect(() => {
    const currentTasks = tasks();
    const nextStatuses = new Map<string, string>();
    const newlyFinished: string[] = [];
    for (const job of currentTasks) {
      nextStatuses.set(job.id, job.status);
      const prev = prevStatuses.get(job.id);
      if (prev === "running" && job.status !== "running") {
        newlyFinished.push(job.id);
      }
    }
    prevStatuses = nextStatuses;

    if (newlyFinished.length > 0) {
      const now = Date.now();
      setRecentlyFinished((prev) => {
        const next = { ...prev };
        for (const id of newlyFinished) {
          next[id] = now;
        }
        return next;
      });

      for (const id of newlyFinished) {
        if (graceTimers.has(id)) clearTimeout(graceTimers.get(id));
        const t = setTimeout(() => {
          graceTimers.delete(id);
          setRecentlyFinished((prev) => {
            if (!prev[id]) return prev;
            if (isOpen(id)) return prev;
            const copy = { ...prev };
            delete copy[id];
            return copy;
          });
        }, 15000);
        graceTimers.set(id, t);
      }
    }
  });

  onCleanup(() => {
    for (const t of graceTimers.values()) clearTimeout(t);
    graceTimers.clear();
  });

  function dismiss(id: string) {
    if (graceTimers.has(id)) {
      clearTimeout(graceTimers.get(id));
      graceTimers.delete(id);
    }
    setRecentlyFinished((prev) => {
      if (!prev[id]) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  }

  createEffect(on(() => props.contextKey, () => {
    setShowArchived(false);
    setExpanded(false);
    setOpen({});
    setRecentlyFinished({});
    for (const t of graceTimers.values()) clearTimeout(t);
    graceTimers.clear();
    prevStatuses.clear();
  }));

  function toggleArchive() {
    setShowArchived((value) => !value);
    setExpanded(false);
  }

  function duration(job: SessionBgTask) {
    if (!Number.isFinite(job.startedAt) || job.startedAt <= 0) return "--";
    const end = job.status === "running" ? bg.clock() : job.endedAt;
    return typeof end === "number" && end > 0
      ? elapsedLabel(Math.max(0, end - job.startedAt)) : "--";
  }

  const isOpen = (id: string) => open()[id] === true;
  const toggle = (id: string) => {
    setOpen((prev) => {
      const nextOpen = !prev[id];
      if (!nextOpen && recentlyFinished()[id]) {
        const finishedAt = recentlyFinished()[id];
        if (finishedAt && Date.now() - finishedAt >= 15000) {
          dismiss(id);
        }
      }
      return { ...prev, [id]: nextOpen };
    });
  };
  const logText = (job: SessionBgTask) => {
    // Session tail (authoritative) + live output not covered by the snapshot.
    const sess = typeof job.content === "string" ? job.content : bg.sessionContent(job.id) || "";
    const live = bg.liveTail(job.id);
    if (!live) return sess;
    if (!sess) return live;
    return sess.endsWith("\n") ? sess + live : sess + "\n" + live;
  };
  return (
    <Show when={tasks().length > 0}>
      <div class={`w-full ${ui.convWidthClass()} mx-auto py-1`} data-bg-card>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 pb-2">
          <span class="text-2xs font-medium text-fg-secondary">Background tasks</span>
          <button
            type="button"
            class={`inline-flex items-center gap-1 min-h-7 [@media(pointer:coarse)]:min-h-9 rounded-lg border px-2 py-0.5 text-2xs font-medium transition-colors cursor-pointer ${showArchived()
              ? "border-[color-mix(in_oklab,var(--accent)_35%,var(--border))] bg-accent-subtle text-accent"
              : "border-border bg-surface-subtle text-fg-muted hover:bg-surface-muted hover:text-fg"}`}
            aria-pressed={showArchived()}
            aria-label={`Archived tasks (${archived().length})`}
            data-rc-tip={showArchived() ? "Hide archived tasks" : `Archived tasks (${archived().length})`}
            onClick={toggleArchive}
            data-bg-archive-toggle
          >
            <Iconify icon="lucide:archive" size={12} />
            <span class="tabular-nums">{archived().length}</span>
          </button>
          <span class="ml-auto inline-flex items-center text-2xs text-fg-muted tabular-nums whitespace-nowrap" data-bg-running-count>
            {running().length} running
          </span>
        </div>
        <Show when={selected().length > 0}>
        <div class="flex flex-col gap-1.5">
          <For each={visible()}>
            {(job) => (
              <div
                class="rounded-panel border border-border bg-surface overflow-hidden"
                data-bg-row={job.id}
              >
                <div class="flex items-center">
                  <button
                    type="button"
                    aria-expanded={isOpen(job.id)}
                    data-rc-tip={isOpen(job.id) ? "Hide logs" : "Show logs"}
                    aria-label={isOpen(job.id) ? "Hide logs" : "Show logs"}
                    class="flex-1 min-w-0 flex items-center gap-2 px-3.5 py-2 min-h-9 [@media(pointer:coarse)]:min-h-11 text-left cursor-pointer hover:bg-surface-muted/60 transition-colors"
                    onClick={() => toggle(job.id)}
                  >
                    <span
                      class={`inline-flex items-center justify-center shrink-0 ${taskState(job.status).color}`}
                      role="img"
                      aria-label={taskState(job.status).label}
                      data-rc-tip={taskState(job.status).label}
                      data-bg-status={job.status}
                    >
                      <Show
                        when={job.status === "running"}
                        fallback={<Iconify icon={taskState(job.status).icon} size={14} />}
                      >
                        <ProcessEqualizer size={13} class="text-accent" />
                      </Show>
                    </span>
                    <span
                      class="truncate text-fg min-w-0 flex-1 text-xs"
                      data-rc-tip={job.label && job.label.length > 60 ? job.label : undefined}
                    >
                      <ShellCmd
                        prompt={job.kind === "exec_script" || job.kind === "python" ? "> " : "$ "}
                        text={shortLabel(job.label || job.id)}
                      />
                    </span>
                    <Show when={job.status !== "running" && job.exitCode !== undefined}>
                      <span
                        class={`shrink-0 rounded-inner border px-1.5 py-0.5 font-mono text-2xs leading-tight tabular-nums ${exitBadgeTone(job.exitCode!)}`}
                        data-bg-exit-code={job.exitCode}
                      >
                        exit {job.exitCode}
                      </span>
                    </Show>
                    <span class="text-2xs text-fg-muted tabular-nums shrink-0" data-bg-duration>
                      {duration(job)}
                    </span>
                    <Iconify icon="lucide:chevron-down" size={14} class={`shrink-0 text-fg-muted transition-transform ${isOpen(job.id) ? "rotate-180" : ""}`} />
                  </button>
                  <Show when={job.status === "running" || (!showArchived() && job.status !== "running")}>
                    <div class="flex items-center gap-1.5 pr-2.5 pl-1 shrink-0">
                      <Show when={job.status === "running"}>
                        <button
                          type="button"
                          class="ui-icon-button ui-icon-button-xs ui-icon-button-danger shrink-0 rounded-lg"
                          onClick={(e) => {
                            e.stopPropagation();
                            bg.stop(job.id);
                          }}
                          data-rc-tip="Stop task"
                          aria-label="Stop task"
                          data-bg-stop={job.id}
                        >
                          <Iconify icon="lucide:square" size={12} />
                        </button>
                      </Show>
                      <Show when={!showArchived() && job.status !== "running"}>
                        <button
                          type="button"
                          class="ui-icon-button ui-icon-button-xs shrink-0 rounded-lg text-fg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            dismiss(job.id);
                          }}
                          data-rc-tip="Dismiss task"
                          aria-label="Dismiss task"
                          data-bg-dismiss={job.id}
                        >
                          <Iconify icon="lucide:x" size={12} />
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
                <Show when={isOpen(job.id)}>
                  <div class="border-t border-border-subtle bg-surface-subtle overflow-hidden">
                    <div
                      ref={(el) => {
                        restoreToolScroll(`bg:${job.id}`, el);
                        requestAnimationFrame(() => restoreToolScroll(`bg:${job.id}`, el));
                        onCleanup(followTail(el, () => isOpen(job.id) && job.status === "running"));
                      }}
                      onScroll={(e) => recordToolScroll(`bg:${job.id}`, e.currentTarget)}
                      class="max-h-96 overflow-auto overscroll-contain"
                    >
                      <div class="min-w-full w-fit">
                        <div data-bg-log>
                          <CodeBlock embedded text={logText(job) || "No output yet."} language={undefined} plain wrap={false} scrollKey={`bg:${job.id}`} />
                        </div>
                        <Show when={(job.droppedLines || 0) > 0}>
                          <p class="px-3.5 pb-2 text-2xs text-fg-muted">
                            {job.droppedLines} earlier lines discarded by the tail cap. Use bg_check for full paging.
                          </p>
                        </Show>
                      </div>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show when={selected().length > 3}>
            <button
              type="button"
              class="self-start min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-lg px-3 py-1.5 text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
              aria-expanded={expanded()}
              onClick={() => setExpanded((value) => !value)}
              data-bg-list-toggle
            >
              {expanded() ? "Show less" : `See all (${selected().length})`}
            </button>
          </Show>
        </div>
        </Show>
      </div>
    </Show>
  );
}
