import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
import solidPlugin from "../plugins/solid-plugin";
import { buildRenderBlocks } from "../web/src/indirect-code/transcript";
import { isBlockRunning } from "../web/src/indirect-code/utils/blockRuns";
import type {
  createDisclosure as CreateDisclosureFn,
  useToolUnitModel as UseToolUnitModelFn,
} from "../web/src/indirect-code/components/tool/toolUnitModel";
import type {
  formatStickyPromptPreview as FormatStickyPromptPreviewFn,
  groupBlocksIntoTurns as GroupBlocksIntoTurnsFn,
  resolveStickyTurnState as ResolveStickyTurnStateFn,
  StickyTurnMetrics,
} from "../web/src/indirect-code/components/TranscriptView";
import type { ChatMessage, RenderBlock, ToolUnit } from "../web/src/indirect-code/types";

const repoRoot = path.join(import.meta.dir, "..");
const readRepo = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let clientMod: {
  createRoot: typeof import("solid-js").createRoot;
  createSignal: typeof import("solid-js").createSignal;
  createMemo: typeof import("solid-js").createMemo;
  createDisclosure: typeof CreateDisclosureFn;
  useToolUnitModel: typeof UseToolUnitModelFn;
  groupBlocksIntoTurns: typeof GroupBlocksIntoTurnsFn;
  formatStickyPromptPreview: typeof FormatStickyPromptPreviewFn;
  resolveStickyTurnState: typeof ResolveStickyTurnStateFn;
};

beforeAll(async () => {
  const virtualEntry = path.join(repoRoot, "web/src/indirect-code/__transcript_ux_test_entry__.ts");
  const virtualPlugin: import("bun").BunPlugin = {
    name: "transcript-ux-test-entry",
    setup(build) {
      build.onResolve({ filter: /__transcript_ux_test_entry__\.ts$/ }, () => ({
        path: virtualEntry,
        namespace: "transcript-ux-test",
      }));
      build.onLoad({ filter: /.*/, namespace: "transcript-ux-test" }, () => ({
        contents: [
          `export { createRoot, createSignal, createMemo } from "solid-js";`,
          `export { createDisclosure, useToolUnitModel } from ${JSON.stringify(path.join(repoRoot, "web/src/indirect-code/components/tool/toolUnitModel.ts"))};`,
          `export { groupBlocksIntoTurns, formatStickyPromptPreview, resolveStickyTurnState } from ${JSON.stringify(path.join(repoRoot, "web/src/indirect-code/components/TranscriptView.tsx"))};`,
        ].join("\n"),
        loader: "ts",
      }));
    },
  };

  // Bundle with target: "browser" so Solid's real client reactive runtime
  // (createEffect/createMemo/createSignal) runs instead of solid-js/dist/server.js.
  const bundle = await Bun.build({
    entrypoints: [virtualEntry],
    target: "browser",
    plugins: [virtualPlugin, iconifyPlugin, solidPlugin],
  });
  if (!bundle.success) {
    throw new Error(bundle.logs.map(String).join("\n"));
  }
  const code = await bundle.outputs[0]!.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const g = globalThis as Record<string, any>;
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  const hadWindowDoc = Boolean(
    g.window && typeof g.window === "object" && "document" in g.window,
  );
  const prevWindowDoc = g.window?.document;
  const hadDocument = "document" in g;
  const prevDocument = g.document;
  const fakeDoc = {
    compatMode: "CSS1Compat",
    hidden: false,
    documentElement: { dataset: {}, style: {} },
    addEventListener() {},
    removeEventListener() {},
  };
  if (!g.document) g.document = fakeDoc;
  if (!g.window || typeof g.window !== "object") {
    g.window = {
      document: g.document,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    };
  } else if (!g.window.document) {
    g.window.document = g.document;
  }
  try {
    clientMod = await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
    if (!hadWindow) {
      delete g.window;
    } else {
      g.window = prevWindow;
      if (g.window && typeof g.window === "object") {
        if (!hadWindowDoc) delete g.window.document;
        else g.window.document = prevWindowDoc;
      }
    }
    if (!hadDocument) delete g.document;
    else g.document = prevDocument;
  }
}, 30_000);

