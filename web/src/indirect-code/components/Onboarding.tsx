import { createSignal, For, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Icon as Iconify } from "../../components/icon";
import { Badge, Btn, copyWithToast } from "../../ui";
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
    void copyWithToast(cmd);
    setCopiedKey(kind);
    setTimeout(() => setCopiedKey((prev) => (prev === kind ? null : prev)), 1600);
  };

  return (
    <div class="flex-1 min-h-0 flex flex-col items-center p-4 sm:p-6 bg-background text-center overflow-y-auto">
      <div class="max-w-xl w-full mx-auto space-y-6 my-auto py-8">
        {/* Title & Subtitle */}
        <div>
          <IndirectBrand />
          <p class="text-[13px] text-fg-secondary mt-5 max-w-md mx-auto leading-relaxed">
            Connect a machine to work with your coding agent from anywhere. Your projects and conversations stay local on that host.
          </p>
        </div>

        {/* Action: Connect / Pair */}
        <Show
          when={m.pairingData()}
          fallback={
            <div class="space-y-6 pt-2">
              <div>
                <Btn
                  onClick={() => m.generatePairingToken({ silent: true })}
                  disabled={m.pairingLoading()}
                  class="gap-2"
                >
                  <Show
                    when={!m.pairingLoading()}
                    fallback={<Iconify icon="lucide:refresh-cw" size={16} class="animate-spin" />}
                  >
                    <Iconify icon="lucide:plus" size={16} />
                  </Show>
                  <span>Connect a host</span>
                </Btn>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-left max-w-lg mx-auto">
                <For
                  each={[
                    { icon: "lucide:hard-drive", title: "Local ownership", desc: "Source files, git state, and sessions stay on your host." },
                    { icon: "lucide:terminal-square", title: "Zero-config binary", desc: "Single Go daemon with background runner supervision." },
                    { icon: "lucide:laptop", title: "Multi-device sync", desc: "Resume live turns seamlessly from desktop or mobile." },
                  ]}
                >
                  {(f) => (
                    <div class="rc-studio-card p-3 space-y-1.5">
                      <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-subtle text-accent">
                        <Iconify icon={f.icon} size={14} />
                      </div>
                      <div class="text-xs font-medium text-fg">{f.title}</div>
                      <p class="text-[11px] text-fg-muted leading-relaxed">{f.desc}</p>
                    </div>
                  )}
                </For>
              </div>
            </div>
          }
        >
          {/* Bespoke Pairing Terminal Studio Card */}
          {(() => {
            const cmds = () => indirectInstallCommands(m.pairingData()?.connectUrl || "");
            const activeCmd = () => (osTab() === "windows" ? cmds().windows : cmds().unix);
            return (
              <div class="rc-studio-card p-4 sm:p-5 text-left space-y-4">
                <div class="flex items-center justify-between gap-3 pb-3 border-b border-border">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-success animate-pulse" />
                    <span class="text-xs font-medium text-fg">Ready to connect</span>
                  </div>
                  <Badge tone="green">Valid for ~15m</Badge>
                </div>

                {/* Step 1: one-line install */}
                <div class="space-y-2.5">
                  <div class="text-xs font-medium text-fg">
                    1. Copy the command for your system and run it once in a terminal:
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => copyCmd("unix", cmds().unix)}
                      class={`flex items-center justify-between gap-2 p-3 rounded-panel border transition-all cursor-pointer group ${
                        osTab() === "unix"
                          ? "border-accent bg-accent-subtle shadow-resting"
                          : "border-border bg-surface hover:border-border-strong hover:bg-surface-muted"
                      }`}
                    >
                      <span class="flex items-center gap-2 text-xs font-medium text-fg">
                        <Iconify icon="lucide:terminal" size={14} class="text-accent" />
                        Linux & macOS
                      </span>
                      <Iconify
                        icon={copiedKey() === "unix" ? "lucide:check" : "lucide:copy"}
                        size={14}
                        class={copiedKey() === "unix" ? "text-success" : "text-fg-muted group-hover:text-accent"}
                      />
                    </button>
                    <button
                      type="button"
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => copyCmd("windows", cmds().windows)}
                      class={`flex items-center justify-between gap-2 p-3 rounded-panel border transition-all cursor-pointer group ${
                        osTab() === "windows"
                          ? "border-accent bg-accent-subtle shadow-resting"
                          : "border-border bg-surface hover:border-border-strong hover:bg-surface-muted"
                      }`}
                    >
                      <span class="flex items-center gap-2 text-xs font-medium text-fg">
                        <Iconify icon="lucide:app-window" size={14} class="text-accent" />
                        Windows
                      </span>
                      <Iconify
                        icon={copiedKey() === "windows" ? "lucide:check" : "lucide:copy"}
                        size={14}
                        class={copiedKey() === "windows" ? "text-success" : "text-fg-muted group-hover:text-accent"}
                      />
                    </button>
                  </div>

                  <div class="rc-studio-well overflow-hidden">
                    <div class="flex items-center justify-between gap-2 border-b border-border bg-surface/60 px-3 py-1.5">
                      <span class="font-mono text-[11px] font-medium text-fg-secondary">
                        {osTab() === "windows" ? "PowerShell" : "POSIX Shell"}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyCmd(osTab(), activeCmd())}
                        class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent-subtle transition-colors cursor-pointer"
                      >
                        <Iconify icon={copiedKey() === osTab() ? "lucide:check" : "lucide:copy"} size={11} />
                        <span>{copiedKey() === osTab() ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                    <div class="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-fg select-all">
                      <span class="mr-2 text-accent select-none">{osTab() === "windows" ? "PS>" : "$"}</span>
                      <span class="break-all">{activeCmd()}</span>
                    </div>
                  </div>

                  <p class="text-[11px] text-fg-muted leading-relaxed">
                    Installs Indirect Code, connects this host, and keeps it available in the background.
                  </p>
                </div>

                {/* Live Status */}
                <div class="p-3.5 rounded-panel bg-accent-subtle border border-accent/25 flex items-center gap-3">
                  <div class="w-8 h-8 rounded-lg bg-surface/80 flex items-center justify-center text-accent shrink-0 border border-accent/20">
                    <Iconify icon="lucide:refresh-cw" size={15} class="animate-spin" />
                  </div>
                  <div class="text-xs min-w-0">
                    <p class="font-medium text-fg">Waiting for your host…</p>
                    <p class="text-fg-secondary text-[11px] mt-0.5">
                      Run the command above in your terminal. This screen will connect automatically.
                    </p>
                  </div>
                </div>

                {/* Action Buttons */}
                <div class="flex items-center justify-end gap-2 pt-1 text-xs flex-wrap">
                  <button
                    type="button"
                    onClick={h.loadHosts}
                    class="px-3 py-1.5 rounded-control border border-border bg-surface text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer font-medium"
                  >
                    Check Connection
                  </button>
                  <button
                    type="button"
                    onClick={() => m.generatePairingToken({ silent: true })}
                    class="px-3 py-1.5 rounded-control border border-border bg-surface-muted hover:bg-surface-strong text-fg transition-colors cursor-pointer font-medium"
                  >
                    Regenerate Token
                  </button>
                </div>
              </div>
            );
          })()}
        </Show>
      </div>
    </div>
  );
}
