import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { formatEffort, normalizeEffort } from "../../utils/format";
import { useComposerCtx, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";

export function ToolbarModel() {
  const c = useComposerCtx();
  const ui = useUI();
  const anyMenuOpen = () => ui.effortMenuOpen() || ui.modelMenuOpen();
  const isMaxEffort = () => normalizeEffort(c.effort()) === "max";
  return (
<>
{/* Effort + Model pickers (desktop toolbar only — on mobile they live in the + menu) */}
<Show when={!ui.isMobile()}>
<div>
  <button
    type="button"
    ref={c.modelBtn}
    data-menubtn
    aria-expanded={anyMenuOpen()}
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={(e) => {
      e.stopPropagation();
      if (anyMenuOpen()) {
        ui.setEffortMenuOpen(false);
        ui.setModelMenuOpen(false);
      } else {
        ui.closeMenus();
        ui.setEffortMenuOpen(true);
        ui.setModelMenuOpen(false);
      }
    }}
    class="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
    data-rc-tip="Effort & model" aria-label={`Switch model: ${c.activeModelName()}${formatEffort(c.effort()) ? ` ${formatEffort(c.effort())}` : ""}`}
  >
    <Iconify icon="lucide:cpu" size={13} class="shrink-0 text-fg-muted" />
    <span class="max-w-[130px] sm:max-w-[190px] truncate text-fg">{c.activeModelName()}</span>
    <Show when={formatEffort(c.effort())}>
      <span
        class={`rounded border px-1 py-0.5 font-mono text-[10px] font-medium shrink-0 leading-none transition-colors ${
          isMaxEffort()
            ? "border-accent/35 bg-accent-subtle text-accent"
            : "border-border/80 bg-surface-subtle text-fg-muted"
        }`}
      >
        {formatEffort(c.effort())}
      </span>
    </Show>
    <Iconify icon="lucide:chevron-down" size={11} class={`shrink-0 text-fg-muted transition-transform duration-150 ${anyMenuOpen() ? "rotate-180" : ""}`} />
  </button>
  <FloatMenu
    anchor={() => c.modelBtn}
    open={ui.effortMenuOpen()}
    onClose={() => ui.setEffortMenuOpen(false)}
    role="dialog"
    aria-label="Reasoning effort"
    placement="top-start"
    width="min(20.5rem, calc(100vw - 1.5rem))"
  >
    <div>{c.effortPickerBody()}</div>
  </FloatMenu>
  <FloatMenu
    anchor={() => c.modelBtn}
    open={ui.modelMenuOpen()}
    onClose={() => ui.setModelMenuOpen(false)}
    role="dialog"
    aria-label="Select model"
    placement="top-start"
    width="min(26rem, calc(100vw - 1.5rem))"
  >
    <div>{c.modelPickerBody(true)}</div>
  </FloatMenu>

</div>
</Show>
</>
  );
}
