import { createSignal, For, type JSX } from "solid-js";

import { createGlide } from "../motion/glide";
import { press } from "../motion/press";
import { rovingIndex } from "../primitives/a11y";

export interface SegmentOption<T extends string> {
  value: T;
  label: JSX.Element;
  /** Accessible name when the label is an icon. */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<SegmentOption<T>>;
  /** Accessible name for the group. */
  label?: string;
  size?: "sm" | "md";
  class?: string;
}

/**
 * Switch between a small set of related views (Arc "Segmented control").
 * One raised highlight glides between options on spring.morph; labels
 * never scale or change weight, only their color follows. Arrow keys,
 * Home and End move the selection; only the selected option is a tab stop.
 */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  const [track, setTrack] = createSignal<HTMLDivElement>();
  const [indicator, setIndicator] = createSignal<HTMLSpanElement>();
  const selectedIndex = () => Math.max(0, props.options.findIndex((option) => option.value === props.value));
  createGlide({
    container: track,
    indicator,
    target: () => {
      void props.value;
      return track()?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null;
    },
  });
  const onKeyDown = (event: KeyboardEvent) => {
    const next = rovingIndex(event.key, selectedIndex(), props.options.length, (index) => !!props.options[index]?.disabled);
    if (next === undefined || next === selectedIndex()) return;
    event.preventDefault();
    const option = props.options[next]!;
    props.onChange(option.value);
    queueMicrotask(() => track()?.querySelectorAll<HTMLElement>(".ui-segment")[next]?.focus({ preventScroll: true }));
  };
  return (
    <div
      ref={setTrack}
      role="group"
      aria-label={props.label}
      data-glide=""
      class={`ui-segmented ${props.size === "sm" ? "ui-segmented-sm" : ""} ${props.class ?? ""}`}
      onKeyDown={onKeyDown}
    >
      <span ref={setIndicator} class="ui-segmented-indicator" aria-hidden="true" />
      <For each={props.options}>
        {(option, index) => (
          <button
            type="button"
            class="ui-segment"
            aria-pressed={option.value === props.value}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            tabIndex={index() === selectedIndex() ? 0 : -1}
            onPointerDown={(e) => {
              if (!option.disabled) press(e.currentTarget);
            }}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}
