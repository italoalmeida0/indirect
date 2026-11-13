import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import type { DaemonCommand } from "../web/src/indirect-code/daemon-protocol";
import type { ChatMessage, Project, SessionSummary } from "../web/src/indirect-code/types";
import { withoutTodoActivity } from "../web/src/indirect-code/live";
import { buildRenderBlocks, createRenderBlockBuilder } from "../web/src/indirect-code/transcript";
import {
  enforceSlidingTurnWindow,
  MAX_WINDOW_TURNS,
  type SlidingSealLike,
  type SlideWindowResult,
} from "../web/src/indirect-code/transcript/history";
import {
  base64ToBytes,
  createBlobUrlCache,
  DEFAULT_BLOB_URL_CACHE_MAX_BYTES,
  type BlobUrlCache,
} from "../web/src/indirect-code/utils/blobUrlCache";
import {
  areProjectListsEqual,
  areProjectsEqual,
  areSessionListsEqual,
  areSessionsEqual,
} from "../web/src/indirect-code/hooks/useMirror";
import { projectsByActivity } from "../web/src/indirect-code/paths";
import {
  fetchWidgetSource,
  invalidateWidgetSources,
  noteWidgetData,
} from "../web/src/indirect-code/components/generative-ui/widget-source";
import { parseContentBlocks } from "../web/src/indirect-code/utils/wire";

const ROOT = join(import.meta.dir, "..");

let createRoot: typeof import("solid-js")["createRoot"];
let createSignal: typeof import("solid-js")["createSignal"];
let createEffect: typeof import("solid-js")["createEffect"];
let createComposer: typeof import("../web/src/indirect-code/hooks/useComposer")["createComposer"];
let createMentions: typeof import("../web/src/indirect-code/hooks/useMentions")["createMentions"];
let createProjects: typeof import("../web/src/indirect-code/hooks/useProjects")["createProjects"];
let createBackground: typeof import("../web/src/indirect-code/hooks/useBackground")["createBackground"];
let createReview: typeof import("../web/src/indirect-code/hooks/useReview")["createReview"];
let createQueue: typeof import("../web/src/indirect-code/hooks/useQueue")["createQueue"];
let createTranscript: typeof import("../web/src/indirect-code/hooks/useTranscript")["createTranscript"];
let syncComposerHeight: typeof import("../web/src/indirect-code/components/composer/ComposerInput")["syncComposerHeight"];
let mountTarnavMarkdownHost: typeof import("../web/src/indirect-code/components/TarnavMarkdown")["mountTarnavMarkdownHost"];

