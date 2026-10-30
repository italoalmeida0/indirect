import { db } from "./db";
import { costAggFieldsSql, costRowFieldsSql, modelPricingJoins } from "./pricing";
import { filteredUsageSeries, memoizedUsageSource, resolveUsageScope, usageSource, USAGE_MODEL_DIMENSIONS, usageSeriesGranularity, type UsageScope } from "./usage-filters";
import { USAGE_DAY, USAGE_HOUR, USAGE_MINUTE } from "./usage-rollup";

const DAY = USAGE_DAY;
interface Metrics { in_tok: number; cache_tok: number; out_tok: number; reqs: number; cost_in: number; cost_cache: number; cost_out: number; cost: number }
const sums = (alias: string) => ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"].map((field) => `SUM(${alias}.${field}) AS ${field}`).join(", ");

/** Scratch tables exist for the lifetime of one reader connection and are
 * emptied before each analytic, so a job never inherits another job's rows and
 * the reader never pays for repeated schema changes. DROP+CREATE of the same
 * name inside one busy connection intermittently fails here, and CREATE IF NOT
 * EXISTS plus DELETE has the same guarantee with less churn. */
function scratch(name: string, columns: string) {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${name} (${columns})`);
  db.exec(`DELETE FROM temp.${name}`);
  return name;
}

/** One scan of the source split into its six dimensions, so the four
 * breakdown charts of a page never re-aggregate the same interval. */
function dimensionTable(scope: UsageScope, userId: string | null) {
  scratch("usage_dims", `key_id TEXT NOT NULL, user_id TEXT NOT NULL, proto TEXT NOT NULL,
    provider_id TEXT NOT NULL, model TEXT NOT NULL, upstream_model TEXT NOT NULL,
    in_tok INTEGER NOT NULL, cache_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL,
    cost_in_nanos INTEGER, cost_cache_nanos INTEGER, cost_out_nanos INTEGER,
    reqs INTEGER NOT NULL, success_reqs INTEGER NOT NULL, error_reqs INTEGER NOT NULL`);
  const source = memoizedUsageSource(scope, userId);
  db.prepare(`INSERT INTO temp.usage_dims
    SELECT s.key_id, s.user_id, s.proto, s.provider_id, s.model, s.upstream_model,
      SUM(s.in_tok), SUM(s.cache_tok), SUM(s.out_tok), SUM(s.cost_in_nanos), SUM(s.cost_cache_nanos), SUM(s.cost_out_nanos),
      SUM(s.reqs), SUM(s.success_reqs), SUM(s.error_reqs)
    FROM ${source.sql} s GROUP BY s.key_id, s.user_id, s.proto, s.provider_id, s.model, s.upstream_model`).run(...source.params);
}

function breakdown(scope: UsageScope, userId: string | null, dimension: "user_id" | "provider_id" | "proto" | "key_id", limit: number, includeCost = true) {
  const join = dimension === "user_id" ? "LEFT JOIN users d ON d.id = r.id" : dimension === "provider_id" ? "LEFT JOIN providers d ON d.id = r.id" : dimension === "key_id" ? "LEFT JOIN api_keys d ON d.id = r.id LEFT JOIN users owner ON owner.id = d.user_id" : "";
  const label = dimension === "user_id" ? "COALESCE(NULLIF(d.name, ''), d.email, r.id)" : dimension === "provider_id" ? "COALESCE(NULLIF(d.name, ''), NULLIF(r.id, ''), 'Unattributed')" : dimension === "key_id" ? "COALESCE(NULLIF(d.name, ''), CASE WHEN d.id IS NULL THEN 'Deleted key' ELSE 'Unnamed key' END)" : "CASE r.id WHEN 'openai' THEN 'OpenAI' WHEN 'anthropic' THEN 'Anthropic' ELSE r.id END";
  const detail = dimension === "user_id" ? "COALESCE(d.email, r.id)" : dimension === "key_id" ? userId === null ? "COALESCE(owner.email, 'Deleted user')" : "substr(r.id, 1, 8)" : "''";
  const byReqsOnly = !includeCost || dimension === "provider_id" || dimension === "proto";
  const rankOrder = byReqsOnly ? "reqs DESC, (in_tok + cache_tok + out_tok) DESC" : "cost DESC, reqs DESC";
  const outerOrder = byReqsOnly ? "SUM(r.reqs) DESC, (SUM(r.in_tok) + SUM(r.cache_tok) + SUM(r.out_tok)) DESC" : "SUM(r.cost) DESC, SUM(r.reqs) DESC";
  return db.prepare<Metrics & { id: string | null; label: string; detail: string; members: number }, []>(`
    WITH targets AS (
      SELECT s.${dimension} AS id, s.model, s.upstream_model, SUM(s.in_tok) AS in_tok,
        SUM(s.cache_tok) AS cache_tok, SUM(s.out_tok) AS out_tok, SUM(s.cost_in_nanos) AS cost_in_nanos, SUM(s.cost_cache_nanos) AS cost_cache_nanos, SUM(s.cost_out_nanos) AS cost_out_nanos, SUM(s.reqs) AS reqs
      FROM temp.usage_dims s GROUP BY s.${dimension}, s.model, s.upstream_model
    ), totals AS (
      SELECT m.id, SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok,
        SUM(m.reqs) AS reqs, ${costAggFieldsSql("m")} FROM targets m ${modelPricingJoins("m")}
      GROUP BY m.id HAVING SUM(m.reqs) > 0
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ${rankOrder}, id) AS rank FROM totals
    )
    SELECT CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END AS id,
      CASE WHEN r.rank <= ${limit} THEN ${label} ELSE 'Other' END AS label,
      CASE WHEN r.rank <= ${limit} THEN ${detail} ELSE '' END AS detail,
      COUNT(*) AS members, ${sums("r")} FROM ranked r ${join}
    GROUP BY CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END
    ORDER BY (CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END) IS NULL,
      ${outerOrder},
      CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END
  `).all();
}

/** Scratch table holding one segment per chart bucket for a window. */
function bucketTable(name: string, granularity: "month" | "day" | "hour" | "minute") {
  const unit = granularity === "month" ? DAY : granularity === "minute" ? USAGE_MINUTE : granularity === "hour" ? USAGE_HOUR : DAY;
  const index = granularity === "month" ? `CAST(substr(s.date, 1, 4) AS INTEGER) * 12 + CAST(substr(s.date, 6, 2) AS INTEGER) - 1`
    : unit < DAY ? `CAST(s.bucket / ${unit} AS INTEGER)`
    : `CAST(strftime('%s', s.date) AS INTEGER) * 1000 / ${unit}`;
  scratch(name, `bucket INTEGER NOT NULL, model TEXT NOT NULL, upstream_model TEXT NOT NULL,
    in_tok INTEGER NOT NULL, cache_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL,
    cost_in_nanos INTEGER, cost_cache_nanos INTEGER, cost_out_nanos INTEGER,
    reqs INTEGER NOT NULL, success_reqs INTEGER NOT NULL, error_reqs INTEGER NOT NULL`);
  return { name, index, unit };
}

/** Store one window's rollup segments in its scratch table, numbered from the
 * window's own first chart bucket so every chart holds at most 48 ordinals. */
function fillBucketTable(table: ReturnType<typeof bucketTable>, scope: UsageScope, userId: string | null, monthly: boolean, unit: number, startIndex: number, step: number) {
  // Charts only attribute cost and volume per model, so the projection stops
  // at model/upstream and each ledger segment aggregates before the union.
  const source = usageSource(scope, userId, undefined, monthly, unit, USAGE_MODEL_DIMENSIONS);
  // Group by ordinal: every segment already exports a "bucket" column, so a
  // name here would bind to the source instead of the chart ordinal.
  db.prepare(`INSERT INTO temp.${table.name}
    SELECT CAST((${table.index} - ${startIndex}) / ${step} AS INTEGER) AS chart_bucket, s.model, s.upstream_model,
      SUM(s.in_tok), SUM(s.cache_tok), SUM(s.out_tok), SUM(s.cost_in_nanos), SUM(s.cost_cache_nanos), SUM(s.cost_out_nanos),
      SUM(s.reqs), SUM(s.success_reqs), SUM(s.error_reqs)
    FROM ${source.sql} s GROUP BY 1, s.model, s.upstream_model`).run(...source.params);
}

/** Price and bucket one scratch table into per-model chart rows. */
function chartRows(table: string, limit = 5) {
  return db.prepare<{ metric: "cost" | "reqs"; bucket: number; model: string | null; name: string; rank: number; cost: number; reqs: number; success_reqs: number; error_reqs: number }, []>(`
    WITH priced AS MATERIALIZED (
      SELECT m.*, ${costRowFieldsSql("m")} FROM temp.${table} m ${modelPricingJoins("m")}
    ), totals AS (
      SELECT model, SUM(cost) AS cost, SUM(reqs) AS reqs FROM priced GROUP BY model
    ), ranked AS (
      SELECT model, ROW_NUMBER() OVER (ORDER BY cost DESC, reqs DESC, model) AS spend_rank,
        ROW_NUMBER() OVER (ORDER BY reqs DESC, cost DESC, model) AS volume_rank FROM totals
    )
    SELECT 'cost' AS metric, p.bucket, CASE WHEN r.spend_rank <= ${limit} THEN p.model ELSE NULL END AS model,
      CASE WHEN r.spend_rank <= ${limit} THEN COALESCE(NULLIF(md.name, ''), p.model) ELSE 'Other' END AS name,
      MIN(r.spend_rank, ${limit + 1}) AS rank, SUM(p.cost) AS cost, SUM(p.reqs) AS reqs,
      SUM(p.success_reqs) AS success_reqs, SUM(p.error_reqs) AS error_reqs
    FROM priced p JOIN ranked r ON r.model = p.model LEFT JOIN models md ON md.id = p.model
    GROUP BY p.bucket, CASE WHEN r.spend_rank <= ${limit} THEN p.model ELSE NULL END
    UNION ALL
    SELECT 'reqs', p.bucket, CASE WHEN r.volume_rank <= ${limit} THEN p.model ELSE NULL END,
      CASE WHEN r.volume_rank <= ${limit} THEN COALESCE(NULLIF(md.name, ''), p.model) ELSE 'Other' END,
      MIN(r.volume_rank, ${limit + 1}), SUM(p.cost), SUM(p.reqs), SUM(p.success_reqs), SUM(p.error_reqs)
    FROM priced p JOIN ranked r ON r.model = p.model LEFT JOIN models md ON md.id = p.model
    GROUP BY p.bucket, CASE WHEN r.volume_rank <= ${limit} THEN p.model ELSE NULL END
    ORDER BY metric, rank, p.bucket`).all();
}

/** Chart bucket index of a UTC date string ("YYYY-MM-DD") or of an epoch. */
function bucketIndex(value: string, granularity: "month" | "day" | "hour" | "minute"): number {
  const parsed = new Date(value.includes(" UTC") ? value.replace(" ", "T").replace(" UTC", ":00Z") : value.length === 10 ? `${value}T00:00:00Z` : value);
  return granularity === "month" ? parsed.getUTCFullYear() * 12 + parsed.getUTCMonth() : Math.floor(parsed.getTime() / unitOf(granularity));
}

function unitOf(granularity: "month" | "day" | "hour" | "minute"): number {
  return granularity === "minute" ? USAGE_MINUTE : granularity === "hour" ? USAGE_HOUR : DAY;
}

/** A window spanning more than ~13 months charts by month. */
function spanIsMonthly(scope: UsageScope): boolean {
  return scope.from === null || scope.to - scope.from > 400 * DAY;
}

/** Granularity this window can actually be read at (see usageSeriesGranularity). */
function granularityUnit(scope: UsageScope): number {
  return unitOf(usageSeriesGranularity(scope));
}

/** Date labels for every chart bucket. */
function datesFor(first: number, last: number, step: number, granularity: "month" | "day" | "hour" | "minute") {
  const unit = unitOf(granularity);
  const monthly = granularity === "month";
  return Array.from({ length: Math.max(1, Math.ceil((last - first + 1) / step)) }, (_, index) => {
    const bucket = first + index * step;
    const date = new Date(monthly ? Date.UTC(Math.floor(bucket / 12), bucket % 12, 1) : bucket * unit).toISOString();
    const lastBucket = Math.min(last, bucket + step - 1);
    const lastDate = new Date(monthly ? Date.UTC(Math.floor(lastBucket / 12), lastBucket % 12, 1) : lastBucket * unit).toISOString();
    const label = monthly ? date.slice(0, 7) : unit < DAY ? `${date.slice(5, 10)} ${date.slice(11, 16)}` : date.slice(5, 10);
    return { date, lastDate, label };
  });
}

/** Aggregate one window onto its own 48-bucket chart grid: at most 48 values
 * per chart, and both the current range and its comparison keep their own
 * calendar labels. */
function windowChart(requested: UsageScope, userId: string | null, granularity: "month" | "day" | "hour" | "minute" | null, name: string) {
  // Resolve the bounds first: the comparison window is built from the REQUESTED
  // range and then widened to whole archived days. Charting it at the current
  // window's granularity would ask for minute buckets over a range that only
  // exists as days, so nothing is reachable and the comparison renders zero.
  // Passing null lets each window pick its own granularity from its own bounds.
  const scope = resolveUsageScope(requested).scope;
  const unit = granularity === null ? granularityUnit(scope) : unitOf(granularity);
  const monthly = granularity === null ? spanIsMonthly(scope) : granularity === "month";
  // The effective unit, after the null-means-derive branch above.
  const chartGranularity: "month" | "day" | "hour" | "minute" = granularity ?? (monthly ? "month" : unit === USAGE_MINUTE ? "minute" : unit === USAGE_HOUR ? "hour" : "day");
  const first = scope.from === null ? null : monthly ? new Date(scope.from).getUTCFullYear() * 12 + new Date(scope.from).getUTCMonth() : Math.floor(scope.from / unit);
  const last = new Date(scope.to - 1);
  const lastIndex = monthly ? last.getUTCFullYear() * 12 + last.getUTCMonth() : Math.floor(last.getTime() / unit);
  // The series' first point is the chart's first bucket; an unbounded start
  // begins at the first period with a row, exactly like the daily series.
  const startIndex = first ?? bucketIndex(filteredUsageSeries(scope, userId).series[0]?.date ?? new Date(scope.to - 1).toISOString().slice(0, 10), chartGranularity);
  const step = Math.max(1, Math.ceil((lastIndex - startIndex + 1) / 48));
  const table = bucketTable(name, chartGranularity);
  fillBucketTable(table, scope, userId, monthly, unit, startIndex, step);
  return { rows: chartRows(table.name), dates: datesFor(startIndex, lastIndex, step, chartGranularity), table: table.name };
}

/** One transaction in a bounded read worker supplies every chart in the page.
 * Long windows reuse monthly rollups; only exact partial-day edges scan events.
 * At most 48 time buckets × 6 model categories cross the HTTP boundary. */
export function filteredUsageAnalytics(scope: UsageScope, userId: string | null, requestedScope: UsageScope = scope, includeCost = true) {
  const current = filteredUsageSeries(scope, userId);
  // The chart grid is derived from the interval, not from the returned points:
  // an interval whose only rows are archived still charts at day resolution.
  const granularity = usageSeriesGranularity(scope);
  const requestedSpan = requestedScope.from === null ? Infinity : requestedScope.to - requestedScope.from;
  const previousWindow = requestedScope.from === null || requestedScope.from === 0 ? null : resolveUsageScope({ ...requestedScope, from: Math.max(0, requestedScope.from - requestedSpan), to: requestedScope.from });
  // Both the chart and its comparison are aggregated from the month, day,
  // hour, minute and raw segments; the comparison used to run a second full
  // pass over the same history, doubling the cost of every analytics page.
  const chart = windowChart(scope, userId, granularity, "usage_chart");
  // The comparison picks its OWN granularity: widening to archived days can
  // change the unit, and borrowing the current window's unit made an archived
  // comparison unreadable (it charted zero).
  const comparison = previousWindow === null ? null : windowChart(previousWindow.scope, userId, null, "usage_comparison");
  const rows = chart.rows;
  const dates = chart.dates;
  const modelChart = (metric: "cost" | "reqs") => {
    const selected = rows.filter((row) => row.metric === metric);
    const groups = [...new Map(selected.map((row) => [row.rank, { id: row.model, label: row.name, rank: row.rank }])).values()].sort((a, b) => a.rank - b.rank);
    const indices = new Map(groups.map((group, index) => [group.rank, index]));
    const points = dates.map((date) => ({ ...date, values: groups.map(() => 0) }));
    for (const row of selected) {
      const point = points[row.bucket];
      const index = indices.get(row.rank);
      if (point && index !== undefined) point.values[index] += row[metric];
    }
    return { groups: groups.map(({ rank: _, ...group }) => group), points };
  };
  // Outcomes are read from the uncharted bucket table, not from the model
  // ranking: folding six models into "Other" must not lose their counts.
  const outcomes = dates.map((date) => ({ ...date, success: 0, errors: 0, unknown: 0 }));
  for (const row of db.prepare<{ bucket: number; reqs: number; success_reqs: number; error_reqs: number }, []>(`SELECT bucket, SUM(reqs) AS reqs, SUM(success_reqs) AS success_reqs, SUM(error_reqs) AS error_reqs FROM temp.${chart.table} GROUP BY bucket`).all()) {
    const point = outcomes[row.bucket];
    if (!point) continue;
    point.success += row.success_reqs;
    point.errors += row.error_reqs;
    point.unknown += Math.max(0, row.reqs - row.success_reqs - row.error_reqs);
  }
  // One scan of the dimensions feeds the user, key, provider and protocol
  // charts of the page; each of them used to re-split and re-price the range.
  dimensionTable(scope, userId);
  const users = userId === null ? breakdown(scope, null, "user_id", 8, includeCost) : [];
  return { ...current, previous: comparison === null ? [] : comparisonSeries(comparison), modelSpend: includeCost ? modelChart("cost") : { groups: [], points: [] }, modelRequests: modelChart("reqs"),
    users, keys: breakdown(scope, userId, "key_id", 8, includeCost), outcomes,
    providers: breakdown(scope, userId, "provider_id", 5, includeCost), protocols: breakdown(scope, userId, "proto", 2, includeCost),
    activeUsers: users.reduce((sum, row) => sum + row.members, 0), scope: { from: scope.from, to: scope.to }, previousHistory: previousWindow?.history ?? null };
}

/** The comparison keeps its own calendar shape: one point per bucket of the
 * previous window, so its totals and labels never borrow the current range. */
function comparisonSeries(chart: { rows: ReturnType<typeof chartRows>; dates: ReturnType<typeof datesFor> }) {
  const totals = chart.dates.map((date) => ({ ...date, reqs: 0, cost: 0 }));
  for (const row of chart.rows) if (row.metric === "reqs") {
    const point = totals[row.bucket];
    if (!point) continue;
    point.reqs += row.reqs;
    point.cost += row.cost;
  }
  return totals;
}