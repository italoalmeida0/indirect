import { describe, expect, test } from "bun:test";
import type { DailyPoint } from "../web/src/api";
import { buildRequestActivity } from "../web/src/overview-activity";

const point = (date: string, reqs: number): DailyPoint => ({ date, reqs, in_tok: 0, cache_tok: 0, out_tok: 0 });
const time = (date: string) => Date.parse(date);

describe("overview request activity", () => {
  test("two weeks render only their calendar weeks instead of a padded year", () => {
    const view = buildRequestActivity([], { from: time("2026-10-12T10:00Z"), to: time("2026-10-26T10:00Z"), unit: "day" });
    expect(view.columns).toBe(3);
    expect(view.cells).toHaveLength(21);
    expect(view.periods).toBe(15);
    expect(view.short).toBe(true);
    expect(view.panels).toHaveLength(1);
    expect(view.panels[0]!.columns).toBe(7);
    expect(view.panels[0]!.rowLabels).toHaveLength(3);
    expect(view.panels[0]!.cells.find((cell) => cell.key === "2026-10-26")).toMatchObject({ column: 0, row: 2 });
  });

  test("narrow layouts wrap every selected day without dropping or duplicating traffic", () => {
    const from = time("2025-01-01T00:00Z");
    const series = Array.from({ length: 365 }, (_, index) => point(new Date(from + index * 86_400_000).toISOString().slice(0, 10), index));
    const view = buildRequestActivity(series, { from, to: time("2026-01-01T00:00Z"), unit: "day" }, 10);
    const cells = view.panels.flatMap((panel) => panel.cells).filter((cell) => cell.count !== null);
    expect(view.short).toBe(false);
    expect(view.panels.length).toBeGreaterThan(1);
    expect(view.panels.every((panel) => panel.columns <= 10 && panel.rowLabels.length === 7)).toBe(true);
    expect(cells).toHaveLength(365);
    expect(new Set(cells.map((cell) => cell.key)).size).toBe(365);
    expect(cells.reduce((sum, cell) => sum + cell.count!, 0)).toBe(view.total);
  });

  test("monthly history splits into half-year panels on narrow screens", () => {
    const series = Array.from({ length: 120 }, (_, month) => point(new Date(Date.UTC(2016, month, 1)).toISOString().slice(0, 10), month));
    const view = buildRequestActivity(series, { from: null, to: time("2026-01-01T00:00Z"), unit: "month" }, 7);
    expect(view.panels).toHaveLength(2);
    expect(view.panels.every((panel) => panel.columns === 6)).toBe(true);
    const cells = view.panels.flatMap((panel) => panel.cells);
    expect(cells).toHaveLength(120);
    expect(new Set(cells.map((cell) => cell.key)).size).toBe(120);
    expect(cells.reduce((sum, cell) => sum + (cell.count ?? 0), 0)).toBe(view.total);
  });

  test("folds minute and hour buckets into UTC days without losing requests", () => {
    const view = buildRequestActivity([
      point("2026-10-25 23:00 UTC", 13), point("2026-10-25 23:59 UTC", 2), point("2026-10-26 00:00 UTC", 7),
    ], { from: time("2026-10-25T23:00Z"), to: time("2026-10-26T00:01Z"), unit: "minute" });
    expect(view.cells.filter((cell) => cell.count !== null).map((cell) => [cell.key, cell.count])).toEqual([["2026-10-25", 15], ["2026-10-26", 7]]);
    expect(view.total).toBe(22);
    expect(view.average).toBe(11);
    expect(view.peak?.key).toBe("2026-10-25");
  });

  test("respects exclusive ends and distinguishes inactive days from outside dates", () => {
    const view = buildRequestActivity([point("2026-10-25", 5), point("2026-10-26", 99)], {
      from: time("2026-10-24T00:00Z"), to: time("2026-10-26T00:00Z"), unit: "day",
    });
    expect(view.cells.find((cell) => cell.key === "2026-10-24")?.count).toBe(0);
    expect(view.cells.find((cell) => cell.key === "2026-10-23")?.count).toBeNull();
    expect(view.cells.some((cell) => cell.key === "2026-10-26" && cell.count !== null)).toBe(false);
    expect(view.total).toBe(5);
    expect(view.periods).toBe(2);
    expect(view.active).toBe(1);
    expect(view.cells.every((cell) => new Date(`${cell.key}T00:00Z`).getUTCDay() === (cell.row + 1) % 7)).toBe(true);
  });

  test("keeps leap days and all days in the largest daily range", () => {
    const from = time("2024-01-01T00:00Z");
    const view = buildRequestActivity([point("2024-02-29", 37)], { from, to: from + 400 * 86_400_000, unit: "day" });
    expect(view.periods).toBe(400);
    expect(view.cells.find((cell) => cell.key === "2024-02-29")?.count).toBe(37);
    expect(view.columns).toBeGreaterThan(53);
    expect(view.cells.length).toBeLessThanOrEqual(413);
  });

  test("keeps monthly rollups monthly, including partial boundary months", () => {
    const view = buildRequestActivity([
      point("2024-12-01", 4), point("2025-01-01", 10), point("2025-02-01", 20), point("2025-03-01", 999),
    ], { from: time("2024-12-29T18:00Z"), to: time("2025-03-01T00:00Z"), unit: "month" });
    expect(view.monthly).toBe(true);
    expect(view.rowLabels).toEqual(["2024", "2025"]);
    expect(view.cells.filter((cell) => cell.count !== null).map((cell) => [cell.key, cell.count])).toEqual([["2024-12", 4], ["2025-01", 10], ["2025-02", 20]]);
    expect(view.total).toBe(34);
    expect(view.periods).toBe(3);
    expect(view.columnLabels).toHaveLength(12);
  });

  test("all history starts at the first returned month and handles ten years in 120 cells", () => {
    const series = Array.from({ length: 120 }, (_, month) => point(new Date(Date.UTC(2016, month, 1)).toISOString().slice(0, 10), month));
    const view = buildRequestActivity(series, { from: null, to: time("2026-01-01T00:00Z"), unit: "month" });
    expect(view.cells).toHaveLength(120);
    expect(view.periods).toBe(120);
    expect(view.total).toBe(series.reduce((sum, row) => sum + row.reqs, 0));
    expect(view.peak?.key).toBe("2025-12");
    expect(new Set(view.cells.map((cell) => cell.key)).size).toBe(view.cells.length);
  });

  test("zero activity has no peak or positive intensity", () => {
    const view = buildRequestActivity([], { from: time("2026-10-01T00:00Z"), to: time("2026-10-04T00:00Z"), unit: "day" });
    expect(view.periods).toBe(3);
    expect(view.active).toBe(0);
    expect(view.average).toBe(0);
    expect(view.peak).toBeNull();
    expect(view.cells.every((cell) => cell.level === 0)).toBe(true);
  });

  test("intensity follows request volume and invalid values cannot poison the calendar", () => {
    const series = [0, 1, 10, 100, 1000, NaN, -10].map((count, index) => point(`2026-10-0${index + 1}`, count));
    series.push(point("bad date", 1e6));
    const view = buildRequestActivity(series, { from: time("2026-10-01T00:00Z"), to: time("2026-10-08T00:00Z"), unit: "day" });
    const selected = view.cells.filter((cell) => cell.count !== null);
    expect(selected.slice(0, 5).map((cell) => cell.level)).toEqual([0, 1, 2, 3, 4]);
    expect(view.total).toBe(1111);
    expect(view.active).toBe(4);
  });

  test("rejects inverted or unbounded daily scopes instead of allocating huge grids", () => {
    const from = time("1970-01-01T00:00Z");
    expect(buildRequestActivity([], { from, to: Date.now(), unit: "day" }).cells).toHaveLength(0);
    expect(buildRequestActivity([], { from: Date.now(), to: from, unit: "month" }).cells).toHaveLength(0);
  });
});
