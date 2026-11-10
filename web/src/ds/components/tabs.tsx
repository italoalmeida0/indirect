import { createEffect, createSignal, createUniqueId, For, on, Show, type JSX } from "solid-js";

import { animate } from "../motion/animate";
import { createGlide } from "../motion/glide";
import { press } from "../motion/press";
import { motionTokens, tween } from "../motion/tokens";
import { copyText } from "../primitives/clipboard";
import { rovingIndex } from "../primitives/a11y";
import { Glyph } from "./icon";

/* ------------------------------------------------------------------ Tabs */

export interface TabItem<T extends string> {
  value: T;
  label: JSX.Element;
  icon?: string;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  items: Array<TabItem<T>>;
  /** Accessible name of the tab list. */
  label?: string;
  ariaLabel?: string;
  /** "pill" (raised highlight in a tray) or "line" (underline indicator). */
  variant?: "pill" | "line";
  /** id prefix: tabs get `${id}-tab-${value}`, panels should use `${id}-panel-${value}`. */
  id?: string;
  class?: string;
}

/**
 * Switch between related content in the same context (Arc "Tabs"). The
 * indicator glides between tabs on spring.morph; arrow keys move the
 * selection and only the selected tab is a tab stop. Pair with
 * `TabPanel` for the content.
 */
export function Tabs<T extends string>(props: TabsProps<T>) {
  const autoId = createUniqueId();
  const tabId = () => props.id ?? autoId;
  const [list, setList] = createSignal<HTMLDivElement>();
  const [indicator, setIndicator] = createSignal<HTMLSpanElement>();
  const selectedIndex = () => Math.max(0, props.items.findIndex((item) => item.value === props.value));
  createGlide({
    container: list,
    indicator,
    target: () => {
      void props.value;
      return list()?.querySelector<HTMLElement>('[aria-selected="true"]') ?? null;
    },
  });
  const onKeyDown = (event: KeyboardEvent) => {
    const next = rovingIndex(event.key, selectedIndex(), props.items.length, (index) => !!props.items[index]?.disabled);
    if (next === undefined || next === selectedIndex()) return;
    event.preventDefault();
    props.onChange(props.items[next]!.value);
    queueMicrotask(() => list()?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus({ preventScroll: true }));
  };
  const line = () => props.variant === "line";
  return (
    <div
      ref={setList}
      role="tablist"
      aria-label={props.label ?? props.ariaLabel}
      data-glide=""
      class={`${line() ? "ui-tabs-line" : "ui-tabs-list"} ${props.class ?? ""}`}
      onKeyDown={onKeyDown}
    >
      <span ref={setIndicator} class={line() ? "ui-tabs-line-indicator" : "ui-tabs-indicator"} aria-hidden="true" />
      <For each={props.items}>
        {(item, index) => (
          <button
            type="button"
            role="tab"
            id={`${tabId()}-tab-${item.value}`}
            aria-controls={props.id && item.value === props.value ? `${props.id}-panel-${item.value}` : undefined}
            aria-selected={item.value === props.value}
            tabIndex={index() === selectedIndex() ? 0 : -1}
            disabled={item.disabled}
            class={line() ? "ui-tab" : "ui-segment"}
            onClick={() => props.onChange(item.value)}
          >
            <Show when={item.icon}>{(ic) => <Glyph icon={ic()} size={14} class="mr-1.5" />}</Show>
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** Content of one tab; fades in on change (no travel, content swaps in place). */
export function TabPanel(props: { id?: string; value: string; active: boolean | string; children: JSX.Element; class?: string }) {
  let el: HTMLDivElement | undefined;
  const isActive = () => (typeof props.active === "boolean" ? props.active : props.active === props.value);
  createEffect(on(isActive, (active) => {
    if (active && el) animate(el, { opacity: "1" }, tween.fast, { from: { opacity: "0" } });
  }, { defer: true }));
  return (
    <Show when={isActive()}>
      <div
        ref={el}
        role="tabpanel"
        id={props.id ? `${props.id}-panel-${props.value}` : undefined}
        aria-labelledby={props.id ? `${props.id}-tab-${props.value}` : undefined}
        tabIndex={0}
        class={props.class}
      >
        {props.children}
      </div>
    </Show>
  );
}

/* -------------------------------------------------------------- IconSwap */

/**
 * An icon that morphs between states (Arc "Icon morph"): the outgoing glyph
 * shrinks and fades while the incoming one grows in, on one snappy spring.
 * Use for copy → check, send → stop, play → pause, menu → close.
 */
export function IconSwap(props: { icon: string; size?: number; class?: string; strokeWidth?: number }) {
  let box: HTMLSpanElement | undefined;
  createEffect(on(() => props.icon, () => {
    if (!box) return;
    animate(box, { opacity: "1", scale: "1", filter: "blur(0px)" }, motionTokens.spring.snappy, {
      from: { opacity: "0", scale: "0.6", filter: `blur(${motionTokens.blur.subtle}px)` },
    });
  }, { defer: true }));
  return (
    <span ref={box} class={`inline-grid place-items-center ${props.class ?? ""}`} aria-hidden="true">
      <Glyph icon={props.icon} size={props.size ?? 16} strokeWidth={props.strokeWidth} />
    </span>
  );
}

/* ------------------------------------------------------------ CopyButton */

export interface CopyButtonProps {
  value?: string | (() => string);
  text?: string | (() => string);
  /** Accessible name, e.g. "Copy API key". */
  label?: string;
  size?: "xs" | "sm" | "md";
  /** Show a text label beside the icon ("Copy" → "Copied"). */
  showText?: boolean;
  class?: string;
  onCopied?: (ok: boolean) => void;
}

/**
 * Copy a value with immediate, in-place confirmation (Arc "Copy button"):
 * the copy glyph morphs into a check for 1.6s. No toast: the confirmation
 * is where the eye already is. Failure says so in place too.
 */
export function CopyButton(props: CopyButtonProps) {
  const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle");
  let timer = 0;
  const run = async () => {
    const raw = props.value ?? props.text ?? "";
    const ok = await copyText(typeof raw === "function" ? raw() : raw);
    setState(ok ? "copied" : "failed");
    props.onCopied?.(ok);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setState("idle"), 1600);
  };
  const icon = () => (state() === "copied" ? "lucide:check" : state() === "failed" ? "lucide:x" : "lucide:copy");
  const text = () => (state() === "copied" ? "Copied" : state() === "failed" ? "Copy failed" : "Copy");
  return (
    <button
      type="button"
      ref={press}
      aria-label={props.showText ? undefined : (props.label ?? "Copy")}
      title={undefined}
      onClick={() => void run()}
      class={props.showText
        ? `ui-button ui-button-secondary ui-button-${props.size ?? "xs"} ${props.class ?? ""}`
        : `ui-icon-button ${props.size === "xs" ? "ui-icon-button-xs" : props.size === "md" ? "ui-icon-button-md" : ""} ${props.class ?? ""}`}
      data-state={state()}
    >
      <IconSwap icon={icon()} size={props.size === "xs" ? 14 : 16} class={state() === "copied" ? "text-success" : state() === "failed" ? "text-danger" : ""} />
      <Show when={props.showText}><span class="ui-button-label">{text()}</span></Show>
      <span class="sr-only" aria-live="polite">{state() === "copied" ? "Copied" : state() === "failed" ? "Copy failed" : ""}</span>
    </button>
  );
}
