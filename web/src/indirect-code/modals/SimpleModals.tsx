import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Badge, Btn, Modal, copyToClipboard, toast } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useModal } from "../ctx";
import { indirectInstallCommands } from "../install";
import type { ChoiceOption } from "../viewTypes";

export { NewProjectModal } from "./NewProjectModal";

function defaultPlatform(): "unix" | "windows" {
  try {
    return /win/i.test(navigator.userAgent || "") ? "windows" : "unix";
  } catch {
    return "unix";
  }
}

function isDestructiveChoice(opt: ChoiceOption): boolean {
  return Boolean((opt as { danger?: boolean }).danger) || /\bdiscard\b|\bdelete\b|\bremove\b/i.test(opt.label);
}

function isRecommendedChoice(opt: ChoiceOption): boolean {
  return Boolean((opt as { recommended?: boolean }).recommended) && !isDestructiveChoice(opt);
}

export function ChoiceModal() {
  const m = useModal();
  const state = () => m.choiceState();

  createEffect(() => {
    const st = state();
    if (!st || typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const num = Number(e.key);
      if (!Number.isInteger(num) || num < 1 || num > st.options.length) return;
      const picked = st.options[num - 1];
      if (!picked) return;
      e.preventDefault();
      e.stopPropagation();
      st.resolve(picked.id);
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  return (
    <Modal
      open={!!state()}
      title={state()?.title || "Choose option"}
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
            {(opt, idx) => {
              const destructive = () => isDestructiveChoice(opt);
              const recommended = () => isRecommendedChoice(opt);
              const accentCard = () => Boolean(opt.primary && !destructive());
              return (
                <button
                  type="button"
                  ref={press}
                  onClick={() => state()?.resolve(opt.id)}
                  class={`flex items-center justify-between gap-3 rounded-panel border px-3.5 py-2.5 text-left transition-colors cursor-pointer group ${
                    accentCard()
                      ? "border-accent bg-accent-subtle/40 hover:bg-accent-subtle"
                      : destructive()
                        ? "border-border bg-surface hover:border-danger/45 hover:bg-danger-subtle/40"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle"
                  }`}
                >
                  <div class="flex items-start gap-3 min-w-0 flex-1">
                    <span
                      class={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-2xs font-medium tabular-nums ${
                        accentCard()
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
                            accentCard()
                              ? "text-fg"
                              : destructive()
                                ? "text-fg group-hover:text-danger"
                                : "text-fg-secondary group-hover:text-fg"
                          }`}
                        >
                          {opt.label}
                        </span>
                        <Show when={recommended()}>
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
                      accentCard()
                        ? "text-accent"
                        : destructive()
                          ? "text-fg-muted group-hover:text-danger"
                          : "text-fg-muted group-hover:text-fg"
                    }`}
                  />
                </button>
              );
            }}
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
      width="max-w-md"
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
      <p class="text-xs sm:text-sm text-fg-secondary whitespace-pre-line leading-relaxed">
        {state()?.message}
      </p>
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
      subtitle="Run a one-time command on your workstation or server to connect it."
      width="max-w-xl"
      onClose={() => m.setShowPairModal(false)}
      footer={
        <div class="flex w-full items-center justify-between gap-3 flex-wrap">
          <Show when={m.pairingData()}>
            <div class="flex items-center gap-2 text-xs text-fg-secondary min-w-0">
              <span class="ui-spinner w-3.5 h-3.5 text-accent shrink-0" aria-hidden="true" />
              <span class="truncate">Waiting for host…</span>
            </div>
          </Show>
          <div class="flex items-center gap-2 ml-auto">
            <Show when={m.pairingData()}>
              <Btn
                variant="outline"
                size="sm"
                loading={m.pairingLoading()}
                disabled={m.pairingLoading()}
                onClick={() => void m.generatePairingToken()}
              >
                Regenerate token
              </Btn>
            </Show>
            <Btn size="sm" onClick={() => m.setShowPairModal(false)}>
              Done
            </Btn>
          </div>
        </div>
      }
    >
      <div class="space-y-4 text-xs">
        <Show
          when={m.pairingData()}
          fallback={
            <div class="flex flex-col items-center justify-center gap-3 rounded-panel border border-border bg-surface-subtle/50 px-4 py-8 text-center">
              <Show
                when={m.pairingLoading()}
                fallback={
                  <>
                    <Iconify icon="lucide:terminal" size={20} class="text-fg-muted" />
                    <p class="text-xs text-fg-secondary">
                      Generate a one-time command to connect a new host.
                    </p>
                    <Btn size="sm" onClick={() => void m.generatePairingToken()}>
                      Generate pairing command
                    </Btn>
                  </>
                }
              >
                <span class="ui-spinner w-4 h-4 text-accent" aria-hidden="true" />
                <p class="text-xs text-fg-secondary">Generating pairing command…</p>
              </Show>
            </div>
          }
        >
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
                  <Badge tone="success">Valid ~15m</Badge>
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
                        ref={press}
                        onClick={() => setOsTab("unix")}
                        class={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-2xs font-medium transition-colors cursor-pointer ${
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
                        ref={press}
                        onClick={() => setOsTab("windows")}
                        class={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-2xs font-medium transition-colors cursor-pointer ${
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
                      ref={press}
                      onClick={() => copyCmd(osTab(), activeCmd())}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer ml-auto"
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
                        title: "Host connects",
                        desc: "Installs Indirect Code, claims the token, and starts automatically.",
                      },
                      {
                        step: "03",
                        title: "Local workspace",
                        desc: "Files, git state, and conversations remain on that machine.",
                      },
                    ]}
                  >
                    {(item, idx) => (
                      <div class={idx() > 0 ? "sm:pl-3.5 space-y-0.5 pr-2" : "space-y-0.5 pr-2"}>
                        <div class="flex items-center gap-1.5">
                          <span class="font-mono text-[10px] font-medium text-accent tabular-nums">
                            {item.step}
                          </span>
                          <span class="text-[11px] font-medium text-fg">{item.title}</span>
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
