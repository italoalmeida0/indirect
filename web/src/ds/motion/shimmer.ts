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
 *
 * An off→on flicker inside one frame (e.g. a snapshot that clears and refills a
 * transcript synchronously) keeps the previous delay: the class never leaves the
 * computed style, so the CSS animation does not restart, `animationstart` never
 * re-syncs it, and a freshly minted delay would knock the node out of phase.
 */
export function createShimmerStyle(active: () => boolean): () => JSX.CSSProperties | undefined {
  let wasActive = false;
  let cached: JSX.CSSProperties | undefined;
  let offAt: number | null = null;
  return () => {
    const on = Boolean(active()) && !reducedMotion();
    if (!on) {
      if (wasActive) offAt = currentShimmerClockMs();
      wasActive = false;
      return undefined;
    }
    if (!wasActive || !cached) {
      const sameFrame = cached !== undefined && offAt !== null && currentShimmerClockMs() === offAt;
      if (!sameFrame) cached = shimmerPhaseStyle(true);
      wasActive = true;
      offAt = null;
    }
    return cached;
  };
}

/**
 * Computes the Web Animations `startTime` on `document.timeline` for an infinite
 * `ui-shimmer` animation with timing delay `delayMs` at `nowMs`.
 *
 * Guarantees both invariants required by Web Animations 1 §3.6.3:
 * 1. Immediate active phase (`localTime = nowMs - startTime >= max(0, delayMs)`),
 *    preventing a negative `--ui-shimmer-delay` (`beforeActiveBoundary = 0`) from
 *    landing in `localTime < 0` (`before` phase, frozen at `200%`) when `(nowMs % P) < -delayMs`.
 * 2. Exact global phase lock (`activeTime = localTime - delayMs ≡ nowMs (mod P)`).
 */
export function shimmerAlignedStartTimeMs(nowMs: number, delayMs = 0): number {
  const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
  const safeDelay = Number.isFinite(delayMs) ? delayMs : 0;
  const anchor =
    Math.floor((safeNow + Math.min(0, safeDelay)) / SHIMMER_DURATION_MS) * SHIMMER_DURATION_MS;
  return anchor - safeDelay;
}

/**
 * Locks a running `ui-shimmer` `CSSAnimation` directly onto `document.timeline`
 * so every `.ui-shimmer` node on the page shares identical sub-millisecond phase
 * without ever placing `startTime` in the future (`before` phase).
 */
export function syncShimmerAnimation(
  target: Element,
  nowMs: number = currentShimmerClockMs(),
): void {
  if (typeof target.getAnimations !== "function") return;
  for (const anim of target.getAnimations()) {
    if ((anim as CSSAnimation).animationName !== "ui-shimmer") continue;
    const rawDelay = anim.effect?.getTiming().delay;
    const delay = typeof rawDelay === "number" && Number.isFinite(rawDelay) ? rawDelay : 0;
    const desiredStart = shimmerAlignedStartTimeMs(nowMs, delay);
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
