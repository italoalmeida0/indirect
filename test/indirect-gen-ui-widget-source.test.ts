import { describe, expect, test } from "bun:test";

import {
  fetchWidgetSource,
  invalidateWidgetSources,
  noteWidgetData,
  widgetSourceVersion,
  type GetWidgetCommand,
  type WidgetSourceRecord,
} from "../web/src/indirect-code/components/generative-ui/widget-source";

/**
 * Widget source cache semantics. Each case here is a regression guard for
 * the "returning to a session shows a stale/missing widget" bug:
 *   - late daemon answers must refill the RIGHT cache entry (never a dead
 *     synthetic key) and bump the version so renderers retry;
 *   - null answers are never cached;
 *   - invalidation drops entries AND stale in-flight answers.
 */

type Sent = GetWidgetCommand[];

function rec(id: string, source: string): WidgetSourceRecord {
  return { id, source };
}

function drain() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("widget source cache", () => {
  test("serves a cached answer without a second request", async () => {
    const sent: Sent = [];
    const p1 = fetchWidgetSource((c) => sent.push(c), "h1", "s1", "w1");
    expect(sent).toHaveLength(1);
    noteWidgetData({ requestId: sent[0].requestId, sessionId: "s1", widget: rec("w1", "v1") });
    expect((await p1)?.source).toBe("v1");

    const p2 = fetchWidgetSource((c) => sent.push(c), "h1", "s1", "w1");
    expect(sent).toHaveLength(1); // cache hit: no new command
    expect((await p2)?.source).toBe("v1");
    invalidateWidgetSources("s1");
    await drain();
  });

  test("a late answer refills the real entry and bumps the version", async () => {
    const sent: Sent = [];
    const before = widgetSourceVersion.get();
    const p = fetchWidgetSource((c) => sent.push(c), "h1", "s2", "w2", 0);
    // Simulate the request timing out, then the daemon answering late.
    expect(await p).toBeNull();
    await drain();
    noteWidgetData({ requestId: sent[0].requestId, sessionId: "s2", widget: rec("w2", "late") });
    expect(widgetSourceVersion.get()).toBeGreaterThan(before);
    // The next fetch must be a cache hit carrying the late source —
    // the old bug cached it under key("", session, id) and the real entry
    // stayed empty forever.
    const p2 = fetchWidgetSource((c) => sent.push(c), "h1", "s2", "w2");
    expect(sent).toHaveLength(1);
    expect((await p2)?.source).toBe("late");
    invalidateWidgetSources("s2");
    await drain();
  });

  test("null answers are never cached (widget_set later must be visible)", async () => {
    const sent: Sent = [];
    const p = fetchWidgetSource((c) => sent.push(c), "h1", "s3", "w3", 0);
    // Daemon answers "no widget".
    noteWidgetData({ requestId: sent[0].requestId, sessionId: "s3" });
    expect(await p).toBeNull();

    // widget_set happens (invalidates), then a fence re-renders.
    invalidateWidgetSources("s3", "w3");
    await drain();
    const p2 = fetchWidgetSource((c) => sent.push(c), "h1", "s3", "w3");
    expect(sent).toHaveLength(2); // a fresh request, NOT a cached null
    noteWidgetData({ requestId: sent[1].requestId, sessionId: "s3", widget: rec("w3", "fresh") });
    expect((await p2)?.source).toBe("fresh");
    invalidateWidgetSources("s3");
    await drain();
  });

  test("invalidation drops in-flight answers (stale fetch cannot refill)", async () => {
    const sent: Sent = [];
    const p = fetchWidgetSource((c) => sent.push(c), "h1", "s4", "w4");
    invalidateWidgetSources("s4", "w4"); // widget_set while the fetch is in flight
    await drain();
    // The stale answer arrives after the invalidation: must NOT cache.
    noteWidgetData({ requestId: sent[0].requestId, sessionId: "s4", widget: rec("w4", "stale") });
    const p2 = fetchWidgetSource((c) => sent.push(c), "h1", "s4", "w4");
    expect(sent).toHaveLength(2); // re-fetched after invalidation
    noteWidgetData({ requestId: sent[1].requestId, sessionId: "s4", widget: rec("w4", "new") });
    expect((await p2)?.source).toBe("new");
    expect(await p).toBeNull(); // the invalidated request resolved null
    invalidateWidgetSources("s4");
    await drain();
  });

  test("invalidation scopes by session and widget id", async () => {
    const sent: Sent = [];
    const a = fetchWidgetSource((c) => sent.push(c), "h1", "s5", "wa");
    const b = fetchWidgetSource((c) => sent.push(c), "h1", "s5", "wb");
    noteWidgetData({ requestId: sent[0].requestId, sessionId: "s5", widget: rec("wa", "A") });
    noteWidgetData({ requestId: sent[1].requestId, sessionId: "s5", widget: rec("wb", "B") });
    await Promise.all([a, b]);

    invalidateWidgetSources("s5", "wa");
    await drain();
    // wb survives; wa must be re-fetched.
    const a2 = fetchWidgetSource((c) => sent.push(c), "h1", "s5", "wa");
    const b2 = fetchWidgetSource((c) => sent.push(c), "h1", "s5", "wb");
    expect(sent).toHaveLength(3); // only wa re-requested
    expect((await b2)?.source).toBe("B");
    noteWidgetData({ requestId: sent[2].requestId, sessionId: "s5", widget: rec("wa", "A2") });
    expect((await a2)?.source).toBe("A2");
    invalidateWidgetSources("s5");
    await drain();
  });

  test("session switching invalidates that session's widgets only", async () => {
    const sent: Sent = [];
    const p = fetchWidgetSource((c) => sent.push(c), "h1", "gone", "w");
    noteWidgetData({ requestId: sent[0].requestId, sessionId: "gone", widget: rec("w", "old") });
    expect((await p)?.source).toBe("old");

    // Re-entering the session drops its cache (fresh source on return).
    invalidateWidgetSources("gone");
    await drain();
    const p2 = fetchWidgetSource((c) => sent.push(c), "h1", "gone", "w");
    expect(sent).toHaveLength(2);
    noteWidgetData({ requestId: sent[1].requestId, sessionId: "gone", widget: rec("w", "updated") });
    expect((await p2)?.source).toBe("updated");
    invalidateWidgetSources("gone");
    await drain();
  });
});
