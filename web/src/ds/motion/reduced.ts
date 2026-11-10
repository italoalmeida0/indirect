import { createSignal } from "solid-js";

/**
 * Reduced motion, reactive. Every animation in the design system has a
 * branch on this: keep the final state, focus and feedback; drop travel,
 * loops and autoplay. A counter jumps to its value, a panel appears at full
 * height.
 *
 * The OS preference is the default; the design-system gallery (and tests)
 * can force either value with `setReducedMotionOverride`.
 */
const query = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : undefined;

const [system, setSystem] = createSignal(query?.matches ?? false);
const [override, setOverride] = createSignal<boolean | null>(null);
query?.addEventListener?.("change", (event) => setSystem(event.matches));

/** True when animations should collapse to their final state. */
export function reducedMotion(): boolean {
  const forced = override();
  return forced ?? system();
}

/** Force reduced motion on (true), off (false) or back to the OS (null). */
export function setReducedMotionOverride(value: boolean | null): void {
  setOverride(value);
  if (typeof document !== "undefined") {
    if (value === null) delete document.documentElement.dataset.reducedMotion;
    else document.documentElement.dataset.reducedMotion = value ? "reduce" : "no-preference";
  }
}
