import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import { press } from "../../ds/motion/press";
import {
  ACCENTS,
  Badge,
  Select,
  accent,
  setAccent,
  setThemeMode,
  theme,
  themeMode,
  type AccentName,
  type ThemeMode,
} from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal, useUI } from "../ctx";
import { pushSupported } from "../hooks/usePushSubscription";
import { validateProxyUrl } from "../hooks/useSettings";
import {
  normalizeAccessMode,
  normalizeMidTurnSend,
  type AccessMode,
  type MidTurnDelivery,
  type PermissionCapability,
  type PermissionEffect,
  type PermissionRule,
} from "../utils/settingsValidation";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "high-contrast", label: "Contrast" },
  { value: "system", label: "System" },
];

type ConvWidth = "narrow" | "default" | "wide";

const WIDTH_OPTIONS: Array<{
  value: ConvWidth;
  label: string;
  px: string;
  caption: string;
  colPct: string;
}> = [
  { value: "narrow", label: "Narrow", px: "576px", caption: "Focused", colPct: "44%" },
  { value: "default", label: "Default", px: "768px", caption: "Balanced", colPct: "66%" },
  { value: "wide", label: "Wide", px: "1024px", caption: "Studio", colPct: "88%" },
];

const MID_TURN_SEND_OPTIONS: Array<{
  value: MidTurnDelivery;
  label: string;
  icon: string;
  description: string;
}> = [
  {
    value: "queue",
    label: "Add to queue",
    icon: "lucide:list-plus",
    description: "Hold in queue until the turn finishes; promote anytime.",
  },
  {
    value: "steer",
    label: "Send on next step",
    icon: "lucide:corner-up-right",
    description: "Stage automatically for the next AI step, with × to return to queue.",
  },
  {
    value: "interrupt",
    label: "Interrupt & send",
    icon: "lucide:zap",
    description: "Cancel active thinking or tool call and send immediately.",
  },
];

const DEFAULT_ACCESS_OPTIONS: Array<{
  value: AccessMode;
  label: string;
  recommended?: boolean;
  icon: string;
  description: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    recommended: true,
    icon: "lucide:shield-check",
    description:
      "Sandboxed to workspace. Runs safe edits & dev commands; asks on outside paths, secrets, network, or destructive actions.",
  },
  {
    value: "ask",
    label: "Ask for approval",
    icon: "lucide:hand",
    description:
      "Sandboxed to workspace. Asks before file writes, shell commands, network, or outside access.",
  },
  {
    value: "full",
    label: "Full access",
    icon: "lucide:shield-alert",
    description:
      "Unrestricted workspace and host access. Runs all commands, file edits, and network requests without asking.",
  },
];

const PERMISSION_KIND_OPTIONS: Array<{
  value: PermissionCapability;
  label: string;
  shortLabel: string;
  icon: string;
  placeholder: string;
}> = [
  {
    value: "exec",
    label: "Command prefix",
    shortLabel: "Command",
    icon: "lucide:terminal",
    placeholder: "e.g. git push or npm publish",
  },
  {
    value: "fs_read",
    label: "Read path",
    shortLabel: "Read",
    icon: "lucide:folder-lock",
    placeholder: "e.g. /opt/shared/** or .env.example",
  },
  {
    value: "fs_write",
    label: "Write path",
    shortLabel: "Write",
    icon: "lucide:file-pen-line",
    placeholder: "e.g. ../shared-lib/**",
  },
  {
    value: "net",
    label: "Network host",
    shortLabel: "Network",
    icon: "lucide:globe",
    placeholder: "e.g. api.github.com or *.npmjs.org",
  },
  {
    value: "tool",
    label: "Tool name",
    shortLabel: "Tool",
    icon: "lucide:wrench",
    placeholder: "e.g. fetch_url",
  },
];

const COMPACT_RULER_STOPS = [50, 65, 80, 95] as const;
const COMPACT_TICKS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95] as const;

function snapCompactPct(raw: number): number {
  const clamped = Math.max(50, Math.min(95, raw));
  return Math.round(clamped / 5) * 5;
}

function SettingSwitchRow(props: {
  id: string;
  checked: () => boolean;
  onChange: (checked: boolean) => void;
  title: JSX.Element;
  description: JSX.Element;
  nested?: boolean;
}) {
  return (
    <label
      for={props.id}
      class={`flex items-center justify-between gap-4 px-3.5 py-2.5 cursor-pointer select-none hover:bg-surface-subtle/60 transition-colors ${
        props.nested ? "pl-5 bg-surface-subtle/35" : ""
      }`}
    >
      <span class={`min-w-0 ${props.nested ? "border-l-2 border-border-strong pl-3" : ""}`}>
        <span class="flex items-center gap-2 font-medium text-fg flex-wrap">
          {props.title}
        </span>
        <span class="mt-0.5 block text-2xs text-fg-muted font-normal leading-relaxed">
          {props.description}
        </span>
      </span>
      <span class="relative inline-flex items-center shrink-0">
        <input
          id={props.id}
          type="checkbox"
          role="switch"
          checked={props.checked()}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
          class="sr-only peer"
        />
        <span
          ref={press}
          class="ui-switch-track shrink-0"
          aria-hidden="true"
          aria-checked={props.checked()}
        >
          <span class="ui-switch-thumb" />
        </span>
      </span>
    </label>
  );
}

