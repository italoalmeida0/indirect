import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "bun:test";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
import solidPlugin from "../plugins/solid-plugin";
import { isSyntheticNudge, withoutContinueNudges } from "../web/src/indirect-code/live";
import { buildRenderBlocks } from "../web/src/indirect-code/transcript";
import { cutTail, normalizeSessionMessages } from "../web/src/indirect-code/transcript/updaters";
import type {
  CompactionViewModel,
  formatFailedCommandTip as FormatFailedCommandTipFn,
  getActiveFoldBlocks as GetActiveFoldBlocksFn,
  resolveCompactionViewModel as ResolveCompactionViewModelFn,
  sanitizeCompactionSummary as SanitizeCompactionSummaryFn,
  stripCompactionPreviewMarkdown as StripCompactionPreviewMarkdownFn,
} from "../web/src/indirect-code/components/CompactionBalloon";
import type {
  CompactionState,
  FoldBlockFailedCommand,
  FoldBlockInfo,
} from "../web/src/indirect-code/types";

const repoRoot = path.join(import.meta.dir, "..");
const balloonFilePath = path.join(
  repoRoot,
  "web/src/indirect-code/components/CompactionBalloon.tsx",
);

let mod: {
  formatFailedCommandTip: typeof FormatFailedCommandTipFn;
  getActiveFoldBlocks: typeof GetActiveFoldBlocksFn;
  resolveCompactionViewModel: typeof ResolveCompactionViewModelFn;
  sanitizeCompactionSummary: typeof SanitizeCompactionSummaryFn;
  stripCompactionPreviewMarkdown: typeof StripCompactionPreviewMarkdownFn;
};

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [
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
    mod = await import(blobUrl);
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
});

