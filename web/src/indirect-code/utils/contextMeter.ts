export const COMPACTION_RESERVE_TOKENS = 16_384;

export type ContextSegmentId = "input" | "cache" | "output" | "reasoning" | "context";
export type ContextZoneId = ContextSegmentId | "usable" | "reserve";

export interface ContextMeterInput {
  used: number | null;
  window: number;
  autoCompactPercent: number;
}

export interface ContextMeterMath {
  window: number;
  used: number | null;
  autoCompactEnabled: boolean;
  autoCompactPercent: number;
  usableLimit: number;
  reserveTokens: number;
  thresholdRatio: number;
  usedRatio: number;
  usableRemaining: number | null;
  overThresholdTokens: number;
  usableUsedPct: number | null;
  usableLeftPct: number | null;
  isArmed: boolean;
}

export interface UsageBreakdownInput {
  inTok?: number;
  cacheTok?: number;
  outTok?: number;
  reasoningTok?: number;
}

export interface TokenMixBreakdown {
  inTok: number;
  cacheTok: number;
  /** Total output tokens reported by provider (includes reasoningTok). */
  outTok: number;
  /** Non-reasoning output tokens: Math.max(0, outTok - reasoningTok). */
  netOutTok: number;
  reasoningTok: number;
  /** Non-double-counted sum: inTok + cacheTok + netOutTok + reasoningTok. */
  totalMixTok: number;
}

export interface BarSegmentLayout {
  id: ContextSegmentId;
  x0: number;
  x1: number;
  width: number;
  weight: number;
  tokens: number;
}

export interface BarSpanLayout {
  id: "usable" | "reserve";
  x0: number;
  x1: number;
  width: number;
}

export interface BarZonesLayout {
  cssW: number;
  innerLeft: number;
  innerRight: number;
  innerW: number;
  usedRatio: number;
  thresholdRatio: number;
  totalOccupiedW: number;
  occupiedEndX: number;
  thresholdX: number | null;
  segments: BarSegmentLayout[];
  usableZone: BarSpanLayout | null;
  reserveZone: BarSpanLayout | null;
}

/**
 * Resolves used token count from contextDisplay() output, including partial
 * browser test fixtures that omit `used` while supplying `window` and `percent`.
 */
export function resolveContextUsed(ctx: {
  used?: number | null;
  window: number;
  percent: number | null;
}): number | null {
  if (ctx.used !== undefined) return ctx.used;
  if (typeof ctx.percent === "number" && Number.isFinite(ctx.percent) && ctx.window > 0) {
    return Math.round((ctx.window * ctx.percent) / 100);
  }
  return null;
}

/**
 * Mirrors daemon `compactTargetTokens(window, thresholdPct)` (`packages/core/compaction.go`):
 * - `0` (or `<= 0`) disables proactive auto-compaction (`usableLimit = window`, `reserveTokens = 0`).
 * - `0 < thresholdPct < 100`: `Math.floor((window * thresholdPct) / 100)`, clamped so at least
 *   `COMPACTION_RESERVE_TOKENS` (`16_384`) remain reserved when `window > 16_384`.
 */
export function computeUsableLimit(windowTokens: number, thresholdPct: number): number {
  const win = Number.isFinite(windowTokens) && windowTokens > 0 ? Math.floor(windowTokens) : 0;
  if (win <= 0) return 0;
  const pct = Number.isFinite(thresholdPct) ? Math.round(thresholdPct) : 0;
  if (pct > 0 && pct < 100) {
    const rawTarget = Math.floor((win * pct) / 100);
    if (win > COMPACTION_RESERVE_TOKENS && win - rawTarget < COMPACTION_RESERVE_TOKENS) {
      return Math.max(1, win - COMPACTION_RESERVE_TOKENS);
    }
    return Math.max(1, rawTarget);
  }
  return win;
}

export function computeContextMeterMath(input: ContextMeterInput): ContextMeterMath {
  const win = Number.isFinite(input.window) && input.window > 0 ? Math.floor(input.window) : 0;
  const rawPct = Number.isFinite(input.autoCompactPercent) ? Math.round(input.autoCompactPercent) : 80;
  const normalizedPct = rawPct > 0 && rawPct < 100 ? rawPct : 0;
  const autoCompactEnabled = win > 0 && normalizedPct > 0;
  const used =
    input.used !== null && input.used !== undefined && Number.isFinite(input.used)
      ? Math.max(0, Math.round(input.used))
      : null;

  const usableLimit = computeUsableLimit(win, normalizedPct);
  const reserveTokens = win > 0 ? Math.max(0, win - usableLimit) : 0;
  const thresholdRatio = win > 0 ? Math.min(1, Math.max(0, usableLimit / win)) : 1;
  const usedRatio = used !== null && win > 0 ? Math.min(1, Math.max(0, used / win)) : 0;

  const usableRemaining = used !== null && win > 0 ? Math.max(0, usableLimit - used) : null;
  const overThresholdTokens =
    used !== null && win > 0 && used > usableLimit ? used - usableLimit : 0;
  const usableUsedPct =
    used !== null && usableLimit > 0 ? Math.round((used * 100) / usableLimit) : null;
  const usableLeftPct =
    usableRemaining !== null && usableLimit > 0
      ? Math.max(0, Math.round((usableRemaining * 100) / usableLimit))
      : null;
  const isArmed = autoCompactEnabled && used !== null && used >= usableLimit;

  return {
    window: win,
    used,
    autoCompactEnabled,
    autoCompactPercent: normalizedPct,
    usableLimit,
    reserveTokens,
    thresholdRatio,
    usedRatio,
    usableRemaining,
    overThresholdTokens,
    usableUsedPct,
    usableLeftPct,
    isArmed,
  };
}

