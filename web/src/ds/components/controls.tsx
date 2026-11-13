import { Show, splitProps, type JSX } from "solid-js";

import { shimmerPhaseStyle } from "../motion/shimmer";
import { Glyph } from "./icon";

/* ---------------------------------------------------------------- Switch */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label beside the switch (omit when a row title labels it). */
  label?: JSX.Element;
  ariaLabel?: string;
  ariaLabelledby?: string;
  ariaDescribedby?: string;
  disabled?: boolean;
  id?: string;
  class?: string;
}

/**
 * A tactile toggle for settings that take effect immediately (Arc
 * "Switch"). The thumb moves with transforms inside a fixed box (nothing
 * around it shifts) and lands without overshoot: it reports state.
 */
export function Switch(props: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      aria-labelledby={props.ariaLabelledby}
      aria-describedby={props.ariaDescribedby}
      disabled={props.disabled}
      class={`ui-switch ${props.class ?? ""}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="ui-switch-track" aria-checked={props.checked} aria-hidden="true"><span class="ui-switch-thumb" /></span>
      <Show when={props.label}><span>{props.label}</span></Show>
    </button>
  );
}

/* -------------------------------------------------------------- Checkbox */

export interface CheckboxProps {
  checked: boolean | "indeterminate";
  onChange: (checked: boolean) => void;
  label?: JSX.Element;
  ariaLabel?: string;
  disabled?: boolean;
  class?: string;
}

/** A binary choice with a precise, legible state (Arc "Checkbox"). */
export function Checkbox(props: CheckboxProps) {
  const state = () => (props.checked === "indeterminate" ? "indeterminate" : props.checked ? "checked" : "unchecked");
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked === "indeterminate" ? "mixed" : props.checked}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      class={`inline-flex items-center gap-2.5 text-sm text-fg disabled:opacity-50 cursor-pointer ${props.class ?? ""}`}
      onClick={() => props.onChange(props.checked !== true)}
    >
      <span class="ui-check" data-state={state()} aria-hidden="true">
        <Glyph icon={state() === "indeterminate" ? "lucide:minus" : "lucide:check"} size={12} strokeWidth={3} />
      </span>
      <Show when={props.label}><span>{props.label}</span></Show>
    </button>
  );
}

/* ----------------------------------------------------------------- Badge */

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
/** Legacy tone names used by older screens. */
export type LegacyTone = "green" | "red" | "amber" | "zinc" | "indigo" | "blue" | "violet";

const LEGACY_TONES: Record<LegacyTone, BadgeTone> = {
  green: "success",
  red: "danger",
  amber: "warning",
  zinc: "neutral",
  indigo: "accent",
  blue: "accent",
  violet: "accent",
};

export interface BadgeProps {
  tone?: BadgeTone | LegacyTone;
  /** Leading status dot (pair color with the label, never color alone). */
  dot?: boolean;
  size?: "sm" | "md";
  class?: string;
  children: JSX.Element;
}

/**
 * A small label for status, category or metadata (Arc "Badge"). `accent`
 * marks emphasis ("Recommended", "New"); the other tones mean real status.
 */
export function Badge(props: BadgeProps) {
  const tone = () => LEGACY_TONES[props.tone as LegacyTone] ?? (props.tone as BadgeTone | undefined) ?? "neutral";
  return (
    <span class={`ui-badge ui-badge-${tone()} ${props.dot ? "ui-badge-dot" : ""} ${props.size === "sm" ? "ui-badge-sm" : ""} ${props.class ?? ""}`}>
      {props.children}
    </span>
  );
}

/* ----------------------------------------------------------------- Alert */

export type AlertTone = "info" | "success" | "warning" | "danger" | "neutral";

const ALERT_ICONS: Record<AlertTone, string> = {
  info: "lucide:info",
  success: "lucide:circle-check",
  warning: "lucide:triangle-alert",
  danger: "lucide:circle-alert",
  neutral: "lucide:info",
};

export interface AlertProps {
  tone?: AlertTone | "warn" | "accent";
  title?: JSX.Element;
  icon?: JSX.Element;
  class?: string;
  /** Hide the leading icon (dense contexts). */
  plain?: boolean;
  action?: JSX.Element;
  children?: JSX.Element;
}

/** A persistent message that helps people recover or continue (Arc "Alert"). */
export function Alert(props: AlertProps) {
  const tone = (): AlertTone => (props.tone === "warn" ? "warning" : props.tone === "accent" ? "info" : props.tone ?? "info");
  return (
    <div class={`ui-alert ui-alert-${tone()} ${props.class ?? ""}`} role={tone() === "danger" ? "alert" : "status"}>
      <Show when={!props.plain}>
        <span class="ui-alert-icon" aria-hidden="true">
          <Show when={props.icon} fallback={<Glyph icon={ALERT_ICONS[tone()]} size={16} />}>
            {props.icon}
          </Show>
        </span>
      </Show>
      <div class="min-w-0 flex-1">
        <Show when={props.title}><div class="ui-alert-title">{props.title}</div></Show>
        <Show when={props.children}><div>{props.children}</div></Show>
      </div>
      <Show when={props.action}><div class="shrink-0 self-center">{props.action}</div></Show>
    </div>
  );
}

/* -------------------------------------------------------------- Progress */

export interface ProgressProps {
  value: number;
  max?: number;
  tone?: "default" | "warning" | "danger";
  /** Unknown duration: a calm sweep instead of a fill. */
  indeterminate?: boolean;
  label?: string;
  class?: string;
}

/** Show how much of a known task is complete (Arc "Progress"). The fill
 *  scales on a spring without overshoot: it reports state. */
export function Progress(props: ProgressProps) {
  const pct = () => {
    const max = props.max ?? 100;
    return Math.min(100, Math.max(0, max > 0 ? (props.value / max) * 100 : 0));
  };
  return (
    <div
      class={`ui-progress ${props.indeterminate ? "ui-progress-indeterminate" : ""} ${props.class ?? ""}`}
      data-tone={props.tone && props.tone !== "default" ? props.tone : undefined}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={props.indeterminate ? undefined : 0}
      aria-valuemax={props.indeterminate ? undefined : 100}
      aria-valuenow={props.indeterminate ? undefined : Math.round(pct())}
    >
      <span class="ui-progress-fill" style={props.indeterminate ? undefined : { scale: `${pct() / 100} 1` }} />
    </div>
  );
}

/* --------------------------------------------- Spinner, skeleton, empty */

export function Spinner(props: { class?: string; label?: string }) {
  return (
    <span
      class={`ui-spinner ${props.class ?? ""}`}
      role={props.label ? "status" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    />
  );
}

export function Skeleton(props: { class?: string; style?: JSX.CSSProperties }) {
  return <div class={`ui-skeleton ${props.class ?? ""}`} style={props.style} aria-hidden="true" />;
}

export interface EmptyStateProps {
  icon?: string;
  title: string;
  hint?: string;
  action?: JSX.Element;
  class?: string;
}

/** A useful next step when there is nothing to show yet (Arc "Empty state"). */
export function EmptyState(props: EmptyStateProps) {
  return (
    <div class={`ui-empty ${props.class ?? ""}`}>
      <Show when={props.icon}>{(icon) => <span class="ui-empty-icon"><Glyph icon={icon()} size={22} /></span>}</Show>
      <p class="ui-empty-title">{props.title}</p>
      <Show when={props.hint}><p class="ui-empty-hint">{props.hint}</p></Show>
      <Show when={props.action}><div class="mt-3">{props.action}</div></Show>
    </div>
  );
}

/** Ongoing work, shown with a calm light across the words (Arc "Text shimmer"). */
export function Shimmer(props: { children: JSX.Element; class?: string }) {
  const phaseStyle = shimmerPhaseStyle(true);
  return <span class={`ui-shimmer ${props.class ?? ""}`} style={phaseStyle}>{props.children}</span>;
}

/** Keyboard key cap. */
export function Kbd(props: JSX.HTMLAttributes<HTMLElement>) {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return <kbd {...rest} class={`ui-kbd ${local.class ?? ""}`}>{local.children}</kbd>;
}
