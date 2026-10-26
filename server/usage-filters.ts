import { db } from "./db";
import { ApiError } from "./http";
import { gridPage, type ColSpec, type parseGridQuery } from "./gridql";
import { costAggFieldsSql, costRowFieldsSql, modelPricingJoins } from "./pricing";
import { cachedUsageQuery } from "./usage-cache";

const DAY = 86_400_000;
const fields = ["model", "provider_id", "key_id", "proto", "upstream_model", "provider_key_id", "user_id"] as const;
type Field = typeof fields[number];
interface UsageSelection { include: string[]; exclude: string[] }
export interface UsageScope {
  from: number | null;
  to: number;
  selection: Partial<Record<Field, UsageSelection>>;
}

/** Explicit analytics queries coexist with the older days/hours API. Reject
 * invalid input rather than silently showing an unexpectedly wider scope. */
export function readUsageScope(url: URL, admin = false): UsageScope | null {
  if (!url.searchParams.has("from") && !url.searchParams.has("to") && !url.searchParams.has("selection")) return null;
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const from = rawFrom === "all" ? null : Number(rawFrom);
  const to = rawTo === null ? Date.now() : Number(rawTo);
  if (rawFrom === null || rawFrom === "" || (from !== null && (!Number.isSafeInteger(from) || from < 0))
    || !Number.isSafeInteger(to) || to <= 0 || to > 8_640_000_000_000_000 || (from !== null && from >= to)) {
    throw new ApiError(400, "Invalid time range");
  }
  const selection: UsageScope["selection"] = {};
  const raw = url.searchParams.get("selection");
  if (raw) {
    if (raw.length > 32_000) throw new ApiError(400, "Too many filter values");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ApiError(400, "Invalid filters"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Invalid filters");
    let count = 0;
    for (const [key, value] of Object.entries(parsed)) {
      if (!fields.includes(key as Field) || (key === "user_id" && !admin)) throw new ApiError(400, "Unknown filter");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "Invalid filter values");
      const entry: UsageSelection = { include: [], exclude: [] };
      for (const mode of ["include", "exclude"] as const) {
        const values = (value as Record<string, unknown>)[mode] ?? [];
        if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || v.length > 512)) throw new ApiError(400, "Invalid filter values");
        entry[mode] = [...new Set(values)] as string[];
        count += entry[mode].length;
      }
      if (count > 250) throw new ApiError(400, "Too many filter values");
      selection[key as Field] = entry;
    }
  }
  // Preserve legacy scoping if a caller also supplies a singular filter.
  for (const field of ["key_id", "provider_id", ...(admin ? ["user_id" as const] : [])] as const) {
    const value = url.searchParams.get(field);
    if (value && !selection[field]) selection[field] = { include: [value], exclude: [] };
  }
  return { from, to, selection };
}

export function usageScopeWhere(scope: UsageScope, alias: string, userId: string | null, time = true) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (userId !== null) { clauses.push(`${alias}.user_id = ?`); params.push(userId); }
  if (time) {
    if (scope.from !== null) { clauses.push(`${alias}.ts >= ?`); params.push(scope.from); }
    clauses.push(`${alias}.ts < ?`); params.push(scope.to);
  }
  for (const field of fields) {
    const selection = scope.selection[field];
    if (!selection) continue;
    for (const mode of ["include", "exclude"] as const) {
      const values = selection[mode];
      if (!values.length) continue;
      clauses.push(`${alias}.${field} ${mode === "include" ? "IN" : "NOT IN"} (${values.map(() => "?").join(",")})`);
      params.push(...values);
    }
  }
  return { clauses, params };
}

/** Complete UTC months use monthly aggregates, boundary days use the daily
 * ledger, and only the two partial days read raw events. Segments never overlap. */
