import { Worker } from "node:worker_threads";
import { ApiError } from "./http";
import { cachedUsageQueryAsync } from "./usage-cache";
import type { UsageScope, filteredUsageSeries, filteredTopModels, filteredUsageBreakdown, usageFilterOptions } from "./usage-filters";
import type { userEvents } from "./usage";
import type { parseGridQuery } from "./gridql";
import type { filteredUsageAnalytics } from "./usage-analytics";

export type UsageReadRequest = { scope: UsageScope; userId: string | null } & (
  | { kind: "series" }
  | { kind: "overview"; userId: string }
  | { kind: "analytics" }
  | { kind: "facets"; search: string }
  | { kind: "breakdown"; grid: ReturnType<typeof parseGridQuery>; users: boolean; summaryOnly: boolean }
  | { kind: "events"; opts: Parameters<typeof userEvents>[1]; userId: string }
);
type Result<R extends UsageReadRequest> = R extends { kind: "analytics" } ? ReturnType<typeof filteredUsageAnalytics>
  : R extends { kind: "overview" } ? ReturnType<typeof filteredUsageSeries> & { models: ReturnType<typeof filteredTopModels> }
  : R extends { kind: "series" } ? ReturnType<typeof filteredUsageSeries>
  : R extends { kind: "facets" } ? ReturnType<typeof usageFilterOptions>
  : R extends { kind: "events" } ? ReturnType<typeof userEvents> : ReturnType<typeof filteredUsageBreakdown>;
interface Job { id: number; expires: number; timer?: ReturnType<typeof setTimeout>; request: UsageReadRequest; resolve: (result: any) => void; reject: (error: Error) => void }
interface Reader { worker: Worker; job?: Job; timer?: ReturnType<typeof setTimeout>; stopping?: boolean }
const readers: Reader[] = [];
const queue: Job[] = [];
let sequence = 0;
const busy = () => new ApiError(503, "Analytics is busy. Please retry shortly.");

function failed(reader: Reader) {
  const index = readers.indexOf(reader);
  if (index < 0 || reader.stopping) return;
  reader.stopping = true;
  clearTimeout(reader.timer);
  reader.job?.reject(busy());
  reader.job = undefined;
  // A replacement is created only after termination finishes, keeping the
  // physical reader count bounded even if native SQLite work is slow to stop.
  void reader.worker.terminate().finally(() => {
    const index = readers.indexOf(reader);
    if (index >= 0) readers.splice(index, 1);
    dispatch();
  });
}

function dispatch() {
  while (queue.length && readers.length < 2) {
    const reader: Reader = { worker: new Worker(new URL("./usage-reader-worker.ts", import.meta.url), { workerData: { usageReader: true } }) };
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
    reader.worker.postMessage({ id: reader.job.id, request: reader.job.request });
  }
}

/** Two independent read-only SQLite connections keep analytical GROUP BY and
 * sorting off the proxy event loop. Queue + deadlines bound overload; identical
 * requests coalesce before consuming a reader slot. No writes run here. */
export function readUsage<R extends UsageReadRequest>(request: R): Promise<Result<R>> {
  const { scope, userId, ...options } = request;
  let extra: unknown = options;
  if (request.kind === "facets") {
    const search = new URLSearchParams(request.search);
    for (const key of ["from", "to", "selection"]) search.delete(key);
    search.sort(); extra = search.toString();
  }
  return cachedUsageQueryAsync(`reader-${request.kind}`, scope, userId, () => new Promise<Result<R>>((resolve, reject) => {
    if (queue.length >= 16) { reject(busy()); return; }
    const job: Job = { id: ++sequence, expires: Date.now() + 30_000, request, resolve, reject };
    job.timer = setTimeout(() => {
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); job.reject(busy()); }
    }, 30_000);
    queue.push(job);
    dispatch();
  }), extra);
}

export async function closeUsageReaders(): Promise<void> {
  for (const job of queue.splice(0)) { clearTimeout(job.timer); job.reject(busy()); }
  const stopping: Promise<number>[] = [];
  for (const reader of readers.splice(0)) {
    clearTimeout(reader.timer); reader.job?.reject(busy()); stopping.push(reader.worker.terminate());
  }
  await Promise.all(stopping);
}
