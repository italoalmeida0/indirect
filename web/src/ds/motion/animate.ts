import { untrack } from "solid-js";

import { reducedMotion } from "./reduced";
import { motionTokens, type SpringTransition, type Transition } from "./tokens";

/**
 * A small animation engine on top of the Web Animations API.
 *
 * Springs are integrated once per (visualDuration, bounce) pair and played as
 * a CSS `linear()` easing, so they run on the compositor like any other
 * WAAPI animation. The model is "final state first":
 *
 *  1. the current on-screen value of every animated property is captured
 *     (computed style already reflects a running animation),
 *  2. any running animation on those properties is cancelled,
 *  3. the FINAL value is written inline,
 *  4. a WAAPI animation plays from the captured value to the final one.
 *
 * Interrupting therefore never jumps: a new target starts from wherever the
 * element is. When the animation ends nothing is retained except the inline
 * final value, and identity transforms are removed entirely, so no
 * containing block is left behind for position:fixed descendants.
 *
 * Reduced motion: values jump to their final state (still resolving
 * `finished`), so callers never need a second code path for correctness.
 */

export interface Controls {
  /** Resolves when the animation finishes or is stopped/superseded. */
  finished: Promise<void>;
  /** Freeze at the current on-screen value and stop. */
  stop(): void;
}

export type Frame = Record<string, string | number>;

export interface AnimateOptions {
  /** Explicit start values (required when the element is not connected yet). */
  from?: Frame;
  /** Properties whose inline value is removed once the animation finishes
   *  (e.g. `height` back to auto after an expand). */
  clear?: readonly string[];
}

interface Curve {
  duration: number;
  easing: string;
  points: number[];
}

const curves = new Map<string, Curve>();

let linearSupport: boolean | undefined;
function supportsLinear(): boolean {
  if (linearSupport === undefined) {
    linearSupport = typeof CSS !== "undefined" && typeof CSS.supports === "function"
      && CSS.supports("transition-timing-function", "linear(0, 1)");
  }
  return linearSupport;
}

/** Integrate a spring (mass 1) from 0 to 1 and sample it for `linear()`. */
export function springCurve(spring: Pick<SpringTransition, "visualDuration" | "bounce">): Curve {
  const key = `${spring.visualDuration}|${spring.bounce}`;
  const cached = curves.get(key);
  if (cached) return cached;
  const root = (2 * Math.PI) / (spring.visualDuration * 1.2);
  const stiffness = root * root;
  const damping = 2 * Math.min(1, Math.max(0.05, 1 - spring.bounce)) * Math.sqrt(stiffness);
  const dt = 1 / 1000;
  const trace: number[] = [0];
  let x = 0;
  let v = 0;
  let t = 0;
  for (; t < 5; t += dt) {
    const a = -stiffness * (x - 1) - damping * v;
    v += a * dt;
    x += v * dt;
    trace.push(x);
    if (t > 0.05 && Math.abs(1 - x) < 0.0008 && Math.abs(v) < 0.02) break;
  }
  const duration = Math.max(0.05, t);
  const count = Math.min(80, Math.max(16, Math.round(duration * 60)));
  const points: number[] = [];
  for (let i = 0; i <= count; i++) {
    const index = Math.min(trace.length - 1, Math.round((i / count) * (trace.length - 1)));
    points.push(i === count ? 1 : Math.round(trace[index]! * 10000) / 10000);
  }
  const easing = supportsLinear()
    ? `linear(${points.join(", ")})`
    : `cubic-bezier(${motionTokens.ease.standard.join(", ")})`;
  const curve = { duration, easing, points };
  curves.set(key, curve);
  return curve;
}

function timing(transition: Transition): { duration: number; easing: string; delay: number; points?: number[] } {
  const delay = (transition.delay ?? 0) * 1000;
  if (transition.type === "spring") {
    const curve = springCurve(transition);
    return { duration: curve.duration * 1000, easing: curve.easing, delay, points: curve.points };
  }
  const ease = transition.ease ?? motionTokens.ease.standard;
  return {
    duration: transition.duration * 1000,
    easing: typeof ease === "string" ? ease : `cubic-bezier(${ease.join(", ")})`,
    delay,
  };
}

