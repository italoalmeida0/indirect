import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
import solidPlugin from "../plugins/solid-plugin";
import { useToolUnitModel } from "../web/src/indirect-code/components/tool/toolUnitModel";
import type { TranscriptRenderCtx } from "../web/src/indirect-code/components/TranscriptBlocks";
import { normalizeSessionMessages } from "../web/src/indirect-code/transcript/updaters";
import type { ToolUnit } from "../web/src/indirect-code/types";
import {
  extractArrivalSpillInfo,
  formatSpillBytes,
  parseExploreView,
  parseHumanDurationMs,
  parseSessionHistoryView,
  splitHighlightSegments,
} from "../web/src/indirect-code/utils/contextTools";
import { footerFromAttrs, stripToolEnvelopeDetailed } from "../web/src/indirect-code/utils/envelope";
import { elapsedLabel } from "../web/src/indirect-code/utils/format";

function makeStubRenderCtx(overrides: Partial<TranscriptRenderCtx> = {}): TranscriptRenderCtx {
  return {
    renderBlocks: () => [],
    sessionStatus: () => "idle",
    isPinned: () => true,
    messages: () => [],
    thinkingStart: () => null,
    thinkingElapsed: () => 0,
    toolProgress: () => ({}),
    elapsedLabel,
    specialProgress: () => ({}),
    thinkingIndex: () => 0,
    verboseChat: () => true,
    hideToolMessages: () => false,
    setPreviewFile: () => {},
    turnClock: () => 0,
    toolStarts: () => ({}),
    activeSession: () => undefined,
    pendingApproval: () => null,
    projects: () => [],
    backgroundJobs: () => [],
    bgOutput: () => ({}),
    bgClock: () => 0,
    ...overrides,
  } as TranscriptRenderCtx;
}