beforeAll(async () => {
  installTestBrowserEnv();
  const solidClientPath = join(ROOT, "node_modules", "solid-js", "dist", "solid.js");
  const solidStorePath = join(ROOT, "node_modules", "solid-js", "store", "dist", "store.js");
  const solidWebPath = join(ROOT, "node_modules", "solid-js", "web", "dist", "web.js");
  const virtualEntryPath = join(ROOT, "web/src/indirect-code/__perf_client_entry__.tsx");
  const entryCode = `
    export { createRoot, createSignal, createEffect } from "solid-js";
    export { createComposer } from "./hooks/useComposer";
    export { createMentions } from "./hooks/useMentions";
    export { createProjects } from "./hooks/useProjects";
    export { createBackground } from "./hooks/useBackground";
    export { createReview } from "./hooks/useReview";
    export { createQueue } from "./hooks/useQueue";
    export { createTranscript } from "./hooks/useTranscript";
    export { syncComposerHeight } from "./components/composer/ComposerInput";
    export { mountTarnavMarkdownHost } from "./components/TarnavMarkdown";
  `;
  const buildRes = await Bun.build({
    entrypoints: [virtualEntryPath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "solid-client-perf-harness",
        setup(build) {
          build.onResolve({ filter: /__perf_client_entry__\.tsx$/ }, () => ({
            path: virtualEntryPath,
          }));
          build.onLoad({ filter: /__perf_client_entry__\.tsx$/ }, async () => {
            const out = await transformAsync(entryCode, {
              filename: virtualEntryPath,
              presets: [
                [solidPreset, { generate: "dom", hydratable: false }],
                [tsPreset, { isTSX: true, allExtensions: true }],
              ],
              babelrc: false,
              configFile: false,
            });
            return { contents: out?.code ?? entryCode, loader: "js" };
          });
          build.onResolve({ filter: /^solid-js$/ }, () => ({ path: solidClientPath }));
          build.onResolve({ filter: /^solid-js\/store$/ }, () => ({ path: solidStorePath }));
          build.onResolve({ filter: /^solid-js\/web$/ }, () => ({ path: solidWebPath }));
          build.onResolve({ filter: /^(highlight\.js|katex)/ }, (args) => ({
            path: args.path,
            namespace: "stub-heavy",
          }));
          build.onLoad({ filter: /.*/, namespace: "stub-heavy" }, () => ({
            contents: "export default { registerLanguage() {}, highlightElement() {}, highlight() { return { value: '' }; }, getLanguage() { return null; }, renderToString(s) { return s; } };",
            loader: "js",
          }));
          build.onResolve({ filter: /^virtual:icons$/ }, () => ({
            path: "virtual:icons",
            namespace: "virtual-icons",
          }));
          build.onLoad({ filter: /.*/, namespace: "virtual-icons" }, () => ({
            contents: "export const registry = {}; export const icons = {}; export default registry;",
            loader: "js",
          }));
          build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
          build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
            if (args.path.endsWith("__perf_client_entry__.tsx")) return undefined;
            const code = await readFile(args.path, "utf8");
            const out = await transformAsync(code, {
              filename: args.path,
              presets: [
                [solidPreset, { generate: "dom", hydratable: false }],
                [tsPreset, { isTSX: true, allExtensions: true }],
              ],
              sourceMaps: false,
              babelrc: false,
              configFile: false,
            });
            return { contents: out?.code ?? code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!buildRes.success || buildRes.outputs.length === 0) {
    throw new Error(`Failed to bundle client Solid perf harness: ${JSON.stringify(buildRes.logs)}`);
  }
  const jsText = await buildRes.outputs[0]!.text();
  const mod = await import(`data:text/javascript;base64,${Buffer.from(jsText, "utf8").toString("base64")}`);
  createRoot = mod.createRoot;
  createSignal = mod.createSignal;
  createEffect = mod.createEffect;
  createComposer = mod.createComposer;
  createMentions = mod.createMentions;
  createProjects = mod.createProjects;
  createBackground = mod.createBackground;
  createReview = mod.createReview;
  createQueue = mod.createQueue;
  createTranscript = mod.createTranscript;
  syncComposerHeight = mod.syncComposerHeight;
  mountTarnavMarkdownHost = mod.mountTarnavMarkdownHost;
});

const SAVED_GLOBAL_KEYS = [
  "Node",
  "HTMLElement",
  "Element",
  "location",
  "localStorage",
  "document",
  "window",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const savedGlobals = new Map<string, { present: boolean; value: unknown }>();
for (const key of SAVED_GLOBAL_KEYS) {
  const g = globalThis as Record<string, unknown>;
  savedGlobals.set(key, { present: key in g, value: g[key] });
}

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, entry] of savedGlobals.entries()) {
    if (entry.present) {
      g[key] = entry.value;
    } else {
      delete g[key];
    }
  }
});

class FakeNode {
  nodeType = 3;
  parentNode: FakeElement | null = null;
  private _text = "";
  constructor(text = "") {
    this._text = text;
  }
  get data(): string {
    return this._text;
  }
  set data(v: string) {
    this._text = String(v ?? "");
  }
  appendData(text: string) {
    this._text += String(text ?? "");
  }
  get textContent(): string {
    return this._text;
  }
  set textContent(v: string) {
    this._text = String(v ?? "");
  }
}

class FakeElement extends FakeNode {
  override nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  childNodes: (FakeElement | FakeNode)[] = [];
  className = "";

  constructor(tagName: string) {
    super("");
    this.tagName = tagName.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  get firstChild(): FakeElement | FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeElement | FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  override get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  override set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = v ? [new FakeNode(String(v))] : [];
    for (const c of this.childNodes) c.parentNode = this;
  }

  set innerHTML(v: string) {
    this.textContent = v.replace(/<[^>]*>/g, "");
  }

  get innerHTML(): string {
    return this.textContent;
  }

  appendChild<T extends FakeElement | FakeNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes: (FakeElement | FakeNode | string)[]) {
    for (const n of nodes) {
      this.appendChild(typeof n === "string" ? new FakeNode(n) : n);
    }
  }

  prepend(...nodes: (FakeElement | FakeNode | string)[]) {
    const converted = nodes.map((n) => (typeof n === "string" ? new FakeNode(n) : n));
    for (const c of converted) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
    }
    this.childNodes.unshift(...converted);
  }

  removeChild<T extends FakeElement | FakeNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceChildren(...nodes: (FakeElement | FakeNode | string)[]) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  replaceWith(...nodes: (FakeElement | FakeNode | string)[]) {
    const parent = this.parentNode;
    if (!parent) return;
    const idx = parent.childNodes.indexOf(this);
    if (idx < 0) return;
    const converted = nodes.map((n) => (typeof n === "string" ? new FakeNode(n) : n));
    for (const c of converted) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = parent;
    }
    parent.childNodes.splice(idx, 1, ...converted);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string) {
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      this.dataset[camel] = value;
    }
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className || this.attributes.get("class") || null;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener() {}
  removeEventListener() {}

  contains(target: FakeElement | FakeNode | null): boolean {
    let cur: FakeElement | FakeNode | null = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => this.matchesSingle(part.trim()));
  }

  private matchesSingle(sel: string): boolean {
    if (!sel) return false;
    if (sel === "*") return true;
    const attrMatch = /^([a-z0-9-]*)?(?:\[([a-z0-9-]+)(?:="([^"]*)")?\])+$/i.exec(sel);
    if (attrMatch) {
      const tag = attrMatch[1];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const attrRe = /\[([a-z0-9-]+)(?:="([^"]*)")?\]/gi;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(sel)) !== null) {
        const attrVal = this.getAttribute(m[1]);
        if (attrVal === null) return false;
        if (m[2] !== undefined && attrVal !== m[2]) return false;
      }
      return true;
    }
    if (sel.includes(" ")) {
      const parts = sel.split(/\s+/);
      const last = parts[parts.length - 1];
      if (!this.matchesSingle(last)) return false;
      let cur = this.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !cur.matchesSingle(parts[i])) cur = cur.parentNode;
        if (!cur) return false;
        cur = cur.parentNode;
      }
      return true;
    }
    return this.tagName === sel.toUpperCase();
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    let cur: FakeElement | null = this.parentNode;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function installTestBrowserEnv() {
  const storage = new Map<string, string>();
  let setItemCalls = 0;
  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<() => void>>();
  const rafQueue: FrameRequestCallback[] = [];

  const root = globalThis as Record<string, any>;
  Object.assign(FakeNode, { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  root.Node = FakeNode;
  root.HTMLElement = FakeElement;
  root.Element = FakeElement;
  root.location = { href: "http://localhost:3000/" };
  root.localStorage = {
    get length() {
      return storage.size;
    },
    key: (i: number) => Array.from(storage.keys())[i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      setItemCalls++;
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
    clear: () => {
      storage.clear();
    },
  };
  root.document = {
    hidden: false,
    visibilityState: "visible",
    documentElement: { dataset: {}, style: {} },
    body: new FakeElement("body"),
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeNode(text),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: (ev: string, fn: () => void) => {
      if (!docListeners.has(ev)) docListeners.set(ev, new Set());
      docListeners.get(ev)!.add(fn);
    },
    removeEventListener: (ev: string, fn: () => void) => {
      docListeners.get(ev)?.delete(fn);
    },
  };
  root.window = {
    document: root.document,
    location: root.location,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: (ev: string, fn: () => void) => {
      if (!winListeners.has(ev)) winListeners.set(ev, new Set());
      winListeners.get(ev)!.add(fn);
    },
    removeEventListener: (ev: string, fn: () => void) => {
      winListeners.get(ev)?.delete(fn);
    },
  };
  root.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  root.cancelAnimationFrame = () => {};

  return {
    storage,
    getSetItemCalls: () => setItemCalls,
    resetSetItemCalls: () => {
      setItemCalls = 0;
    },
    rafQueue,
    emitVisibility: (state: "hidden" | "visible") => {
      root.document.visibilityState = state;
      root.document.hidden = state === "hidden";
      for (const fn of docListeners.get("visibilitychange") ?? []) fn();
    },
    emitPageHide: () => {
      for (const fn of winListeners.get("pagehide") ?? []) fn();
    },
  };
}

describe("Layer 3 — Frontend Zero-Jank, Bi-Directional History Window & Heap Leak Elimination", () => {
  test("1. blockRawIdx is O(1) without subscribing to messages() when srcIdx != null, and lastVisibleBlockId stays stable on prepend", async () => {
    installTestBrowserEnv();
    const sent: DaemonCommand[] = [];

    await createRoot(async (dispose) => {
      const t = createTranscript({
        send: (cmd) => sent.push(cmd),
        isOpen: () => true,
        getSessionId: () => "s1",
        getHostId: () => "h1",
        toast: () => {},
        showChoice: async () => null,
        onTurnIdle: () => {},
        onUsageContext: () => {},
      });

      await t.applySessionContent(
        "s1",
        [
          { id: "u1", role: "user", turnIndex: 10, content: "First prompt" },
          { id: "a1", role: "assistant", turnIndex: 10, content: "First answer" },
        ],
        null,
        { oldestTurn: 10, newestTurn: 10, hasOlder: true, totalTurns: 10, firstIndex: 20 },
      );

      const firstBlock = t.visibleBlocks()[0]!;
      expect(firstBlock.msg.srcIdx).toBe(20);

      let rawIdxRuns = 0;
      createEffect(() => {
        t.blockRawIdx(firstBlock);
        rawIdxRuns++;
      });
      expect(rawIdxRuns).toBe(1);

      // Stream 15 deltas into a new running turn: blockRawIdx(firstBlock) must NOT re-run!
      t.handleAgentEvent("s1", { type: "turn_start" } as any);
      t.handleAgentEvent("s1", { type: "assistant_start", index: 22, turnIndex: 11, messageId: "a2" } as any);
      for (let i = 0; i < 15; i++) {
        t.handleAgentEvent("s1", { type: "text_delta", delta: `chunk-${i} `, messageId: "a2" } as any);
      }
      expect(rawIdxRuns).toBe(1);

      const tailIdBeforePrepend = t.lastVisibleBlockId();
      expect(tailIdBeforePrepend).toBe("a2");

      // Prepend an older history page: lastVisibleBlockId stays identical so existing blocks do not flip isLast.
      t.requestOlderHistory();
      const histCmd = sent.find((c) => c.type === "get_history") as any;
      expect(histCmd?.beforeTurn).toBe(10);
      await t.noteHistoryPage(
        [
          { id: "u0", role: "user", turnIndex: 9, content: "Older prompt" },
          { id: "a0", role: "assistant", turnIndex: 9, content: "Older answer" },
        ],
        { oldestTurn: 9, newestTurn: 9, hasOlder: false, totalTurns: 10, firstIndex: 18 },
        histCmd.requestId,
        undefined,
        "older",
      );
      expect(t.lastVisibleBlockId()).toBe(tailIdBeforePrepend);
      dispose();
    });
  });

  test("2. withoutTodoActivity WeakMap memoization restores 100% RenderCache hit rate on agentic turns", () => {
    const historical: ChatMessage[] = [];
    for (let turn = 1; turn <= 40; turn++) {
      historical.push({
        id: `u_${turn}`,
        role: "user",
        turnIndex: turn,
        srcIdx: turn * 3,
        blocks: [{ type: "text", text: `Task ${turn}` }],
      });
      historical.push({
        id: `a_${turn}`,
        role: "assistant",
        turnIndex: turn,
        srcIdx: turn * 3 + 1,
        blocks: [
          { type: "tool_call", toolId: `todo_${turn}`, toolName: "todo", toolArgs: '{"items":[]}' },
          { type: "tool_result", toolId: `todo_${turn}`, toolName: "todo", toolResult: "ok" },
          { type: "tool_call", toolId: `bash_${turn}`, toolName: "bash", toolArgs: '{"command":"ls"}' },
          { type: "tool_result", toolId: `bash_${turn}`, toolName: "bash", toolResult: "file.ts" },
          { type: "tool_call", toolId: `sum_${turn}`, toolName: "summary", toolArgs: JSON.stringify({ for_user: `Progress ${turn}` }) },
          { type: "tool_result", toolId: `sum_${turn}`, toolName: "summary", toolResult: "ok" },
          {
            type: "tool_call",
            toolId: `fin_${turn}`,
            toolName: "finish_entire_request",
            toolArgs: JSON.stringify({ final_message_to_user: `Completed turn ${turn}` }),
          },
          { type: "tool_result", toolId: `fin_${turn}`, toolName: "finish_entire_request", toolResult: "ok" },
        ],
      });
    }

    const firstPass = withoutTodoActivity(historical);
    const secondPass = withoutTodoActivity(historical);
    expect(firstPass.length).toBe(secondPass.length);
    for (let i = 0; i < firstPass.length; i++) {
      expect(secondPass[i]).toBe(firstPass[i]);
    }

    const build = createRenderBlockBuilder();
    const initialBlocks = build(historical);
    expect(initialBlocks.length).toBeGreaterThanOrEqual(80);

    // Append active streaming turn 41 and mutate it across multiple deltas:
    // every single RenderBlock of turns 1..40 MUST preserve exact === reference identity!
    const liveBlocks1 = build([
      ...historical,
      { id: "u_41", role: "user", turnIndex: 41, blocks: [{ type: "text", text: "Run 41" }] },
      { id: "a_41", role: "assistant", turnIndex: 41, streaming: true, blocks: [{ type: "text", text: "Hel" }] },
    ]);
    const liveBlocks2 = build([
      ...historical,
      { id: "u_41", role: "user", turnIndex: 41, blocks: [{ type: "text", text: "Run 41" }] },
      { id: "a_41", role: "assistant", turnIndex: 41, streaming: true, blocks: [{ type: "text", text: "Hello world" }] },
    ]);

    for (let i = 0; i < initialBlocks.length; i++) {
      expect(liveBlocks1[i]).toBe(initialBlocks[i]);
      expect(liveBlocks2[i]).toBe(initialBlocks[i]);
    }

    // Ensure buildRenderBlocks sets stable ids directly without needing .map() cloning
    expect(buildRenderBlocks(historical).every((b) => typeof b.id === "string" && b.id.length > 0)).toBe(true);
  });

  test("3. TarnavMarkdown parses static historical content synchronously on Frame 0 (>8 KiB without rAF deferral)", () => {
    const env = installTestBrowserEnv();
    const longHistoricalDoc =
      "# Frame Zero Heading\n\n" +
      Array.from({ length: 260 }, (_, i) => `- Historical bullet item number ${i} with details`).join("\n") +
      "\n\nFinal tail sentinel paragraph.";
    expect(longHistoricalDoc.length).toBeGreaterThan(10_000);

    const { dispose, streamingHost } = createRoot((dispose) => {
      const staticHost = new FakeElement("div") as unknown as HTMLDivElement;
      mountTarnavMarkdownHost(staticHost, () => ({
        children: longHistoricalDoc,
        streaming: false,
      }));

      // Frame 0 (zero rAF callbacks executed!): full historical markdown is already parsed in DOM
      expect(env.rafQueue.length).toBe(0);
      expect((staticHost as unknown as FakeElement).children.length).toBeGreaterThan(2);
      expect(staticHost.textContent).toContain("Frame Zero Heading");
      expect(staticHost.textContent).toContain("Final tail sentinel paragraph.");

      // Streaming content still defers to requestAnimationFrame as intended
      const streamingHost = new FakeElement("div") as unknown as HTMLDivElement;
      mountTarnavMarkdownHost(streamingHost, () => ({
        children: "# Live streaming heading",
        streaming: true,
      }));
      expect((streamingHost as unknown as FakeElement).children.length).toBe(0);
      return { dispose, streamingHost };
    });

    try {
      expect((streamingHost as unknown as FakeElement).children.length).toBe(0);
      expect(env.rafQueue.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  test("4. Sliding 180-turn window eviction + bi-directional beforeTurn / afterTurn / aroundMsgIdx protocol", async () => {
    installTestBrowserEnv();

    // Pure sliding window unit verification at MAX_WINDOW_TURNS = 180
    expect(MAX_WINDOW_TURNS).toBe(180);
    const makeTurnMsgs = (fromTurn: number, toTurn: number): ChatMessage[] => {
      const list: ChatMessage[] = [];
      for (let t = fromTurn; t <= toTurn; t++) {
        list.push(
          { id: `u_${t}`, role: "user", turnIndex: t, srcIdx: t * 2, blocks: [{ type: "text", text: `U${t}` }] },
          { id: `a_${t}`, role: "assistant", turnIndex: t, srcIdx: t * 2 + 1, blocks: [{ type: "text", text: `A${t}` }] },
        );
      }
      return list;
    };

    const sealsOlder: SlidingSealLike[] = [
      { oldestTurn: 1, newestTurn: 30, firstIndex: 2, msgCount: 60, hasOlderBelow: false },
      { oldestTurn: 31, newestTurn: 200, firstIndex: 62, msgCount: 340, hasOlderBelow: true },
    ];
    const slidOlder: SlideWindowResult = enforceSlidingTurnWindow(
      makeTurnMsgs(1, 200),
      sealsOlder,
      { oldestTurn: 1, newestTurn: 200, hasOlder: false, totalTurns: 200 },
      "older",
      MAX_WINDOW_TURNS,
    );
    expect(slidOlder.prunedTurns).toBe(20);
    expect(slidOlder.cursor.oldestTurn).toBe(1);
    expect(slidOlder.cursor.newestTurn).toBe(180);
    expect(slidOlder.cursor.hasNewer).toBe(true);
    expect(slidOlder.messages[slidOlder.messages.length - 1]?.turnIndex).toBe(180);

    const slidNewer = enforceSlidingTurnWindow(
      makeTurnMsgs(1, 200),
      [
        { oldestTurn: 1, newestTurn: 180, firstIndex: 2, msgCount: 360, hasOlderBelow: false },
        { oldestTurn: 181, newestTurn: 200, firstIndex: 362, msgCount: 40, hasOlderBelow: true },
      ],
      { oldestTurn: 1, newestTurn: 200, hasOlder: false, hasNewer: false, totalTurns: 200 },
      "newer",
      MAX_WINDOW_TURNS,
    );
    expect(slidNewer.prunedTurns).toBe(20);
    expect(slidNewer.cursor.oldestTurn).toBe(21);
    expect(slidNewer.cursor.newestTurn).toBe(200);
    expect(slidNewer.cursor.hasOlder).toBe(true);
    expect(slidNewer.messages[0]?.turnIndex).toBe(21);

    // End-to-end hook protocol test: older -> hasNewer, scroll near bottom -> afterTurn, unloaded jump -> aroundMsgIdx, reloadLatest
    const sent: DaemonCommand[] = [];
    await createRoot(async (dispose) => {
      const t = createTranscript({
        send: (cmd) => sent.push(cmd),
        isOpen: () => true,
        getSessionId: () => "sess-window",
        getHostId: () => "host-1",
        toast: () => {},
        showChoice: async () => null,
        onTurnIdle: () => {},
        onUsageContext: () => {},
      });

      const rawRange = (fromTurn: number, toTurn: number) => {
        const out: any[] = [];
        for (let turn = fromTurn; turn <= toTurn; turn++) {
          out.push(
            { id: `u_${turn}`, role: "user", turnIndex: turn, content: `User ${turn}` },
            { id: `a_${turn}`, role: "assistant", turnIndex: turn, content: `Assistant ${turn}` },
          );
        }
        return out;
      };

      // Cross-session jump with aroundMsgIdx
      t.fetchSession("sess-window", { aroundMsgIdx: 88 });
      const fetchReq = sent[sent.length - 1] as any;
      expect(fetchReq).toMatchObject({
        type: "get_session",
        sessionId: "sess-window",
        aroundMsgIdx: 88,
      });

      // Seed tail turns 31..200 (170 turns)
      await t.applySessionContent(
        "sess-window",
        rawRange(31, 200),
        null,
        {
          oldestTurn: 31,
          newestTurn: 200,
          hasOlder: true,
          hasNewer: false,
          totalTurns: 200,
          firstIndex: 60,
        },
        { transcript: { stream: "s-stream", seq: 1 } },
      );
      expect(t.historyHasOlder()).toBe(true);
      expect(t.historyHasNewer()).toBe(false);

      // Prepend turns 6..30 (25 turns) -> 195 turns total -> prunes bottom 15 turns (186..200) -> hasNewer = true!
      sent.length = 0;
      t.requestOlderHistory();
      const olderReq = sent[0] as any;
      expect(olderReq).toMatchObject({ type: "get_history", sessionId: "sess-window", beforeTurn: 31 });

      await t.noteHistoryPage(
        rawRange(6, 30),
        { oldestTurn: 6, newestTurn: 30, hasOlder: true, totalTurns: 200, firstIndex: 10 },
        olderReq.requestId,
        undefined,
        "older",
      );
      expect(t.historyHasNewer()).toBe(true);
      expect(t.historyNewestTurn()).toBe(185);
      expect(t.historyOldestTurn()).toBe(6);

      // Simulate scrolling near bottom (< 400px remaining) -> triggers get_history { afterTurn: 185 }
      sent.length = 0;
      const fakeContainer = {
        isConnected: true,
        scrollTop: 4700,
        clientHeight: 600,
        scrollHeight: 5500, // 5500 - 4700 - 600 = 200 < 400
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
      } as unknown as HTMLDivElement;
      t.setChatContainerRef(fakeContainer);
      t.onChatScroll();

      const newerReq = sent.find((c) => c.type === "get_history") as any;
      expect(newerReq).toMatchObject({ type: "get_history", sessionId: "sess-window", afterTurn: 185 });

      await t.noteHistoryPage(
        rawRange(186, 200),
        { oldestTurn: 186, newestTurn: 200, hasOlder: true, hasNewer: false, totalTurns: 200, firstIndex: 370 },
        newerReq.requestId,
        undefined,
        "newer",
      );
      expect(t.historyHasNewer()).toBe(false);
      expect(t.historyHasOlder()).toBe(true);
      expect(t.historyOldestTurn()).toBe(21);
      expect(t.historyNewestTurn()).toBe(200);

      // Same-session search jump to unloaded mid-history msgIdx = 4 (< firstLoadedSrcIdx)
      sent.length = 0;
      t.jumpToMessage(4);
      const aroundReq = sent[0] as any;
      expect(aroundReq).toMatchObject({ type: "get_history", sessionId: "sess-window", aroundMsgIdx: 4 });

      await t.noteHistoryPage(
        rawRange(1, 10),
        { oldestTurn: 1, newestTurn: 10, hasOlder: false, hasNewer: true, totalTurns: 200, firstIndex: 0, targetMsgIdx: 4 },
        aroundReq.requestId,
        undefined,
        "around",
      );
      expect(t.historyHasNewer()).toBe(true);
      expect(t.highlightedMsgIdx()).toBe(4);

      // reloadLatest() clears detached window and fetches latest get_session
      sent.length = 0;
      t.reloadLatest();
      expect(t.historyHasNewer()).toBe(false);
      expect(sent[0]).toMatchObject({ type: "get_session", sessionId: "sess-window" });

      dispose();
    });
  });

  test("5. blobUrlCache enforces byte cap, revokes ObjectURLs on LRU eviction/clear, and lazily resolves get_blob -> blob_data", () => {
    expect(DEFAULT_BLOB_URL_CACHE_MAX_BYTES).toBe(16 * 1024 * 1024);
    const created: string[] = [];
    const revoked: string[] = [];
    let seq = 0;

    const cache: BlobUrlCache = createBlobUrlCache({
      maxBytes: 10,
      createObjectURL: () => {
        const u = `blob:test/${++seq}`;
        created.push(u);
        return u;
      },
      revokeObjectURL: (u) => {
        revoked.push(u);
      },
    });

    const b64FourBytes = btoa("abcd");
    expect(base64ToBytes(b64FourBytes).byteLength).toBe(4);

    const u1 = cache.putBase64("k1", b64FourBytes, "image/png", "sess-a");
    const u2 = cache.putBase64("k2", b64FourBytes, "image/png", "sess-b");
    expect(cache.totalBytes()).toBe(8);
    expect(revoked).toEqual([]);

    // Touch k1 so k2 becomes the LRU victim when k3 (4 bytes -> 12 > 10) is inserted
    expect(cache.get("k1")).toBe(u1);
    const u3 = cache.putBase64("k3", b64FourBytes, "image/png", "sess-b");
    expect(u3).toBe("blob:test/3");
    expect(revoked).toEqual([u2]);
    expect(cache.peek("k2")).toBeUndefined();
    expect(cache.peek("k1")).toBe(u1);

    // Session eviction revokes sess-a's inline blob while keeping sess-b's blob
    expect(cache.evictSession("sess-a")).toBe(1);
    expect(revoked).toEqual([u2, u1]);

    // Lazy CAS sha256 resolution via get_blob -> blob_data
    const parsed = parseContentBlocks({
      role: "user",
      content: [{ type: "image", blobSha256: "deadbeef1234", mediaType: "image/webp" }],
    });
    expect(parsed[0]?.imageSha256).toBe("deadbeef1234");
    expect(parsed[0]?.imageData).toBeUndefined();

    const sent: DaemonCommand[] = [];
    expect(cache.resolveImageBlock(parsed[0]!, (cmd) => sent.push(cmd), "sess-b")).toBeUndefined();
    // Duplicate render while in flight must NOT send a second get_blob
    expect(cache.resolveImageBlock(parsed[0]!, (cmd) => sent.push(cmd), "sess-b")).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "get_blob", sha256: "deadbeef1234" });

    const resolvedUrl = cache.noteBlobData({
      sha256: "deadbeef1234",
      mediaType: "image/webp",
      data: b64FourBytes,
    });
    expect(resolvedUrl).toBe("blob:test/4");
    expect(cache.resolveImageBlock(parsed[0]!, (cmd) => sent.push(cmd), "sess-b")).toBe("blob:test/4");

    cache.clear();
    expect(cache.totalBytes()).toBe(0);
    expect(revoked).toContain("blob:test/3");
    expect(revoked).toContain("blob:test/4");
  });

  test("6. Structural useMirror comparators and O(S + P) projectsByActivity match semantics without JSON.stringify", () => {
    const baseSession: SessionSummary = {
      id: "s1",
      hostId: "h1",
      cwd: "/workspace/app/packages/web",
      title: "Fix jank",
      model: "claude-sonnet",
      status: "idle",
      pinned: false,
      createdAt: 100,
      updatedAt: 200,
      options: {
        mode: "agentic",
        effort: "high",
        access: "full",
        skills: [
          { name: "build", usable: "always" },
          { name: "lint", usable: "always" },
        ],
      },
      skills: {
        build: { priority: 1, active: true, usable: "always" },
        lint: { priority: 2, active: false, usable: "always" },
      },
    };
    const clonedSession: SessionSummary = {
      ...baseSession,
      options: {
        mode: "agentic",
        effort: "high",
        access: "full",
        skills: [
          { name: "build", usable: "always" },
          { name: "lint", usable: "always" },
        ],
      },
      skills: {
        build: { priority: 1, active: true, usable: "always" },
        lint: { priority: 2, active: false, usable: "always" },
      },
    };

    expect(areSessionsEqual(baseSession, clonedSession)).toBe(true);
    expect(areSessionListsEqual([baseSession], [clonedSession])).toBe(true);

    const changedSkillSession: SessionSummary = {
      ...clonedSession,
      skills: {
        build: { priority: 1, active: false, usable: "always" },
        lint: { priority: 2, active: false, usable: "always" },
      },
    };
    expect(areSessionsEqual(baseSession, changedSkillSession)).toBe(false);
    expect(areSessionListsEqual([baseSession], [changedSkillSession])).toBe(false);

    const pRoot: Project = { id: "p-root", hostId: "h1", name: "app", path: "/workspace/app", createdAt: 10 };
    const pWeb: Project = { id: "p-web", hostId: "h1", name: "web", path: "/workspace/app/packages/web", createdAt: 20 };
    const pOther: Project = { id: "p-other", hostId: "h1", name: "other", path: "/workspace/other", createdAt: 50 };

    expect(areProjectsEqual(pRoot, { ...pRoot })).toBe(true);
    expect(areProjectListsEqual([pRoot, pWeb], [{ ...pRoot }, { ...pWeb }])).toBe(true);
    expect(areProjectListsEqual([pRoot, pWeb], [{ ...pRoot, collapsed: true }, { ...pWeb }])).toBe(false);

    // Longest-prefix match assigns s1 to p-web (not p-root) and sorts p-web first by activity
    const sorted = projectsByActivity([pRoot, pOther, pWeb], [baseSession]);
    expect(sorted.map((p) => p.id)).toEqual(["p-web", "p-other", "p-root"]);
  });

  test("7. Cross-session heap leaks are evicted (departing widget sources, background live output, review 8 MiB Blob LRU, contexts & queues)", async () => {
    installTestBrowserEnv();

    // 7a. Departing session widget source invalidation
    const pageSrc = readFileSync(join(import.meta.dir, "../web/src/indirect-code/IndirectCodePage.tsx"), "utf-8");
    expect(pageSrc).toContain("const prevSessionId = untrack(activeSessionId);");
    expect(pageSrc).toContain("invalidateWidgetSources(prevSessionId);");

    const widgetReqs: any[] = [];
    const pPrev = fetchWidgetSource((cmd) => widgetReqs.push(cmd), "h1", "s-prev", "w1");
    noteWidgetData({
      requestId: widgetReqs[0].requestId,
      sessionId: "s-prev",
      widgetId: "w1",
      widget: { id: "w1", source: "export default () => null;" },
    });
    expect((await pPrev)?.source).toContain("export default");

    const pNext = fetchWidgetSource((cmd) => widgetReqs.push(cmd), "h1", "s-next", "w1");
    noteWidgetData({
      requestId: widgetReqs[1].requestId,
      sessionId: "s-next",
      widgetId: "w1",
      widget: { id: "w1", source: "export default () => 'next';" },
    });
    expect((await pNext)?.source).toContain("'next'");

    // Switching from s-prev -> s-next invalidates s-prev while keeping s-next cached
    invalidateWidgetSources("s-prev");
    widgetReqs.length = 0;
    const cachedNext = await fetchWidgetSource((cmd) => widgetReqs.push(cmd), "h1", "s-next", "w1");
    expect(cachedNext?.source).toContain("'next'");
    expect(widgetReqs).toHaveLength(0);

    // 7b. Background output buffer eviction on session switch + Review 8 MiB Blob cache + Transcript/Queue purge
    const origCreateUrl = URL.createObjectURL;
    const origRevokeUrl = URL.revokeObjectURL;
    const revokedReviewUrls: string[] = [];
    let reviewUrlSeq = 0;
    URL.createObjectURL = () => `blob:review/${++reviewUrlSeq}`;
    URL.revokeObjectURL = (u: string) => {
      revokedReviewUrls.push(u);
    };

    try {
      const reviewSent: DaemonCommand[] = [];
      const ctx = createRoot((dispose) => {
        const [activeSid, setActiveSid] = createSignal("s1");

        const bg = createBackground({
          send: () => {},
          isOpen: () => true,
          getSessionId: activeSid,
          toast: () => {},
        });
        const review = createReview({
          send: (cmd) => {
            reviewSent.push(cmd);
          },
          isOpen: () => true,
          isHostOnline: () => true,
          isSessionRunning: () => false,
          getSessionId: activeSid,
          getHostId: () => "h1",
          toast: () => {},
          showConfirm: async () => true,
        });
        const t = createTranscript({
          send: () => {},
          isOpen: () => true,
          getSessionId: activeSid,
          getHostId: () => "h1",
          toast: () => {},
          showChoice: async () => null,
          onTurnIdle: () => {},
          onUsageContext: () => {},
        });
        const q = createQueue({
          send: () => {},
          getSessionId: activeSid,
          isOpen: () => true,
          isHostOnline: () => true,
          isSessionRunning: () => false,
          toast: () => {},
        });
        return { dispose, setActiveSid, bg, review, t, q };
      });

      try {
        ctx.bg.noteSessionTaskEvent({
          type: "bg_task_registered",
          jobId: "job-1",
          sessionId: "s1",
          kind: "bash",
          label: "build",
        });
        ctx.bg.noteOutput("job-1", "large stdout chunk", "s1", 0, 1, 18, true);
        expect(ctx.bg.output()["job-1"]).toBe("large stdout chunk");

        ctx.review.noteSessionFiles("s1", [
          { id: "f1", name: "diagram.png", mime: "image/png", size: 4 },
        ]);
        expect(ctx.review.sessionFiles()["s1"]).toHaveLength(1);
        ctx.review.openStoredPreview("s1", "f1");
        const getAttReq = reviewSent.find((c) => c.type === "get_attachment") as any;
        expect(typeof getAttReq?.requestId).toBe("string");
        ctx.review.noteAttachmentData({
          type: "attachment_data",
          requestId: getAttReq.requestId,
          sessionId: "s1",
          attachment: {
            id: "f1",
            name: "diagram.png",
            mime: "image/png",
            data: btoa("png!"),
            size: 4,
          },
        } as any);
        expect(ctx.review.previewFile()?.dataUrl).toBe("blob:review/1");
        expect(ctx.review.previewFile()?.dataB64).toBeUndefined();
        expect(ctx.review.previewFile()?.blob).toBeInstanceOf(Blob);

        // Switch session s1 -> s2: inactive session live buffers and sessionFiles are evicted!
        ctx.setActiveSid("s2");
        expect(ctx.bg.output()).toEqual({});
        expect(ctx.review.sessionFiles()["s1"]).toBeUndefined();

        ctx.review.purgeSessionFiles("s1");
        expect(revokedReviewUrls).toContain("blob:review/1");

        // Transcript purgeSession removes sessionContexts[s1], Queue purgeQueue removes queues[s1]
        ctx.t.setSessionContexts({ s1: { model: "m", usedTokens: 10, windowTokens: 100 } as any, s2: null });
        ctx.t.purgeSession("s1");
        expect("s1" in ctx.t.sessionContexts()).toBe(false);

        ctx.q.noteQueue("s1", [{ id: "q1", text: "queued", createdAt: 1 }] as any);
        ctx.q.purgeQueue("s1");
        expect("s1" in ctx.q.queues()).toBe(false);
        expect(ctx.q.queueOf("s1")).toEqual([]);
      } finally {
        ctx.dispose();
      }
    } finally {
      URL.createObjectURL = origCreateUrl;
      URL.revokeObjectURL = origRevokeUrl;
    }
  });

  test("8. Composer typing zero-reflow: debounced 250ms drafts + flush triggers, single-line height fast-path, non-flashing @mentions & monotonic search requestId", () => {
    vi.useFakeTimers();
    const env = installTestBrowserEnv();
    const sent: DaemonCommand[] = [];

    const ctx = createRoot((dispose) => {
      const [sid, setSid] = createSignal("s-draft");
      const composer = createComposer({
        send: (cmd) => {
          sent.push(cmd);
        },
        isOpen: () => true,
        isDisposed: () => false,
        isHostOnline: () => true,
        getHostId: () => "h1",
        getSessionId: sid,
        getProjectId: () => "p1",
        getModel: () => "claude-sonnet",
        getOptions: () => ({ effort: "medium", mode: "agentic", skills: [], access: "full" }),
        isSessionRunning: () => false,
        isWorkspaceBlocked: () => false,
        checkWorkspace: () => {},
        toast: () => {},
        t: {} as any,
        o: {
          configureSession: () => {},
          setActiveModel: () => {},
          setEffort: () => {},
          setModeMenuOpen: () => {},
        },
        onClearConversation: () => {},
        onBeginConversation: () => {},
        isCreatingSession: () => false,
      });
      const [mText, setMText] = createSignal("@src/a");
      const [caret, setCaret] = createSignal(6);
      const mentions = createMentions({
        send: (cmd) => sent.push(cmd),
        isOpen: () => true,
        getSessionId: () => "s-other",
        getProjectId: () => "p1",
        text: mText,
        setText: setMText,
        inputId: "test-mentions",
      });
      const proj = createProjects({
        send: (cmd) => sent.push(cmd),
        isOpen: () => true,
        getHostId: () => "h1",
        sessions: () => [],
        projects: () => [],
        toast: () => {},
        showConfirm: async () => true,
        isHostOnline: () => true,
      });
      return { dispose, setSid, composer, mText, setMText, caret, setCaret, mentions, proj };
    });

    try {
      const { setSid, composer, setMText, caret, setCaret, mentions, proj } = ctx;
      env.resetSetItemCalls();
      for (const ch of ["h", "he", "hel", "hell", "hello"]) {
        composer.setInputPrompt(ch);
      }
      // Zero synchronous localStorage writes during typing burst!
      expect(env.getSetItemCalls()).toBe(0);
      // O(1) slashMatches fast-exit returns [] for non-'/' prompts
      expect(composer.slashMatches()).toEqual([]);

      vi.advanceTimersByTime(250);
      expect(env.getSetItemCalls()).toBe(1);
      expect(env.storage.get("llmgw-draft:h1:s-draft")).toBe("hello");

      // visibilitychange -> hidden flushes pending draft immediately without waiting 250ms
      composer.setInputPrompt("hello world");
      expect(env.storage.get("llmgw-draft:h1:s-draft")).toBe("hello");
      env.emitVisibility("hidden");
      expect(env.storage.get("llmgw-draft:h1:s-draft")).toBe("hello world");
      env.emitVisibility("visible");

      // pagehide flushes immediately
      composer.setInputPrompt("before pagehide");
      env.emitPageHide();
      expect(env.storage.get("llmgw-draft:h1:s-draft")).toBe("before pagehide");

      // Session switch flushes departing session's draft before switching
      composer.setInputPrompt("departing text");
      setSid("s-other");
      expect(env.storage.get("llmgw-draft:h1:s-draft")).toBe("departing text");

      // Single-line syncComposerHeight fast-path skips style.height = "auto" + scrollHeight read
      let scrollHeightReads = 0;
      let heightWrites = 0;
      let currentHeight = "36px";
      const fakeTextarea = {
        clientWidth: 400,
        scrollWidth: 120,
        get scrollHeight() {
          scrollHeightReads++;
          return 36;
        },
        style: {
          get height() {
            return currentHeight;
          },
          set height(v: string) {
            heightWrites++;
            currentHeight = v;
          },
        },
      } as unknown as HTMLTextAreaElement;
      syncComposerHeight(fakeTextarea, "single line prompt");
      expect(scrollHeightReads).toBe(0);
      expect(heightWrites).toBe(0);

      // useMentions keeps existing file matches visible while next @query keystroke is debouncing
      mentions.setFocused(true);
      mentions.setCaret(caret());
      vi.advanceTimersByTime(180);
      const firstSearch = sent.find((c) => c.type === "search_files") as any;
      mentions.noteMatches({
        type: "file_matches",
        requestId: firstSearch.requestId,
        files: ["src/app.ts", "src/api.ts"],
      });
      expect(mentions.files()).toEqual(["src/app.ts", "src/api.ts"]);

      // Next keystroke inside @query must NOT flash files() to [] while debounce runs!
      setMText("@src/ap");
      setCaret(7);
      mentions.setCaret(7);
      expect(mentions.files()).toEqual(["src/app.ts", "src/api.ts"]);

      // Monotonic search requestId ignores out-of-order stale search_results and maps r.field
      mentions.setFocused(false);
      sent.length = 0;
      proj.setSessionFilter("alpha");
      proj.queueDaemonSearch("alpha");
      vi.advanceTimersByTime(300);
      const req1 = sent.find((c) => c.type === "search") as any;
      expect(req1?.type).toBe("search");
      expect(typeof req1.requestId).toBe("string");

      proj.setSessionFilter("alphabet");
      proj.queueDaemonSearch("alphabet");
      vi.advanceTimersByTime(300);
      const searchReqs = sent.filter((c) => c.type === "search") as any[];
      const req2 = searchReqs[1];
      expect(req2.requestId).not.toBe(req1.requestId);

      // Stale req1 response arrives late -> ignored!
      proj.noteSearchResults({
        type: "search_results",
        query: "alpha",
        requestId: req1.requestId,
        results: [{ sessionId: "stale", title: "Stale", snippet: "old", matchCount: 1 }],
      });
      expect(proj.searchResults()).toEqual([]);

      // Latest req2 response arrives -> accepted with field badge mapped!
      proj.noteSearchResults({
        type: "search_results",
        query: "alphabet",
        requestId: req2.requestId,
        results: [{ sessionId: "fresh", title: "Fresh", snippet: "hit", matchCount: 2, messageIdx: 9, field: "tool_output" }],
      });
      expect(proj.searchResults()).toHaveLength(1);
      expect(proj.searchResults()[0]?.sessionId).toBe("fresh");
      expect(proj.searchResults()[0]?.field).toBe("tool_output");
    } finally {
      ctx.dispose();
    }
  });
});