function ThemePreviewChrome(props: { mode: ThemeMode }) {
  if (props.mode === "system") {
    return (
      <div
        aria-hidden="true"
        class="relative h-11 w-full rounded-md overflow-hidden border border-border grid grid-cols-2"
      >
        {/* Day half */}
        <div
          class="flex h-full overflow-hidden"
          style={{ background: "var(--neutral-1)" }}
        >
          <div
            class="w-3 h-full shrink-0 flex flex-col gap-1 p-1"
            style={{
              background: "var(--neutral-3)",
              "border-right": "1px solid var(--neutral-4)",
            }}
          >
            <span class="h-1 w-full rounded-full" style={{ background: "var(--neutral-6)" }} />
            <span class="h-1 w-2/3 rounded-full" style={{ background: "var(--neutral-5)" }} />
          </div>
          <div class="flex-1 p-1.5 flex flex-col gap-1">
            <span
              class="ml-auto h-1.5 w-3/5 rounded-full"
              style={{ background: "var(--accent)" }}
            />
            <span class="h-1 w-4/5 rounded-full" style={{ background: "var(--neutral-10)" }} />
            <span class="mt-auto h-1.5 w-full rounded-xs" style={{ background: "var(--neutral-4)" }} />
          </div>
        </div>
        {/* Night half */}
        <div
          class="flex h-full overflow-hidden"
          style={{
            background: "var(--neutral-11)",
            "border-left": "1px solid var(--neutral-8)",
          }}
        >
          <div class="flex-1 p-1.5 flex flex-col gap-1">
            <span
              class="ml-auto h-1.5 w-3/5 rounded-full"
              style={{ background: "var(--accent)" }}
            />
            <span class="h-1 w-4/5 rounded-full" style={{ background: "var(--neutral-4)" }} />
            <span class="mt-auto h-1.5 w-full rounded-xs" style={{ background: "var(--neutral-10)" }} />
          </div>
        </div>
      </div>
    );
  }

  const isLight = () => props.mode === "light";
  const isContrast = () => props.mode === "high-contrast";

  return (
    <div
      aria-hidden="true"
      class="h-11 w-full rounded-md overflow-hidden flex"
      style={{
        background: isContrast()
          ? "color-mix(in oklab, var(--neutral-11) 45%, black)"
          : isLight()
            ? "var(--neutral-1)"
            : "var(--neutral-11)",
        border: isContrast()
          ? "1px solid var(--neutral-0)"
          : isLight()
            ? "1px solid var(--neutral-4)"
            : "1px solid var(--neutral-9)",
      }}
    >
      <div
        class="w-4 h-full shrink-0 flex flex-col gap-1 p-1"
        style={{
          background: isContrast()
            ? "var(--neutral-11)"
            : isLight()
              ? "var(--neutral-3)"
              : "var(--neutral-10)",
          "border-right": isContrast()
            ? "1px solid var(--neutral-0)"
            : isLight()
              ? "1px solid var(--neutral-4)"
              : "1px solid var(--neutral-9)",
        }}
      >
        <span
          class="h-1 w-full rounded-full"
          style={{
            background: isContrast()
              ? "var(--neutral-0)"
              : isLight()
                ? "var(--neutral-6)"
                : "var(--neutral-7)",
          }}
        />
        <span
          class="h-1 w-3/4 rounded-full"
          style={{
            background: isContrast()
              ? "var(--neutral-4)"
              : isLight()
                ? "var(--neutral-5)"
                : "var(--neutral-8)",
          }}
        />
      </div>
      <div class="flex-1 p-1.5 flex flex-col gap-1 min-w-0">
        <span
          class="ml-auto h-1.5 w-2/5 rounded-full"
          style={{
            background: isContrast() ? "var(--tone-teal)" : "var(--accent)",
          }}
        />
        <span
          class="h-1 w-4/5 rounded-full"
          style={{
            background: isContrast()
              ? "var(--neutral-0)"
              : isLight()
                ? "var(--neutral-10)"
                : "var(--neutral-3)",
          }}
        />
        <span
          class="h-1 w-3/5 rounded-full"
          style={{
            background: isContrast()
              ? "var(--neutral-4)"
              : isLight()
                ? "var(--neutral-6)"
                : "var(--neutral-7)",
          }}
        />
        <span
          class="mt-auto h-1.5 w-full rounded-xs"
          style={{
            background: isContrast()
              ? "var(--neutral-10)"
              : isLight()
                ? "var(--neutral-3)"
                : "var(--neutral-10)",
            border: isContrast() ? "1px solid var(--neutral-0)" : "none",
          }}
        />
      </div>
    </div>
  );
}

function ThemeStudioPicker() {
  let groupEl: HTMLDivElement | undefined;
  const activeAccentLabel = () =>
    ACCENTS.find((a) => a.id === accent())?.label ?? "Teal";

  const onRadioKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const idx = THEME_OPTIONS.findIndex((o) => o.value === themeMode());
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const nextIdx = (idx + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    const next = THEME_OPTIONS[nextIdx]!;
    setThemeMode(next.value);
    groupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIdx]?.focus();
  };

  return (
    <div class="rounded-panel border border-border bg-surface p-3.5 space-y-3.5">
      <div>
        <div class="flex items-center justify-between gap-2 mb-2">
          <span class="text-xs font-medium text-fg">Theme</span>
          <span class="text-2xs text-fg-muted">
            {themeMode() === "system"
              ? "Follows OS appearance"
              : themeMode() === "high-contrast"
                ? "Maximum contrast"
                : `${themeMode() === "dark" ? "Dark" : "Light"} surface`}
          </span>
        </div>
        <div
          ref={groupEl}
          role="radiogroup"
          aria-label="Theme"
          onKeyDown={onRadioKeyDown}
          class="grid grid-cols-2 sm:grid-cols-4 gap-2"
        >
          <For each={THEME_OPTIONS}>
            {(opt) => {
              const active = () => themeMode() === opt.value;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={active()}
                  tabIndex={active() ? 0 : -1}
                  ref={press}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setThemeMode(opt.value, {
                      x: rect.left + rect.width / 2,
                      y: rect.top + rect.height / 2,
                    });
                  }}
                  class={`flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors cursor-pointer ${
                    active()
                      ? "border-accent bg-accent-subtle/40 text-fg"
                      : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle text-fg-secondary"
                  }`}
                >
                  <ThemePreviewChrome mode={opt.value} />
                  <div class="flex items-center justify-between gap-1.5 px-0.5 w-full">
                    <span class="text-xs font-medium text-fg">{opt.label}</span>
                    <span
                      aria-hidden="true"
                      class={`h-2 w-2 shrink-0 rounded-full transition-colors ${
                        active() ? "bg-accent" : "border border-border-strong bg-transparent"
                      }`}
                    />
                  </div>
                </button>
              );
            }}
          </For>
        </div>
      </div>

      {/* Accent Swatches */}
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-border-subtle pt-3">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-fg">Accent</span>
          <span class="text-2xs text-fg-muted">
            {theme() === "high-contrast" ? `${activeAccentLabel()} (Contrast override)` : activeAccentLabel()}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="Accent color"
          class="flex flex-wrap items-center gap-2"
        >
          <For each={ACCENTS}>
            {(item) => {
              const selected = () => accent() === item.id;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected()}
                  aria-label={item.label}
                  data-rc-tip={item.label}
                  ref={press}
                  onClick={() => setAccent(item.id as AccentName)}
                  class={`relative flex h-6 w-6 items-center justify-center rounded-full transition-transform cursor-pointer [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-[''] ${
                    selected()
                      ? "ring-2 ring-fg ring-offset-2 ring-offset-surface scale-105"
                      : "opacity-80 hover:opacity-100 hover:scale-105"
                  }`}
                  style={{ background: item.swatch }}
                >
                  <Show when={selected()}>
                    <Iconify
                      icon="lucide:check"
                      size={12}
                      style={{ color: "var(--neutral-0)" }}
                    />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}

