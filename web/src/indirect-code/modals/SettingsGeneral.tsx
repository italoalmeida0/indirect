import { Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Badge, Segmented, setThemeMode, themeMode } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal, useUI } from "../ctx";
import { pushSupported } from "../hooks/usePushSubscription";

function Toggle(props: {
  on: () => boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={props.onToggle}
      class="ui-switch-track shrink-0 cursor-pointer"
      role="switch"
      aria-checked={props.on()}
      aria-label={props.label}
    >
      <span class="ui-switch-thumb" />
    </button>
  );
}

export function SettingsGeneralSection() {
  const m = useModal();
  const ui = useUI();
  const hosts = useHost();
  const hostStatus = () => hosts.activeHost?.()?.status;
  const du = ui.daemonUpdate;
  const compactPct = () => m.daemonSettings().autoCompactPercent ?? 80;

  return (
    <div class="space-y-4">
      {/* 1. Appearance & Layout Studio */}
      <section id="rc-set-appearance" class="rc-studio-card p-4 space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-2.5">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent">
              <Iconify icon="lucide:palette" size={15} />
            </div>
            <div>
              <h3 class="text-sm font-medium text-fg">Appearance</h3>
              <p class="text-[11px] text-fg-muted">
                Color mode, reading column proportions, and stream verbosity.
              </p>
            </div>
          </div>
        </div>

        <div class="space-y-3.5 text-xs">
          <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <span class="font-medium text-fg">Theme</span>
              <span class="text-[11px] text-fg-muted">Light, dark, high-contrast, or system</span>
            </div>
            <Segmented
              value={themeMode()}
              onChange={setThemeMode}
              class="grid grid-cols-4"
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "high-contrast", label: "Contrast" },
                { value: "system", label: "System" },
              ]}
            />
          </div>

          <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <span class="font-medium text-fg">Conversation Width</span>
              <span class="font-mono text-[11px] text-fg-muted">
                {ui.convWidth() === "narrow"
                  ? "576px (Focused)"
                  : ui.convWidth() === "wide"
                    ? "1024px (Studio)"
                    : "768px (Balanced)"}
              </span>
            </div>
            <Segmented
              value={ui.convWidth()}
              onChange={(v) => {
                ui.setConvWidth(v);
                try { localStorage.setItem("llmgw-rc-width", v); } catch {}
              }}
              class="grid grid-cols-3"
              options={[
                { value: "narrow", label: "Narrow" },
                { value: "default", label: "Default" },
                { value: "wide", label: "Wide" },
              ]}
            />
            {/* Bespoke Column Geometry Miniature Preview */}
            <div class="rc-studio-well mt-2 px-3 py-2" aria-hidden="true">
              <div class="mx-auto flex flex-col gap-1 rounded-md border border-border/80 bg-surface px-2.5 py-1.5 transition-all duration-200"
                style={{
                  width: ui.convWidth() === "narrow" ? "52%" : ui.convWidth() === "wide" ? "94%" : "72%",
                }}
              >
                <div class="ml-auto h-1.5 w-2/5 rounded-full bg-surface-strong" />
                <div class="h-1.5 w-4/5 rounded-full bg-accent/45" />
                <div class="h-1.5 w-3/5 rounded-full bg-surface-muted" />
              </div>
            </div>
          </div>

          <div class="rc-studio-well divide-y divide-border overflow-hidden">
            <div class="flex items-center justify-between gap-4 p-3">
              <div class="min-w-0">
                <div class="font-medium text-fg">Verbose Agent Chat</div>
                <div class="mt-0.5 text-[11px] text-fg-muted">
                  Display intermediate thinking steps and tool trace segments.
                </div>
              </div>
              <button
                type="button"
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => {
                  const v = !ui.verboseChat();
                  ui.setVerboseChat(v);
                  try { localStorage.setItem("llmgw-rc-verbose", v ? "1" : "0"); } catch {}
                }}
                class="ui-switch-track shrink-0 cursor-pointer"
                role="switch"
                aria-checked={ui.verboseChat()}
                aria-label="Verbose agent chat"
              >
                <span class="ui-switch-thumb" />
              </button>
            </div>
            <Show when={ui.verboseChat()}>
              <div class="flex items-center justify-between gap-4 bg-surface/40 p-3 pl-5">
                <div class="min-w-0 border-l-2 border-accent/40 pl-3">
                  <div class="font-medium text-fg">Hide Tool Call Messages</div>
                  <div class="mt-0.5 text-[11px] text-fg-muted leading-relaxed">
                    Group short intermediate commentary into tool trace blocks. Messages with 50+ tokens always stay visible.
                  </div>
                </div>
                <button
                  type="button"
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => {
                    const v = !ui.hideToolMessages();
                    ui.setHideToolMessages(v);
                    try { localStorage.setItem("llmgw-rc-hide-tool-messages", v ? "1" : "0"); } catch {}
                  }}
                  class="ui-switch-track shrink-0 cursor-pointer"
                  role="switch"
                  aria-checked={ui.hideToolMessages()}
                  aria-label="Hide tool call messages"
                >
                  <span class="ui-switch-thumb" />
                </button>
              </div>
            </Show>
          </div>
        </div>
      </section>

      {/* 2. Turn Notifications & Push Telemetry */}
      <section id="rc-set-notifications" class="rc-studio-card p-4 space-y-3.5">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-2.5">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent">
              <Iconify icon="lucide:bell" size={15} />
            </div>
            <div>
              <h3 class="text-sm font-medium text-fg">Turn notifications</h3>
              <p class="text-[11px] text-fg-muted">
                Background alerts across hosts and closed browser tabs.
              </p>
            </div>
          </div>
          <Show when={ui.pushSub.supported()}>
            <Badge
              tone={
                ui.pushSub.state() === "active"
                  ? "green"
                  : ui.pushSub.state() === "blocked" || ui.pushSub.state() === "error"
                    ? "red"
                    : "zinc"
              }
            >
              {ui.pushSub.state() === "active"
                ? "Push active"
                : ui.pushSub.state() === "blocked"
                  ? "Push blocked"
                  : ui.pushSub.state() === "error"
                    ? "Push error"
                    : "Push standby"}
            </Badge>
          </Show>
        </div>

        <div class="space-y-3 text-xs">
          <div class="rc-studio-well divide-y divide-border overflow-hidden">
            <div class="flex items-center justify-between gap-4 p-3">
              <div class="min-w-0">
                <div class="font-medium text-fg">Notify when a turn finishes</div>
                <div class="mt-0.5 text-[11px] text-fg-muted leading-relaxed">
                  Browser notification for turns on any host or conversation — even ones you are not watching.
                  <Show when={pushSupported()}>
                    <span> With this on and permission granted, closed tabs still notify via push.</span>
                  </Show>
                </div>
              </div>
              <Toggle
                on={() => ui.turnNotify.notifyOn()}
                label="Notify when a turn finishes"
                onToggle={() => {
                  const v = !ui.turnNotify.notifyOn();
                  ui.turnNotify.setEnabled(v);
                  void ui.pushSub.sync();
                }}
              />
            </div>
            <Show when={ui.turnNotify.notifyOn()}>
              <div class="flex items-center justify-between gap-4 bg-surface/40 p-3 pl-5">
                <div class="min-w-0 border-l-2 border-accent/40 pl-3">
                  <div class="font-medium text-fg">Play a sound</div>
                  <div class="mt-0.5 text-[11px] text-fg-muted">
                    Short chime with the notification (only while a tab is open).
                  </div>
                </div>
                <Toggle
                  on={() => ui.turnNotify.soundOn()}
                  label="Play a sound"
                  onToggle={() => ui.turnNotify.setSound(!ui.turnNotify.soundOn())}
                />
              </div>
            </Show>
          </div>

          <Show when={ui.turnNotify.notifyOn() && ui.turnNotify.permission() === "denied"}>
            <p class="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[11px] text-danger">
              Browser notifications are blocked for this site — allow them in the browser site settings, then use Test below.
            </p>
          </Show>

          <div class="flex items-center justify-between gap-3 flex-wrap pt-0.5">
            <button
              type="button"
              onClick={() => ui.turnNotify.testNotify()}
              class="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:bell-ring" size={13} class="text-accent" />
              <span>Test notification</span>
            </button>
            <Show when={ui.pushSub.supported()}>
              <span class="text-[11px] text-fg-muted">
                {ui.pushSub.state() === "active"
                  ? "Push active on this device — closed tabs still notify."
                  : ui.pushSub.state() === "blocked"
                    ? "Push blocked — allow notifications in site settings."
                    : ui.pushSub.state() === "off"
                      ? "Push off — turn notifications on to enable."
                      : ui.pushSub.state() === "error"
                        ? "Push setup failed — retry with Test below."
                        : "Checking push status…"}
              </span>
            </Show>
          </div>
        </div>
      </section>

      {/* 3. Daemon Release & Update Slot Studio */}
      <section id="rc-set-updates" class="rc-studio-card p-4 space-y-3.5">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-2.5">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent">
              <Iconify icon="lucide:arrow-down-to-line" size={15} />
            </div>
            <div>
              <h3 class="text-sm font-medium text-fg">Updates</h3>
              <p class="text-[11px] text-fg-muted">
                Daemon slot binary version and update checks.
              </p>
            </div>
          </div>
          <Show when={du.info()?.current}>
            <span class="rounded-full border border-border bg-surface px-2.5 py-0.5 font-mono text-[11px] text-fg-secondary">
              {du.info()?.current}
            </span>
          </Show>
        </div>

        <div class="space-y-3 text-xs">
          <label for="settings-auto-update" class="rc-studio-well flex items-center justify-between gap-4 p-3 cursor-pointer select-none">
            <span class="min-w-0">
              <span class="text-fg font-medium block">Auto-update daemon</span>
              <span class="block text-[11px] text-fg-muted font-normal mt-0.5 leading-relaxed">
                Preference saved for when automatic updates become available. For now, check on start, reconnect and every 10 minutes; use Update now to apply.
              </span>
            </span>
            <span class="relative inline-flex items-center shrink-0">
              <input
                id="settings-auto-update"
                type="checkbox"
                checked={du.info()?.autoUpdate ?? true}
                onChange={(e) => du.toggle(e.currentTarget.checked)}
                class="sr-only peer"
              />
              <span
                class="ui-switch-track shrink-0 cursor-pointer"
                aria-checked={du.info()?.autoUpdate ?? true}
              >
                <span class="ui-switch-thumb" />
              </span>
            </span>
          </label>

          <div class="rc-studio-well flex items-center justify-between gap-3 flex-wrap px-3 py-2.5">
            <div class="flex items-center gap-2 min-w-0 text-fg-secondary">
              <Iconify icon="lucide:package-check" size={14} class="shrink-0 text-accent" />
              <span class="min-w-0 leading-relaxed">
                {(() => {
                  const i = du.info();
                  if (!i?.current) return "Version unknown (daemon never reported).";
                  if (i.current === "dev") return "Running dev build (self-update disabled).";
                  let s = `Running ${i.current}`;
                  if (i.available && i.available !== i.current) s += ` — ${i.available} available`;
                  else if (i.checkedAt) s += " — up to date";
                  if (hostStatus() === "updating") s += " (updating)";
                  else if ((i as any).mismatchWant) {
                    const left = Math.max(0, 1 - Math.floor((Date.now() - ((i as any).mismatchAt || 0)) / 60000));
                    s += ` (mirror stale: wanted ${(i as any).mismatchWant}, got ${(i as any).mismatchGot || "?"}${left > 0 ? ` — retry in ~${left}min` : ""})`;
                  }
                  return s + ".";
                })()}
              </span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                onClick={() => du.checkNow()}
              >
                Check now
              </button>
              <Show when={(() => { const i = du.info(); return !!i && !!i.available && i.available !== i.current && hostStatus() !== "updating"; })()}>
                <button
                  type="button"
                  class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground hover:bg-accent-strong transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={du.applying()}
                  onClick={() => { du.apply(); m.cancelSettings(); }}
                >
                  {du.applying() ? "Updating…" : "Update now"}
                </button>
              </Show>
            </div>
          </div>

          <Show when={(() => { const i = du.info(); return !!i && (i.lifecycle === "failed" || i.lifecycle === "done"); })()}>
            <p class="text-[11px] text-fg-muted">
              {(() => {
                const i = du.info();
                if (i?.lifecycle === "failed") return `Last update ${i.target || ""} failed: ${i.failedReason || i.error || "unknown error"}.`;
                return `Last update finished: now running ${i?.current || ""}.`;
              })()}
            </p>
          </Show>
          <Show when={du.info()?.error}>
            <p class="text-[11px] text-danger">{du.info()?.error}</p>
          </Show>
        </div>
      </section>

      {/* 4. Runtime, Context Compaction & Security Studio */}
      <section id="rc-set-runtime" class="rc-studio-card p-4 space-y-4">
        <div class="flex items-center gap-2.5">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent">
            <Iconify icon="lucide:sliders-horizontal" size={15} />
          </div>
          <div>
            <h3 class="text-sm font-medium text-fg">Advanced</h3>
            <p class="text-[11px] text-fg-muted">
              Context compaction budget, approval sandbox, proxy routing, and auto-titling.
            </p>
          </div>
        </div>

        <div class="space-y-4 text-xs">
          <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <label class="font-medium text-fg">Auto-compact threshold</label>
              <span class="font-mono text-[11px] text-accent">
                {compactPct() === 0 ? "Manual only" : `Compacts at ${compactPct()}%`}
              </span>
            </div>
            <Segmented
              value={String(compactPct())}
              onChange={(v) =>
                m.setDaemonSettings({ ...m.daemonSettings(), autoCompactPercent: Number(v) })
              }
              class="grid grid-cols-6"
              options={[0, 70, 80, 85, 90, 95].map((v) => ({
                value: String(v),
                label: v === 0 ? "Off" : `${v}%`,
              }))}
            />
            {/* Bespoke Context Compaction Trigger Zone Meter */}
            <div class="rc-studio-well mt-2 p-2.5 space-y-1.5" aria-hidden="true">
              <div class="flex items-center justify-between text-[10px] font-mono">
                <span class="text-fg-secondary">
                  {compactPct() === 0
                    ? "Auto-compaction disabled · manual compact only"
                    : `Active conversation buffer: 0% → ${compactPct()}%`}
                </span>
                <span class="text-accent">
                  {compactPct() === 0
                    ? "100% raw"
                    : `${100 - compactPct()}% headroom reserve`}
                </span>
              </div>
              <div class="h-2 rounded-full bg-surface-muted overflow-hidden flex">
                <div
                  class="h-full bg-accent transition-all duration-200"
                  style={{ width: `${compactPct() === 0 ? 100 : compactPct()}%` }}
                />
                <div class="h-full bg-warning/55 flex-1 transition-all duration-200" />
              </div>
            </div>
            <p class="text-[11px] text-fg-muted mt-1.5">
              Compact the transcript automatically past this context usage.
            </p>
          </div>

          <div class="rc-studio-well divide-y divide-border overflow-hidden">
            <div class="flex items-center justify-between gap-4 p-3">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 font-medium text-fg">
                  <Iconify icon="lucide:shield" size={13} class="text-accent" />
                  <span>Jail new conversations</span>
                </div>
                <div class="mt-0.5 text-[11px] text-fg-muted">
                  Start every session jailed: file writes and shell commands need approval first.
                </div>
              </div>
              <Toggle
                on={() => m.daemonSettings().jailByDefault ?? false}
                onToggle={() =>
                  m.setDaemonSettings({ ...m.daemonSettings(), jailByDefault: !(m.daemonSettings().jailByDefault ?? false) })
                }
                label="Jail new conversations"
              />
            </div>

            <div class="flex items-center justify-between gap-4 p-3">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 font-medium text-fg">
                  <Iconify icon="lucide:lock-open" size={13} class={m.daemonSettings().insecureTls ? "text-warning" : "text-fg-muted"} />
                  <span>Skip TLS verification</span>
                  <Show when={m.daemonSettings().insecureTls}>
                    <Badge tone="amber">Insecure</Badge>
                  </Show>
                </div>
                <div class="mt-0.5 text-[11px] text-fg-muted">
                  Provider requests accept self-signed certificates. Only the provider client is affected.
                </div>
              </div>
              <Toggle
                on={() => m.daemonSettings().insecureTls ?? false}
                onToggle={() =>
                  m.setDaemonSettings({ ...m.daemonSettings(), insecureTls: !(m.daemonSettings().insecureTls ?? false) })
                }
                label="Skip TLS verification"
              />
            </div>

            <label for="settings-auto-title" class="flex items-center justify-between gap-4 p-3 cursor-pointer select-none">
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-fg font-medium">
                  <Iconify icon="lucide:sparkles" size={13} class="text-accent" />
                  <span>Auto-generate conversation titles</span>
                </span>
                <span class="block text-[11px] text-fg-muted font-normal mt-0.5">
                  The host asks the model for a short title after the first exchange. Off leaves "New conversation".
                </span>
              </span>
              <span class="relative inline-flex items-center shrink-0">
                <input
                  id="settings-auto-title"
                  type="checkbox"
                  checked={!(m.daemonSettings().noAutoTitle ?? false)}
                  onChange={(e) =>
                    m.setDaemonSettings({ ...m.daemonSettings(), noAutoTitle: !e.currentTarget.checked })
                  }
                  class="sr-only peer"
                />
                <span
                  class="ui-switch-track shrink-0 cursor-pointer"
                  aria-checked={!(m.daemonSettings().noAutoTitle ?? false)}
                >
                  <span class="ui-switch-thumb" />
                </span>
              </span>
            </label>
          </div>

          <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <label for="settings-upstream-proxy" class="font-medium text-fg">
                Upstream proxy
              </label>
              <Badge tone={(m.daemonSettings().httpProxy ?? "").trim() ? "blue" : "zinc"}>
                {(m.daemonSettings().httpProxy ?? "").trim() ? "Explicit proxy" : "Env default"}
              </Badge>
            </div>
            <div class="rc-studio-well flex items-center gap-2 px-2.5 py-1.5 focus-within:border-accent transition-colors">
              <Iconify icon="lucide:globe" size={14} class="shrink-0 text-fg-muted" />
              <input
                id="settings-upstream-proxy"
                type="text"
                value={m.daemonSettings().httpProxy ?? ""}
                onInput={(e) =>
                  m.setDaemonSettings({ ...m.daemonSettings(), httpProxy: e.currentTarget.value })
                }
                placeholder="http://host:port (empty = environment default)"
                class="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg placeholder:text-fg-muted outline-none"
                aria-label="Upstream proxy URL"
              />
              <Show when={(m.daemonSettings().httpProxy ?? "").length > 0}>
                <button
                  type="button"
                  onClick={() => m.setDaemonSettings({ ...m.daemonSettings(), httpProxy: "" })}
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-muted hover:text-fg cursor-pointer"
                  aria-label="Clear upstream proxy"
                >
                  <Iconify icon="lucide:x" size={12} />
                </button>
              </Show>
            </div>
            <p class="text-[11px] text-fg-muted mt-1.5">
              Explicit proxy for provider requests. Empty keeps HTTP(S)_PROXY environment handling.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
