import { createEffect, on, onCleanup, type Accessor } from "solid-js";

import { animate, type Controls } from "./animate";
import { motionTokens, tween } from "./tokens";

/**
 * Size morphs. Animating width or height is allowed only when the size IS
 * the information (a panel opening, a label changing), and then on a spring.
 */

/** Expand `el` from 0 to its natural height (opacity together, no overshoot). */
export function expandHeight(el: HTMLElement): Controls {
  const target = el.scrollHeight;
  el.style.overflow = "hidden";
  const controls = animate(
    el,
    { height: `${target}px`, opacity: "1" },
    motionTokens.spring.smooth,
    { from: { height: "0px", opacity: "0" }, clear: ["height", "overflow"] },
  );
  return controls;
}

/** Collapse `el` from its current height to 0; exits are faster. */
export function collapseHeight(el: HTMLElement): Controls {
  const start = el.getBoundingClientRect().height;
  el.style.overflow = "hidden";
  return animate(
    el,
    { height: "0px", opacity: "0" },
    tween.exit,
    { from: { height: `${start}px` } },
  );
}

/**
 * Width that follows new content: when `key` changes (a button label goes
 * from "Save" to "Saving…"), the slot springs from its previous width to the
 * natural width of the new content instead of snapping. Other resizes (late
 * web fonts, parent reflow) are left alone.
 */
export function createMorphWidth(slot: Accessor<HTMLElement | undefined>, key: Accessor<unknown>): void {
  let lastWidth = 0;
  createEffect(() => {
    const node = slot();
    if (!node || typeof ResizeObserver === "undefined") return;
    lastWidth = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      if (!node.style.width) lastWidth = node.getBoundingClientRect().width;
    });
    observer.observe(node);
    onCleanup(() => observer.disconnect());
  });
  createEffect(on(key, () => {
    const node = slot();
    if (!node || !lastWidth) return;
    const from = lastWidth;
    node.style.width = "";
    const to = node.getBoundingClientRect().width;
    if (Math.abs(to - from) < 0.5) return;
    void animate(node, { width: `${to}px` }, motionTokens.spring.morph, {
      from: { width: `${from}px` },
      clear: ["width"],
    }).finished.then(() => { lastWidth = node.getBoundingClientRect().width; });
  }, { defer: true }));
}