describe("parseSessionHistoryView (search & recall across live details and reloaded envelopes)", () => {
  test("handles 0-hit and empty-compacted-history search outputs cleanly", () => {
    const emptyReloaded = stripToolEnvelopeDetailed(
      '<tool_result action="search" hits="0" indexed="0">No compacted history yet (0 messages before compaction boundary). Pass include_live_tail=true to also search current uncompacted messages.</tool_result>',
    );
    const vEmpty = parseSessionHistoryView(
      { query: "sessionActor" },
      emptyReloaded.body,
      { env: emptyReloaded.attrs },
    );
    expect(vEmpty.action).toBe("search");
    if (vEmpty.action === "search") {
      expect(vEmpty.query).toBe("sessionActor");
      expect(vEmpty.hitCount).toBe(0);
      expect(vEmpty.hitCountKnown).toBe(true);
      expect(vEmpty.indexed).toBe(0);
      expect(vEmpty.includeLiveTail).toBe(false);
      expect(vEmpty.hits).toEqual([]);
      expect(vEmpty.rawText).toContain("No compacted history yet");
    }

    const zeroMatchReloaded = stripToolEnvelopeDetailed(
      '<tool_result action="search" hits="0" indexed="28" live_tail="true">No matches for "nonexistentSymbol" across 28 indexed message(s).</tool_result>',
    );
    const vZero = parseSessionHistoryView(
      {},
      zeroMatchReloaded.body,
      { env: zeroMatchReloaded.attrs },
    );
    expect(vZero.action).toBe("search");
    if (vZero.action === "search") {
      expect(vZero.query).toBe("nonexistentSymbol");
      expect(vZero.hitCount).toBe(0);
      expect(vZero.hitCountKnown).toBe(true);
      expect(vZero.indexed).toBe(28);
      expect(vZero.includeLiveTail).toBe(true);
      expect(vZero.hits).toEqual([]);
    }
  });

  test("parses structured live details.hits AND deterministic reloaded text identically (block, retired Tier-1, Tier-2, message hits)", () => {
    const rawDaemonSearchText = [
      'Found 3 match(es) for "FoldBlock retire":',
      "",
      "1. [block b4 · tier 2 · msgs #0-#35 · LSM rollup & FoldBlock lifecycle] (score 6.42)",
      "   Merged b1..b3 into Tier 2 FoldBlock b4 while keeping retired blocks searchable.",
      '   recall: {"action":"recall","block_id":"b4"}',
      "",
      "2. [block b1 (retired->b4) · tier 1 · msgs #0-#11 · Initial schema] (score 4.18)",
      "   Added retired_by_block_id field to FoldBlock struct.",
      '   recall: {"action":"recall","block_id":"b1"}',
      "",
      "3. [msg #9 · assistant · block b1] (score 3.05)",
      "   Updated retireFoldBlocks in session_compaction.go to preserve raw message indices.",
      '   recall: {"action":"recall","start_msg":8,"end_msg":10}',
    ].join("\n");

    const liveDetails = {
      action: "search",
      query: "FoldBlock retire",
      indexed: 36,
      include_live_tail: false,
      hits: [
        {
          kind: "block",
          block_id: "b4",
          tier: 2,
          start_idx: 0,
          end_idx: 35,
          topic: "LSM rollup & FoldBlock lifecycle",
          score: 6.42,
          snippet: "Merged b1..b3 into Tier 2 FoldBlock b4 while keeping retired blocks searchable.",
        },
        {
          kind: "block",
          block_id: "b1",
          retired_by: "b4",
          tier: 1,
          start_idx: 0,
          end_idx: 11,
          topic: "Initial schema",
          score: 4.18,
          snippet: "Added retired_by_block_id field to FoldBlock struct.",
        },
        {
          kind: "message",
          msg_idx: 9,
          role: "assistant",
          block_id: "b1",
          score: 3.05,
          snippet: "Updated retireFoldBlocks in session_compaction.go to preserve raw message indices.",
        },
      ],
    };

    const liveView = parseSessionHistoryView(
      { action: "search", query: "FoldBlock retire" },
      rawDaemonSearchText,
      liveDetails,
    );

    const reloadedEnv = stripToolEnvelopeDetailed(
      `<tool_result action="search" hits="3" indexed="36">${rawDaemonSearchText}</tool_result>`,
    );
    const reloadedView = parseSessionHistoryView(
      { action: "search", query: "FoldBlock retire" },
      reloadedEnv.body,
      { env: reloadedEnv.attrs },
    );

    expect(liveView.action).toBe("search");
    expect(reloadedView.action).toBe("search");
    if (liveView.action === "search" && reloadedView.action === "search") {
      expect(reloadedView.query).toBe("FoldBlock retire");
      expect(reloadedView.hitCount).toBe(3);
      expect(reloadedView.indexed).toBe(36);
      expect(reloadedView.hits).toEqual(liveView.hits);
      // Machine recall hints must never leak into human UI snippets
      for (const h of reloadedView.hits) {
        expect(h.snippet).not.toContain("recall:");
      }
      expect(reloadedView.hits[0]).toMatchObject({
        rank: 1,
        kind: "block",
        blockId: "b4",
        tier: 2,
        startIdx: 0,
        endIdx: 35,
        topic: "LSM rollup & FoldBlock lifecycle",
      });
      expect(reloadedView.hits[1]).toMatchObject({
        rank: 2,
        kind: "block",
        blockId: "b1",
        retiredBy: "b4",
        tier: 1,
      });
      expect(reloadedView.hits[2]).toMatchObject({
        rank: 3,
        kind: "message",
        msgIdx: 9,
        role: "assistant",
        blockId: "b1",
      });
    }
  });

  test("parses verbatim recall and paginated recall cleanly across live details and reloaded envelopes", () => {
    const rawRecallBody = [
      "=== [msg #4 · user · block b1] ===",
      "Please inspect arrival_spill.go and check the threshold.",
      "",
      "=== [msg #5 · assistant · block b1] ===",
      "Threshold is ArrivalSpillThresholdBytes = 20 * 1024 (20 KB).",
      "",
      "[... recall paginated: offset_chars=0, next_offset=120, total_chars=480, truncated=true — call session_history with offset_chars=120 to continue]",
    ].join("\n");

    const reloaded = stripToolEnvelopeDetailed(
      `<tool_result action="recall" block_id="b1" start_msg="4" end_msg="8" offset_chars="0" total_chars="480" truncated="true" next_offset="120">${rawRecallBody}</tool_result>`,
    );
    const vReloaded = parseSessionHistoryView(
      { block_id: "b1" },
      reloaded.body,
      { env: reloaded.attrs },
    );

    expect(vReloaded.action).toBe("recall");
    if (vReloaded.action === "recall") {
      expect(vReloaded.blockId).toBe("b1");
      expect(vReloaded.startMsg).toBe(4);
      expect(vReloaded.endMsg).toBe(8);
      expect(vReloaded.offsetChars).toBe(0);
      expect(vReloaded.totalChars).toBe(480);
      expect(vReloaded.truncated).toBe(true);
      expect(vReloaded.nextOffset).toBe(120);
      expect(vReloaded.cleanText).not.toContain("recall paginated:");
      expect(vReloaded.messages).toEqual([
        {
          msgIdx: 4,
          role: "user",
          blockId: "b1",
          content: "Please inspect arrival_spill.go and check the threshold.",
        },
        {
          msgIdx: 5,
          role: "assistant",
          blockId: "b1",
          content: "Threshold is ArrivalSpillThresholdBytes = 20 * 1024 (20 KB).",
        },
      ]);
    }

    // Mid-message offset_chars slice with leading continuation text before next header
    const midSlice = [
      "tail of message 5 before header boundary",
      "=== [msg #6 · tool · block b1] ===",
      "exit 0",
    ].join("\n");
    const vMid = parseSessionHistoryView(
      { action: "recall", block_id: "b1", start_msg: 5, end_msg: 6, offset_chars: 200 },
      midSlice,
      { total_chars: 280, truncated: false },
    );
    expect(vMid.action).toBe("recall");
    if (vMid.action === "recall") {
      expect(vMid.messages).toHaveLength(2);
      expect(vMid.messages[0]).toEqual({
        msgIdx: 5,
        role: "continued",
        blockId: "b1",
        content: "tail of message 5 before header boundary",
      });
      expect(vMid.messages[1]).toEqual({
        msgIdx: 6,
        role: "tool",
        blockId: "b1",
        content: "exit 0",
      });
    }

    // Past-end offset fallback
    const vPastEnd = parseSessionHistoryView(
      { action: "recall", block_id: "b1", offset_chars: 900 },
      "[offset_chars=900 is at or past end of recalled text (480 chars)]",
    );
    expect(vPastEnd.action).toBe("recall");
    if (vPastEnd.action === "recall") {
      expect(vPastEnd.offsetChars).toBe(900);
      expect(vPastEnd.totalChars).toBe(480);
      expect(vPastEnd.messages).toEqual([]);
      expect(vPastEnd.cleanText).toContain("at or past end");
    }
  });
});

