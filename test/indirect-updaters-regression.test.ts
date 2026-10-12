import { afterEach, expect, setSystemTime, test, vi } from "bun:test";
import {
  appendToolResult,
  cutTail,
  mergeTranscriptTail,
  mergeUsage,
  normalizeSessionMessages,
  upsertToolCall,
} from "../web/src/indirect-code/transcript/updaters";
import { normalizeSession } from "../web/src/indirect-code/store/sessions";
import type { ChatMessage } from "../web/src/indirect-code/types";
// Safety net: a test that throws before its finally clause would leak the
// fake clock into later test FILES (same process) — restore unconditionally.
afterEach(() => { vi.useRealTimers(); });

const assistant = (id: string, text = ""): ChatMessage => ({
  id,
  role: "assistant",
  time: 1,
  streaming: true,
  blocks: [{ type: "text", text }],
});

// BUG-TR-01 regression: an orphan tool_result (no matching call card) must not
// land on an unrelated completed bubble.
test("orphan tool result opens its own carrier instead of polluting the last bubble", () => {
  const a1: ChatMessage = {
    id: "a1",
    role: "assistant",
    time: 1,
    blocks: [{ type: "tool_call", toolId: "callX", toolName: "bash", toolArgs: "" }],
  };
  const done = { ...assistant("a2", "answer"), streaming: false };
  const out = appendToolResult([a1, done], "callUNKNOWN", "res", false);
  const host = out.find((m) => m.blocks.some((b: any) => b.toolId === "callUNKNOWN"));
  expect(host?.id).not.toBe("a2");
  expect(host?.role).toBe("assistant");
  // The completed bubble is untouched.
  expect(out.find((m) => m.id === "a2")?.blocks).toEqual(done.blocks);
});

// The active streaming carrier may still host an orphan result (mid-turn
// detach placeholders land before the card is replayed).
test("orphan tool result still joins the active streaming carrier", () => {
  const active = assistant("a1", "thinking");
  const out = appendToolResult([active], "callLate", "res", false);
  expect(out).toHaveLength(1);
  expect(out[0].blocks.some((b: any) => b.toolId === "callLate")).toBe(true);
});

// BUG-TR-02 regression: a re-issued tool_call must update the existing card
// even when it lives in an earlier carrier than the newest assistant.
test("re-issued tool call updates the existing card in an earlier carrier", () => {
  const a1: ChatMessage = {
    id: "a1",
    role: "assistant",
    time: 1,
    blocks: [{ type: "tool_call", toolId: "callD", toolName: "bash", toolArgs: "old" }],
  };
  const steer: ChatMessage = { id: "u1", role: "user", time: 2, blocks: [{ type: "text", text: "steer" }] };
  const a2 = assistant("a2", "ok");
  const out = upsertToolCall([a1, steer, a2], "callD", "bash", { x: 1 });
  const cards = out.flatMap((m) => m.blocks).filter((b: any) => b.toolId === "callD");
  expect(cards).toHaveLength(1);
  expect((cards[0] as any).toolArgs).toContain("x");
});

