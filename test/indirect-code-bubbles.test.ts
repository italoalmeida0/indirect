import { afterEach, describe, expect, mock, test, vi } from "bun:test";
import { createRoot } from "solid-js";
import type { DaemonCommand } from "../web/src/indirect-code/daemon-protocol";
import type { Session } from "../web/src/api";
import type { ChatMessage, TurnBalloon, TurnChangedFile } from "../web/src/indirect-code/types";
import type { QueuedMessage, StoredAttachment } from "../web/src/indirect-code/viewTypes";
import { buildRenderBlocks } from "../web/src/indirect-code/transcript";
import { isBlockRunning, groupToolRuns } from "../web/src/indirect-code/utils/blockRuns";
import { createTurnChanges } from "../web/src/indirect-code/hooks/useTurnChanges";
import { createQueue } from "../web/src/indirect-code/hooks/useQueue";
import { createBackground } from "../web/src/indirect-code/hooks/useBackground";

// virtual:icons is a build-time module (iconify plugin) absent from bun test;
// hooks pulling the UI graph transitively only need the registry export.
mock.module("virtual:icons", () => ({ registry: {} }));
// Safety net: a test that throws before its finally clause would leak the
// fake clock into later test FILES (same process) — restore unconditionally.
afterEach(() => { vi.useRealTimers(); });

/** DOM globals the web hooks read at module init or in scroll plumbing. */
function stubBrowserGlobals() {
  const storage = new Map<string, string>();
  const root = globalThis as Record<string, unknown>;
  root.localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  };
  root.document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { dataset: {}, style: {} },
  };
  root.window = {
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // Transcript scroll scheduling is fire-and-forget; tests never await a frame.
  root.requestAnimationFrame = () => 0;
  root.cancelAnimationFrame = () => {};
  return storage;
}

/** Reconcile keys come from these rows: the ids must be unique per row. */
function rowKey(row: TurnBalloon | TurnChangedFile): string {
  return row && typeof row === "object" && "id" in row && typeof row.id === "string" ? row.id : "";
}

describe("Bug 55 — a visible message ends an aggregate's live state", () => {
  test("only the silent tail aggregate runs; text-carrying aggregates stop", () => {
    // text→tool→text→tool→text spans several render blocks in ONE turn.
    // The mid-turn texts carry summary/completion flags: plain interim text is
    // ephemeral (superseded by the next tool call) and would not stay visible.
    const list: ChatMessage[] = [
      { id: "u1", role: "user", blocks: [{ type: "text", text: "go" }] },
      { id: "m1", role: "assistant", turnIndex: 7, blocks: [{ type: "tool_call", toolId: "a1", toolName: "read", toolArgs: "{}" }] },
      { id: "m2", role: "assistant", turnIndex: 7, hasSummary: true, blocks: [{ type: "text", text: "step one" }] },
      { id: "m3", role: "assistant", turnIndex: 7, blocks: [{ type: "tool_call", toolId: "b1", toolName: "bash", toolArgs: "{}" }] },
      { id: "m4", role: "assistant", turnIndex: 7, hasCompletion: true, blocks: [{ type: "text", text: "done" }] },
      { id: "m5", role: "assistant", turnIndex: 7, blocks: [{ type: "tool_call", toolId: "c1", toolName: "bash", toolArgs: "{}" }] },
    ];
    const blocks = buildRenderBlocks(list);
    const assistantBlocks = blocks.filter((b) => b.msg.role !== "user");
    expect(assistantBlocks.length).toBeGreaterThan(1);
    // A visible message is the end-of-work signal: an aggregate that carries
    // its own text (or that a message block appeared after) is history and
    // must not spin. Only the silent tail aggregate is still working.
    const live = assistantBlocks.filter((b) => isBlockRunning(blocks, b, "running"));
    expect(live.length).toBe(1);
    expect(live[0]).toBe(assistantBlocks[assistantBlocks.length - 1]);
    expect(live[0].kind === "series" && live[0].textMsg == null).toBe(true);
    // Every aggregate that carries a message is done.
    for (const block of assistantBlocks.slice(0, -1)) {
      expect(isBlockRunning(blocks, block, "running")).toBe(false);
    }
    // And nothing is live once the session is idle.
    for (const block of assistantBlocks) {
      expect(isBlockRunning(blocks, block, "idle")).toBe(false);
    }
  });

  test("a turn ending on its answer never spins", () => {
    // tool → text fuses into ONE aggregate carrying the message: the moment
    // the message landed the work is over, even while the session still runs.
    const list: ChatMessage[] = [
      { id: "m1", role: "assistant", turnIndex: 7, blocks: [{ type: "tool_call", toolId: "a1", toolName: "read", toolArgs: "{}" }] },
      { id: "m2", role: "assistant", turnIndex: 7, hasCompletion: true, blocks: [{ type: "text", text: "done" }] },
    ];
    const blocks = buildRenderBlocks(list);
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind === "series" && blocks[0].textMsg != null).toBe(true);
    expect(isBlockRunning(blocks, blocks[0], "running")).toBe(false);
  });

  test("an aggregate a message appeared after is no longer live", () => {
    // tool (turn 7) → text (turn 8): the text is a new block after the
    // aggregate — the aggregate is history even though the session runs.
    const list: ChatMessage[] = [
      { id: "m1", role: "assistant", turnIndex: 7, blocks: [{ type: "tool_call", toolId: "a1", toolName: "read", toolArgs: "{}" }] },
      { id: "m2", role: "assistant", turnIndex: 8, blocks: [{ type: "text", text: "answer" }] },
    ];
    const blocks = buildRenderBlocks(list);
    expect(blocks.length).toBe(2);
    expect(isBlockRunning(blocks, blocks[0], "running")).toBe(false);
    expect(isBlockRunning(blocks, blocks[1], "running")).toBe(false);
  });
});

