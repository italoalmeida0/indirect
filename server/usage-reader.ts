import { Worker } from "node:worker_threads";
import { ApiError } from "./http";
import { cachedUsageQueryAsync } from "./usage-cache";
import { LIMITS } from "./config";
import { resolveUsageScope } from "./usage-filters";
import type { UsageHistory, UsageScope, filteredUsageSeries, filteredTopModels, filteredUsageBreakdown, usageFilterOptions } from "./usage-filters";
import type { userEvents } from "./usage";
import type { parseGridQuery } from "./gridql";
import type { filteredUsageAnalytics } from "./usage-analytics";
import type { CatalogKind, catalogAuditPage, catalogFilterOptions } from "./catalog";

export type UsageReadRequest = { scope: UsageScope; userId: string | null } & (
  | { kind: "series" }
  | { kind: "overview"; userId: string }
  | { kind: "analytics"; includeCost?: boolean }
  | { kind: "catalog-facets"; catalog: CatalogKind; search: string }
  | { kind: "catalog-audit"; search: string }
  | { kind: "facets"; search: string }
  | { kind: "breakdown"; grid: ReturnType<typeof parseGridQuery>; users: boolean; summaryOnly: boolean }
  | { kind: "events"; opts: Parameters<typeof userEvents>[1]; userId: string }
);
type Result<R extends UsageReadRequest> = (R extends { kind: "catalog-facets" } ? ReturnType<typeof catalogFilterOptions>
  : R extends { kind: "catalog-audit" } ? ReturnType<typeof catalogAuditPage>
  : R extends { kind: "analytics" } ? ReturnType<typeof filteredUsageAnalytics>
  : R extends { kind: "overview" } ? ReturnType<typeof filteredUsageSeries> & { models: ReturnType<typeof filteredTopModels> }
  : R extends { kind: "series" } ? ReturnType<typeof filteredUsageSeries>
  : R extends { kind: "facets" } ? ReturnType<typeof usageFilterOptions>
  : R extends { kind: "events" } ? ReturnType<typeof userEvents> : ReturnType<typeof filteredUsageBreakdown>) & { history?: UsageHistory };
interface Job { id: number; expires: number; timer?: ReturnType<typeof setTimeout>; request: UsageReadRequest; resolve: (result: any) => void; reject: (error: Error) => void }
interface Reader { worker: Worker; job?: Job; timer?: ReturnType<typeof setTimeout>; stopping?: boolean }
const readers: Reader[] = [];
const queue: Job[] = [];
let sequence = 0;
const busy = () => new ApiError(503, "Analytics is busy. Please retry shortly.");

function failed(reader: Reader, error: Error = busy()) {
  const index = readers.indexOf(reader);
  if (index < 0 || reader.stopping) return;
  reader.stopping = true;
  clearTimeout(reader.timer);
  reader.job?.reject(error);
  reader.job = undefined;
  // A replacement is created only after termination finishes, keeping the
  // physical reader count bounded even if native SQLite work is slow to stop.
  const finished = () => {
    const index = readers.indexOf(reader);
    if (index >= 0) readers.splice(index, 1);
    dispatch();
  };
  void reader.worker.terminate().then(finished, finished);
}

function dispatch() {
  while (readers.length < LIMITS.analyticsReaders && queue.length > readers.filter((reader) => !reader.job && !reader.stopping).length) {
    let worker: Worker;
    try { worker = new Worker(new URL("./usage-reader-worker.ts", import.meta.url), { workerData: { usageReader: true } }); }
    catch { for (const job of queue.splice(0)) job.reject(busy()); return; }
    const reader: Reader = { worker };
    readers.push(reader);
    reader.worker.unref();
    reader.worker.on("error", () => failed(reader));
    reader.worker.on("exit", () => failed(reader));
    reader.worker.on("message", (reply: { id: number; result?: unknown; error?: { status: number; message: string } }) => {
      const job = reader.job;
      if (!job || job.id !== reply.id) return;
      clearTimeout(reader.timer); reader.job = undefined;
      if (reply.error) job.reject(new ApiError(reply.error.status, reply.error.message));
      else job.resolve(reply.result);
      dispatch();
    });
  }
  for (const reader of readers) {
    if (reader.job || reader.stopping || !queue.length) continue;
    reader.job = queue.shift()!;
    clearTimeout(reader.job.timer);
    const remaining = reader.job.expires - Date.now();
    if (remaining <= 0) { reader.job.reject(busy()); reader.job = undefined; dispatch(); return; }
    reader.timer = setTimeout(() => failed(reader), remaining);
    try { reader.worker.postMessage({ id: reader.job.id, request: reader.job.request }); }
    catch { failed(reader); }
  }
}

/** Bounded read-only workers isolate analytical GROUP BY from the proxy.
 * Identical requests coalesce; a job is cancelled only after all its callers
 * have disconnected. */
export function readUsage<R extends UsageReadRequest>(request: R, signal?: AbortSignal): Promise<Result<R>> {
  const { scope, userId, ...options } = request;
  let extra: unknown = options;
  let invalidationScope = scope;
  if (request.kind !== "catalog-facets" && request.kind !== "catalog-audit" && request.kind !== "events") {
    invalidationScope = resolveUsageScope(scope).scope;
    if (request.kind === "analytics" && scope.from !== null && scope.from > 0) {
      const previous = resolveUsageScope({ ...scope, from: Math.max(0, scope.from - (scope.to - scope.from)), to: scope.from }).scope;
      invalidationScope = { ...invalidationScope, from: previous.from };
    }
  }
  if (request.kind === "facets") {
    const search = new URLSearchParams(request.search);
    for (const key of ["from", "to", "selection"]) search.delete(key);
    search.sort(); extra = search.toString();
  }
  return cachedUsageQueryAsync(`reader-${request.kind}`, scope, userId, (sharedSignal) => new Promise<Result<R>>((resolve, reject) => {
    if (sharedSignal.aborted) { reject(new DOMException("Analytics request cancelled", "AbortError")); return; }
    if (queue.length >= LIMITS.analyticsPending) { reject(busy()); return; }
    let finished = false;
    const cleanup = () => { clearTimeout(job.timer); sharedSignal.removeEventListener("abort", abort); };
    const job: Job = {
      id: ++sequence, expires: Date.now() + LIMITS.analyticsDeadlineMs, request,
      resolve: (result) => { if (!finished) { finished = true; cleanup(); resolve(result); } },
      reject: (error) => { if (!finished) { finished = true; cleanup(); reject(error); } },
    };
    const abort = () => {
      const error = new DOMException("Analytics request cancelled", "AbortError");
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); job.reject(error); dispatch(); return; }
      const reader = readers.find((candidate) => candidate.job === job);
      if (reader) failed(reader, error);
    };
    job.timer = setTimeout(() => {
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); job.reject(busy()); }
    }, LIMITS.analyticsDeadlineMs);
    queue.push(job);
    sharedSignal.addEventListener("abort", abort, { once: true });
    if (sharedSignal.aborted) abort(); else dispatch();
  }), extra, signal, invalidationScope);
}

export async function closeUsageReaders(): Promise<void> {
  for (const job of queue.splice(0)) { clearTimeout(job.timer); job.reject(busy()); }
  const stopping: Promise<number>[] = [];
  for (const reader of readers.splice(0)) {
    clearTimeout(reader.timer); reader.job?.reject(busy()); stopping.push(reader.worker.terminate());
  }
  await Promise.all(stopping);
}