describe("Multi-era synthetic compaction messages in transcript pipeline", () => {
  test("hides multiple synthetic FoldBlock <system-reminder> messages while keeping exact srcIdx", () => {
    const synB1 =
      "<system-reminder>## Context Summary (compacted)\n\n" +
      "[FoldBlock b1 · raw msgs #0–#12 · 44.2K tok · files: auth.go]\n\n" +
      "## Goal\nImplement token auth.\n</system-reminder>";
    const synB2 =
      "  <system-reminder>\n## Context Summary (compacted) — Era b2\n\n" +
      "## Progress\n- Wired middleware and tests.\n" +
      "[FoldBlock b2 · raw msgs #12–#24 · 39.8K tok]\n</system-reminder>  ";

    expect(isSyntheticNudge(synB1)).toBe(true);
    expect(isSyntheticNudge(synB2)).toBe(true);

    const rawMsgs = [
      // idx 0: synthetic FoldBlock b1
      {
        id: "syn_b1",
        role: "user",
        turnIndex: 1,
        content: [{ type: "text", text: synB1 }],
        meta: { compaction: "true", block_id: "b1" },
      },
      // idx 1: synthetic FoldBlock b2
      {
        id: "syn_b2",
        role: "user",
        turnIndex: 1,
        content: [{ type: "text", text: synB2 }],
        meta: { compaction: "true", block_id: "b2" },
      },
      // idx 2: first kept real user prompt
      {
        id: "u_real_1",
        role: "user",
        turnIndex: 5,
        content: [{ type: "text", text: "Run the auth test suite now." }],
      },
      // idx 3: assistant tool call
      {
        id: "a_real_1",
        role: "assistant",
        turnIndex: 5,
        content: [
          {
            type: "tool_use",
            id: "call_bash_1",
            name: "bash",
            input: { command: "go test ./..." },
          },
        ],
      },
      // idx 4: tool result envelope (hoisted onto assistant at idx 3)
      {
        id: "t_real_1",
        role: "tool",
        turnIndex: 5,
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_bash_1",
            content: '<tool_result type="ok" exit="0">PASS</tool_result>',
          },
        ],
      },
      // idx 5: assistant final answer
      {
        id: "a_real_2",
        role: "assistant",
        turnIndex: 5,
        content: [{ type: "text", text: "All auth tests passed." }],
      },
      // idx 6: second real user prompt
      {
        id: "u_real_2",
        role: "user",
        turnIndex: 6,
        content: [{ type: "text", text: "Ship it." }],
      },
    ];

    const normalized = normalizeSessionMessages(rawMsgs, [], 0);
    const displayRows = withoutContinueNudges(normalized);

    // Zero synthetic compaction user bubbles survive in display rows
    expect(displayRows.map((m) => m.id)).toEqual([
      "u_real_1",
      "a_real_1",
      "a_real_2",
      "u_real_2",
    ]);
    for (const row of displayRows) {
      const joined = row.blocks.map((b) => b.text || "").join("\n");
      expect(joined).not.toContain("## Context Summary (compacted)");
      expect(joined).not.toContain("<system-reminder>");
    }

    // Raw daemon indices (srcIdx) stay 100% exact despite hidden synthetic rows and hoisted tool_result
    expect(displayRows.map((m) => m.srcIdx)).toEqual([2, 3, 5, 6]);
    const hoistedResult = displayRows[1]!.blocks.find((b) => b.type === "tool_result");
    expect(hoistedResult).toBeDefined();
    expect(hoistedResult?.srcIdx).toBe(4);

    // Render blocks also exclude all synthetic FoldBlock bubbles while keeping raw anchors intact
    const renderBlocks = buildRenderBlocks(normalized);
    const userRenderBlocks = renderBlocks.filter((b) => b.msg.role === "user");
    expect(userRenderBlocks.map((b) => b.msg.id)).toEqual(["u_real_1", "u_real_2"]);
    expect(userRenderBlocks.map((b) => b.msg.srcIdx)).toEqual([2, 6]);

    // cutTail against raw index 3 drops tool_result@4, a_real_2@5, u_real_2@6 cleanly
    const truncated = withoutContinueNudges(cutTail(normalized, 3));
    expect(truncated.map((m) => m.srcIdx)).toEqual([2, 3]);
    expect(truncated[1]!.blocks.some((b) => b.type === "tool_result")).toBe(false);
  });

  test("preserves global srcIdx offsets on paged history blocks with synthetic FoldBlock rows", () => {
    const pagedRaw = [
      {
        id: "syn_tier2",
        role: "user",
        turnIndex: 8,
        content: [
          {
            type: "text",
            text: "<system-reminder>## Context Summary (compacted)\n\nTier 2 merged summary</system-reminder>",
          },
        ],
      },
      {
        id: "u_paged",
        role: "user",
        turnIndex: 9,
        content: [{ type: "text", text: "Continue phase 2" }],
      },
      {
        id: "a_paged",
        role: "assistant",
        turnIndex: 9,
        content: [{ type: "text", text: "Starting phase 2." }],
      },
    ];

    const normalized = normalizeSessionMessages(pagedRaw, [], 40);
    const visible = withoutContinueNudges(normalized);
    expect(visible.map((m) => ({ id: m.id, srcIdx: m.srcIdx }))).toEqual([
      { id: "u_paged", srcIdx: 41 },
      { id: "a_paged", srcIdx: 42 },
    ]);
  });
});

