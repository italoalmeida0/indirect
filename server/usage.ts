import { db } from "./db";
import { LIMITS } from "./config";
import { guardedMaintenance } from "./maintenance";
import { prepareUsageRollupUpsert, USAGE_HOUR, USAGE_MINUTE } from "./usage-rollup";
import { withSqliteRetryAsync } from "./sqlite-retry";
import type { Charge } from "./billing";
import { usageScopeWhere } from "./usage-filters";
import { cachedUsageQuery, invalidateUsageQueries } from "./usage-cache";
import { buildGridWhere, buildGridOrder, gridPage, type ColSpec, type GridFilterEntry, type GridSort } from "./gridql";
import {
  modelPricingJoins,
  costInExprSql,
  costCacheExprSql,
  costOutExprSql,
  costExprSql,
  costRowFieldsSql,
  costAggFieldsSql,
} from "./pricing";

/**
 * Usage accounting.
 *
 * Writes: proxy events are buffered and flushed in one transaction (every
 * second or every 100 events) to avoid per-request analytics transactions.
 *
 * USD admission and settlement are synchronous in billing.ts. These buffered
 * analytics rows carry the immutable prices already charged by that ledger.
 */

export interface UsageEvent {
  keyId: string;
  userId: string;
  proto: "openai" | "anthropic" | "responses";
  model: string;
  /** Cache-free input tokens (providers charge full price for these). */
  inTok: number;
  /** Cached input tokens — cache reads (+ Anthropic cache creation), billed
   *  at the provider's cache rate. Tracked in their own bucket, never folded
   *  into inTok. */
  cacheTok: number;
  outTok: number;
  latencyMs: number;
  status: number;
  stream: boolean;
  estimated: boolean;
  /** Upstream dimension (which candidate of the failover chain answered).
   *  Empty strings on pre-011 events. */
  providerId?: string;
  providerKeyId?: string;
  upstreamModel?: string;
  ts?: number;
  charge: Charge;
}

const buffer: UsageEvent[] = [];
let bufferStart = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushDueAt = 0;
let retryPending = false;
const queuedUsage = () => buffer.length - bufferStart;
const flushBatchSize = 8;

// Leave room for already admitted streams to finish while storage recovers.
const maxBufferedUsage = 100_000;
export function canRecordUsage(): boolean { return queuedUsage() < Math.max(0, maxBufferedUsage - LIMITS.globalConcurrency); }

const flushInBackground = guardedMaintenance("usage flush", async () => {
  if (!queuedUsage()) return;
  // The ASYNC retry is mandatory here: the synchronous policy sleeps by
  // blocking the thread, so a held write lock would freeze every request
  // (including /api/health) for the whole backoff window. Awaiting between
  // attempts keeps the gateway serving while the buffer waits for the writer.
  const result = await withSqliteRetryAsync(() => flushUsageBatch(flushBatchSize), {
    name: "usage flush",
    // The flush is the restaurant's till: retry longer than a maintenance
    // sweep before declaring failure, but still bounded.
    attempts: 6,
    deadlineMs: 5_000,
  });
  retryPending = false;
  // Keep the buffer moving without starving the event loop: yield to the
  // timer queue between batches instead of spinning synchronously.
  if (queuedUsage()) scheduleFlush(result.retried ? 50 : 0);
}, {
  onResult: ({ ok }) => {
    if (ok) return;
    // The batch stays buffered; the next tick retries the same events.
    retryPending = true;
    scheduleFlush();
  },
});

function scheduleFlush(delay = 1_000): void {
  const due = Date.now() + delay;
  if (flushTimer && due >= flushDueAt) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushDueAt = due;
  flushTimer = setTimeout(() => { flushTimer = undefined; flushInBackground(); }, delay);
  flushTimer.unref();
}

export function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function recordUsage(ev: UsageEvent): void {
  buffer.push(ev);
  scheduleFlush(queuedUsage() >= 100 && !retryPending ? 0 : 1_000);
}

