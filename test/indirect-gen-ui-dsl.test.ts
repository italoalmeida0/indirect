import { describe, expect, test } from "bun:test";

import {
  parseGenerativeUiDsl,
  splitGenerativeUiSegments,
  withGenerativeUiSegmentIds,
  generativeUiSegmentId,
} from "../web/src/indirect-code/components/generative-ui/dsl";

/**
 * The fence carries HEADER LINES ONLY (placeholder / state / id). The widget
 * source lives in the session's widget store; `widget_id:` is the link. Legacy
 * `@jsx` bodies are migrated away daemon-side and never parsed here.
 */
describe("parseGenerativeUiDsl (headers only)", () => {
  test("widget_id + placeholder + state headers", () => {
    const d = parseGenerativeUiDsl(`placeholder: Building your savings projection
state: {"amount": 1000, "years": 5}
widget_id: savings`);
    expect(d.id).toBe("savings");
    expect(d.placeholder).toBe("Building your savings projection");
    expect(d.state).toEqual({ amount: 1000, years: 5 });
  });

  test("widget_id alone (the common case)", () => {
    const d = parseGenerativeUiDsl("widget_id: savings");
    expect(d.id).toBe("savings");
    expect(d.placeholder).toBeUndefined();
    expect(d.state).toBeUndefined();
  });

  test("missing/blank body parses to empty data (static card)", () => {
    expect(parseGenerativeUiDsl(undefined)).toEqual({});
    expect(parseGenerativeUiDsl("")).toEqual({});
    expect(parseGenerativeUiDsl("\n\n")).toEqual({});
  });

  test("invalid state JSON is ignored, headers still parse", () => {
    const d = parseGenerativeUiDsl(`state: {oops
widget_id: w1`);
    expect(d.id).toBe("w1");
    expect(d.state).toBeUndefined();
  });

  test("non-object state is ignored", () => {
    expect(parseGenerativeUiDsl(`state: [1,2]`).state).toBeUndefined();
    expect(parseGenerativeUiDsl(`state: "x"`).state).toBeUndefined();
    expect(parseGenerativeUiDsl(`state: 5`).state).toBeUndefined();
  });

  test("unknown headers (incl. bare id:) and legacy noise are ignored", () => {
    const d = parseGenerativeUiDsl(`placeholder: Hi
state: {"a": 1}
widget_id: w1
@jsx
export default function App() { return null; }`);
    expect(d.id).toBe("w1");
    expect(d.placeholder).toBe("Hi");
    expect(d.state).toEqual({ a: 1 });
  });

  test("values are bounded", () => {
    const d = parseGenerativeUiDsl(`placeholder: ${"x".repeat(500)}
widget_id: ${"y".repeat(500)}`);
    expect(d.placeholder!.length).toBeLessThanOrEqual(120);
    expect(d.id!.length).toBeLessThanOrEqual(120);
  });
});

describe("splitGenerativeUiSegments", () => {
  test("markdown around a closed fence", () => {
    const segs = splitGenerativeUiSegments(`before

\`\`\`generative_ui
widget_id: w1
\`\`\`

after`);
    expect(segs.map((s) => s.kind)).toEqual(["md", "widget", "md"]);
    const widget = segs[1];
    if (widget.kind !== "widget") throw new Error("kind");
    expect(widget.closed).toBe(true);
    expect(widget.body).toContain("widget_id: w1");
  });

  test("an open fence at stream end is an open widget segment", () => {
    const segs = splitGenerativeUiSegments(`text\n\`\`\`generative_ui\nwidget_id: w1`);
    expect(segs.map((s) => s.kind)).toEqual(["md", "widget"]);
    const widget = segs[1];
    if (widget.kind !== "widget") throw new Error("kind");
    expect(widget.closed).toBe(false);
  });

  test("empty fence body still mounts a widget segment", () => {
    const segs = splitGenerativeUiSegments("```generative_ui\n```");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("widget");
  });

  test("other languages stay in the markdown run", () => {
    const segs = splitGenerativeUiSegments("```js\nconst x = 1;\n```");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("md");
  });

  test("four backticks work too", () => {
    const segs = splitGenerativeUiSegments("````generative_ui\nwidget_id: w1\n````");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("widget");
  });

  test("segment ids are stable and kind-sensitive", () => {
    const segs = splitGenerativeUiSegments(`a\n\`\`\`generative_ui\nwidget_id: w1\n\`\`\``);
    const withIds = withGenerativeUiSegmentIds(segs);
    expect(withIds[0].id).toBe(generativeUiSegmentId(segs[0], 0));
    expect(withIds[1].id).not.toBe(withIds[0].id);
  });
});
