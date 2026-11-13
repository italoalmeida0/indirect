import type { JSX } from "solid-js";
import { reducedMotion } from "./reduced";

/** Period of `.ui-shimmer` in milliseconds (`2.2s` in `web/src/ds/components.css`). */
export const SHIMMER_DURATION_MS = 2200;

/** Monotonic document-timeline clock in milliseconds (matches Web Animations `document.timeline`). */
export function currentShimmerClockMs(): number {
  if (typeof document !== "undefined" && document.timeline?.currentTime != null) {
    const t = Number(document.timeline.currentTime);
    if (Number.isFinite(t) && t >= 0) return t;
  }
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    const t = performance.now();
    if (Number.isFinite(t) && t >= 0) return t;
  }
  return 0;
}

/**
 * Negative `animation-delay` in `(-SHIMMER_DURATION_MS, 0]` that locks a newly
 * activated `.ui-shimmer` node onto the global wall-clock wave at `nowMs`.
 */
export function shimmerPhaseDelayMs(nowMs: number = currentShimmerClockMs()): number {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return 0;
  const mod = nowMs % SHIMMER_DURATION_MS;
  return mod === 0 ? 0 : -mod;
}

/**
 * Inline `--ui-shimmer-delay` style aligning `.ui-shimmer` to the shared
 * document timeline from its very first painted frame.
 */
export function shimmerPhaseStyle(active = true): JSX.CSSProperties | undefined {
  if (!active || reducedMotion()) return undefined;
  return { "--ui-shimmer-delay": `${shimmerPhaseDelayMs().toFixed(2)}ms` };
}

/**
 * Reactive phase-locked style for conditional `.ui-shimmer` elements:
 * computes `--ui-shimmer-delay` once when `active()` turns true and keeps the
 * style object reference identical across subsequent text, counter, and timer updates.
 */
export function createShimmerStyle(active: () => boolean): () => JSX.CSSProperties | undefined {
  let wasActive = false;
  let cached: JSX.CSSProperties | undefined;
  return () => {
    const on = Boolean(active()) && !reducedMotion();
    if (!on) {
      wasActive = false;
      cached = undefined;
      return undefined;
    }
    if (!wasActive || !cached) {
      wasActive = true;
      cached = shimmerPhaseStyle(true);
    }
    return cached;
  };
}

/**
 * Locks a running `ui-shimmer` `CSSAnimation` directly onto `document.timeline`
 * (`startTime + delay = floor(now / P) * P`) so every `.ui-shimmer` node on the
 * page shares identical sub-millisecond phase even without inline style props.
 */
export function syncShimmerAnimation(target: Element): void {
  if (typeof target.getAnimations !== "function") return;
  const now = currentShimmerClockMs();
  const cycleStart = Math.floor(now / SHIMMER_DURATION_MS) * SHIMMER_DURATION_MS;
  for (const anim of target.getAnimations()) {
    if ((anim as CSSAnimation).animationName !== "ui-shimmer") continue;
    const rawDelay = anim.effect?.getTiming().delay;
    const delay = typeof rawDelay === "number" && Number.isFinite(rawDelay) ? rawDelay : 0;
    const desiredStart = cycleStart - delay;
    if (typeof anim.startTime !== "number" || Math.abs(anim.startTime - desiredStart) > 0.5) {
      try {
        anim.startTime = desiredStart;
      } catch {
        // Ignore detached or non-writable animation timelines.
      }
    }
  }
}

let syncInstalled = false;

/** Installs a single passive capture-phase `animationstart` listener on `document`. */
export function installShimmerPhaseSync(): void {
  if (syncInstalled || typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return;
  }
  syncInstalled = true;
  document.addEventListener(
    "animationstart",
    (event: AnimationEvent) => {
      if (event.animationName !== "ui-shimmer") return;
      if (event.target instanceof Element) {
        syncShimmerAnimation(event.target);
      }
    },
    { capture: true, passive: true },
  );
}

installShimmerPhaseSync();