describe("Scrollbar gutter reservation & diagonal layout-shift prevention", () => {
  test("code.css reserves symmetrical desktop scrollbar gutters and 0px mobile gutter", () => {
    const css = readRepo("web/src/styles/code.css");
    expect(css).toContain(".rc-transcript-scroll {");
    expect(css).toContain("overflow-anchor: none;");
    expect(css).toContain("scrollbar-gutter: stable;");
    expect(css).toContain("scrollbar-gutter: stable both-edges;");
    expect(css).toContain("html.mobile .rc-transcript-scroll");
    expect(css).toContain("scrollbar-gutter: auto;");
  });

  test("TranscriptView wires rc-transcript-scroll, overflow-x-hidden, and preserves shared padding", () => {
    const src = readRepo("web/src/indirect-code/components/TranscriptView.tsx");
    expect(src).toContain("rc-transcript-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden");
    expect(src).toContain('class="pt-6 pb-8 space-y-5"');
    expect(src).not.toContain("pb-28");
  });

  test("DisclosureBody and TranscriptBlocks lock flex cross-axis width (w-full min-w-0) with overflow-anchor: none", () => {
    const disc = readRepo("web/src/indirect-code/components/Disclosure.tsx");
    expect(disc).toContain("w-full min-w-0");
    expect(disc).toContain('"overflow-anchor": "none"');

    const blocks = readRepo("web/src/indirect-code/components/TranscriptBlocks.tsx");
    expect(blocks).toContain('class="w-full min-w-0 flex flex-col my-0.5"');
    expect(blocks).toContain('class="w-full min-w-0 space-y-2.5"');
    expect(blocks).toContain('class="w-full min-w-0 flex flex-col"');
    expect(blocks).toContain("border-l border-border space-y-0.5 min-w-0");
  });
});

