import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { ToolUnit } from "../web/src/indirect-code/types";
import { groupTitle, specialTitle } from "../web/src/indirect-code/utils/titles";
import {
  DAEMON_BUILTIN_TOOLS,
  extractTodoItems,
  isDaemonBuiltinTool,
  resolveWidgetId,
  toolCatOf,
} from "../web/src/indirect-code/utils/tools";
import { partitionToolSegs } from "../web/src/indirect-code/utils/toolSegs";
import { isHeaderOnlySleep, toolSummary } from "../web/src/indirect-code/transcript";

function mkUnit(
  toolName: string,
  args: Record<string, unknown> = {},
  result?: { text?: string; details?: Record<string, unknown>; isError?: boolean; durationMs?: number },
): ToolUnit {
  return {
    id: `id_${toolName}`,
    call: {
      type: "tool_call",
      toolId: `id_${toolName}`,
      toolName,
      toolArgs: JSON.stringify(args),
    },
    ...(result
      ? {
          result: {
            type: "tool_result",
            toolId: `id_${toolName}`,
            toolResult: result.text ?? "",
            ...(result.details ? { toolDetails: result.details } : {}),
            ...(result.isError ? { isError: true } : {}),
            ...(result.durationMs !== undefined ? { toolDurationMs: result.durationMs } : {}),
          },
        }
      : {}),
  };
}

describe("Go daemon builtin tool catalog parity", () => {
  test("every tool Name() in indirect-code-daemon/packages/agent/tools is registered in DAEMON_BUILTIN_TOOLS", () => {
    const toolsDir = join(process.cwd(), "indirect-code-daemon", "packages", "agent", "tools");
    const goFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
    const discovered = new Set<string>();
    const nameMethodRe = /func\s*\([^)]+\)\s*Name\(\)\s*string\s*\{\s*return\s*"([^"]+)"\s*\}/g;

    for (const file of goFiles) {
      const src = readFileSync(join(toolsDir, file), "utf8");
      for (const m of src.matchAll(nameMethodRe)) {
        discovered.add(m[1]!);
      }
    }

    // Sanity check: ensure we actually parsed the Go tool implementations
    expect(discovered.size).toBeGreaterThanOrEqual(20);
    for (const goToolName of discovered) {
      expect(isDaemonBuiltinTool(goToolName)).toBe(true);
    }

    // Also ensure runtime/legacy aliases are recognized as builtins
    for (const alias of ["patch", "python", "bg_list", "bg_tail", "todowrite", "todoread"]) {
      expect(isDaemonBuiltinTool(alias)).toBe(true);
    }
    expect(isDaemonBuiltinTool("mcp__github__search")).toBe(false);
    expect(isDaemonBuiltinTool("custom_unknown_tool")).toBe(false);
  });
});

