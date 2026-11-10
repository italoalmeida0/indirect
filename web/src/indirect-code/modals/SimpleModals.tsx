import { createSignal, For, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Badge, Btn, Modal, ModalNotice, copyWithToast } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useModal } from "../ctx";
import { indirectInstallCommands } from "../install";

export { NewProjectModal } from "./NewProjectModal";

function defaultPlatform(): "unix" | "windows" {
  try {
    return /win/i.test(navigator.userAgent || "") ? "windows" : "unix";
  } catch {
    return "unix";
  }
}

export function ChoiceModal() {
  const m = useModal();
  const state = () => m.choiceState();

  return (
    <Modal
      open={!!state()}
      title={state()?.title || "Choose Option"}
      subtitle="Select one of the choices below to continue with this action."
      onClose={() => state()?.resolve(null)}
      footer={
        <Btn
          variant="outline"
          size="sm"
          onClick={() => state()?.resolve(null)}
        >
          Cancel
        </Btn>
      }
    >
      <div class="space-y-4">
        <Show when={state()?.message}>
          <div class="rc-studio-well px-3.5 py-2.5 text-xs sm:text-sm text-fg-secondary whitespace-pre-line leading-relaxed">
            {state()?.message}
          </div>
        </Show>
        <div class="flex flex-col gap-2.5">
          <For each={state()?.options || []}>
            {(opt, idx) => (
              <button
                type="button"
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => state()?.resolve(opt.id)}
                class={`flex items-center justify-between gap-3 rounded-panel border p-3.5 text-left transition-all cursor-pointer group ${
                  opt.primary
                    ? "border-accent bg-accent-subtle hover:bg-accent/15 shadow-resting"
                    : "border-border bg-surface-subtle hover:bg-surface-muted hover:border-border-strong"
                }`}
              >
                <div class="flex items-start gap-3 min-w-0 flex-1">
                  <span
                    class={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-medium ${
                      opt.primary
                        ? "bg-accent text-accent-foreground"
                        : "border border-border bg-surface text-fg-muted group-hover:text-fg"
                    }`}
                  >
                    {idx() + 1}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span
                        class={`text-xs sm:text-sm font-medium ${
                          opt.primary ? "text-fg" : "text-fg-secondary group-hover:text-fg"
                        }`}
                      >
                        {opt.label}
                      </span>
                      <Show when={opt.primary}>
                        <span class="bg-accent text-accent-foreground text-[10px] font-medium px-2 py-0.5 rounded-full">
                          Recommended
                        </span>
                      </Show>
                    </div>
                    <Show when={opt.hint}>
                      <p class="text-xs text-fg-muted mt-1 leading-relaxed">
                        {opt.hint}
                      </p>
                    </Show>
                  </div>
                </div>
                <div
                  class={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-transform group-hover:translate-x-0.5 ${
                    opt.primary
                      ? "border-accent/35 bg-surface text-accent"
                      : "border-border bg-surface text-fg-muted group-hover:text-fg"
                  }`}
                >
                  <Iconify icon="lucide:arrow-right" size={14} />
                </div>
              </button>
            )}
          </For>
        </div>
      </div>
    </Modal>
  );
}

export function ConfirmModal() {
  const m = useModal();
  const state = () => m.confirmState();

  return (
    <Modal
      open={!!state()}
      title={state()?.title || "Confirm action"}
      subtitle={
        state()?.danger
          ? "Review the permanent host operation below before confirming."
          : "Review the details below before continuing."
      }
      onClose={() => {
        state()?.resolve(false);
        m.setConfirmState(null);
      }}
      footer={
        <>
          <Btn
            variant="outline"
            size="sm"
            onClick={() => {
              state()?.resolve(false);
              m.setConfirmState(null);
            }}
          >
            {state()?.cancelText || "Cancel"}
          </Btn>
          <Btn
            variant={state()?.danger ? "danger" : "primary"}
            size="sm"
            onClick={() => {
              state()?.resolve(true);
              m.setConfirmState(null);
            }}
          >
            {state()?.confirmText || "Confirm"}
          </Btn>
        </>
      }
    >
      <div class="space-y-4">
        <ModalNotice
          tone={state()?.danger ? "danger" : "info"}
          title={state()?.danger ? "Destructive Action" : "Confirmation"}
        >
          <span class="whitespace-pre-line leading-relaxed">{state()?.message}</span>
        </ModalNotice>
      </div>
    </Modal>
  );
}