// BUG-TR-03 regression: cacheTok must fall back to the previous value when a
// usage snapshot carries no cache fields at all (like reasoningTok/cost*).
test("mergeUsage preserves cacheTok when the snapshot omits cache fields", () => {
  const prev = {
    s1: {
      inTok: 10,
      outTok: 5,
      cacheTok: 777,
      reasoningTok: 3,
      costUsd: 1,
      costInUsd: 0.5,
      costCacheUsd: 0.2,
      costOutUsd: 0.3,
    },
  };
  const next = mergeUsage(prev, "s1", undefined, { input_tokens: 20, output_tokens: 9 });
  expect(next.s1.cacheTok).toBe(777);
  // Explicit zero cache fields still win (real "no cache" report).
  const zeroed = mergeUsage(prev, "s1", undefined, {
    input_tokens: 20,
    output_tokens: 9,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  expect(zeroed.s1.cacheTok).toBe(0);
  // Nonzero cache fields replace (cumulative semantics).
  const replaced = mergeUsage(prev, "s1", undefined, {
    input_tokens: 20,
    output_tokens: 9,
    cache_read_tokens: 42,
    cache_write_tokens: 8,
  });
  expect(replaced.s1.cacheTok).toBe(50);
});

// BUG 29 regression: a paged tail snapshot replaces its raw range but must
// keep optimistic echo rows (srcIdx == null) — pending user intent, not old
// tail. Before the fix every session_content dropped the echo and the user
// bubble flashed away until user_message re-stamped it.
test("paged tail snapshot keeps optimistic rows (BUG 29)", () => {
  const optimistic: ChatMessage = { id: "optimistic_1", role: "user", time: 2, blocks: [{ type: "text", text: "hello" }] };
  const prev: ChatMessage[] = [{ ...assistant("history", "old"), srcIdx: 2 }, optimistic];
  const merged = mergeTranscriptTail(prev, [{ ...assistant("msg_5", "hi"), srcIdx: 5 }], 5);
  // Older pages stay, the tail is authoritative, the echo survives last.
  expect(merged.map((m) => m.id)).toEqual(["history", "msg_5", "optimistic_1"]);
});

// BUG 30 regression: a tool_result hoisted onto an earlier carrier carries
// its own raw envelope index (here 12 on the carrier at 5). When a cut keeps
// the carrier but not the envelope (keep 10), the orphaned result must go.
test("cutTail prunes hoisted tool results whose envelope is cut (BUG 30)", () => {
  const msgs = normalizeSessionMessages([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }, { type: "tool_use", id: "t2", name: "bash", input: {} }] }, // srcIdx 5
    { role: "user", content: [{ text: "steer" }] },         // srcIdx 6
    { role: "tool", content: [{ call_id: "t2", content: [{ text: "ok" }] }] },  // srcIdx 7 — inside the cut
    { role: "user", content: [{ text: "f1" }] },            // srcIdx 8
    { role: "user", content: [{ text: "f2" }] },            // srcIdx 9
    { role: "user", content: [{ text: "f3" }] },            // srcIdx 10
    { role: "user", content: [{ text: "f4" }] },            // srcIdx 11
    { role: "tool", content: [{ call_id: "t1", content: [{ text: "ok" }] }] },  // srcIdx 12 — beyond the cut
  ], [], 5);
  const carrier = msgs.find((m) => m.srcIdx === 5);
  expect(carrier?.blocks.find((b) => b.type === "tool_result" && b.toolId === "t1")?.srcIdx).toBe(12);
  expect(carrier?.blocks.find((b) => b.type === "tool_result" && b.toolId === "t2")?.srcIdx).toBe(7);
  const cut = cutTail(msgs, 10);
  expect(cut.map((m) => m.srcIdx)).toEqual([5, 6, 8, 9, 10]);
  const kept = cut.find((m) => m.srcIdx === 5);
  expect(kept?.blocks.some((b) => b.type === "tool_result" && b.toolId === "t1")).toBe(false);
  expect(kept?.blocks.some((b) => b.type === "tool_result" && b.toolId === "t2")).toBe(true);
});

// BUG 31 regression: (m.srcIdx ?? -1) never exceeded keep, so unstamped
// optimistic echoes survived every edit/regenerate cut and accumulated.
test("cutTail drops unstamped rows together with the tail (BUG 31)", () => {
  const echo: ChatMessage = { id: "optimistic_1", role: "user", time: 2, blocks: [{ type: "text", text: "echo" }] };
  expect(cutTail([echo], 0)).toEqual([]);
  const rows: ChatMessage[] = [{ ...assistant("msg_2", "kept"), srcIdx: 2 }, echo, { ...assistant("msg_4", "gone"), srcIdx: 4 }];
  expect(cutTail(rows, 2).map((m) => m.id)).toEqual(["msg_2"]);
  expect(cutTail(rows, -1)).toEqual([]);
});

// BUG 35 regression: a corrupted/missing timestamp fell back to Date.now()
// on every pull, so useMirror's JSON.stringify equality never matched and
// the sidebar churned forever. The fallback must not read the clock.
test("normalizeSession timestamp fallback is stable across pulls (BUG 35)", () => {
  vi.useFakeTimers();
  try {
    const payload = { id: "s1", cwd: "/w", title: "T", createdAt: 0, updatedAt: 0 };
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = normalizeSession(payload, "h1");
    setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const second = normalizeSession(payload, "h1");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Genuine timestamps pass through untouched.
    expect(normalizeSession({ id: "s2", createdAt: 1700000000000, updatedAt: 1700000001000 }, "h1"))
      .toMatchObject({ createdAt: 1700000000000, updatedAt: 1700000001000 });
  } finally {
    setSystemTime();
    vi.useRealTimers();
  }
});