const insertEvent = db.prepare(
  `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream, estimated, provider_id, provider_key_id, upstream_model, cost_in_nanos, cost_cache_nanos, cost_out_nanos)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const upsertDaily = db.prepare(
  `INSERT INTO usage_daily (key_id, user_id, date, in_tok, cache_tok, out_tok, reqs)
   VALUES (?, ?, ?, ?, ?, ?, 1)
   ON CONFLICT(key_id, date)
   DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                 cache_tok = cache_tok + excluded.cache_tok,
                 out_tok = out_tok + excluded.out_tok,
                 reqs = reqs + 1`,
);
// Same rollup, one dimension deeper (model): powers the per-model dashboard
// queries without scanning usage_events (~0.03ms extra per event, measured).
const upsertModelDaily = db.prepare(
  `INSERT INTO usage_model_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs, cost_in_nanos, cost_cache_nanos, cost_out_nanos)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
   ON CONFLICT(key_id, date, proto, model)
   DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                 cache_tok = cache_tok + excluded.cache_tok,
                 out_tok = out_tok + excluded.out_tok,
                 reqs = reqs + 1, cost_in_nanos = COALESCE(cost_in_nanos, 0) + excluded.cost_in_nanos, cost_cache_nanos = COALESCE(cost_cache_nanos, 0) + excluded.cost_cache_nanos, cost_out_nanos = COALESCE(cost_out_nanos, 0) + excluded.cost_out_nanos`,
);
// Deepest rollup (migration 011): adds the upstream dimensions — provider,
// provider key and upstream model id — powering the AG Grid usage breakdown
// (filter by provider / upstream model / provider key) without scanning
// usage_events. Written alongside the two shallower rollups.
const upsertModelProviderDaily = db.prepare(
  `INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs, success_reqs, error_reqs, cost_in_nanos, cost_cache_nanos, cost_out_nanos)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
   ON CONFLICT(key_id, date, proto, provider_id, provider_key_id, model, upstream_model)
   DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                 cache_tok = cache_tok + excluded.cache_tok,
                 out_tok = out_tok + excluded.out_tok,
                 reqs = reqs + 1, success_reqs = success_reqs + excluded.success_reqs,
                 error_reqs = error_reqs + excluded.error_reqs,
                 cost_in_nanos = COALESCE(cost_in_nanos, 0) + excluded.cost_in_nanos, cost_cache_nanos = COALESCE(cost_cache_nanos, 0) + excluded.cost_cache_nanos, cost_out_nanos = COALESCE(cost_out_nanos, 0) + excluded.cost_out_nanos`,
);
const upsertModelProviderMonthly = db.prepare(
  `INSERT INTO usage_model_provider_monthly (key_id, user_id, month, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs, success_reqs, error_reqs, cost_in_nanos, cost_cache_nanos, cost_out_nanos)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
   ON CONFLICT(key_id, month, proto, provider_id, provider_key_id, model, upstream_model)
   DO UPDATE SET in_tok = in_tok + excluded.in_tok, cache_tok = cache_tok + excluded.cache_tok,
                 out_tok = out_tok + excluded.out_tok, reqs = reqs + 1,
                 success_reqs = success_reqs + excluded.success_reqs, error_reqs = error_reqs + excluded.error_reqs,
                 cost_in_nanos = COALESCE(cost_in_nanos, 0) + excluded.cost_in_nanos, cost_cache_nanos = COALESCE(cost_cache_nanos, 0) + excluded.cost_cache_nanos, cost_out_nanos = COALESCE(cost_out_nanos, 0) + excluded.cost_out_nanos`,
);
const upsertHour = prepareUsageRollupUpsert(db, "hour");
const upsertMinute = prepareUsageRollupUpsert(db, "minute");

export function flushUsage(): void {
  while (queuedUsage()) flushUsageBatch(flushBatchSize);
}

function flushUsageBatch(limit: number): void {
  if (!queuedUsage()) return;
  // Keep the batch until the transaction commits; a busy database must not
  // lose settled analytics. Calls are synchronous, so no writers interleave.
  const batch = buffer.slice(bufferStart, bufferStart + limit);
  const changedWindows: Array<{ userId: string; ts: number }> = [];
  db.transaction(() => {
    for (const ev of batch) {
      const ts = ev.ts ?? Date.now();
      changedWindows.push({ userId: ev.userId, ts });
      const model = ev.model.slice(0, 128);
      const cost = [ev.charge.input, ev.charge.cache, ev.charge.output];
      insertEvent.run(
        ev.keyId,
        ev.userId,
        ts,
        ev.proto,
        model,
        ev.inTok,
        ev.cacheTok,
        ev.outTok,
        ev.latencyMs,
        ev.status,
        ev.stream ? 1 : 0,
        ev.estimated ? 1 : 0,
        ev.providerId ?? "",
        ev.providerKeyId ?? "",
        ev.upstreamModel ?? "",
        ...cost,
      );
      const date = utcDate(ts);
      upsertDaily.run(ev.keyId, ev.userId, date, ev.inTok, ev.cacheTok, ev.outTok);
      upsertModelDaily.run(ev.keyId, ev.userId, date, ev.proto, model, ev.inTok, ev.cacheTok, ev.outTok, ...cost);
      upsertModelProviderDaily.run(
        ev.keyId,
        ev.userId,
        date,
        ev.proto,
        ev.providerId ?? "",
        ev.providerKeyId ?? "",
        model,
        ev.upstreamModel ?? "",
        ev.inTok,
        ev.cacheTok,
        ev.outTok,
        ev.status >= 200 && ev.status < 300 ? 1 : 0,
        ev.status < 200 || ev.status >= 300 ? 1 : 0,
        ...cost,
      );
      upsertModelProviderMonthly.run(ev.keyId, ev.userId, date.slice(0, 7), ev.proto, ev.providerId ?? "", ev.providerKeyId ?? "", model, ev.upstreamModel ?? "", ev.inTok, ev.cacheTok, ev.outTok,
        ev.status >= 200 && ev.status < 300 ? 1 : 0, ev.status < 200 || ev.status >= 300 ? 1 : 0, ...cost);
      const rollupValues = [ev.keyId, ev.userId, ev.proto, ev.providerId ?? "", ev.providerKeyId ?? "", model, ev.upstreamModel ?? "", ev.inTok, ev.cacheTok, ev.outTok,
        ev.status >= 200 && ev.status < 300 ? 1 : 0, ev.status < 200 || ev.status >= 300 ? 1 : 0, ...cost];
      upsertHour.run(Math.floor(ts / USAGE_HOUR) * USAGE_HOUR, ...rollupValues);
      upsertMinute.run(Math.floor(ts / USAGE_MINUTE) * USAGE_MINUTE, ...rollupValues);
    }
  })();
  bufferStart += batch.length;
  if (bufferStart === buffer.length) { buffer.length = 0; bufferStart = 0; }
  else if (bufferStart >= 4096 && bufferStart * 2 >= buffer.length) { buffer.splice(0, bufferStart); bufferStart = 0; }
  invalidateUsageQueries(changedWindows);
}

// ===== Dashboard queries =====

export interface HourlyPoint {
  date: string; // "2026-08-13 13:00 UTC" (tooltip/legend text)
  label: string; // "13:00" (axis tick)
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
  cost_in: number;
  cost_cache: number;
  cost_out: number;
  cost: number;
}

const HOUR_MS = 3_600_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Hourly buckets for the trailing `hours` hours (UTC), zero-filled so charts
 * render quiet hours as empty bars instead of gaps. Reads usage_events —
 * usage_daily can't go below one day. Optional userId/keyId/providerId narrow
 * the scope; both null = global.
 */
export function hourlySeries(userId: string | null, keyId: string | null, hours: number, providerId?: string): HourlyPoint[] {
  const h = Math.min(Math.max(Math.floor(hours) || 24, 1), 168);
  const startHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (h - 1) * HOUR_MS;
  const clauses = ["e.ts >= ?"];
  const params: Array<string | number> = [startHour];
  if (userId !== null) {
    clauses.push("e.user_id = ?");
    params.push(userId);
  }
  if (keyId !== null) {
    clauses.push("e.key_id = ?");
    params.push(keyId);
  }
  if (providerId) {
    clauses.push("e.provider_id = ?");
    params.push(providerId);
  }
  const rows = db
    .prepare<{ hbucket: number; in_tok: number; cache_tok: number; out_tok: number; reqs: number; cost_in: number; cost_cache: number; cost_out: number; cost: number }, any[]>(
      `SELECT (e.ts / ?) AS hbucket,
              COALESCE(SUM(e.in_tok), 0) AS in_tok,
              COALESCE(SUM(e.cache_tok), 0) AS cache_tok,
              COALESCE(SUM(e.out_tok), 0) AS out_tok,
              COUNT(*) AS reqs,
              ${costAggFieldsSql("e")}
       FROM usage_events e
       ${modelPricingJoins("e")}
       WHERE ${clauses.join(" AND ")}
       GROUP BY hbucket`,
    )
    .all(HOUR_MS, ...params);
  const byBucket = new Map(rows.map((r) => [r.hbucket, r]));
  const out: HourlyPoint[] = [];
  for (let i = 0; i < h; i++) {
    const ts = startHour + i * HOUR_MS;
    const r = byBucket.get(Math.floor(ts / HOUR_MS));
    const d = new Date(ts);
    out.push({
      date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:00 UTC`,
      label: `${pad2(d.getUTCHours())}:00`,
      in_tok: r?.in_tok ?? 0,
      cache_tok: r?.cache_tok ?? 0,
      out_tok: r?.out_tok ?? 0,
      reqs: r?.reqs ?? 0,
      cost_in: r?.cost_in ?? 0,
      cost_cache: r?.cost_cache ?? 0,
      cost_out: r?.cost_out ?? 0,
      cost: r?.cost ?? 0,
    });
  }
  return out;
}

