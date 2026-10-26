import { db } from "./db";
import { ApiError } from "./http";
import { gridPage, type ColSpec, type parseGridQuery } from "./gridql";
import { costAggFieldsSql, modelPricingJoins } from "./pricing";

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
      clauses.push(`COALESCE(${alias}.${field}, '') ${mode === "include" ? "IN" : "NOT IN"} (${values.map(() => "?").join(",")})`);
      params.push(...values);
    }
  }
  return { clauses, params };
}

/** Whole UTC days come from the rollup. Only the two partial boundary days
 * read events, so precise local dates/times never turn a year into a raw scan. */
function usageSource(scope: UsageScope, userId: string | null) {
  const start = scope.from === null ? null : Math.ceil(scope.from / DAY) * DAY;
  const end = Math.floor(scope.to / DAY) * DAY;
  const segments: string[] = [];
  const params: Array<string | number> = [];
  const dimensions = "key_id, user_id, proto, provider_id, provider_key_id, model, upstream_model";
  if (start === null || start < end) {
    const where = usageScopeWhere(scope, "m", userId, false);
    if (start !== null) { where.clauses.push("m.date >= ?"); where.params.push(new Date(start).toISOString().slice(0, 10)); }
    where.clauses.push("m.date < ?"); where.params.push(new Date(end).toISOString().slice(0, 10));
    segments.push(`SELECT ${dimensions}, date, in_tok, cache_tok, out_tok, reqs FROM usage_model_provider_daily m WHERE ${where.clauses.join(" AND ")}`);
    params.push(...where.params);
  }
  const intervals: Array<[number | null, number]> = start !== null && start >= end
    ? [[scope.from, scope.to]]
    : [...(scope.from !== null && start !== scope.from ? [[scope.from, start!] as [number, number]] : []), ...(end < scope.to ? [[end, scope.to] as [number, number]] : [])];
  for (const [from, to] of intervals) {
    const where = usageScopeWhere({ ...scope, from, to }, "e", userId);
    segments.push(`SELECT ${dimensions}, date(ts / 1000, 'unixepoch') AS date, SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, COUNT(*) AS reqs FROM usage_events e WHERE ${where.clauses.join(" AND ")} GROUP BY ${dimensions}, date`);
    params.push(...where.params);
  }
  return { sql: `(${segments.join(" UNION ALL ")})`, params };
}

export function filteredUsageSeries(scope: UsageScope, userId: string | null) {
  const span = scope.from === null ? Infinity : scope.to - scope.from;
  const unit = span <= 3_600_000 ? 60_000 : span <= 3 * DAY ? 3_600_000 : DAY;
  let rows: any[];
  if (unit < DAY) {
    const where = usageScopeWhere(scope, "m", userId);
    rows = db.prepare(`SELECT CAST(m.ts / ${unit} AS INTEGER) * ${unit} AS bucket,
      SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, COUNT(*) AS reqs, ${costAggFieldsSql("m")}
      FROM usage_events m ${modelPricingJoins("m")} WHERE ${where.clauses.join(" AND ")} GROUP BY bucket`).all(...where.params);
  } else {
    const source = usageSource(scope, userId);
    rows = db.prepare(`SELECT CAST(strftime('%s', m.date) AS INTEGER) * 1000 AS bucket,
      SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs, ${costAggFieldsSql("m")}
      FROM ${source.sql} m ${modelPricingJoins("m")} GROUP BY m.date ORDER BY m.date`).all(...source.params);
  }
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const first = scope.from ?? rows[0]?.bucket ?? scope.to - DAY;
  const points = [];
  // Long histories stay sparse rather than allocating unbounded empty days.
  const buckets = (scope.to - first) / unit > 4000 ? rows.map((r) => r.bucket) :
    Array.from({ length: Math.ceil(scope.to / unit) - Math.floor(first / unit) }, (_, i) => Math.floor(first / unit) * unit + i * unit);
  for (const bucket of buckets) {
    const row = byBucket.get(bucket);
    const date = new Date(bucket).toISOString();
    points.push({ date: unit === DAY ? date.slice(0, 10) : `${date.slice(0, 10)} ${date.slice(11, 16)} UTC`,
      ...(unit < DAY ? { label: `${span >= DAY ? `${date.slice(5, 10)} ` : ""}${date.slice(11, 16)}` } : {}),
      in_tok: row?.in_tok ?? 0, cache_tok: row?.cache_tok ?? 0, out_tok: row?.out_tok ?? 0,
      reqs: row?.reqs ?? 0, cost_in: row?.cost_in ?? 0, cost_cache: row?.cost_cache ?? 0, cost_out: row?.cost_out ?? 0, cost: row?.cost ?? 0 });
  }
  return { series: points, granularity: unit === DAY ? "day" : unit === 60_000 ? "minute" : "hour" };
}

