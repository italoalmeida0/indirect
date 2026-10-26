import { describe, expect, test } from "bun:test";
import { localDateTime, presetRange, rangeLabel, rangeUnit } from "../web/src/analytics-range";

describe("analytics time ranges", () => {
  test("relative windows preserve exact bounds and choose useful buckets", () => {
    const now = new Date(2026, 9, 26, 10, 26).getTime();
    const range = presetRange("15m", now);
    expect(range.from).toBe(now - 15 * 60_000);
    expect(range.to).toBe(now);
    expect(rangeUnit(range)).toBe("minute");
    expect(rangeUnit(presetRange("2d", now))).toBe("hour");
    expect(rangeUnit(presetRange("1mo", now))).toBe("day");
    expect(rangeUnit(presetRange("all", now))).toBe("day");
  });

  test("month and year subtraction clamp leap days and month ends", () => {
    expect(localDateTime(presetRange("1mo", new Date(2024, 2, 31, 9, 30).getTime()).from!)).toBe("2024-02-29T09:30");
    expect(localDateTime(presetRange("1mo", new Date(2025, 2, 31, 9, 30).getTime()).from!)).toBe("2025-02-28T09:30");
    expect(localDateTime(presetRange("1y", new Date(2024, 1, 29, 9, 30).getTime()).from!)).toBe("2023-02-28T09:30");
  });

  test("calendar windows use local midnight, Monday weeks and exclusive ends", () => {
    const now = new Date(2026, 9, 26, 10, 26).getTime();
    const yesterday = presetRange("yesterday", now);
    expect(localDateTime(yesterday.from!)).toBe("2026-10-25T00:00");
    expect(localDateTime(yesterday.to)).toBe("2026-10-26T00:00");
    const lastWeek = presetRange("prev-week", now);
    expect(localDateTime(lastWeek.from!)).toBe("2026-10-19T00:00");
    expect(localDateTime(lastWeek.to)).toBe("2026-10-26T00:00");
    const lastMonth = presetRange("prev-month", now);
    expect(localDateTime(lastMonth.from!)).toBe("2026-09-01T00:00");
    expect(localDateTime(lastMonth.to)).toBe("2026-10-01T00:00");
    expect(rangeLabel(lastMonth)).toBe("Previous month");
    expect(presetRange("all", now).from).toBeNull();
  });
});
