import { describe, expect, mock, test, vi } from "bun:test";
import { createRoot } from "solid-js";
import type { DaemonCommand } from "../web/src/indirect-code/daemon-protocol";

// Regression: audit bug 79 — a concurrent fetchSession must not strand the
// order machine's `waiting` flag (the resync response's id was overwritten and
// dropped, freezing the transcript forever).

mock.module("virtual:icons", () => ({ registry: {} }));

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

describe("Bug 79 — concurrent fetchSession does not strand the resync", () => {
  test("the resync response's id is accepted even after a later fetch", async () => {
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
      // Two fetches issued back to back (resync + a page caller): ids A, B.
      t.fetchSession("s1");
      t.fetchSession("s1");
      const ids = sent.filter((p) => p.type === "get_session").map((p) => ("requestId" in p ? String(p.requestId) : ""));
      expect(ids.length).toBe(2);
      const [idA, idB] = ids;
      // THE FIX: the FIRST response (id A, the resync's) must still pass the
      // guard even though B was issued after it. Before the fix, A was
      // dropped (A !== current transcriptRequestId) and `waiting` stuck.
      expect(t.noteSessionDataRequestGuard(idA)).toBe(false); // accepted
      // Each id is good for exactly one response:
      expect(t.noteSessionDataRequestGuard(idA)).toBe(true); // consumed
      expect(t.noteSessionDataRequestGuard(idB)).toBe(false); // B still live
      expect(t.noteSessionDataRequestGuard("foreign-id")).toBe(true);
      dispose();
    });
  });
});
