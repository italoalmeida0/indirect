import { parentPort } from "node:worker_threads";
import { ApiError } from "./http";
import { filteredTopModels, filteredUsageBreakdown, filteredUsageSeries, resolveUsageScope, usageFilterOptions } from "./usage-filters";
import { userEvents } from "./usage";
import { db } from "./db";
import type { UsageReadRequest } from "./usage-reader";
import { filteredUsageAnalytics } from "./usage-analytics";
import { catalogAuditPage, catalogFilterOptions } from "./catalog";

parentPort!.on("message", ({ id, request: r }: { id: number; request: UsageReadRequest }) => {
  try {
    const result = db.transaction(() => {
      if (r.kind === "catalog-facets") return catalogFilterOptions(r.catalog, new URLSearchParams(r.search), r.userId);
      if (r.kind === "catalog-audit") return catalogAuditPage(new URLSearchParams(r.search));
      const resolved = resolveUsageScope(r.scope);
      const scope = r.kind === "events" ? r.scope : resolved.scope;
      const data = r.kind === "analytics" ? filteredUsageAnalytics(scope, r.userId, r.scope, r.includeCost ?? true)
        : r.kind === "overview" ? { ...filteredUsageSeries(scope, r.userId), models: filteredTopModels(scope, r.userId) }
        : r.kind === "series" ? filteredUsageSeries(scope, r.userId)
        : r.kind === "facets" ? usageFilterOptions(r.userId, scope, new URLSearchParams(r.search))
        : r.kind === "events" ? userEvents(r.userId, { ...r.opts, scope })
        : filteredUsageBreakdown(scope, r.userId, r.grid, r.users, r.summaryOnly);
      const history = r.kind === "events" ? { ...resolved.history, effective: resolved.history.requested, resolution: "millisecond" as const, adjusted: false } : resolved.history;
      return { ...data, history };
    })();
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: { status: error instanceof ApiError ? error.status : 500, message: error instanceof ApiError ? error.message : "Analytics query failed" } });
  }
});
