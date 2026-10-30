import type { Database } from "bun:sqlite";

export const USAGE_DAY = 86_400_000;
export const USAGE_HOUR = 3_600_000;
export const USAGE_MINUTE = 60_000;
export type RollupKind = "hour" | "minute";

export interface UsageRollupCoverage { raw_from: number; hourly_from: number; minute_from: number }

export function usageRollupCoverage(db: Database): UsageRollupCoverage {
  return db.query<UsageRollupCoverage, []>("SELECT raw_from, hourly_from, minute_from FROM usage_rollup_coverage WHERE id = 1").get()!;
}

/** Called in the same transaction as the event and daily/monthly ledgers. */
export function prepareUsageRollupUpsert(db: Database, kind: RollupKind) {
  return db.prepare(`INSERT INTO usage_${kind}_rollups
    (bucket, key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model,
     in_tok, cache_tok, out_tok, reqs, success_reqs, error_reqs, cost_in_nanos, cost_cache_nanos, cost_out_nanos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket, key_id, proto, provider_id, provider_key_id, model, upstream_model) DO UPDATE SET
      in_tok = in_tok + excluded.in_tok, cache_tok = cache_tok + excluded.cache_tok,
      out_tok = out_tok + excluded.out_tok, reqs = reqs + 1,
      success_reqs = success_reqs + excluded.success_reqs, error_reqs = error_reqs + excluded.error_reqs,
      cost_in_nanos = COALESCE(cost_in_nanos, 0) + excluded.cost_in_nanos,
      cost_cache_nanos = COALESCE(cost_cache_nanos, 0) + excluded.cost_cache_nanos,
      cost_out_nanos = COALESCE(cost_out_nanos, 0) + excluded.cost_out_nanos`);
}

export interface RebuildUsageRollupsOptions {
  /** UTC day boundaries, [from,to). `to` covers the current day. */
  from: number;
  to: number;
  /** First day with complete retained raw events, explicitly declared by the operator. */
  rawFrom: number;
  /** First day to rebuild minute-level rows; hours are rebuilt from `from`. */
  minuteFrom: number;
  onDay?: (day: number) => void;
}

/** Replace rollups from actual events one day at a time. Each day and its
 *  coverage advance commit atomically. Live ingestion is safe, but running
 *  offline avoids temporarily contending with the gateway for its writer. */