describe("splitHighlightSegments", () => {
  test("highlights identifiers, file:line paths, and camelCase sub-tokens without regex crashes or HTML injection", () => {
    const segs = splitHighlightSegments(
      "Error in packages/agent/session_history.go:142 calling retireFoldBlocks()",
      "session_history.go:142 retireFoldBlocks",
    );
    const matchedTexts = segs.filter((s) => s.match).map((s) => s.text);
    expect(matchedTexts).toEqual(["session_history.go:142", "retireFoldBlocks"]);
    expect(segs.map((s) => s.text).join("")).toBe(
      "Error in packages/agent/session_history.go:142 calling retireFoldBlocks()",
    );

    // Regex metacharacters & HTML-like text stay 100% literal and safe
    const hostileQuery = "[a-z]+ (foo|bar) $1 \\ * ? ^ {2,3} <script>";
    const hostileText = "Literal [a-z]+ and <script>alert(1)</script> in snippet";
    const safeSegs = splitHighlightSegments(hostileText, hostileQuery);
    expect(safeSegs.map((s) => s.text).join("")).toBe(hostileText);
    expect(safeSegs.filter((s) => s.match).map((s) => s.text)).toContain("[a-z]+");
    expect(safeSegs.filter((s) => s.match).map((s) => s.text)).toContain("script");

    // Empty query returns a single unmatched segment
    expect(splitHighlightSegments("plain snippet", "   ")).toEqual([
      { text: "plain snippet", match: false },
    ]);
    expect(splitHighlightSegments("", "query")).toEqual([]);
  });
});

