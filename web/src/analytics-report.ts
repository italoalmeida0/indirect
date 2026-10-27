import { createResource, onCleanup, untrack } from "solid-js";
import { api, type AnalyticsReport } from "./api";
import type { createAnalyticsFilters } from "./analytics-filters";
import { modelColorIndices } from "./analytics-data";

/** Keep a resolved report, its label and its exact applied query together.
 * Pending filters never relabel old data, and stale network reads are canceled. */
export function createAnalyticsReport(filters: ReturnType<typeof createAnalyticsFilters>, admin = false) {
  let abort: AbortController | undefined;
  const [report, actions] = createResource(filters.query, async (query) => {
    abort?.abort();
    const controller = abort = new AbortController();
    const label = untrack(filters.label);
    const result = await api<AnalyticsReport>("GET", `${admin ? "/api/admin" : "/api/usage"}/analytics?${query}`, undefined, controller.signal);
    return { ...result, label, query, modelColors: modelColorIndices(result.modelSpend, result.modelRequests) };
  });
  onCleanup(() => abort?.abort());
  return { report, refetch: actions.refetch };
}
