import { afterEach, describe, expect, mock, test, vi } from "bun:test";
import { createRoot } from "solid-js";

// Regression: audit bug 81 — a replayed approval/question request for an
// already-resolved id must not resurrect the dead card (the daemon drops the
// user's answer on the stale branch, silently).

mock.module("virtual:icons", () => ({ registry: {} }));
// Timers are faked per test — restore the real clock AFTER each test or the
// fake clock leaks into later test FILES (same process): their beforeAll
// hooks (Bun.sleep-based readiness polls) then hang forever.
afterEach(() => { vi.useRealTimers(); });

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
  root.requestAnimationFrame = () => 0;
  root.cancelAnimationFrame = () => {};
}

describe("Bug 81 — replayed requests cannot resurrect resolved cards", () => {
  test("approval_request after approval_resolved stays dead", async () => {
    stubBrowserGlobals();
    vi.useFakeTimers();
    // Module-loading boundary: mock.module("virtual:icons") must be
    // registered before useTranscript's chain (ui.tsx) loads it — a static
    // import would be hoisted above the mock.
    const { createTranscript } = await import("../web/src/indirect-code/hooks/useTranscript");
    const t = createTranscript({
      send: () => {},
      isOpen: () => true,
      getSessionId: () => "s1",
      getHostId: () => "h1",
      toast: () => {},
      showChoice: async () => null,
      onTurnIdle: () => {},
      onUsageContext: () => {},
    });
    createRoot((dispose) => {
      t.noteApprovalRequest({ type: "tool_approval_request", sessionId: "s1", callId: "c1", tool: "bash", args: "{}" });
      expect(t.pendingApproval()?.callId).toBe("c1");
      t.noteApprovalResolved("s1", "c1");
      expect(t.pendingApproval()).toBeNull();
      // Late replay of the SAME request (wire replay after resolution).
      t.noteApprovalRequest({ type: "tool_approval_request", sessionId: "s1", callId: "c1", tool: "bash", args: "{}" });
      expect(t.pendingApproval()).toBeNull(); // stays dead
      // A genuinely new call is unaffected.
      t.noteApprovalRequest({ type: "tool_approval_request", sessionId: "s1", callId: "c2", tool: "bash", args: "{}" });
      expect(t.pendingApproval()?.callId).toBe("c2");
      dispose();
    });
  });

  test("question_request after question_resolved stays dead", async () => {
    stubBrowserGlobals();
    vi.useFakeTimers();
    // Module-loading boundary: same as above.
    const { createTranscript } = await import("../web/src/indirect-code/hooks/useTranscript");
    const t = createTranscript({
      send: () => {},
      isOpen: () => true,
      getSessionId: () => "s1",
      getHostId: () => "h1",
      toast: () => {},
      showChoice: async () => null,
      onTurnIdle: () => {},
      onUsageContext: () => {},
    });
    createRoot((dispose) => {
      const q = { id: "q1", questions: [{ header: "", question: "Q?", options: [], multiple: false, answers: [] }] };
      t.showQuestion(q as never);
      expect(t.pendingQuestion()?.id).toBe("q1");
      t.noteQuestionResolved("s1", "q1");
      expect(t.pendingQuestion()).toBeNull();
      // Late replay of the same question.
      t.showQuestion(q as never);
      expect(t.pendingQuestion()).toBeNull(); // stays dead
      dispose();
    });
  });
});
