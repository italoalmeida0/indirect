import { describe, expect, test } from "bun:test";
import { normalizeSessionMessages } from "../web/src/indirect-code/transcript/updaters";

// Regression: audit bug 69 — a background_delivery fold row carrying a
// tool_result must not hoist a synthetic carrier (empty bubble).
describe("Bug 69 — background fold rows never render a bubble", () => {
  test("fold row with a tool_result renders nothing", () => {
    const out = normalizeSessionMessages([{
      id: "n1",
      role: "user",
      content: [{ type: "tool_result", call_id: "c1", content: [{ text: "fold" }] }],
      meta: { background_delivery: "job1" },
    }]);
    expect(out.length).toBe(0);
  });

  test("fold row with plain text renders nothing", () => {
    const out = normalizeSessionMessages([{
      id: "n2",
      role: "user",
      content: [{ type: "text", text: "<system-reminder>done</system-reminder>" }],
      meta: { background_delivery: "job2" },
    }]);
    expect(out.length).toBe(0);
  });

  test("a normal row with a tool_result still hoists its carrier", () => {
    const out = normalizeSessionMessages([{
      id: "t1",
      role: "tool",
      content: [{ type: "tool_result", call_id: "c1", content: [{ text: "real" }] }],
    }]);
    expect(out.length).toBe(1);
    expect(out[0].role).toBe("assistant");
  });
});