/** Daily series over the trailing `days` days — or the full history ("all"). */
export function userDailySeries(userId: string, days: number | "all") {
  const where = days === "all" ? "m.user_id = ?" : "m.user_id = ? AND m.date >= date('now', ?)";
  const params = days === "all" ? [userId] : [userId, `-${days} days`];
  return db
    .prepare(
      `SELECT m.date,
              SUM(m.in_tok) AS in_tok,
              SUM(m.cache_tok) AS cache_tok,
              SUM(m.out_tok) AS out_tok,
              SUM(m.reqs) AS reqs,
              ${costAggFieldsSql("m")}
       FROM usage_model_provider_daily m
       ${modelPricingJoins("m")}
       WHERE ${where}
       GROUP BY m.date ORDER BY m.date`,
    )
    .all(...params);
}

export function keyDailySeries(keyId: string, days: number | "all") {
  const where = days === "all" ? "m.key_id = ?" : "m.key_id = ? AND m.date >= date('now', ?)";
  const params = days === "all" ? [keyId] : [keyId, `-${days} days`];
  return db
    .prepare(
      `SELECT m.date,
              SUM(m.in_tok) AS in_tok,
              SUM(m.cache_tok) AS cache_tok,
              SUM(m.out_tok) AS out_tok,
              SUM(m.reqs) AS reqs,
              ${costAggFieldsSql("m")}
       FROM usage_model_provider_daily m
       ${modelPricingJoins("m")}
       WHERE ${where}
       GROUP BY m.date ORDER BY m.date`,
    )
    .all(...params);
}

