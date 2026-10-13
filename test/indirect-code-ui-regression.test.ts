import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  bodyWithoutFooter,
  stripToolEnvelopeDetailed,
} from "../web/src/indirect-code/utils/envelope";
import { parseContentBlocks } from "../web/src/indirect-code/utils/wire";
import { buildRenderBlocks, createRenderBlockBuilder } from "../web/src/indirect-code/transcript";
import {
  composerIsCollapsed,
  type ComposerCollapseState,
} from "../web/src/indirect-code/utils/composerState";
import type { ChatMessage, ContentBlock } from "../web/src/indirect-code/types";

describe("tool body footer stripping (bug 7 regressions)", () => {
  test("numeric bracket output lines survive; only footer shapes are stripped", () => {
    // Purely numeric bracket lines are legitimate tool output (counts, ids,
    // versions) and must never be eaten as a "footer fact".
    expect(bodyWithoutFooter("output\n[42]")).toBe("output\n[42]");
    expect(bodyWithoutFooter("output\n[1.5]")).toBe("output\n[1.5]");
    expect(bodyWithoutFooter("output\n[12-13]")).toBe("output\n[12-13]");
    expect(bodyWithoutFooter("output\n[2024]")).toBe("output\n[2024]");
    // The stated invariant: a legitimate last line like "[done]" survives.
    expect(bodyWithoutFooter("output\n[done]")).toBe("output\n[done]");
    // Numeric first line alone is never a footer.
    expect(bodyWithoutFooter("[42]")).toBe("[42]");
  });

  test("footer facts are stripped together with the newline that introduced them", () => {
    expect(bodyWithoutFooter("output\n[No output yet.]")).toBe("output");
    expect(bodyWithoutFooter("output\n[exit 0]")).toBe("output");
    expect(bodyWithoutFooter("output\n[running]")).toBe("output");
    expect(bodyWithoutFooter("chunk\n[1-200/1500 truncated]")).toBe("chunk");
    expect(bodyWithoutFooter("chunk\n[1/5 truncated]")).toBe("chunk");
    expect(bodyWithoutFooter("chunk\n[1-200/1500]")).toBe("chunk");
    expect(bodyWithoutFooter("output\n[more lines: offset 30]")).toBe("output");
    expect(bodyWithoutFooter("output\n[Took 1.2s]")).toBe("output");
    // Multi-fact footer lines ("[exit 0]  [Took 1.2s]") still strip cleanly.
    expect(bodyWithoutFooter("output\n[exit 0]  [Took 1.2s]")).toBe("output");
    // No orphan newline and no content loss when the body is one footer line.
    expect(bodyWithoutFooter("[exit 0]")).toBe("");
  });
});

describe("escaped tool_result markers in tool bodies (bug 8 regressions)", () => {
  test("wire-form escaped marker keeps the full body after it", () => {
    // Daemon escape contract: only `<tool_result` / `</tool_result` become
    // `&lt;tool_result` / `&lt;/tool_result` — the trailing `>` is NOT escaped.
    const wire = '<tool_result type="ok" exit="0">use &lt;tool_result> to wrap</tool_result>';
    const out = stripToolEnvelopeDetailed(wire);
    expect(out.body).toBe("use <tool_result> to wrap");
    expect(out.attrs.exit).toBe("0");
  });

  test("escaped marker mid-body does not erase the tail or the real close", () => {
    const wire =
      '<tool_result type="ok">head &lt;tool_result mid &lt;/tool_result tail</tool_result>';
    expect(stripToolEnvelopeDetailed(wire).body).toBe("head <tool_result mid </tool_result tail");
  });

  test("escaped close marker unescapes without eating following text", () => {
    const wire = '<tool_result type="ok">a &lt;/tool_result> b</tool_result>';
    expect(stripToolEnvelopeDetailed(wire).body).toBe("a </tool_result> b");
  });

  test("tool_result wire content displays fully through parseContentBlocks", () => {
    const [block] = parseContentBlocks({
      content: [
        {
          type: "tool_result",
          tool_use_id: "call1",
          content: '<tool_result type="ok">use &lt;tool_result> to wrap</tool_result>',
        },
      ],
    });
    expect(block.type).toBe("tool_result");
    if (block.type !== "tool_result") throw new Error("expected tool_result block");
    expect(block.toolResult).toBe("use <tool_result> to wrap");
  });
});

