import { batch, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { formatEffort, normalizeEffort } from "../../utils/format";
import { useComposerCtx, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";

const COMPACT_EFFORT_LABELS: Record<string, string> = {
  OFF: "OFF",
  MIN: "MIN",
  LOW: "L",
  MED: "M",
  HIGH: "H",
  XHIGH: "XH",
  MAX: "MAX",
};

function compactEffortLabel(raw: string): string {
  const full = formatEffort(raw);
  return COMPACT_EFFORT_LABELS[full] ?? full;
}

export function ToolbarModel() {
  const c = useComposerCtx();
  const ui = useUI();
  const anyMenuOpen = () => ui.effortMenuOpen() || ui.modelMenuOpen();
  const isMaxEffort = () => normalizeEffort(c.effort()) === "max";
  return (
<>
{/* Effort + Model pickers (desktop and mobile composer toolbar) */}
<div class="min-w-0 shrink">
  <button
    type="button"
    ref={(el) => {
      c.modelBtn = el;
      press(el);
    }}
    data-menubtn
    aria-expanded={anyMenuOpen()}
    onClick={(e) => {
      e.stopPropagation();
      if (anyMenuOpen()) {
        ui.setEffortMenuOpen(false);
        ui.setModelMenuOpen(false);
        ui.setModelFromEffort?.(false);
      } else {
        ui.closeMenus();
        ui.setModelFromEffort?.(false);
        ui.setEffortMenuOpen(true);
      }
    }}
    class={`rc-composer-model relative h-7 max-w-full min-w-0 flex items-center rounded-lg text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer ${
      ui.isMobile() ? "gap-1 px-1" : "gap-1 sm:gap-1.5 px-1.5 sm:px-2"
    }`}
    data-rc-tip="Effort & model" aria-label={`Switch model: ${c.activeModelName()}${formatEffort(c.effort()) ? ` ${formatEffort(c.effort())}` : ""}`}
  >
    <Show when={!ui.isMobile()}>
      <Iconify icon="lucide:cpu" size={13} class="shrink-0 text-fg-muted hidden sm:inline-flex" />
    </Show>
    <span class="min-w-0 truncate text-fg @[500px]:max-w-[200px]">{c.activeModelName()}</span>
    <Show when={formatEffort(c.effort())}>
      <span
        class={`inline-flex items-center rounded border px-1 py-0.5 font-mono text-2xs font-medium shrink-0 leading-none transition-colors ${
          isMaxEffort()
            ? "border-accent/35 bg-accent-subtle text-accent"
            : "border-border bg-surface-subtle text-fg-muted"
        }`}
      >
        <span class="sm:hidden">{compactEffortLabel(c.effort())}</span>
        <span class="hidden sm:inline">{formatEffort(c.effort())}</span>
      </span>
    </Show>
    <Iconify icon="lucide:chevron-down" size={11} class={`hidden sm:inline-flex shrink-0 text-fg-muted transition-transform duration-150 ${anyMenuOpen() ? "rotate-180" : ""}`} />
  </button>
  <FloatMenu
    anchor={() => c.modelBtn}
    open={ui.effortMenuOpen()}
    onClose={() => ui.setEffortMenuOpen(false)}
    role="dialog"
    aria-label="Reasoning effort"
    placement="top-start"
    width={ui.isMobile() ? "min(20.5rem, calc(100vw - 1rem))" : "min(20.5rem, calc(100vw - 1.5rem))"}
  >
    <div>{c.effortPickerBody()}</div>
  </FloatMenu>
  <FloatMenu
    anchor={() => c.modelBtn}
    open={ui.modelMenuOpen()}
    onClose={() => ui.setModelMenuOpen(false)}
    onEscape={() => {
      if (c.modelFilter?.()) {
        c.setModelFilter?.("");
        return;
      }
      if (ui.modelFromEffort?.()) {
        batch(() => {
          ui.setModelMenuOpen(false);
          ui.setEffortMenuOpen(true);
        });
        return;
      }
      ui.setModelMenuOpen(false);
      c.modelBtn?.focus();
    }}
    role="dialog"
    aria-label="Select model"
    placement="top-start"
    width={ui.isMobile() ? "min(24rem, calc(100vw - 1rem))" : "min(26rem, calc(100vw - 1.5rem))"}
  >
    <div>{c.modelPickerBody(true)}</div>
  </FloatMenu>

</div>
</>
  );
}
