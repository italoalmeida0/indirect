import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, createSignal } from "solid-js";
import { setReducedMotionOverride } from "../web/src/ds/motion/reduced";
import {
  SHIMMER_DURATION_MS,
  createShimmerStyle,
  shimmerPhaseDelayMs,
  shimmerPhaseStyle,
} from "../web/src/ds/motion/shimmer";
import { createQueue } from "../web/src/indirect-code/hooks/useQueue";

const repoRoot = join(import.meta.dir, "..");

describe("ui-shimmer CSS period math & reduced-motion contract", () => {
  const css = readFileSync(join(repoRoot, "web/src/ds/components.css"), "utf8");

  test("enforces exact integer-period background-position shift and repeat tiling", () => {
    const ruleMatch = css.match(/\.ui-shimmer\s*\{([\s\S]*?)\n\}/);
    expect(ruleMatch).not.toBeNull();
    const ruleBody = ruleMatch![1]!;

    expect(ruleBody).toContain("background-repeat: repeat;");
    expect(ruleBody).toContain("-webkit-background-clip: text;");
    expect(ruleBody).toContain("background-clip: text;");
    expect(ruleBody).toContain("-webkit-text-fill-color: transparent;");
    expect(ruleBody).not.toContain("will-change");
    expect(ruleBody).not.toContain("transform:");

    const sizeMatch = ruleBody.match(/background-size:\s*(\d+(?:\.\d+)?)%\s+100%/);
    expect(sizeMatch).not.toBeNull();
    const S = Number(sizeMatch![1]) / 100;
    expect(S).toBeGreaterThan(1);

    const animMatch = ruleBody.match(
      /animation:\s*ui-shimmer\s+(\d+(?:\.\d+)?)s\s+linear\s+var\(--ui-shimmer-delay,\s*0ms\)\s+infinite/,
    );
    expect(animMatch).not.toBeNull();
    expect(Math.round(Number(animMatch![1]) * 1000)).toBe(SHIMMER_DURATION_MS);

    const kfMatch = css.match(
      /@keyframes\s+ui-shimmer\s*\{\s*from\s*\{\s*background-position:\s*(-?\d+(?:\.\d+)?)%\s+0;\s*\}\s*to\s*\{\s*background-position:\s*(-?\d+(?:\.\d+)?)%\s+0;\s*\}\s*\}/,
    );
    expect(kfMatch).not.toBeNull();
    const pFrom = Number(kfMatch![1]);
    const pTo = Number(kfMatch![2]);

    // CSS percentage background-position-x: offset(P) = (1 - S) * W * (P / 100).
    // For left-to-right sweep of exactly +1 * bgW (+S * W) with zero wraparound snap:
    // (1 - S) * (pTo - pFrom) / 100 === +S.
    const shiftInElementWidths = (1 - S) * ((pTo - pFrom) / 100);
    expect(shiftInElementWidths).toBeCloseTo(S, 9);
    expect(shiftInElementWidths).toBeGreaterThan(0); // strictly left-to-right
  });

  test("preserves reduced-motion static text fallback for both media query and data attribute", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(':root[data-reduced-motion="reduce"] .ui-shimmer');
    expect(css).toContain("-webkit-text-fill-color: currentColor;");
  });
});

describe("shimmer wall-clock phase synchronization & reactive DOM stability", () => {
  test("shimmerPhaseDelayMs maps arbitrary wall-clock timestamps into (-SHIMMER_DURATION_MS, 0]", () => {
    expect(shimmerPhaseDelayMs(0)).toBe(0);
    expect(shimmerPhaseDelayMs(-50)).toBe(0);
    expect(shimmerPhaseDelayMs(SHIMMER_DURATION_MS)).toBe(0);
    expect(shimmerPhaseDelayMs(SHIMMER_DURATION_MS * 4)).toBe(0);
    expect(shimmerPhaseDelayMs(550)).toBe(-550);
    expect(shimmerPhaseDelayMs(SHIMMER_DURATION_MS * 3 + 725.5)).toBeCloseTo(-725.5, 5);
  });

  test("createShimmerStyle holds stable style reference across reactive ticks and respects reducedMotion", () => {
    try {
      setReducedMotionOverride(false);
      createRoot((dispose) => {
        const [busy, setBusy] = createSignal(true);
        const [tick, setTick] = createSignal(0);
        const style = createShimmerStyle(() => {
          tick(); // simulate downstream reactive poll alongside active check
          return busy();
        });

        const first = style();
        expect(first).toBeDefined();
        expect(typeof (first as Record<string, string>)["--ui-shimmer-delay"]).toBe("string");

        // Ticking unrelated signals while busy() remains true must NOT recompute --ui-shimmer-delay
        setTick(1);
        setTick(2);
        expect(style()).toBe(first);

        // Turning off clears inline delay; re-activating mints a fresh phase-locked delay
        setBusy(false);
        expect(style()).toBeUndefined();
        setBusy(true);
        expect(style()).toBeDefined();

        // Reduced motion disables inline phase delay cleanly
        setReducedMotionOverride(true);
        expect(style()).toBeUndefined();
        expect(shimmerPhaseStyle(true)).toBeUndefined();

        dispose();
      });
    } finally {
      setReducedMotionOverride(null);
    }
  });

  test("useQueue.noteQueue preserves identical QueuedMessage references across snapshot pulls", () => {
    const q = createRoot(() =>
      createQueue({
        send: () => {},
        getSessionId: () => "s1",
        isOpen: () => true,
        isHostOnline: () => true,
        isSessionRunning: () => true,
        toast: () => {},
      }),
    );

    const payload = [
      {
        id: "int-1",
        text: "Fix shimmer jump",
        attachmentIds: ["a1"],
        model: "m1",
        yolo: false,
        createdAt: 100,
        delivery: "interrupt",
      },
      {
        id: "q-2",
        text: "Follow-up task",
        attachmentIds: [],
        model: "m1",
        yolo: false,
        createdAt: 101,
        delivery: "queue",
      },
    ];

    q.noteQueue("s1", payload);
    const firstStaged = q.stagedItems("s1")[0]!;
    expect(firstStaged.id).toBe("int-1");

    // Second pull with fresh plain objects but identical content keeps exact object reference
    q.noteQueue("s1", JSON.parse(JSON.stringify(payload)));
    expect(q.stagedItems("s1")[0]).toBe(firstStaged);

    // Updating the passive item still preserves the active interrupt item's reference
    const updatedPassive = JSON.parse(JSON.stringify(payload));
    updatedPassive[1].text = "Edited passive task";
    q.noteQueue("s1", updatedPassive);
    expect(q.stagedItems("s1")[0]).toBe(firstStaged);
    expect(q.passiveItems("s1")[0]?.text).toBe("Edited passive task");
  });

  test("StatusBanners uses <Index> for todos so setTodos updates never remount active shimmer items", () => {
    const statusSrc = readFileSync(
      join(repoRoot, "web/src/indirect-code/components/composer/StatusBanners.tsx"),
      "utf8",
    );
    expect(statusSrc).toContain("<Index each={t.todos()}>");
    expect(statusSrc).not.toContain("<For each={t.todos()}>");
  });
});
