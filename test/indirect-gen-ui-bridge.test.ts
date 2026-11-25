import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  attachGuBridge,
  createWidgetPublishController,
  MAX_STATE_CHARS,
  parseSavedStateJSON,
  resolveWidgetStateJSON,
  type WidgetPublishResult,
} from "../web/src/indirect-code/components/generative-ui/bridge";
import { WIDGET_BASE_CSS } from "../web/src/indirect-code/components/generative-ui/widget-doc";

describe("gen-ui state persistence helpers", () => {
  test("parseSavedStateJSON accepts plain objects up to 64KB and rejects corrupt/non-object/oversized payloads", () => {
    expect(parseSavedStateJSON('{"level":3,"gold":120,"inv":["sword"]}')).toEqual({
      level: 3,
      gold: 120,
      inv: ["sword"],
    });
    expect(parseSavedStateJSON(null)).toBeNull();
    expect(parseSavedStateJSON("")).toBeNull();
    expect(parseSavedStateJSON("{truncated")).toBeNull();
    expect(parseSavedStateJSON("[1,2,3]")).toBeNull();
    expect(parseSavedStateJSON('"hello"')).toBeNull();
    expect(parseSavedStateJSON("42")).toBeNull();
    expect(parseSavedStateJSON("null")).toBeNull();

    const okBig = JSON.stringify({ pad: "x".repeat(MAX_STATE_CHARS - 20) });
    expect(okBig.length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(parseSavedStateJSON(okBig)).not.toBeNull();

    const tooBig = JSON.stringify({ pad: "x".repeat(MAX_STATE_CHARS + 10) });
    expect(tooBig.length).toBeGreaterThan(MAX_STATE_CHARS);
    expect(parseSavedStateJSON(tooBig)).toBeNull();
  });

  test("resolveWidgetStateJSON merges saved keys over fence defaults and recovers from corrupt storage", () => {
    const def = { title: "Eldoria", level: 1, gold: 50, items: ["torch"], tutorial: true };
    // Saved partial update preserves untouched defaults while overriding changed values (including falsy/empty).
    const merged = JSON.parse(
      resolveWidgetStateJSON(def, JSON.stringify({ level: 4, gold: 0, items: [], tutorial: false })),
    );
    expect(merged).toEqual({
      title: "Eldoria",
      level: 4,
      gold: 0,
      items: [],
      tutorial: false,
    });
    // Corrupt/truncated saved JSON falls back safely to defaults (never bricks publish with HTTP 400).
    expect(JSON.parse(resolveWidgetStateJSON(def, '{"level":4,'))).toEqual(def);
    expect(JSON.parse(resolveWidgetStateJSON(def, "[1,2]"))).toEqual(def);
    expect(JSON.parse(resolveWidgetStateJSON(undefined, '{"xp":99}'))).toEqual({ xp: 99 });
  });
});

describe("attachGuBridge rate isolation & state validation", () => {
  function createMockHost() {
    const listeners: Array<(ev: MessageEvent) => void> = [];
    const origWindow = (globalThis as any).window;
    const mockWin = {
      addEventListener: (type: string, fn: (ev: MessageEvent) => void) => {
        if (type === "message") listeners.push(fn);
      },
      removeEventListener: (type: string, fn: (ev: MessageEvent) => void) => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    };
    (globalThis as any).window = mockWin;
    const frameWin = {} as Window;
    const post = (data: unknown, source: unknown = frameWin) => {
      for (const fn of [...listeners]) fn({ data, source } as MessageEvent);
    };
    const restore = () => {
      (globalThis as any).window = origWindow;
    };
    return { frameWin, post, restore };
  }

  test("resize bursts never starve or drop saveState messages", () => {
    const host = createMockHost();
    const resizes: number[] = [];
    const states: string[] = [];
    const detach = attachGuBridge(() => host.frameWin, {
      onSendPrompt: () => {},
      onOpenLink: () => {},
      onResize: (h) => resizes.push(h),
      onState: (s) => states.push(s),
    });
    try {
      // Fire 120 resize events (well past the 60/min prompt limit).
      for (let i = 0; i < 120; i++) host.post({ __gu: "resize", height: 200 + i });
      expect(resizes.length).toBe(120);

      // Subsequent saveState MUST still succeed immediately.
      host.post({ __gu: "state", state: JSON.stringify({ level: 5, gold: 420 }) });
      expect(states).toEqual(['{"level":5,"gold":420}']);

      // Oversized, malformed, or non-object state payloads are rejected (never truncated into invalid JSON).
      host.post({ __gu: "state", state: '{"bad":' });
      host.post({ __gu: "state", state: "[1,2,3]" });
      host.post({ __gu: "state", state: JSON.stringify({ big: "a".repeat(MAX_STATE_CHARS + 50) }) });
      expect(states).toHaveLength(1);
    } finally {
      detach();
      host.restore();
    }
  });

  test("sendPrompt enforces 60/min rate cap and slash-command downgrade independently of resize/state", () => {
    const host = createMockHost();
    const sent: string[] = [];
    const prefilled: string[] = [];
    const states: string[] = [];
    const detach = attachGuBridge(() => host.frameWin, {
      onSendPrompt: (t) => sent.push(t),
      onPrefillPrompt: (t) => prefilled.push(t),
      onOpenLink: () => {},
      onResize: () => {},
      onState: (s) => states.push(s),
    });
    try {
      host.post({ __gu: "sendPrompt", text: "/full" });
      expect(sent).toEqual([]);
      expect(prefilled).toEqual(["/full"]);

      for (let i = 0; i < 70; i++) host.post({ __gu: "sendPrompt", text: `msg ${i}` });
      // 1 prefill + 59 sent = 60 action ops/min total
      expect(sent.length).toBe(59);

      // State saves still work even after prompt bucket is saturated.
      host.post({ __gu: "state", state: '{"saved":true}' });
      expect(states).toEqual(['{"saved":true}']);
    } finally {
      detach();
      host.restore();
    }
  });
});

describe("WIDGET_BASE_CSS mobile, spacing, and touch-control craft", () => {
  test("includes airy layout classes, mobile breakpoints, overflow guard, and touch controls", () => {
    expect(WIDGET_BASE_CSS).toContain("overflow-x: clip");
    expect(WIDGET_BASE_CSS).toContain(".gu-stack");
    expect(WIDGET_BASE_CSS).toContain(".gu-kpis");
    expect(WIDGET_BASE_CSS).toContain(".gu-grid");
    expect(WIDGET_BASE_CSS).toContain(".gu-grid-4");
    expect(WIDGET_BASE_CSS).toContain(".gu-tabs");
    expect(WIDGET_BASE_CSS).toContain(".gu-chips");
    expect(WIDGET_BASE_CSS).toContain("@media (max-width: 560px)");
    expect(WIDGET_BASE_CSS).toContain("@media (max-width: 420px)");
    expect(WIDGET_BASE_CSS).toContain("-webkit-touch-callout: none");
    expect(WIDGET_BASE_CSS).toContain(".gu-touch-controls");
    expect(WIDGET_BASE_CSS).toContain(".gu-touch-bar");
    expect(WIDGET_BASE_CSS).toContain(".gu-touch-btn");
    expect(WIDGET_BASE_CSS).toContain(".gu-touch-btn-primary");
    expect(WIDGET_BASE_CSS).toContain(".gu-touch-btn-round");
    expect(WIDGET_BASE_CSS).toContain(".gu-dpad");
    expect(WIDGET_BASE_CSS).toContain(".gu-game-stage");
  });

  test("fullscreen .gu-game-stage only forces 100vh when it is an :only-child so sibling touch bars stay visible", () => {
    const baseMatch = WIDGET_BASE_CSS.match(/html\[data-fullscreen="true"\]\s+\.gu-game-stage\s*\{([^}]*)\}/);
    expect(baseMatch).not.toBeNull();
    expect(baseMatch![1]).not.toContain("100vh");
    expect(baseMatch![1]).not.toContain("height: 100%");
    expect(baseMatch![1]).toContain("max-height: none !important");

    const onlyChildMatch = WIDGET_BASE_CSS.match(
      /html\[data-fullscreen="true"\]\s+\.gu-game-stage:only-child\s*\{([^}]*)\}/,
    );
    expect(onlyChildMatch).not.toBeNull();
    expect(onlyChildMatch![1]).toContain("height: 100% !important");
    expect(onlyChildMatch![1]).toContain("min-height: 100vh !important");
  });
});

