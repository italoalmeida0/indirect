import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";

import { anchorFloat } from "../../floating";
import { createPresence, cssExit } from "../motion/presence";

/**
 * Short supporting text for unfamiliar controls (Arc "Tooltip").
 *
 * Hover on precise pointers or keyboard focus shows it; touch never pins
 * one. The first tooltip waits (hover intent) and rises a few pixels from
 * its trigger; moving to another trigger within the skip window shows the
 * next one instantly with a plain fade, like a native toolbar.
 */
let lastClosedAt = 0;
const SKIP_WINDOW = 500;

export interface TooltipProps {
  content: JSX.Element;
  placement?: Placement;
  /** Hover-intent delay in ms (default 300; 0 inside the skip window). */
  delay?: number;
  disabled?: boolean;
  children: JSX.Element;
}

export function Tooltip(props: TooltipProps) {
  const [show, setShow] = createSignal(false);
  const [instant, setInstant] = createSignal(false);
  let anchor: HTMLSpanElement | undefined;
  let showTimer: number | undefined;

  const presence = createPresence(show, { exit: (el) => cssExit(el, 120) });

  const open = (fromFocus = false) => {
    if (props.disabled) return;
    if (!fromFocus && document.documentElement.classList.contains("mobile")) return;
    window.clearTimeout(showTimer);
    const skip = Date.now() - lastClosedAt < SKIP_WINDOW;
    setInstant(skip);
    if (skip || fromFocus) {
      setShow(true);
      return;
    }
    showTimer = window.setTimeout(() => setShow(true), props.delay ?? 300);
  };
  const close = () => {
    window.clearTimeout(showTimer);
    if (show()) lastClosedAt = Date.now();
    setShow(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    window.clearTimeout(showTimer);
  });

  return (
    <>
      <span
        ref={anchor}
        class="inline-flex max-w-full"
        onMouseEnter={() => open()}
        onMouseLeave={close}
        onFocusIn={() => { if (anchor?.querySelector(":focus-visible")) open(true); }}
        onFocusOut={close}
        onPointerDown={close}
      >
        {props.children}
      </span>
      <Show when={presence.present()}>
        <Portal>
          <div
            ref={(el) => {
              presence.ref(el);
              onCleanup(anchorFloat(anchor!, el, { placement: props.placement ?? "top", gap: 8 }));
            }}
            role="tooltip"
            data-instant={instant() ? "" : undefined}
            class="ui-tooltip w-max"
          >
            {props.content}
          </div>
        </Portal>
      </Show>
    </>
  );
}
