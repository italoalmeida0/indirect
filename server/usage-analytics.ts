import { db } from "./db";
import { costAggFieldsSql, costRowFieldsSql, modelPricingJoins } from "./pricing";
import { filteredUsageSeries, usageScopeWhere, usageSource, type UsageScope } from "./usage-filters";

const DAY = 86_400_000;
interface Metrics { in_tok: number; cache_tok: number; out_tok: number; reqs: number; cost_in: number; cost_cache: number; cost_out: number; cost: number }
const sums = (alias: string) => ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"].map((field) => `SUM(${alias}.${field}) AS ${field}`).join(", ");

function breakdown(scope: UsageScope, userId: string | null, dimension: "user_id" | "provider_id" | "proto", limit: number) {
  const source = usageSource(scope, userId);
  const join = dimension === "user_id" ? "LEFT JOIN users d ON d.id = r.id" : dimension === "provider_id" ? "LEFT JOIN providers d ON d.id = r.id" : "";
  const label = dimension === "user_id" ? "COALESCE(NULLIF(d.name, ''), d.email, r.id)" : dimension === "provider_id" ? "COALESCE(NULLIF(d.name, ''), NULLIF(r.id, ''), 'Unattributed')" : "CASE r.id WHEN 'openai' THEN 'OpenAI' WHEN 'anthropic' THEN 'Anthropic' ELSE r.id END";
  return db.prepare<Metrics & { id: string | null; label: string; detail: string; members: number }, Array<string | number>>(`
    WITH targets AS (
      SELECT s.${dimension} AS id, s.model, s.upstream_model, SUM(s.in_tok) AS in_tok,
        SUM(s.cache_tok) AS cache_tok, SUM(s.out_tok) AS out_tok, SUM(s.reqs) AS reqs
      FROM ${source.sql} s GROUP BY s.${dimension}, s.model, s.upstream_model
    ), totals AS (
      SELECT m.id, SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok,
        SUM(m.reqs) AS reqs, ${costAggFieldsSql("m")} FROM targets m ${modelPricingJoins("m")}
      GROUP BY m.id HAVING SUM(m.reqs) > 0
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ${dimension === "provider_id" || dimension === "proto" ? "reqs DESC, cost DESC" : "cost DESC, reqs DESC"}, id) AS rank FROM totals
    )
    SELECT CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END AS id,
      CASE WHEN r.rank <= ${limit} THEN ${label} ELSE 'Other' END AS label,
      ${dimension === "user_id" ? `CASE WHEN r.rank <= ${limit} THEN COALESCE(d.email, r.id) ELSE '' END` : "''"} AS detail,
      COUNT(*) AS members, ${sums("r")} FROM ranked r ${join}
    GROUP BY CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END
    ORDER BY (CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END) IS NULL,
      ${dimension === "provider_id" || dimension === "proto" ? "SUM(r.reqs) DESC, SUM(r.cost) DESC" : "SUM(r.cost) DESC, SUM(r.reqs) DESC"},
      CASE WHEN r.rank <= ${limit} THEN r.id ELSE NULL END
  `).all(...source.params);
}

/** One transaction in a bounded read worker supplies every chart in the page.
 * Long windows reuse monthly rollups; only exact partial-day edges scan events.
 * At most 48 time buckets × 6 model categories cross the HTTP boundary. */