export function PairModal() {
  const m = useModal();
  const [osTab, setOsTab] = createSignal<"unix" | "windows">(defaultPlatform());
  const [copiedKey, setCopiedKey] = createSignal<"unix" | "windows" | null>(null);

  const copyCmd = (kind: "unix" | "windows", cmd: string) => {
    setOsTab(kind);
    void copyWithToast(cmd);
    setCopiedKey(kind);
    setTimeout(() => setCopiedKey((prev) => (prev === kind ? null : prev)), 1600);
  };

  return (
    <Modal
      open={m.showPairModal()}
      title="Pair Indirect Code Host"
      subtitle="Run a one-time terminal command on your target machine to connect its daemon with your account."
      width="max-w-xl"
      onClose={() => m.setShowPairModal(false)}
      footer={
        <Btn size="sm" onClick={() => m.setShowPairModal(false)}>
          Done
        </Btn>
      }
    >
      <div class="space-y-4 text-xs">
        <Show when={m.pairingData()}>
          {(p) => {
            const cmds = () => indirectInstallCommands(p().connectUrl);
            const activeCmd = () => (osTab() === "windows" ? cmds().windows : cmds().unix);
            return (
              <div class="space-y-4">
                {/* Live Pairing Token Telemetry Banner */}
                <div class="rc-studio-well flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="h-2 w-2 shrink-0 rounded-full bg-success animate-pulse" />
                    <span class="font-medium text-fg">One-time pairing token active</span>
                  </div>
                  <Badge tone="green">Valid ~15m</Badge>
                </div>

                {/* Bespoke OS Selector & One-Click Copy Tiles */}
                <div class="space-y-2.5">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs font-medium text-fg">1. Choose target OS & copy command</span>
                    <span class="text-[11px] text-fg-muted">Click to copy & preview</span>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => copyCmd("unix", cmds().unix)}
                      class={`flex items-center justify-between gap-3 p-3.5 rounded-panel border transition-all cursor-pointer group text-left ${
                        osTab() === "unix"
                          ? "border-accent bg-accent-subtle shadow-resting"
                          : "border-border bg-surface-subtle hover:border-border-strong hover:bg-surface-muted"
                      }`}
                    >
                      <div class="min-w-0">
                        <div class="text-xs font-medium text-fg flex items-center gap-1.5">
                          <Iconify icon="lucide:terminal" size={13} class={osTab() === "unix" ? "text-accent" : "text-fg-muted"} />
                          <span>Linux & macOS</span>
                        </div>
                        <div class="text-[11px] text-fg-muted mt-0.5 font-mono truncate">
                          curl -fsSL … | bash
                        </div>
                      </div>
                      <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-fg-secondary group-hover:text-accent transition-colors">
                        <Iconify icon={copiedKey() === "unix" ? "lucide:check" : "lucide:copy"} size={13} class={copiedKey() === "unix" ? "text-success" : ""} />
                      </div>
                    </button>

                    <button
                      type="button"
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => copyCmd("windows", cmds().windows)}
                      class={`flex items-center justify-between gap-3 p-3.5 rounded-panel border transition-all cursor-pointer group text-left ${
                        osTab() === "windows"
                          ? "border-accent bg-accent-subtle shadow-resting"
                          : "border-border bg-surface-subtle hover:border-border-strong hover:bg-surface-muted"
                      }`}
                    >
                      <div class="min-w-0">
                        <div class="text-xs font-medium text-fg flex items-center gap-1.5">
                          <Iconify icon="lucide:app-window" size={13} class={osTab() === "windows" ? "text-accent" : "text-fg-muted"} />
                          <span>Windows PowerShell</span>
                        </div>
                        <div class="text-[11px] text-fg-muted mt-0.5 font-mono truncate">
                          irm … | iex
                        </div>
                      </div>
                      <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-fg-secondary group-hover:text-accent transition-colors">
                        <Iconify icon={copiedKey() === "windows" ? "lucide:check" : "lucide:copy"} size={13} class={copiedKey() === "windows" ? "text-success" : ""} />
                      </div>
                    </button>
                  </div>

                  {/* Live Terminal Command Inspector */}
                  <div class="rc-studio-card overflow-hidden">
                    <div class="flex items-center justify-between gap-2 border-b border-border bg-surface-muted/60 px-3 py-1.5">
                      <span class="font-mono text-[11px] font-medium text-fg-secondary">
                        {osTab() === "windows" ? "PowerShell" : "POSIX Shell"}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyCmd(osTab(), activeCmd())}
                        class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent-subtle transition-colors cursor-pointer"
                      >
                        <Iconify icon={copiedKey() === osTab() ? "lucide:check" : "lucide:copy"} size={11} />
                        <span>{copiedKey() === osTab() ? "Copied" : "Copy command"}</span>
                      </button>
                    </div>
                    <div class="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-fg select-all">
                      <span class="mr-2 text-accent select-none">{osTab() === "windows" ? "PS>" : "$"}</span>
                      <span class="break-all">{activeCmd()}</span>
                    </div>
                  </div>
                </div>

                {/* 3-Step Pairing Pipeline */}
                <div class="rc-studio-card p-3.5 space-y-2.5">
                  <div class="text-xs font-medium text-fg flex items-center gap-2">
                    <Iconify icon="lucide:layers" size={14} class="text-accent" />
                    <span>How pairing works</span>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <For
                      each={[
                        { step: "01", title: "Paste in terminal", desc: "Run once on your laptop, server, or container." },
                        { step: "02", title: "Background daemon", desc: "Downloads, pairs via token, and registers service." },
                        { step: "03", title: "Instant relay", desc: "Files and sessions stay local on that machine." },
                      ]}
                    >
                      {(item) => (
                        <div class="rc-studio-well p-2.5 space-y-1">
                          <span class="font-mono text-[10px] font-medium text-accent">{item.step}</span>
                          <div class="text-[11px] font-medium text-fg">{item.title}</div>
                          <p class="text-[11px] text-fg-muted leading-snug">{item.desc}</p>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            );
          }}
        </Show>
      </div>
    </Modal>
  );
}
