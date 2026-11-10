import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("Fixer B2-4 Regression Tests", () => {
  describe("BUG-T5-04: bg_await timer calculation clock skew", () => {
    test("sleepRemaining clamps to total when client clock is behind server start time", async () => {
      const { useToolUnitModel } = await import("../web/src/indirect-code/components/tool/toolUnitModel");
      const { createRoot } = await import("solid-js");
      const ctx: any = {
        toolProgress: () => ({}),
        // Server recorded start at 105000, but client turnClock is 100000 (skew: -5s)
        toolStarts: () => ({ s1: 105000 }),
        turnClock: () => 100000,
        elapsedLabel: (ms: number) => `${ms}ms`,
        backgroundJobs: () => [],
        bgOutput: () => ({}),
        bgClock: () => 0,
      };
      const sleepUnit: any = {
        call: { type: "tool_call", toolId: "s1", toolName: "bg_await", toolArgs: JSON.stringify({ max_wait_seconds: 30, waiting_for: "bg_1" }) },
      };
      createRoot((dispose) => {
        const sleep = useToolUnitModel(ctx, "m1", sleepUnit, 0, () => true, () => true);
        // Without clamping, Math.ceil(30 - (-5)) would be 35s left. With clamping, it's 30s left.
        expect(sleep.sleepRemaining()).toBe("30s left");
        dispose();
      });
    });

    test("sleepRemaining clamps to 0 when time has elapsed", async () => {
      const { useToolUnitModel } = await import("../web/src/indirect-code/components/tool/toolUnitModel");
      const { createRoot } = await import("solid-js");
      const ctx: any = {
        toolProgress: () => ({}),
        toolStarts: () => ({ s1: 100000 }),
        turnClock: () => 140000, // 40s elapsed for 30s wait
        elapsedLabel: (ms: number) => `${ms}ms`,
        backgroundJobs: () => [],
        bgOutput: () => ({}),
        bgClock: () => 0,
      };
      const sleepUnit: any = {
        call: { type: "tool_call", toolId: "s1", toolName: "bg_await", toolArgs: JSON.stringify({ max_wait_seconds: 30, waiting_for: "bg_1" }) },
      };
      createRoot((dispose) => {
        const sleep = useToolUnitModel(ctx, "m1", sleepUnit, 0, () => true, () => true);
        expect(sleep.sleepRemaining()).toBe("0s left");
        dispose();
      });
    });
  });

  describe("BUG-T5-06 & toolUnitModel running state", () => {
    test("running() returns true while executing, false once tool result arrives", async () => {
      const { useToolUnitModel } = await import("../web/src/indirect-code/components/tool/toolUnitModel");
      const { createRoot } = await import("solid-js");
      const ctx: any = {
        toolProgress: () => ({}),
        toolStarts: () => ({ c1: 100000 }),
        turnClock: () => 100000,
        elapsedLabel: (ms: number) => `${ms}ms`,
        backgroundJobs: () => [],
        bgOutput: () => ({}),
        bgClock: () => 0,
      };
      const runningUnit: any = {
        call: { type: "tool_call", toolId: "c1", toolName: "bg_cancel", toolArgs: JSON.stringify({ job_id: "bg_1" }) },
      };
      const doneUnit: any = {
        call: { type: "tool_call", toolId: "c2", toolName: "bg_cancel", toolArgs: JSON.stringify({ job_id: "bg_1" }) },
        result: { type: "tool_result", toolId: "c2", toolResult: "" },
      };

      createRoot((dispose) => {
        const activeCancel = useToolUnitModel(ctx, "m1", runningUnit, 0, () => true, () => true);
        expect(activeCancel.running()).toBe(true);

        const finishedCancel = useToolUnitModel(ctx, "m1", doneUnit, 1, () => true, () => false);
        expect(finishedCancel.running()).toBe(false);

        dispose();
      });
    });

    test("ToolSearchBodies checks !props.m.running() for bg_cancel", () => {
      const src = readFileSync("web/src/indirect-code/components/tool/ToolSearchBodies.tsx", "utf-8");
      expect(src).toContain('props.m.name() === "bg_cancel" && !props.m.running()');
    });
  });

  describe("BUG-T5-01: Finished background tool row displays output instead of frozen Running in background…", () => {
    test("ToolSearchBodies bash block displays output when bgRunning() is false", () => {
      const src = readFileSync("web/src/indirect-code/components/tool/ToolSearchBodies.tsx", "utf-8");
      expect(src).toContain('text={props.m.bgRunning()');
      expect(src).not.toContain('props.m.bgRunning() || props.m.isDetachedBg()');
    });

    test("ToolEditBodies exec_script block displays output when bgRunning() is false", () => {
      const src = readFileSync("web/src/indirect-code/components/tool/ToolEditBodies.tsx", "utf-8");
      expect(src).toContain('text={props.m.bgRunning() ?');
      expect(src).not.toContain('props.m.bgRunning() || props.m.isDetachedBg()');
    });
  });

  describe("BUG-T5-02 & BUG-T5-03: BackgroundCard UX", () => {
    test("BackgroundCard row has cursor-pointer and onClick handler on header", () => {
      const src = readFileSync("web/src/indirect-code/components/BackgroundCard.tsx", "utf-8");
      expect(src).toContain('cursor-pointer hover:bg-surface-muted/60');
      expect(src).toContain('onClick={() => toggle(job.id)}');
    });

    test("BackgroundCard includes recently finished tasks in activeTasks and allows dismiss", () => {
      const src = readFileSync("web/src/indirect-code/components/BackgroundCard.tsx", "utf-8");
      expect(src).toContain("recentlyFinished");
      expect(src).toContain("activeTasks");
      expect(src).toContain("data-bg-dismiss");
    });
  });

  describe("TurnChangesBalloon is strictly read-only with pro diffstat and status badges", () => {
    test("TurnChangesBalloon renders zero Undo buttons, badges, or callbacks and includes 5-block diffstat and Expand/Collapse all", () => {
      const src = readFileSync("web/src/indirect-code/components/TurnChangesBalloon.tsx", "utf-8");
      expect(src).not.toContain("onUndo");
      expect(src).not.toContain("undoBusy");
      expect(src).not.toContain("undoneCount");
      expect(src).not.toContain("lucide:undo-2");
      expect(src).toContain("diffStatBlocks");
      expect(src).toContain("Collapse all");
      expect(src).toContain("Expand all");
      expect(src).toContain('label: "A"');
      expect(src).toContain('label: "M"');
      expect(src).toContain('label: "D"');
      expect(src).toContain('label: "BIN"');
    });

    test("TranscriptView renders TurnChangesBalloon without undo props", () => {
      const src = readFileSync("web/src/indirect-code/components/TranscriptView.tsx", "utf-8");
      expect(src).not.toContain("undoTurn");
      expect(src).not.toContain("undoBusy");
      expect(src).not.toContain("onUndo");
    });
  });

  describe("BUG-R3-T2-08: Binary file rows in balloon show chevron and cursor pointer", () => {
    test("isExpandable includes binary files so chevron and pointer are shown", () => {
      const src = readFileSync("web/src/indirect-code/components/TurnChangesBalloon.tsx", "utf-8");
      expect(src).toContain('const isExpandable = () => hasDiff() || props.f.status === "binary";');
      expect(src).toContain("<Show when={isExpandable()}>");
    });
  });

  describe("BUG-R3-T2-07: TurnChangesBalloon autoscroll bottom clearance", () => {
    test("TranscriptView applies pb-28 when balloon is on the last block", () => {
      const src = readFileSync("web/src/indirect-code/components/TranscriptView.tsx", "utf-8");
      expect(src).toContain('isLast() ? "pb-28" : ""');
    });
  });
});