describe("Tool-aggregate & internal tool lifecycle auto-collapse", () => {
  test("createDisclosure auto-collapses on active -> finished transition and clears pre-finish manual state", () => {
    clientMod.createRoot((dispose) => {
      const [running, setRunning] = clientMod.createSignal(true);
      const disc = clientMod.createDisclosure(() => String(running()), running);

      expect(disc.open()).toBe(true);

      // User toggles manually while running (closes then re-opens).
      disc.toggle();
      expect(disc.open()).toBe(false);
      disc.toggle();
      expect(disc.open()).toBe(true);

      // Aggregate finishes / is superseded -> auto-collapses and clears pre-finish manual state.
      setRunning(false);
      expect(disc.open()).toBe(false);

      dispose();
    });
  });

  test("createDisclosure never subscribes an enclosing tracking scope to phase() (no DOM teardown on phase change)", () => {
    clientMod.createRoot((dispose) => {
      const [running, setRunning] = clientMod.createSignal(true);
      let pinned = true;
      let outerRuns = 0;
      let disc!: ReturnType<typeof CreateDisclosureFn>;

      // Simulates <Show>{() => renderTurnAggregate(...)}</Show> calling createDisclosure.
      const outer = clientMod.createMemo(() => {
        outerRuns++;
        disc = clientMod.createDisclosure(() => String(running()), running, () => pinned);
        return outerRuns;
      });

      expect(outer()).toBe(1);
      expect(disc.open()).toBe(true);

      // Detach (unpin) and finish the turn: outer computation must NOT re-run,
      // and unpinned thinking-only content stays open!
      pinned = false;
      setRunning(false);
      expect(outer()).toBe(1);
      expect(outerRuns).toBe(1);
      expect(disc.open()).toBe(true);

      dispose();
    });
  });

  test("createDisclosure preserves post-finish manual opens across unrelated ticks and later turns", () => {
    clientMod.createRoot((dispose) => {
      const [blocks, setBlocks] = clientMod.createSignal<RenderBlock[]>(
        buildRenderBlocks([
          { id: "u1", role: "user", turnIndex: 1, blocks: [{ type: "text", text: "Run checks" }] },
          {
            id: "a1",
            role: "assistant",
            turnIndex: 1,
            blocks: [{ type: "tool_call", toolId: "c1", toolName: "bash", toolArgs: '{"command":"bun test"}' }],
          },
        ]),
      );
      const [status, setStatus] = clientMod.createSignal<"running" | "idle">("running");
      const [tick, setTick] = clientMod.createSignal(0);

      const firstSeries = () => blocks().find((b) => b.id === "a1")!;
      const isRunning = () => {
        tick(); // simulate unrelated reactive reads
        return isBlockRunning(blocks(), firstSeries(), status());
      };

      const agg = clientMod.createDisclosure(() => String(isRunning()), isRunning);
      expect(agg.open()).toBe(true);

      // Assistant text lands on the series -> aggregate is superseded and collapses.
      setBlocks(
        buildRenderBlocks([
          { id: "u1", role: "user", turnIndex: 1, blocks: [{ type: "text", text: "Run checks" }] },
          {
            id: "a1",
            role: "assistant",
            turnIndex: 1,
            blocks: [
              { type: "tool_call", toolId: "c1", toolName: "bash", toolArgs: '{"command":"bun test"}' },
              { type: "tool_result", toolId: "c1", toolResult: "ok" },
            ],
          },
          { id: "a2", role: "assistant", turnIndex: 1, hasCompletion: true, blocks: [{ type: "text", text: "All tests pass." }] },
        ]),
      );
      expect(isRunning()).toBe(false);
      expect(agg.open()).toBe(false);

      // Turn ends too.
      setStatus("idle");
      expect(agg.open()).toBe(false);

      // User manually expands finished aggregate -> MUST stay open!
      agg.toggle();
      expect(agg.open()).toBe(true);

      // Unrelated clock ticks, snapshots, and a brand-new running turn must NOT collapse it.
      setTick(1);
      expect(agg.open()).toBe(true);
      setBlocks([
        ...blocks(),
        ...buildRenderBlocks([
          { id: "u2", role: "user", turnIndex: 2, blocks: [{ type: "text", text: "Next task" }] },
          { id: "a3", role: "assistant", turnIndex: 2, blocks: [{ type: "tool_call", toolId: "c2", toolName: "read", toolArgs: '{"path":"a.ts"}' }] },
        ]),
      ]);
      setStatus("running");
      expect(isRunning()).toBe(false);
      expect(agg.open()).toBe(true);

      setStatus("idle");
      expect(agg.open()).toBe(true);

      dispose();
    });
  });

  test("useToolUnitModel collapses active and pre-finish manually opened rows on turn finish, and keeps post-finish manual opens", () => {
    clientMod.createRoot((dispose) => {
      const [running, setRunning] = clientMod.createSignal(true);
      const [active1, setActive1] = clientMod.createSignal(true);
      const [active2, setActive2] = clientMod.createSignal(false);
      const [clock, setClock] = clientMod.createSignal(1000);

      const u1: ToolUnit = {
        id: "t1",
        call: { type: "tool_call", toolId: "t1", toolName: "bash", toolArgs: '{"command":"ls"}' },
      };
      const u2: ToolUnit = {
        id: "t2",
        call: { type: "tool_call", toolId: "t2", toolName: "read", toolArgs: '{"path":"README.md"}' },
      };

      const ctx: any = {
        toolProgress: () => ({}),
        toolStarts: () => ({ t1: 1000, t2: 1100 }),
        turnClock: clock,
        elapsedLabel: (ms: number) => `${ms}ms`,
        backgroundJobs: () => [],
        bgOutput: () => ({}),
        bgClock: () => 0,
      };

      const m1 = clientMod.useToolUnitModel(ctx, "m1", u1, 0, running, active1);
      const m2 = clientMod.useToolUnitModel(ctx, "m1", u2, 1, running, active2);

      // Tool 1 is live tail -> auto-opened; Tool 2 not active yet -> closed.
      expect(m1.openBody()).toBe(true);
      expect(m2.openBody()).toBe(false);

      // Tool 1 finishes, Tool 2 becomes active -> Tool 1 auto-collapses, Tool 2 opens.
      u1.result = { type: "tool_result", toolId: "t1", toolResult: "file.ts" };
      setActive1(false);
      setActive2(true);
      expect(m1.openBody()).toBe(false);
      expect(m2.openBody()).toBe(true);

      // User manually opens Tool 1 while the aggregate is still running.
      m1.toggle();
      expect(m1.openBody()).toBe(true);

      // Aggregate finishes -> BOTH Tool 1 (pre-finish manual) and Tool 2 (live) collapse cleanly!
      u2.result = { type: "tool_result", toolId: "t2", toolResult: "# Readme" };
      setActive2(false);
      setRunning(false);
      expect(m1.openBody()).toBe(false);
      expect(m2.openBody()).toBe(false);

      // Post-finish: user manually opens Tool 1 -> stays open across clock ticks!
      m1.toggle();
      expect(m1.openBody()).toBe(true);
      setClock(5000);
      expect(m1.openBody()).toBe(true);

      dispose();
    });
  });

  test("TranscriptBlocks auto-collapses tool aggregates and subgroups even when unpinned, while keeping thinking-only unpinned preservation", () => {
    const src = readRepo("web/src/indirect-code/components/TranscriptBlocks.tsx");
    expect(src).toContain(
      "const allowAutoCollapse = () => (onlyThinking() ? (ctx.isPinned ? ctx.isPinned() : true) : true);",
    );
    expect(src).toContain(
      "const { open, toggle } = createDisclosure(() => String(running()), running, allowAutoCollapse);",
    );
    // Tool subgroup disclosure must not be gated by ctx.isPinned.
    expect(src).toContain(
      "const { open, toggle } = createDisclosure(() => `${running()}:${active()}`, active);",
    );
  });
});

