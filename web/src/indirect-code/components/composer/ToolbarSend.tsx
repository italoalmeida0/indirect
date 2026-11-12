import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { FloatMenu } from "../FloatMenu";
import { useComposerCtx, useModal, useSession, useTranscriptCtx, useUI } from "../../ctx";
import type { MidTurnDelivery } from "../../utils/settingsValidation";

const MID_TURN_MODES: Array<{
  value: MidTurnDelivery;
  pillLabel: string;
  menuLabel: string;
  description: string;
  sendTip: string;
  icon: string;
}> = [
  {
    value: "queue",
    pillLabel: "Queue",
    menuLabel: "Queue",
    description: "Send after turn finishes",
    sendTip: "Queue message",
    icon: "lucide:list-plus",
  },
  {
    value: "steer",
    pillLabel: "Next step",
    menuLabel: "Send next",
    description: "Inject on next AI step",
    sendTip: "Send on next step",
    icon: "lucide:corner-up-right",
  },
  {
    value: "interrupt",
    pillLabel: "Interrupt",
    menuLabel: "Interrupt now",
    description: "Stop current step & send immediately",
    sendTip: "Interrupt & send immediately",
    icon: "lucide:zap",
  },
];

export function MidTurnModeMenuBody(props: {
  selected: () => MidTurnDelivery;
  onSelect: (mode: MidTurnDelivery) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div class="flex flex-col gap-0.5" data-midturn-menu-body>
      <div class="px-2 py-1 text-[11px] font-medium text-fg-muted">
        Mid-turn send behavior
      </div>
      <For each={MID_TURN_MODES}>
        {(opt) => {
          const active = () => props.selected() === opt.value;
          return (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={active()}
              data-midturn-option={opt.value}
              onClick={() => props.onSelect(opt.value)}
              class={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer ${
                active()
                  ? "bg-accent-subtle/60 text-fg"
                  : "text-fg-secondary hover:bg-surface-muted hover:text-fg"
              }`}
            >
              <Iconify
                icon={opt.icon}
                size={14}
                class={`mt-0.5 shrink-0 ${
                  opt.value === "interrupt" && active()
                    ? "text-warning"
                    : active()
                      ? "text-accent"
                      : "text-fg-muted"
                }`}
              />
              <span class="flex-1 min-w-0">
                <span class="block text-xs font-medium text-fg">
                  {opt.menuLabel}
                </span>
                <span class="block text-[11px] text-fg-muted">
                  {opt.description}
                </span>
              </span>
              <Show when={active()}>
                <Iconify
                  icon="lucide:check"
                  size={13}
                  class="mt-0.5 shrink-0 text-accent"
                />
              </Show>
            </button>
          );
        }}
      </For>
      <div class="mt-1 border-t border-border/70 pt-1">
        <button
          type="button"
          role="menuitem"
          data-action="midturn-open-settings"
          onClick={props.onOpenSettings}
          class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
        >
          <span>Change default in Settings…</span>
          <Iconify icon="lucide:sliders-horizontal" size={12} class="shrink-0" />
        </button>
      </div>
    </div>
  );
}

export function ToolbarSend() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  const m = useModal();
  const ui = useUI();

  let modeBtnRef: HTMLButtonElement | undefined;

  const isRunning = () => t.sessionStatus() === "running";
  const currentMode = (): MidTurnDelivery => c.midTurnDelivery?.() ?? "queue";
  const menuOpen = () => Boolean(c.midTurnMenuOpen?.());
  const modeMeta = () =>
    MID_TURN_MODES.find((opt) => opt.value === currentMode()) ??
    MID_TURN_MODES[0]!;

  const pillToneClass = () => {
    const mode = currentMode();
    if (mode === "steer") {
      return "border-accent/35 bg-accent-subtle text-accent hover:bg-accent-subtle/80";
    }
    if (mode === "interrupt") {
      return "border-warning/40 bg-warning-subtle text-warning hover:bg-warning-subtle/80";
    }
    return "border-border bg-surface-subtle text-fg-secondary hover:bg-surface-muted hover:text-fg";
  };

  const sendToneClass = () => {
    if (!isRunning()) {
      return "bg-fg text-background hover:opacity-90 active:opacity-80";
    }
    const mode = currentMode();
    if (mode === "steer") {
      return "bg-accent text-accent-foreground hover:bg-accent-strong active:opacity-90";
    }
    if (mode === "interrupt") {
      return "border border-warning/45 bg-warning-subtle text-warning hover:bg-warning/20 active:opacity-90 disabled:border-transparent";
    }
    return "bg-fg text-background hover:opacity-90 active:opacity-80";
  };

  const sendIcon = () => (isRunning() ? modeMeta().icon : "lucide:arrow-up");

  const sendLabel = () => {
    if (!s.activeSessionId()) return "Start conversation";
    if (isRunning()) return modeMeta().sendTip;
    return "Send";
  };

  const sendTip = () => {
    if (c.sending()) return "Uploading attachments...";
    return sendLabel();
  };

  return (
    <div class="flex shrink-0 items-center gap-1.5">
      <Show when={isRunning()}>
        <button
          ref={modeBtnRef}
          type="button"
          data-composer-midturn-mode={currentMode()}
          data-menubtn
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          data-rc-tip="Mid-turn send mode"
          aria-label={`Mid-turn send mode: ${modeMeta().pillLabel}`}
          onPointerDown={(e) => {
            if (!e.currentTarget.disabled) press(e.currentTarget);
          }}
          onClick={() => {
            const next = !menuOpen();
            if (next) ui.closeMenus?.();
            c.setMidTurnMenuOpen?.(next);
          }}
          class={`h-7 shrink-0 rounded-full border px-2 text-[11px] font-medium inline-flex items-center gap-1 transition-colors cursor-pointer ${pillToneClass()}`}
        >
          <Iconify icon={modeMeta().icon} size={12} class="shrink-0" />
          <span>{modeMeta().pillLabel}</span>
          <Iconify icon="lucide:chevron-down" size={11} class="opacity-70 shrink-0" />
        </button>
        <FloatMenu
          anchor={() => modeBtnRef}
          open={menuOpen()}
          onClose={() => c.setMidTurnMenuOpen?.(false)}
          placement="top-end"
          width="min(18.5rem, calc(100vw - 1rem))"
          role="menu"
          aria-label="Mid-turn send mode"
        >
          <MidTurnModeMenuBody
            selected={currentMode}
            onSelect={(mode) => {
              c.setMidTurnMenuOpen?.(false);
              c.setMidTurnDelivery?.(mode);
            }}
            onOpenSettings={() => {
              c.setMidTurnMenuOpen?.(false);
              m.openSettings?.("rc-set-mid-turn-send");
            }}
          />
        </FloatMenu>
        <button
          type="button"
          onPointerDown={(e) => {
            if (!e.currentTarget.disabled) press(e.currentTarget);
          }}
          onClick={t.cancelCurrentTurn}
          disabled={t.turnActivity()?.status === "cancelling"}
          class="h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center border border-danger/35 bg-danger-subtle text-danger hover:bg-danger/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          data-rc-tip={t.turnActivity()?.status === "cancelling" ? "Stopping…" : "Stop"}
          aria-label={t.turnActivity()?.status === "cancelling" ? "Stopping turn" : "Stop"}
        >
          <span class="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
        </button>
      </Show>
      <button
        type="button"
        onPointerDown={(e) => {
          if (!e.currentTarget.disabled) press(e.currentTarget);
        }}
        onClick={c.sendPrompt}
        disabled={
          s.creatingSession() ||
          c.sending() ||
          c.preparingAttachments() > 0 ||
          !c.activeModel() ||
          (s.activeSessionId()
            ? !c.inputPrompt().trim() && c.pendingAttachments().length === 0
            : (!c.inputPrompt().trim() && c.pendingAttachments().length === 0) || !s.activeProject())
        }
        class={`rc-composer-send h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center ${sendToneClass()} disabled:bg-surface-muted disabled:text-fg-muted disabled:opacity-100 disabled:cursor-not-allowed transition-all cursor-pointer`}
        data-rc-tip={sendTip()}
        aria-label={sendLabel()}
      >
        <Iconify icon={sendIcon()} size={15} />
      </button>
    </div>
  );
}