describe("parseExploreView and parseHumanDurationMs", () => {
  test("parses human duration strings accurately", () => {
    expect(parseHumanDurationMs("450ms")).toBe(450);
    expect(parseHumanDurationMs("2.4s")).toBe(2400);
    expect(parseHumanDurationMs("14s")).toBe(14_000);
    expect(parseHumanDurationMs("1m 12s")).toBe(72_000);
    expect(parseHumanDurationMs("1h 2m 3s")).toBe(3_723_000);
    expect(parseHumanDurationMs("")).toBeUndefined();
  });

  test("extracts task, focusPaths, turns, toolCalls, tokens, duration, and turnCapReached from live details and reloaded attrs", () => {
    const synthesis = [
      "### Summary",
      "Actor state is isolated per session.",
      "",
      "[Note: explore reached its 20-turn cap after 34 tool call(s).]",
    ].join("\n");

    // Live structured details
    const live = parseExploreView(
      {
        task: "  Trace how sessionActor drains control before inbox  ",
        focus_paths: ["cmd/daemon", "packages/agent"],
      },
      synthesis,
      {
        turns: 20,
        tool_calls: 34,
        focus_paths: ["cmd/daemon", "packages/agent"],
        input_tokens: 42_500,
        output_tokens: 1_850,
        turn_cap_reached: true,
        duration_ms: 8420,
      },
    );
    expect(live).toEqual({
      task: "Trace how sessionActor drains control before inbox",
      focusPaths: ["cmd/daemon", "packages/agent"],
      turns: 20,
      toolCalls: 34,
      inputTokens: 42_500,
      outputTokens: 1_850,
      durationMs: 8420,
      turnCapReached: true,
      synthesis,
    });

    // Reloaded from disk (<tool_result ...attrs...>body</tool_result> only)
    const reloadedEnv = stripToolEnvelopeDetailed(
      `<tool_result turns="20" tool_calls="34" duration="8.4s" in_tokens="42500" out_tokens="1850" turn_cap_reached="true">${synthesis}</tool_result>`,
    );
    const reloaded = parseExploreView(
      {
        task: "Trace how sessionActor drains control before inbox",
        focus_paths: ["cmd/daemon", "packages/agent"],
      },
      reloadedEnv.body,
      { env: reloadedEnv.attrs },
    );
    expect(reloaded.turns).toBe(20);
    expect(reloaded.toolCalls).toBe(34);
    expect(reloaded.inputTokens).toBe(42_500);
    expect(reloaded.outputTokens).toBe(1_850);
    expect(reloaded.durationLabel).toBe("8.4s");
    expect(reloaded.durationMs).toBe(8400);
    expect(reloaded.turnCapReached).toBe(true);
    expect(reloaded.synthesis).toBe(synthesis);
  });
});