function usageSource(scope: UsageScope, userId: string | null, field?: Field, monthly = true) {
  const start = scope.from === null ? null : Math.ceil(scope.from / DAY) * DAY;
  const end = Math.floor(scope.to / DAY) * DAY;
  const segments: string[] = [];
  const params: Array<string | number> = [];
  const dimensions = field ?? "key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model";
  const metrics = field ? "" : "in_tok, cache_tok, out_tok, ";
  if (start === null || start < end) {
    const monthStart = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
    const nextMonth = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
    const firstMonth = start === null ? null : start === monthStart(start) ? start : nextMonth(start);
    const lastMonth = monthStart(end);
    const hasMonths = monthly && (firstMonth === null || firstMonth < lastMonth);
    if (hasMonths) {
      const where = usageScopeWhere(scope, "m", userId, false);
      if (firstMonth !== null) { where.clauses.push("m.month >= ?"); where.params.push(new Date(firstMonth).toISOString().slice(0, 7)); }
      where.clauses.push("m.month < ?"); where.params.push(new Date(lastMonth).toISOString().slice(0, 7));
      segments.push(`SELECT ${dimensions}, month || '-01' AS date, ${metrics}reqs FROM usage_model_provider_monthly m WHERE ${where.clauses.join(" AND ")}`);
      params.push(...where.params);
    }
    const days: Array<[number | null, number]> = hasMonths
      ? [...(start !== null && start < firstMonth! ? [[start, firstMonth!] as [number, number]] : []), ...(lastMonth < end ? [[lastMonth, end] as [number, number]] : [])]
      : [[start, end]];
    for (const [from, to] of days) {
      const where = usageScopeWhere(scope, "m", userId, false);
      if (from !== null) { where.clauses.push("m.date >= ?"); where.params.push(new Date(from).toISOString().slice(0, 10)); }
      where.clauses.push("m.date < ?"); where.params.push(new Date(to).toISOString().slice(0, 10));
      segments.push(`SELECT ${dimensions}, date, ${metrics}reqs FROM usage_model_provider_daily m WHERE ${where.clauses.join(" AND ")}`);
      params.push(...where.params);
    }
  }
  const intervals: Array<[number | null, number]> = start !== null && start >= end
    ? [[scope.from, scope.to]]
    : [...(scope.from !== null && start !== scope.from ? [[scope.from, start!] as [number, number]] : []), ...(end < scope.to ? [[end, scope.to] as [number, number]] : [])];
  for (const [from, to] of intervals) {
    const where = usageScopeWhere({ ...scope, from, to }, "e", userId);
    const sums = field ? "" : "SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, ";
    segments.push(`SELECT ${dimensions}, date(ts / 1000, 'unixepoch') AS date, ${sums}COUNT(*) AS reqs FROM usage_events e WHERE ${where.clauses.join(" AND ")} GROUP BY ${dimensions}, date`);
    params.push(...where.params);
  }
  return { sql: `(${segments.join(" UNION ALL ")})`, params };
}

export function filteredUsageSeries(scope: UsageScope, userId: string | null) {
  return cachedUsageQuery("series", scope, userId, () => buildUsageSeries(scope, userId));
}

function buildUsageSeries(scope: UsageScope, userId: string | null) {
  const span = scope.from === null ? Infinity : scope.to - scope.from;
  const monthly = span > 400 * DAY;
  const unit = span <= 3_600_000 ? 60_000 : span <= 3 * DAY ? 3_600_000 : DAY;
  let rows: any[];
  if (unit < DAY) {
    const where = usageScopeWhere(scope, "m", userId);
    rows = db.prepare(`SELECT m.bucket, SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs, ${costAggFieldsSql("m")}
      FROM (SELECT CAST(e.ts / ${unit} AS INTEGER) * ${unit} AS bucket, e.model, e.upstream_model,
        SUM(e.in_tok) AS in_tok, SUM(e.cache_tok) AS cache_tok, SUM(e.out_tok) AS out_tok, COUNT(*) AS reqs
        FROM usage_events e WHERE ${where.clauses.map((clause) => clause.replaceAll("m.", "e.")).join(" AND ")}
        GROUP BY bucket, e.model, e.upstream_model) m
      ${modelPricingJoins("m")} GROUP BY m.bucket ORDER BY m.bucket`).all(...where.params);
  } else {
    // Daily charts must keep daily buckets; long windows can consume monthly
    // rows because their displayed buckets are months as well.
    const source = usageSource(scope, userId, undefined, monthly);
    rows = db.prepare(`SELECT CAST(strftime('%s', m.date) AS INTEGER) * 1000 AS bucket,
      SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs, ${costAggFieldsSql("m")}
      FROM (SELECT ${monthly ? "substr(s.date, 1, 7) || '-01'" : "s.date"} AS date, s.model, s.upstream_model, SUM(s.in_tok) AS in_tok, SUM(s.cache_tok) AS cache_tok, SUM(s.out_tok) AS out_tok, SUM(s.reqs) AS reqs
        FROM ${source.sql} s GROUP BY ${monthly ? "substr(s.date, 1, 7)" : "s.date"}, s.model, s.upstream_model) m
      ${modelPricingJoins("m")} GROUP BY m.date ORDER BY m.date`).all(...source.params);
  }
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const first = scope.from ?? rows[0]?.bucket ?? scope.to - DAY;
  const points = [];
  // Long histories stay sparse rather than allocating unbounded empty days.
  const buckets: number[] = [];
  if (monthly) {
    const d = new Date(first); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() < scope.to && buckets.length < 4000) { buckets.push(d.getTime()); d.setUTCMonth(d.getUTCMonth() + 1); }
  } else if ((scope.to - first) / unit > 4000) buckets.push(...rows.map((r) => r.bucket));
  else for (let bucket = Math.floor(first / unit) * unit; bucket < scope.to; bucket += unit) buckets.push(bucket);
  for (const bucket of buckets) {
    const row = byBucket.get(bucket);
    const date = new Date(bucket).toISOString();
    points.push({ date: unit === DAY ? date.slice(0, 10) : `${date.slice(0, 10)} ${date.slice(11, 16)} UTC`,
      ...(monthly ? { label: date.slice(0, 7) } : unit < DAY ? { label: `${span >= DAY ? `${date.slice(5, 10)} ` : ""}${date.slice(11, 16)}` } : {}),
      in_tok: row?.in_tok ?? 0, cache_tok: row?.cache_tok ?? 0, out_tok: row?.out_tok ?? 0,
      reqs: row?.reqs ?? 0, cost_in: row?.cost_in ?? 0, cost_cache: row?.cost_cache ?? 0, cost_out: row?.cost_out ?? 0, cost: row?.cost ?? 0 });
  }
  return { series: points, granularity: monthly ? "month" : unit === DAY ? "day" : unit === 60_000 ? "minute" : "hour" };
}

