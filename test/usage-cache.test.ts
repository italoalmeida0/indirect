import { describe, expect, test } from "bun:test";
import { cachedUsageQuery, cachedUsageQueryAsync, invalidateUsageQueries } from "../server/usage-cache";
import { audit } from "../server/db";
import type { UsageScope } from "../server/usage-filters";
import { LIMITS } from "../server/config";

const scope: UsageScope = { from: 100, to: 200, selection: {} };

describe("bounded analytics query cache", () => {
  test("canonical selections share work and tenant identities do not", () => {
    let reads = 0;
    const load = () => ++reads;
    const a = { ...scope, selection: { model: { include: ["a", "b"], exclude: [] } } };
    const b = { ...scope, selection: { model: { include: ["b", "a"], exclude: [] } } };
    expect(cachedUsageQuery("canonical-test", a, "one", load)).toBe(1);
    expect(cachedUsageQuery("canonical-test", b, "one", load)).toBe(1);
    expect(cachedUsageQuery("canonical-test", b, "two", load)).toBe(2);
  });

  test("writes invalidate only overlapping user and global windows", () => {
    let reads = 0;
    const load = () => ++reads;
    const get = (user: string | null) => cachedUsageQuery("range-test", scope, user, load);
    expect(get("one")).toBe(1);
    expect(get("two")).toBe(2);
    expect(get(null)).toBe(3);
    invalidateUsageQueries([{ userId: "one", ts: 200 }]); // exclusive end
    expect(get("one")).toBe(1);
    invalidateUsageQueries([{ userId: "one", ts: 150 }]);
    expect(get("one")).toBe(4);
    expect(get("two")).toBe(2);
    expect(get(null)).toBe(5);
  });

  test("a query can invalidate on its expanded or comparison window", async () => {
    let reads = 0;
    const load = async () => ++reads;
    const expanded = { ...scope, from: 50 };
    const get = () => cachedUsageQueryAsync("expanded-window", scope, "one", load, undefined, undefined, expanded);
    expect(await get()).toBe(1);
    invalidateUsageQueries([{ userId: "one", ts: 75 }]);
    expect(await get()).toBe(2);
  });

  test("audited metadata mutations invalidate names and pricing immediately", () => {
    let reads = 0;
    const get = () => cachedUsageQuery("metadata-test", scope, "one", () => ++reads);
    expect(get()).toBe(1);
    audit("test.analytics-cache");
    expect(get()).toBe(2);
  });

  test("an unbounded sequence of view keys evicts old entries", () => {
    let reads = 0;
    const get = (i: number) => cachedUsageQuery("capacity-test", scope, String(i), () => ++reads);
    expect(get(0)).toBe(1);
    for (let i = 1; i <= 300; i++) get(i);
    expect(get(0)).toBe(302);
  });

  test("concurrent readers coalesce and writes during a read prevent stale caching", async () => {
    let resolve!: (value: number) => void;
    let reads = 0;
    const load = () => { reads++; return new Promise<number>((done) => resolve = done); };
    const first = cachedUsageQueryAsync("inflight-test", scope, "one", load);
    const second = cachedUsageQueryAsync("inflight-test", scope, "one", load);
    await Promise.resolve();
    expect(reads).toBe(1);
    invalidateUsageQueries([{ userId: "one", ts: 150 }]);
    resolve(1);
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(await cachedUsageQueryAsync("inflight-test", scope, "one", async () => ++reads)).toBe(2);
  });

  test("pending queries are bounded before reader dispatch", async () => {
    const releases: Array<() => void> = [];
    const jobs = Array.from({ length: LIMITS.analyticsPending }, (_, i) => cachedUsageQueryAsync("pending-limit-test", scope, `pending-${i}`, () => new Promise<number>((resolve) => releases.push(() => resolve(i)))));
    try {
      await expect(cachedUsageQueryAsync("pending-limit-test", scope, "overflow", async () => 0)).rejects.toMatchObject({ status: 503 });
    } finally {
      await Promise.resolve();
      for (const release of releases) release();
      await Promise.all(jobs);
    }
  });

  test("cancelled subscribers do not cancel shared work needed by another caller", async () => {
    const first = new AbortController(), second = new AbortController();
    let finish!: (value: number) => void;
    let runs = 0, cancelled = false;
    const load = (signal: AbortSignal) => {
      runs++;
      signal.addEventListener("abort", () => { cancelled = true; });
      return new Promise<number>((resolve) => { finish = resolve; });
    };
    const a = cachedUsageQueryAsync("shared-cancel", scope, "one", load, undefined, first.signal);
    const b = cachedUsageQueryAsync("shared-cancel", scope, "one", load, undefined, second.signal);
    const rejected = a.then(() => "resolved", (error) => error.name);
    await Promise.resolve();
    first.abort();
    expect(await rejected).toBe("AbortError");
    expect(cancelled).toBe(false);
    finish(7);
    expect(await b).toBe(7);
    expect(runs).toBe(1);
  });

  test("a job is cancelled after its final subscriber leaves, and a new caller can retry", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const task = cachedUsageQueryAsync("all-cancel", scope, "one", (signal) => new Promise<number>((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(new DOMException("cancelled", "AbortError")); });
    }), undefined, controller.signal);
    const rejected = task.then(() => "resolved", (error) => error.name);
    await Promise.resolve();
    controller.abort();
    expect(await rejected).toBe("AbortError");
    expect(cancelled).toBe(true);
    expect(await cachedUsageQueryAsync("all-cancel", scope, "one", async () => 9)).toBe(9);
  });
});
