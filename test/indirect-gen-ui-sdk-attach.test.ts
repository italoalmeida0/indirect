import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  attachGuBridge,
  postGuAiContext,
  postGuAiEvent,
  postGuAttachments,
  type WidgetAiContext,
  type WidgetAiEvent,
  type WidgetAiRequestPayload,
  type WidgetAttachPayload,
} from "../web/src/indirect-code/components/generative-ui/bridge";
import { createWidgetAiController } from "../web/src/indirect-code/components/generative-ui/ai-client";
import { buildJsxModuleBody } from "../web/src/indirect-code/components/generative-ui/model-code";
import { compileJsxModule } from "../web/src/indirect-code/components/generative-ui/jsx-compile";
import { buildRuntimeScript } from "../web/src/indirect-code/components/generative-ui/widget-doc";
import {
  createAttachmentDraft,
  MAX_ATTACHMENTS,
} from "../web/src/indirect-code/hooks/useAttachmentDraft";
import { runWidgetLint } from "../server/routes/widget-lint";

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("model-code AST audit allows window.__gu.attach and window.__gu.ai cleanly", () => {
  test("widget code using attach, detach, onAttachmentsChange, and ai.* compiles with zero audit cuts", () => {
    const src = `
      import { useState, useEffect } from "react";
      export default function App() {
        const [ctx, setCtx] = useState(() => window.__gu.ai.getContext());
        const [atts, setAtts] = useState(() => window.__gu.getAttachments());
        const [reply, setReply] = useState("");
        useEffect(() => {
          const u1 = window.__gu.ai.onContextChange(setCtx);
          const u2 = window.__gu.onAttachmentsChange(setAtts);
          return () => { u1(); u2(); window.__gu.ai.abort(); };
        }, []);
        const run = async () => {
          const { ai, attach, detach } = window.__gu;
          attach({ key: "brief", name: "brief.json", content: { ok: true } });
          const models = await ai.listModels();
          const r = await ai.stream({
            prompt: "Move",
            model: models[0]?.id,
            effort: "low",
            onToken: (_d, full) => setReply(full),
          });
          const j = await ai.json({ prompt: "JSON" });
          window.indirectUi.attach({ key: "result", name: "res.md", content: r.text + JSON.stringify(j.data) });
          detach("brief");
        };
        return <div className="gu-root"><button onClick={run}>{ctx.modelName} ({atts.length}) {reply}</button></div>;
      }
    `;
    const compiled = compileJsxModule(src);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const audited = buildJsxModuleBody(compiled.code);
    expect(audited).toContain("window.__gu.ai.getContext");
    expect(audited).toContain("window.__gu.ai.onContextChange");
    expect(audited).toContain("window.__gu.onAttachmentsChange");
    expect(audited).toContain("ai.stream");
    expect(audited).toContain("ai.json");
    expect(audited).toContain("window.indirectUi.attach");
    expect(audited).not.toContain("void 0");
  });

  test("forbidden escapes (fetch, eval, constructor, parent.postMessage) remain neutralized alongside window.__gu.ai", () => {
    const src = `
      export default function App() {
        const leak = () => {
          fetch("https://evil.example");
          window.fetch("https://evil.example");
          window.parent.postMessage({ __gu: "gesture" }, "*");
          parent.postMessage({ __gu: "gesture" }, "*");
          return ({}).constructor;
        };
        return <div className="gu-root"><button onClick={leak}>go</button></div>;
      }
    `;
    const compiled = compileJsxModule(src);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const audited = buildJsxModuleBody(compiled.code);
    expect(audited).not.toContain('fetch("https://evil.example")');
    expect(audited).not.toContain(".constructor");
    expect(audited).not.toContain("parent.postMessage");
  });
});