export function userSummary(userId: string) {
  const baseSql = `SELECT COALESCE(SUM(m.in_tok),0) AS in_tok, COALESCE(SUM(m.cache_tok),0) AS cache_tok, COALESCE(SUM(m.out_tok),0) AS out_tok, COALESCE(SUM(m.reqs),0) AS reqs, ${costAggFieldsSql("m")} FROM usage_model_provider_daily m ${modelPricingJoins("m")}`;
  const today = db
    .prepare<{ in_tok: number; cache_tok: number; out_tok: number; reqs: number; cost_in: number; cost_cache: number; cost_out: number; cost: number }, [string]>(
      `${baseSql} WHERE m.user_id = ? AND m.date = date('now')`,
    )
    .get(userId)!;
  const month = db
    .prepare<{ in_tok: number; cache_tok: number; out_tok: number; reqs: number; cost_in: number; cost_cache: number; cost_out: number; cost: number }, [string]>(
      `${baseSql} WHERE m.user_id = ? AND m.date >= date('now', 'start of month')`,
    )
    .get(userId)!;
  const total = db
    .prepare<{ in_tok: number; cache_tok: number; out_tok: number; reqs: number; cost_in: number; cost_cache: number; cost_out: number; cost: number }, [string]>(
      `${baseSql} WHERE m.user_id = ?`,
    )
    .get(userId)!;
  return { today, month, total };
}

