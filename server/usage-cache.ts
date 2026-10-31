import { auditRevision, db } from "./db";
import type { UsageScope } from "./usage-filters";
import { ApiError } from "./http";
import { LIMITS } from "./config";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 256;
const TTL = 30_000;
interface Entry {
  value: unknown;
  bytes: number;
  expires: number;
  userId: string | null;
  from: number | null;
  to: number;
}
const entries = new Map<string, Entry>();
interface Pending {
  promise: Promise<unknown>;
  scope: UsageScope;
  userId: string | null;
  invalidated: boolean;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
const pending = new Map<string, Pending>();
let activeJobs = 0;
let bytes = 0;
let revision = -1;
let dataVersion = -1;
const readVersion = db.prepare<{ data_version: number }, []>("PRAGMA data_version");

function remove(key: string, entry: Entry) {
  entries.delete(key);
  bytes -= entry.bytes;
}

function synchronize() {
  const version = readVersion.get()!.data_version;
  if (version !== dataVersion || auditRevision !== revision) {
    entries.clear(); bytes = 0;
    for (const job of pending.values()) job.invalidated = true;
    dataVersion = version; revision = auditRevision;
  }
}

function cached(key: string) {
  const hit = entries.get(key);
  if (hit) {
    if (hit.expires > Date.now()) { entries.delete(key); entries.set(key, hit); return hit; }
    remove(key, hit);
  }
}

function insert(key: string, value: unknown, scope: UsageScope, userId: string | null) {
  const size = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
  if (size > MAX_BYTES / 4) return;
  const now = Date.now();
  const previous = entries.get(key);
  if (previous) remove(key, previous);
  for (const [oldKey, entry] of entries) {
    if (entry.expires <= now || bytes + size > MAX_BYTES || entries.size >= MAX_ENTRIES) remove(oldKey, entry);
    else break;
  }
  entries.set(key, { value, bytes: size, expires: now + TTL, userId, from: scope.from, to: scope.to });
  bytes += size;
}

/** Canonical keys make equivalent checkbox selections reuse the same work.
 * Tenant identity is part of every key, including for empty selections. */
export function usageQueryKey(scope: UsageScope, userId: string | null, kind: string, extra?: unknown): string {
  const selection = Object.keys(scope.selection).filter((field) => {
    const entry = scope.selection[field as keyof UsageScope["selection"]]!;
    return entry.include.length || entry.exclude.length;
  }).sort().map((field) => {
    const entry = scope.selection[field as keyof UsageScope["selection"]]!;
    return [field, [...entry.include].sort(), [...entry.exclude].sort()];
  });
  return JSON.stringify([kind, userId, scope.from, scope.to, selection, extra]);
}

/** Bounded LRU, never an alternate ledger. Audited metadata changes invalidate
 * names/pricing, external SQLite writers invalidate via data_version, and
 * ingestion invalidates only overlapping user/time windows. */
export function cachedUsageQuery<T>(kind: string, scope: UsageScope, userId: string | null, load: () => T, extra?: unknown): T {
  synchronize();
  const key = usageQueryKey(scope, userId, kind, extra);
  const hit = cached(key);
  if (hit) return hit.value as T;
  const value = load();
  insert(key, value, scope, userId);
  return value;
}

/** Coalesce identical reader jobs. A write during a query prevents its result
 * from entering the cache; readers already waiting still receive their snapshot. */
export function cachedUsageQueryAsync<T>(kind: string, scope: UsageScope, userId: string | null, load: (signal: AbortSignal) => Promise<T>, extra?: unknown, signal?: AbortSignal, invalidationScope = scope): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException("Analytics request cancelled", "AbortError"));
  synchronize();
  const key = usageQueryKey(scope, userId, kind, extra);
  const hit = cached(key);
  if (hit) return Promise.resolve(hit.value as T);
  let job = pending.get(key);
  if (!job || job.invalidated) {
    if (activeJobs >= LIMITS.analyticsPending) return Promise.reject(new ApiError(503, "Analytics is busy. Please retry shortly."));
    const created: Pending = { scope: invalidationScope, userId, invalidated: false, controller: new AbortController(), waiters: 0, settled: false, promise: undefined as unknown as Promise<T> };
    activeJobs++;
    created.promise = Promise.resolve().then(() => load(created.controller.signal)).then((value) => {
      synchronize();
      if (!created.invalidated) insert(key, value, invalidationScope, userId);
      return value;
    }).finally(() => {
      created.settled = true;
      activeJobs--;
      if (pending.get(key) === created) pending.delete(key);
    });
    pending.set(key, created);
    job = created;
  }
  const subscribed = job;
  subscribed.waiters++;
  return new Promise<T>((resolve, reject) => {
    let active = true;
    const done = () => {
      if (!active) return false;
      active = false;
      signal?.removeEventListener("abort", abort);
      subscribed.waiters--;
      return true;
    };
    const abort = () => {
      if (!done()) return;
      if (!subscribed.waiters && !subscribed.settled) {
        subscribed.invalidated = true;
        if (pending.get(key) === subscribed) pending.delete(key);
        subscribed.controller.abort();
      }
      reject(new DOMException("Analytics request cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    subscribed.promise.then((value) => { if (done()) resolve(value as T); }, (error) => { if (done()) reject(error); });
  });
}

export function invalidateUsageQueries(events: Array<{ userId: string; ts: number }>): void {
  if ((!entries.size && !pending.size) || !events.length) return;
  const spans = new Map<string | null, { from: number; to: number }>();
  for (const event of events) {
    for (const id of [event.userId, null]) {
      const span = spans.get(id);
      if (span) { span.from = Math.min(span.from, event.ts); span.to = Math.max(span.to, event.ts); }
      else spans.set(id, { from: event.ts, to: event.ts });
    }
  }
  for (const [key, entry] of entries) {
    const span = spans.get(entry.userId);
    if (span && span.from < entry.to && (entry.from === null || span.to >= entry.from)) remove(key, entry);
  }
  for (const job of pending.values()) {
    const span = spans.get(job.userId);
    if (span && span.from < job.scope.to && (job.scope.from === null || span.to >= job.scope.from)) job.invalidated = true;
  }
}