/** Rank public models across keys/protocols, retaining the busiest route for
 * attribution. The same segmented rollups preserve exact partial-day bounds. */
export function filteredTopModels(scope: UsageScope, userId: string) {
  return cachedUsageQuery("top-models", scope, userId, () => {
    const source = usageSource(scope, userId);
    return db.prepare<{
      model: string; model_name: string; reqs: number; provider_id: string;
      provider_name: string | null; upstream_model: string; route_count: number;
    }, Array<string | number>>(`WITH routes AS (
      SELECT s.model, s.provider_id, s.upstream_model, SUM(s.reqs) AS reqs
      FROM ${source.sql} s GROUP BY s.model, s.provider_id, s.upstream_model
      HAVING SUM(s.reqs) > 0
    ), ranked AS (
      SELECT *, SUM(reqs) OVER (PARTITION BY model) AS model_reqs,
        COUNT(*) OVER (PARTITION BY model) AS route_count,
        ROW_NUMBER() OVER (PARTITION BY model ORDER BY reqs DESC, provider_id, upstream_model) AS route_rank
      FROM routes
    )
    SELECT r.model, COALESCE(NULLIF(m.name, ''), r.model) AS model_name,
      r.model_reqs AS reqs, r.provider_id, p.name AS provider_name, r.upstream_model, r.route_count
    FROM ranked r LEFT JOIN providers p ON p.id = r.provider_id LEFT JOIN models m ON m.id = r.model
    WHERE r.route_rank = 1 ORDER BY r.model_reqs DESC, r.model LIMIT 5`).all(...source.params);
  });
}

export function filteredUsageBreakdown(scope: UsageScope, userId: string | null, grid: ReturnType<typeof parseGridQuery>, users = false, summaryOnly = false) {
  const source = usageSource(scope, userId);
  const cols: Record<string, ColSpec> = {};
  const visibleFields = users ? ["user_id", "email"] : ["model", "proto", "provider_id", "provider_key_id", "upstream_model", "provider_name", "provider_key_label", ...(userId === null ? [] : ["key_id", "key_name"])];
  for (const field of visibleFields) cols[field] = { col: field };
  const sumCols = ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"];
  for (const field of sumCols) cols[field] = { col: field, kind: "number" };
  const dimensions = `${userId === null ? "" : "m.key_id, "}m.model, m.proto, m.provider_id, m.provider_key_id, m.upstream_model`;
  const group = users ? "m.user_id, m.model, m.upstream_model" : dimensions;
  const grouped = `SELECT ${group}, SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs
    FROM ${source.sql} m GROUP BY ${group}`;
  const args = {
    baseSql: `SELECT ${users ? "m.user_id, COALESCE(u.email, m.user_id) AS email, SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs" : `${dimensions}, ${userId === null ? "" : "COALESCE(k.name, substr(m.key_id, 1, 8)) AS key_name, "}p.name AS provider_name, pk.label AS provider_key_label, m.in_tok, m.cache_tok, m.out_tok, m.reqs`},
      ${users ? costAggFieldsSql("m") : costRowFieldsSql("m")}
      FROM (${grouped}) m
      ${users ? "LEFT JOIN users u ON u.id = m.user_id" : `${userId === null ? "" : "LEFT JOIN api_keys k ON k.id = m.key_id"} LEFT JOIN providers p ON p.id = m.provider_id LEFT JOIN provider_keys pk ON pk.id = m.provider_key_id`}
      ${modelPricingJoins("m")}
      ${users ? "GROUP BY m.user_id" : ""}`,
    baseParams: source.params, cols, grid,
    defaultOrder: "reqs DESC", tieBreak: users ? "user_id DESC" : `${userId === null ? "" : "key_id DESC, "}model DESC, proto DESC, provider_id DESC, provider_key_id DESC, upstream_model DESC`, sumCols,
  };
  const summary = cachedUsageQuery("breakdown-summary", scope, userId, () => {
    const result = gridPage({ ...args, includeRows: false });
    return { total: result.total, totals: result.totals };
  }, [users, grid.filters]);
  if (summaryOnly) return { rows: [], ...summary };
  return cachedUsageQuery("breakdown-page", scope, userId, () => gridPage({ ...args, summary }), [users, grid]);
}