describe("Bug 56 — tool runs never merge across an entry boundary", () => {
  test("hidden thinking splits tool runs instead of merging them", () => {
    // entries: [tools1, thinking, tools2] — with verboseChat off the thinking
    // ROW is hidden, but it is still an entry boundary: merging across it
    // duplicated tools1's group with tools2's units and blanked tools2's row.
    const list: ChatMessage[] = [
      { id: "m1", role: "assistant", turnIndex: 7, blocks: [{ type: "tool_call", toolId: "a1", toolName: "read", toolArgs: "{}" }] },
      { id: "m2", role: "assistant", turnIndex: 7, blocks: [{ type: "reasoning", reasoning: "plan" }] },
      { id: "m3", role: "assistant", turnIndex: 7, blocks: [{ type: "tool_call", toolId: "b1", toolName: "bash", toolArgs: "{}" }] },
    ];
    const blocks = buildRenderBlocks(list);
    expect(blocks).toHaveLength(1);
    const series = blocks[0];
    if (series.kind !== "series") throw new Error("expected a series block");
    expect(series.entries.map((e) => e.kind)).toEqual(["tools", "thinking", "tools"]);
    const runs = groupToolRuns(series.entries);
    expect(runs.size).toBe(2);
    expect(runs.get(series.entries[0].id)?.map((u) => u.call?.toolId)).toEqual(["a1"]);
    expect(runs.get(series.entries[2].id)?.map((u) => u.call?.toolId)).toEqual(["b1"]);
  });
});

describe("Bug 57 — setBalloons reconcile keys stay unique", () => {
  test("duplicate turnIndex and duplicate file path keep every row alive", () => {
    const tc = createTurnChanges({ send: () => {}, getSessionId: () => "s", toast: () => {} });
    // Same turnIndex twice (live + committed halves before the server dedupes)
    // and one balloon carrying the same path twice (modified + new).
    tc.applySnapshot({ fileBalloons: [
      { turnIndex: 3, files: [
        { path: "dup.ts", status: "modified" },
        { path: "dup.ts", status: "new" },
        { path: "other.ts", status: "modified" },
      ] },
      { turnIndex: 3, files: [{ path: "b.ts", status: "new" }] },
    ] });
    const rows = tc.balloons();
    expect(rows).toHaveLength(2);
    // Colliding keys made the keyed reconcile merge/mismatch these rows.
    expect(new Set(rows.map(rowKey)).size).toBe(2);
    expect(rows[0].files.map((f) => f.path)).toEqual(["dup.ts", "dup.ts", "other.ts"]);
    expect(new Set(rows[0].files.map(rowKey)).size).toBe(3);
    // A repeated snapshot must keep each row's content on its own row.
    tc.applySnapshot({ fileBalloons: [
      { turnIndex: 3, files: [
        { path: "dup.ts", status: "modified" },
        { path: "dup.ts", status: "new" },
        { path: "other.ts", status: "modified" },
      ] },
      { turnIndex: 3, files: [{ path: "b.ts", status: "new" }] },
    ] });
    const after = tc.balloons();
    expect(after).toHaveLength(2);
    expect(after[0].files.map((f) => f.path)).toEqual(["dup.ts", "dup.ts", "other.ts"]);
    expect(after[1].files.map((f) => f.path)).toEqual(["b.ts"]);
    expect(new Set(after.map(rowKey)).size).toBe(2);
  });
});

