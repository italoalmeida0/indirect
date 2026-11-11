import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { Tooltip } from "../../../ui";
import { compactTokens } from "../../context";
import { baseNameOf, cacheHitPct, fmtUsd, usageCosts } from "../../transcript";
import { useComposerCtx, useSession, useTranscriptCtx, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";

export function ComposerFooter() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  const ui = useUI();
  const pct = () => c.activeContext().percent;
  const barToneClass = () => {
    const p = pct() ?? 0;
    if (p >= 92) return "bg-danger";
    if (p >= 78) return "bg-warning";
    return "bg-accent";
  };

  return (
<>
<Show when={s.draftMode() && c.pendingMode?.() !== "talk"}>
  <div class="mt-3 flex justify-center" data-draft-project>
    {/* Project picker — where the next conversation starts. Talk drafts
        have no project (they are born in the default Home project), so
        the picker hides while the pending mode is talk.
        Default: project of the newest conversation (daemon). */}
    <div>
      <button
        type="button"
        ref={s.projBtn}
        data-menubtn
        aria-expanded={s.projectMenuOpen()}
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={(e) => {
          e.stopPropagation();
          s.setProjectMenuOpen(!s.projectMenuOpen());
          ui.setEffortMenuOpen(false);
          ui.setModelMenuOpen(false);
          c.setAddContextOpen(false);
          c.setModeMenuOpen(false);
          c.setAccessMenuOpen(false);
          ui.setUsageOpen(false);
        }}
        class="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-fg-secondary hover:text-fg hover:border-border-strong hover:bg-surface-subtle transition-colors cursor-pointer"
        data-rc-tip="Project" aria-label={`Project: ${s.activeProject()?.name || "Select project"}`}
      >
        <Iconify icon="lucide:folder" size={13} class="text-accent shrink-0" />
        <span class="max-w-[160px] truncate text-fg">
          {s.activeProject()?.name || "Select project"}
        </span>
        <Iconify icon="lucide:chevron-down" size={11} class={`text-fg-muted shrink-0 transition-transform duration-150 ${s.projectMenuOpen() ? "rotate-180" : ""}`} />
      </button>
      <FloatMenu anchor={() => s.projBtn} open={s.projectMenuOpen()} onClose={() => s.setProjectMenuOpen(false)} placement="bottom" width="18rem">
          <div class="px-2.5 py-1.5 border-b border-border-subtle mb-0.5 text-[11px] font-medium text-fg-muted flex items-center justify-between">
            <span>Workspace project</span>
            <span class="font-mono text-[10px] tabular-nums">{s.projects().length}</span>
          </div>
          <div class="max-h-56 overflow-y-auto space-y-0.5 px-0.5 [scrollbar-gutter:stable]">
            <For
              each={s.projects()}
              fallback={
                <div class="px-2.5 py-2 text-[11px] text-fg-muted">
                  No projects yet.
                </div>
              }
            >
              {(p) => {
                const active = () => p.id === s.activeProject()?.id;
                return (
                  <button
                    type="button"
                    onClick={() => {
                      s.pickProject(p.id);
                      s.setProjectMenuOpen(false);
                    }}
                    class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                      active()
                        ? "bg-accent-subtle text-fg font-medium"
                        : "text-fg-secondary hover:text-fg hover:bg-surface-muted"
                    }`}
                    data-rc-tip={p.path} aria-label={`${p.name} (${p.path})`}
                  >
                    <span class="flex items-center gap-2 min-w-0">
                      <Iconify icon="lucide:folder" size={13} class={`shrink-0 ${active() ? "text-accent" : "text-fg-muted"}`} />
                      <span class="truncate">{p.name}</span>
                    </span>
                    <Show when={active()}>
                      <Iconify icon="lucide:check" size={13} class="text-accent shrink-0" />
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
          <div class="mt-1 border-t border-border-subtle pt-1 px-0.5">
            <button
              type="button"
              onClick={() => {
                s.setProjectMenuOpen(false);
                s.openNewProjectModal();
              }}
              class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-fg-secondary hover:bg-surface-muted hover:text-fg flex items-center gap-2 cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:folder-plus" size={13} class="text-accent shrink-0" />
              <span>New project…</span>
            </button>
          </div>
      </FloatMenu>
    </div>
  </div>
</Show>
<Show when={s.activeSessionId()}>
  <div class="flex items-center justify-between gap-3 px-1.5 py-1.5 text-[11px] text-fg-muted" data-composer-footer>
    <span class="flex items-center gap-1.5 min-w-0" data-rc-tip={s.currentProject()?.path}>
      <Iconify icon="lucide:folder" size={12} class="shrink-0 text-fg-muted" />
      <span class="truncate">{s.currentProject()?.name || baseNameOf(s.activeSession()?.cwd) || "Project"}</span>
    </span>
    <FloatMenu anchor={() => ui.contextBtn} open={ui.usageOpen()} onClose={() => ui.setUsageOpen(false)} placement="top-end" width="min(19.5rem, calc(100vw - 1.5rem))">
      <div class="p-2 text-xs space-y-2.5">
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-medium text-fg-muted">Conversation context</span>
            <Show when={pct() !== null}>
              <span class="rounded border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] font-medium text-fg-secondary tabular-nums">
                {Math.min(100, pct() ?? 0)}% full
              </span>
            </Show>
          </div>
          <div class="font-mono text-sm font-medium text-fg tabular-nums tracking-tight">{c.activeContext().label}</div>
          <Show when={pct() !== null}>
            <div
              class="h-1.5 rounded-full bg-surface-muted overflow-hidden"
              role="progressbar"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, pct() ?? 0)}
            >
              <div class={`h-full rounded-full transition-all duration-200 ${barToneClass()}`} style={{ width: `${Math.min(100, pct() ?? 0)}%` }} />
            </div>
          </Show>
          <p class="text-[11px] text-fg-muted leading-snug">
            {c.activeContext().window > 0 ? `${compactTokens(c.activeContext().window)} token window.` : "Context limit not configured."}
            {" "}Latest request + response.
          </p>
        </div>

        <div class="pt-2.5 border-t border-border-subtle space-y-2">
          <Show
            when={t.activeUsage()}
            fallback={
              <>
                <div class="text-[11px] font-medium text-fg-muted">Session telemetry</div>
                <p class="text-fg-muted text-[11px] leading-snug">
                  No usage reported yet. Run a turn to inspect input, cache, and output tokens.
                </p>
              </>
            }
          >
            {(u) => {
              const costs = usageCosts(u());
              const totalTok = () => Math.max(1, (u().inTok || 0) + (u().cacheTok || 0) + (u().outTok || 0) + (u().reasoningTok || 0));
              const chip = (v: number | undefined) =>
                costs ? <span class="text-fg-muted ml-1.5">${fmtUsd(v || 0)}</span> : null;
              return (
                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-[11px] font-medium text-fg-muted">Session telemetry</span>
                    <Show when={costs && costs.total > 0}>
                      <span class="font-mono text-[11px] font-medium text-fg tabular-nums">
                        ${fmtUsd(costs!.total)}
                      </span>
                    </Show>
                  </div>
                  <div class="h-1 rounded-full bg-surface-muted overflow-hidden flex gap-px" aria-hidden="true">
                    <div class="h-full bg-accent" style={{ width: `${((u().inTok || 0) / totalTok()) * 100}%` }} />
                    <div class="h-full bg-tone-sky" style={{ width: `${((u().cacheTok || 0) / totalTok()) * 100}%` }} />
                    <div class="h-full bg-tone-violet" style={{ width: `${((u().outTok || 0) / totalTok()) * 100}%` }} />
                    <div class="h-full bg-tone-amber" style={{ width: `${((u().reasoningTok || 0) / totalTok()) * 100}%` }} />
                  </div>
                  <div class="space-y-1 pt-0.5 font-mono text-[11px] tabular-nums">
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 font-sans text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-accent" />Input</span>
                      <span class="text-fg">{compactTokens(u().inTok)}{chip(costs?.input)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 font-sans text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-tone-sky" />Cache{(() => { const p = cacheHitPct(u()); return p === null ? "" : ` (${p}%)`; })()}</span>
                      <span class="text-fg">{compactTokens(u().cacheTok)}{chip(costs?.cache)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 font-sans text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-tone-violet" />Output</span>
                      <span class="text-fg">{compactTokens(u().outTok)}{chip(costs?.output)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 font-sans text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-tone-amber" />Reasoning</span>
                      <span class="text-fg">{compactTokens(u().reasoningTok)}{chip(costs?.reasoning)}</span>
                    </div>
                  </div>
                </div>
              );
            }}
          </Show>
        </div>
      </div>
    </FloatMenu>
    <Tooltip content="Conversation context and session usage" disabled={ui.usageOpen()}>
      <button
        type="button"
        ref={ui.contextBtn}
        data-menubtn
        aria-label={`Conversation context: ${c.activeContext().label}`}
        aria-expanded={ui.usageOpen()}
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={() => { const next = !ui.usageOpen(); ui.closeMenus(); ui.setUsageOpen(next); }}
        class="flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] tabular-nums text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
      >
        <Iconify icon="lucide:chart-pie" size={11} class="text-accent shrink-0" />
        <span>{c.activeContext().label}</span>
      </button>
    </Tooltip>
  </div>
</Show>
</>
  );
}
