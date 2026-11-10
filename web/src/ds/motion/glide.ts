import { createEffect, onCleanup, untrack } from "solid-js";

import { animate } from "./animate";
import { motionTokens, tween, type Transition } from "./tokens";

/**
 * Gliding highlight: ONE persistent indicator that travels between items,
 * the Solid equivalent of a shared `layoutId` highlight (segmented controls,
 * tabs, navigation rails, menu hover rows).
 *
 * The container must be the indicator's offset parent (position: relative)
 * and the indicator is absolutely positioned at left/top 0. The first
 * placement, container resizes and font loading jump without animation;
 * only a change of target glides (spring.morph). When the target becomes
 * null the indicator fades out in place.
 */
export interface GlideOptions {
  container: () => HTMLElement | undefined;
  indicator: () => HTMLElement | undefined;
  /** The item the indicator should cover, or null to hide it. */
  target: () => HTMLElement | null | undefined;
  transition?: Transition;
  /** Inset the indicator from the item edges, px. */
  inset?: number;
}

export function createGlide(opts: GlideOptions): void {
  let placed = false;
  let visible = false;
  let lastTarget: HTMLElement | null | undefined;

  const measure = (item: HTMLElement) => {
    const inset = opts.inset ?? 0;
    return {
      x: item.offsetLeft + inset,
      y: item.offsetTop + inset,
      w: Math.max(0, item.offsetWidth - inset * 2),
      h: Math.max(0, item.offsetHeight - inset * 2),
    };
  };

  const place = (item: HTMLElement | null | undefined, glide: boolean) => {
    const indicator = opts.indicator();
    if (!indicator) return;
    if (!item || !item.isConnected) {
      if (visible) animate(indicator, { opacity: 0 }, tween.exit);
      visible = false;
      return;
    }
    const box = measure(item);
    const frame = { translate: `${box.x}px ${box.y}px`, width: `${box.w}px`, height: `${box.h}px` };
    if (!placed || !visible || !glide) {
      // Jump into place, then fade in if it was hidden.
      for (const [key, value] of Object.entries(frame)) (indicator.style as unknown as Record<string, string>)[key] = value;
      if (!visible) animate(indicator, { opacity: 1 }, tween.fast, { from: { opacity: placed ? 0 : 1 } });
      placed = true;
      visible = true;
      return;
    }
    const defaultSpring = indicator.classList.contains("ui-menu-highlight")
      ? motionTokens.spring.snappy
      : motionTokens.spring.morph;
    animate(indicator, frame, opts.transition ?? defaultSpring);
  };

  createEffect(() => {
    const item = opts.target();
    const container = opts.container();
    if (!container) return;
    const glide = lastTarget !== undefined && item !== lastTarget;
    lastTarget = item;
    // Measure after layout settles for this tick.
    queueMicrotask(() => untrack(() => place(item, glide)));
  });

  createEffect(() => {
    const container = opts.container();
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place(untrack(opts.target), false));
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });
}
