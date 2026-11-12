import { createSignal, For, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Icon as Iconify } from "../../components/icon";
import { Badge, Btn, copyToClipboard, toast } from "../../ui";
import { useHost, useModal } from "../ctx";
import { indirectInstallCommands } from "../install";
import { IndirectBrand } from "./IndirectBrand";

function defaultPlatform(): "unix" | "windows" {
  try {
    return /win/i.test(navigator.userAgent || "") ? "windows" : "unix";
  } catch {
    return "unix";
  }
}

export function Onboarding() {
  const h = useHost();
  const m = useModal();
  const [osTab, setOsTab] = createSignal<"unix" | "windows">(defaultPlatform());
  const [copiedKey, setCopiedKey] = createSignal<"unix" | "windows" | null>(null);
  m.setShowPairModal(false);

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
    <div class="flex-1 min-h-0 flex flex-col items-center p-4 sm:p-6 bg-background text-center overflow-y-auto">
      <div class="max-w-xl w-full mx-auto space-y-6 my-auto py-8">
        {/* Workstation Pairing Hero */}
        <div>
          <IndirectBrand />
          <p class="text-[13px] text-fg-secondary mt-5 max-w-md mx-auto leading-relaxed">
            Pair a workstation or server to run your coding agent from anywhere. Source files, git state, and sessions stay local on that machine.
          </p>
        </div>

        <Show
          when={m.pairingData()}
          fallback={
            <div class="space-y-7 pt-1">
              <div>
                <Btn
                  onClick={() => m.generatePairingToken({ silent: true })}
                  disabled={m.pairingLoading()}
                  class="gap-2"
                >
                  <Show
                    when={!m.pairingLoading()}
                    fallback={<Iconify icon="lucide:refresh-cw" size={15} class="animate-spin" />}
                  >
                    <Iconify icon="lucide:plus" size={15} />
                  </Show>
                  <span>Connect a host</span>
                </Btn>
              </div>

              {/* Minimal Hairline Architecture Rail */}
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-0 sm:divide-x divide-border border-t border-border pt-5 text-left max-w-lg mx-auto">
                <For
                  each={[
                    {
                      icon: "lucide:hard-drive",
                      title: "Local ownership",
                      desc: "Repositories, credentials, and transcripts stay on your machine.",
                    },
                    {
                      icon: "lucide:terminal-square",
                      title: "Single-binary daemon",
                      desc: "Supervised Go worker with durable background task runners.",
                    },
                    {
                      icon: "lucide:laptop",
                      title: "Multi-device relay",
                      desc: "Resume live turns cleanly across desktop and mobile.",
                    },
                  ]}
                >
                  {(f, idx) => (
                    <div class={idx() > 0 ? "sm:pl-4 pr-2 space-y-1" : "pr-2 space-y-1"}>
                      <div class="flex items-center gap-1.5 text-xs font-medium text-fg">
                        <Iconify icon={f.icon} size={13} class="shrink-0 text-fg-muted" />
                        <span>{f.title}</span>
                      </div>
                      <p class="text-[11px] text-fg-muted leading-relaxed">{f.desc}</p>
                    </div>
                  )}
                </For>
              </div>
            </div>
          }
        >
          {(() => {
            const cmds = () => indirectInstallCommands(m.pairingData()?.connectUrl || "");
            const activeCmd = () => (osTab() === "windows" ? cmds().windows : cmds().unix);
            return (
              <div class="rounded-panel border border-border bg-surface p-4 sm:p-5 text-left space-y-4">
                {/* Token Header */}
                <div class="flex items-center justify-between gap-3 pb-3 border-b border-border flex-wrap">
                  <div class="flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full bg-success animate-pulse" />
                    <span class="text-xs font-medium text-fg">Ready to pair workstation</span>
                  </div>
                  <Badge tone="green">Valid ~15m</Badge>
                </div>

                {/* Unified Terminal Command Block */}
                <div class="rounded-control border border-border bg-background/60 overflow-hidden">
                  <div class="flex items-center justify-between gap-2 border-b border-border bg-surface-subtle px-2.5 py-1.5 flex-wrap">
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
                        class={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
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
                        class={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
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
                      class="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                    >
                      <Iconify
                        icon={copiedKey() === osTab() ? "lucide:check" : "lucide:copy"}
                        size={12}
                        class={copiedKey() === osTab() ? "text-success" : "text-fg-secondary"}
                      />
                      <span>{copiedKey() === osTab() ? "Copied" : "Copy command"}</span>
                    </button>
                  </div>

                  <div class="overflow-x-auto p-3.5 font-mono text-[11px] leading-relaxed text-fg select-all">
                    <span class="mr-2 select-none text-accent">
                      {osTab() === "windows" ? "PS>" : "$"}
                    </span>
                    <span class="break-all">{activeCmd()}</span>
                  </div>
                </div>

                {/* Minimal 3-Step Rail */}
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-0 sm:divide-x divide-border border-y border-border py-3.5">
                  <For
                    each={[
                      {
                        step: "01",
                        title: "Paste in terminal",
                        desc: "Run once on the machine you want to pair.",
                      },
                      {
                        step: "02",
                        title: "Daemon registers",
                        desc: "Installs Indirect Code and pairs via this token.",
                      },
                      {
                        step: "03",
                        title: "Auto-connects",
                        desc: "This workspace opens as soon as the host checks in.",
                      },
                    ]}
                  >
                    {(item, idx) => (
                      <div class={idx() > 0 ? "sm:pl-3.5 pr-2 space-y-0.5" : "pr-2 space-y-0.5"}>
                        <div class="flex items-center gap-1.5">
                          <span class="font-mono text-[10px] font-medium text-accent">
                            {item.step}
                          </span>
                          <span class="text-[11px] font-medium text-fg">{item.title}</span>
                        </div>
                        <p class="text-[11px] text-fg-muted leading-relaxed">{item.desc}</p>
                      </div>
                    )}
                  </For>
                </div>

                {/* Live Listening Status + Actions */}
                <div class="flex items-center justify-between gap-3 flex-wrap text-xs">
                  <div class="flex items-center gap-2 text-fg-secondary min-w-0">
                    <Iconify icon="lucide:refresh-cw" size={13} class="shrink-0 animate-spin text-accent" />
                    <span class="truncate">Waiting for your host…</span>
                  </div>

                  <div class="flex items-center gap-2 ml-auto flex-wrap">
                    <button
                      type="button"
                      onClick={h.loadHosts}
                      class="rounded-control border border-border bg-surface px-3 py-1.5 font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                    >
                      Check Connection
                    </button>
                    <button
                      type="button"
                      onClick={() => m.generatePairingToken({ silent: true })}
                      class="rounded-control border border-border bg-surface-subtle px-3 py-1.5 font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                    >
                      Regenerate Token
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        </Show>
      </div>
    </div>
  );
}