export function rebuildUsageRollups(db: Database, opts: RebuildUsageRollupsOptions): UsageRollupCoverage {
  const { from, to, rawFrom, minuteFrom } = opts;
  for (const value of [from, to, rawFrom, minuteFrom]) {
    if (!Number.isSafeInteger(value) || value < 0 || value % USAGE_DAY !== 0) throw new Error("Rollup rebuild bounds must be nonnegative UTC day boundaries");
  }
  const current = usageRollupCoverage(db);
  if (from < rawFrom || (rawFrom < current.raw_from && from !== rawFrom) || minuteFrom < from || minuteFrom >= to || to <= from || to < current.hourly_from || to < current.minute_from) {
    throw new Error("Rollup rebuild must bridge existing coverage and include the current retained range");
  }
  const insert = (kind: RollupKind, unit: number) => db.prepare(`INSERT INTO usage_${kind}_rollups
    (bucket, key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model,
     in_tok, cache_tok, out_tok, reqs, success_reqs, error_reqs, cost_in_nanos, cost_cache_nanos, cost_out_nanos)
    SELECT CAST(ts / ${unit} AS INTEGER) * ${unit} AS bucket, key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model,
      SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*), SUM(status >= 200 AND status < 300), SUM(status < 200 OR status >= 300),
      SUM(cost_in_nanos), SUM(cost_cache_nanos), SUM(cost_out_nanos)
    FROM usage_events WHERE ts >= ? AND ts < ?
    GROUP BY bucket, key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model`);
  const hourInsert = insert("hour", USAGE_HOUR), minuteInsert = insert("minute", USAGE_MINUTE);
  const deleteHour = db.prepare("DELETE FROM usage_hour_rollups WHERE bucket >= ? AND bucket < ?");
  const deleteMinute = db.prepare("DELETE FROM usage_minute_rollups WHERE bucket >= ? AND bucket < ?");
  const dailyCount = db.prepare<{ n: number }, [string]>("SELECT COALESCE(SUM(reqs), 0) AS n FROM usage_model_provider_daily WHERE date = ?");
  const hourlyCount = db.prepare<{ n: number }, [number, number]>("SELECT COALESCE(SUM(reqs), 0) AS n FROM usage_hour_rollups WHERE bucket >= ? AND bucket < ?");
  const advanceHour = db.prepare("UPDATE usage_rollup_coverage SET hourly_from = MAX(hour_floor, MIN(hourly_from, ?)) WHERE id = 1");
  const advanceMinute = db.prepare("UPDATE usage_rollup_coverage SET minute_from = MAX(minute_floor, MIN(minute_from, ?)) WHERE id = 1");
  const advanceRaw = db.prepare("UPDATE usage_rollup_coverage SET raw_from = ? WHERE id = 1");
  try {
    for (let day = to - USAGE_DAY; day >= from; day -= USAGE_DAY) {
      db.transaction(() => {
        deleteHour.run(day, day + USAGE_DAY);
        hourInsert.run(day, day + USAGE_DAY);
        if (day >= minuteFrom) {
          deleteMinute.run(day, day + USAGE_DAY);
          minuteInsert.run(day, day + USAGE_DAY);
          advanceMinute.run(day);
        }
        if (day >= rawFrom) {
          const expected = dailyCount.get(new Date(day).toISOString().slice(0, 10))!.n;
          const actual = hourlyCount.get(day, day + USAGE_DAY)!.n;
          if (expected !== actual) throw new Error(`Raw event count does not match the daily ledger for ${new Date(day).toISOString().slice(0, 10)}`);
        }
        advanceHour.run(day);
      }).immediate();
      opts.onDay?.(day);
    }
    advanceRaw.run(rawFrom);
    return usageRollupCoverage(db);
  } finally {
    for (const statement of [hourInsert, minuteInsert, deleteHour, deleteMinute, dailyCount, hourlyCount, advanceHour, advanceMinute, advanceRaw]) statement.finalize();
  }
}

/** Advance coverage before deleting bounded batches. Queries fall back to raw
 * events for the removed buckets, so partially completed cleanup stays exact.
 *
 * The same sweep extends hour coverage backwards over retained events, so the
 * partially covered hours left by migration 027 stop falling back to a raw
 * scan once the gateway has been running for a few minutes. */
export function pruneUsageRollups(db: Database, now: number, hourDays: number, minuteDays: number, batch = 1000): void {
  backfillHourRollups(db, { now });
  const today = Math.floor(now / USAGE_DAY) * USAGE_DAY;
  const hourCutoff = Math.max(0, today - (hourDays - 1) * USAGE_DAY);
  const minuteCutoff = Math.max(0, today - (minuteDays - 1) * USAGE_DAY);
  db.transaction(() => {
    const coverage = db.prepare("UPDATE usage_rollup_coverage SET hour_floor = MAX(hour_floor, ?), minute_floor = MAX(minute_floor, ?), hourly_from = MAX(hourly_from, ?), minute_from = MAX(minute_from, ?) WHERE id = 1");
    try { coverage.run(hourCutoff, minuteCutoff, hourCutoff, minuteCutoff); } finally { coverage.finalize(); }
    for (const [kind, cutoff] of [["hour", hourCutoff], ["minute", minuteCutoff]] as const) {
      const remove = db.prepare(`DELETE FROM usage_${kind}_rollups
        WHERE (bucket,key_id,proto,provider_id,provider_key_id,model,upstream_model) IN (
          SELECT bucket,key_id,proto,provider_id,provider_key_id,model,upstream_model
          FROM usage_${kind}_rollups WHERE bucket < ? ORDER BY bucket LIMIT ?
        )`);
      try { remove.run(cutoff, batch); } finally { remove.finalize(); }
    }
  }).immediate();
}
/** Hours a bounded backfill covers per call. Startup and the periodic sweep
 * both use the same budget so ingestion never waits on a long scan. */
