import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";

import type { Controls } from "./animate";
import { reducedMotion } from "./reduced";

/**
 * Exit driven by CSS: mark the element `data-state="closed"` (its stylesheet
 * transitions to the closed look) and resolve after `ms`. Used by floating
 * surfaces whose entrance is a CSS @starting-style transition.
 */
export function cssExit(el: HTMLElement, ms = 130): Controls {
  el.dataset.state = "closed";
  if (untrack(reducedMotion)) return { finished: Promise.resolve(), stop() {} };
  let timer = 0;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  timer = window.setTimeout(resolveFinished, ms);
  return {
    finished,
    stop() {
      window.clearTimeout(timer);
      delete el.dataset.state;
      resolveFinished();
    },
  };
}

/**
 * Presence: keep an element mounted until its exit animation finishes.
 * Solid's <Show> unmounts synchronously; this replaces React's
 * AnimatePresence for our components.
 *
 *   const presence = createPresence(() => props.open, {
 *     enter: (el) => animate(el, { opacity: 1 }, spring.smooth, { from: { opacity: 0 } }),
 *     exit: (el) => animate(el, { opacity: 0 }, tween.exit),
 *   });
 *   <Show when={presence.present()}><div ref={presence.ref}>…</div></Show>
 *
 * Interruptible: reopening during an exit runs `enter` again from wherever
 * the element is (the engine starts every animation from the on-screen
 * value), and closing during an entrance runs `exit` the same way.
 * `state()` is "open" | "closing" for data attributes and pointer-events.
 */
export interface Presence {
  present: Accessor<boolean>;
  state: Accessor<"open" | "closing">;
  ref: (el: HTMLElement) => void;
  element: () => HTMLElement | undefined;
}

export interface PresenceOptions {
  enter?: (el: HTMLElement) => Controls | void;
  exit?: (el: HTMLElement) => Controls | void;
}

export function createPresence(open: Accessor<boolean>, opts: PresenceOptions): Presence {
  const [present, setPresent] = createSignal(open());
  const [closing, setClosing] = createSignal(false);
  let el: HTMLElement | undefined;
  let token = 0;
  let exiting: Controls | undefined;

  createEffect(on(open, (isOpen) => {
    const mine = ++token;
    if (isOpen) {
      setClosing(false);
      const pending = exiting;
      exiting = undefined;
      pending?.stop();
      if (!present()) setPresent(true);
      else if (el) opts.enter?.(el);
      return;
    }
    if (!present()) return;
    if (!el || !opts.exit) {
      setPresent(false);
      return;
    }
    setClosing(true);
    const controls = opts.exit(el);
    exiting = controls || undefined;
    const finished = controls ? controls.finished : Promise.resolve();
    void finished.then(() => {
      if (mine !== token) return;
      exiting = undefined;
      setClosing(false);
      setPresent(false);
    });
  }, { defer: true }));

  onCleanup(() => { token++; });

  return {
    present,
    state: () => (closing() ? "closing" : "open"),
    element: () => el,
    ref(node: HTMLElement) {
      el = node;
      // The ref runs before insertion; enter in a microtask (still before
      // the next paint) once the node is in the document.
      queueMicrotask(() => {
        if (el === node && open()) opts.enter?.(node);
      });
    },
  };
}