describe("CompactionBalloon FoldBlock filtering, ordering, and legacy fallback", () => {
  const sampleBlocks: FoldBlockInfo[] = [
    {
      id: "b1",
      tier: 1,
      startIdx: 0,
      endIdx: 10,
      topic: "Initial setup",
      summary: "## Goal\nBootstrap repo",
      retiredByBlockId: "b5",
    },
    {
      id: "b2",
      tier: 1,
      startIdx: 10,
      endIdx: 22,
      topic: "Database layer",
      summary: "## Progress\nAdded WAL",
      retiredByBlockId: "b5",
    },
    {
      id: "b3",
      tier: 1,
      startIdx: 22,
      endIdx: 35,
      topic: "Session actor",
      summary: "<system-reminder>## Context Summary (compacted)\n\n## Decisions\nMailbox-only state</system-reminder>",
      readFiles: ["cmd/daemon/session_actor.go"],
      modifiedFiles: ["packages/core/compaction.go"],
      activatedTools: ["session_history"],
      rawTokens: 46200,
      blockTokens: 1450,
    },
    {
      id: "b4",
      tier: 1,
      startIdx: 35,
      endIdx: 48,
      topic: "Split turn recovery",
      summary: "## Progress\nMid-turn fold\n\n**Turn Context (split turn):**\n## Original Request\nFinish tests",
      modifiedFiles: ["web/src/indirect-code/components/CompactionBalloon.tsx"],
      failedCommands: [
        {
          command: "go test ./packages/core/...",
          exitCode: "1",
          firstError: "compaction_test.go:84: expected keepFrom 22, got 20",
        },
      ],
      rawTokens: 41800,
      blockTokens: 1320,
    },
    // Appended Tier-2 rollup covering [0, 22) placed at end of blocks slice by LSM merge
    {
      id: "b5",
      tier: 2,
      startIdx: 0,
      endIdx: 22,
      topic: "Bootstrap + WAL rollup",
      summary: "## Goal\nBootstrap repo and crash-only WAL.",
      sourceBlockIds: ["b1", "b2"],
      modifiedFiles: ["cmd/daemon/store_wal.go"],
      rawTokens: 84000,
      blockTokens: 1900,
    },
  ];

  test("filters retired blocks and sorts active blocks chronologically without mutating input", () => {
    const snapshotOrder = sampleBlocks.map((b) => b.id);
    const state: CompactionState = {
      previousSummary: "Joined summary",
      count: 5,
      keepFrom: 48,
      prunedBefore: 35,
      blocks: sampleBlocks,
    };

    const active = mod.getActiveFoldBlocks(state);
    expect(active.map((b) => b.id)).toEqual(["b5", "b3", "b4"]);
    expect(sampleBlocks.map((b) => b.id)).toEqual(snapshotOrder);

    const vm: CompactionViewModel = mod.resolveCompactionViewModel(state);
    expect(vm.mode).toBe("eras");
    expect(vm.retiredBlockCount).toBe(2);
    expect(vm.activeBlocks.map((b) => b.id)).toEqual(["b5", "b3", "b4"]);
    expect(vm.isSplitTurn).toBe(true);
    expect(vm.totalRawTokens).toBe(84000 + 46200 + 41800);
    expect(vm.totalBlockTokens).toBe(1900 + 1450 + 1320);
    expect(vm.headerModifiedFiles).toEqual([
      "cmd/daemon/store_wal.go",
      "packages/core/compaction.go",
      "web/src/indirect-code/components/CompactionBalloon.tsx",
    ]);
    expect(vm.headerReadFiles).toEqual(["cmd/daemon/session_actor.go"]);
  });

  test("falls back cleanly to legacy single-summary mode when blocks are absent or empty", () => {
    const legacyState: CompactionState = {
      previousSummary:
        "## Context Summary (compacted)\n\n## Goal\nMaintain 100% legacy compatibility.\n\n**Turn Context (split turn):**\nKept suffix.",
      modifiedFiles: ["server/index.ts"],
      readFiles: ["README.md"],
      count: 2,
      keepFrom: 18,
    };

    expect(mod.getActiveFoldBlocks(legacyState)).toEqual([]);
    expect(mod.getActiveFoldBlocks({ ...legacyState, blocks: [] })).toEqual([]);
    expect(mod.getActiveFoldBlocks(null)).toEqual([]);

    const vm = mod.resolveCompactionViewModel(legacyState);
    expect(vm.mode).toBe("legacy");
    expect(vm.activeBlocks).toEqual([]);
    expect(vm.retiredBlockCount).toBe(0);
    expect(vm.isSplitTurn).toBe(true);
    expect(vm.cleanedSummary).toBe(
      "## Goal\nMaintain 100% legacy compatibility.\n\n**Turn Context (split turn):**\nKept suffix.",
    );
    expect(vm.copyText).toBe(vm.cleanedSummary);
    expect(vm.headerModifiedFiles).toEqual(["server/index.ts"]);
    expect(vm.headerReadFiles).toEqual(["README.md"]);
    expect(vm.previewText).not.toContain("## Context Summary (compacted)");
    expect(vm.previewText).not.toContain("**");
  });

  test("deduplicates single-era header file chips so expanded single era does not repeat identical files", () => {
    const singleEraState: CompactionState = {
      previousSummary: "Summary",
      modifiedFiles: ["a.ts", "legacy-only.ts"],
      readFiles: ["b.ts"],
      count: 1,
      keepFrom: 12,
      blocks: [
        {
          id: "b1",
          tier: 1,
          startIdx: 0,
          endIdx: 12,
          summary: "## Goal\nSingle era",
          modifiedFiles: ["a.ts"],
          readFiles: ["b.ts"],
        },
      ],
    };

    const vm = mod.resolveCompactionViewModel(singleEraState);
    expect(vm.mode).toBe("eras");
    expect(vm.headerModifiedFiles).toEqual(["legacy-only.ts"]);
    expect(vm.headerReadFiles).toEqual([]);
  });

  test("honors explicit summary override in legacy mode even if compaction has blocks", () => {
    const state: CompactionState = {
      previousSummary: "Ignored",
      blocks: [
        {
          id: "b1",
          tier: 1,
          startIdx: 0,
          endIdx: 6,
          summary: "Era body",
        },
      ],
    };
    const vm = mod.resolveCompactionViewModel(
      state,
      "<system-reminder>## Context Summary (compacted)\n\nExplicit summary prop</system-reminder>",
    );
    expect(vm.mode).toBe("legacy");
    expect(vm.activeBlocks).toEqual([]);
    expect(vm.cleanedSummary).toBe("Explicit summary prop");
    expect(vm.copyText).toBe("Explicit summary prop");
  });
});