describe("Bug 32 — relay reconnect survives a failing auth refresh", () => {
  test("a rejecting ensureAuth still schedules the next connect attempt", async () => {
    const storage = stubBrowserGlobals();
    storage.set("cache_code_session", JSON.stringify({
      accessToken: "token", refreshToken: "refresh", user: { id: "u" },
    }));
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      static readonly OPEN = 1;
      readonly url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this); }
      send() {}
      close() {}
    }
    const root = globalThis as Record<string, unknown>;
    const previousWebSocket = root.WebSocket;
    const previousLocation = root.location;
    root.WebSocket = FakeWebSocket;
    root.location = { protocol: "http:", host: "dashboard.test" };
    vi.useFakeTimers();
    try {
      // Dynamic import: the module graph reads localStorage at init, so the
      // stubs above must land before it loads. The session is set explicitly
      // via setSession — the api module's init-time localStorage read is
      // order-dependent when another test file loads it first.
      const { createRelay } = await import("../web/src/indirect-code/hooks/useRelay");
      const api = await import("../web/src/api");
      const previousSession = api.currentSession();
      const sessionFixture: Session = {
        accessToken: "token",
        refreshToken: "refresh",
        user: {
          id: "u", email: "u@test", name: "U", role: "admin",
          hasPassword: false, googleLinked: false, totpEnabled: false,
          status: "active", createdAt: 1,
        },
      };
      api.setSession(sessionFixture);
      const relay = createRoot((dispose) => ({
        r: createRelay({
          getHostId: () => "h1",
          onMessage: () => {},
          onOpen: () => {},
          onClose: () => {},
          ensureAuth: () => Promise.reject(new Error("transient network blip")),
          isActiveHost: () => true,
        }),
        dispose,
      }));
      relay.r.connect("h1");
      expect(FakeWebSocket.instances).toHaveLength(1);
      // First socket dies (its onclose arms the single reconnect timer).
      FakeWebSocket.instances[0].onclose?.();
      vi.advanceTimersByTime(1000);
      // Let the async timer callback resume past its rejected ensureAuth.
      await Promise.resolve();
      await Promise.resolve();
      expect(FakeWebSocket.instances).toHaveLength(2);
      relay.dispose();
      api.setSession(previousSession);
    } finally {
      vi.useRealTimers();
      root.WebSocket = previousWebSocket;
      root.location = previousLocation;
    }
  });
});

describe("Bug 63 — edit drafts survive a message moving to another srcIdx", () => {
  const prefix = "llmgw-edit:h1:s1:";
  const sourceOfHello = JSON.stringify(["user", "hello", []]);

  function transcriptOpts(sent: DaemonCommand[]) {
    return {
      send: (payload: DaemonCommand) => sent.push(payload),
      isOpen: () => true,
      getSessionId: () => "s1",
      getHostId: () => "h1",
      toast: () => {},
      showChoice: async () => null,
      onTurnIdle: () => {},
      onUsageContext: () => {},
    };
  }
  /** The user's "hello" sits at srcIdx 5 in this snapshot. */
  const rawHelloAt5 = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "assistant", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "extra" }] },
    { role: "assistant", content: [{ type: "text", text: "extra2" }] },
    { role: "user", content: "hello" },
  ];
  /** Same message one snapshot later: it lives at srcIdx 3. */
  const rawHelloAt3 = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "assistant", content: [{ type: "text", text: "more" }] },
    { role: "user", content: "hello" },
  ];

  test("draft at srcIdx 5 survives when the message moves to 3 and re-anchors", async () => {
    const storage = stubBrowserGlobals();
    storage.set(`${prefix}active`, "5");
    storage.set(`${prefix}5`, JSON.stringify({ source: sourceOfHello, text: "my draft", attachmentIds: [] }));
    // Dynamic import: module init reads the stubbed localStorage.
    const { createTranscript } = await import("../web/src/indirect-code/hooks/useTranscript");
    const sent: DaemonCommand[] = [];
    const t = createRoot((dispose) => ({
      tr: createTranscript(transcriptOpts(sent)),
      dispose,
    }));
    await t.tr.applySessionContent("s1", rawHelloAt3);
    // The user's draft must never be deleted by a lookup miss.
    expect(storage.has(`${prefix}5`)).toBe(true);
    // The edit re-anchors to the message's new home and keeps the text.
    expect(t.tr.editingMsgIdx()).toBe(3);
    expect(t.tr.editingMsgText()).toBe("my draft");
    expect(storage.get(`${prefix}active`)).toBe("3");
    expect(JSON.parse(storage.get(`${prefix}3`) || "null")?.text).toBe("my draft");
    t.dispose();
  });

  test("an open edit follows the message to its new srcIdx without losing the draft", async () => {
    const storage = stubBrowserGlobals();
    storage.set(`${prefix}active`, "5");
    storage.set(`${prefix}5`, JSON.stringify({ source: sourceOfHello, text: "my draft", attachmentIds: [] }));
    const { createTranscript } = await import("../web/src/indirect-code/hooks/useTranscript");
    const sent: DaemonCommand[] = [];
    const t = createRoot((dispose) => ({
      tr: createTranscript(transcriptOpts(sent)),
      dispose,
    }));
    // Restore first: the draft opens an edit on the message at srcIdx 5.
    await t.tr.applySessionContent("s1", rawHelloAt5);
    expect(t.tr.editingMsgIdx()).toBe(5);
    t.tr.updateEditingMsgText("typed later");
    // The transcript is rebuilt and the message now sits at srcIdx 3.
    await t.tr.applySessionContent("s1", rawHelloAt3);
    expect(t.tr.editingMsgIdx()).toBe(3);
    expect(t.tr.editingMsgText()).toBe("typed later");
    expect(storage.has(`${prefix}5`)).toBe(true);
    expect(JSON.parse(storage.get(`${prefix}3`) || "null")?.text).toBe("typed later");
    t.dispose();
  });
});

