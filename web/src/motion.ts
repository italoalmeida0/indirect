import { createEffect, createSignal, onCleanup } from "solid-js";
import USAL from "usal";

/**
 * USAL bootstrap — imported for side effects by the app entry.
 *
 * USAL v2 observes the DOM reactively (MutationObserver + IntersectionObserver),
 * so Solid-mounted nodes (route changes, resource resolutions) animate
 * automatically, no manual restarts.
 *
 *  - once:true + forwards:true  → entrances run a single time and the final
 *    state is retained (no replay/re-hide on scroll).
 *  - prefers-reduced-motion     → durations collapse to ~instant instead of
 *    animating (deterministic — USAL never leaves elements hidden).
 */

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

USAL.config({
  defaults: {
    animation: "fade",
    direction: "u",
    duration: reduceMotion ? 1 : 240,
    delay: 0,
    threshold: 10,
    splitDelay: reduceMotion ? 0 : 30,
    forwards: true,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    blur: false,
  },
  observersDelay: 50,
  once: true,
});

/**
 * Spread helper for Solid JSX: <div {...usal("fade-u delay-100")} />.
 * Plain attribute passthrough — USAL parses the tokens itself.
 */
export function usal(value: string): { "data-usal": string } {
  // Explicit per-element timings otherwise override the reduced-motion defaults.
  const timing = reduceMotion
    ? `${value.replace(/\b(duration|delay|split-delay)-\d+\b/g, (_, kind: string) => `${kind}-${kind === "duration" ? 1 : 0}`).replace(/\bloop\b/g, "")} duration-1 delay-0`
    : value;
  return { "data-usal": timing };
}

/** Staggered container: children cascade in. */
export function usalItems(
  value = "fade-u",
  stagger = 60,
): { "data-usal": string } {
  return usal(`split-item ${value} split-delay-${stagger} threshold-5`);
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Number that follows `target` WITHOUT recreating its element.
 *
 * USAL's `count-[n]` replaces the animated text node with its own span, so a
 * Solid update after the animation would write into a detached node: numbers
 * either went stale or had to remount (`<Show keyed>`) on every data refresh,
 * which replayed the whole card's entrance. This tween owns the number
 * instead: it counts up from zero on mount and from the value on screen when
 * the data changes, so a refresh animates the value and leaves the DOM alone.
 * `prefers-reduced-motion` jumps straight to the target.
 */
export function createTweenedNumber(
  target: () => number,
  entrance = 700,
  update = 420,
): () => number {
  const [display, setDisplay] = createSignal(0);
  let frame = 0;
  let current = 0;
  let settled = false;
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const run = (to: number, duration: number) => {
    stop();
    const from = current;
    if (reduceMotion || !Number.isFinite(to) || from === to) {
      current = Number.isFinite(to) ? to : from;
      setDisplay(current);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      current = from + (to - from) * easeOutCubic(t);
      setDisplay(current);
      if (t < 1) {
        frame = requestAnimationFrame(step);
      } else {
        frame = 0;
        current = to;
        setDisplay(to);
      }
    };
    frame = requestAnimationFrame(step);
  };
  createEffect(() => {
    // Read the dependency first: Solid memos evaluate eagerly.
    const to = target();
    run(to, settled ? update : entrance);
    settled = true;
  });
  onCleanup(stop);
  return display;
}

export { USAL };

// USAL 2.0 observes all DOM mutations and searches the entire document for
// shadow roots/animation targets. The streaming workspace has no USAL
// entrances; leave its hot DOM outside that global observer's lifetime.
let motionEnabled = true;
let changingMotion = false;
export function setMotionEnabled(enabled: boolean) {
  if (motionEnabled === enabled) return;
  motionEnabled = enabled;
  if (changingMotion) return;
  changingMotion = true;
  void (async () => {
    // Let USAL's automatic initial rAF run before attempting to destroy it.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      for (;;) {
        const wanted = motionEnabled;
        if (wanted) await USAL.restart();
        else await USAL.destroy();
        if (wanted === motionEnabled) break;
      }
    } finally { changingMotion = false; }
  })();
}
