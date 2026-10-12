import { afterEach, describe, expect, mock, test, vi } from "bun:test";
import { createRoot } from "solid-js";
import type { DaemonCommand } from "../web/src/indirect-code/daemon-protocol";

// Regression: audit bug 80 — a failed question submit must clear
// questionSubmitting (via question_error) so the modal is answerable again.

mock.module("virtual:icons", () => ({ registry: {} }));
// Timers are faked per test — restore the real clock AFTER each test or the
// fake clock leaks into later test FILES (same process): their beforeAll
// hooks (Bun.sleep-based readiness polls) then hang forever.
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

describe("Bug 80 — question submit failure is recoverable", () => {
  test("noteQuestionError clears questionSubmitting for the same question", async () => {
    stubBrowserGlobals();
    vi.useFakeTimers();
    // Module-loading boundary: mock.module("virtual:icons") must be
    // registered before useTranscript's chain (ui.tsx) loads it — a static
    // import would be hoisted above the mock.
    const { createTranscript } = await import("../web/src/indirect-code/hooks/useTranscript");
    const sent: DaemonCommand[] = [];
    const t = createTranscript({
      send: (p) => { sent.push(p); },
      isOpen: () => true,
      getSessionId: () => "s1",
      getHostId: () => "h1",
      toast: () => {},
      showChoice: async () => null,
      onTurnIdle: () => {},
      onUsageContext: () => {},
    });
    createRoot((dispose) => {
      t.showQuestion({ id: "q1", questions: [{ header: "", question: "Q?", options: [], multiple: false }] });
      t.answerQuestion([["a"]]);
      expect(sent.some((p) => p.type === "question_response")).toBe(true);
      // The daemon answers with question_error for the SAME id (validation
      // failure keeps the question pending).
      t.noteQuestionError("s1", "q1", "bad answers");
      // THE FIX: submitting cleared → a retry is accepted.
      t.answerQuestion([["b"]]);
      const responses = sent.filter((p) => p.type === "question_response");
      expect(responses.length).toBe(2);
      dispose();
    });
  });

  test("a question_error for a superseded id does not clobber the new question", async () => {
    stubBrowserGlobals();
    vi.useFakeTimers();
    // Module-loading boundary: same as above.
    const { createTranscript } = await import("../web/src/indirect-code/hooks/useTranscript");
    const sent: DaemonCommand[] = [];
    const t = createTranscript({
      send: (p) => { sent.push(p); },
      isOpen: () => true,
      getSessionId: () => "s1",
      getHostId: () => "h1",
      toast: () => {},
      showChoice: async () => null,
      onTurnIdle: () => {},
      onUsageContext: () => {},
    });
    createRoot((dispose) => {
      t.showQuestion({ id: "q1", questions: [{ header: "", question: "Q1?", options: [], multiple: false }] });
      t.answerQuestion([["a"]]);
      // q2 supersedes q1 (snapshot) — submitting resets via showQuestion.
      t.showQuestion({ id: "q2", questions: [{ header: "", question: "Q2?", options: [], multiple: false }] });
      // A LATE question_error for the dead q1 must not touch q2's state.
      t.noteQuestionError("s1", "q1", "late error");
      t.answerQuestion([["b"]]);
      const responses = sent.filter((p) => p.type === "question_response");
      expect(responses.length).toBe(2);
      dispose();
    });
  });
});