describe("Compaction summary sanitization, failed command formatting, and E2E DOM contracts", () => {
  test("strips <system-reminder> tags and ## Context Summary (compacted) headers without harming body markdown", () => {
    const wrapped =
      "<system-reminder>## Context Summary (compacted)\n\n" +
      "## Goal\nShip multi-era timeline.\n\n" +
      "- Keep `srcIdx` stable\n" +
      "- See [docs](https://example.com)</system-reminder>";

    const cleaned = mod.sanitizeCompactionSummary(wrapped);
    expect(cleaned).toBe(
      "## Goal\nShip multi-era timeline.\n\n- Keep `srcIdx` stable\n- See [docs](https://example.com)",
    );
    expect(cleaned).not.toContain("<system-reminder>");
    expect(cleaned).not.toContain("</system-reminder>");
    expect(cleaned).not.toContain("## Context Summary (compacted)");

    const preview = mod.stripCompactionPreviewMarkdown(cleaned);
    expect(preview).toBe(
      "Goal Ship multi-era timeline. - Keep srcIdx stable - See docs",
    );
  });

  test("handles multi-block joined wrappers and empty inputs safely", () => {
    const joined =
      "<system-reminder>\n## Context Summary (compacted) [b1]\n\nEra one\n</system-reminder>\n\n" +
      "<system-reminder>\n## Context Summary (compacted) [b2]\n\nEra two\n</system-reminder>";
    expect(mod.sanitizeCompactionSummary(joined)).toBe("Era one\n\nEra two");
    expect(mod.sanitizeCompactionSummary("## Context Summary (compacted)")).toBe("");
    expect(mod.sanitizeCompactionSummary("")).toBe("");
    expect(mod.sanitizeCompactionSummary(undefined)).toBe("");
    expect(mod.sanitizeCompactionSummary(null)).toBe("");
  });

  test("formats failed command tooltip strings cleanly", () => {
    const failed: FoldBlockFailedCommand = {
      command: "bun test",
      exitCode: "1",
      firstError: "Expected 2, received 1",
    };
    expect(mod.formatFailedCommandTip(failed)).toBe(
      "bun test · exit 1 · Expected 2, received 1",
    );
    expect(mod.formatFailedCommandTip({ command: "cargo check" })).toBe("cargo check");
  });

  test("preserves E2E collapsed pill label and timeline badges in CompactionBalloon.tsx", () => {
    const src = readFileSync(balloonFilePath, "utf8");
    expect(src).toContain("Context Compacted");
    expect(src).toContain("· Split Turn");
    expect(src).toContain("Tier {props.block.tier} · Merged");
    expect(src).toContain("msgs #{props.block.startIdx}–#{props.block.endIdx}");
  });
});
