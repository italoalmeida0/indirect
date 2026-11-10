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
{/* Floating pin-at-bottom (unlocks on any scroll gesture) */}
<Show when={!t.isAtBottom() && t.messages().length > 0}>
  <div class="flex justify-center pb-2">
    <button
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={() => t.pinAtBottom()}
      class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium bg-surface-raised/95 backdrop-blur-md border border-border text-fg-secondary shadow-raised hover:text-fg hover:border-border-strong transition-colors cursor-pointer"
    >
      <Iconify icon="lucide:pin" size={13} class="text-accent" />
      <span>Pin at bottom</span>
    </button>
  </div>
</Show>
{/* Slash Command Autocomplete Menu */}
<FloatMenu anchor={() => document.getElementById("rc-composer")} open={c.slashMatches().length > 0} placement="top-start" width="min(34rem, calc(100vw - 1.5rem))">
  <div ref={slashList} class="p-1 max-h-60 overflow-y-auto space-y-0.5">
    <div class="px-2.5 py-1 text-[11px] font-medium text-fg-muted">
      Slash commands
    </div>
    <For each={c.slashMatches()}>
      {(sc, idx) => {
        const active = () => idx() === c.slashIndex();
        return (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => c.pickSlash(sc.cmd)}
            class={`w-full text-left px-2.5 py-2 rounded-lg text-xs flex items-center justify-between gap-3 transition-colors cursor-pointer ${
              active()
                ? "bg-accent-subtle text-fg"
                : "text-fg-secondary hover:bg-surface-muted hover:text-fg"
            }`}
          >
            <div class="flex items-center gap-2 font-mono font-medium shrink-0">
              <span class={active() ? "text-accent" : "text-fg"}>{sc.cmd}</span>
              <Show when={sc.args}>
                <span class="text-[11px] text-fg-muted">{sc.args}</span>
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