export function filteredUsageAnalytics(scope: UsageScope, userId: string | null) {
  const current = filteredUsageSeries(scope, userId);
  const span = scope.from === null ? Infinity : scope.to - scope.from;
  const monthly = current.granularity === "month";
  const unit = current.granularity === "minute" ? 60_000 : current.granularity === "hour" ? 3_600_000 : DAY;
  const first = current.series[0]?.date ?? new Date(scope.to - 1).toISOString().slice(0, 10);
  const firstDate = new Date(first.includes(" UTC") ? first.replace(" ", "T").replace(" UTC", ":00Z") : `${first}T00:00:00Z`);
  const startIndex = monthly ? firstDate.getUTCFullYear() * 12 + firstDate.getUTCMonth() : Math.floor(firstDate.getTime() / unit);
  const last = new Date(scope.to - 1);
  const lastIndex = monthly ? last.getUTCFullYear() * 12 + last.getUTCMonth() : Math.floor(last.getTime() / unit);
  const step = Math.max(1, Math.ceil((lastIndex - startIndex + 1) / 48));
  let sourceSql: string;
  let params: Array<string | number>;
  if (unit < DAY) {
    const where = usageScopeWhere(scope, "e", userId);
    sourceSql = `SELECT CAST((CAST(e.ts / ${unit} AS INTEGER) - ${startIndex}) / ${step} AS INTEGER) AS bucket,
      e.model, e.upstream_model, SUM(e.in_tok) AS in_tok, SUM(e.cache_tok) AS cache_tok,
      SUM(e.out_tok) AS out_tok, COUNT(*) AS reqs FROM usage_events e WHERE ${where.clauses.join(" AND ")}
      GROUP BY bucket, e.model, e.upstream_model`;
    params = where.params;
  } else {
    const source = usageSource(scope, userId, undefined, monthly);
    const index = monthly ? "CAST(substr(s.date, 1, 4) AS INTEGER) * 12 + CAST(substr(s.date, 6, 2) AS INTEGER) - 1" : `CAST(strftime('%s', s.date) AS INTEGER) * 1000 / ${unit}`;
    sourceSql = `SELECT CAST((${index} - ${startIndex}) / ${step} AS INTEGER) AS bucket,
      s.model, s.upstream_model, SUM(s.in_tok) AS in_tok, SUM(s.cache_tok) AS cache_tok,
      SUM(s.out_tok) AS out_tok, SUM(s.reqs) AS reqs FROM ${source.sql} s GROUP BY bucket, s.model, s.upstream_model`;
    params = source.params;
  }
  const rows = db.prepare<{ metric: "cost" | "reqs"; bucket: number; model: string | null; name: string; rank: number; cost: number; reqs: number }, Array<string | number>>(`
    WITH grouped AS (${sourceSql}), priced AS MATERIALIZED (
      SELECT m.*, ${costRowFieldsSql("m")} FROM grouped m ${modelPricingJoins("m")}
    ), totals AS (
      SELECT model, SUM(cost) AS cost, SUM(reqs) AS reqs FROM priced GROUP BY model
    ), ranked AS (
      SELECT model, ROW_NUMBER() OVER (ORDER BY cost DESC, reqs DESC, model) AS spend_rank,
        ROW_NUMBER() OVER (ORDER BY reqs DESC, cost DESC, model) AS volume_rank FROM totals
    )
    SELECT 'cost' AS metric, p.bucket, CASE WHEN r.spend_rank <= 5 THEN p.model ELSE NULL END AS model,
      CASE WHEN r.spend_rank <= 5 THEN COALESCE(NULLIF(md.name, ''), p.model) ELSE 'Other' END AS name,
      MIN(r.spend_rank, 6) AS rank, SUM(p.cost) AS cost, SUM(p.reqs) AS reqs
    FROM priced p JOIN ranked r ON r.model = p.model LEFT JOIN models md ON md.id = p.model
    GROUP BY p.bucket, CASE WHEN r.spend_rank <= 5 THEN p.model ELSE NULL END
    UNION ALL
    SELECT 'reqs', p.bucket, CASE WHEN r.volume_rank <= 5 THEN p.model ELSE NULL END,
      CASE WHEN r.volume_rank <= 5 THEN COALESCE(NULLIF(md.name, ''), p.model) ELSE 'Other' END,
      MIN(r.volume_rank, 6), SUM(p.cost), SUM(p.reqs)
    FROM priced p JOIN ranked r ON r.model = p.model LEFT JOIN models md ON md.id = p.model
    GROUP BY p.bucket, CASE WHEN r.volume_rank <= 5 THEN p.model ELSE NULL END
    ORDER BY metric, rank, bucket
  `).all(...params);
  const dates = Array.from({ length: Math.max(1, Math.ceil((lastIndex - startIndex + 1) / step)) }, (_, index) => {
    const bucket = startIndex + index * step;
    const time = monthly ? Date.UTC(Math.floor(bucket / 12), bucket % 12, 1) : bucket * unit;
    const date = new Date(time).toISOString();
    const lastBucket = Math.min(lastIndex, bucket + step - 1);
    const lastDate = new Date(monthly ? Date.UTC(Math.floor(lastBucket / 12), lastBucket % 12, 1) : lastBucket * unit).toISOString();
    const label = monthly ? date.slice(0, 7) : unit < DAY ? `${date.slice(5, 10)} ${date.slice(11, 16)}` : date.slice(5, 10);
    return { date, lastDate, label };
  });
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
  const previous = scope.from === null || scope.from === 0 ? [] : filteredUsageSeries({ ...scope, from: Math.max(0, scope.from - span), to: scope.from }, userId).series;
  const users = userId === null ? breakdown(scope, null, "user_id", 8) : [];
  return { ...current, previous, modelSpend: modelChart("cost"), modelRequests: modelChart("reqs"),
    users, providers: breakdown(scope, userId, "provider_id", 5), protocols: breakdown(scope, userId, "proto", 2),
    activeUsers: users.reduce((sum, row) => sum + row.members, 0), scope: { from: scope.from, to: scope.to } };
}
