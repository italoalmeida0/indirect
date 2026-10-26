export interface AnalyticsRange {
  preset: string;
  from: number | null;
  /** Exclusive upper bound, shared by every query in the view. */
  to: number;
}

export const relativePeriods = [
  { id: "15m", label: "Past 15 minutes" },
  { id: "30m", label: "Past 30 minutes" },
  { id: "1h", label: "Past hour" },
  { id: "3h", label: "Past 3 hours" },
  { id: "1d", label: "Past 24 hours" },
  { id: "2d", label: "Past 48 hours" },
  { id: "1w", label: "Past week" },
  { id: "14d", label: "Past 2 weeks" },
  { id: "1mo", label: "Past month" },
  { id: "90d", label: "Past 90 days" },
  { id: "1y", label: "Past year" },
] as const;

export const calendarPeriods = [
  { id: "today", label: "Today" }, { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" }, { id: "prev-week", label: "Previous week" },
  { id: "month", label: "This month" }, { id: "prev-month", label: "Previous month" },
  { id: "year", label: "This year" }, { id: "prev-year", label: "Previous year" },
] as const;

export function rangeLabel(range: AnalyticsRange): string {
  return [...relativePeriods, ...calendarPeriods].find((p) => p.id === range.preset)?.label
    ?? (range.preset === "all" ? "All time" : "Custom range");
}

export function presetRange(preset: string, now = Date.now()): AnalyticsRange {
  const end = new Date(now);
  const start = new Date(now);
  const relative = /^(\d+)(m|h|d|w)$/.exec(preset);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return { preset, from: now - Number(relative[1]) * unit[relative[2] as keyof typeof unit], to: now };
  }
  if (preset === "all") return { preset, from: null, to: now };
  if (preset === "1mo" || preset === "1y") {
    // Clamp month ends (March 31 → February 28), rather than overflowing.
    const day = start.getDate();
    start.setDate(1);
    start.setMonth(start.getMonth() - (preset === "1y" ? 12 : 1));
    start.setDate(Math.min(day, new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()));
  } else {
    start.setHours(0, 0, 0, 0);
    if (preset.endsWith("week")) start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    if (preset.endsWith("month")) start.setDate(1);
    if (preset.endsWith("year")) start.setMonth(0, 1);
    if (preset === "yesterday" || preset.startsWith("prev-")) {
      end.setTime(start.getTime());
      if (preset === "yesterday") start.setDate(start.getDate() - 1);
      if (preset === "prev-week") start.setDate(start.getDate() - 7);
      if (preset === "prev-month") start.setMonth(start.getMonth() - 1);
      if (preset === "prev-year") start.setFullYear(start.getFullYear() - 1);
    }
  }
  return { preset, from: start.getTime(), to: end.getTime() };
}

export function rangeUnit(range: AnalyticsRange): "minute" | "hour" | "day" | "month" {
  const span = range.from === null ? Infinity : range.to - range.from;
  return span <= 3_600_000 ? "minute" : span <= 3 * 86_400_000 ? "hour" : span > 400 * 86_400_000 ? "month" : "day";
}

export function localDateTime(ts: number): string {
  const date = new Date(ts);
  return new Date(ts - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