describe("attachGuBridge attach, detach, and embedded AI protocol", () => {
  function createMockHost() {
    const listeners: Array<(ev: MessageEvent) => void> = [];
    const postedToFrame: unknown[] = [];
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
    const frameWin = {
      postMessage: (msg: unknown) => {
        postedToFrame.push(msg);
      },
    } as unknown as Window;
    const post = (data: unknown, source: unknown = frameWin) => {
      for (const fn of [...listeners]) fn({ data, source } as MessageEvent);
    };
    const restore = () => {
      (globalThis as any).window = origWindow;
    };
    return { frameWin, postedToFrame, post, restore };
  }

  test("validates text and PNG dataUrl attachments, sanitizes names/keys, and blocks unsafe dataUrls", () => {
    const host = createMockHost();
    const attached: WidgetAttachPayload[] = [];
    const detached: Array<string | undefined> = [];
    const detach = attachGuBridge(() => host.frameWin, {
      onSendPrompt: () => {},
      onOpenLink: () => {},
      onResize: () => {},
      onAttach: (p) => attached.push(p),
      onDetach: (k) => detached.push(k),
    });
    try {
      host.post({
        __gu: "attach",
        key: "form/1",
        name: "../../brief.json",
        mime: "application/json",
        content: '{"goal":"ship"}',
      });
      host.post({
        __gu: "attach",
        key: "sketch",
        name: "board.png",
        mime: "image/png",
        dataUrl: TINY_PNG_DATA_URL,
      });
      // Unsafe dataUrl (HTML / SVG script vector) must be dropped silently.
      host.post({
        __gu: "attach",
        key: "xss",
        name: "x.svg",
        mime: "image/svg+xml",
        dataUrl: "data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=",
      });
      // Active HTML/SVG text mimes coerce to inert text/plain; dot-only names fall back cleanly.
      host.post({
        __gu: "attach",
        key: "svg-note",
        name: "..",
        mime: "image/svg+xml",
        content: "<svg onload=alert(1)/>",
      });
      host.post({ __gu: "detach", key: "form/1" });
      host.post({ __gu: "detach" });

      expect(attached).toHaveLength(3);
      expect(attached[0]).toEqual({
        key: "form_1",
        name: ".._.._brief.json",
        mime: "application/json",
        content: '{"goal":"ship"}',
      });
      expect(attached[1]!.mime).toBe("image/png");
      expect(attached[1]!.dataUrl).toBe(TINY_PNG_DATA_URL);
      expect(attached[2]).toEqual({
        key: "svg-note",
        name: "svg-note.txt",
        mime: "text/plain",
        content: "<svg onload=alert(1)/>",
      });
      expect(detached).toEqual(["form_1", undefined]);
    } finally {
      detach();
      host.restore();
    }
  });

  test("gates aiRequest behind canUseAi and returns structured aiError instead of hanging", () => {
    const host = createMockHost();
    let allowed = false;
    const reqs: WidgetAiRequestPayload[] = [];
    const aborts: Array<string | undefined> = [];
    const detach = attachGuBridge(() => host.frameWin, {
      onSendPrompt: () => {},
      onOpenLink: () => {},
      onResize: () => {},
      canUseAi: () => allowed,
      onAiRequest: (r) => reqs.push(r),
      onAiAbort: (id) => aborts.push(id),
    });
    try {
      // Blocked before user interaction
      host.post({ __gu: "aiRequest", reqId: "r1", prompt: "Hi" });
      expect(reqs).toHaveLength(0);
      expect(host.postedToFrame).toEqual([
        {
          __gu: "aiError",
          reqId: "r1",
          error: "AI calls require a user click or interaction in the widget first.",
          code: "interaction_required",
        },
      ]);

      // Allowed after interaction
      allowed = true;
      host.post({
        __gu: "aiRequest",
        reqId: "r2",
        stream: true,
        json: false,
        model: "claude-sonnet",
        effort: "high",
        prompt: "Play e4",
        maxTokens: 512,
      });
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({
        reqId: "r2",
        stream: true,
        model: "claude-sonnet",
        effort: "high",
        prompt: "Play e4",
        maxTokens: 512,
      });

      // Empty request rejected cleanly
      host.post({ __gu: "aiRequest", reqId: "r3", prompt: "   " });
      expect((host.postedToFrame.at(-1) as any).code).toBe("invalid_request");

      // Abort forwarded
      host.post({ __gu: "aiAbort", reqId: "r2" });
      expect(aborts).toEqual(["r2"]);

      // Outbound helpers emit exact envelopes
      postGuAttachments(host.frameWin, [{ key: "form", name: "form.json", mime: "application/json", size: 20 }]);
      postGuAiContext(host.frameWin, {
        model: "m1",
        modelName: "M1",
        effort: "medium",
        efforts: [],
        models: [],
      });
      postGuAiEvent(host.frameWin, { op: "aiDelta", reqId: "r2", text: "e5" });
      expect(host.postedToFrame.slice(-3)).toEqual([
        { __gu: "attachments", items: [{ key: "form", name: "form.json", mime: "application/json", size: 20 }] },
        { __gu: "aiContext", context: { model: "m1", modelName: "M1", effort: "medium", efforts: [], models: [] } },
        { __gu: "aiDelta", reqId: "r2", text: "e5" },
      ]);
    } finally {
      detach();
      host.restore();
    }
  });
});

