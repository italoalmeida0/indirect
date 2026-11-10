import {
  createSignal,
  createUniqueId,
  createEffect,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";

import { anchorFloat } from "./floating";
import { usal } from "./motion";
import { Button, type ButtonSize, type ButtonVariant } from "./ds/components/button";
import {
  Alert,
  Badge as DsBadge,
  Checkbox,
  EmptyState as DsEmptyState,
  Kbd,
  Progress,
  Shimmer,
  Skeleton,
  Spinner as DsSpinner,
  Switch,
  type BadgeTone,
  type LegacyTone,
} from "./ds/components/controls";
import { Dialog } from "./ds/components/dialog";
import { Calendar, RangeCalendar, RollingText } from "./ds/components/calendar";
import { DatePicker, DateTimePicker, TimePicker } from "./ds/components/date-picker";
import {
  CheckTile,
  CurrencyField,
  OtpPinField,
  RoleCardGroup,
  SecretField,
  StepperField,
  TokenTagField,
} from "./ds/components/studio-controls";
import { Glyph } from "./ds/components/icon";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ds/components/menu";
import { Collapse, ConfirmButton, Drawer } from "./ds/components/overlay";
import { RollingNumber } from "./ds/components/rolling-number";
import { SegmentedControl } from "./ds/components/segmented";
import { CopyButton, TabPanel, Tabs } from "./ds/components/tabs";
import { pushToast, ToastRegion } from "./ds/components/toast";
import { Tooltip as DsTooltip } from "./ds/components/tooltip";
import { createGlide } from "./ds/motion/glide";
import { createPresence, cssExit } from "./ds/motion/presence";
import { reducedMotion } from "./ds/motion/reduced";
import { press } from "./ds/motion/press";
import { pushLayer } from "./ds/primitives/layers";

export {
  Alert,
  Calendar,
  Checkbox,
  CheckTile,
  CurrencyField,
  OtpPinField,
  RoleCardGroup,
  SecretField,
  StepperField,
  TokenTagField,
  Collapse,
  ConfirmButton,
  CopyButton,
  DatePicker,
  DateTimePicker,
  Drawer,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Progress,
  RangeCalendar,
  RollingNumber,
  RollingText,
  Shimmer,
  Skeleton,
  Switch,
  TabPanel,
  Tabs,
  TimePicker,
};

/**
 * Gateway UI kit. Every component here is a thin, API-stable adapter over
 * the design system in `web/src/ds` (tokens, motion engine, components), so
 * screens written against this module get the new look and motion without
 * call-site changes. New code may import from `ds/` directly.
 */

import { registry } from "virtual:icons";

// ==========================================
// ICON SYSTEM (Iconify Lucide, bundled at build time)
// ==========================================

// Semantic names -> Iconify Lucide identifiers
export const Icons = {
  key: "lucide:key",
  chart: "lucide:bar-chart-2",
  users: "lucide:users",
  cog: "lucide:settings",
  logout: "lucide:log-out",
  plus: "lucide:plus",
  copy: "lucide:copy",
  check: "lucide:check",
  trash: "lucide:trash-2",
  shield: "lucide:shield",
  clock: "lucide:clock",
  x: "lucide:x",
  server: "lucide:server",
  refresh: "lucide:refresh-cw",
  eye: "lucide:eye",
  bolt: "lucide:zap",
  ban: "lucide:ban",
  book: "lucide:book-open",
  gauge: "lucide:layout-dashboard",
  warning: "lucide:alert-triangle",
  search: "lucide:search",
  edit: "lucide:edit-3",
  home: "lucide:home",
  idc: "lucide:folder-code",
  sun: "lucide:sun",
  moon: "lucide:moon",
  monitor: "lucide:monitor",
  chevronDown: "lucide:chevron-down",
  arrowUpRight: "lucide:arrow-up-right",
  menu: "lucide:menu",
  grip: "lucide:grip-vertical",
  layers: "lucide:layers",
  terminal: "lucide:terminal",
  folder: "lucide:folder",
  play: "lucide:play",
  stop: "lucide:square",
  send: "lucide:send",
  file: "lucide:file-text",
  chevronRight: "lucide:chevron-right",
  split: "lucide:git-branch",
  git: "lucide:git-branch",
  sparkles: "lucide:sparkles",
  save: "lucide:save",
  dollarSign: "lucide:dollar-sign",
  code: "lucide:code",
  alertCircle: "lucide:alert-circle",
} as const;

export function Icon(props: {
  name: string;
  size?: number;
  class?: string;
  strokeWidth?: number;
}) {
  const known = () => registry[props.name] ?? registry[`lucide:${props.name}`];
  return (
    <span class={`inline-flex items-center justify-center shrink-0 ${props.class ?? ""}`}>
      <Show when={known()} fallback={<svg width={props.size ?? 16} height={props.size ?? 16} aria-hidden="true" />}>
        <Glyph icon={props.name.includes(":") ? props.name : `lucide:${props.name}`} size={props.size ?? 16} strokeWidth={props.strokeWidth} />
      </Show>
    </span>
  );
}

// ==========================================
// THEME (light / dark / high contrast + system follow) and ACCENT
// ==========================================

export type Theme = "light" | "dark" | "high-contrast";
/** User-facing choice: an explicit theme, or follow the OS (`system`).
 *  Stored in localStorage under THEME_KEY; missing/unknown also means
 *  `system` (fresh installs follow the OS by default). */
export type ThemeMode = "light" | "dark" | "high-contrast" | "system";
const THEME_KEY = "llmgw-theme";

/** Theme-color meta values (page chrome / PWA task switcher), kept in sync
 *  with the effective theme. Values mirror each theme's page background. */
const THEME_COLORS: Record<Theme, string> = { light: "#ffffff", dark: "#141414", "high-contrast": "#000000" };

export function getThemeMode(): ThemeMode {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {}
  return stored === "light" || stored === "dark" || stored === "high-contrast" ? stored : "system";
}

export function getTheme(): Theme {
  if (document.documentElement.dataset.theme === "high-contrast") return "high-contrast";
  if (document.documentElement.dataset.theme === "dark") return "dark";
  if (document.documentElement.dataset.theme === "light") return "light";
  // Unset (pre-init): resolve like the inline init script in index.html.
  try {
    const s = localStorage.getItem(THEME_KEY);
    if (s === "high-contrast") return "high-contrast";
    if (s === "dark") return "dark";
    if (s === "light") return "light";
  } catch {}
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const [theme, setThemeSignal] = createSignal<Theme>(getTheme());
export { theme };
const [themeMode, setThemeModeSignal] = createSignal<ThemeMode>(getThemeMode());
export { themeMode };

/** Keep `<meta name="theme-color">` on the effective theme. */
export function syncMetaThemeColor(): void {
  try {
    const t = getTheme();
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", THEME_COLORS[t]);
  } catch {}
}

/** Where a theme change reveal grows from (the toggle that asked for it). */
export interface RevealOrigin {
  x: number;
  y: number;
}

function commitTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  setThemeSignal(t);
  syncMetaThemeColor();
}

/**
 * Apply a theme. With an origin and View Transitions support, the new
 * appearance crosses the page as a circle growing from the toggle (an
 * eclipse); otherwise colors crossfade briefly. Reduced motion swaps at once.
 */
function applyTheme(t: Theme, origin?: RevealOrigin): void {
  const html = document.documentElement;
  if (html.dataset.theme === t) {
    setThemeSignal(t);
    return;
  }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (origin && doc.startViewTransition && !reducedMotion()) {
    const transition = doc.startViewTransition(() => commitTheme(t));
    const radius = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y));
    void transition.ready.then(() => {
      html.animate(
        { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
        { duration: 560, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    }).catch(() => {});
    return;
  }
  if (!reducedMotion()) html.classList.add("theme-xfade");
  commitTheme(t);
  window.setTimeout(() => html.classList.remove("theme-xfade"), 380);
}

export function setThemeMode(m: ThemeMode, origin?: RevealOrigin): void {
  try {
    if (m === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, m);
  } catch {}
  setThemeModeSignal(m);
  if (m === "system") {
    const t: Theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    applyTheme(t, origin);
  } else {
    applyTheme(m, origin);
  }
}

export function toggleTheme(origin?: RevealOrigin): void {
  setThemeMode(getTheme() === "dark" ? "light" : "dark", origin);
}

/** Follow the OS while the user has no explicit choice (mode `system`). */
export function watchSystemTheme(): void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const mode = getThemeMode();
    setThemeModeSignal(mode);
    if (mode !== "system") {
      // An explicit choice (including high contrast) wins on every load.
      if (document.documentElement.dataset.theme !== mode) commitTheme(mode);
      return;
    }
    commitTheme(mq.matches ? "dark" : "light");
  };
  apply();
  try {
    window.addEventListener?.("storage", (e) => {
      // Cross-tab theme/accent sync (e.g. changed in another tab/settings).
      if (e.key === THEME_KEY) apply();
      if (e.key === ACCENT_KEY) applyAccent(getAccent());
    });
  } catch {}
  mq.addEventListener?.("change", apply);
  applyAccent(getAccent());
}