/**
 * Detailed per-key × model × (provider × upstream-model × provider key) rollup read
 * (migration 011's usage_model_provider_daily) for the dashboard grids.
 * Joins resolve display names; paged grid reads apply filters and sorting in SQL.
 */
export interface UsageBreakdownRow {
  key_id: string;
  key_name: string;
  model: string;
  proto: "openai" | "anthropic" | "responses";
  provider_id: string;
  provider_name: string | null;
  provider_key_id: string;
  provider_key_label: string | null;
  upstream_model: string;
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
  cost_in: number;
  cost_cache: number;
  cost_out: number;
  cost: number;
}

function usageBreakdownScope(
  userId: string,
  opts: { keyId?: string; providerId?: string; days: number | "all" },
): { where: string; params: Array<string | number> } {
  const clauses: string[] = ["m.user_id = ?"];
  const params: Array<string | number> = [userId];
  if (opts.keyId) {
    clauses.push("m.key_id = ?");
    params.push(opts.keyId);
  }
  if (opts.providerId) {
    clauses.push("m.provider_id = ?");
    params.push(opts.providerId);
  }
  if (opts.days !== "all") {
    clauses.push("m.date >= date('now', ?)");
    params.push(`-${Math.min(Math.max(Number(opts.days) || 14, 1), 365)} days`);
  }
  return { where: clauses.join(" AND "), params };
}

const USER_BREAKDOWN_COLS: Record<string, ColSpec> = {
  key_id: { col: "key_id" },
  key_name: { col: "key_name" },
  model: { col: "model" },
  proto: { col: "proto" },
  provider_id: { col: "provider_id" },
  provider_name: { col: "provider_name" },
  provider_key_id: { col: "provider_key_id" },
  provider_key_label: { col: "provider_key_label" },
  upstream_model: { col: "upstream_model" },
  in_tok: { col: "in_tok", kind: "number" },
  cache_tok: { col: "cache_tok", kind: "number" },
  out_tok: { col: "out_tok", kind: "number" },
  reqs: { col: "reqs", kind: "number" },
  cost_in: { col: "cost_in", kind: "number" },
  cost_cache: { col: "cost_cache", kind: "number" },
  cost_out: { col: "cost_out", kind: "number" },
  cost: { col: "cost", kind: "number" },
};

export function userUsageBreakdown(
  userId: string,
  opts: { keyId?: string; providerId?: string; days: number | "all"; limit?: number },
): UsageBreakdownRow[] {
  const { where, params } = usageBreakdownScope(userId, opts);
  return db
    .prepare(
      `SELECT m.key_id, COALESCE(k.name, substr(m.key_id, 1, 8)) AS key_name, m.model, m.proto,
              m.provider_id, p.name AS provider_name, m.provider_key_id, pk.label AS provider_key_label,
              m.upstream_model,
              SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs,
              ${costAggFieldsSql("m")}
       FROM usage_model_provider_daily m
       LEFT JOIN api_keys k ON k.id = m.key_id
       LEFT JOIN providers p ON p.id = m.provider_id
       LEFT JOIN provider_keys pk ON pk.id = m.provider_key_id
       ${modelPricingJoins("m")}
       WHERE ${where}
       GROUP BY m.key_id, m.model, m.proto, m.provider_id, m.provider_key_id, m.upstream_model
       ORDER BY (SUM(m.in_tok) + SUM(m.cache_tok) + SUM(m.out_tok)) DESC
       LIMIT ?`,
    )
    .all(...params, opts.limit ?? 2000) as UsageBreakdownRow[];
}