export function filteredUsageBreakdown(scope: UsageScope, userId: string | null, grid: ReturnType<typeof parseGridQuery>, users = false) {
  const source = usageSource(scope, userId);
  const cols: Record<string, ColSpec> = {};
  const visibleFields = users ? ["user_id", "email"] : ["model", "proto", "provider_id", "provider_key_id", "upstream_model", "provider_name", "provider_key_label", ...(userId === null ? [] : ["key_id", "key_name"])];
  for (const field of visibleFields) cols[field] = { col: field };
  const sumCols = ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"];
  for (const field of sumCols) cols[field] = { col: field, kind: "number" };
  const dimensions = `${userId === null ? "" : "m.key_id, "}m.model, m.proto, m.provider_id, m.provider_key_id, m.upstream_model`;
  return gridPage({
    baseSql: `SELECT ${users ? "m.user_id, COALESCE(u.email, m.user_id) AS email" : `${dimensions}, ${userId === null ? "" : "COALESCE(k.name, substr(m.key_id, 1, 8)) AS key_name, "}p.name AS provider_name, pk.label AS provider_key_label`},
      SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs, ${costAggFieldsSql("m")}
      FROM ${source.sql} m
      ${users ? "LEFT JOIN users u ON u.id = m.user_id" : "LEFT JOIN api_keys k ON k.id = m.key_id LEFT JOIN providers p ON p.id = m.provider_id LEFT JOIN provider_keys pk ON pk.id = m.provider_key_id"}
      ${modelPricingJoins("m")}
      GROUP BY ${users ? "m.user_id" : dimensions}`,
    baseParams: source.params, cols, grid,
    defaultOrder: "reqs DESC", tieBreak: users ? "user_id DESC" : `${userId === null ? "" : "key_id DESC, "}model DESC, proto DESC, provider_id DESC, provider_key_id DESC, upstream_model DESC`, sumCols,
  });
}

/** Values come only from visible usage history, including deleted resources.
 * No credentials, prefixes or other users' identities enter the user scope. */
export function usageFilterOptions(userId: string | null) {
  const labels: Record<Field, string> = { model: "Model", provider_id: "Provider", key_id: "API key", proto: "Protocol", upstream_model: "Upstream model", provider_key_id: "Upstream key", user_id: "User" };
  const icons: Record<Field, string> = { model: "box", provider_id: "server", key_id: "key", proto: "arrow-left-right", upstream_model: "layers", provider_key_id: "shield", user_id: "users" };
  const scope = userId === null ? "" : "WHERE m.user_id = ?";
  const categories = fields.filter((f) => f !== "user_id" || userId === null).map((field) => {
    const label = field === "key_id" ? "COALESCE(k.name, substr(m.key_id, 1, 8))"
      : field === "provider_id" ? "COALESCE(p.name, substr(m.provider_id, 1, 8))"
      : field === "provider_key_id" ? "COALESCE(pk.label, substr(m.provider_key_id, 1, 8))"
      : field === "user_id" ? "COALESCE(u.email, m.user_id)" : `m.${field}`;
    const join = field === "key_id" ? "LEFT JOIN api_keys k ON k.id = m.key_id" : field === "provider_id" ? "LEFT JOIN providers p ON p.id = m.provider_id" : field === "provider_key_id" ? "LEFT JOIN provider_keys pk ON pk.id = m.provider_key_id" : field === "user_id" ? "LEFT JOIN users u ON u.id = m.user_id" : "";
    const options = db.prepare(`SELECT COALESCE(m.${field}, '') AS value, COALESCE(NULLIF(${label}, ''), 'Unknown') AS label, SUM(m.reqs) AS count
      FROM usage_model_provider_daily m ${join} ${scope} GROUP BY m.${field} ORDER BY label COLLATE NOCASE, value`).all(...(userId === null ? [] : [userId]));
    return { id: field, label: labels[field], icon: icons[field], options };
  });
  return categories;
}