describe("composer collapse predicate is shared (bug 58 regression)", () => {
  test("16-state matrix matches the unified rule on every row", () => {
    const states: ComposerCollapseState[] = [];
    for (const composerCollapsed of [false, true])
      for (const draftMode of [false, true])
        for (const activeSessionId of ["", "s1"])
          for (const workspaceBlocked of [false, true])
            states.push({ composerCollapsed, draftMode, activeSessionId, workspaceBlocked });
    expect(states).toHaveLength(16);
    for (const s of states) {
      const expected =
        s.composerCollapsed && !s.draftMode && !!s.activeSessionId && !s.workspaceBlocked;
      expect(composerIsCollapsed(s)).toBe(expected);
    }
    // The row that used to diverge (composer expanded while the banners
    // collapsed): with no active session nothing collapses in either place.
    expect(
      composerIsCollapsed({
        composerCollapsed: true,
        draftMode: false,
        activeSessionId: "",
        workspaceBlocked: false,
      }),
    ).toBe(false);
  });

  test("Composer and StatusBanners both consume the shared predicate", () => {
    const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");
    const sources = [
      read("web/src/indirect-code/components/Composer.tsx"),
      read("web/src/indirect-code/components/composer/StatusBanners.tsx"),
    ];
    for (const src of sources) {
      expect(src).toContain("composerIsCollapsed(");
      // No re-inlined divergent predicate at the call site.
      expect(src).not.toContain("composerCollapsed() &&");
    }
  });
});

describe("render blocks carry turn identity (bug 55 plumbing)", () => {
  const toolMsg = (id: string, turnIndex: number | undefined, toolId: string): ChatMessage => ({
    id,
    role: "assistant",
    turnIndex,
    time: 1,
    blocks: [{ type: "tool_call", toolId, toolName: "bash", toolArgs: "" }],
  });
  const textMsg = (id: string, turnIndex: number | undefined, text: string, flags?: { hasSummary?: boolean; hasCompletion?: boolean }): ChatMessage => ({
    id,
    role: "assistant",
    turnIndex,
    time: 1,
    blocks: [{ type: "text", text }],
    ...flags,
  });

  test("every block of a multi-text turn shares one turn identity", () => {
    // text -> tool -> text -> tool -> text spans several render blocks; live
    // state is turn-scoped, so all of them must share one turnKey — not just
    // the transcript's last block. The texts are summary/completion projections
    // (plain interim text is ephemeral and would not stay visible).
    const turn: ChatMessage[] = [
      toolMsg("m1", 7, "t1"),
      textMsg("m2", 7, "one", { hasSummary: true }),
      toolMsg("m3", 7, "t2"),
      textMsg("m4", 7, "two", { hasCompletion: true }),
      toolMsg("m5", 7, "t3"),
    ];
    const blocks = buildRenderBlocks(turn);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map((b) => b.turnKey)).toEqual(blocks.map(() => "turn:7"));
    // The consumer contract: matching the newest block's turnKey marks every
    // block of the running turn live (the pre-fix `at(-1)` check hit only one).
    const live = blocks.filter((b) => b.turnKey === blocks[blocks.length - 1].turnKey);
    expect(live.length).toBe(blocks.length);
  });

  test("turn identity separates turns and survives the render cache", () => {
    const earlier = textMsg("m0", 6, "earlier answer");
    const turn: ChatMessage[] = [
      toolMsg("m1", 7, "t1"),
      textMsg("m2", 7, "one", { hasSummary: true }),
      toolMsg("m3", 7, "t2"),
    ];
    const build = createRenderBlockBuilder();
    const blocks = build([earlier, ...turn]);
    expect(blocks.map((b) => b.turnKey)).toEqual(["turn:6", "turn:7", "turn:7"]);
    // Cached rebuilds keep the same identity per block.
    const rebuilt = build([earlier, ...turn]);
    expect(rebuilt.map((b) => b.turnKey)).toEqual(blocks.map((b) => b.turnKey));
    // A plain text-only turn is keyed too (single block).
    const single = buildRenderBlocks([textMsg("only", 3, "hi")]);
    expect(single).toHaveLength(1);
    expect(single[0].turnKey).toBe("turn:3");
    // Legacy messages without a stamped turnIndex fall back to the lead id.
    const legacy = buildRenderBlocks([textMsg("a1", undefined, "hi", { hasSummary: true }), toolMsg("a2", undefined, "t")]);
    expect(legacy.every((b) => b.turnKey === "msg:a1")).toBe(true);
  });

  test("block content of a multi-text turn is unchanged by the plumbing", () => {
    const blocks = buildRenderBlocks([
      toolMsg("m1", 7, "t1"),
      textMsg("m2", 7, "one"),
      textMsg("m3", 7, "two"),
    ]);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("series");
    const texts = blocks.flatMap((b) =>
      b.kind === "series"
        ? (b.textMsg?.blocks ?? b.msg.blocks).filter((x: ContentBlock) => x.type === "text")
        : b.msg.blocks.filter((x: ContentBlock) => x.type === "text"),
    );
    expect(texts.map((x) => (x.type === "text" ? x.text : ""))).toEqual(["one", "two"]);
  });
});
