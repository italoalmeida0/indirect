import { describe, expect, test } from "bun:test";
import { pullReplyMatches } from "../web/src/indirect-code/store/sessions";

// Regression: audit bug 34 — a pull-response must only resolve the request
// that issued it: id + hostId + COLLECTION. A stale id or a cross-tab id
// collision must never resolve a projects pull with sessions items.

describe("Bug 34 — pull-reply correlation checks the collection", () => {
  const req = { hostId: "h1", collection: "sessions" };

  test("matching host+collection resolves", () => {
    expect(pullReplyMatches(req, { hostId: "h1", collection: "sessions" })).toBe(true);
  });

  test("a wrong collection is rejected (the bug: used to resolve)", () => {
    expect(pullReplyMatches(req, { hostId: "h1", collection: "projects" })).toBe(false);
  });

  test("a wrong host is rejected", () => {
    expect(pullReplyMatches(req, { hostId: "h2", collection: "sessions" })).toBe(false);
  });

  test("a legacy reply without the echoed collection falls back to host only", () => {
    // Older daemons omit collection on the reply — the guard must not
    // reject those (the pre-bug behavior for that path is preserved).
    expect(pullReplyMatches(req, { hostId: "h1" })).toBe(true);
    expect(pullReplyMatches(req, { hostId: "h2" })).toBe(false);
  });
});
