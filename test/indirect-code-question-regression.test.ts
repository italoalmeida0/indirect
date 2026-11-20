import { afterAll, afterEach, describe, expect, mock, test, vi } from "bun:test";
import { createRoot } from "solid-js";
import type { DaemonCommand } from "../web/src/indirect-code/daemon-protocol";

// Regression: audit bug 80 — a failed question submit must clear
// questionSubmitting (via question_error) so the modal is answerable again.

mock.module("virtual:icons", () => ({ registry: {} }));
const STUBBED_GLOBAL_KEYS = [
  "localStorage",
  "document",
  "window",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
let savedBrowserGlobals: Map<string, PropertyDescriptor | undefined> | null = null;

function restoreBrowserGlobals() {
  if (!savedBrowserGlobals) return;
  const root = globalThis as Record<string, unknown>;
  for (const [key, desc] of savedBrowserGlobals) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete root[key];
  }
  savedBrowserGlobals = null;
}

// Timers are faked per test — restore the real clock and stubbed DOM globals
// AFTER each test or they leak into later test FILES (same process).
afterEach(() => {
  vi.useRealTimers();
  restoreBrowserGlobals();
});
afterAll(() => {
  restoreBrowserGlobals();
});

/** DOM globals the web hooks read at module init or in scroll plumbing. */
function stubBrowserGlobals() {
  if (!savedBrowserGlobals) {
    savedBrowserGlobals = new Map(
      STUBBED_GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
  }
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

  test("showQuestion preserves recommend and decide_later during normalization", async () => {
    stubBrowserGlobals();
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
      t.showQuestion({
        id: "q-rec",
        questions: [{
          header: "Choice",
          question: "Pick one?",
          options: [{ label: "Opt1" }, { label: "Opt2" }],
          multiple: false,
          recommend: "Opt1",
          decide_later: true,
        }],
      } as any);
      const pending = t.pendingQuestion();
      expect(pending).not.toBeNull();
      expect(pending?.questions[0].recommend).toBe("Opt1");
      expect(pending?.questions[0].decide_later).toBe(true);
      dispose();
    });
  });
});