describe("extractArrivalSpillInfo, formatSpillBytes, and footerFromAttrs", () => {
  test("extracts brain spill metadata, strips LLM trailer, and preserves non-spilled output", () => {
    const previewWithTrailer = [
      "line 1: build started",
      "line 2: compiling 420 modules",
      "",
      "[Full output saved to /home/dev/.indirect/slots/a/brain/tool-output-987654.txt (1420 lines, 68400 bytes) — use read/search on that file to inspect specific sections]",
    ].join("\n");

    const fromAttrsAndTrailer = extractArrivalSpillInfo(previewWithTrailer, {
      truncated: "true",
      spilled: "true",
      spill_file: "tool-output-987654.txt",
      spill_lines: "1420",
      spill_bytes: "68400",
    });
    expect(fromAttrsAndTrailer).toEqual({
      spilled: true,
      fileName: "tool-output-987654.txt",
      fullPath: "/home/dev/.indirect/slots/a/brain/tool-output-987654.txt",
      lines: 1420,
      bytes: 68_400,
      cleanBody: "line 1: build started\nline 2: compiling 420 modules",
    });
    expect(formatSpillBytes(fromAttrsAndTrailer.bytes)).toBe("66.8 KB");

    // Windows path in trailer without spill_file attr (legacy session reload)
    const winPreview =
      "stdout head\n\n[Full output saved to C:\\Users\\italo\\.indirect\\brain\\tool-output-win.txt (850 lines, 29696 bytes) — inspect with read]";
    const fromWinTrailer = extractArrivalSpillInfo(winPreview);
    expect(fromWinTrailer).toEqual({
      spilled: true,
      fileName: "tool-output-win.txt",
      fullPath: "C:\\Users\\italo\\.indirect\\brain\\tool-output-win.txt",
      lines: 850,
      bytes: 29_696,
      cleanBody: "stdout head",
    });

    // Non-spilled output passes through untouched
    const normal = "plain output\n[exit 0]";
    expect(extractArrivalSpillInfo(normal, { exit: "0" })).toEqual({
      spilled: false,
      cleanBody: normal,
    });
  });

  test("footerFromAttrs formats spilled brain fact cleanly and suppresses redundant truncated chip", () => {
    expect(
      footerFromAttrs({
        exit: "0",
        truncated: "true",
        page: "1-120/1420",
        next: "121",
        spilled: "true",
        spill_file: "tool-output-1.txt",
        spill_lines: "1420",
        spill_bytes: "68400",
      }),
    ).toEqual([
      { label: "exit 0", tone: "muted" },
      { label: "saved full output (1,420 lines) to brain", tone: "muted" },
    ]);

    expect(
      footerFromAttrs({
        truncated: "true",
        spilled: "true",
      }),
    ).toEqual([
      { label: "saved full output to brain", tone: "muted" },
    ]);

    // Non-spilled truncated page still emits "page truncated"
    expect(footerFromAttrs({ truncated: "true", page: "1-50/200" })).toEqual([
      { label: "1-50/200 truncated", tone: "muted" },
    ]);
  });
});

describe("useToolUnitModel & normalizeSessionMessages integration", () => {
  test("ticks live elapsed timer for explore while active and resolves duration on reload", () => {
    createRoot((dispose) => {
      const [clock, setClock] = createSignal(5_000);
      const pendingExplore: ToolUnit = {
        id: "call_exp_1",
        call: {
          type: "tool_call",
          toolId: "call_exp_1",
          toolName: "explore",
          toolArgs: JSON.stringify({ task: "Audit actor mailboxes" }),
        },
      };
      const ctx = makeStubRenderCtx({
        turnClock: clock,
        toolStarts: () => ({ call_exp_1: 2_000 }),
        toolProgress: () => ({ call_exp_1: "step 2 · read cmd/daemon/actor.go" }),
      });

      const liveModel = useToolUnitModel(ctx, "m1", pendingExplore, 0, () => true, () => true);
      expect(liveModel.elapsed()).toBe("3s");
      expect(liveModel.prog()).toBe("step 2 · read cmd/daemon/actor.go");
      setClock(9_200);
      expect(liveModel.elapsed()).toBe("7s");

      // Reloaded explore from disk where only Go wire messages + <tool_result duration="450ms" ...> exist
      const reloadedMsgs = normalizeSessionMessages([
        {
          id: "a1",
          role: "assistant",
          content: [
            {
              id: "call_exp_2",
              name: "explore",
              arguments: { task: "Fast lookup" },
            },
          ],
        },
        {
          id: "t1",
          role: "tool",
          content: [
            {
              call_id: "call_exp_2",
              content: [
                {
                  text: '<tool_result turns="1" tool_calls="2" duration="450ms">Done.</tool_result>',
                },
              ],
            },
          ],
        },
      ]);
      const reloadedUnit: ToolUnit = {
        id: "call_exp_2",
        call: reloadedMsgs[0]!.blocks[0],
        result: reloadedMsgs[0]!.blocks[1],
      };
      const reloadedModel = useToolUnitModel(ctx, "a1", reloadedUnit, 0, () => false, () => false);
      expect(reloadedModel.elapsed()).toBe("450ms");
      dispose();
    });
  });

  test("strips arrival-spill trailer from output() and terminal().output while exposing spill()", () => {
    createRoot((dispose) => {
      const reloadedMsgs = normalizeSessionMessages([
        {
          id: "a2",
          role: "assistant",
          content: [
            {
              id: "call_bash_spill",
              name: "bash",
              arguments: { command: "bun test" },
            },
          ],
        },
        {
          id: "t2",
          role: "tool",
          content: [
            {
              call_id: "call_bash_spill",
              content: [
                {
                  text: '<tool_result exit="0" truncated="true" spilled="true" spill_file="tool-output-42.txt" spill_lines="2100" spill_bytes="92160">PASS test/suite.test.ts\n\n[Full output saved to /tmp/brain/tool-output-42.txt (2100 lines, 92160 bytes) — use read/search]</tool_result>',
                },
              ],
            },
          ],
        },
      ]);
      const unit: ToolUnit = {
        id: "call_bash_spill",
        call: reloadedMsgs[0]!.blocks[0],
        result: reloadedMsgs[0]!.blocks[1],
      };
      const m = useToolUnitModel(makeStubRenderCtx(), "a2", unit, 0, () => false, () => false);
      expect(m.spill().spilled).toBe(true);
      expect(m.spill().fileName).toBe("tool-output-42.txt");
      expect(m.spill().lines).toBe(2100);
      expect(m.spill().bytes).toBe(92_160);
      expect(m.output()).toBe("PASS test/suite.test.ts");
      expect(m.terminal().output).toBe("PASS test/suite.test.ts");
      expect(m.footer()).toEqual([
        { label: "exit 0", tone: "muted" },
        { label: "saved full output (2,100 lines) to brain", tone: "muted" },
      ]);
      dispose();
    });
  });
});