/** Accent hue. Teal is the product default; the rest follow Arc's set. */
export type Accent = "teal" | "neutral" | "violet" | "blue" | "green" | "amber" | "orange" | "coral" | "rose";
export type AccentName = Accent;
export const ACCENTS: Array<{ id: AccentName; label: string; swatch: string }> = [
  { id: "teal", label: "Teal", swatch: "oklch(0.60 0.125 182)" },
  { id: "neutral", label: "Neutral", swatch: "oklch(0.45 0.008 250)" },
  { id: "violet", label: "Violet", swatch: "oklch(0.58 0.16 285)" },
  { id: "blue", label: "Blue", swatch: "oklch(0.58 0.14 252)" },
  { id: "green", label: "Green", swatch: "oklch(0.60 0.14 152)" },
  { id: "amber", label: "Amber", swatch: "oklch(0.72 0.15 72)" },
  { id: "orange", label: "Orange", swatch: "oklch(0.66 0.16 48)" },
  { id: "coral", label: "Coral", swatch: "oklch(0.64 0.16 28)" },
  { id: "rose", label: "Rose", swatch: "oklch(0.62 0.16 355)" },
];
const ACCENT_IDS = new Set<Accent>(ACCENTS.map((a) => a.id));
const ACCENT_KEY = "llmgw-accent";

