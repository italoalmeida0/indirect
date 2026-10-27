import { describe, expect, test } from "bun:test";
import type { DailyPoint } from "../web/src/api";
import { analyticsBuckets, analyticsTotals, cachePercent, modelColorIndices } from "../web/src/analytics-data";

const point = (index: number): DailyPoint => ({
  date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
  in_tok: index + 1, cache_tok: (index + 1) * 3, out_tok: (index + 1) * 2,
  reqs: index + 1, cost_in: (index + 1) * .001, cost_cache: (index + 1) * .0001,
  cost_out: (index + 1) * .004, cost: (index + 1) * .0051,
});

describe("analytics chart aggregation", () => {
  test("decade-long data stays bounded and preserves all totals, including the last partial bucket", () => {
    const source = Array.from({ length: 3653 }, (_, index) => point(index));
    const buckets = analyticsBuckets(source);
    expect(buckets.length).toBeLessThanOrEqual(48);
    expect(buckets.at(-1)!.date).toBe(source[3619]!.date);
    const before = analyticsTotals(source);
    const after = analyticsTotals(buckets);
    for (const field of Object.keys(before) as Array<keyof typeof before>) {
      expect(after[field]).toBeCloseTo(before[field], 6);
    }
    expect(buckets.at(-1)!.lastDate).toBe(source.at(-1)!.date);
    expect(source[0]).toEqual(point(0));
  });

  test("short ranges preserve individual dates and empty ranges have no invented activity", () => {
    const source = [point(0), point(1)];
    expect(analyticsBuckets(source)).toEqual(source.map((point) => ({ ...point, lastDate: point.date })));
    expect(analyticsBuckets([])).toEqual([]);
    expect(analyticsTotals([])).toEqual({ in_tok: 0, cache_tok: 0, out_tok: 0, reqs: 0, cost_in: 0, cost_cache: 0, cost_out: 0, cost: 0 });
  });

  test("cache hit rate uses token weights across the entire range", () => {
    const totals = analyticsTotals([{ ...point(0), in_tok: 90, cache_tok: 10 }, { ...point(1), in_tok: 0, cache_tok: 900 }]);
    expect(cachePercent(totals.in_tok, totals.cache_tok)).toBe(91);
    expect(cachePercent(0, 0)).toBeNull();
    expect(cachePercent(0, 100)).toBe(100);
    expect(cachePercent(100, 0)).toBe(0);
  });

  test("independent model rankings preserve colors and keep each legend distinct", () => {
    const ranking = (ids: Array<string | null>) => ({ groups: ids.map((id) => ({ id, label: id ?? "Other" })), points: [] });
    const spend = ranking(["a", "b", "c", "d", "e", null]);
    const requests = ranking(["e", "f", "b", "g", "h", null]);
    const colors = modelColorIndices(spend, requests);
    expect(colors.get("e")).toBe(4);
    expect(colors.get("b")).toBe(1);
    expect(new Set(requests.groups.filter((group) => group.id !== null).map((group) => colors.get(group.id!))).size).toBe(5);
    expect(colors.has("Other")).toBe(false);
    expect(modelColorIndices(ranking([]), ranking([])).size).toBe(0);
  });
});
