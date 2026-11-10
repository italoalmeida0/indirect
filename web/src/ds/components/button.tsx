import { createEffect, createSignal, on, Show, splitProps, type JSX } from "solid-js";

import { animate } from "../motion/animate";
import { createMorphWidth } from "../motion/morph";
import { press } from "../motion/press";
import { motionTokens } from "../motion/tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "ref"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Busy state: the label fades, a spinner takes its place, clicks are ignored. */
  loading?: boolean;
  block?: boolean;
  type?: "button" | "submit" | "reset";
  ref?: (el: HTMLButtonElement) => void;
  /**
   * Identity of the label. When it changes, the new label rises 2px as it
   * fades in and the button width springs to the new content. Defaults to
   * the children when they are plain text.
   */
  labelKey?: unknown;
}

/**
 * A clear, responsive action with quiet secondary states (Arc "Button").
 * One primary per surface; the rest secondary or ghost.
 */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "loading", "block", "class", "children", "ref", "labelKey", "type", "disabled"]);
  const [label, setLabel] = createSignal<HTMLSpanElement>();
  const key = () => {
    if (local.labelKey !== undefined) return local.labelKey;
    const children = local.children;
    return typeof children === "string" || typeof children === "number" ? children : undefined;
  };
  createMorphWidth(label, key);
  createEffect(on(key, (value, previous) => {
    const el = label();
    if (!el || value === previous) return;
    animate(el, { opacity: "1", translate: "0px 0px" }, motionTokens.spring.snappy, { from: { opacity: "0", translate: "0px 2px" } });
  }, { defer: true }));
  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading ? "true" : undefined}
      ref={(el) => {
        press(el);
        local.ref?.(el);
      }}
      class={`ui-button ui-button-${local.variant ?? "primary"} ui-button-${local.size ?? "sm"} ${local.block ? "ui-button-block" : ""} ${local.class ?? ""}`}
    >
      <span class="ui-button-label" ref={setLabel}>{local.children}</span>
      <Show when={local.loading}>
        <span class="ui-button-loader" aria-hidden="true"><span class="ui-spinner" /></span>
      </Show>
    </button>
  );
}
