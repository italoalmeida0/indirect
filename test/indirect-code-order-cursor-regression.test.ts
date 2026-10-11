import { describe, expect, test } from "bun:test";
import { createTranscriptOrder } from "../web/src/indirect-code/transcript/order";

// Regression: audit bugs 26, 46 — cursor-less events/snapshots with an active
// stream must trigger a resync (the old code dropped them silently: no apply,
// no request — the client diverged forever).

describe("Bug 46 — cursor-less event after stream init requests a resync", () => {
  test("event(undefined) does not apply and requests a resync", () => {
    let resyncs = 0;
    const order = createTranscriptOrder(() => { resyncs++; });
    let applied = 0;
    order.event({ stream: "s", seq: 1 }, () => { applied++; });
    expect(applied).toBe(1);
    order.event(undefined, () => { applied++; });
    // THE FIX: dropped without apply, but a resync is requested.
    expect(applied).toBe(1);
    expect(resyncs).toBe(1);
  });

  test("before stream init a cursor-less event still applies (legacy)", () => {
    let resyncs = 0;
    const order = createTranscriptOrder(() => { resyncs++; });
    let applied = 0;
    order.event(undefined, () => { applied++; });
    expect(applied).toBe(1);
    expect(resyncs).toBe(0);
  });
});

describe("Bug 26 — cursor-less snapshot with active stream requests a resync", () => {
  test("snapshot(undefined) returns null AND requests a resync", () => {
    let resyncs = 0;
    const order = createTranscriptOrder(() => { resyncs++; });
    order.event({ stream: "s", seq: 1 }, () => {});
    const replay = order.snapshot(undefined);
    // THE FIX: null (caller discards) + resync requested (re-anchor).
    expect(replay).toBeNull();
    expect(resyncs).toBe(1);
  });

  test("cursor-less snapshot with NO stream returns [] and no resync", () => {
    let resyncs = 0;
    const order = createTranscriptOrder(() => { resyncs++; });
    const replay = order.snapshot(undefined);
    expect(replay).toEqual([]);
    expect(resyncs).toBe(0);
  });
});
