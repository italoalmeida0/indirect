import { untrack } from "solid-js";

import { animate } from "./ds/motion/animate";
import { reducedMotion } from "./ds/motion/reduced";
import { motionTokens } from "./ds/motion/tokens";

/**
 * Entrance helpers for gateway screens, on the design-system motion engine.
 *
 * `{...usal("fade-u delay-100")}` keeps its historical call-site shape but
 * no longer depends on the USAL library or a document-wide observer:
 * it spreads a `ref` that plays ONE entrance when the element mounts, and
 * only if the element is on screen at that moment. There is no scroll
 * reveal (design rule: one orchestrated entrance per page, nothing replays
 * on scroll). Reduced motion shows the final state immediately.
 *
 * Tokens understood: `fade` / `fade-u` / `fade-d` / `fade-l` / `fade-r`,
 * `delay-N`, `split-item` + `split-delay-N` (children cascade).
 */

interface EntranceSpec {
  x: number;
  y: number;
  delay: number;
  stagger?: number;
}

function parse(value: string): EntranceSpec {
  const tokens = value.split(/\s+/);
  const number = (prefix: string) => {
    const token = tokens.find((item) => item.startsWith(prefix));
    const parsed = token ? Number(token.slice(prefix.length)) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const direction = tokens.find((token) => token.startsWith("fade")) ?? "fade-u";
  const distance = 6;
  return {
    x: direction === "fade-l" ? distance : direction === "fade-r" ? -distance : 0,
    y: direction === "fade-u" ? distance : direction === "fade-d" ? -distance : 0,
    delay: Math.min(400, number("delay-") ?? 0) / 1000,
    stagger: tokens.includes("split-item") ? Math.min(80, number("split-delay-") ?? 35) / 1000 : undefined,
  };
}

function onScreen(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
}

/** Play one entrance on `el` (opacity tween + spring rise). */
function enter(el: HTMLElement, spec: EntranceSpec): void {
  if (untrack(reducedMotion) || !el.isConnected || !onScreen(el)) return;
  animate(el, { opacity: "1" }, { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: spec.delay }, { from: { opacity: "0" } });
  if (spec.x || spec.y) {
    animate(el, { translate: "0px 0px" }, { ...motionTokens.spring.smooth, delay: spec.delay }, { from: { translate: `${spec.x}px ${spec.y}px` } });
  }
}

/** Spread on an element: `<div {...usal("fade-u delay-100")}>`. */
export function usal(value: string): { ref: (el: HTMLElement) => void } {
  const spec = parse(value);
  return {
    ref: (el: HTMLElement) => {
      queueMicrotask(() => {
        if (spec.stagger === undefined) {
          enter(el, spec);
          return;
        }
        Array.from(el.children).slice(0, 12).forEach((child, index) => {
          if (child instanceof HTMLElement) enter(child, { ...spec, delay: spec.delay + index * spec.stagger! });
        });
      });
    },
  };
}

/** Staggered container: children cascade in (capped, total under ~0.4s). */
export function usalItems(value = "fade-u", stagger = 35): { ref: (el: HTMLElement) => void } {
  return usal(`split-item ${value} split-delay-${Math.min(stagger, 45)}`);
}