export const USAGE_HOURLY_BACKFILL_HOURS = 6;

/** Extend hour-rollup coverage backwards from raw events that are known to be
 * retained, one bounded batch at a time.
 *
 * Migration 027 started sub-day coverage at the next complete hour, so every
 * hour before that instant fell back to a raw scan even when the events were
 * still present. The first sub-day query after a long import therefore paid a
 * multi-second GROUP BY over the seven rollup dimensions for each partial edge.
 * This advances `hourly_from` backwards over hours whose raw events still
 * exist: the current day is written by live ingestion, so only the stretch
 * after the last covered bucket is rebuilt, and it is rebuilt from the events
 * themselves rather than declared.
 *
 * The batch never crosses `hour_floor` (the prune watermark) nor the declared
 * raw-retention boundary, so it never claims coverage for deleted rows. Each
 * batch commits atomically with its own coverage advance: an interrupted run
 * resumes where it stopped, and a query that races it reads raw events for the
 * hours that are not published yet. */
export function backfillHourRollups(
  db: Database,
  opts: { now?: number; hours?: number; rawFrom?: number } = {},
): { advanced: boolean; hourlyFrom: number; hours: number } {
  const now = opts.now ?? Date.now();
  const limit = Math.max(0, Math.floor(opts.hours ?? USAGE_HOURLY_BACKFILL_HOURS));
  const coverage = usageRollupCoverage(db);
  const floor = db.query<{ hour_floor: number; raw_from: number }, []>("SELECT hour_floor, raw_from FROM usage_rollup_coverage WHERE id = 1").get()!;
  const boundary = Math.max(0, Math.floor(opts.rawFrom ?? floor.raw_from ?? 0), floor.hour_floor ?? 0);
  const currentHour = Math.floor(now / USAGE_HOUR) * USAGE_HOUR;
  // Hours already written by live ingestion are authoritative; backfill stops
  // at the first hour this process can prove it has not covered.
  const target = Math.max(boundary, coverage.hourly_from - limit * USAGE_HOUR);
  if (target >= coverage.hourly_from || limit === 0) return { advanced: false, hourlyFrom: coverage.hourly_from, hours: 0 };
  const oldest = db.query<{ ts: number | null }, []>("SELECT MIN(ts) AS ts FROM usage_events").get()!.ts;
  const from = Math.max(target, boundary, oldest === null ? target : Math.floor(oldest / USAGE_HOUR) * USAGE_HOUR);
  if (from >= coverage.hourly_from) return { advanced: false, hourlyFrom: coverage.hourly_from, hours: 0 };
  const insert = db.prepare(`INSERT INTO usage_hour_rollups
    (bucket, key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model,
     in_tok, cache_tok, out_tok, reqs, success_reqs, error_reqs, cost_in_nanos, cost_cache_nanos, cost_out_nanos)
    SELECT CAST(ts / ${USAGE_HOUR} AS INTEGER) * ${USAGE_HOUR}, key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model,
      SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*), SUM(status >= 200 AND status < 300), SUM(status < 200 OR status >= 300),
      SUM(cost_in_nanos), SUM(cost_cache_nanos), SUM(cost_out_nanos)
    FROM usage_events WHERE ts >= ? AND ts < ?
    GROUP BY 1, key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model`);
  const remove = db.prepare("DELETE FROM usage_hour_rollups WHERE bucket >= ? AND bucket < ?");
  const advance = db.prepare("UPDATE usage_rollup_coverage SET hourly_from = ? WHERE id = 1");
  try {
    db.transaction(() => {
      remove.run(from, coverage.hourly_from);
      insert.run(from, coverage.hourly_from);
      advance.run(from);
    }).immediate();
  } finally {
    for (const statement of [insert, remove, advance]) statement.finalize();
  }
  return { advanced: true, hourlyFrom: from, hours: Math.round((coverage.hourly_from - from) / USAGE_HOUR) };
}