function ColumnWidthPicker(props: {
  value: () => string;
  onChange: (v: ConvWidth) => void;
}) {
  let groupEl: HTMLDivElement | undefined;
  const currentOpt = () =>
    WIDTH_OPTIONS.find((o) => o.value === props.value()) ?? WIDTH_OPTIONS[1]!;

  const onRadioKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const idx = WIDTH_OPTIONS.findIndex((o) => o.value === currentOpt().value);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const nextIdx = (idx + delta + WIDTH_OPTIONS.length) % WIDTH_OPTIONS.length;
    const next = WIDTH_OPTIONS[nextIdx]!;
    props.onChange(next.value);
    groupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIdx]?.focus();
  };

  return (
    <div class="rounded-panel border border-border bg-surface p-3.5">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="text-xs font-medium text-fg">Conversation width</span>
        <span class="text-2xs text-fg-muted">
          {currentOpt().caption}
        </span>
      </div>
      <div
        ref={groupEl}
        role="radiogroup"
        aria-label="Conversation width"
        onKeyDown={onRadioKeyDown}
        class="grid grid-cols-1 min-[440px]:grid-cols-3 gap-2"
      >
        <For each={WIDTH_OPTIONS}>
          {(opt) => {
            const active = () => currentOpt().value === opt.value;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active()}
                tabIndex={active() ? 0 : -1}
                ref={press}
                onClick={() => props.onChange(opt.value)}
                class={`flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors cursor-pointer group ${
                  active()
                    ? "border-accent bg-accent-subtle/40 text-fg"
                    : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle text-fg-secondary"
                }`}
              >
                {/* Miniature Viewport Column Schematic */}
                <div
                  aria-hidden="true"
                  class="h-11 w-full rounded-md border border-border bg-background/80 px-1.5 py-1.5 flex justify-center overflow-hidden"
                >
                  <div
                    class={`h-full flex flex-col gap-1 rounded-xs border px-1.5 py-1 transition-colors ${
                      active()
                        ? "border-accent/45 bg-surface"
                        : "border-border/70 bg-surface-subtle/70"
                    }`}
                    style={{ width: opt.colPct }}
                  >
                    <span
                      class={`ml-auto h-1 w-2/5 rounded-full ${
                        active() ? "bg-accent" : "bg-fg-muted/50"
                      }`}
                    />
                    <span class="h-1 w-4/5 rounded-full bg-fg/40" />
                    <span class="h-1 w-3/5 rounded-full bg-fg-muted/35" />
                    <span class="mt-auto h-1 w-full rounded-full bg-border-strong/60" />
                  </div>
                </div>
                <div class="flex items-center justify-between gap-1.5 px-0.5 w-full min-w-0">
                  <span class="text-xs font-medium text-fg truncate">{opt.label}</span>
                  <span class="text-2xs text-fg-muted tabular-nums shrink-0">{opt.px}</span>
                </div>
              </button>
            );
          }}
        </For>
      </div>
      <p class="mt-2 text-2xs text-fg-muted sm:hidden">
        Applies on desktop screens.
      </p>
    </div>
  );
}