export function getAccent(): Accent {
  try {
    const stored = localStorage.getItem(ACCENT_KEY) as Accent | null;
    if (stored && ACCENT_IDS.has(stored)) return stored;
  } catch {}
  return "teal";
}

const [accent, setAccentSignal] = createSignal<Accent>(getAccent());
export { accent };

function applyAccent(a: Accent): void {
  if (a === "teal") delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = a;
  setAccentSignal(a);
}

export function setAccent(a: Accent): void {
  try {
    if (a === "teal") localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, a);
  } catch {}
  if (!reducedMotion()) document.documentElement.classList.add("theme-xfade");
  applyAccent(a);
  window.setTimeout(() => document.documentElement.classList.remove("theme-xfade"), 380);
}

export function ThemeToggle(props: {
  class?: string;
  tooltipPlacement?: Placement;
}) {
  const label = () => {
    if (themeMode() === "system") return "Theme follows the system. Switch to manual";
    return theme() === "dark" ? "Switch to light theme" : "Switch to dark theme";
  };
  return (
    <DsTooltip content={label()} placement={props.tooltipPlacement ?? "bottom"}>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }}
        aria-label="Toggle theme"
        ref={press}
        class={`ui-icon-button ${props.class ?? ""}`}
      >
        <span
          class="flex items-center justify-center transition-transform duration-500 ease-spring"
          style={{ transform: theme() === "dark" ? "rotate(0deg)" : "rotate(180deg)" }}
        >
          <Glyph icon={theme() === "dark" ? Icons.sun : themeMode() === "system" ? Icons.monitor : Icons.moon} size={18} />
        </span>
      </button>
    </DsTooltip>
  );
}

// ==========================================
// COMPONENTS
// ==========================================

const BTN_VARIANT: Record<string, ButtonVariant> = {
  primary: "primary",
  brand: "primary",
  ghost: "ghost",
  danger: "danger",
  outline: "secondary",
  secondary: "secondary",
  subtle: "secondary",
};

export function Btn(props: {
  variant?: "primary" | "brand" | "ghost" | "danger" | "outline" | "secondary" | "subtle";
  size?: "xs" | "sm" | "md" | "lg";
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit";
  class?: string;
  title?: string;
  children: JSX.Element;
}) {
  // Legacy sizes: the default control is the compact 36px one; `sm` or `xs` is the
  // dense 28px row action; `lg` is the full 44px form action.
  const size = (): ButtonSize => (props.size === "sm" || props.size === "xs" ? "xs" : props.size === "lg" ? "md" : "sm");
  const btn = (
    <Button
      variant={BTN_VARIANT[props.variant ?? "primary"]}
      size={size()}
      type={props.type ?? "button"}
      class={props.class}
      onClick={props.onClick}
      disabled={props.disabled}
      loading={props.loading}
    >
      {props.children}
    </Button>
  );
  // title floats as a themed Tooltip (never two competing labels).
  return (
    <Show when={props.title} fallback={btn}>
      {(title) => <DsTooltip content={title()}>{btn}</DsTooltip>}
    </Show>
  );
}

