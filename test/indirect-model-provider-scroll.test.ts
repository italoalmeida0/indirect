import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "bun:test";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
import solidPlugin from "../plugins/solid-plugin";
import type {
  ProviderHoldTimers,
  computeProviderScrollBounds as ComputeBoundsFn,
  computeProviderStepPx as ComputeStepFn,
  createProviderHoldScroller as CreateHoldScrollerFn,
  translateProviderWheelDelta as TranslateWheelFn,
} from "../web/src/indirect-code/components/ModelPickerBody";

const repoRoot = path.join(import.meta.dir, "..");
const modelPickerPath = path.join(
  repoRoot,
  "web/src/indirect-code/components/ModelPickerBody.tsx",
);
const dsComponentsCssPath = path.join(repoRoot, "web/src/ds/components.css");

let mod: {
  PROVIDER_SCROLL_EPSILON: number;
  PROVIDER_HOLD_DELAY_MS: number;
  computeProviderScrollBounds: typeof ComputeBoundsFn;
  computeProviderStepPx: typeof ComputeStepFn;
  translateProviderWheelDelta: typeof TranslateWheelFn;
  createProviderHoldScroller: typeof CreateHoldScrollerFn;
};

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL("../web/src/indirect-code/components/ModelPickerBody.tsx", import.meta.url),
      ),
    ],
    target: "browser",
    plugins: [iconifyPlugin, solidPlugin],
  });
  if (!bundle.success) {
    throw new Error(bundle.logs.map(String).join("\n"));
  }
  const code = await bundle.outputs[0]!.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const g = globalThis as Record<string, any>;
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  const hadWindowDoc = Boolean(
    g.window && typeof g.window === "object" && "document" in g.window,
  );
  const prevWindowDoc = g.window?.document;
  const hadDocument = "document" in g;
  const prevDocument = g.document;
  const fakeDoc = { addEventListener() {}, removeEventListener() {} };
  if (!g.document) g.document = fakeDoc;
  if (!g.window || typeof g.window !== "object") {
    g.window = { document: g.document };
  } else if (!g.window.document) {
    g.window.document = g.document;
  }
  try {
    mod = await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
    if (!hadWindow) {
      delete g.window;
    } else {
      g.window = prevWindow;
      if (g.window && typeof g.window === "object") {
        if (!hadWindowDoc) delete g.window.document;
        else g.window.document = prevWindowDoc;
      }
    }
    if (!hadDocument) delete g.document;
    else g.document = prevDocument;
  }
});

