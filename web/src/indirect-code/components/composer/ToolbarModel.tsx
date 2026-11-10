import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { formatEffort } from "../../utils/format";
import { useComposerCtx, useSession, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";

export function ToolbarModel() {
  const c = useComposerCtx();
  const s = useSession();
  const ui = useUI();
  return (
<>
{/* Model picker (desktop toolbar only — on mobile it is in the + menu) */}
<Show when={!ui.isMobile()}>
<div>
  <button
    ref={c.modelBtn}
    data-menubtn
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={(e) => {
      e.stopPropagation();
      ui.setModelMenuOpen(!ui.modelMenuOpen());
      s.setProjectMenuOpen(false);
      c.setAddContextOpen(false);
      ui.setUsageOpen(false);
    }}
    class="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
    data-rc-tip="Switch model" aria-label={`Switch model: ${c.activeModelName()}${formatEffort(c.effort()) ? ` ${formatEffort(c.effort())}` : ""}`}
  >
    <Iconify icon="lucide:cpu" size={13} class="shrink-0 text-fg-muted" />
    <span class="max-w-[130px] sm:max-w-[190px] truncate text-fg">{c.activeModelName()}</span>
    <Show when={formatEffort(c.effort())}>
      <span class="rounded border border-border/80 bg-surface-subtle px-1 py-0.5 text-[10px] font-medium text-fg-muted shrink-0 leading-none">{formatEffort(c.effort())}</span>
    </Show>
    <Iconify icon="lucide:chevron-down" size={11} class={`shrink-0 text-fg-muted transition-transform duration-150 ${ui.modelMenuOpen() ? "rotate-180" : ""}`} />
  </button>
  <FloatMenu anchor={() => c.modelBtn} open={ui.modelMenuOpen()} role="dialog" aria-label="Select model" placement="top-start" width="min(25rem, calc(100vw - 1.5rem))">
    <div>{c.modelPickerBody()}</div>
  </FloatMenu>

</div>
</Show>
</>
  );
}
