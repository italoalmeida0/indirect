import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { baseNameOf } from "../../transcript";
import { useComposerCtx, useSession, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";
import { ContextUsageMeter } from "./ContextUsageMeter";

export function ComposerFooter() {
  const c = useComposerCtx();
  const s = useSession();
  const ui = useUI();
  const pct = () => c.activeContext().percent;
  const contextTokensLabel = () => {
    const ctx = c.activeContext();
    return ctx.tokensLabel ?? ctx.label.replace(/\s*\(\d+%\)$/, "");
  };

  return (
<>
<Show when={s.draftMode() && c.pendingMode?.() !== "talk"}>
  <div class="mt-3 flex justify-center" data-draft-project>
      {/* Project picker: where the next conversation starts. Talk drafts
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
        class="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:text-fg hover:border-border-strong hover:bg-surface-subtle transition-colors cursor-pointer"
        data-rc-tip="Project" aria-label={`Project: ${s.activeProject()?.name || "Select project"}`}
      >
        <Iconify icon="lucide:folder" size={13} class="text-accent shrink-0" />
        <span class="max-w-[160px] truncate text-fg">
          {s.activeProject()?.name || "Select project"}
        </span>
        <Iconify icon="lucide:chevron-down" size={11} class={`text-fg-muted shrink-0 transition-transform duration-150 ${s.projectMenuOpen() ? "rotate-180" : ""}`} />
      </button>
      <FloatMenu anchor={() => s.projBtn} open={s.projectMenuOpen()} onClose={() => s.setProjectMenuOpen(false)} placement="bottom" width="18rem">
          <div class="-mx-1.5 -mt-1.5 mb-1.5 px-3 py-1.5 border-b border-border-subtle text-2xs font-medium text-fg-muted flex items-center justify-between">
            <span>Workspace project</span>
            <span class="font-mono text-2xs tabular-nums">{s.projects().length}</span>
          </div>
          <div class="max-h-56 overflow-y-auto overscroll-contain space-y-0.5">
            <For
              each={s.projects()}
              fallback={
                <div class="px-2.5 py-2 text-2xs text-fg-muted">
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
                    class={`ui-menu-item w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors ${
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
          <div class="mt-1 -mx-1.5 border-t border-border-subtle pt-1 px-1.5">
            <button
              type="button"
              onClick={() => {
                s.setProjectMenuOpen(false);
                s.openNewProjectModal();
              }}
              class="ui-menu-item w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-fg-secondary hover:bg-surface-muted hover:text-fg flex items-center gap-2 cursor-pointer transition-colors"
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
  <div class="flex items-center justify-between gap-3 px-3.5 py-1.5 text-2xs text-fg-muted" data-composer-footer>
    <span class="flex items-center gap-1.5 min-w-0" data-rc-tip={s.currentProject()?.path}>
      <Iconify icon="lucide:folder" size={12} class="shrink-0 text-fg-muted" />
      <span class="truncate">{s.currentProject()?.name || baseNameOf(s.activeSession()?.cwd) || "Project"}</span>
    </span>
    <FloatMenu
      anchor={() => ui.contextBtn}
      open={ui.usageOpen()}
      onClose={() => ui.setUsageOpen(false)}
      placement="top-end"
      width="min(23rem, calc(100vw - 1rem))"
    >
      <ContextUsageMeter
        pct={pct}
        settledPctLabel={<>{pct()}% full</>}
        settledHeadline={<>{contextTokensLabel()}</>}
      />
    </FloatMenu>
    {/* Tooltip suppressed while usage popover is open via aria-expanded (replaces disabled={ui.usageOpen()}) */}
    <button
      type="button"
      ref={ui.contextBtn}
      data-menubtn
      data-rc-tip="Context & token usage"
      aria-label={`Conversation context: ${c.activeContext().label}`}
      aria-expanded={ui.usageOpen()}
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={() => { const next = !ui.usageOpen(); ui.closeMenus(); ui.setUsageOpen(next); }}
      class="flex items-center gap-1.5 rounded-lg px-2 py-0.5 -mr-2 font-mono text-2xs tabular-nums text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
    >
      <Iconify icon="lucide:chart-pie" size={11} class="text-accent shrink-0" />
      <span>{c.activeContext().label}</span>
    </button>
  </div>
</Show>
</>
  );
}