describe("specialTitle and groupTitle across all daemon builtins", () => {
  test("never emits generic 'call'/'calls' or '0 files' for any daemon builtin tool", () => {
    for (const name of DAEMON_BUILTIN_TOOLS) {
      const single = specialTitle([mkUnit(name)]);
      const double = specialTitle([mkUnit(name), mkUnit(name)]);

      expect(single).not.toMatch(/\bcalls?\b/i);
      expect(double).not.toMatch(/\bcalls?\b/i);
      expect(single).not.toMatch(/\b0 files?\b/i);
      expect(double).not.toMatch(/\b0 files?\b/i);
      expect(single).not.toBe("Tools");
      expect(double).not.toBe("Tools");
    }
  });

  test("formats explore combinations naturally without 0-file prefixes", () => {
    expect(specialTitle([mkUnit("glob")])).toBe("Explored 1 search");
    expect(specialTitle([mkUnit("search"), mkUnit("glob")])).toBe("Explored 2 searches");
    expect(specialTitle([mkUnit("inspect")])).toBe("Explored 1 directory");
    expect(specialTitle([mkUnit("inspect"), mkUnit("inspect")])).toBe("Explored 2 directories");
    expect(specialTitle([mkUnit("read"), mkUnit("read"), mkUnit("glob")])).toBe("Explored 2 files, 1 search");
    expect(specialTitle([mkUnit("read"), mkUnit("search"), mkUnit("inspect")])).toBe(
      "Explored 1 file, 1 search, 1 directory",
    );

    expect(groupTitle("explore", [mkUnit("inspect")])).toBe("Explored 1 directory");
    expect(groupTitle("explore", [mkUnit("glob"), mkUnit("inspect")])).toBe("Explored 1 search, 1 directory");
    expect(groupTitle("explore", [mkUnit("read"), mkUnit("read"), mkUnit("search"), mkUnit("inspect"), mkUnit("inspect")])).toBe(
      "Explored 2 files, 1 search, 2 directories",
    );
    expect(groupTitle("explore", [])).toBe("Explored workspace");
    expect(groupTitle("command", [mkUnit("bash")])).toBe("Ran 1 command");
    expect(groupTitle("command", [mkUnit("bash"), mkUnit("exec_script")])).toBe("Ran 2 commands");
  });

  test("summarizes task plans, skills, background jobs, widgets, MCP, and custom tools", () => {
    expect(specialTitle([mkUnit("todo")])).toBe("Updated task plan");
    expect(specialTitle([mkUnit("todowrite"), mkUnit("todowrite")])).toBe("Updated task plan");
    expect(specialTitle([mkUnit("todoread")])).toBe("Checked task plan");
    expect(specialTitle([mkUnit("todowrite"), mkUnit("todoread")])).toBe("Updated task plan · Checked task plan");

    expect(specialTitle([mkUnit("use_skill")])).toBe("Loaded 1 skill");
    expect(specialTitle([mkUnit("use_skill"), mkUnit("use_skill")])).toBe("Loaded 2 skills");

    expect(specialTitle([mkUnit("bg_check")])).toBe("Checked 1 job");
    expect(specialTitle([mkUnit("bg_list"), mkUnit("bg_tail")])).toBe("Checked 2 jobs");
    expect(specialTitle([mkUnit("bg_cancel")])).toBe("Stopped 1 job");
    expect(specialTitle([mkUnit("bg_cancel"), mkUnit("bg_cancel")])).toBe("Stopped 2 jobs");

    expect(specialTitle([mkUnit("widget_set")])).toBe("Updated 1 widget");
    expect(specialTitle([mkUnit("widget_set"), mkUnit("widget_edit")])).toBe("Updated 2 widgets");
    expect(specialTitle([mkUnit("widget_lint")])).toBe("Linted 1 widget");
    expect(specialTitle([mkUnit("widget_lint"), mkUnit("widget_lint")])).toBe("Linted 2 widgets");
    expect(specialTitle([mkUnit("widget_read")])).toBe("Inspected 1 widget");
    expect(specialTitle([mkUnit("widget_read"), mkUnit("widget_list")])).toBe("Inspected 2 widgets");

    expect(specialTitle([mkUnit("summary")])).toBe("Recorded 1 summary");
    expect(specialTitle([mkUnit("summary"), mkUnit("summary")])).toBe("Recorded 2 summaries");
    expect(specialTitle([mkUnit("finish_entire_request")])).toBe("Completed response");

    expect(specialTitle([mkUnit("mcp__linear__list_issues")])).toBe("Used 1 MCP tool");
    expect(specialTitle([mkUnit("mcp__linear__list_issues"), mkUnit("mcp__github__pr")])).toBe("Used 2 MCP tools");

    // Unknown non-MCP tools still use generic call(s)
    expect(specialTitle([mkUnit("fetch_url"), mkUnit("mystery")])).toBe("Checked 1 page · 1 call");
    expect(specialTitle([mkUnit("mystery_a"), mkUnit("mystery_b")])).toBe("2 calls");
  });

  test("preserves partitionToolSegs grouping contract for explore and command categories", () => {
    expect(toolCatOf("inspect")).toBe("explore");
    expect(toolCatOf("exec_script")).toBe("command");
    expect(toolCatOf("patch")).toBe("edit");
    expect(toolCatOf("widget_set")).toBe("other");
    expect(toolCatOf("use_skill")).toBe("other");

    const segs = partitionToolSegs([
      mkUnit("inspect"),
      mkUnit("read"),
      mkUnit("use_skill"),
      mkUnit("widget_set"),
      mkUnit("bash"),
      mkUnit("exec_script"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["group", "unit", "unit", "group"]);
    expect(isHeaderOnlySleep("bg_await", false)).toBe(true);
    expect(isHeaderOnlySleep("bg_await", true)).toBe(true);
    expect(isHeaderOnlySleep("bg_tail", true)).toBe(false);
  });
});

describe("toolSummary across every daemon builtin tool", () => {
  test("never falls back to generic lucide:wrench icon for any daemon builtin", () => {
    for (const name of DAEMON_BUILTIN_TOOLS) {
      const sum = toolSummary(mkUnit(name, {}, { text: "ok" }));
      expect(sum.icon).not.toBe("lucide:wrench");
      expect(sum.verb.length).toBeGreaterThan(0);
    }
  });

  test("formats use_skill row headers with skill name and turn scope", () => {
    expect(toolSummary(mkUnit("use_skill", { name: "generative_ui" }))).toEqual({
      icon: "lucide:sparkles",
      verb: "Loading skill",
      target: "generative_ui",
      stat: undefined,
    });
    expect(
      toolSummary(
        mkUnit("use_skill", { name: "generative_ui_talk", once: true }, { text: "<skill id=\"generative_ui_talk\" loaded and active>" }),
      ),
    ).toEqual({
      icon: "lucide:sparkles",
      verb: "Loaded skill",
      target: "generative_ui_talk",
      stat: "this turn",
    });
  });

  test("formats todo, todowrite, and todoread with active task and completion progress", () => {
    const items = [
      { id: "1", text: "Audit Go tools", status: "completed" },
      { id: "2", text: "Update specialTitle", status: "completed" },
      { id: "3", text: "Render widget bodies", status: "in_progress" },
      { id: "4", text: "Run typecheck", status: "pending" },
    ];
    expect(toolSummary(mkUnit("todowrite", { items }, { text: JSON.stringify(items), details: { items, done: 2, total: 4 } }))).toEqual({
      icon: "lucide:list-todo",
      verb: "Updated plan",
      target: "Render widget bodies",
      stat: "2/4 done",
    });
    expect(toolSummary(mkUnit("todo", { items: items.map((i) => ({ ...i, status: "completed" })) }, { text: "[]" }))).toEqual({
      icon: "lucide:list-todo",
      verb: "Updated plan",
      target: "All tasks completed",
      stat: "4/4 done",
    });
    expect(toolSummary(mkUnit("todoread", {}, { text: JSON.stringify(items) }))).toEqual({
      icon: "lucide:list-checks",
      verb: "Checked plan",
      target: "Render widget bodies",
      stat: "2/4 done",
    });

    // Supports { todos: [{ content, status }] } alias shape too
    const legacyTodos = extractTodoItems({ todos: [{ content: "Verify UI", status: "in_progress" }] });
    expect(legacyTodos).toEqual([{ id: "1", text: "Verify UI", status: "in_progress" }]);
  });

  test("formats bg_list, bg_tail, bg_check, bg_await, and bg_cancel cleanly", () => {
    expect(
      toolSummary(
        mkUnit("bg_list", {}, { text: "background jobs (2 jobs)\n[running] bg_1 — npm run dev\n[done] bg_2 — bun test" }),
      ),
    ).toEqual({
      icon: "lucide:layers",
      verb: "Checked",
      target: "Background jobs",
      stat: "2 jobs",
    });
    expect(toolSummary(mkUnit("bg_list", {}, { text: "(none)" }))).toEqual({
      icon: "lucide:layers",
      verb: "Checked",
      target: "Background jobs",
      stat: "0 jobs",
    });
    expect(
      toolSummary(
        mkUnit(
          "bg_tail",
          { job_id: "1a2b3c4d5e6f7a8b_9f8e7d6c5b4a3210" },
          { text: "1:ready\n2:listening", details: { env: { kind: "bash", status: "running", page: "1-2/2" } } },
        ),
      ),
    ).toEqual({
      icon: "lucide:terminal",
      verb: "Tailed",
      target: "1a2b3c4d…4a3210#L1-2",
      stat: "running",
    });
    expect(
      toolSummary(
        mkUnit("bg_check", { job_id: "bg_js" }, { text: "1:42", details: { env: { kind: "exec_script", page: "1-1/1" } } }),
      ),
    ).toEqual({
      icon: "mdi:language-javascript",
      verb: "Read",
      target: "Background Task#L1-1",
    });
    expect(toolSummary(mkUnit("bg_await", { max_wait_seconds: 30, reason: "waiting for server" }, { durationMs: 12000 }))).toEqual({
      icon: "lucide:timer",
      verb: "Waited",
      target: "12s",
    });
    expect(toolSummary(mkUnit("bg_cancel", { job_id: "bg_1" }, { text: "cancelled" }))).toEqual({
      icon: "lucide:terminal",
      verb: "Canceled",
      target: "Terminal Background Task",
    });
  });

  test("formats widget_set, widget_edit, widget_read, widget_lint, and widget_list with ids, src_file, and +N -M stats", () => {
    expect(resolveWidgetId({ widget_id: "revenue-chart" })).toBe("revenue-chart");

    // widget_set with content
    expect(
      toolSummary(
        mkUnit(
          "widget_set",
          { id: "revenue-chart", content: "export default function App() {\n  return <div />;\n}" },
          { text: "LINT OK: revenue-chart (14ms)", details: { id: "revenue-chart", total_lines: 3, lint_ok: true } },
        ),
      ),
    ).toEqual({
      icon: "lucide:layout-template",
      verb: "Saved widget",
      target: "revenue-chart",
      stat: "3 lines",
    });

    // widget_set importing src_file
    expect(
      toolSummary(
        mkUnit(
          "widget_set",
          { widget_id: "metrics-card", src_file: "web/widgets/MetricsCard.tsx" },
          { text: "LINT OK: metrics-card (19ms)", details: { id: "metrics-card", total_lines: 48, lint_ok: true } },
        ),
      ),
    ).toEqual({
      icon: "lucide:layout-template",
      verb: "Imported widget",
      target: "metrics-card ← MetricsCard.tsx",
      stat: "48 lines",
    });

    // widget_set lint failure
    expect(
      toolSummary(
        mkUnit(
          "widget_set",
          { id: "broken-widget", content: "export default () => <div" },
          { text: "[compile] line 1: Unexpected token\nLINT FAILED: broken-widget (1 error(s))", details: { lint_ok: false } },
        ),
      ),
    ).toEqual({
      icon: "lucide:shield-alert",
      verb: "Saved widget",
      target: "broken-widget",
      stat: "lint failed",
    });

    // widget_set delete
    expect(
      toolSummary(mkUnit("widget_set", { id: "old-widget", delete: true }, { details: { deleted: true } })),
    ).toEqual({
      icon: "lucide:trash-2",
      verb: "Deleted widget",
      target: "old-widget",
    });

    // widget_edit with daemon display diff -> +N -M stats
    expect(
      toolSummary(
        mkUnit(
          "widget_edit",
          { id: "revenue-chart", edits: [{ old_text: "const a = 1;", new_text: "const a = 2;\nconst b = 3;" }] },
          { details: { display: "APPLIED\n✓ revenue-chart\n1:-const a = 1;\n1:+const a = 2;\n2:+const b = 3;\n" } },
        ),
      ),
    ).toEqual({
      icon: "lucide:file-diff",
      verb: "Edited widget",
      target: "revenue-chart",
      statAdd: 2,
      statDel: 1,
    });

    // widget_edit before result arrives still computes +N -M from args.edits
    expect(
      toolSummary(
        mkUnit("widget_edit", {
          widget_id: "revenue-chart",
          edits: [{ old_text: "line1\noldLine\nline3", new_text: "line1\nnewLineA\nnewLineB\nline3" }],
        }),
      ),
    ).toEqual({
      icon: "lucide:file-diff",
      verb: "Editing widget",
      target: "revenue-chart",
      statAdd: 2,
      statDel: 1,
    });

    // widget_read with line range
    expect(
      toolSummary(mkUnit("widget_read", { id: "revenue-chart", offset: 10, limit: 25 }, { text: "x\ny" })),
    ).toEqual({
      icon: "lucide:code-2",
      verb: "Read widget",
      target: "revenue-chart#L10-34",
    });

    // widget_lint pass & fail
    expect(
      toolSummary(
        mkUnit(
          "widget_lint",
          { id: "revenue-chart" },
          { text: "LINT OK: revenue-chart (22ms)", details: { lint_ok: true, lint: { ok: true, durationMs: 22 } } },
        ),
      ),
    ).toEqual({
      icon: "lucide:shield-check",
      verb: "Linted widget",
      target: "revenue-chart",
      stat: "22ms",
    });
    expect(
      toolSummary(
        mkUnit(
          "widget_lint",
          { id: "revenue-chart" },
          {
            text: "[audit] forbidden global\n[render] crash\nLINT FAILED: revenue-chart (2 error(s))",
            details: { lint_ok: false, lint: { ok: false, errors: [{ phase: "audit", message: "a" }, { phase: "render", message: "b" }] } },
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:shield-alert",
      verb: "Lint failed",
      target: "revenue-chart",
      stat: "2 errors",
    });

    // widget_list
    expect(
      toolSummary(
        mkUnit("widget_list", {}, { text: "widgets (2 entries)\n  a (1 kB, 10 lines)\n  b (2 kB, 20 lines)\n", details: { total: 2 } }),
      ),
    ).toEqual({
      icon: "lucide:layout-grid",
      verb: "Listed",
      target: "widgets",
      stat: "2 widgets",
    });
  });

  test("formats summary and finish_entire_request without exposing private for_me notes", () => {
    const sum = toolSummary(
      mkUnit(
        "summary",
        { for_user: "Finished auditing daemon builtins", for_me: "SECRET_INTERNAL_MEMORY_DO_NOT_SHOW" },
        { text: "ok" },
      ),
    );
    expect(sum).toEqual({
      icon: "lucide:milestone",
      verb: "Summary",
      target: "Finished auditing daemon builtins",
    });
    expect(JSON.stringify(sum)).not.toContain("SECRET_INTERNAL_MEMORY_DO_NOT_SHOW");

    expect(
      toolSummary(mkUnit("finish_entire_request", { final_message_to_user: "All checks green." }, { text: "ok" })),
    ).toEqual({
      icon: "lucide:check-circle-2",
      verb: "Completed",
      target: "All checks green.",
    });
  });
});
