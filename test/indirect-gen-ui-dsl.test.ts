import { describe, expect, test } from "bun:test";

import {
  frozenDuplicateSegmentIds,
  parseGenerativeUiDsl,
  splitGenerativeUiSegments,
  withGenerativeUiSegmentIds,
  generativeUiSegmentId,
} from "../web/src/indirect-code/components/generative-ui/dsl";

/**
 * The fence carries HEADER LINES ONLY (placeholder / state / widget_id). The widget
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

describe("frozenDuplicateSegmentIds", () => {
  const fence = (id: string) => "```generative_ui\nwidget_id: " + id + "\n```";

  test("only the LAST fence of a widget id stays active", () => {
    const segs = withGenerativeUiSegmentIds(
      splitGenerativeUiSegments(fence("w1") + "\n\ntext\n\n" + fence("w1") + "\n\n" + fence("w2")),
    );
    const frozen = frozenDuplicateSegmentIds(segs);
    const widgets = segs.filter((s) => s.kind === "widget");
    expect(widgets).toHaveLength(3);
    expect(frozen.has(widgets[0].id)).toBe(true); // first w1 frozen
    expect(frozen.has(widgets[1].id)).toBe(false); // last w1 active
    expect(frozen.has(widgets[2].id)).toBe(false); // w2 active
  });

  test("a single fence never freezes", () => {
    const segs = withGenerativeUiSegmentIds(splitGenerativeUiSegments(fence("only") + "\n"));
    expect(frozenDuplicateSegmentIds(segs).size).toBe(0);
  });

  test("three duplicates freeze the two earlier ones", () => {
    const segs = withGenerativeUiSegmentIds(
      splitGenerativeUiSegments([fence("x"), fence("x"), fence("x")].join("\n\n")),
    );
    expect(frozenDuplicateSegmentIds(segs).size).toBe(2);
  });
});

describe("widget-live registry (one live instance per widget id)", () => {
  test("the newest claim supersedes earlier ones; release reactivates", async () => {
    const { claimLiveWidget, releaseLiveWidget, liveWidgetCount } = await import(
      "../web/src/indirect-code/components/generative-ui/widget-live"
    );
    const events: string[] = [];
    const mk = (name: string) => {
      const token = Symbol(name);
      return {
        token,
        entry: {
          token,
          onSupersede: () => events.push(`supersede:${name}`),
          onReactivate: () => events.push(`reactivate:${name}`),
        },
      };
    };
    const a = mk("a");
    const b = mk("b");
    const c = mk("c");
    claimLiveWidget("w1", a.entry);
    claimLiveWidget("w1", b.entry);
    claimLiveWidget("w1", c.entry);
    expect(events).toEqual(["supersede:a", "supersede:b"]);
    expect(liveWidgetCount("w1")).toBe(3);

    // The active one leaves: the newest survivor comes back.
    releaseLiveWidget("w1", c.token);
    expect(events.at(-1)).toBe("reactivate:b");
    releaseLiveWidget("w1", b.token);
    expect(events.at(-1)).toBe("reactivate:a");
    releaseLiveWidget("w1", a.token);
    expect(liveWidgetCount("w1")).toBe(0);
    // Releasing an unknown token is a no-op.
    releaseLiveWidget("w1", a.token);
  });

  test("session-scoped single active widget supersedes across distinct widget ids", async () => {
    const { claimLiveWidget, releaseLiveWidget, liveWidgetCount } = await import(
      "../web/src/indirect-code/components/generative-ui/widget-live"
    );
    const events: string[] = [];
    const mk = (name: string) => {
      const token = Symbol(name);
      return {
        token,
        entry: {
          token,
          onSupersede: () => events.push(`supersede:${name}`),
          onReactivate: () => events.push(`reactivate:${name}`),
        },
      };
    };
    const greeter = mk("greeter");
    const counter = mk("counter");

    // Mount greeter-widget in session-1
    claimLiveWidget("greeter-widget", greeter.entry, "session-1");
    expect(events).toEqual([]);

    // Mount counter-widget in session-1 -> greeter is superseded
    claimLiveWidget("counter-widget", counter.entry, "session-1");
    expect(events).toEqual(["supersede:greeter"]);
    expect(liveWidgetCount("counter-widget", "session-1")).toBe(1);
    expect(liveWidgetCount("greeter-widget", "session-1")).toBe(1);

    // Release counter-widget in session-1 -> greeter is reactivated
    releaseLiveWidget("counter-widget", counter.token, "session-1");
    expect(events.at(-1)).toBe("reactivate:greeter");

    releaseLiveWidget("greeter-widget", greeter.token, "session-1");
    expect(liveWidgetCount("", "session-1")).toBe(0);
  });
});
