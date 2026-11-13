import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import { press } from "../../ds/motion/press";
import {
  ACCENTS,
  Badge,
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
import { normalizeMidTurnSend, type MidTurnDelivery } from "../utils/settingsValidation";

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
      onPointerDown={(e) => {
        const track = e.currentTarget.querySelector<HTMLElement>(".ui-switch-track");
        if (track) press(track);
      }}
      class={`flex min-h-11 items-center justify-between gap-4 px-3.5 py-2.5 cursor-pointer select-none hover:bg-surface-subtle/60 transition-colors ${
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
                ? "Maximum WCAG contrast"
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
                  onPointerDown={(e) => press(e.currentTarget)}
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
          class="flex flex-wrap items-center gap-2 [@media(pointer:coarse)]:gap-3"
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
                  onPointerDown={(e) => press(e.currentTarget)}
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
        <span class="text-2xs text-fg-muted tabular-nums">
          {currentOpt().px} · {currentOpt().caption}
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
                onPointerDown={(e) => press(e.currentTarget)}
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
                onPointerDown={(e) => press(e.currentTarget)}
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
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => props.onChange(0)}
            class={`min-h-6 [@media(pointer:coarse)]:min-h-9 rounded-md px-2.5 py-0.5 text-2xs font-medium transition-colors cursor-pointer ${
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
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => {
              if (isOff()) props.onChange(lastAutoPct());
            }}
            class={`min-h-6 [@media(pointer:coarse)]:min-h-9 rounded-md px-2.5 py-0.5 text-2xs font-medium transition-colors cursor-pointer ${
              !isOff()
                ? "bg-accent text-accent-foreground"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            Auto
          </button>
        </div>
      </div>

      {/* Zone Legend */}
      <div class="flex items-center justify-between gap-2 text-2xs" aria-hidden="true">
        <span class="inline-flex items-center gap-1.5 text-fg-secondary">
          <span
            class={`h-2 w-2 rounded-xs ${
              isOff() ? "bg-fg-muted/40" : "bg-accent"
            }`}
          />
          <span>Conversation history</span>
        </span>
        <span class="inline-flex items-center gap-1.5 text-fg-muted">
          <span>Compaction reserve</span>
          <span
            class={`h-2 w-2 rounded-xs ${
              isOff() ? "bg-border-strong/50" : "bg-warning"
            }`}
          />
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
          aria-valuenow={isOff() ? 50 : activePct()}
          aria-valuetext={
            isOff()
              ? "Manual /compact only (Off)"
              : `${activePct()}% trigger · ${headroomPct()}% headroom`
          }
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onSliderKeyDown}
          class={`relative h-9 w-full rounded-lg border select-none touch-none ${
            isOff()
              ? "border-border bg-surface-subtle cursor-pointer"
              : "border-border-strong bg-surface-subtle cursor-ew-resize"
          }`}
        >
          {/* Clipped inner two-zone fill */}
          <div class="absolute inset-0 rounded-[7px] overflow-hidden flex pointer-events-none">
            <div
              class={`h-full flex items-center pl-2.5 min-w-0 ${
                dragging() ? "transition-none" : "transition-[width] duration-150 ease-out"
              } ${
                isOff()
                  ? "bg-surface-muted/60"
                  : "bg-accent-subtle border-r border-accent"
              }`}
              style={{ width: `${isOff() ? 100 : activePct()}%` }}
            >
              <span class="truncate text-2xs text-fg-secondary tabular-nums">
                {isOff() ? "0% → 100% unreserved" : `0% → ${activePct()}%`}
              </span>
            </div>
            <Show when={!isOff()}>
              <div class="h-full flex-1 bg-warning-subtle flex items-center justify-end pr-2 overflow-hidden">
                <Show when={headroomPct() >= 15}>
                  <span class="text-2xs text-warning tabular-nums">
                    {headroomPct()}%
                  </span>
                </Show>
              </div>
            </Show>
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
                : "transition-[left,transform,opacity] duration-150 ease-out bg-surface-raised"
            } ${
              isOff()
                ? "border-border opacity-45"
                : "border-border-strong"
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
          class="relative h-6 [@media(pointer:coarse)]:h-8 w-full mt-1 select-none"
        >
          <span
            aria-hidden="true"
            class="absolute left-0 top-1.5 text-2xs text-fg-muted/70 tabular-nums leading-none pointer-events-none"
          >
            0%
          </span>
          <For each={COMPACT_RULER_STOPS}>
            {(mark) => {
              const selected = () => !isOff() && activePct() === mark;
              const edgeRight = mark === 95;
              return (
                <button
                  type="button"
                  aria-pressed={selected()}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => commitPct(mark)}
                  style={{ left: `${mark}%` }}
                  class={`absolute top-0 flex min-h-6 [@media(pointer:coarse)]:min-h-9 flex-col items-center gap-0.5 border-0 bg-transparent px-1 py-0 cursor-pointer group rounded-xs ${
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
    </div>
  );
}

export function SettingsGeneralSection() {
  const m = useModal();
  const ui = useUI();
  const hosts = useHost();
  const hostStatus = () => hosts.activeHost?.()?.status;
  const du = ui.daemonUpdate;
  const compactPct = () => m.daemonSettings().autoCompactPercent ?? 80;
  const midTurnSend = () =>
    normalizeMidTurnSend(m.daemonSettings().midTurnSend);

  return (
    <div class="space-y-6">
      {/* 1. Appearance & Layout */}
      <section id="rc-set-appearance" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5">
        <div>
          <h3 class="text-sm font-medium text-fg">Appearance</h3>
          <p class="text-xs text-fg-muted mt-0.5">
            Surface theme, workspace accent, reading column geometry, and stream verbosity.
          </p>
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
              description="Display intermediate thinking steps and tool trace segments."
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
                description="Group short intermediate commentary into tool trace blocks. Messages with 50+ tokens always stay visible."
              />
            </Show>
          </div>
        </div>
      </section>

      {/* 2. Turn Notifications & Push */}
      <section id="rc-set-notifications" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-sm font-medium text-fg">Turn notifications</h3>
            <p class="text-xs text-fg-muted mt-0.5">
              Background alerts across hosts and closed browser tabs.
            </p>
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
                  Browser notification for turns on any host or conversation, even ones you are not watching.
                  <Show when={pushSupported()}>
                    <span> With this on and permission granted, closed tabs still notify via push.</span>
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

          <Show when={ui.turnNotify.notifyOn() && ui.turnNotify.permission() === "denied"}>
            <p class="rounded-panel border border-danger/30 bg-danger-subtle px-3.5 py-2.5 text-2xs text-danger">
              Browser notifications are blocked for this site. Allow them in your browser site settings, then use Test notification below.
            </p>
          </Show>

          <div class="flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => ui.turnNotify.testNotify()}
              class="ui-button ui-button-outline ui-button-sm rounded-lg"
            >
              <Iconify icon="lucide:bell-ring" size={13} class="text-fg-secondary" />
              <span>Test notification</span>
            </button>
            <Show when={ui.pushSub.supported()}>
              <span class="text-2xs text-fg-muted">
                {ui.pushSub.state() === "active"
                  ? "Push active on this device: closed tabs still notify."
                  : ui.pushSub.state() === "blocked"
                    ? "Push blocked: allow notifications in site settings."
                    : ui.pushSub.state() === "off"
                      ? "Push off: turn notifications on to enable."
                      : ui.pushSub.state() === "error"
                        ? "Push setup failed: retry with Test notification."
                        : "Checking push status…"}
              </span>
            </Show>
          </div>
        </div>
      </section>

      {/* 3. Updates */}
      <section id="rc-set-updates" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 class="text-sm font-medium text-fg">Updates</h3>
            <p class="text-xs text-fg-muted mt-0.5">
              Daemon slot binary version and update checks.
            </p>
          </div>
          <Show when={du.info()?.current}>
            <span class="rounded-pill border border-border bg-surface-subtle px-2.5 py-0.5 font-mono text-2xs text-fg-secondary">
              {du.info()?.current}
            </span>
          </Show>
        </div>

        <div class="space-y-3 text-xs">
          <div class="rounded-panel border border-border bg-surface divide-y divide-border-subtle overflow-hidden">
            <SettingSwitchRow
              id="settings-auto-update"
              checked={() => du.info()?.autoUpdate ?? true}
              onChange={(checked) => du.toggle(checked)}
              title="Auto-update daemon"
              description="Preference saved for when automatic updates become available. For now, check on start, reconnect and every 10 minutes; use Update now to apply."
            />

            <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 flex-wrap">
              <div class="flex items-center gap-2 min-w-0 text-fg-secondary">
                <Iconify icon="lucide:package-check" size={14} class="shrink-0 text-fg-muted" />
                <span class="min-w-0 leading-relaxed">
                  {(() => {
                    const i = du.info();
                    if (!i?.current) return "Version unknown (daemon never reported).";
                    if (i.current === "dev") return "Running dev build (self-update disabled).";
                    let s = `Running ${i.current}`;
                    if (i.available && i.available !== i.current) s += ` · ${i.available} available`;
                    else if (i.checkedAt) s += " · up to date";
                    if (hostStatus() === "updating") s += " (updating)";
                    else if ((i as any).mismatchWant) {
                      const left = Math.max(
                        0,
                        1 - Math.floor((Date.now() - ((i as any).mismatchAt || 0)) / 60000),
                      );
                      s += ` (mirror stale: wanted ${(i as any).mismatchWant}, got ${(i as any).mismatchGot || "?"}${left > 0 ? `, retry in ~${left}m` : ""})`;
                    }
                    return s + ".";
                  })()}
                </span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onPointerDown={(e) => press(e.currentTarget)}
                  class="ui-button ui-button-outline ui-button-xs rounded-lg"
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
                    onPointerDown={(e) => press(e.currentTarget)}
                    class="ui-button ui-button-primary ui-button-xs rounded-lg"
                    disabled={du.applying()}
                    onClick={() => {
                      du.apply();
                      m.cancelSettings();
                    }}
                  >
                    {du.applying() ? "Updating…" : "Update now"}
                  </button>
                </Show>
              </div>
            </div>
          </div>

          <Show
            when={(() => {
              const i = du.info();
              return !!i && (i.lifecycle === "failed" || i.lifecycle === "done");
            })()}
          >
            <p class="text-2xs text-fg-muted">
              {(() => {
                const i = du.info();
                if (i?.lifecycle === "failed") {
                  return `Last update ${i.target || ""} failed: ${i.failedReason || i.error || "unknown error"}.`;
                }
                return `Last update finished: now running ${i?.current || ""}.`;
              })()}
            </p>
          </Show>
          <Show when={du.info()?.error}>
            <p class="text-2xs text-danger">{du.info()?.error}</p>
          </Show>
        </div>
      </section>

      {/* 4. Advanced Runtime & Context Compaction */}
      <section id="rc-set-runtime" class="scroll-mt-24 sm:scroll-mt-16 space-y-3.5 pb-3">
        <div>
          <h3 class="text-sm font-medium text-fg">Runtime & messaging</h3>
          <p class="text-xs text-fg-muted mt-0.5">
            Mid-turn message handling, context compaction partition, approval defaults, TLS policy, and upstream proxy.
          </p>
        </div>

        <div class="space-y-3 text-xs">
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

          <div class="rounded-panel border border-border bg-surface divide-y divide-border-subtle overflow-hidden">
            <SettingSwitchRow
              id="settings-jail-default"
              checked={() => m.daemonSettings().jailByDefault ?? false}
              onChange={(checked) =>
                m.setDaemonSettings({
                  ...m.daemonSettings(),
                  jailByDefault: checked,
                })
              }
              title="Jail new conversations"
              description="Start every session jailed: file writes and shell commands need approval first."
            />

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
                    <Badge tone="amber">Insecure</Badge>
                  </Show>
                </>
              }
              description="Provider requests accept self-signed certificates. Only the provider client is affected."
            />

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

          <div class="rounded-panel border border-border bg-surface p-3.5">
            <div class="flex items-center justify-between gap-2 mb-2">
              <label for="settings-upstream-proxy" class="font-medium text-fg">
                Upstream proxy
              </label>
              <Badge tone={(m.daemonSettings().httpProxy ?? "").trim() ? "blue" : "zinc"}>
                {(m.daemonSettings().httpProxy ?? "").trim() ? "Explicit proxy" : "Env default"}
              </Badge>
            </div>
            <div class="flex min-h-9 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 py-1 focus-within:border-accent transition-colors">
              <Iconify icon="lucide:globe" size={14} class="shrink-0 text-fg-muted" />
              <input
                id="settings-upstream-proxy"
                type="text"
                value={m.daemonSettings().httpProxy ?? ""}
                onInput={(e) =>
                  m.setDaemonSettings({
                    ...m.daemonSettings(),
                    httpProxy: e.currentTarget.value,
                  })
                }
                placeholder="http://host:port (empty = environment default)"
                class="min-w-0 flex-1 bg-transparent font-mono max-sm:text-base sm:text-xs text-fg placeholder:text-fg-muted outline-none"
                aria-label="Upstream proxy URL"
              />
              <Show when={(m.daemonSettings().httpProxy ?? "").length > 0}>
                <button
                  type="button"
                  onClick={() => m.setDaemonSettings({ ...m.daemonSettings(), httpProxy: "" })}
                  class="ui-icon-button ui-icon-button-xs shrink-0 rounded-lg"
                  data-rc-tip="Clear proxy"
                  aria-label="Clear upstream proxy"
                >
                  <Iconify icon="lucide:x" size={13} />
                </button>
              </Show>
            </div>
            <p class="text-2xs text-fg-muted mt-1.5">
              Explicit proxy for provider requests. Empty keeps HTTP(S)_PROXY environment handling.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