describe("Context tool SolidJS component invariants & bundle compilation", () => {
  const repoRoot = path.join(import.meta.dir, "..");

  test("enforces single scroll container, never renders summary args.for_me, and exposes expected data hooks", () => {
    const contextBodiesSrc = readFileSync(
      path.join(repoRoot, "web/src/indirect-code/components/tool/ToolContextBodies.tsx"),
      "utf8",
    );
    const searchBodiesSrc = readFileSync(
      path.join(repoRoot, "web/src/indirect-code/components/tool/ToolSearchBodies.tsx"),
      "utf8",
    );
    const headerSrc = readFileSync(
      path.join(repoRoot, "web/src/indirect-code/components/tool/ToolUnitHeader.tsx"),
      "utf8",
    );
    const balloonSrc = readFileSync(
      path.join(repoRoot, "web/src/indirect-code/components/CompactionBalloon.tsx"),
      "utf8",
    );

    // Single scroll container rule: ToolBody owns max-h-96 overflow-auto
    expect(contextBodiesSrc).not.toMatch(/\boverflow-(?:y-)?auto\b/);
    expect(contextBodiesSrc).not.toMatch(/\bmax-h-\d+\b/);

    // Privacy invariant: summary internal memory notes (args.for_me) must never be rendered
    expect(contextBodiesSrc).not.toContain("for_me");

    // Expected UI hooks
    expect(contextBodiesSrc).toContain('data-tool-context="explore"');
    expect(contextBodiesSrc).toContain('data-tool-context="session-history"');
    expect(searchBodiesSrc).toContain("data-arrival-spill");
    expect(headerSrc).toContain("data-explore-step");
    expect(balloonSrc).toContain("data-compaction-boundary-caption");
    expect(balloonSrc).toContain(
      "Context boundary · earlier turns above are folded into eras and searchable via",
    );
  });

  test("compiles ToolBody, ToolContextBodies, ToolUnitHeader, and CompactionBalloon cleanly with Solid + Iconify plugins", async () => {
    const bundle = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL("../web/src/indirect-code/components/tool/ToolBody.tsx", import.meta.url),
        ),
        fileURLToPath(
          new URL("../web/src/indirect-code/components/tool/ToolUnitHeader.tsx", import.meta.url),
        ),
        fileURLToPath(
          new URL("../web/src/indirect-code/components/CompactionBalloon.tsx", import.meta.url),
        ),
      ],
      target: "browser",
      plugins: [iconifyPlugin, solidPlugin],
    });
    if (!bundle.success) {
      throw new Error(bundle.logs.map(String).join("\n"));
    }
    expect(bundle.outputs.length).toBeGreaterThanOrEqual(3);
  });
});