describe("createWidgetAiController", () => {
  const baseCtx: WidgetAiContext & { hostId?: string } = {
    hostId: "host_1",
    model: "session-default-model",
    modelName: "Session Default",
    effort: "medium",
    efforts: [],
    models: [],
  };

  test("inherits session model & effort when omitted and honors explicit overrides", async () => {
    const sentBodies: any[] = [];
    const ctrl = createWidgetAiController(async (_url, init) => {
      const parsed = JSON.parse(String(init?.body || "{}"));
      sentBodies.push(parsed);
      return new Response(
        JSON.stringify({
          success: true,
          text: "ok",
          reasoning: "",
          model: parsed.model,
          effort: parsed.effort,
          finishReason: "stop",
          usage: { inputTokens: 10, cacheTokens: 0, outputTokens: 5, reasoningTokens: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const events: WidgetAiEvent[] = [];
    ctrl.start({ reqId: "a1", stream: false, json: false, prompt: "Default call" }, baseCtx, (e) => events.push(e));
    ctrl.start(
      { reqId: "a2", stream: false, json: false, model: "custom-model", effort: "max", prompt: "Override call" },
      baseCtx,
      (e) => events.push(e),
    );
    await Bun.sleep(20);

    expect(sentBodies[0]).toMatchObject({
      hostId: "host_1",
      model: "session-default-model",
      effort: "medium",
    });
    expect(sentBodies[1]).toMatchObject({
      hostId: "host_1",
      model: "custom-model",
      effort: "max",
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.op).toBe("aiDone");
    expect(events[1]!.op).toBe("aiDone");
  });

  test("streams SSE deltas, enforces concurrency cap (max 4), and aborts cleanly", async () => {
    const abortedSignals: boolean[] = [];
    const ctrl = createWidgetAiController((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedSignals.push(true);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const events: WidgetAiEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      ctrl.start({ reqId: `c${i}`, stream: true, json: false, prompt: `req ${i}` }, baseCtx, (e) => events.push(e));
    }
    // 5th request exceeds cap of 4 immediately
    expect(ctrl.activeCount()).toBe(4);
    expect(events.some((e) => e.op === "aiError" && e.reqId === "c5" && e.code === "concurrency_limit")).toBe(true);

    ctrl.abort();
    await Bun.sleep(20);
    expect(ctrl.activeCount()).toBe(0);
    expect(abortedSignals).toHaveLength(4);
    expect(events.filter((e) => e.op === "aiError" && e.aborted)).toHaveLength(4);

    // Truncated SSE stream (EOF without done frame) must emit stream_truncated error, not fake aiDone.
    const truncEvents: WidgetAiEvent[] = [];
    const truncCtrl = createWidgetAiController(async () => {
      const enc = new TextEncoder();
      const s = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"type":"delta","text":"half"}\n\n'));
          c.close();
        },
      });
      return new Response(s, { headers: { "content-type": "text/event-stream" } });
    });
    truncCtrl.start({ reqId: "tr1", stream: true, json: false, prompt: "trunc" }, baseCtx, (e) => truncEvents.push(e));
    await Bun.sleep(25);
    expect(truncEvents.some((e) => e.op === "aiDelta" && e.text === "half")).toBe(true);
    expect(truncEvents.some((e) => e.op === "aiError" && e.code === "stream_truncated")).toBe(true);
    expect(truncEvents.some((e) => e.op === "aiDone")).toBe(false);
  });
});

describe("createAttachmentDraft keyed widget attachments", () => {
  test("updates keyed attachments in-place without duplicates, even at MAX_ATTACHMENTS, and isolates detach by owner", () => {
    const toasts: Array<{ msg: string; kind?: string }> = [];
    let dispose!: () => void;
    let draft!: ReturnType<typeof createAttachmentDraft>;
    createRoot((d) => {
      dispose = d;
      draft = createAttachmentDraft({
        send: () => {},
        isOpen: () => true,
        toast: (msg, kind) => toasts.push({ msg, kind }),
      });
    });
    try {
      // First keyed attach creates entry
      const r1 = draft.upsertWidgetAttachment({
        owner: "sess1:intake",
        slot: "form",
        name: "intake.json",
        mime: "application/json",
        content: '{"step":1}',
      });
      expect(r1).toEqual({ ok: true, updated: false });
      expect(draft.pendingAttachments()).toHaveLength(1);
      const firstKey = draft.pendingAttachments()[0]!.key;

      // Simulate an earlier upload so we verify update clears stale serverId
      draft.setPendingAttachments((prev) =>
        prev.map((a) => ({ ...a, serverId: "att_old", serverSessionId: "sess1" })),
      );

      // Static attachment from another widget + user-style slot
      draft.upsertWidgetAttachment({
        owner: "sess1:other",
        name: "snap.txt",
        mime: "text/plain",
        content: "static snap",
      });
      expect(draft.pendingAttachments()).toHaveLength(2);

      // Update keyed slot in-place: keeps index 0, mints fresh revision key (prevents mid-send race), clears serverId!
      const r2 = draft.upsertWidgetAttachment({
        owner: "sess1:intake",
        slot: "form",
        name: "intake-v2.json",
        mime: "application/json",
        content: '{"step":2,"notes":"updated"}',
      });
      expect(r2).toEqual({ ok: true, updated: true });
      expect(draft.pendingAttachments()).toHaveLength(2);
      expect(draft.pendingAttachments()[0]!.key).not.toBe(firstKey);
      expect(draft.pendingAttachments()[0]!.widgetSlot).toBe("form");
      expect(draft.pendingAttachments()[0]!.name).toBe("intake-v2.json");
      expect(draft.pendingAttachments()[0]!.text).toBe('{"step":2,"notes":"updated"}');
      expect(draft.pendingAttachments()[0]!.serverId).toBeUndefined();

      // Colon delimiter isolation: (owner="sess1:a", slot="b:c") must NOT collide with (owner="sess1:a:b", slot="c").
      const c1 = draft.upsertWidgetAttachment({
        owner: "sess1:a",
        slot: "b:c",
        name: "one.txt",
        mime: "text/plain",
        content: "one",
      });
      const c2 = draft.upsertWidgetAttachment({
        owner: "sess1:a:b",
        slot: "c",
        name: "two.txt",
        mime: "text/plain",
        content: "two",
      });
      expect(c1).toEqual({ ok: true, updated: false });
      expect(c2).toEqual({ ok: true, updated: false });
      draft.removeWidgetAttachment("sess1:a");
      draft.removeWidgetAttachment("sess1:a:b");

      // Forged image dataUrl (invalid PNG magic bytes) is rejected immediately.
      const forged = draft.upsertWidgetAttachment({
        owner: "sess1:intake",
        slot: "badimg",
        name: "fake.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,bm90LWEtcG5n",
      });
      expect(forged.ok).toBe(false);

      // Fill remaining slots up to MAX_ATTACHMENTS (10)
      for (let i = 0; i < MAX_ATTACHMENTS - 2; i++) {
        const res = draft.upsertWidgetAttachment({
          owner: "sess1:filler",
          slot: `s${i}`,
          name: `f${i}.txt`,
          mime: "text/plain",
          content: `data ${i}`,
        });
        expect(res.ok).toBe(true);
      }
      expect(draft.pendingAttachments()).toHaveLength(MAX_ATTACHMENTS);

      // New distinct attachment fails when at cap...
      const fullRes = draft.upsertWidgetAttachment({
        owner: "sess1:intake",
        slot: "extra",
        name: "overflow.txt",
        mime: "text/plain",
        content: "too many",
      });
      expect(fullRes.ok).toBe(false);

      // ...but updating an EXISTING keyed attachment still succeeds in-place!
      const updateAtCap = draft.upsertWidgetAttachment({
        owner: "sess1:intake",
        slot: "form",
        name: "intake-v3.json",
        mime: "application/json",
        content: '{"step":3}',
      });
      expect(updateAtCap).toEqual({ ok: true, updated: true });
      expect(draft.pendingAttachments()).toHaveLength(MAX_ATTACHMENTS);
      expect(draft.pendingAttachments()[0]!.text).toBe('{"step":3}');

      // Image dataUrl attachment decodes cleanly
      draft.removeWidgetAttachment("sess1:filler");
      expect(draft.pendingAttachments()).toHaveLength(2);
      const imgRes = draft.upsertWidgetAttachment({
        owner: "sess1:intake",
        slot: "canvas",
        name: "sketch.png",
        mime: "image/png",
        dataUrl: TINY_PNG_DATA_URL,
      });
      expect(imgRes).toEqual({ ok: true, updated: false });
      const imgAtt = draft.pendingAttachments().find((a) => a.widgetSlot === "canvas")!;
      expect(imgAtt.mime).toBe("image/png");
      expect(imgAtt.text).toBeUndefined();
      expect(imgAtt.size).toBeGreaterThan(20);

      // Detach only "form" leaves "canvas" and "sess1:other" intact
      expect(draft.removeWidgetAttachment("sess1:intake", "form")).toBe(true);
      expect(draft.pendingAttachments().map((a) => a.name)).toEqual(["snap.txt", "sketch.png"]);
    } finally {
      dispose();
    }
  });
});

describe("buildRuntimeScript lintMode SDK behavior", () => {
  test("lintMode exposes attach/detach/onAttachmentsChange and mock ai.getContext/complete/stream/json", async () => {
    const code = buildRuntimeScript({ stateJSON: '{"n":1}', lintMode: true });
    const mockDoc = {
      readyState: "complete",
      documentElement: { setAttribute() {}, removeAttribute() {} },
      body: { getBoundingClientRect: () => ({ height: 100 }) },
      querySelector: () => ({ getBoundingClientRect: () => ({ height: 100 }) }),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    };
    const mockWin: any = {
      document: mockDoc,
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame() {},
      devicePixelRatio: 1,
      focus() {},
      postMessage() {},
    };
    mockWin.parent = mockWin;
    mockWin.window = mockWin;

    const run = new Function("window", "document", "requestAnimationFrame", "cancelAnimationFrame", code);
    run(mockWin, mockDoc, () => 0, () => {});

    const gu = mockWin.__gu;
    const iu = mockWin.indirectUi;
    expect(typeof gu.attach).toBe("function");
    expect(typeof gu.detach).toBe("function");
    expect(typeof gu.ai.getContext).toBe("function");
    expect(iu.ai).toBe(gu.ai);

    // Keyed attach + in-place update + detach notify listeners in lint mode
    const observed: number[] = [];
    const unsub = gu.onAttachmentsChange((list: any[]) => observed.push(list.length));
    expect(gu.attach({ key: "k1", name: "a.json", content: { v: 1 } })).toBe(true);
    expect(gu.attach({ key: "k1", name: "a.json", content: { v: 2 } })).toBe(true);
    expect(gu.getAttachments()).toHaveLength(1);
    expect(gu.detach("k1")).toBe(true);
    expect(gu.getAttachments()).toHaveLength(0);
    expect(observed).toEqual([1, 1, 0]);
    unsub();

    // AI SDK resolves cleanly in lint mode without network
    const ctx = gu.ai.getContext();
    expect(ctx.ready).toBe(true);
    expect(ctx.models.length).toBeGreaterThan(0);
    expect(ctx.efforts.length).toBe(7);

    const streamed: string[] = [];
    const sr = await gu.ai.stream({ prompt: "Hi", onToken: (d: string) => streamed.push(d) });
    expect(sr.mocked).toBe(true);
    expect(streamed.length).toBe(1);

    const jr = await gu.ai.json({ prompt: "Move" });
    expect(jr.data).toEqual({ ok: true });

    // lintMode honors req.abort() cleanly
    const abortedReq = gu.ai.complete({ prompt: "Cancel me" });
    abortedReq.abort();
    let abortErr: any = null;
    try {
      await abortedReq;
    } catch (e) {
      abortErr = e;
    }
    expect(abortErr?.aborted).toBe(true);
  });

  test("real Obscura lint passes cleanly for a widget using window.__gu.ai and window.__gu.attach", async () => {
    const src = `
      import { useState, useEffect } from "react";
      export function buildPayload(name, effort) {
        return { name, effort, ready: true };
      }
      export default function App(props) {
        const [ctx, setCtx] = useState(() => window.__gu.ai.getContext());
        const [atts, setAtts] = useState(() => window.__gu.getAttachments());
        const [name, setName] = useState(props.name || "Player");
        useEffect(() => {
          const u1 = window.__gu.ai.onContextChange(setCtx);
          const u2 = window.__gu.onAttachmentsChange(setAtts);
          return () => { u1(); u2(); window.__gu.ai.abort(); };
        }, []);
        const sync = () => window.__gu.attach({ key: "form", name: "form.json", content: buildPayload(name, ctx.effort) });
        const ask = () => window.__gu.ai.complete({ prompt: "Hello " + name });
        return (
          <div className="gu-root gu-stack">
            <h2 className="gu-title">AI Intake Widget</h2>
            <p className="gu-caption">{ctx.modelName || "Default"} · {ctx.effort}</p>
            <input className="gu-input" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="gu-row">
              <button className="gu-btn-primary" onClick={sync}>Attach ({atts.length})</button>
              <button className="gu-btn" onClick={ask}>Ask AI</button>
            </div>
          </div>
        );
      }
    `;
    const testCode = `
      import { buildPayload } from "./widget";
      const p = buildPayload("Alice", "high");
      if (!p.ready || p.name !== "Alice") throw new Error("bad payload");
      const ok = window.__gu.attach({ key: "form", name: "form.json", content: p });
      if (!ok || window.__gu.getAttachments().length !== 1) throw new Error("attach failed in lint");
      const res = await window.__gu.ai.json({ prompt: "test" });
      if (!res.data || res.data.ok !== true) throw new Error("ai.json mock failed in lint");
    `;
    const result = await runWidgetLint({
      id: "sdk_lint_test",
      source: src,
      state: JSON.stringify({ name: "Ada" }),
      test: testCode,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  }, 30_000);
});