describe("createWidgetPublishController race serialization", () => {
  test("invalidate + run during an in-flight publish discards stale result and republishes fresh state", async () => {
    let key = "v1";
    let currentUrl = "";
    const errors: string[] = [];
    const resolvers: Array<(res: WidgetPublishResult) => void> = [];
    const startedKeys: string[] = [];

    const ctrl = createWidgetPublishController({
      canPublish: () => true,
      getKey: () => key,
      hasUrl: () => !!currentUrl,
      clearUrl: () => {
        currentUrl = "";
      },
      publish: () => {
        startedKeys.push(key);
        return new Promise<WidgetPublishResult>((resolve) => resolvers.push(resolve));
      },
      onSuccess: (url) => {
        currentUrl = url;
      },
      onError: (msg) => errors.push(msg),
    });

    // Publish #1 starts with v1.
    const p1 = ctrl.run();
    expect(startedKeys).toEqual(["v1"]);

    // While publish #1 is still in flight, resetState/reload invalidates and switches to v2.
    key = "v2";
    ctrl.invalidate();
    expect(currentUrl).toBe("");
    void ctrl.run();
    // Still only 1 concurrent POST in flight.
    expect(startedKeys).toEqual(["v1"]);

    // Stale publish #1 finishes (even with an old URL or error) -> must NOT overwrite v2.
    resolvers[0]({ ok: true, url: "/w/stale-v1" });
    await p1;
    // Pending v2 publish immediately launches on settlement.
    expect(startedKeys).toEqual(["v1", "v2"]);
    expect(currentUrl).toBe("");
    expect(ctrl.publishedKey).toBe("");

    // Fresh publish #2 resolves -> lands v2 cleanly.
    resolvers[1]({ ok: true, url: "/w/fresh-v2" });
    await Promise.resolve();
    await Promise.resolve();
    expect(currentUrl).toBe("/w/fresh-v2");
    expect(ctrl.publishedKey).toBe("v2");
    expect(errors).toEqual([]);

    // Identical key without invalidation is deduped (zero extra POST).
    await ctrl.run();
    expect(startedKeys).toEqual(["v1", "v2"]);
  });

  test("stale error from invalidated in-flight publish never flashes or stalls the queued republish", async () => {
    let key = "v1";
    let currentUrl = "";
    const errors: string[] = [];
    const resolvers: Array<(res: WidgetPublishResult) => void> = [];

    const ctrl = createWidgetPublishController({
      canPublish: () => true,
      getKey: () => key,
      hasUrl: () => !!currentUrl,
      clearUrl: () => {
        currentUrl = "";
      },
      publish: () => new Promise<WidgetPublishResult>((resolve) => resolvers.push(resolve)),
      onSuccess: (url) => {
        currentUrl = url;
      },
      onError: (msg) => errors.push(msg),
    });

    const p1 = ctrl.run();
    key = "v2";
    ctrl.invalidate();
    void ctrl.run();

    resolvers[0]({ ok: false, error: "stale HTTP 500" });
    await p1;
    expect(errors).toEqual([]);
    expect(resolvers.length).toBe(2);

    resolvers[1]({ ok: true, url: "/w/recovered-v2" });
    await Promise.resolve();
    await Promise.resolve();
    expect(currentUrl).toBe("/w/recovered-v2");
    expect(errors).toEqual([]);
  });
});

describe("GenerativeUiWidget fullscreen layout", () => {
  const src = readFileSync(
    path.join(import.meta.dir, "..", "web/src/indirect-code/components/generative-ui/renderer.tsx"),
    "utf8",
  );

  test("fullscreen Portal body is a flex-col container and iframe uses flex-1 so source panel and error banner stay visible", () => {
    expect(src).toContain('class="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"');
    expect(src).toContain('"block min-h-0 w-full flex-1 border-0 bg-surface"');
    expect(src).not.toContain('? { height: "100%" }');
    expect(src).toContain('class="shrink-0 border-b border-border-subtle bg-surface-subtle p-3 text-fg"');
    expect(src).toContain('class="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-surface-subtle px-3 py-2"');
  });
});
