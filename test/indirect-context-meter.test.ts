import { describe, expect, test } from "bun:test";
import {
  COMPACTION_RESERVE_TOKENS,
  computeBarZones,
  computeContextMeterMath,
  computeTokenMix,
  computeUsableLimit,
  hitTestBarZone,
  resolveContextUsed,
} from "../web/src/indirect-code/utils/contextMeter";

describe("contextMeter usable context & auto-compaction math", () => {
  test("computeUsableLimit mirrors daemon compactTargetTokens and 16,384 reserve clamp", () => {
    expect(COMPACTION_RESERVE_TOKENS).toBe(16_384);

    // 80% of 200K = 160K (headroom 40K >= 16,384)
    expect(computeUsableLimit(200_000, 80)).toBe(160_000);

    // 95% of 200K = 190K (headroom 10K < 16,384 -> clamped to 200,000 - 16,384 = 183,616)
    expect(computeUsableLimit(200_000, 95)).toBe(200_000 - 16_384);

    // 95% of 1M = 950K (headroom 50K >= 16,384 -> 950K)
    expect(computeUsableLimit(1_000_000, 95)).toBe(950_000);

    // Small context windows <= 16,384 preserve percentage without clamping to 1
    expect(computeUsableLimit(8_000, 80)).toBe(6_400);
    expect(computeUsableLimit(20_000, 90)).toBe(20_000 - 16_384);

    // Auto-compact Off (0) uses full window
    expect(computeUsableLimit(200_000, 0)).toBe(200_000);
    expect(computeUsableLimit(0, 80)).toBe(0);
  });

  test("computeContextMeterMath computes usableRemaining, percentages, and armed state", () => {
    const normal = computeContextMeterMath({
      used: 64_000,
      window: 200_000,
      autoCompactPercent: 80,
    });
    expect(normal.autoCompactEnabled).toBe(true);
    expect(normal.usableLimit).toBe(160_000);
    expect(normal.reserveTokens).toBe(40_000);
    expect(normal.thresholdRatio).toBeCloseTo(0.8, 5);
    expect(normal.usedRatio).toBeCloseTo(0.32, 5);
    expect(normal.usableRemaining).toBe(96_000);
    expect(normal.usableUsedPct).toBe(40);
    expect(normal.usableLeftPct).toBe(60);
    expect(normal.overThresholdTokens).toBe(0);
    expect(normal.isArmed).toBe(false);

    const armedOver = computeContextMeterMath({
      used: 172_400,
      window: 200_000,
      autoCompactPercent: 80,
    });
    expect(armedOver.usableRemaining).toBe(0);
    expect(armedOver.overThresholdTokens).toBe(12_400);
    expect(armedOver.usableUsedPct).toBe(108);
    expect(armedOver.usableLeftPct).toBe(0);
    expect(armedOver.isArmed).toBe(true);

    const off = computeContextMeterMath({
      used: 172_400,
      window: 200_000,
      autoCompactPercent: 0,
    });
    expect(off.autoCompactEnabled).toBe(false);
    expect(off.usableLimit).toBe(200_000);
    expect(off.reserveTokens).toBe(0);
    expect(off.thresholdRatio).toBe(1);
    expect(off.usableRemaining).toBe(27_600);
    expect(off.isArmed).toBe(false);

    const unconfigured = computeContextMeterMath({
      used: 42_000,
      window: 0,
      autoCompactPercent: 80,
    });
    expect(unconfigured.usableLimit).toBe(0);
    expect(unconfigured.usableRemaining).toBeNull();
    expect(unconfigured.usableUsedPct).toBeNull();
    expect(unconfigured.usableLeftPct).toBeNull();
    expect(unconfigured.isArmed).toBe(false);

    const emptySession = computeContextMeterMath({
      used: null,
      window: 200_000,
      autoCompactPercent: 80,
    });
    expect(emptySession.usableLimit).toBe(160_000);
    expect(emptySession.usableRemaining).toBeNull();
    expect(emptySession.usedRatio).toBe(0);
    expect(emptySession.isArmed).toBe(false);
  });

  test("resolveContextUsed handles full contextDisplay and partial test mocks", () => {
    expect(resolveContextUsed({ used: 64_200, window: 200_000, percent: 32 })).toBe(64_200);
    expect(resolveContextUsed({ used: null, window: 200_000, percent: null })).toBeNull();
    expect(resolveContextUsed({ window: 100_000, percent: 1 })).toBe(1_000);
    expect(resolveContextUsed({ window: 0, percent: null })).toBeNull();
  });

  test("computeTokenMix subtracts reasoningTok from outTok so weights never double-count", () => {
    const mix = computeTokenMix({
      inTok: 60_000,
      cacheTok: 100_000,
      outTok: 20_000,
      reasoningTok: 12_000,
    });
    expect(mix.inTok).toBe(60_000);
    expect(mix.cacheTok).toBe(100_000);
    expect(mix.outTok).toBe(20_000);
    expect(mix.netOutTok).toBe(8_000);
    expect(mix.reasoningTok).toBe(12_000);
    expect(mix.totalMixTok).toBe(180_000);

    // Defensive clamp if malformed data has reasoningTok > outTok
    const clamped = computeTokenMix({
      inTok: 1_000,
      cacheTok: 0,
      outTok: 500,
      reasoningTok: 800,
    });
    expect(clamped.netOutTok).toBe(0);
    expect(clamped.totalMixTok).toBe(1_800);

    expect(computeTokenMix(null).totalMixTok).toBe(0);
  });

  test("computeBarZones & hitTestBarZone partition segments, usable headroom, and reserve buffer accurately", () => {
    const zones = computeBarZones({
      cssW: 340,
      used: 100_000,
      window: 200_000,
      autoCompactPercent: 80,
      usage: {
        inTok: 40_000,
        cacheTok: 50_000,
        outTok: 10_000,
        reasoningTok: 200, // tiny slice -> enforced >= 6px minimum width
      },
    });

    // innerLeft = 2, innerRight = 338, innerW = 336, usedRatio = 0.5 -> totalOccupiedW = 168
    expect(zones.innerLeft).toBe(2);
    expect(zones.innerRight).toBe(338);
    expect(zones.totalOccupiedW).toBe(168);
    expect(zones.segments.map((s) => s.id)).toEqual([
      "input",
      "cache",
      "output",
      "reasoning",
    ]);

    // All 4 segments are 100% contiguous (zero inter-segment gap: seg[i].x1 === seg[i+1].x0)
    const sumSegW = zones.segments.reduce((acc, s) => acc + s.width, 0);
    expect(sumSegW).toBeCloseTo(zones.totalOccupiedW, 5);
    expect(zones.segments[0]?.x0).toBe(2);
    expect(zones.segments[zones.segments.length - 1]?.x1).toBeCloseTo(2 + 168, 5);
    for (let i = 0; i < zones.segments.length - 1; i++) {
      expect(zones.segments[i]!.x1).toBeCloseTo(zones.segments[i + 1]!.x0, 6);
    }
    const reasoningSeg = zones.segments.find((s) => s.id === "reasoning")!;
    expect(reasoningSeg.width).toBeGreaterThanOrEqual(6);

    expect(zones.thresholdX).toBe(2 + Math.round(336 * 0.8));
    expect(zones.usableZone).not.toBeNull();
    expect(zones.usableZone?.x0).toBeCloseTo(2 + 168, 5);
    expect(zones.reserveZone).not.toBeNull();
    expect(zones.reserveZone?.x1).toBe(338);

    // Hit-testing every zone across contiguous boundaries
    for (let i = 0; i < zones.segments.length; i++) {
      const seg = zones.segments[i]!;
      const mid = (seg.x0 + seg.x1) * 0.5;
      expect(hitTestBarZone(zones, mid)).toBe(seg.id);
    }
    expect(
      hitTestBarZone(zones, (zones.usableZone!.x0 + zones.usableZone!.x1) * 0.5),
    ).toBe("usable");
    expect(
      hitTestBarZone(zones, (zones.reserveZone!.x0 + zones.reserveZone!.x1) * 0.5),
    ).toBe("reserve");
    expect(hitTestBarZone(zones, -5)).toBeNull();
    expect(hitTestBarZone(zones, 999)).toBeNull();

    // 100% full symmetry: leftmost segment starts at 2, rightmost ends at cssW - 2 = 338
    const fullZones = computeBarZones({
      cssW: 340,
      used: 200_000,
      window: 200_000,
      autoCompactPercent: 80,
      usage: {
        inTok: 60_000,
        cacheTok: 100_000,
        outTok: 40_000,
        reasoningTok: 15_000,
      },
    });
    expect(fullZones.segments[0]?.x0).toBe(2);
    expect(fullZones.segments[fullZones.segments.length - 1]?.x1).toBe(338);
    expect(fullZones.usableZone).toBeNull();
    expect(fullZones.reserveZone).toBeNull();

    // Fallback single "context" segment when usage telemetry is absent
    const fallbackZones = computeBarZones({
      cssW: 340,
      used: 50_000,
      window: 200_000,
      autoCompactPercent: 80,
      usage: null,
    });
    expect(fallbackZones.segments).toHaveLength(1);
    expect(fallbackZones.segments[0]?.id).toBe("context");
    expect(hitTestBarZone(fallbackZones, 20)).toBe("context");
  });
});
