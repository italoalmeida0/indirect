import { parentPort } from "node:worker_threads";
import { ApiError } from "./http";
import { filteredTopModels, filteredUsageBreakdown, filteredUsageSeries, usageFilterOptions } from "./usage-filters";
import { userEvents } from "./usage";
import { db } from "./db";
import type { UsageReadRequest } from "./usage-reader";
import { filteredUsageAnalytics } from "./usage-analytics";
import { catalogAuditPage, catalogFilterOptions } from "./catalog";

parentPort!.on("message", ({ id, request: r }: { id: number; request: UsageReadRequest }) => {
  try {
    const result = db.transaction(() => r.kind === "catalog-facets" ? catalogFilterOptions(r.catalog, new URLSearchParams(r.search), r.userId)
      : r.kind === "catalog-audit" ? catalogAuditPage(new URLSearchParams(r.search))
      : r.kind === "analytics" ? filteredUsageAnalytics(r.scope, r.userId)
      : r.kind === "overview" ? { ...filteredUsageSeries(r.scope, r.userId), models: filteredTopModels(r.scope, r.userId) }
      : r.kind === "series" ? filteredUsageSeries(r.scope, r.userId)
      : r.kind === "facets" ? usageFilterOptions(r.userId, r.scope, new URLSearchParams(r.search))
      : r.kind === "events" ? userEvents(r.userId, { ...r.opts, scope: r.scope })
      : filteredUsageBreakdown(r.scope, r.userId, r.grid, r.users, r.summaryOnly))();
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: { status: error instanceof ApiError ? error.status : 500, message: error instanceof ApiError ? error.message : "Analytics query failed" } });
  }
});
