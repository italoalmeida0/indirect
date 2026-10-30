/** Rebuild retained sub-day analytics from raw events, preferably offline.
 * Example: DATA_DIR=./data bun scripts/rebuild-usage-rollups.ts --raw-from=2026-08-01
 * --raw-from must be the first complete UTC day of retained raw events. */
import { db } from "../server/db";
import { LIMITS } from "../server/config";
import { rebuildUsageRollups, USAGE_DAY } from "../server/usage-rollup";

const argument = (name: string) => process.argv.slice(2).find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
function day(value: string | undefined, name: string): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be a UTC date (YYYY-MM-DD)`);
  const ts = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isSafeInteger(ts) || new Date(ts).toISOString().slice(0, 10) !== value) throw new Error(`Invalid ${name}`);
  return ts;
}

const rawFrom = day(argument("raw-from"), "raw-from");
const today = Math.floor(Date.now() / USAGE_DAY) * USAGE_DAY;
const from = argument("from") ? day(argument("from"), "from") : Math.max(rawFrom, today - (LIMITS.analyticsHourlyDays - 1) * USAGE_DAY);
const minuteFrom = argument("minute-from") ? day(argument("minute-from"), "minute-from") : Math.max(from, today - (LIMITS.analyticsMinuteDays - 1) * USAGE_DAY);
const to = argument("to") ? day(argument("to"), "to") : today + USAGE_DAY;
const coverage = rebuildUsageRollups(db, { from, to, rawFrom, minuteFrom, onDay: (ts) => console.log(`[usage-rollup] rebuilt ${new Date(ts).toISOString().slice(0, 10)}`) });
console.log("[usage-rollup] coverage:", JSON.stringify(coverage));