function createFakeClock() {
  let nowMs = 1000;
  let nextTimerId = 1;
  let nextRafId = 1;
  const timeouts = new Map<number, { due: number; fn: () => void }>();
  const rafs = new Map<number, (now: number) => void>();

  const timers: ProviderHoldTimers = {
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timeouts.set(id, { due: nowMs + ms, fn });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (id) => {
      timeouts.delete(id as unknown as number);
    },
    requestAnimationFrame: (cb) => {
      const id = nextRafId++;
      rafs.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => {
      rafs.delete(id);
    },
    now: () => nowMs,
  };

  const advance = (deltaMs: number, frameStepMs = 1000 / 120) => {
    const target = nowMs + deltaMs;
    while (nowMs < target) {
      const nextStep = Math.min(target, nowMs + frameStepMs);
      // Fire any timers due at or before nextStep in chronological order
      while (true) {
        let earliestId: number | null = null;
        let earliestDue = Infinity;
        for (const [id, entry] of timeouts) {
          if (entry.due <= nextStep && entry.due < earliestDue) {
            earliestDue = entry.due;
            earliestId = id;
          }
        }
        if (earliestId === null) break;
        const entry = timeouts.get(earliestId)!;
        timeouts.delete(earliestId);
        nowMs = entry.due;
        entry.fn();
      }
      nowMs = nextStep;
      if (rafs.size > 0) {
        const snapshot = Array.from(rafs.entries());
        rafs.clear();
        for (const [, cb] of snapshot) {
          cb(nowMs);
        }
      }
    }
  };

  return {
    timers,
    advance,
    pendingTimeouts: () => timeouts.size,
    pendingRafs: () => rafs.size,
  };
}

describe("ModelPickerBody provider scroll geometry & wheel helpers", () => {
  test("computeProviderScrollBounds applies 1.5px epsilon and hides both arrows when chips fit", () => {
    expect(mod.PROVIDER_SCROLL_EPSILON).toBe(1.5);
    // 2-3 providers fit cleanly within width -> both false
    expect(mod.computeProviderScrollBounds(0, 400, 260)).toEqual({
      canScrollLeft: false,
      canScrollRight: false,
    });
    expect(mod.computeProviderScrollBounds(0, 400, 401.2)).toEqual({
      canScrollLeft: false,
      canScrollRight: false,
    });

    // Overflowing strip (scrollWidth = 740, clientWidth = 400 -> maxScroll = 340)
    expect(mod.computeProviderScrollBounds(0, 400, 740)).toEqual({
      canScrollLeft: false,
      canScrollRight: true,
    });
    expect(mod.computeProviderScrollBounds(1.4, 400, 740)).toEqual({
      canScrollLeft: false,
      canScrollRight: true,
    });
    expect(mod.computeProviderScrollBounds(2, 400, 740)).toEqual({
      canScrollLeft: true,
      canScrollRight: true,
    });
    expect(mod.computeProviderScrollBounds(338, 400, 740)).toEqual({
      canScrollLeft: true,
      canScrollRight: true,
    });
    expect(mod.computeProviderScrollBounds(338.6, 400, 740)).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
    expect(mod.computeProviderScrollBounds(340, 400, 740)).toEqual({
      canScrollLeft: true,
      canScrollRight: false,
    });
  });

  test("computeProviderStepPx scales with strip width and enforces a 120px minimum step", () => {
    expect(mod.computeProviderStepPx(100)).toBe(120);
    expect(mod.computeProviderStepPx(402)).toBe(Math.round(402 * 0.64));
  });

  test("translateProviderWheelDelta maps vertical mouse wheel to horizontal scroll only on overflowing strips", () => {
    // Non-overflowing strip: leave wheel untouched
    expect(
      mod.translateProviderWheelDelta({
        deltaX: 0,
        deltaY: 80,
        clientWidth: 400,
        scrollWidth: 320,
      }),
    ).toBeNull();

    // Vertical mouse wheel on overflowing strip: translate deltaY
    expect(
      mod.translateProviderWheelDelta({
        deltaX: 0,
        deltaY: 96,
        clientWidth: 400,
        scrollWidth: 740,
      }),
    ).toBe(96);
    expect(
      mod.translateProviderWheelDelta({
        deltaX: 4,
        deltaY: -64,
        clientWidth: 400,
        scrollWidth: 740,
      }),
    ).toBe(-64);

    // Native horizontal trackpad swipe (|deltaX| >= |deltaY|) or pinch-zoom (ctrlKey): do not hijack
    expect(
      mod.translateProviderWheelDelta({
        deltaX: 50,
        deltaY: 20,
        clientWidth: 400,
        scrollWidth: 740,
      }),
    ).toBeNull();
    expect(
      mod.translateProviderWheelDelta({
        deltaX: 0,
        deltaY: 80,
        ctrlKey: true,
        clientWidth: 400,
        scrollWidth: 740,
      }),
    ).toBeNull();
  });
});

describe("ModelPickerBody press-and-hold continuous gliding controller", () => {
  test("short click (< 160ms) does not enter hold mode or suppress the discrete click step", () => {
    const clock = createFakeClock();
    const strip = { scrollLeft: 0, clientWidth: 400, scrollWidth: 740 };
    let updates = 0;
    const scroller = mod.createProviderHoldScroller({
      getStrip: () => strip,
      onScrollUpdate: () => {
        updates++;
      },
      timers: clock.timers,
    });

    expect(scroller.start(1)).toBe(true);
    clock.advance(95);
    scroller.stop();

    expect(scroller.didHold()).toBe(false);
    expect(strip.scrollLeft).toBe(0);
    expect(updates).toBe(0);
    expect(scroller.consumeClickSuppression()).toBe(false);
    expect(clock.pendingTimeouts()).toBe(0);
    expect(clock.pendingRafs()).toBe(0);
  });

  test("holding past 160ms glides smoothly at 144Hz without rounding subpixels to 0, stops on release, and suppresses click jump", () => {
    const clock = createFakeClock();
    const strip = { scrollLeft: 0, clientWidth: 400, scrollWidth: 900 };
    let updates = 0;
    const scroller = mod.createProviderHoldScroller({
      getStrip: () => strip,
      onScrollUpdate: () => {
        updates++;
      },
      timers: clock.timers,
    });

    expect(scroller.start(1)).toBe(true);
    // Hold for 460ms at 144Hz (~6.94ms/frame) -> 300ms of continuous rAF gliding
    clock.advance(460, 1000 / 144);
    expect(scroller.didHold()).toBe(true);
    expect(scroller.isHolding()).toBe(true);
    const posAtRelease = strip.scrollLeft;
    expect(posAtRelease).toBeGreaterThan(80);
    expect(posAtRelease).toBeLessThan(200);
    expect(updates).toBeGreaterThan(20);

    // Release pointer: must stop immediately where released without jumping an extra step
    scroller.stop();
    expect(scroller.isHolding()).toBe(false);
    expect(clock.pendingRafs()).toBe(0);
    clock.advance(100, 1000 / 144);
    expect(strip.scrollLeft).toBe(posAtRelease);

    // Immediate synthetic click on release is suppressed once, then cleared
    expect(scroller.consumeClickSuppression()).toBe(true);
    expect(scroller.consumeClickSuppression()).toBe(false);
  });

  test("holding automatically stops upon reaching right or left scroll boundaries", () => {
    const clock = createFakeClock();
    const strip = { scrollLeft: 260, clientWidth: 400, scrollWidth: 740 }; // 80px from right end (340)
    const scroller = mod.createProviderHoldScroller({
      getStrip: () => strip,
      onScrollUpdate: () => {},
      timers: clock.timers,
    });

    expect(scroller.start(1)).toBe(true);
    clock.advance(500, 1000 / 120);
    expect(strip.scrollLeft).toBe(340);
    expect(scroller.isHolding()).toBe(false);
    expect(clock.pendingRafs()).toBe(0);
    // Releasing after hitting boundary still suppresses post-hold click
    expect(scroller.consumeClickSuppression()).toBe(true);

    // Cannot start right-hold when already at right boundary
    expect(scroller.start(1)).toBe(false);

    // Hold left all the way back to 0
    expect(scroller.start(-1)).toBe(true);
    clock.advance(1400, 1000 / 120);
    expect(strip.scrollLeft).toBe(0);
    expect(scroller.isHolding()).toBe(false);
    expect(clock.pendingRafs()).toBe(0);
  });

  test("dispose() cleans up both pending hold timers and active rAF loops on unmount", () => {
    const clock = createFakeClock();
    const strip = { scrollLeft: 100, clientWidth: 400, scrollWidth: 800 };
    const scroller = mod.createProviderHoldScroller({
      getStrip: () => strip,
      onScrollUpdate: () => {},
      timers: clock.timers,
    });

    // Unmount during 160ms pre-hold delay
    scroller.start(1);
    expect(clock.pendingTimeouts()).toBe(1);
    scroller.dispose();
    expect(clock.pendingTimeouts()).toBe(0);
    clock.advance(300);
    expect(strip.scrollLeft).toBe(100);

    // Unmount during active rAF glide
    scroller.start(-1);
    clock.advance(250);
    expect(clock.pendingRafs()).toBe(1);
    const frozen = strip.scrollLeft;
    expect(frozen).toBeLessThan(100);
    scroller.dispose();
    expect(clock.pendingRafs()).toBe(0);
    clock.advance(300);
    expect(strip.scrollLeft).toBe(frozen);
  });
});

describe("ModelPickerBody provider carousel markup & design-token hygiene", () => {
  const src = readFileSync(modelPickerPath, "utf8");
  const dsCss = readFileSync(dsComponentsCssPath, "utf8");

  test("edge scrim gradients match .ui-popover's exact semantic surface token with zero hardcoded colors", () => {
    const popoverRule = dsCss.match(/\.ui-popover\s*\{[^}]*background:\s*var\((--[a-z0-9-]+)\)/);
    expect(popoverRule).not.toBeNull();
    const popoverSurfaceVar = popoverRule![1]!;
    expect(popoverSurfaceVar).toBe("--surface-raised");

    expect(src).toContain(
      `linear-gradient(90deg, var(${popoverSurfaceVar}) 56%, transparent 100%)`,
    );
    expect(src).toContain(
      `linear-gradient(270deg, var(${popoverSurfaceVar}) 56%, transparent 100%)`,
    );
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\s*\(/);
  });

  test("wires accessible < and > scroll buttons, ResizeObserver + onCleanup, wheel translation, and chip auto-reveal", () => {
    expect(src).toContain('role="toolbar"');
    expect(src).toContain('aria-label="Filter by provider"');
    expect(src).toContain('aria-label="Scroll providers left"');
    expect(src).toContain('aria-label="Scroll providers right"');
    expect(src).toContain("ResizeObserver");
    expect(src).toContain("onCleanup");
    expect(src).toContain("setPointerCapture");
    expect(src).toContain("onWheel={handleProviderWheel}");
    expect(src).toContain("scrollIntoView");
    expect(src).toContain("reducedMotion()");
  });
});