function MidTurnSendPicker(props: {
  value: () => MidTurnDelivery;
  onChange: (v: MidTurnDelivery) => void;
}) {
  let groupEl: HTMLDivElement | undefined;
  const currentOpt = () =>
    MID_TURN_SEND_OPTIONS.find((o) => o.value === props.value()) ??
    MID_TURN_SEND_OPTIONS[0]!;

  const onRadioKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const idx = MID_TURN_SEND_OPTIONS.findIndex((o) => o.value === currentOpt().value);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const nextIdx =
      (idx + delta + MID_TURN_SEND_OPTIONS.length) % MID_TURN_SEND_OPTIONS.length;
    const next = MID_TURN_SEND_OPTIONS[nextIdx]!;
    props.onChange(next.value);
    groupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIdx]?.focus();
  };

  return (
    <div
      id="rc-set-mid-turn-send"
      data-setting="mid-turn-send"
      class="scroll-mt-24 sm:scroll-mt-16 rounded-panel border border-border bg-surface p-3.5 space-y-3"
    >
      <div class="min-w-0">
        <div class="text-xs font-medium text-fg">While agent is working</div>
        <div class="mt-0.5 text-2xs text-fg-muted">
          Default action when you send a message during an active turn.
        </div>
      </div>

      <div
        ref={groupEl}
        role="radiogroup"
        aria-label="While agent is working"
        onKeyDown={onRadioKeyDown}
        class="grid grid-cols-1 sm:grid-cols-3 gap-2"
      >
        <For each={MID_TURN_SEND_OPTIONS}>
          {(opt) => {
            const active = () => currentOpt().value === opt.value;
            return (
              <button
                type="button"
                role="radio"
                data-midturn-radio={opt.value}
                aria-checked={active()}
                tabIndex={active() ? 0 : -1}
                ref={press}
                onClick={() => props.onChange(opt.value)}
                class={`flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors cursor-pointer min-w-0 ${
                  active()
                    ? "border-accent bg-accent-subtle/40 text-fg"
                    : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle text-fg-secondary"
                }`}
              >
                <div class="flex items-center justify-between gap-2 w-full min-w-0">
                  <span class="inline-flex items-center gap-1.5 min-w-0">
                    <Iconify
                      icon={opt.icon}
                      size={14}
                      class={`shrink-0 ${active() ? "text-accent" : "text-fg-muted"}`}
                    />
                    <span class="text-xs font-medium text-fg truncate">
                      {opt.label}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    class={`h-2 w-2 shrink-0 rounded-full transition-colors ${
                      active() ? "bg-accent" : "border border-border-strong bg-transparent"
                    }`}
                  />
                </div>
                <p class="text-2xs text-fg-muted leading-relaxed">
                  {opt.description}
                </p>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function AutoCompactGauge(props: {
  value: () => number;
  onChange: (pct: number) => void;
}) {
  const [dragging, setDragging] = createSignal(false);
  const [lastAutoPct, setLastAutoPct] = createSignal(
    props.value() > 0 ? snapCompactPct(props.value()) : 80,
  );
  let trackEl: HTMLDivElement | undefined;

  createEffect(() => {
    const v = props.value();
    if (v > 0) setLastAutoPct(snapCompactPct(v));
  });

  const isOff = () => props.value() <= 0;
  const activePct = () => (isOff() ? lastAutoPct() : Math.max(50, Math.min(95, props.value())));
  const headroomPct = () => 100 - activePct();

  const pctFromClientX = (clientX: number): number => {
    if (!trackEl) return activePct();
    const rect = trackEl.getBoundingClientRect();
    if (rect.width <= 0) return activePct();
    const raw = ((clientX - rect.left) / rect.width) * 100;
    return snapCompactPct(raw);
  };

  const commitPct = (next: number) => {
    const snapped = snapCompactPct(next);
    setLastAutoPct(snapped);
    if (props.value() !== snapped) {
      props.onChange(snapped);
    }
  };

  const onTrackPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLDivElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {}
    target.focus({ preventScroll: true });
    setDragging(true);
    commitPct(pctFromClientX(e.clientX));
  };

  const onTrackPointerMove = (e: PointerEvent) => {
    if (!dragging()) return;
    commitPct(pctFromClientX(e.clientX));
  };

  const endDrag = (e: PointerEvent) => {
    if (!dragging()) return;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {}
    setDragging(false);
  };

  const onSliderKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      commitPct(isOff() ? lastAutoPct() : activePct() - 5);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      commitPct(isOff() ? lastAutoPct() : activePct() + 5);
    } else if (e.key === "Home") {
      e.preventDefault();
      commitPct(50);
    } else if (e.key === "End") {
      e.preventDefault();
      commitPct(95);
    }
  };

  return (
    <div class="rounded-panel border border-border bg-surface p-3.5 space-y-3">
      {/* Gauge Header: Title + Live Partition Readout + Off / Auto Toggle */}
      <div class="flex items-start sm:items-center justify-between gap-2.5 flex-wrap">
        <div class="min-w-0">
          <div class="text-xs font-medium text-fg">Auto-compact threshold</div>
          <div class="mt-0.5 text-2xs tabular-nums">
            <Show
              when={!isOff()}
              fallback={<span class="text-fg-muted">Manual /compact only</span>}
            >
              <span class="text-accent font-medium">{activePct()}% trigger</span>
              <span class="mx-1.5 text-fg-muted">·</span>
              <span class="text-warning">{headroomPct()}% headroom</span>
            </Show>
          </div>
        </div>

        <div
          role="group"
          aria-label="Auto-compaction mode"
          class="inline-flex items-center rounded-lg border border-border bg-surface-subtle p-0.5 shrink-0"
        >
          <button
            type="button"
            aria-pressed={isOff()}
            ref={press}
            onClick={() => props.onChange(0)}
            class={`rounded-md px-2.5 py-0.5 text-2xs font-medium transition-colors cursor-pointer ${
              isOff()
                ? "bg-surface-strong text-fg"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            Off
          </button>
          <button
            type="button"
            aria-pressed={!isOff()}
            ref={press}
            onClick={() => {
              if (isOff()) props.onChange(lastAutoPct());
            }}
            class={`rounded-md px-2.5 py-0.5 text-2xs font-medium transition-colors cursor-pointer ${
              !isOff()
                ? "bg-accent text-accent-foreground"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            Auto
          </button>
        </div>
      </div>

      <Show
        when={!isOff()}
        fallback={
          <p class="text-2xs text-fg-muted leading-relaxed">
            Automatic compaction is off. Run <code class="font-mono text-fg-secondary">/compact</code> manually whenever you want to summarize older turns.
          </p>
        }
      >
        {/* Zone Legend */}
        <div class="flex items-center justify-between gap-2 text-2xs" aria-hidden="true">
          <span class="inline-flex items-center gap-1.5 text-fg-secondary">
            <span class="h-2 w-2 rounded-xs bg-accent" />
            <span>Conversation history</span>
          </span>
          <span class="inline-flex items-center gap-1.5 text-fg-muted">
            <span>Compaction reserve</span>
            <span class="h-2 w-2 rounded-xs bg-warning" />
          </span>
        </div>

        {/* Unified Calibrated Partition Track + Proportional Ruler Scale */}
        <div>
          <div
            ref={trackEl}
            role="slider"
            tabIndex={0}
            aria-label="Auto-compact threshold"
            aria-valuemin={50}
            aria-valuemax={95}
            aria-valuenow={activePct()}
            aria-valuetext={`${activePct()}% trigger · ${headroomPct()}% headroom`}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onSliderKeyDown}
            class="relative h-9 w-full rounded-lg border border-border-strong bg-surface-subtle cursor-ew-resize select-none touch-none"
          >
            {/* Clipped inner two-zone fill */}
            <div class="absolute inset-0 rounded-[7px] overflow-hidden flex pointer-events-none">
              <div
                class={`h-full flex items-center pl-2.5 min-w-0 bg-accent-subtle border-r border-accent ${
                  dragging() ? "transition-none" : "transition-[width] duration-150 ease-out"
                }`}
                style={{ width: `${activePct()}%` }}
              >
                <span class="truncate text-2xs text-fg-secondary tabular-nums">
                  {`0% → ${activePct()}%`}
                </span>
              </div>
              <div class="h-full flex-1 bg-warning-subtle flex items-center justify-end pr-2 overflow-hidden">
                <Show when={headroomPct() >= 15}>
                  <span class="text-2xs text-warning tabular-nums">
                    {headroomPct()}%
                  </span>
                </Show>
              </div>
            </div>

            {/* 50% minimum auto-trigger dashed floor + 5% calibration ticks */}
            <div class="absolute inset-0 pointer-events-none" aria-hidden="true">
              <span class="absolute top-0 bottom-0 left-1/2 border-l border-dashed border-border-strong/70" />
              <For each={COMPACT_TICKS}>
                {(tick) => {
                  const major = tick === 50 || tick === 65 || tick === 80 || tick === 95;
                  return (
                    <span
                      class={`absolute bottom-0 -translate-x-1/2 w-px ${
                        major ? "h-2 bg-border-strong" : "h-1 bg-border-strong/60"
                      }`}
                      style={{ left: `${tick}%` }}
                    />
                  );
                }}
              </For>
            </div>

            {/* Tactile Partition Handle */}
            <div
              aria-hidden="true"
              class={`absolute -top-1 -bottom-1 w-4 -translate-x-1/2 rounded-md border flex items-center justify-center gap-0.5 pointer-events-none ${
                dragging()
                  ? "transition-none scale-105 border-accent bg-surface-raised shadow-raised"
                  : "transition-[left,transform,opacity] duration-150 ease-out bg-surface-raised border-border-strong"
              }`}
              style={{ left: `${activePct()}%` }}
            >
              <span class="h-3 w-px rounded-full bg-fg-muted" />
              <span class="h-3 w-px rounded-full bg-fg-muted" />
            </div>
          </div>

          {/* Proportionally Aligned Calibrated Ruler Scale */}
          <div
            role="group"
            aria-label="Auto-compact threshold presets"
            class="relative h-6 w-full mt-1 select-none"
          >
            <span
              aria-hidden="true"
              class="absolute left-0 top-1.5 text-2xs text-fg-muted/70 tabular-nums leading-none pointer-events-none"
            >
              0%
            </span>
            <For each={COMPACT_RULER_STOPS}>
              {(mark) => {
                const selected = () => activePct() === mark;
                const edgeRight = mark === 95;
                return (
                  <button
                    type="button"
                    aria-pressed={selected()}
                    ref={press}
                    onClick={() => commitPct(mark)}
                    style={{ left: `${mark}%` }}
                    class={`absolute top-0 flex flex-col items-center gap-0.5 border-0 bg-transparent px-1 py-0 cursor-pointer group rounded-xs ${
                      edgeRight ? "-translate-x-3/4 sm:-translate-x-1/2" : "-translate-x-1/2"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      class={`w-px h-1 transition-colors ${
                        selected()
                          ? "bg-accent"
                          : "bg-border-strong group-hover:bg-fg-muted"
                      }`}
                    />
                    <span
                      class={`text-2xs tabular-nums leading-none transition-colors ${
                        selected()
                          ? "text-fg font-medium"
                          : "text-fg-muted group-hover:text-fg"
                      }`}
                    >
                      {mark}%
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        <p class="text-2xs text-fg-muted leading-relaxed">
          Drag the partition or pick a stop to summarize older turns automatically once context usage crosses the trigger.
        </p>
      </Show>
    </div>
  );
}

function DefaultAccessPicker(props: {
  value: () => AccessMode;
  onChange: (mode: AccessMode) => void;
}) {
  let groupEl: HTMLDivElement | undefined;
  const currentOpt = () =>
    DEFAULT_ACCESS_OPTIONS.find((o) => o.value === props.value()) ??
    DEFAULT_ACCESS_OPTIONS[0]!;

  const onRadioKeyDown = (e: KeyboardEvent) => {
    const idx = DEFAULT_ACCESS_OPTIONS.findIndex(
      (o) => o.value === currentOpt().value,
    );
    let nextIdx = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      nextIdx = (idx + 1) % DEFAULT_ACCESS_OPTIONS.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIdx =
        (idx - 1 + DEFAULT_ACCESS_OPTIONS.length) %
        DEFAULT_ACCESS_OPTIONS.length;
    }
    if (nextIdx >= 0) {
      e.preventDefault();
      const target = DEFAULT_ACCESS_OPTIONS[nextIdx]!;
      props.onChange(target.value);
      requestAnimationFrame(() => {
        const radios = groupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        radios?.[nextIdx]?.focus();
      });
    }
  };

  return (
    <div
      data-setting="default-access"
      class="rounded-panel border border-border bg-surface p-3.5 space-y-3"
    >
      <div class="min-w-0">
        <div class="text-xs font-medium text-fg">
          Default permissions for new conversations
        </div>
        <div class="mt-0.5 text-2xs text-fg-muted">
          Applied when starting a new conversation unless overridden in the composer.
        </div>
      </div>

      <div
        ref={groupEl}
        role="radiogroup"
        aria-label="Default permissions for new conversations"
        onKeyDown={onRadioKeyDown}
        class="grid grid-cols-1 sm:grid-cols-3 gap-2"
      >
        <For each={DEFAULT_ACCESS_OPTIONS}>
          {(opt) => {
            const active = () => currentOpt().value === opt.value;
            const isFull = opt.value === "full";
            return (
              <button
                type="button"
                role="radio"
                data-default-access-radio={opt.value}
                aria-checked={active()}
                tabIndex={active() ? 0 : -1}
                ref={press}
                onClick={() => props.onChange(opt.value)}
                class={`flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors cursor-pointer min-w-0 ${
                  active()
                    ? isFull
                      ? "border-[color-mix(in_oklab,var(--warning)_45%,var(--border))] bg-warning-subtle/60 text-fg"
                      : "border-accent bg-accent-subtle/40 text-fg"
                    : "border-border bg-surface hover:border-border-strong hover:bg-surface-subtle text-fg-secondary"
                }`}
              >
                <div class="flex items-center justify-between gap-2 w-full min-w-0">
                  <span class="inline-flex items-center gap-1.5 min-w-0 flex-wrap">
                    <Iconify
                      icon={opt.icon}
                      size={14}
                      class={`shrink-0 ${
                        isFull
                          ? active()
                            ? "text-warning"
                            : "text-warning/80"
                          : active()
                            ? "text-accent"
                            : "text-fg-muted"
                      }`}
                    />
                    <span
                      class={`text-xs font-medium truncate ${
                        isFull && active() ? "text-warning" : "text-fg"
                      }`}
                    >
                      {opt.label}
                    </span>
                    <Show when={opt.recommended}>
                      <span class="inline-flex items-center rounded-inner border border-accent/30 bg-accent-subtle px-1.5 py-px text-2xs font-medium leading-tight text-accent shrink-0">
                        Recommended
                      </span>
                    </Show>
                  </span>
                  <span
                    aria-hidden="true"
                    class={`h-2 w-2 shrink-0 rounded-full transition-colors ${
                      active()
                        ? isFull
                          ? "bg-warning"
                          : "bg-accent"
                        : "border border-border-strong bg-transparent"
                    }`}
                  />
                </div>
                <p class="text-2xs text-fg-muted leading-relaxed">
                  {opt.description}
                </p>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function makeRuleId(): string {
  try {
    return `rule_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  } catch {
    return `rule_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function GlobalPermissionRulesManager(props: {
  rules: () => PermissionRule[];
  onChange: (next: PermissionRule[]) => void;
}) {
  const [draftEffect, setDraftEffect] = createSignal<PermissionEffect>("allow");
  const [draftKind, setDraftKind] = createSignal<PermissionCapability>("exec");
  const [draftPattern, setDraftPattern] = createSignal("");
  const [ruleFeedback, setRuleFeedback] = createSignal("");

  const currentKindMeta = () =>
    PERMISSION_KIND_OPTIONS.find((k) => k.value === draftKind()) ??
    PERMISSION_KIND_OPTIONS[0]!;

  const kindMetaFor = (kind: PermissionCapability) =>
    PERMISSION_KIND_OPTIONS.find((k) => k.value === kind) ??
    PERMISSION_KIND_OPTIONS[0]!;

  const handleAddRule = () => {
    const pattern = draftPattern().trim();
    if (!pattern) {
      setRuleFeedback("Enter a pattern to add a rule.");
      return;
    }
    if (/[\r\n\0]/.test(pattern)) {
      setRuleFeedback("Pattern cannot contain line breaks.");
      return;
    }
    const effect = draftEffect();
    const kind = draftKind();
    const existing = props.rules();
    if (
      existing.some(
        (r) => r.effect === effect && r.kind === kind && r.pattern === pattern,
      )
    ) {
      setRuleFeedback("This rule already exists.");
      return;
    }
    const nextRule: PermissionRule = {
      id: makeRuleId(),
      effect,
      kind,
      pattern,
      createdAt: Math.floor(Date.now() / 1000),
    };
    props.onChange([...existing, nextRule]);
    setDraftPattern("");
    setRuleFeedback("");
  };

  const handleRemoveRule = (id: string) => {
    props.onChange(props.rules().filter((r) => r.id !== id));
  };

  return (
    <div
      data-setting="permission-rules"
      class="rounded-panel border border-border bg-surface p-3.5 space-y-3"
    >
      <div class="flex items-start justify-between gap-2.5 flex-wrap">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs font-medium text-fg">
              Global permission rules
            </span>
            <Badge tone="neutral">
              {props.rules().length}{" "}
              {props.rules().length === 1 ? "rule" : "rules"}
            </Badge>
          </div>
          <p class="mt-0.5 text-2xs text-fg-muted leading-relaxed">
            Rules saved with 'Always allow' (or added below) apply across all conversations on this host. Deny rules always take precedence over Allow rules.
          </p>
        </div>
      </div>

      {/* Inline Add Rule Control */}
      <div class="space-y-1.5">
        <div class="flex flex-col sm:flex-row sm:items-center gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <div
              role="group"
              aria-label="Rule effect"
              class="inline-flex shrink-0 items-center rounded-control border border-border bg-surface-subtle p-0.5"
            >
              <button
                type="button"
                data-rule-effect="allow"
                aria-pressed={draftEffect() === "allow"}
                ref={press}
                onClick={() => {
                  setDraftEffect("allow");
                  setRuleFeedback("");
                }}
                class={`rounded-md px-2 py-1 text-2xs font-medium transition-colors cursor-pointer ${
                  draftEffect() === "allow"
                    ? "bg-success-subtle text-success border border-success/30"
                    : "border border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                Allow
              </button>
              <button
                type="button"
                data-rule-effect="deny"
                aria-pressed={draftEffect() === "deny"}
                ref={press}
                onClick={() => {
                  setDraftEffect("deny");
                  setRuleFeedback("");
                }}
                class={`rounded-md px-2 py-1 text-2xs font-medium transition-colors cursor-pointer ${
                  draftEffect() === "deny"
                    ? "bg-danger-subtle text-danger border border-danger/30"
                    : "border border-transparent text-fg-muted hover:text-fg"
                }`}
              >
                Deny
              </button>
            </div>

            <div
              data-rule-kind
              class="flex-1 sm:w-40 sm:flex-none min-w-0 [&_.ui-field]:min-h-7 [&_.ui-field]:h-7 [&_.ui-field]:px-2.5 [&_.ui-field]:text-xs"
            >
              <Select
                ariaLabel="Rule capability kind"
                value={draftKind()}
                onChange={(v) => {
                  setDraftKind(v as PermissionCapability);
                  setRuleFeedback("");
                }}
                options={PERMISSION_KIND_OPTIONS.map((k) => ({
                  value: k.value,
                  label: k.label,
                }))}
              />
            </div>
          </div>

          <div class="flex items-center gap-2 flex-1 min-w-0">
            <input
              type="text"
              aria-label="Rule pattern"
              data-rule-pattern
              value={draftPattern()}
              onInput={(e) => {
                setDraftPattern(e.currentTarget.value);
                if (ruleFeedback()) setRuleFeedback("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddRule();
                }
              }}
              placeholder={currentKindMeta().placeholder}
              class={`h-7 flex-1 min-w-0 rounded-control border bg-surface px-2.5 font-mono text-xs text-fg placeholder:font-sans placeholder:text-fg-muted outline-none transition-colors ${
                ruleFeedback()
                  ? "border-danger focus:border-danger"
                  : "border-border-strong focus:border-accent"
              }`}
            />
            <button
              type="button"
              data-action="add-permission-rule"
              disabled={!draftPattern().trim()}
              ref={press}
              onClick={handleAddRule}
              class="h-7 shrink-0 inline-flex items-center gap-1 rounded-control border border-border-strong bg-surface-subtle hover:bg-surface-muted px-2.5 text-xs font-medium text-fg transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <Iconify icon="lucide:plus" size={13} class="shrink-0" />
              <span>Add rule</span>
            </button>
          </div>
        </div>

        <Show
          when={ruleFeedback()}
          fallback={
            <Show when={draftPattern().trim()}>
              <p class="text-2xs text-fg-muted">
                Press Enter or click Add rule to include this rule before saving.
              </p>
            </Show>
          }
        >
          <p role="alert" class="text-2xs text-danger">
            {ruleFeedback()}
          </p>
        </Show>
      </div>

      {/* Rules List / Empty State */}
      <Show
        when={props.rules().length > 0}
        fallback={
          <div
            data-permission-rules-empty
            class="rounded-lg border border-dashed border-border bg-surface-subtle/50 px-3.5 py-4 text-center text-2xs text-fg-muted leading-relaxed"
          >
            No global permission rules yet. Choose 'Always allow' on an approval prompt or add a custom rule above.
          </div>
        }
      >
        <div
          data-permission-rules-list
          class="rounded-lg border border-border overflow-hidden"
        >
          <For each={props.rules()}>
            {(rule) => {
              const kMeta = () => kindMetaFor(rule.kind);
              const isDeny = () => rule.effect === "deny";
              return (
                <div
                  data-permission-rule-row={rule.id}
                  class="px-3 py-2 border-b border-border-subtle last:border-b-0 bg-surface hover:bg-surface-subtle/60 flex items-center justify-between gap-2 min-w-0 transition-colors"
                >
                  <div class="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                    <Badge tone={isDeny() ? "danger" : "success"}>
                      {isDeny() ? "Deny" : "Allow"}
                    </Badge>
                    <span class="inline-flex items-center gap-1 rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 text-2xs font-medium text-fg-secondary shrink-0">
                      <Iconify
                        icon={kMeta().icon}
                        size={11}
                        class="text-fg-muted shrink-0"
                      />
                      <span>{kMeta().shortLabel}</span>
                    </span>
                    <code class="font-mono text-xs text-fg break-words [overflow-wrap:anywhere] min-w-0">
                      {rule.pattern}
                    </code>
                  </div>
                  <button
                    type="button"
                    data-action="remove-permission-rule"
                    data-rule-id={rule.id}
                    data-rc-tip="Revoke rule"
                    aria-label={`Revoke ${rule.effect} rule for ${rule.pattern}`}
                    ref={press}
                    onClick={() => handleRemoveRule(rule.id)}
                    class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-danger-subtle hover:text-danger transition-colors cursor-pointer"
                  >
                    <Iconify icon="lucide:trash-2" size={13} />
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

function HostUnavailableNotice(props: { status?: string; loaded: boolean }) {
  const message = () => {
    if (props.status === "updating") {
      return "This host is updating. Host settings will become editable once it reconnects.";
    }
    if (props.status !== "online") {
      return "This host is offline. Device settings above still apply; reconnect the host to change host settings.";
    }
    return "Loading host settings…";
  };
  return (
    <div class="flex items-center gap-2 rounded-panel border border-border bg-surface-subtle/70 px-3.5 py-2.5 text-xs text-fg-secondary">
      <Show
        when={props.status === "online" && !props.loaded}
        fallback={<Iconify icon="lucide:wifi-off" size={14} class="shrink-0 text-fg-muted" />}
      >
        <span class="ui-spinner w-3.5 h-3.5 text-accent shrink-0" aria-hidden="true" />
      </Show>
      <span>{message()}</span>
    </div>
  );
}

export function SettingsGeneralSection() {
  const m = useModal();
  const ui = useUI();
  const hosts = useHost();
  const hostStatus = () => hosts.activeHost?.()?.status;
  const hostOnline = () => hostStatus() === "online" && (hosts.wsOpen ? hosts.wsOpen() : true);
  const configLoaded = () => (typeof m.configLoaded === "function" ? m.configLoaded() : true);
  const hostEditable = () => configLoaded() && hostOnline();
  const du = ui.daemonUpdate;
  const compactPct = () => m.daemonSettings().autoCompactPercent ?? 80;
  const midTurnSend = () =>
    normalizeMidTurnSend(m.daemonSettings().midTurnSend);
  const defaultAccess = () =>
    normalizeAccessMode(m.daemonSettings().defaultAccess, "auto");
  const permissionRules = () => m.daemonSettings().permissionRules ?? [];
  const proxyError = () => validateProxyUrl(m.daemonSettings().httpProxy ?? "");

  const pushBlocked = () =>
    ui.turnNotify.notifyOn() &&
    (ui.turnNotify.permission() === "denied" || ui.pushSub.state() === "blocked");
  const pushFailed = () =>
    ui.turnNotify.notifyOn() && !pushBlocked() && ui.pushSub.state() === "error";

  const pushBadge = () => {
    if (!ui.turnNotify.notifyOn()) return { tone: "neutral" as const, label: "Push off" };
    if (pushBlocked()) return { tone: "danger" as const, label: "Push blocked" };
    if (ui.pushSub.state() === "active") return { tone: "success" as const, label: "Push active" };
    if (ui.pushSub.state() === "error") return { tone: "danger" as const, label: "Push error" };
    if (ui.pushSub.state() === "off") return { tone: "neutral" as const, label: "Permission needed" };
    return { tone: "neutral" as const, label: "Checking…" };
  };

  const handleUpdateNow = () => {
    const run = () => {
      du.apply();
      m.cancelSettings();
    };
    if (m.settingsDirty() && typeof m.showConfirm === "function") {
      void m
        .showConfirm({
          title: "Update host with unsaved changes?",
          message:
            "Starting the update will close Settings and discard your unsaved host setting changes.",
          confirmText: "Discard & update",
          cancelText: "Keep editing",
          danger: true,
        })
        .then((ok) => {
          if (ok) run();
        });
      return;
    }
    run();
  };

  return (
    <div class="space-y-6">
      {/* 1. Appearance & Layout */}
      <section id="rc-set-appearance" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-sm font-medium text-fg">Appearance</h3>
            <p class="text-xs text-fg-muted mt-0.5">
              Theme, accent color, layout width, and message display.
            </p>
          </div>
          <span class="text-2xs text-fg-muted shrink-0">Saved on this device</span>
        </div>

        <div class="space-y-3 text-xs">
          <ThemeStudioPicker />

          <ColumnWidthPicker
            value={ui.convWidth}
            onChange={(v) => {
              ui.setConvWidth(v);
              try {
                localStorage.setItem("llmgw-rc-width", v);
              } catch {}
            }}
          />

          <div class="rounded-panel border border-border bg-surface divide-y divide-border-subtle overflow-hidden">
            <SettingSwitchRow
              id="settings-verbose-chat"
              checked={ui.verboseChat}
              onChange={(v) => {
                ui.setVerboseChat(v);
                try {
                  localStorage.setItem("llmgw-rc-verbose", v ? "1" : "0");
                } catch {}
              }}
              title="Verbose agent chat"
              description="Display intermediate thinking steps and tool calls."
            />

            <Show when={ui.verboseChat()}>
              <SettingSwitchRow
                id="settings-hide-tool-messages"
                nested
                checked={ui.hideToolMessages}
                onChange={(v) => {
                  ui.setHideToolMessages(v);
                  try {
                    localStorage.setItem("llmgw-rc-hide-tool-messages", v ? "1" : "0");
                  } catch {}
                }}
                title="Hide tool call messages"
                description="Group short intermediate commentary into tool calls. Messages with 50+ tokens always stay visible."
              />
            </Show>
          </div>
        </div>
      </section>

      {/* 2. Notifications & Push */}
      <section id="rc-set-notifications" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-sm font-medium text-fg">Notifications</h3>
            <p class="text-xs text-fg-muted mt-0.5">
              Background alerts across hosts and closed browser tabs.
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-2xs text-fg-muted">Saved on this device</span>
            <Show when={ui.pushSub.supported()}>
              <Badge tone={pushBadge().tone}>{pushBadge().label}</Badge>
            </Show>
          </div>
        </div>

        <div class="space-y-3 text-xs">
          <div class="rounded-panel border border-border bg-surface divide-y divide-border-subtle overflow-hidden">
            <SettingSwitchRow
              id="settings-turn-notify"
              checked={() => ui.turnNotify.notifyOn()}
              onChange={(v) => {
                ui.turnNotify.setEnabled(v);
                void ui.pushSub.sync();
              }}
              title="Notify when a turn finishes"
              description={
                <>
                  Browser alerts for workspace turns across any host, even conversations you are not watching. Talk and Learning conversations stay silent.
                  <Show when={pushSupported()}>
                    <span> With permission granted, closed tabs also notify via push.</span>
                  </Show>
                </>
              }
            />

            <Show when={ui.turnNotify.notifyOn()}>
              <SettingSwitchRow
                id="settings-turn-sound"
                nested
                checked={() => ui.turnNotify.soundOn()}
                onChange={(v) => ui.turnNotify.setSound(v)}
                title="Play a sound"
                description="Short chime with the notification (only while a tab is open)."
              />
            </Show>
          </div>

          <Show when={pushBlocked()}>
            <p class="rounded-panel border border-danger/30 bg-danger-subtle px-3.5 py-2.5 text-2xs text-danger">
              Browser notifications are blocked for this site. Allow them in your browser site settings, then use Test notification below.
            </p>
          </Show>
          <Show when={pushFailed()}>
            <p class="rounded-panel border border-danger/30 bg-danger-subtle px-3.5 py-2.5 text-2xs text-danger">
              Background push setup failed. Click Test notification below to retry.
            </p>
          </Show>

          <div class="flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              ref={press}
              disabled={!ui.turnNotify.notifyOn()}
              onClick={() => ui.turnNotify.testNotify()}
              class="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <Iconify icon="lucide:bell-ring" size={13} class="text-fg-secondary" />
              <span>Test notification</span>
            </button>
            <Show when={!pushBlocked() && !pushFailed()}>
              <span class="text-2xs text-fg-muted">
                {!ui.turnNotify.notifyOn()
                  ? "Turn notifications on to send a test."
                  : ui.pushSub.supported() && ui.pushSub.state() === "active"
                    ? "Closed tabs still notify via push."
                    : ui.pushSub.supported() && ui.pushSub.state() === "off"
                      ? "Click Test notification to grant browser permission."
                      : ui.pushSub.supported() && ui.pushSub.state() === "unknown"
                        ? "Checking push status…"
                        : ""}
              </span>
            </Show>
          </div>
        </div>
      </section>

      {/* 3. Updates */}
      <section id="rc-set-updates" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-sm font-medium text-fg">Updates</h3>
            <p class="text-xs text-fg-muted mt-0.5">
              Host version and update checks.
            </p>
          </div>
          <Show when={du.info()?.current}>
            <span class="rounded-pill border border-border bg-surface-subtle px-2.5 py-0.5 font-mono text-2xs text-fg-secondary">
              {du.info()?.current}
            </span>
          </Show>
        </div>

        <div class="space-y-3 text-xs">
          <Show when={!hostOnline()}>
            <HostUnavailableNotice status={hostStatus()} loaded={configLoaded()} />
          </Show>

          <div class="rounded-panel border border-border bg-surface overflow-hidden">
            <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 flex-wrap">
              <div class="flex items-center gap-2 min-w-0 text-fg-secondary">
                <Iconify icon="lucide:package-check" size={14} class="shrink-0 text-fg-muted" />
                <span class="min-w-0 leading-relaxed">
                  {(() => {
                    const i = du.info();
                    if (!i?.current) return "Version unavailable (host has not reported yet).";
                    if (i.current === "dev") return "Dev build (self-update disabled).";
                    if (hostStatus() === "updating") {
                      return i.target ? `Updating to ${i.target}…` : "Updating…";
                    }
                    if (i.available && i.available !== i.current) {
                      return `Update available: ${i.available}.`;
                    }
                    if (i.checkedAt) return "Up to date.";
                    return "No update check yet.";
                  })()}
                </span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  ref={press}
                  disabled={!hostOnline()}
                  class="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                  onClick={() => du.checkNow()}
                >
                  Check now
                </button>
                <Show
                  when={(() => {
                    const i = du.info();
                    return (
                      !!i &&
                      !!i.available &&
                      i.available !== i.current &&
                      hostStatus() !== "updating"
                    );
                  })()}
                >
                  <button
                    type="button"
                    ref={press}
                    class="inline-flex items-center justify-center rounded-lg bg-accent hover:bg-accent-strong text-accent-foreground px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={du.applying() || !hostOnline()}
                    onClick={handleUpdateNow}
                  >
                    {du.applying() ? "Updating…" : "Update now"}
                  </button>
                </Show>
              </div>
            </div>
          </div>

          <Show when={du.info()?.lifecycle === "failed"}>
            <p class="text-2xs text-danger">
              {(() => {
                const i = du.info()!;
                return `Last update${i.target ? ` (${i.target})` : ""} failed: ${i.failedReason || i.error || "unknown error"}.`;
              })()}
            </p>
          </Show>
          <Show when={du.info()?.lifecycle === "done"}>
            <p class="text-2xs text-fg-muted">
              {`Last update finished${du.info()?.current ? `: now running ${du.info()!.current}` : ""}.`}
            </p>
          </Show>
          <Show when={du.info()?.error && du.info()?.lifecycle !== "failed"}>
            <p class="text-2xs text-danger">{du.info()?.error}</p>
          </Show>
        </div>
      </section>

      {/* 4. Permissions */}
      <section id="rc-set-permissions" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-sm font-medium text-fg">Permissions</h3>
            <p class="text-xs text-fg-muted mt-0.5">
              Default execution permissions for new conversations and host-wide allow or deny rules.
            </p>
          </div>
          <span class="text-2xs text-fg-muted shrink-0">Saved on host</span>
        </div>

        <Show when={!hostEditable()}>
          <HostUnavailableNotice status={hostStatus()} loaded={configLoaded()} />
        </Show>

        <fieldset
          disabled={!hostEditable()}
          class="space-y-3 text-xs min-w-0 disabled:opacity-55"
        >
          <DefaultAccessPicker
            value={defaultAccess}
            onChange={(mode) =>
              m.setDaemonSettings({
                ...m.daemonSettings(),
                defaultAccess: mode,
                jailByDefault: mode !== "full",
              })
            }
          />

          <GlobalPermissionRulesManager
            rules={permissionRules}
            onChange={(nextRules) =>
              m.setDaemonSettings({
                ...m.daemonSettings(),
                permissionRules: nextRules,
              })
            }
          />
        </fieldset>
      </section>

      {/* 5. Runtime */}
      <section id="rc-set-runtime" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5 pb-3">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-sm font-medium text-fg">Runtime</h3>
            <p class="text-xs text-fg-muted mt-0.5">
              Mid-turn messages, context compaction, conversation titles, and network options.
            </p>
          </div>
          <span class="text-2xs text-fg-muted shrink-0">Saved on host</span>
        </div>

        <Show when={!hostEditable()}>
          <HostUnavailableNotice status={hostStatus()} loaded={configLoaded()} />
        </Show>

        <fieldset
          disabled={!hostEditable()}
          class="space-y-3 text-xs min-w-0 disabled:opacity-55"
        >
          <MidTurnSendPicker
            value={midTurnSend}
            onChange={(mode) =>
              m.setDaemonSettings({ ...m.daemonSettings(), midTurnSend: mode })
            }
          />

          <AutoCompactGauge
            value={compactPct}
            onChange={(pct) =>
              m.setDaemonSettings({ ...m.daemonSettings(), autoCompactPercent: pct })
            }
          />

          <div class="rounded-panel border border-border bg-surface overflow-hidden">
            <SettingSwitchRow
              id="settings-auto-title"
              checked={() => !(m.daemonSettings().noAutoTitle ?? false)}
              onChange={(checked) =>
                m.setDaemonSettings({
                  ...m.daemonSettings(),
                  noAutoTitle: !checked,
                })
              }
              title="Auto-generate conversation titles"
              description='The host asks the model for a short title after the first exchange. Off leaves "New conversation".'
            />
          </div>

          <details
            open={Boolean(proxyError()) || undefined}
            class="rounded-panel border border-border bg-surface overflow-hidden group"
          >
            <summary class="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-medium text-fg cursor-pointer select-none hover:bg-surface-subtle/60 transition-colors list-none [&::-webkit-details-marker]:hidden">
              <span class="inline-flex items-center gap-2 min-w-0">
                <Iconify
                  icon="lucide:chevron-right"
                  size={13}
                  class="shrink-0 text-fg-muted transition-transform group-open:rotate-90"
                />
                <span>Advanced network</span>
              </span>
              <span class="flex items-center gap-1.5 shrink-0">
                <Show when={m.daemonSettings().insecureTls}>
                  <Badge tone="warning">Insecure TLS</Badge>
                </Show>
                <Show when={(m.daemonSettings().httpProxy ?? "").trim()}>
                  <Badge tone={proxyError() ? "danger" : "info"}>
                    {proxyError() ? "Invalid proxy" : "Custom proxy"}
                  </Badge>
                </Show>
              </span>
            </summary>

            <div class="border-t border-border-subtle divide-y divide-border-subtle">
              <SettingSwitchRow
                id="settings-insecure-tls"
                checked={() => m.daemonSettings().insecureTls ?? false}
                onChange={(checked) =>
                  m.setDaemonSettings({
                    ...m.daemonSettings(),
                    insecureTls: checked,
                  })
                }
                title={
                  <>
                    <span>Skip TLS verification</span>
                    <Show when={m.daemonSettings().insecureTls}>
                      <Badge tone="warning">Insecure</Badge>
                    </Show>
                  </>
                }
                description="Provider requests accept self-signed certificates. Only the provider client is affected."
              />

              <div class="p-3.5">
                <div class="flex items-center justify-between gap-2 mb-2">
                  <label for="settings-upstream-proxy" class="font-medium text-fg">
                    Upstream proxy
                  </label>
                  <Badge
                    tone={
                      proxyError()
                        ? "danger"
                        : (m.daemonSettings().httpProxy ?? "").trim()
                          ? "info"
                          : "neutral"
                    }
                  >
                    {proxyError()
                      ? "Invalid URL"
                      : (m.daemonSettings().httpProxy ?? "").trim()
                        ? "Explicit proxy"
                        : "Env default"}
                  </Badge>
                </div>
                <div
                  class={`flex items-center gap-2 rounded-control border bg-surface px-3 py-1.5 transition-colors ${
                    proxyError()
                      ? "border-danger focus-within:border-danger"
                      : "border-border-strong focus-within:border-accent"
                  }`}
                >
                  <Iconify icon="lucide:globe" size={14} class="shrink-0 text-fg-muted" />
                  <input
                    id="settings-upstream-proxy"
                    type="text"
                    aria-invalid={proxyError() ? "true" : undefined}
                    value={m.daemonSettings().httpProxy ?? ""}
                    onInput={(e) =>
                      m.setDaemonSettings({
                        ...m.daemonSettings(),
                        httpProxy: e.currentTarget.value,
                      })
                    }
                    placeholder="http://host:port (empty = environment default)"
                    class="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg placeholder:text-fg-muted outline-none"
                    aria-label="Upstream proxy URL"
                  />
                  <Show when={(m.daemonSettings().httpProxy ?? "").length > 0}>
                    <button
                      type="button"
                      onClick={() => m.setDaemonSettings({ ...m.daemonSettings(), httpProxy: "" })}
                      class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                      data-rc-tip="Clear proxy"
                      aria-label="Clear upstream proxy"
                    >
                      <Iconify icon="lucide:x" size={13} />
                    </button>
                  </Show>
                </div>
                <Show
                  when={proxyError()}
                  fallback={
                    <p class="text-2xs text-fg-muted mt-1.5">
                      Explicit proxy for provider requests. Empty keeps HTTP(S)_PROXY environment handling.
                    </p>
                  }
                >
                  <p role="alert" class="text-2xs text-danger mt-1.5">
                    {proxyError()}
                  </p>
                </Show>
              </div>
            </div>
          </details>
        </fieldset>
      </section>
    </div>
  );
}
