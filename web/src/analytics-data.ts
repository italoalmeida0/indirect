import type { DailyPoint, ModelTimeline } from "./api";

export const analyticsFields = ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"] as const;
export type AnalyticsMetric = typeof analyticsFields[number];

export function analyticsTotals(points: DailyPoint[]) {
  const result = Object.fromEntries(analyticsFields.map((field) => [field, 0])) as Record<AnalyticsMetric, number>;
  for (const point of points) for (const field of analyticsFields) result[field] += point[field] ?? 0;
  return result;
}

/** Sum every bucket, including the last partial group. Chart density never
 * changes the total or averages cache percentages with the wrong weight. */
export function analyticsBuckets(points: DailyPoint[], limit = 48): Array<DailyPoint & { lastDate: string }> {
  const size = Math.max(1, Math.ceil(points.length / Math.max(1, limit)));
  const result: Array<DailyPoint & { lastDate: string }> = [];
  for (let start = 0; start < points.length; start += size) {
    const chunk = points.slice(start, start + size);
    const first = chunk[0]!;
    const last = chunk.at(-1)!;
    result.push({ ...analyticsTotals(chunk), date: first.date, lastDate: last.date, label: first.label });
  }
  return result;
}

/** Both top-five rankings keep the same color for a model, even when their
 * orders differ. Models unique to the request ranking use its free colors. */
export function modelColorIndices(spend: ModelTimeline, volume: ModelTimeline): ReadonlyMap<string, number> {
  const indices = new Map<string, number>();
  for (const group of spend.groups) if (group.id !== null) indices.set(group.id, indices.size);
  const used = new Set(volume.groups.flatMap((group) => group.id !== null && indices.has(group.id) ? [indices.get(group.id)!] : []));
  for (const group of volume.groups) {
    if (group.id === null || indices.has(group.id)) continue;
    const available = [0, 1, 2, 3, 4].find((index) => !used.has(index)) ?? 0;
    indices.set(group.id, available);
    used.add(available);
  }
  return indices;
}

export function cachePercent(input: number, cache: number): number | null {
  return input + cache > 0 ? cache / (input + cache) * 100 : null;
}
