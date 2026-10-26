import type { DailyPoint } from "./api";

const DAY = 86_400_000;
const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const monthName = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });

export interface ActivityCell {
  key: string;
  label: string;
  /** Null is outside the selected range; zero is a selected, inactive bucket. */
  count: number | null;
  level: number;
  column: number;
  row: number;
}

export interface ActivityScope {
  from: number | null;
  to: number;
  unit: "minute" | "hour" | "day" | "month";
}

function dayStart(time: number): number { return Math.floor(time / DAY) * DAY; }
function monday(time: number): number { return time - ((new Date(time).getUTCDay() + 6) % 7) * DAY; }
function monthIndex(time: number): number {
  const date = new Date(time);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}
function monthTime(index: number): number { return Date.UTC(Math.floor(index / 12), index % 12, 1); }

/** Reuse the bounded analytics series. Never infer daily traffic from monthly rollups. */
export function buildRequestActivity(points: DailyPoint[], scope: ActivityScope) {
  const monthly = scope.unit === "month";
  const counts = new Map<number, number>();
  for (const point of points) {
    const time = Date.parse(`${point.date.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    const key = monthly ? monthIndex(time) : time;
    const count = Number.isFinite(point.reqs) ? Math.max(0, Math.trunc(point.reqs)) : 0;
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  const end = monthly ? monthIndex(scope.to - 1) : dayStart(scope.to - 1);
  const start = scope.from === null
    ? (counts.size ? Math.min(...counts.keys()) : end)
    : monthly ? monthIndex(scope.from) : dayStart(scope.from);
  // Daily endpoints are capped at 400 days by the API; wider scopes use months.
  // A malformed response must not allocate an unbounded calendar in the browser.
  const valid = Number.isFinite(start) && Number.isFinite(end) && scope.to > (scope.from ?? 0) && end >= start && end - start <= (monthly ? 4000 : 401 * DAY);
  const cells: ActivityCell[] = [];
  const columnLabels: { column: number; label: string }[] = [];
  const rowLabels: string[] = monthly ? [] : ["Mon", "", "Wed", "", "Fri", "", ""];
  let columns = monthly ? 12 : 53;
  if (valid) {
    if (monthly) {
      const firstYear = Math.floor(start / 12);
      const lastYear = Math.floor(end / 12);
      for (let column = 0; column < 12; column++) columnLabels.push({ column, label: monthName.format(monthTime(firstYear * 12 + column)) });
      for (let year = firstYear; year <= lastYear; year++) {
        rowLabels.push(String(year));
        for (let month = 0; month < 12; month++) {
          const index = year * 12 + month;
          const time = monthTime(index);
          cells.push({ key: new Date(time).toISOString().slice(0, 7), label: monthFormat.format(time), count: index >= start && index <= end ? counts.get(index) ?? 0 : null, level: 0, column: month, row: year - firstYear });
        }
      }
    } else {
      const firstWeek = Math.min(monday(start), monday(end) - 52 * 7 * DAY);
      const lastDay = monday(end) + 6 * DAY;
      columns = Math.round((lastDay - firstWeek + DAY) / (7 * DAY));
      let lastMonth = -1;
      for (let time = firstWeek, index = 0; time <= lastDay; time += DAY, index++) {
        const date = new Date(time);
        const column = Math.floor(index / 7);
        if (index % 7 === 0 && date.getUTCMonth() !== lastMonth) {
          lastMonth = date.getUTCMonth();
          // Leave room for the final month label instead of overflowing the grid.
          if (column < columns - 1) columnLabels.push({ column, label: `${monthName.format(time)}${date.getUTCMonth() === 0 ? ` ${date.getUTCFullYear()}` : ""}` });
        }
        cells.push({ key: date.toISOString().slice(0, 10), label: dateFormat.format(time), count: time >= start && time <= end ? counts.get(time) ?? 0 : null, level: 0, column, row: index % 7 });
      }
    }
  }
  for (let index = columnLabels.length - 2; !monthly && index >= 0; index--) {
    if (columnLabels[index + 1]!.column - columnLabels[index]!.column < 3) columnLabels.splice(index, 1);
  }
  const selected = cells.filter((cell) => cell.count !== null);
  const positive = selected.map((cell) => cell.count!).filter((count) => count > 0).sort((a, b) => a - b);
  const thresholds = [.25, .5, .75].map((fraction) => positive[Math.min(positive.length - 1, Math.floor(positive.length * fraction))] ?? 0);
  for (const cell of selected) {
    if (cell.count! > 0) cell.level = 1 + thresholds.filter((threshold) => cell.count! >= threshold).length;
  }
  const total = selected.reduce((sum, cell) => sum + cell.count!, 0);
  const peak = selected.reduce<ActivityCell | null>((best, cell) => !best || cell.count! >= best.count! ? cell : best, null);
  return {
    monthly, cells, columns, rowLabels, columnLabels, total,
    active: positive.length, periods: selected.length,
    average: selected.length ? total / selected.length : 0,
    peak: peak?.count ? peak : null,
    first: selected[0]?.label, last: selected.at(-1)?.label,
  };
}