describe("Bug 33 — queue_update attachmentIds contract (web side)", () => {
  function queueFixture() {
    const sent: DaemonCommand[] = [];
    const q = createQueue({
      send: (payload) => sent.push(payload),
      getSessionId: () => "s1",
      isOpen: () => true,
      isHostOnline: () => true,
      toast: () => {},
    });
    // The daemon owns the queue: seed the item exactly as session_queue does.
    q.noteQueue("s1", [{ id: "q1", text: "queued text", attachmentIds: ["a", "b"], model: "m", yolo: false, createdAt: 1 }]);
    return { q, sent };
  }
  const item: QueuedMessage = {
    id: "q1", text: "queued text", attachmentIds: ["a", "b"],
    model: "m", yolo: false, createdAt: 1,
  };
  /** Session metadata only covers "a": "b" is stored on the daemon side. */
  const stored: Pick<StoredAttachment, "id" | "name" | "mime" | "size">[] = [
    { id: "a", name: "a.ts", mime: "text/plain", size: 3 },
  ];

  test("beginEdit preloads every attachment id, metadata or not", () => {
    const { q } = queueFixture();
    q.beginEdit(item, stored);
    const pending = q.editDraft.pendingAttachments();
    expect(pending.map((p) => p.serverId)).toEqual(["a", "b"]);
    expect(pending.every((p) => p.serverSessionId === "s1")).toBe(true);
  });

  test("a text-only edit omits attachmentIds (attachments stay unchanged)", async () => {
    const { q, sent } = queueFixture();
    q.beginEdit(item, stored);
    q.setEditingQueueText("new text");
    expect(await q.saveEdit("q1")).toBe(true);
    expect(sent).toHaveLength(1);
    const payload = sent[0] as Extract<DaemonCommand, { type: "queue_update" }>;
    expect(payload.type).toBe("queue_update");
    expect(payload.text).toBe("new text");
    expect("attachmentIds" in payload).toBe(false);
  });

  test("changed attachments send the full replacement list", async () => {
    const { q, sent } = queueFixture();
    q.beginEdit(item, stored);
    // User removes "b": the remaining list IS the new full list.
    const kept = q.editDraft.pendingAttachments().filter((p) => p.serverId !== "b");
    q.editDraft.setPendingAttachments(kept);
    expect(await q.saveEdit("q1")).toBe(true);
    const payload = sent[0] as Extract<DaemonCommand, { type: "queue_update" }>;
    expect(payload.attachmentIds).toEqual(["a"]);
  });
});

describe("Bug 49 — bg_cancel carries the owning session", () => {
  test("stop() sends sessionId so the daemon ownership check passes", () => {
    const sent: DaemonCommand[] = [];
    const bg = createRoot((dispose) => ({
      b: createBackground({
        send: (payload) => sent.push(payload),
        isOpen: () => true,
        getSessionId: () => "s1",
        toast: () => {},
      }),
      dispose,
    }));
    bg.b.stop("bg_9");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "bg_cancel", jobId: "bg_9", sessionId: "s1" });
    bg.dispose();
  });
});