export function Card(props: {
  class?: string;
  interactive?: boolean;
  /** Optional entrance tokens ("fade-u delay-100"): one entrance on mount. */
  motion?: string;
  children: JSX.Element;
}) {
  return (
    <div
      ref={(node) => { if (props.motion) usal(props.motion).ref(node); }}
      class={`ui-card ${props.interactive ? "ui-card-interactive" : ""} ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

export function CardHeader(props: {
  title: string;
  subtitle?: string;
  right?: JSX.Element;
}) {
  return (
    <div class="ui-card-header">
      <div class="min-w-0">
        <h2 class="ui-card-title">{props.title}</h2>
        <Show when={props.subtitle}>
          <p class="ui-card-subtitle">{props.subtitle}</p>
        </Show>
      </div>
      {props.right}
    </div>
  );
}

/** A plain icon beside a stat (design rule: no icons in rounded tiles). */
export function IconTile(props: { icon: string; class?: string }) {
  return (
    <span class={`inline-flex items-center justify-center shrink-0 text-fg-muted ${props.class ?? ""}`}>
      <Glyph icon={props.icon} size={20} />
    </span>
  );
}

/** Icon-only row/list action. The label is a Tooltip + aria-label (no native
 *  title, so grids/modals never clip it); `danger` turns red on hover. */
export function IconBtn(props: {
  icon: string;
  title?: string;
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const tip = () => props.title ?? props.label ?? "";
  return (
    <DsTooltip content={tip()}>
      <button
        type="button"
        aria-label={tip()}
        disabled={props.disabled}
        onClick={() => props.onClick?.()}
        ref={press}
        class={`ui-icon-button ${props.danger ? "ui-icon-button-danger" : ""}`}
      >
        <Glyph icon={props.icon} size={16} />
      </button>
    </DsTooltip>
  );
}

/** Percent change vs the previous period. Status color plus an arrow, never
 *  color alone. */
export function DeltaPill(props: { pct: number; class?: string }) {
  const up = () => props.pct >= 0;
  return (
    <DsBadge tone={up() ? "success" : "danger"} size="sm" class={props.class}>
      <Glyph icon={up() ? "lucide:arrow-up-right" : "lucide:arrow-down-right"} size={12} />
      {`${Math.abs(Math.round(props.pct))}%`}
    </DsBadge>
  );
}

/** Segmented control with a gliding raised highlight. */
export function Segmented<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; badge?: number | string }>;
  class?: string;
  label?: string;
  ariaLabel?: string;
}) {
  return <SegmentedControl value={props.value} onChange={props.onChange} options={props.options} class={props.class} label={props.label ?? props.ariaLabel} />;
}

/**
 * Split an integer into an animatable numeric part + static unit suffix.
 * Thresholds/decimals mirror fmtNum so animated headers agree with the
 * static stats rendered next to them (950, 12.5K, 123M, 12.3B, 5.23T,
 * capped at 999T).
 */
export function compactParts(n: number): { count: string; suffix: string } {
  if (!Number.isFinite(n)) return { count: "—", suffix: "" };
  const neg = n < 0;
  const v = Math.round(Math.abs(n));
  if (v < 1000) return { count: neg ? String(-v) : String(v), suffix: "" };
  const scaled = (limit: number, div: number, suffix: string): { count: string; suffix: string } => {
    let s = v / div;
    if (suffix === "T" && s >= 1000) s = 999;
    const digits = s >= 100 ? 0 : s >= 10 ? 1 : 2;
    return { count: (neg ? "-" : "") + s.toFixed(digits), suffix };
  };
  if (v >= 1_000_000_000_000) return scaled(v, 1_000_000_000_000, "T");
  if (v >= 1_000_000_000) return scaled(v, 1_000_000_000, "B");
  if (v >= 1_000_000) return scaled(v, 1_000_000, "M");
  return scaled(v, 1_000, "K");
}

/**
 * Animated number (compact: 950, 12.5K, 1.14M). Digits roll to the new
 * value on a spring; tabular digits keep the width stable; reduced motion
 * shows the value directly.
 */
export function CountUp(props: { value: number; class?: string }) {
  const parts = () => compactParts(Math.round(Math.max(0, props.value)));
  return (
    <span class={`tabular-nums inline-flex items-baseline ${props.class ?? ""}`}>
      <RollingNumber value={parts().count} />
      <Show when={parts().suffix}>
        {(suffix) => <span class="text-[0.85em] font-medium ml-0.5">{suffix()}</span>}
      </Show>
    </span>
  );
}

export function Input(props: {
  label?: string;
  type?: string;
  value: string | number;
  onInput: (v: string) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number | string;
  autocomplete?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  const [revealed, setRevealed] = createSignal(false);
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  const describedBy = () => (props.hint || props.error ? hintId : undefined);
  return (
    <div class="block">
      <Show when={props.label}>
        <label for={inputId} class="ui-label">{props.label}</label>
      </Show>
      <div class={props.type === "password" ? "ui-field-adorned" : undefined}>
        <input
          id={inputId}
          aria-describedby={describedBy()}
          aria-invalid={props.error ? "true" : undefined}
          type={props.type === "password" && revealed() ? "text" : props.type ?? "text"}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          placeholder={props.placeholder}
          min={props.min}
          max={props.max}
          step={props.step}
          autocomplete={props.autocomplete}
          required={props.required}
          disabled={props.disabled}
          class="ui-field"
        />
        <Show when={props.type === "password"}>
          <span class="ui-field-adornment">
            <button
              type="button"
              aria-label={revealed() ? "Hide password" : "Show password"}
              aria-pressed={revealed()}
              disabled={props.disabled}
              onClick={() => setRevealed(!revealed())}
              class="ui-icon-button"
            >
              <Glyph icon={revealed() ? "lucide:eye-off" : Icons.eye} size={16} />
            </button>
          </span>
        </Show>
      </div>
      <Show when={props.error} fallback={<Show when={props.hint}><span id={hintId} class="ui-hint">{props.hint}</span></Show>}>
        <span id={hintId} class="ui-error-text">{props.error}</span>
      </Show>
    </div>
  );
}

export function Textarea(props: {
  label?: string;
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  const describedBy = () => (props.hint || props.error ? hintId : undefined);
  return (
    <div class="block">
      <Show when={props.label}>
        <label for={inputId} class="ui-label">{props.label}</label>
      </Show>
      <textarea
        id={inputId}
        rows={props.rows ?? 3}
        aria-describedby={describedBy()}
        aria-invalid={props.error ? "true" : undefined}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        placeholder={props.placeholder}
        disabled={props.disabled}
        class="ui-field py-2 min-h-[4.5rem]"
      />
      <Show when={props.error} fallback={<Show when={props.hint}><span id={hintId} class="ui-hint">{props.hint}</span></Show>}>
        <span id={hintId} class="ui-error-text">{props.error}</span>
      </Show>
    </div>
  );
}

/**
 * Custom dropdown select — no native <select> popup. Keyboard: ↑/↓ move,
 * Enter/Space pick, Home/End jump, typing finds an option, Esc restores focus.
 * A portaled listbox chooses its opening side once and stays anchored while
 * scrolling or resizing, including inside a Modal. Listeners exist only while
 * open; keyboard navigation scrolls the menu without moving the page.
 * Motion: the list grows from the trigger, rows rise in with a short
 * stagger, one highlight glides between rows, and closing is faster.
 */
export function Select(props: {
  label?: string;
  ariaLabel?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; hint?: string }>;
  hint?: string;
  variant?: "toolbar";
  icon?: string;
  triggerLabel?: string;
  menuTitle?: string;
  searchable?: boolean;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);
  const [listEl, setListEl] = createSignal<HTMLDivElement>();
  const [indicator, setIndicator] = createSignal<HTMLSpanElement>();
  let root!: HTMLDivElement;
  let button!: HTMLButtonElement;
  let typeahead = "";
  let typeTimer: ReturnType<typeof setTimeout> | undefined;
  const presence = createPresence(open, { exit: (el) => cssExit(el, 130) });
  const current = () => props.options.find((option) => option.value === props.value) ?? { value: props.value, label: props.value || "Select…" };
  createGlide({
    container: listEl,
    indicator,
    target: () => {
      const index = highlight();
      return listEl()?.querySelector<HTMLElement>(`[data-option-index="${index}"]`) ?? null;
    },
  });
  const close = (restoreFocus = false) => {
    setOpen(false);
    typeahead = "";
    clearTimeout(typeTimer);
    if (restoreFocus) button.focus({ preventScroll: true });
  };
  const openMenu = () => {
    setHighlight(Math.max(0, props.options.findIndex((option) => option.value === props.value)));
    setOpen(true);
  };
  const pick = (value: string) => {
    close(true);
    props.onChange(value);
  };
  createEffect(() => {
    if (!open()) return;
    const offLayer = pushLayer({
      kind: "menu",
      contains: (node) => root.contains(node) || !!listEl()?.contains(node),
      onEscape: () => close(true),
      onOutside: () => close(),
    });
    const outside = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target) && !listEl()?.contains(event.target)) close();
    };
    document.addEventListener("focusin", outside);
    onCleanup(() => {
      offLayer();
      document.removeEventListener("focusin", outside);
    });
  });
  onCleanup(() => clearTimeout(typeTimer));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (!open() && ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      openMenu();
      if (event.key === "Home") setHighlight(0);
      if (event.key === "End") setHighlight(props.options.length - 1);
      return;
    }
    if (open() && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const length = props.options.length;
      setHighlight((index) => event.key === "Home" ? 0 : event.key === "End" ? length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + length) % Math.max(1, length));
    } else if (open() && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const option = props.options[highlight()];
      if (option) pick(option.value);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!open()) openMenu();
      clearTimeout(typeTimer);
      typeahead += event.key.toLocaleLowerCase();
      const query = [...typeahead].every((char) => char === typeahead[0]) ? typeahead[0]! : typeahead;
      const start = query.length === 1 ? highlight() + 1 : highlight();
      for (let offset = 0; offset < props.options.length; offset++) {
        const index = (start + offset) % props.options.length;
        if (props.options[index]!.label.toLocaleLowerCase().startsWith(query)) {
          setHighlight(index);
          break;
        }
      }
      typeTimer = setTimeout(() => { typeahead = ""; }, 650);
    }
  };
  createEffect(() => {
    if (!open()) return;
    const index = highlight();
    queueMicrotask(() => {
      const list = listEl();
      const option = list?.querySelector<HTMLElement>(`[data-option-index="${index}"]`);
      if (!list?.isConnected || !option) return;
      const top = option.offsetTop, bottom = top + option.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    });
  });
  return <div class={`ui-select ${props.variant === "toolbar" ? "ui-select-toolbar" : "block"}`}>
    <Show when={props.label}><span id={`${id}-label`} class="ui-label">{props.label}</span></Show>
    <div ref={root} class="relative" onKeyDown={onKeyDown}>
      <button ref={button} type="button" role="combobox" aria-label={props.ariaLabel} aria-labelledby={!props.ariaLabel && props.label ? `${id}-label` : undefined}
        aria-haspopup="listbox" aria-expanded={open()} aria-controls={open() ? `${id}-list` : undefined} aria-activedescendant={open() ? `${id}-option-${highlight()}` : undefined} aria-describedby={`${id}-value${props.hint ? ` ${id}-hint` : ""}`}
        title={current().label} onClick={() => open() ? close() : openMenu()}
        class={props.variant === "toolbar" ? `analytics-control ui-select-trigger ${open() || props.value ? "is-active" : ""}` : "ui-field text-left flex items-center justify-between gap-2 cursor-pointer"}>
        <Show when={props.icon}><Glyph icon={props.icon!} size={15} /></Show>
        <span class="min-w-0 truncate">{props.triggerLabel ?? current().label}</span>
        <Glyph icon={Icons.chevronDown} size={14} class={`ui-select-chevron ${open() ? "is-open" : ""}`} />
      </button>
      <span id={`${id}-value`} class="sr-only">{current().label}</span>
      <Show when={presence.present()}><Portal><div id={`${id}-list`} data-glide="" ref={(element) => {
        setListEl(element);
        presence.ref(element);
        const anchor = button.getBoundingClientRect();
        const maxHeight = props.variant === "toolbar" ? 400 : 320;
        const expectedHeight = Math.min(maxHeight, props.options.length * (window.matchMedia("(pointer: coarse)").matches ? 44 : 36) + (props.menuTitle ? 44 : 10));
        const below = document.documentElement.clientHeight - anchor.bottom;
        onCleanup(anchorFloat(button, element, {
          placement: below >= expectedHeight + 16 || below >= anchor.top ? "bottom-start" : "top-start",
          flip: false,
          gap: 6,
          padding: 12,
          matchWidth: props.variant !== "toolbar",
          maxHeight,
        }));
        onCleanup(() => setListEl(undefined));
      }} role="listbox" aria-label={props.ariaLabel ?? props.label ?? "Options"} onKeyDown={onKeyDown}
        class={`ui-popover ui-menu ui-select-menu ${props.variant === "toolbar" ? "ui-select-toolbar-menu" : ""}`}>
        <span ref={setIndicator} class="ui-menu-highlight" aria-hidden="true" />
        <Show when={props.menuTitle}><div class="ui-select-menu-title" role="presentation">{props.menuTitle}</div></Show>
        <For each={props.options}>{(option, index) => <button id={`${id}-option-${index()}`} type="button" role="option" tabIndex={-1} aria-selected={option.value === props.value} data-option-index={index()} data-hl={index() === highlight() ? "1" : "0"}
          style={{ "--i": index() }}
          onClick={() => pick(option.value)} onPointerEnter={() => setHighlight(index())}
          onPointerDown={(event) => { if (event.pointerType === "mouse") event.preventDefault(); }}
          class={`ui-select-option ${option.value === props.value ? "is-selected" : ""}`}>
          <span class="min-w-0 truncate">{option.label}</span><Show when={option.value === props.value}><Glyph icon={Icons.check} size={14} class="ui-select-check" /></Show>
        </button>}</For>
      </div></Portal></Show>
    </div>
    <Show when={props.hint}><span id={`${id}-hint`} class="ui-hint">{props.hint}</span></Show>
  </div>;
}

/**
 * Floating tooltip: hover (precise pointers) or keyboard focus shows it;
 * flip + shift keep it inside the viewport; portaled above the modal layer.
 * Replaces native `title`: themed, never clipped, instant within a group.
 */
export function Tooltip(props: {
  content: JSX.Element;
  placement?: Placement;
  /** Hover-intent delay in ms. */
  delay?: number;
  disabled?: boolean;
  children: JSX.Element;
}) {
  // Handled by DsTooltip (if (props.disabled) return; inside the open guard).
  return (
    <DsTooltip content={props.content} placement={props.placement} delay={props.delay} disabled={props.disabled}>
      {props.children}
    </DsTooltip>
  );
}

export function Badge(props: {
  tone: BadgeTone | LegacyTone;
  children: JSX.Element;
}) {
  return <DsBadge tone={props.tone}>{props.children}</DsBadge>;
}

export function ModalSection(props: {
  title?: string;
  subtitle?: string;
  info?: string;
  badge?: JSX.Element;
  action?: JSX.Element;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={`space-y-3 ${props.class ?? ""}`}>
      <Show when={props.title || props.action}>
        <div class="flex items-start sm:items-center justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="text-sm font-medium text-fg">
                {props.title}
              </h4>
              <Show when={props.info}>
                <DsTooltip content={props.info}>
                  <span role="button" tabindex="0" aria-label={props.info} class="inline-flex text-fg-muted hover:text-fg cursor-help transition-colors">
                    <Glyph icon="lucide:info" size={14} />
                  </span>
                </DsTooltip>
              </Show>
              {props.badge}
            </div>
            <Show when={props.subtitle}>
              <p class="text-sm text-fg-secondary mt-0.5">
                {props.subtitle}
              </p>
            </Show>
          </div>
          <Show when={props.action}>
            <div class="shrink-0">{props.action}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </div>
  );
}

export function OrDivider(props: { text?: string; class?: string }) {
  return (
    <div class={`ui-divider my-3 ${props.class ?? ""}`}>
      {props.text ?? "Or"}
    </div>
  );
}

export function ModalField(props: {
  label?: string;
  hint?: string;
  children: JSX.Element;
  class?: string;
}) {
  const fieldId = createUniqueId();
  let root: HTMLDivElement | undefined;
  createEffect(() => {
    if (!props.label || !root) return;
    const control = root.querySelector<HTMLElement>("input, textarea, select");
    if (control && !control.id && !control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby")) {
      control.id = fieldId;
    }
  });
  return (
    <div ref={root} class={props.class ?? ""}>
      <Show when={props.label}>
        <label for={fieldId} class="ui-label">{props.label}</label>
      </Show>
      {props.children}
      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

export function SwitchCard(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  label?: string;
  description?: string;
  badge?: JSX.Element;
  disabled?: boolean;
  class?: string;
}) {
  const heading = () => props.title ?? props.label ?? "";
  return (
    <label
      class={`ui-switch-card select-none ${
        props.disabled ? "opacity-50 pointer-events-none" : ""
      } ${props.class ?? ""}`}
    >
      <span class="relative shrink-0 pt-px">
        <input
          type="checkbox"
          role="switch"
          class="peer sr-only"
          aria-label={heading()}
          checked={props.checked}
          aria-checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <span class="ui-switch-track" aria-hidden="true"><span class="ui-switch-thumb" /></span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-medium text-fg">
            {heading()}
          </span>
          {props.badge}
        </span>
        <Show when={props.description}>
          <span class="block text-sm text-fg-secondary mt-0.5">
            {props.description}
          </span>
        </Show>
      </span>
    </label>
  );
}

export function FilterChip(props: {
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  children: JSX.Element;
  disabled?: boolean;
  badge?: JSX.Element;
  class?: string;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => props.onClick?.()}
      aria-pressed={!!props.selected}
      ref={press}
      class={`inline-flex min-h-8 items-center gap-1.5 px-3 rounded-pill text-sm font-medium transition-colors cursor-pointer select-none border ${
        props.selected
          ? "bg-accent-subtle text-accent-strong border-transparent"
          : "bg-surface text-fg-secondary border-border hover:border-border-strong hover:text-fg"
      } ${props.disabled ? "opacity-40 cursor-not-allowed" : ""} ${props.class ?? ""}`}
    >
      <span>{props.children}</span>
      {props.badge}
      <Show when={props.selected && props.onRemove}>
        <span
          role="button"
          aria-label="Remove filter"
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
          class="hover:opacity-75 p-0.5 rounded transition-opacity"
        >
          <Glyph icon={Icons.x} size={12} />
        </span>
      </Show>
    </button>
  );
}

export function ModalNotice(props: {
  tone?: "info" | "warn" | "danger" | "success";
  title?: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <Alert tone={props.tone ?? "info"} title={props.title} class={props.class}>
      {props.children}
    </Alert>
  );
}

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  subtitle?: string;
  badge?: JSX.Element;
  width?: string;
  fullOnMobile?: boolean;
  footer?: JSX.Element;
  children: JSX.Element;
  bodyRef?: (el: HTMLDivElement | undefined) => void;
}) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      subtitle={props.subtitle}
      badge={props.badge}
      width={props.width}
      fullOnMobile={props.fullOnMobile}
      footer={props.footer}
      bodyRef={props.bodyRef}
    >
      {props.children}
    </Dialog>
  );
}

// ===== Toasts =====

/** Capitalize the first letter for display (leaves the rest untouched). */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Background result notification (foreground actions confirm in place). */
function toastFn(text: string, kind: "ok" | "err" = "ok"): void {
  pushToast(capitalize(text), kind);
}
toastFn.success = (text: string) => toastFn(text, "ok");
toastFn.error = (text: string) => toastFn(text, "err");
export const toast = toastFn;

export function Toasts() {
  return <ToastRegion />;
}

export function Spinner(props: { class?: string }) {
  return <DsSpinner class={props.class ?? "w-4 h-4"} />;
}

export function EmptyState(props: {
  icon: string;
  title: string;
  hint?: string;
  description?: string;
}) {
  return <DsEmptyState icon={props.icon} title={props.title} hint={props.hint ?? props.description} />;
}

export function ProgressBar(props: {
  value: number;
  max: number;
  danger?: boolean;
}) {
  const pct = () => (props.max > 0 ? (props.value / props.max) * 100 : 0);
  return <Progress value={props.value} max={props.max} tone={props.danger && pct() > 85 ? "danger" : "default"} />;
}

// ===== Formatting helpers =====

/**
 * Compact token/number formatter: at most 4 significant chars + one
 * K/M/B/T suffix (e.g. 12.3B, 123M, 5.23T, 125K — never "125.K",
 * never a trailing "."). Anything at/above 1000T is capped at "999T".
 * Plain integers below 1000 render as-is; null/undefined renders "—".
 */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  const v = Math.round(Math.abs(n));
  if (v < 1000) return neg ? String(-v) : String(v);
  const UNITS: Array<{ limit: number; div: number; suffix: string }> = [
    { limit: 1_000_000_000_000, div: 1_000_000_000_000, suffix: "T" },
    { limit: 1_000_000_000, div: 1_000_000_000, suffix: "B" },
    { limit: 1_000_000, div: 1_000_000, suffix: "M" },
    { limit: 1_000, div: 1_000, suffix: "K" },
  ];
  for (const u of UNITS) {
    if (v >= u.limit) {
      let scaled = v / u.div;
      if (u.suffix === "T" && scaled >= 1000) scaled = 999;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      const out = `${scaled.toFixed(digits)}${u.suffix}`;
      return neg ? `-${out}` : out;
    }
  }
  return neg ? String(-v) : String(v);
}

/** Formatter for monetary amounts / spending in USD. Compacts at >= $100K ($836K, $1.25M, $1.50B)
 *  unless { compact: false } is explicitly requested. */
export function fmtCost(val: number | null | undefined, opts?: { compact?: boolean }): string {
  if (val === null || val === undefined) return "—";
  if (!Number.isFinite(val)) return "—";
  if (val === 0) return "$0.00";
  const neg = val < 0;
  const abs = Math.abs(val);
  if (abs < 0.01) {
    if (abs < 0.0001) return `${neg ? "-" : ""}$${abs.toFixed(6)}`;
    return `${neg ? "-" : ""}$${abs.toFixed(4)}`;
  }
  if (opts?.compact !== false && abs >= 100_000) {
    if (abs >= 1_000_000_000_000) {
      const t = abs / 1_000_000_000_000;
      const digits = t >= 100 ? 0 : t >= 10 ? 1 : 2;
      return `${neg ? "-" : ""}$${t.toFixed(digits)}T`;
    }
    if (abs >= 1_000_000_000) {
      const b = abs / 1_000_000_000;
      const digits = b >= 100 ? 0 : b >= 10 ? 1 : 2;
      return `${neg ? "-" : ""}$${b.toFixed(digits)}B`;
    }
    if (abs >= 1_000_000) {
      const m = abs / 1_000_000;
      const digits = m >= 100 ? 0 : m >= 10 ? 1 : 2;
      return `${neg ? "-" : ""}$${m.toFixed(digits)}M`;
    }
    const k = abs / 1_000;
    const digits = k >= 100 ? 0 : 1;
    return `${neg ? "-" : ""}$${k.toFixed(digits)}K`;
  }
  return `${neg ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Per-hour axis label when the point is an hour bucket, else MM-DD. */
export function pointLabel(d: { date: string; label?: string }): string {
  return d.label ?? d.date.slice(5);
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeUntil(ts: number | null): string {
  if (!ts) return "never";
  const delta = ts - Date.now();
  if (delta <= 0) return "expired";
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern clipboard API — only exists in secure contexts (https/localhost).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  // Legacy fallback: hidden textarea + execCommand("copy") — works on plain
  // http origins (e.g. port-forwarded hosts) where navigator.clipboard is
  // undefined.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText =
      "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy with standard user feedback (honest on failure). */
export async function copyWithToast(text: string): Promise<void> {
  if (await copyToClipboard(text)) toast("Copied");
  else
    toast(
      "Could not copy automatically. Select the text and copy it manually",
      "err",
    );
}
