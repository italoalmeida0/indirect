import type { Database } from "bun:sqlite";

export interface ProjectUsageRequest {
  projectId: string;
  projectKind: "project" | "cost_center";
  from: number;
  toExclusive: number;
  includeCost: boolean;
}
export interface ProjectUsageTotals {
  requests: number;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  successRequests: number;
  errorRequests: number;
  costUsd?: number;
}
const dateString = (time: number) => new Date(time).toISOString().slice(0, 10);
const monthStart = (time: number) => { const d = new Date(time); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const nextMonth = (time: number) => { const d = new Date(time); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/** Read whole months from monthly rows and partial boundary months from
 * daily rows. The caller authorizes the scope before submitting this job. */
export function projectUsageReport(db: Database, request: ProjectUsageRequest): ProjectUsageTotals {
  const { projectId, projectKind, from, toExclusive, includeCost } = request;
  const dimension = projectKind === "project" ? "project_id" : "cost_center_id";
  const select = `COALESCE(SUM(reqs),0) AS requests, COALESCE(SUM(in_tok),0) AS inputTokens,
    COALESCE(SUM(cache_tok),0) AS cacheTokens, COALESCE(SUM(out_tok),0) AS outputTokens,
    COALESCE(SUM(success_reqs),0) AS successRequests, COALESCE(SUM(error_reqs),0) AS errorRequests${includeCost ? ", COALESCE(SUM(cost_in_nanos + cost_cache_nanos + cost_out_nanos),0) AS costNanos" : ""}`;
  const firstFull = from === monthStart(from) ? from : nextMonth(from);
  const lastFullEnd = monthStart(toExclusive);
  const result: Record<string, number> = { requests: 0, inputTokens: 0, cacheTokens: 0, outputTokens: 0, successRequests: 0, errorRequests: 0 };
  if (includeCost) result.costNanos = 0;
  const add = (table: "daily" | "monthly", start: string, stop: string) => {
    const col = table === "daily" ? "date" : "month";
    const row = db.query<Record<string, number>, [string, string, string]>(`SELECT ${select} FROM usage_financial_${table} WHERE ${dimension} = ? AND ${col} >= ? AND ${col} < ?`).get(projectId, start, stop)!;
    for (const key of Object.keys(result)) result[key] = (result[key] ?? 0) + Number(row[key] ?? 0);
  };
  if (firstFull >= lastFullEnd) add("daily", dateString(from), dateString(toExclusive));
  else {
    if (from < firstFull) add("daily", dateString(from), dateString(firstFull));
    add("monthly", dateString(firstFull).slice(0, 7), dateString(lastFullEnd).slice(0, 7));
    if (lastFullEnd < toExclusive) add("daily", dateString(lastFullEnd), dateString(toExclusive));
  }
  if (includeCost) { result.costUsd = result.costNanos! / 1e9; delete result.costNanos; }
  return result as unknown as ProjectUsageTotals;
}