/**
 * Splits cumulative session telemetry without double-counting `reasoningTok`
 * (daemon `OutputTokens` already includes `ReasoningTokens`).
 */
export function computeTokenMix(usage: UsageBreakdownInput | null | undefined): TokenMixBreakdown {
  if (!usage) {
    return {
      inTok: 0,
      cacheTok: 0,
      outTok: 0,
      netOutTok: 0,
      reasoningTok: 0,
      totalMixTok: 0,
    };
  }
  const inTok = Math.max(0, Math.round(usage.inTok || 0));
  const cacheTok = Math.max(0, Math.round(usage.cacheTok || 0));
  const outTok = Math.max(0, Math.round(usage.outTok || 0));
  const reasoningTok = Math.max(0, Math.round(usage.reasoningTok || 0));
  const netOutTok = Math.max(0, outTok - reasoningTok);
  const totalMixTok = inTok + cacheTok + netOutTok + reasoningTok;

  return {
    inTok,
    cacheTok,
    outTok,
    netOutTok,
    reasoningTok,
    totalMixTok,
  };
}

/**
 * Allocates pixel widths across non-zero segments with `segGap` separation
 * between adjacent segment capsules while enforcing a minimum visual width
 * (`7px` when space allows) so small slices retain complete 4-sided borders.
 */
function allocateSegmentWidths(
  items: Array<{ id: ContextSegmentId; tokens: number }>,
  totalW: number,
  segGap = 1.5,
): BarSegmentLayout[] {
  if (items.length === 0 || totalW <= 0) return [];
  const totalTok = items.reduce((acc, it) => acc + it.tokens, 0);
  if (totalTok <= 0) return [];

  const gapCount = Math.max(0, items.length - 1);
  const effectiveGap =
    gapCount > 0
      ? Math.max(0, Math.min(segGap, (totalW - items.length * 4) / gapCount))
      : 0;
  const availW = Math.max(0, totalW - effectiveGap * gapCount);

  const minSegW = Math.min(7, availW / items.length);
  const widths = new Array<number>(items.length).fill(0);
  const locked = new Array<boolean>(items.length).fill(false);

  let remW = availW;
  let remTok = totalTok;

  for (let pass = 0; pass < items.length; pass++) {
    let lockedAny = false;
    for (let i = 0; i < items.length; i++) {
      if (locked[i]) continue;
      const ideal = remTok > 0 ? (items[i]!.tokens / remTok) * remW : remW / items.length;
      if (ideal < minSegW) {
        widths[i] = minSegW;
        locked[i] = true;
        remW = Math.max(0, remW - minSegW);
        remTok = Math.max(0, remTok - items[i]!.tokens);
        lockedAny = true;
      }
    }
    if (!lockedAny) break;
  }

  const unlockedIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!locked[i]) unlockedIndices.push(i);
  }
  if (unlockedIndices.length > 0) {
    for (const idx of unlockedIndices) {
      widths[idx] =
        remTok > 0 ? (items[idx]!.tokens / remTok) * remW : remW / unlockedIndices.length;
    }
  }

  const out: BarSegmentLayout[] = [];
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const x0 = cursor;
    const x1 = i === items.length - 1 ? totalW : Math.min(totalW, cursor + widths[i]!);
    cursor = x1 + effectiveGap;
    out.push({
      id: items[i]!.id,
      x0,
      x1,
      width: Math.max(0, x1 - x0),
      weight: items[i]!.tokens / totalTok,
      tokens: items[i]!.tokens,
    });
  }
  return out;
}

