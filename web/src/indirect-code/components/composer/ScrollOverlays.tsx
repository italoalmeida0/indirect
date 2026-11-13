import { createEffect, For, Show } from "solid-js";
import { FloatMenu } from "../FloatMenu";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { useComposerCtx, useTranscriptCtx } from "../../ctx";

export function ScrollOverlays() {
  const c = useComposerCtx();
  const t = useTranscriptCtx();
  let slashList: HTMLDivElement | undefined;
  createEffect(() => {const index = c.slashIndex(); slashList?.querySelectorAll("button")[index]?.scrollIntoView({block:"nearest"});});
  return (
<>
{/* Detached older-history pill or floating pin-at-bottom */}
<Show
  when={t.historyHasNewer()}
  fallback={
    <Show when={!t.isAtBottom() && t.messages().length > 0}>
      <div class="absolute bottom-full inset-x-0 mb-2 flex justify-center pointer-events-none z-30 px-4">
        <button
          type="button"
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => t.pinAtBottom()}
          class="pointer-events-auto inline-flex items-center gap-1.5 min-h-8 [@media(pointer:coarse)]:min-h-11 px-3.5 py-1.5 rounded-full text-xs font-medium bg-surface-raised/95 backdrop-blur-md border border-border text-fg-secondary shadow-raised hover:text-fg hover:border-border-strong transition-colors cursor-pointer"
        >
          <Iconify icon="lucide:pin" size={13} class="text-accent shrink-0" />
          <span>Pin at bottom</span>
        </button>
      </div>
    </Show>
  }
>
  <div class="absolute bottom-full inset-x-0 mb-2 flex justify-center pointer-events-none z-30 px-4">
    <button
      type="button"
      data-history-jump-latest
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={() => t.reloadLatest()}
      class="pointer-events-auto inline-flex items-center gap-1.5 min-h-8 [@media(pointer:coarse)]:min-h-11 px-3.5 py-1.5 rounded-full text-xs font-medium bg-surface-raised/95 backdrop-blur-md border border-border text-fg-secondary shadow-raised hover:text-fg hover:border-border-strong transition-colors cursor-pointer"
    >
      <Iconify icon="lucide:arrow-down" size={13} class="text-accent shrink-0" />
      <span>Viewing older history · <span class="text-fg">Jump to latest</span></span>
    </button>
  </div>
</Show>
{/* Slash Command Autocomplete Menu */}
<FloatMenu
  anchor={() => document.getElementById("rc-composer")}
  open={c.slashMatches().length > 0}
  onClose={() => c.dismissSlash()}
  aria-label="Slash commands"
  placement="top-start"
  width="min(34rem, calc(100vw - 1.5rem))"
>
  <div class="-mx-1.5 -mt-1.5 mb-1.5 px-3 py-1.5 border-b border-border-subtle text-2xs font-medium text-fg-muted">
    Slash commands
  </div>
  <div ref={slashList} class="max-h-60 overflow-y-auto overscroll-contain space-y-0.5">
    <For each={c.slashMatches()}>
      {(sc, idx) => {
        const active = () => idx() === c.slashIndex();
        return (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => c.pickSlash(sc.cmd)}
            class={`ui-menu-item w-full text-left px-2.5 py-1.5 min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-lg text-xs flex items-center justify-between gap-3 transition-colors cursor-pointer ${
              active()
                ? "bg-accent-subtle text-fg"
                : "text-fg-secondary hover:bg-surface-muted hover:text-fg"
            }`}
          >
            <div class="flex items-center gap-2 font-mono font-medium shrink-0">
              <span class={active() ? "text-accent" : "text-fg"}>{sc.cmd}</span>
              <Show when={sc.args}>
                <span class="text-2xs text-fg-muted">{sc.args}</span>
              </Show>
            </div>
            <span class="text-xs text-fg-muted truncate">{sc.desc}</span>
          </button>
        );
      }}
    </For>
  </div>
</FloatMenu>
</>
  );
}