export function queryUserUsageBreakdown(
  userId: string,
  opts: {
    keyId?: string;
    providerId?: string;
    days: number | "all";
    limit: number;
    offset: number;
    sort?: GridSort[];
    filters?: Record<string, GridFilterEntry>;
  },
): {
  rows: UsageBreakdownRow[];
  total: number;
  totals: {
    in_tok: number;
    cache_tok: number;
    out_tok: number;
    reqs: number;
    cost_in?: number;
    cost_cache?: number;
    cost_out?: number;
    cost?: number;
  };
} {
  const { where, params } = usageBreakdownScope(userId, opts);
  const baseSql = `
    SELECT m.key_id,
           COALESCE(k.name, substr(m.key_id, 1, 8)) AS key_name,
           m.model, m.proto, m.provider_id, p.name AS provider_name,
           m.provider_key_id, pk.label AS provider_key_label, m.upstream_model,
           SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok,
           SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs,
           ${costAggFieldsSql("m")}
    FROM usage_model_provider_daily m
    LEFT JOIN api_keys k ON k.id = m.key_id
    LEFT JOIN providers p ON p.id = m.provider_id
    LEFT JOIN provider_keys pk ON pk.id = m.provider_key_id
    ${modelPricingJoins("m")}
    WHERE ${where}
    GROUP BY m.key_id, m.model, m.proto, m.provider_id, m.provider_key_id, m.upstream_model`;
  return gridPage({
    baseSql,
    baseParams: params,
    cols: USER_BREAKDOWN_COLS,
    grid: opts,
    defaultOrder: "(in_tok + cache_tok + out_tok) DESC",
    tieBreak: "key_id DESC, model DESC, provider_id DESC, provider_key_id DESC, upstream_model DESC",
    sumCols: ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"],
  }) as {
    rows: UsageBreakdownRow[];
    total: number;
    totals: {
      in_tok: number;
      cache_tok: number;
      out_tok: number;
      reqs: number;
      cost_in?: number;
      cost_cache?: number;
      cost_out?: number;
      cost?: number;
    };
  };
}

// ===== Server-driven events query (AG Grid infinite row model) =====

/** Grid sort/filter column map — STRICT whitelist; unknown columns are simply
 *  ignored (never spliced into SQL). Translation lives in server/gridql. */
const EVENT_COLS: Record<string, ColSpec> = {
  ts: { col: "e.ts", kind: "date" },
  key_name: { col: "COALESCE(k.name, substr(e.key_id, 1, 8))" },
  proto: { col: "e.proto" },
  provider_name: { col: "COALESCE(p.name, '')" },
  model: { col: "e.model" },
  upstream_model: { col: "e.upstream_model" },
  latency_ms: { col: "e.latency_ms", kind: "number" },
  in_tok: { col: "e.in_tok", kind: "number" },
  cache_tok: { col: "e.cache_tok", kind: "number" },
  out_tok: { col: "e.out_tok", kind: "number" },
  cost_in: { col: costInExprSql("e"), kind: "number" },
  cost_cache: { col: costCacheExprSql("e"), kind: "number" },
  cost_out: { col: costOutExprSql("e"), kind: "number" },
  cost: { col: costExprSql("e"), kind: "number" },
  status: { col: "e.status", kind: "number" },
};


