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
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={(e) => {
          e.stopPropagation();
          s.setProjectMenuOpen(!s.projectMenuOpen());
          ui.setModelMenuOpen(false);
          c.setAddContextOpen(false);
          ui.setUsageOpen(false);
        }}
        class="ui-button ui-button-outline ui-button-sm gap-2 shadow-resting"
        data-rc-tip="Project" aria-label={`Project: ${s.activeProject()?.name || "Select project"}`}
      >
        <Iconify icon="lucide:folder" size={13} class="text-accent" />
        <span class="max-w-[140px] truncate">
          {s.activeProject()?.name || "Select project"}
        </span>
        <Iconify icon="lucide:chevron-down" size={11} class={`text-fg-muted transition-transform duration-150 ${s.projectMenuOpen() ? "rotate-180" : ""}`} />
      </button>
      <FloatMenu anchor={() => s.projBtn} open={s.projectMenuOpen()} placement="bottom" width="18rem">
          <div class="px-2.5 py-1.5 text-[11px] font-medium text-fg-muted flex items-center justify-between">
            <span>Project</span>
            <span class="font-mono text-[10px]">{s.projects().length}</span>
          </div>
          <div class="max-h-56 overflow-y-auto space-y-0.5 [scrollbar-gutter:stable]">
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
          <div class="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={() => {
                s.setProjectMenuOpen(false);
                s.openNewProjectModal();
              }}
              class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-fg-secondary hover:bg-surface-muted hover:text-fg flex items-center gap-2 cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:folder-plus" size={13} class="text-accent" />
              <span>New project…</span>
            </button>
          </div>
      </FloatMenu>
    </div>
  </div>
</Show>
<Show when={s.activeSessionId()}>
  <div class="flex items-center justify-between gap-3 px-1 py-1.5 text-[11px] text-fg-muted" data-composer-footer>
    <span class="flex items-center gap-1.5 min-w-0" data-rc-tip={s.currentProject()?.path}>
      <Iconify icon="lucide:folder" size={12} class="shrink-0 text-fg-muted" />
      <span class="truncate">{s.currentProject()?.name || baseNameOf(s.activeSession()?.cwd) || "Project"}</span>
    </span>
    <FloatMenu anchor={() => ui.contextBtn} open={ui.usageOpen()} placement="top-end" width="20rem">
      <div class="p-2 text-xs space-y-3">
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-fg">Conversation context</span>
            <Show when={pct() !== null}>
              <span class="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10px] font-medium text-fg-secondary tabular-nums">
                {Math.min(100, pct() ?? 0)}% full
              </span>
            </Show>
          </div>
          <div class="text-lg font-medium text-fg tabular-nums tracking-tight">{c.activeContext().label}</div>
          <p class="text-[11px] text-fg-muted leading-relaxed">
            {c.activeContext().window > 0 ? `${compactTokens(c.activeContext().window)} tokens configured in the gateway.` : "Context limit not configured in the gateway."}
            {" "}Measured from the latest model request and its response.
          </p>
          <Show when={pct() !== null}>
            <div
              class="h-2 rounded-full bg-surface-muted overflow-hidden mt-2"
              role="progressbar"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, pct() ?? 0)}
            >
              <div class={`h-full rounded-full transition-all duration-200 ${barToneClass()}`} style={{ width: `${Math.min(100, pct() ?? 0)}%` }} />
            </div>
          </Show>
        </div>

        <div class="pt-2.5 border-t border-border space-y-2">
          <div class="font-medium text-fg">Session usage</div>
          <Show
            when={t.activeUsage()}
            fallback={
              <p class="text-fg-muted text-[11px] leading-relaxed">
                No usage reported yet. Run the agent to see input / cache / output tokens here.
              </p>
            }
          >
            {(u) => {
              const costs = usageCosts(u());
              const totalTok = () => Math.max(1, (u().inTok || 0) + (u().cacheTok || 0) + (u().outTok || 0) + (u().reasoningTok || 0));
              const chip = (v: number | undefined) =>
                costs ? <span class="text-fg-muted ml-1.5">${fmtUsd(v || 0)}</span> : null;
              return (
                <div class="space-y-2">
                  {/* Proportional Token Distribution Bar */}
                  <div class="h-1.5 rounded-full bg-surface-muted overflow-hidden flex gap-px" aria-hidden="true">
                    <div class="h-full bg-accent" style={{ width: `${((u().inTok || 0) / totalTok()) * 100}%` }} />
                    <div class="h-full bg-tone-sky" style={{ width: `${((u().cacheTok || 0) / totalTok()) * 100}%` }} />
                    <div class="h-full bg-tone-violet" style={{ width: `${((u().outTok || 0) / totalTok()) * 100}%` }} />
                    <div class="h-full bg-tone-amber" style={{ width: `${((u().reasoningTok || 0) / totalTok()) * 100}%` }} />
                  </div>
                  <div class="rc-studio-well p-2.5 space-y-1.5 font-mono text-[11px]">
                    <Show when={costs && costs.total > 0}>
                      <div class="flex justify-between pb-1.5 mb-1 border-b border-border">
                        <span class="text-fg-secondary font-sans font-medium">Total spend</span>
                        <span class="text-fg font-medium">${fmtUsd(costs!.total)}</span>
                      </div>
                    </Show>
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-accent" />Input</span>
                      <span class="text-fg">{compactTokens(u().inTok)}{chip(costs?.input)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-tone-sky" />Cache{(() => { const p = cacheHitPct(u()); return p === null ? "" : ` (${p}%)`; })()}</span>
                      <span class="text-fg">{compactTokens(u().cacheTok)}{chip(costs?.cache)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-tone-violet" />Output</span>
                      <span class="text-fg">{compactTokens(u().outTok)}{chip(costs?.output)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="flex items-center gap-1.5 text-fg-secondary"><span class="h-1.5 w-1.5 rounded-full bg-tone-amber" />Reasoning</span>
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
        class="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] tabular-nums text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
      >
        <Iconify icon="lucide:chart-pie" size={12} class="text-accent" />
        <span>{c.activeContext().label}</span>
      </button>
    </Tooltip>
  </div>
</Show>
</>
  );
}
