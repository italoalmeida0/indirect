import { createSignal, For, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Badge, Btn, Modal, ModalNotice, copyToClipboard, toast } from "../../ui";
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
      title={state()?.title || "Choose option"}
      subtitle="Select one of the choices below to continue."
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
      <div class="space-y-3.5">
        <Show when={state()?.message}>
          <p class="text-xs sm:text-sm text-fg-secondary whitespace-pre-line leading-relaxed">
            {state()?.message}
          </p>
        </Show>
        <div class="flex flex-col gap-2">
          <For each={state()?.options || []}>
            {(opt, idx) => (
              <button
                type="button"
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => state()?.resolve(opt.id)}
                class={`flex min-h-11 items-center justify-between gap-3 rounded-panel border px-3.5 py-3 text-left transition-colors cursor-pointer group ${
                  opt.primary
                    ? "border-accent bg-accent-subtle/40 hover:bg-accent-subtle"
                    : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle"
                }`}
              >
                <div class="flex items-start gap-3 min-w-0 flex-1">
                  <span
                    class={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-2xs font-medium tabular-nums ${
                      opt.primary
                        ? "bg-accent text-accent-foreground"
                        : "border border-border bg-surface-subtle text-fg-muted group-hover:text-fg"
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
                        <Badge tone="accent">Recommended</Badge>
                      </Show>
                    </div>
                    <Show when={opt.hint}>
                      <p class="mt-0.5 text-xs text-fg-muted leading-relaxed">
                        {opt.hint}
                      </p>
                    </Show>
                  </div>
                </div>
                <Iconify
                  icon="lucide:arrow-right"
                  size={14}
                  class={`shrink-0 transition-transform group-hover:translate-x-0.5 ${
                    opt.primary ? "text-accent" : "text-fg-muted group-hover:text-fg"
                  }`}
                />
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
          title={state()?.danger ? "Destructive action" : "Confirmation"}
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
    void copyToClipboard(cmd).then((ok) => {
      if (ok) {
        setCopiedKey(kind);
        setTimeout(() => setCopiedKey((prev) => (prev === kind ? null : prev)), 1600);
      } else {
        toast("Could not copy automatically. Select the text and copy it manually", "err");
      }
    });
  };

  return (
    <Modal
      open={m.showPairModal()}
      title="Pair Indirect Code host"
      subtitle="Run a one-time bootstrap command on your workstation or server to pair its local daemon."
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
                {/* Live Pairing Token Status Line */}
                <div class="flex items-center justify-between gap-3 flex-wrap">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="h-2 w-2 shrink-0 rounded-full bg-success animate-pulse" />
                    <span class="font-medium text-fg">One-time pairing token active</span>
                  </div>
                  <Badge tone="green">Valid ~15m</Badge>
                </div>

                {/* Unified Workstation Terminal Command Block */}
                <div class="rounded-panel border border-border bg-surface overflow-hidden">
                  <div class="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-subtle px-2.5 py-2 flex-wrap">
                    <div
                      role="tablist"
                      aria-label="Target operating system"
                      class="inline-flex items-center gap-1"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={osTab() === "unix"}
                        onPointerDown={(e) => press(e.currentTarget)}
                        onClick={() => setOsTab("unix")}
                        class={`inline-flex min-h-7 [@media(pointer:coarse)]:min-h-10 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-2xs font-medium transition-colors cursor-pointer ${
                          osTab() === "unix"
                            ? "border-border bg-surface text-fg"
                            : "border-transparent text-fg-muted hover:text-fg"
                        }`}
                      >
                        <Iconify icon="lucide:terminal" size={12} />
                        <span>Linux & macOS</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={osTab() === "windows"}
                        onPointerDown={(e) => press(e.currentTarget)}
                        onClick={() => setOsTab("windows")}
                        class={`inline-flex min-h-7 [@media(pointer:coarse)]:min-h-10 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-2xs font-medium transition-colors cursor-pointer ${
                          osTab() === "windows"
                            ? "border-border bg-surface text-fg"
                            : "border-transparent text-fg-muted hover:text-fg"
                        }`}
                      >
                        <Iconify icon="lucide:app-window" size={12} />
                        <span>Windows</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => copyCmd(osTab(), activeCmd())}
                      class="ui-button ui-button-outline ui-button-xs rounded-lg gap-1.5 ml-auto"
                    >
                      <Iconify
                        icon={copiedKey() === osTab() ? "lucide:check" : "lucide:copy"}
                        size={12}
                        class={copiedKey() === osTab() ? "text-success" : "text-fg-secondary"}
                      />
                      <span>{copiedKey() === osTab() ? "Copied" : "Copy command"}</span>
                    </button>
                  </div>

                  <div class="overflow-x-auto bg-background/60 p-3.5 font-mono text-2xs leading-relaxed text-fg select-all">
                    <span class="mr-2 select-none text-accent">
                      {osTab() === "windows" ? "PS>" : "$"}
                    </span>
                    <span class="break-all">{activeCmd()}</span>
                  </div>
                </div>

                {/* Minimal 3-Step Hairline Rail */}
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-0 sm:divide-x divide-border-subtle border-t border-border-subtle pt-3.5">
                  <For
                    each={[
                      {
                        step: "01",
                        title: "Run in terminal",
                        desc: "Paste once on your laptop, remote VM, or container.",
                      },
                      {
                        step: "02",
                        title: "Daemon pairs",
                        desc: "Installs the binary, claims the token, and starts the service.",
                      },
                      {
                        step: "03",
                        title: "Local workspace",
                        desc: "Files, git state, and sessions remain on that machine.",
                      },
                    ]}
                  >
                    {(item, idx) => (
                      <div class={idx() > 0 ? "sm:pl-3.5 space-y-0.5 pr-2" : "space-y-0.5 pr-2"}>
                        <div class="flex items-center gap-1.5">
                          <span class="font-mono text-2xs font-medium text-accent tabular-nums">
                            {item.step}
                          </span>
                          <span class="text-xs font-medium text-fg">{item.title}</span>
                        </div>
                        <p class="text-2xs text-fg-muted leading-relaxed">{item.desc}</p>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            );
          }}
        </Show>
      </div>
    </Modal>
  );
}
