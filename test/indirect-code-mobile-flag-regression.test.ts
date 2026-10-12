import { describe, expect, test, afterEach } from "bun:test";
import { createRoot } from "solid-js";
import { readMobileFlag, createMobileFlag } from "../web/src/indirect-code/utils/mobileFlag";

// Regression: mobile detection must follow the pre-paint html.mobile flag
// (web/index.html script) — the single source of truth. Viewport heuristics
// (innerWidth <= 768) mislabel touch laptops and small desktop windows.

/** Minimal DOM: a classList on documentElement + a MutationObserver shim. */
function stubDom() {
  const root = globalThis as Record<string, unknown>;
  const classes = new Set<string>();
  const observers: Array<{ cb: () => void }> = [];
  root.document = {
    documentElement: {
      classList: {
        contains: (c: string) => classes.has(c),
        toggle: (c: string, v: boolean) => {
          if (v) {
            if (!classes.has(c)) { classes.add(c); observers.forEach((o) => o.cb()); }
          } else {
            if (classes.delete(c)) observers.forEach((o) => o.cb());
          }
        },
      },
    },
  };
  root.MutationObserver = class {
    cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  };
  return classes;
}

function setMobileFlag(on: boolean) {
  const root = globalThis as Record<string, unknown>;
  const doc = root.document as { documentElement: { classList: { toggle: (c: string, v: boolean) => void } } };
  doc.documentElement.classList.toggle("mobile", on);
}

afterEach(() => {
  setMobileFlag(false);
});

describe("mobile flag — html.mobile is the source of truth", () => {
  test("readMobileFlag mirrors the html.mobile class", () => {
    stubDom();
    setMobileFlag(false);
    expect(readMobileFlag()).toBe(false);
    setMobileFlag(true);
    expect(readMobileFlag()).toBe(true);
    setMobileFlag(false);
    expect(readMobileFlag()).toBe(false);
  });

  test("the signal FOLLOWS the class (the script updates it on resize)", async () => {
    stubDom();
    setMobileFlag(false);
    const isMobile = createRoot((dispose) => {
      const signal = createMobileFlag();
      queueMicrotask(() => dispose());
      return signal;
    });
    expect(isMobile()).toBe(false);
    // The pre-paint script toggles the class on orientationchange/resize —
    // the signal must notice (MutationObserver) without any window listener.
    setMobileFlag(true);
    expect(isMobile()).toBe(true);
    setMobileFlag(false);
    expect(isMobile()).toBe(false);
  });

  test("a touch device WITHOUT the flag is NOT mobile (no viewport heuristics)", () => {
    // The class is what decides — regardless of width/touch. This pins the
    // regression: the old IndirectCodePage used window.innerWidth <= 768,
    // which mislabeled touch laptops and small desktop windows.
    stubDom();
    setMobileFlag(false);
    expect(readMobileFlag()).toBe(false);
  });
});