const IDENTITY = new Set(["", "none", "0", "0px", "0px 0px", "0px 0px 0px", "1", "1 1", "scale(1)", "translate(0px, 0px)", "translateY(0px)", "translateX(0px)", "blur(0px)", "inset(0px)", "inset(0%)"]);
const TRANSFORM_LIKE = new Set(["transform", "translate", "scale", "rotate", "filter", "clipPath"]);

interface Running {
  animation: Animation;
  props: Set<string>;
  settle: () => void;
}

const running = new WeakMap<Element, Running[]>();

function styleOf(el: Element): CSSStyleDeclaration | undefined {
  return (el as HTMLElement).style;
}

function readComputed(el: Element, props: string[]): Frame {
  const out: Frame = {};
  if (!el.isConnected) return out;
  const computed = getComputedStyle(el);
  for (const prop of props) out[prop] = (computed as unknown as Record<string, string>)[prop] ?? "";
  return out;
}

function cleanupIdentity(el: Element, to: Frame, clear?: readonly string[]) {
  const style = styleOf(el);
  if (!style) return;
  const record = style as unknown as Record<string, string>;
  for (const prop of Object.keys(to)) {
    if (TRANSFORM_LIKE.has(prop) && IDENTITY.has(String(to[prop]).trim())) record[prop] = "";
  }
  for (const prop of clear ?? []) record[prop] = "";
}

const resolved: Controls = { finished: Promise.resolve(), stop() {} };

/** Animate `el` to `to`. See the module comment for the model. */
export function animate(el: Element, to: Frame, transition: Transition, opts: AnimateOptions = {}): Controls {
  const style = styleOf(el);
  if (!style) return resolved;
  const props = Object.keys(to);
  const record = style as unknown as Record<string, string>;

  // 1. Capture where the element is now (before cancelling anything).
  const current = { ...readComputed(el, props.filter((prop) => opts.from?.[prop] === undefined)), ...opts.from };

  // 2. Supersede running animations that touch the same properties.
  const list = running.get(el) ?? [];
  for (const entry of [...list]) {
    if (props.some((prop) => entry.props.has(prop))) {
      entry.animation.cancel();
      entry.settle();
    }
  }

  // 3. Final state first.
  for (const prop of props) record[prop] = String(to[prop]);

  const reduce = untrack(reducedMotion);
  const time = timing(transition);
  const from: Frame = {};
  let changed = false;
  for (const prop of props) {
    const start = current[prop];
    if (start === undefined || start === "") continue;
    from[prop] = String(start);
    if (String(start) !== String(to[prop])) changed = true;
  }
  if (reduce || !changed || time.duration <= 0 || typeof (el as HTMLElement).animate !== "function") {
    cleanupIdentity(el, to, opts.clear);
    return resolved;
  }

  // 4. Play from the captured value to the final one.
  const keyframes: Keyframe[] = [
    { ...Object.fromEntries(props.map((prop) => [prop, from[prop] ?? String(to[prop])])) },
    { ...Object.fromEntries(props.map((prop) => [prop, String(to[prop])])) },
  ];
  let animation: Animation;
  try {
    animation = (el as HTMLElement).animate(keyframes, {
      duration: time.duration,
      easing: time.easing,
      delay: time.delay,
      fill: time.delay > 0 ? "backwards" : "none",
    });
  } catch {
    cleanupIdentity(el, to, opts.clear);
    return resolved;
  }

  let done = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const entry: Running = {
    animation,
    props: new Set(props),
    settle: () => {
      if (done) return;
      done = true;
      const remaining = (running.get(el) ?? []).filter((item) => item !== entry);
      if (remaining.length) running.set(el, remaining);
      else running.delete(el);
      resolveFinished();
    },
  };
  running.set(el, [...(running.get(el) ?? []), entry]);
  animation.onfinish = () => {
    cleanupIdentity(el, to, opts.clear);
    entry.settle();
  };
  animation.oncancel = () => entry.settle();

  return {
    finished,
    stop() {
      if (done) return;
      const frozen = readComputed(el, props);
      animation.cancel();
      for (const prop of props) if (frozen[prop]) record[prop] = String(frozen[prop]);
      entry.settle();
    },
  };
}