export function userEvents(
  userId: string,
  opts: {
    keyId?: string;
    limit: number;
    offset: number;
    sort?: Array<{ colId: string; sort: string }>;
    filters?: Record<string, GridFilterEntry>;
    /** Keyset cursor (`ts`, `id` of the previous page's last row) — makes
     *  deep forward pages O(page) instead of O(offset). Only honored for the
     *  default (ts DESC, id DESC) ordering; custom sorts keep OFFSET. */
    cursor?: { ts: number; id: number };
    scope?: import("./usage-filters").UsageScope;
    summaryOnly?: boolean;
  },
): { rows: any[]; total: number; totals: { in_tok: number; cache_tok: number; out_tok: number; reqs: number } } {
  // Scope (user + filters) shared by the page query and the total-count;
  // the keyset cursor predicate applies to the page query ONLY — the count
  // must answer "how many rows exist for this filter view", not "how many
  // remain after this cursor".
  const scopeClauses = [opts.keyId ? "e.user_id = ? AND e.key_id = ?" : "e.user_id = ?"];
  const scopeParams: Array<string | number> = opts.keyId ? [userId, opts.keyId] : [userId];
  if (opts.scope) {
    const extra = usageScopeWhere(opts.scope, "e", null);
    scopeClauses.push(...extra.clauses);
    scopeParams.push(...extra.params);
  }
  if (opts.filters) {
    const { clauses: fc, params: fp } = buildGridWhere(opts.filters, EVENT_COLS);
    scopeClauses.push(...fc);
    scopeParams.push(...fp);
  }
  const useCursor = !!opts.cursor && (!opts.sort || opts.sort.length === 0);
  const pageClauses = [...scopeClauses];
  const pageParams = [...scopeParams];
  if (useCursor) {
    // Keyset continuation: rows strictly older than (cursor.ts, cursor.id).
    // Written as one backward index range (`ts <= X`) plus an exclusion
    // predicate for the boundary row — a `ts < ? OR (ts = ? AND id < ?)`
    // collapses on a near-now cursor (SQLite's MULTI-INDEX OR temp-sorts
    // the user's WHOLE slice: ~200-300ms at 3.65M events, measured). The
    // exclusion is a post-filter over an already-indexed range: O(page +
    // ties-at-boundary), exact even when events share a millisecond.
    pageClauses.push("(e.ts <= ?) AND NOT (e.ts = ? AND e.id >= ?)");
    pageParams.push(opts.cursor!.ts, opts.cursor!.ts, opts.cursor!.id);
  }
  const order = buildGridOrder(opts.sort, EVENT_COLS, "e.ts DESC", "e.id DESC");
  const rows = opts.summaryOnly ? [] : db
    .prepare(
      // LEFT JOINs: hard-deleted keys/providers must not hide their history.
      `SELECT e.id, e.key_id, COALESCE(k.name, substr(e.key_id, 1, 8)) AS key_name, e.ts, e.proto, e.model,
              e.in_tok, e.cache_tok, e.out_tok, e.latency_ms, e.status, e.stream, e.estimated,
              e.provider_id, p.name AS provider_name, e.provider_key_id, pk.label AS provider_key_label,
              e.upstream_model,
              ${costRowFieldsSql("e")}
       FROM usage_events e
       LEFT JOIN api_keys k ON k.id = e.key_id
       LEFT JOIN providers p ON p.id = e.provider_id
       LEFT JOIN provider_keys pk ON pk.id = e.provider_key_id
       ${modelPricingJoins("e")}
       WHERE ${pageClauses.join(" AND ")}
       ORDER BY ${order} LIMIT ?${useCursor ? "" : " OFFSET ?"}`,
    )
    .all(...pageParams, opts.limit, ...(useCursor ? [] : [opts.offset]));

  // The COUNT must never do per-row joins: a LEFT JOIN resolves
  // api_keys/providers for EVERY row of the user's whole history (~85ms at
  // 3.65M events, measured — 10x the page query). The joins only DECORATE
  // the page with names, they filter nothing, so the count runs on
  // usage_events alone; joined-name filters (key_name, provider_name, cost) are
  // the only case that needs the joins back. A short TTL cache absorbs
  // repeat counts for the same view while the grid scrolls. The footer
  // token sums ride the SAME query and the SAME scope (never the cursor
  // predicate) — one pass, and totals always agree with `total`.
  const joinedFilter =
    opts.filters &&
    Object.keys(opts.filters).some((c) => c === "key_name" || c === "provider_name" || c.startsWith("cost"));
  const cacheScope = opts.scope ?? { from: null, to: Infinity, selection: {} };
  const agg = cachedUsageQuery("events-summary", cacheScope, userId, () => (
      joinedFilter
        ? db
            .prepare<{ n: number; in_tok: number; cache_tok: number; out_tok: number }, any[]>(
              `SELECT COUNT(*) AS n, COALESCE(SUM(e.in_tok),0) AS in_tok, COALESCE(SUM(e.cache_tok),0) AS cache_tok, COALESCE(SUM(e.out_tok),0) AS out_tok
               FROM usage_events e
               LEFT JOIN api_keys k ON k.id = e.key_id
               LEFT JOIN providers p ON p.id = e.provider_id
               ${modelPricingJoins("e")}
               WHERE ${scopeClauses.join(" AND ")}`,
            )
        : db
            .prepare<{ n: number; in_tok: number; cache_tok: number; out_tok: number }, any[]>(
              `SELECT COUNT(*) AS n, COALESCE(SUM(e.in_tok),0) AS in_tok, COALESCE(SUM(e.cache_tok),0) AS cache_tok, COALESCE(SUM(e.out_tok),0) AS out_tok
               FROM usage_events e WHERE ${scopeClauses.join(" AND ")}`,
            )
    ).get(...scopeParams)!, [opts.keyId, opts.filters]);
  return { rows, total: agg.n, totals: { in_tok: agg.in_tok, cache_tok: agg.cache_tok, out_tok: agg.out_tok, reqs: agg.n } };
}