export function computeBarZones(params: {
  cssW: number;
  used: number | null;
  window: number;
  autoCompactPercent: number;
  usage: UsageBreakdownInput | null | undefined;
  inset?: number;
}): BarZonesLayout {
  const inset = params.inset ?? 2.5;
  const cssW = Math.max(0, params.cssW);
  const innerLeft = Math.min(inset, cssW * 0.5);
  const innerRight = Math.max(innerLeft, cssW - inset);
  const innerW = Math.max(0, innerRight - innerLeft);

  const math = computeContextMeterMath({
    used: params.used,
    window: params.window,
    autoCompactPercent: params.autoCompactPercent,
  });
  const mix = computeTokenMix(params.usage);

  let totalOccupiedW = 0;
  if (math.window > 0 && math.used !== null && math.used > 0 && innerW > 0) {
    const rawW =
      math.usedRatio >= 0.999 ? innerW : Math.round(innerW * math.usedRatio);
    totalOccupiedW = Math.min(innerW, Math.max(Math.min(7, innerW), rawW));
  }

  const occupiedEndX = innerLeft + totalOccupiedW;
  let segments: BarSegmentLayout[] = [];

  if (totalOccupiedW > 0) {
    if (mix.totalMixTok > 0) {
      const nonZero: Array<{ id: ContextSegmentId; tokens: number }> = [];
      if (mix.inTok > 0) nonZero.push({ id: "input", tokens: mix.inTok });
      if (mix.cacheTok > 0) nonZero.push({ id: "cache", tokens: mix.cacheTok });
      if (mix.netOutTok > 0) nonZero.push({ id: "output", tokens: mix.netOutTok });
      if (mix.reasoningTok > 0) nonZero.push({ id: "reasoning", tokens: mix.reasoningTok });
      segments = allocateSegmentWidths(nonZero, totalOccupiedW, 1.5).map((s) => ({
        ...s,
        x0: innerLeft + s.x0,
        x1: innerLeft + s.x1,
      }));
    } else {
      segments = [
        {
          id: "context",
          x0: innerLeft,
          x1: occupiedEndX,
          width: totalOccupiedW,
          weight: 1,
          tokens: math.used ?? 0,
        },
      ];
    }
  }

  let thresholdX: number | null = null;
  let usableZone: BarSpanLayout | null = null;
  let reserveZone: BarSpanLayout | null = null;

  if (math.window > 0 && innerW > 0) {
    if (math.autoCompactEnabled) {
      const rawTx = innerLeft + Math.round(innerW * math.thresholdRatio);
      const minReservePx = Math.min(10, innerW * 0.25);
      thresholdX = Math.max(
        innerLeft + Math.min(6, innerW),
        Math.min(innerRight - minReservePx, rawTx),
      );
      const usableStart = totalOccupiedW > 0 ? occupiedEndX + 1.5 : innerLeft;
      const usableEnd = thresholdX - 1;
      if (usableEnd - usableStart >= 4) {
        usableZone = {
          id: "usable",
          x0: usableStart,
          x1: usableEnd,
          width: usableEnd - usableStart,
        };
      }
      const reserveStart =
        totalOccupiedW > 0 && occupiedEndX >= thresholdX
          ? occupiedEndX + 1.5
          : thresholdX + 1;
      if (innerRight - reserveStart >= 4) {
        reserveZone = {
          id: "reserve",
          x0: reserveStart,
          x1: innerRight,
          width: innerRight - reserveStart,
        };
      }
    } else {
      const usableStart = totalOccupiedW > 0 ? occupiedEndX + 1.5 : innerLeft;
      if (innerRight - usableStart >= 4) {
        usableZone = {
          id: "usable",
          x0: usableStart,
          x1: innerRight,
          width: innerRight - usableStart,
        };
      }
    }
  }

  return {
    cssW,
    innerLeft,
    innerRight,
    innerW,
    usedRatio: math.usedRatio,
    thresholdRatio: math.thresholdRatio,
    totalOccupiedW,
    occupiedEndX,
    thresholdX,
    segments,
    usableZone,
    reserveZone,
  };
}

export function hitTestBarZone(zones: BarZonesLayout, localX: number): ContextZoneId | null {
  if (!Number.isFinite(localX) || localX < 0 || localX > zones.cssW || zones.innerW <= 0) {
    return null;
  }
  const clampedX = Math.max(zones.innerLeft, Math.min(zones.innerRight, localX));

  if (zones.totalOccupiedW > 0 && zones.segments.length > 0 && clampedX <= zones.occupiedEndX + 0.75) {
    for (let i = 0; i < zones.segments.length; i++) {
      const seg = zones.segments[i]!;
      const rightSplit =
        i < zones.segments.length - 1
          ? (seg.x1 + zones.segments[i + 1]!.x0) * 0.5
          : zones.occupiedEndX + 0.75;
      if (clampedX <= rightSplit) {
        return seg.id;
      }
    }
  }

  if (
    zones.usableZone &&
    clampedX > zones.occupiedEndX + 0.75 &&
    clampedX <= (zones.thresholdX ?? zones.innerRight)
  ) {
    return "usable";
  }

  if (zones.reserveZone && clampedX >= (zones.thresholdX ?? zones.reserveZone.x0)) {
    return "reserve";
  }

  return null;
}
