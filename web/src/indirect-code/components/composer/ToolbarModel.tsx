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
    class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 font-medium transition-colors cursor-pointer"
    data-rc-tip="Switch model" aria-label={`Switch model: ${c.activeModelName()}${formatEffort(c.effort()) ? ` ${formatEffort(c.effort())}` : ""}`}
  >
    <span class="max-w-[120px] sm:max-w-[180px] truncate">{c.activeModelName()}</span>
    <Show when={formatEffort(c.effort())}>
      <span class="text-ink-500 shrink-0 text-[11px]">{" "}{formatEffort(c.effort())}</span>
    </Show>
    <Iconify icon="lucide:chevron-down" size={11} class={`shrink-0 transition-transform duration-150 ${ui.modelMenuOpen() ? "rotate-180" : ""}`} />
  </button>
  <FloatMenu anchor={() => c.modelBtn} open={ui.modelMenuOpen()} role="dialog" aria-label="Select model" placement="top-start" width="26rem">
    <div>{c.modelPickerBody()}</div>
  </FloatMenu>

</div>
</Show>
</>
  );
}