/** Values come only from visible usage history, including deleted resources.
 * No credentials, prefixes or other users' identities enter the user scope. */
export function usageFilterOptions(userId: string | null, scope: UsageScope, search: URLSearchParams) {
  const labels: Record<Field, string> = { model: "Model", provider_id: "Provider", key_id: "API key", proto: "Protocol", upstream_model: "Upstream model", provider_key_id: "Upstream key", user_id: "User" };
  const icons: Record<Field, string> = { model: "box", provider_id: "server", key_id: "key", proto: "arrow-left-right", upstream_model: "layers", provider_key_id: "shield", user_id: "users" };
  const allowed = fields.filter((f) => f !== "user_id" || userId === null);
  const range = { ...scope, selection: {} };
  const field = search.get("field");
  if (field !== null) {
    if (!allowed.includes(field as Field)) throw new ApiError(400, "Unknown filter");
    const q = (search.get("q") ?? "").trim();
    const rawLimit = search.get("limit");
    const rawOffset = search.get("offset");
    const limit = rawLimit === null ? 60 : Number(rawLimit);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (q.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, "Invalid filter page");
    return cachedUsageQuery("facet-page", range, userId, () => {
      const query = facetSql(field as Field, range, userId);
      const where = q ? "WHERE (label LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')" : "";
      const needle = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const params = [...query.params, ...(q ? [needle, needle] : [])];
      const filtered = `SELECT * FROM (${query.sql}) ${where}`;
      const rows = db.prepare<{ value: string; label: string; count: number; total: number }, any[]>(`SELECT *, COUNT(*) OVER () AS total FROM (${filtered}) ORDER BY count DESC, label COLLATE NOCASE, value LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const total = rows[0]?.total ?? (offset > 0 ? db.prepare<{ total: number }, any[]>(`SELECT COUNT(*) AS total FROM (${filtered})`).get(...params)!.total : 0);
      return { field, options: rows.map(({ total: _, ...row }) => row), total, limit, offset };
    }, [field, q, limit, offset]);
  }
  // Metadata is cheap and independent of category searches. Only existing
  // selections need validation before the client applies a changed date range.
  return cachedUsageQuery("facet-selection", scope, userId, () => {
    const selection: UsageScope["selection"] = {};
    const selectedOptions: Partial<Record<Field, Array<{ value: string; label: string; count: number }>>> = {};
    for (const field of allowed) {
      const selected = scope.selection[field];
      if (!selected || (!selected.include.length && !selected.exclude.length)) continue;
      const query = facetSql(field, { ...range, selection: { [field]: { include: [...new Set([...selected.include, ...selected.exclude])], exclude: [] } } }, userId);
      const rows = db.prepare<{ value: string; label: string; count: number }, any[]>(query.sql).all(...query.params);
      const valid = new Set(rows.map((row) => row.value));
      const entry = { include: selected.include.filter((value) => valid.has(value)), exclude: selected.exclude.filter((value) => valid.has(value)) };
      if (entry.include.length || entry.exclude.length) { selection[field] = entry; selectedOptions[field] = rows; }
    }
    return { categories: allowed.map((field) => ({ id: field, label: labels[field], icon: icons[field] })), selection, selectedOptions };
  });
}

function facetSql(field: Field, scope: UsageScope, userId: string | null) {
  const source = usageSource(scope, userId, field);
  const label = field === "key_id" ? "COALESCE(k.name, substr(c.value, 1, 8))"
    : field === "provider_id" ? "COALESCE(p.name, substr(c.value, 1, 8))"
    : field === "provider_key_id" ? "COALESCE(pk.label, substr(c.value, 1, 8))"
    : field === "user_id" ? "COALESCE(u.email, c.value)" : "c.value";
  const join = field === "key_id" ? "LEFT JOIN api_keys k ON k.id = c.value" : field === "provider_id" ? "LEFT JOIN providers p ON p.id = c.value" : field === "provider_key_id" ? "LEFT JOIN provider_keys pk ON pk.id = c.value" : field === "user_id" ? "LEFT JOIN users u ON u.id = c.value" : "";
  return {
    sql: `SELECT c.value, COALESCE(NULLIF(${label}, ''), 'Unknown') AS label, c.count
      FROM (SELECT m.${field} AS value, SUM(m.reqs) AS count FROM ${source.sql} m GROUP BY m.${field} HAVING SUM(m.reqs) > 0) c ${join}`,
    params: source.params,
  };
}