describe("Sticky user prompt turn grouping, formatting, and scroll geometry", () => {
  test("groupBlocksIntoTurns groups multi-turn transcripts and preserves exact RenderBlock references", () => {
    const msgs: ChatMessage[] = [
      { id: "u1", role: "user", turnIndex: 1, srcIdx: 0, blocks: [{ type: "text", text: "First prompt" }] },
      { id: "a1", role: "assistant", turnIndex: 1, srcIdx: 1, blocks: [{ type: "tool_call", toolId: "c1", toolName: "read" }] },
      { id: "a2", role: "assistant", turnIndex: 1, srcIdx: 2, hasSummary: true, blocks: [{ type: "text", text: "Step summary" }] },
      { id: "a3", role: "assistant", turnIndex: 1, srcIdx: 3, hasCompletion: true, blocks: [{ type: "text", text: "Final answer" }] },
      { id: "u2", role: "user", turnIndex: 2, srcIdx: 4, blocks: [{ type: "text", text: "Second prompt" }] },
      { id: "a4", role: "assistant", turnIndex: 2, srcIdx: 5, blocks: [{ type: "text", text: "Reply 2" }] },
    ];
    const blocks = buildRenderBlocks(msgs);
    const turns = clientMod.groupBlocksIntoTurns(blocks);

    expect(turns.map((t) => t.id)).toEqual(["u1", "u2"]);
    expect(turns[0]!.startIdx).toBe(0);
    expect(turns[0]!.userBlock).toBe(blocks[0]);
    expect(turns[0]!.assistantBlocks).toHaveLength(2);
    expect(turns[0]!.assistantBlocks[0]).toBe(blocks[1]);
    expect(turns[0]!.assistantBlocks[1]).toBe(blocks[2]);

    expect(turns[1]!.startIdx).toBe(3);
    expect(turns[1]!.userBlock).toBe(blocks[3]);
    expect(turns[1]!.assistantBlocks).toHaveLength(1);
    expect(turns[1]!.assistantBlocks[0]).toBe(blocks[4]);
  });

  test("groupBlocksIntoTurns handles leading orphan assistant blocks and consecutive user prompts", () => {
    const msgs: ChatMessage[] = [
      { id: "a0", role: "assistant", turnIndex: 1, blocks: [{ type: "text", text: "Post-compaction tail" }] },
      { id: "u1", role: "user", turnIndex: 2, blocks: [{ type: "text", text: "Prompt A" }] },
      { id: "u2", role: "user", turnIndex: 3, blocks: [{ type: "text", text: "Prompt B" }] },
      { id: "a1", role: "assistant", turnIndex: 3, blocks: [{ type: "text", text: "Answer B" }] },
    ];
    const blocks = buildRenderBlocks(msgs);
    const turns = clientMod.groupBlocksIntoTurns(blocks);

    expect(turns.map((t) => t.id)).toEqual(["orphan:a0", "u1", "u2"]);
    expect(turns[0]!.userBlock).toBeNull();
    expect(turns[0]!.assistantBlocks.map((b) => b.msg.id)).toEqual(["a0"]);
    expect(turns[1]!.userBlock?.msg.id).toBe("u1");
    expect(turns[1]!.assistantBlocks).toEqual([]);
    expect(turns[2]!.userBlock?.msg.id).toBe("u2");
    expect(turns[2]!.assistantBlocks.map((b) => b.msg.id)).toEqual(["a1"]);
    expect(clientMod.groupBlocksIntoTurns([])).toEqual([]);
  });

  test("formatStickyPromptPreview collapses multiline text and handles attachment-only prompts", () => {
    expect(
      clientMod.formatStickyPromptPreview("Hey,\n\n  Fix `TranscriptView.tsx`\n  and sticky headers.  "),
    ).toBe("Hey, Fix `TranscriptView.tsx` and sticky headers.");
    expect(clientMod.formatStickyPromptPreview("   \n\t ", [{ name: "spec.pdf" }])).toBe("spec.pdf");
    expect(
      clientMod.formatStickyPromptPreview("", [{ name: "shot1.png" }, { name: "shot2.png" }, { name: "log.txt" }]),
    ).toBe("shot1.png +2");
    expect(clientMod.formatStickyPromptPreview("   ", [])).toBe("");
  });

  test("resolveStickyTurnState sticks below user prompt, pushes smoothly into next turn, and swaps cleanly", () => {
    const atScroll = (scrollTop: number, edits: Record<string, boolean> = {}): StickyTurnMetrics[] => [
      // Turn 1: user [24..84], section [24..1000]
      {
        id: "u1",
        userBottomRel: 84 - scrollTop,
        sectionBottomRel: 1000 - scrollTop,
        eligible: !edits.u1,
      },
      // Turn 2: user [1020..1080], section [1020..2200]
      {
        id: "u2",
        userBottomRel: 1020 + 60 - scrollTop,
        sectionBottomRel: 2200 - scrollTop,
        eligible: !edits.u2,
      },
    ];

    // At top or while user prompt is still visible in flow -> never sticks.
    expect(clientMod.resolveStickyTurnState(atScroll(0), 48, 0)).toEqual({ turnId: null, pushY: 0 });
    expect(clientMod.resolveStickyTurnState(atScroll(50), 48, 50)).toEqual({ turnId: null, pushY: 0 });

    // Once scrolled past Turn 1's user prompt -> Turn 1 sticks cleanly at 0px offset.
    expect(clientMod.resolveStickyTurnState(atScroll(80), 48, 80)).toEqual({ turnId: "u1", pushY: 0 });
    expect(clientMod.resolveStickyTurnState(atScroll(500), 48, 500)).toEqual({ turnId: "u1", pushY: 0 });

    // As Turn 1's section bottom enters the top 48px bar zone -> pushes smoothly up.
    expect(clientMod.resolveStickyTurnState(atScroll(960), 48, 960)).toEqual({ turnId: "u1", pushY: -8 });
    expect(clientMod.resolveStickyTurnState(atScroll(985), 48, 985)).toEqual({ turnId: "u1", pushY: -33 });

    // Turn 1 leaves viewport top while Turn 2's in-flow user prompt is visible -> no sticky overlap.
    expect(clientMod.resolveStickyTurnState(atScroll(995), 48, 995)).toEqual({ turnId: null, pushY: 0 });
    expect(clientMod.resolveStickyTurnState(atScroll(1040), 48, 1040)).toEqual({ turnId: null, pushY: 0 });

    // Scrolled past Turn 2's user prompt -> Turn 2 sticks cleanly.
    expect(clientMod.resolveStickyTurnState(atScroll(1080), 48, 1080)).toEqual({ turnId: "u2", pushY: 0 });

    // Inline editing on the active turn suppresses its sticky header.
    expect(clientMod.resolveStickyTurnState(atScroll(500, { u1: true }), 48, 500)).toEqual({ turnId: null, pushY: 0 });

    // A user-only turn with no content below it never sticks once scrolled past.
    expect(
      clientMod.resolveStickyTurnState(
        [{ id: "u-only", userBottomRel: -10, sectionBottomRel: -10, eligible: true }],
        48,
        100,
      ),
    ).toEqual({ turnId: null, pushY: 0 });
  });

  test("sticky prompt styling stays below overlays (z-15), omits data-transcript-id, and honors reduced motion & high contrast", () => {
    const css = readRepo("web/src/styles/code.css");
    expect(css).toContain(".rc-sticky-prompt-anchor {");
    expect(css).toContain("position: sticky;");
    expect(css).toContain("z-index: 15;");
    expect(css).toContain("height: 0;");
    expect(css).toContain(':root[data-theme="high-contrast"] .rc-sticky-prompt-btn');
    expect(css).toContain(':root[data-reduced-motion="reduce"] .rc-sticky-prompt-btn');

    const src = readRepo("web/src/indirect-code/components/TranscriptView.tsx");
    expect(src).toContain("data-sticky-prompt={stuck().id}");
    expect(src).toContain("line-clamp-2");
    expect(src).toContain("scrollToUserPrompt");
  });
});
