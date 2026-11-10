import { Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Segmented, setThemeMode, themeMode } from "../../ui";
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
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={props.onToggle}
      class="ui-switch-track shrink-0 cursor-pointer"
      role="switch"
      aria-checked={props.on()}
      aria-label={props.label}
    >
      <span
        class="ui-switch-thumb"
      />
    </button>
  );
}

export function SettingsGeneralSection() {
  const m = useModal();
  const ui = useUI();
  const hosts = useHost();
  const hostStatus = () => hosts.activeHost()?.status;
  const du = ui.daemonUpdate;
  return (
<>
<div class="border-b border-line pb-4 last:border-0 last:pb-0 space-y-3">
  <h3 class="text-sm font-medium text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:palette" size={15} class="text-ink-500" />
    <span>Appearance</span>

  </h3>
  <div class="space-y-3 text-xs">
    <div class="py-2">
      <div class="font-medium text-ink-200">Theme</div>
      <div class="text-[11px] text-ink-500 mt-0.5 mb-2">
        White, dark, or follow the system automatically.
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
    <div class="py-2 flex items-center justify-between gap-4">
      <div>
        <div class="font-medium text-ink-200">Verbose Agent Chat</div>
        <div class="text-[11px] text-ink-500 mt-0.5">
          Display intermediate thinking steps.
        </div>
      </div>
      <button
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
        <span
          class="ui-switch-thumb"
        />
      </button>
    </div>
    <Show when={ui.verboseChat()}>
      <div class="py-2 pl-4 border-l-2 border-line/60 flex items-center justify-between gap-4">
        <div>
          <div class="font-medium text-ink-200">Hide Tool Call Messages</div>
          <div class="text-[11px] text-ink-500 mt-0.5">
            Hide intermediate messages sent alongside tool calls to group actions and thoughts during the turn. Messages with 50+ tokens always stay visible.
          </div>
        </div>
        <button
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
          <span
            class="ui-switch-thumb"
          />
        </button>
      </div>
    </Show>
    <div class="py-2">
      <div class="font-medium text-ink-200">Conversation Width</div>
      <div class="text-[11px] text-ink-500 mt-0.5 mb-2">
        Maximum width of the conversation panel.
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
    </div>
  </div>
</div>

<div class="border-b border-line pb-4 last:border-0 last:pb-0 space-y-3">
  <h3 class="text-sm font-medium text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:bell" size={15} class="text-ink-500" />
    <span>Turn notifications</span>
  </h3>
  <div class="space-y-3 text-xs">
    <div class="py-2 flex items-center justify-between gap-4">
      <div>
        <div class="font-medium text-ink-200">Notify when a turn finishes</div>
        <div class="text-[11px] text-ink-500 mt-0.5">
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
      <div class="py-2 pl-4 border-l-2 border-line/60 flex items-center justify-between gap-4">
        <div>
          <div class="font-medium text-ink-200">Play a sound</div>
          <div class="text-[11px] text-ink-500 mt-0.5">
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
    <Show when={ui.turnNotify.notifyOn() && ui.turnNotify.permission() === "denied"}>
      <p class="text-[11px] text-danger">
        Browser notifications are blocked for this site — allow them in the browser site settings, then use Test below.
      </p>
    </Show>
    <div class="flex items-center gap-2">
      <button
        onClick={() => ui.turnNotify.testNotify()}
        class="px-3 py-1.5 rounded-lg border border-line text-ink-200 hover:bg-ink-800 transition-colors cursor-pointer"
      >
        Test notification
      </button>
      <Show when={ui.pushSub.supported()}>
        <span class="text-[11px] text-ink-500">
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
</div>

<div class="border-b border-line pb-4 last:border-0 last:pb-0 space-y-3">
  <h3 class="text-sm font-medium text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:arrow-down-to-line" size={15} class="text-ink-500" />
    <span>Updates</span>
  </h3>
  <div class="space-y-3 text-xs">
    <label for="settings-auto-update" class="flex items-center justify-between gap-4 py-1.5 cursor-pointer select-none">
      <span class="min-w-0">
        <span class="text-ink-200 font-medium block">Auto-update daemon</span>
        <span class="block text-[11px] text-ink-500 font-normal mt-0.5">
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
    <div class="flex items-center gap-2 text-ink-500">
      <span>
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
    <div class="flex items-center gap-2">
      <button class="cursor-pointer text-ink-300 hover:text-ink-100 text-xs font-medium transition-colors" onClick={() => du.checkNow()}>
        Check now
      </button>
      <Show when={(() => { const i = du.info(); return !!i && !!i.available && i.available !== i.current && hostStatus() !== "updating"; })()}>
        <button
          class="cursor-pointer text-accent hover:text-accent-hover text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={du.applying()}
          onClick={() => { du.apply(); m.cancelSettings(); }}
        >
          {du.applying() ? "Updating…" : "Update now"}
        </button>
      </Show>
    </div>
    <Show when={(() => { const i = du.info(); return !!i && (i.lifecycle === "failed" || i.lifecycle === "done"); })()}>
      <p class="text-[11px] text-ink-500">
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
</div>

<div class="border-b border-line pb-4 last:border-0 last:pb-0 space-y-3">
  <h3 class="text-sm font-medium text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:sliders-horizontal" size={15} class="text-ink-500" />
    <span>Advanced</span>
  </h3>
  <div class="space-y-4 text-xs">
    <div>
      <label class="block font-medium text-ink-200 mb-1">
        Auto-compact threshold
      </label>
      <Segmented
        value={String(m.daemonSettings().autoCompactPercent ?? 80)}
        onChange={(v) =>
          m.setDaemonSettings({ ...m.daemonSettings(), autoCompactPercent: Number(v) })
        }
        class="grid grid-cols-6"
        options={[0, 70, 80, 85, 90, 95].map((v) => ({
          value: String(v),
          label: v === 0 ? "Off" : `${v}%`,
        }))}
      />
      {/* Exclusive Context Compaction Trigger Zone Meter */}
      <div class="mt-2 rounded-lg border border-line bg-ink-950/60 p-2.5 space-y-1.5" aria-hidden="true">
        <div class="flex items-center justify-between text-[10px] font-mono">
          <span class="text-ink-400">
            {(m.daemonSettings().autoCompactPercent ?? 80) === 0
              ? "Auto-compaction disabled · manual compact only"
              : `Active conversation buffer: 0% → ${m.daemonSettings().autoCompactPercent ?? 80}%`}
          </span>
          <span class="text-accent">
            {(m.daemonSettings().autoCompactPercent ?? 80) === 0
              ? "100% raw"
              : `${100 - (m.daemonSettings().autoCompactPercent ?? 80)}% headroom reserve`}
          </span>
        </div>
        <div class="h-1.5 rounded-full bg-ink-900 overflow-hidden flex">
          <div
            class="h-full bg-accent transition-all"
            style={{
              width: `${
                (m.daemonSettings().autoCompactPercent ?? 80) === 0
                  ? 100
                  : m.daemonSettings().autoCompactPercent ?? 80
              }%`,
            }}
          />
          <div class="h-full bg-warning/50 flex-1 transition-all" />
        </div>
      </div>
      <p class="text-[11px] text-ink-500 mt-1">
        Compact the transcript automatically past this context usage.
      </p>
    </div>
    <div class="flex items-center justify-between gap-4">
      <div>
        <div class="font-medium text-ink-200">Jail new conversations</div>
        <div class="text-[11px] text-ink-500 mt-0.5">
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
    <div class="flex items-center justify-between gap-4">
      <div>
        <div class="font-medium text-ink-200">Skip TLS verification</div>
        <div class="text-[11px] text-ink-500 mt-0.5">
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
    <div>
      <label for="settings-upstream-proxy" class="block font-medium text-ink-200 mb-1">
        Upstream proxy
      </label>
      <input
        id="settings-upstream-proxy"
        type="text"
        value={m.daemonSettings().httpProxy ?? ""}
        onInput={(e) =>
          m.setDaemonSettings({ ...m.daemonSettings(), httpProxy: e.currentTarget.value })
        }
        placeholder="http://host:port (empty = environment default)"
        class="w-full bg-card border border-line rounded-md px-2 py-1.5 text-xs text-ink-100 placeholder:text-ink-600"
        aria-label="Upstream proxy URL"
      />
      <p class="text-[11px] text-ink-500 mt-1">
        Explicit proxy for provider requests. Empty keeps HTTP(S)_PROXY environment handling.
      </p>
    </div>
  </div>
</div>

<div class="border-b border-line pb-4 last:border-0 last:pb-0 space-y-3">
  <h3 class="text-sm font-medium text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:type" size={15} class="text-ink-500" />
    <span>Title Generator</span>
  </h3>
  <label for="settings-auto-title" class="flex items-center justify-between gap-4 py-1.5 cursor-pointer select-none text-xs">
    <span class="min-w-0">
      <span class="text-ink-200 font-medium block">Auto-generate conversation titles</span>
      <span class="block text-[11px] text-ink-500 font-normal mt-0.5">
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
</>
  );
}
