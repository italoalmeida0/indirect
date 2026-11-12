import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { readFile } from "fs/promises";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import { createRoot } from "solid-js";
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
import { synthesizeEditSectionsFromArgs } from "../web/src/indirect-code/utils/toolEdits";
import { useToolUnitModel } from "../web/src/indirect-code/components/tool/toolUnitModel";
import { isHeaderOnlySleep, toolSummary } from "../web/src/indirect-code/transcript";

/** Strip `//` and `/* ... *\/` comments while keeping string/template literals intact. */
function stripJsComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = source[i]!;
        out += c;
        i++;
        if (c === "\\" && i < n) {
          out += source[i]!;
          i++;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Extract balanced `{...}` expressions from `<Show when={...}>` tags (handles `=>` and nested braces). */
function extractShowWhenExpressions(cleanSrc: string): string[] {
  const results: string[] = [];
  const tagStartRe = /<Show\b[^>]*?\bwhen=\{/g;
  let m: RegExpExecArray | null;
  while ((m = tagStartRe.exec(cleanSrc)) !== null) {
    let idx = m.index + m[0].length;
    let depth = 1;
    let expr = "";
    while (idx < cleanSrc.length && depth > 0) {
      const ch = cleanSrc[idx]!;
      if (ch === "'" || ch === '"' || ch === "`") {
        const quote = ch;
        expr += ch;
        idx++;
        while (idx < cleanSrc.length) {
          const c = cleanSrc[idx]!;
          expr += c;
          idx++;
          if (c === "\\" && idx < cleanSrc.length) {
            expr += cleanSrc[idx]!;
            idx++;
            continue;
          }
          if (c === quote) break;
        }
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      expr += ch;
      idx++;
    }
    results.push(expr.trim());
  }
  return results;
}

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

  test("every daemon builtin tool is either header-only or explicitly handled in a mounted Tool*Bodies.tsx without state-gated top-level guards or null active fallbacks", () => {
    const toolCompDir = join(process.cwd(), "web", "src", "indirect-code", "components", "tool");
    const toolBodySrc = stripJsComments(readFileSync(join(toolCompDir, "ToolBody.tsx"), "utf8"));
    const bodyFiles = readdirSync(toolCompDir).filter((f) => /^Tool.+Bodies\.tsx$/.test(f));
    expect(bodyFiles.length).toBeGreaterThanOrEqual(5);

    // Sanity-check comment stripping + balanced-brace `<Show when={...}>` extraction
    const sample = stripJsComments(
      `// <Show when={props.m.name() === "ghost_comment"}>\n/* <Show when={toolName() === "block_comment"}> */\n<Show when={["a"].some((x) => x === "a") && props.m.name() === "real_tool"}>`,
    );
    const sampleExprs = extractShowWhenExpressions(sample);
    expect(sampleExprs).toEqual([`["a"].some((x) => x === "a") && props.m.name() === "real_tool"`]);

    const handledInBodies = new Set<string>();
    const toolMatchRe = /(?:props\.m\.name\(\)|toolName\(\))\s*===\s*"([a-z0-9_]+)"/g;
    // Top-level tool dispatch `<Show when={...}>` must not exclude running/pending/result states.
    const stateRestrictionRe = /\b(?:props\.m\.running\(\)|props\.running|props\.active|props\.u\.result)\b/;
    // Forbid `{props.active ? "..." : null}` blank fallbacks when a call stops without result.
    const activeNullFallbackRe = /props\.(?:active|running|m\.running\(\))\s*\?[^:{}]+:\s*null\b/;

    for (const file of bodyFiles) {
      const compName = file.replace(/\.tsx$/, "");
      expect(toolBodySrc).toContain(`<${compName}`);
      const cleanSrc = stripJsComments(readFileSync(join(toolCompDir, file), "utf8"));
      expect(activeNullFallbackRe.test(cleanSrc)).toBe(false);

      for (const cond of extractShowWhenExpressions(cleanSrc)) {
        const matchedTools = [...cond.matchAll(toolMatchRe)].map((m) => m[1]!);
        if (matchedTools.length > 0) {
          if (stateRestrictionRe.test(cond)) {
            throw new Error(
              `${file}: top-level tool <Show when={${cond}}> restricts lifecycle state; dispatch by tool name only and render all states inside`,
            );
          }
          for (const t of matchedTools) handledInBodies.add(t);
        }
      }
    }

    for (const builtinName of DAEMON_BUILTIN_TOOLS) {
      const covered = isHeaderOnlySleep(builtinName, true) || handledInBodies.has(builtinName);
      if (!covered) {
        throw new Error(
          `Daemon builtin "${builtinName}" is not header-only and has no <Show when={...}> handler in any Tool*Bodies.tsx`,
        );
      }
      expect(covered).toBe(true);
    }
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
    expect(groupTitle("explore", [mkUnit("read"), mkUnit("read"), mkUnit("session_history")])).toBe(
      "Explored 2 files, 1 history lookup",
    );
    expect(groupTitle("explore", [mkUnit("session_history"), mkUnit("session_history")])).toBe(
      "Explored 2 history lookups",
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
    expect(specialTitle([mkUnit("session_history")])).toBe("Searched 1 history query");
    expect(specialTitle([mkUnit("session_history"), mkUnit("session_history")])).toBe("Searched 2 history queries");
    expect(specialTitle([mkUnit("explore")])).toBe("Delegated 1 investigation");
    expect(specialTitle([mkUnit("explore"), mkUnit("explore")])).toBe("Delegated 2 investigations");

    expect(specialTitle([mkUnit("mcp__linear__list_issues")])).toBe("Used 1 MCP tool");
    expect(specialTitle([mkUnit("mcp__linear__list_issues"), mkUnit("mcp__github__pr")])).toBe("Used 2 MCP tools");

    // Unknown non-MCP tools still use generic call(s)
    expect(specialTitle([mkUnit("fetch_url"), mkUnit("mystery")])).toBe("Checked 1 page · 1 call");
    expect(specialTitle([mkUnit("mystery_a"), mkUnit("mystery_b")])).toBe("2 calls");
  });

  test("preserves partitionToolSegs grouping contract for explore and command categories", () => {
    expect(toolCatOf("inspect")).toBe("explore");
    expect(toolCatOf("session_history")).toBe("explore");
    expect(toolCatOf("explore")).toBe("other");
    expect(toolCatOf("exec_script")).toBe("command");
    expect(toolCatOf("patch")).toBe("edit");
    expect(toolCatOf("widget_set")).toBe("other");
    expect(toolCatOf("use_skill")).toBe("other");

    const segs = partitionToolSegs([
      mkUnit("inspect"),
      mkUnit("read"),
      mkUnit("session_history"),
      mkUnit("explore"),
      mkUnit("use_skill"),
      mkUnit("widget_set"),
      mkUnit("bash"),
      mkUnit("exec_script"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["group", "unit", "unit", "unit", "group"]);
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

  test("formats session_history (search & recall) and explore with rich stats across live and reloaded payloads", () => {
    // Pending search
    expect(toolSummary(mkUnit("session_history", { action: "search", query: "FoldBlock retire" }))).toEqual({
      icon: "lucide:history",
      verb: "Searching history",
      target: "FoldBlock retire",
    });

    // Completed search (live details)
    expect(
      toolSummary(
        mkUnit(
          "session_history",
          { action: "search", query: "FoldBlock" },
          {
            text: 'Found 3 match(es) for "FoldBlock":\n1. [block b1 · tier 1 · msgs #0-#12] (score 4.12)\n   FoldBlock summary',
            details: { action: "search", query: "FoldBlock", hits: [{}, {}, {}], indexed: 42 },
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:history",
      verb: "Searched history",
      target: "FoldBlock",
      stat: "3 matches",
    });

    // Pending & completed recall
    expect(toolSummary(mkUnit("session_history", { action: "recall", block_id: "b2", start_msg: 4, end_msg: 9 }))).toEqual({
      icon: "lucide:history",
      verb: "Recalling history",
      target: "era b2 (msgs #4–#9)",
    });

    expect(
      toolSummary(
        mkUnit(
          "session_history",
          { action: "recall", block_id: "b2", start_msg: 4, end_msg: 9 },
          {
            text: "=== [msg #4 · user · block b2] ===\nhello\n\n[... recall paginated: offset_chars=0, next_offset=4000, total_chars=9800, truncated=true]",
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:history",
      verb: "Recalled history",
      target: "era b2 (msgs #4–#9)",
      stat: "paginated",
    });

    expect(
      toolSummary(
        mkUnit(
          "session_history",
          { action: "recall", start_msg: 12 },
          {
            text: "=== [msg #12 · assistant · block b3] ===\ndone",
            details: { env: { action: "recall", start_msg: "12", end_msg: "12", total_chars: "1450" } },
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:history",
      verb: "Recalled history",
      target: "msg #12",
      stat: "1.5k chars",
    });

    // Explore pending and completed
    expect(toolSummary(mkUnit("explore", { task: "Map session actor mailbox invariants" }))).toEqual({
      icon: "lucide:compass",
      verb: "Exploring",
      target: "Map session actor mailbox invariants",
    });

    expect(
      toolSummary(
        mkUnit(
          "explore",
          { task: "Map session actor mailbox invariants" },
          {
            text: "### Findings\nAll actors isolate state cleanly.",
            details: { turns: 4, tool_calls: 11 },
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:compass",
      verb: "Explored",
      target: "Map session actor mailbox invariants",
      stat: "4 turns · 11 calls",
    });
  });
});

describe("WAL post-reload durability helpers (edit synthesis & fetchDetails)", () => {
  test("synthesizeEditSectionsFromArgs reconstructs FileEditSection diffs across array, JSON-string, object, and top-level arg shapes", () => {
    const fromArray = synthesizeEditSectionsFromArgs(
      {
        path: "src/service.ts",
        edits: [{ old_text: "const RETRIES = 2;", new_text: "const RETRIES = 4;" }],
      },
      "src/service.ts",
      "applied",
    );
    expect(fromArray).toHaveLength(1);
    expect(fromArray[0]?.file).toBe("src/service.ts");
    expect(fromArray[0]?.status).toBe("applied");
    expect(fromArray[0]?.diff).toContain("-const RETRIES = 2;");
    expect(fromArray[0]?.diff).toContain("+const RETRIES = 4;");

    const fromJsonString = synthesizeEditSectionsFromArgs(
      {
        path: "src/config.ts",
        edits: JSON.stringify([{ old_string: "timeout: 1000", new_string: "timeout: 5000" }]),
      },
      "src/config.ts",
      "dry_run",
    );
    expect(fromJsonString).toHaveLength(1);
    expect(fromJsonString[0]?.status).toBe("dry_run");
    expect(fromJsonString[0]?.diff).toContain("-timeout: 1000");
    expect(fromJsonString[0]?.diff).toContain("+timeout: 5000");

    const fromTopLevel = synthesizeEditSectionsFromArgs(
      {
        file_path: "src/index.ts",
        old_string: "foo()",
        new_string: "bar()",
      },
      "src/index.ts",
      "applied",
    );
    expect(fromTopLevel).toHaveLength(1);
    expect(fromTopLevel[0]?.diff).toContain("-foo()");
    expect(fromTopLevel[0]?.diff).toContain("+bar()");
  });

  test("useToolUnitModel.fetchDetails reconstructs url, host, title, content, and truncated from persisted WAL <tool_result> without transient toolDetails", () => {
    const walResult = `<tool_result type="ok" info="Fetched https://docs.example.com/architecture (52 chars, truncated)" url="https://docs.example.com/architecture" chars="52" truncated="true"># Architecture Guide\nSingle scroll surface contract.</tool_result>`;
    const unit = mkUnit("fetch_url", { url: "https://docs.example.com/architecture" }, { text: walResult });

    const details = createRoot((dispose) => {
      const ctx: any = {
        toolProgress: () => ({}),
        toolTick: () => 0,
        cancelBgJob: () => {},
        openFile: () => {},
      };
      const m = useToolUnitModel(ctx, "msg_wal", unit, 0, () => false, () => false);
      const fd = m.fetchDetails();
      dispose();
      return fd;
    });

    expect(details).toBeDefined();
    expect(details?.url).toBe("https://docs.example.com/architecture");
    expect(details?.host).toBe("docs.example.com");
    expect(details?.title).toBe("Architecture Guide");
    expect(details?.truncated).toBe(true);
    expect(details?.content).toContain("# Architecture Guide");
    expect(details?.content).toContain("Single scroll surface contract.");
  });
});

describe("SSR <ToolBody> state-matrix across all non-header-only builtins + MCP", () => {
  const LINE_PREFIX_NOTICE =
    "[Note: Line numbers (N:) are display prefixes, not file content. Copy text after the colon for edits; never include prefixes in file writes.]";

  let renderToolBodySsr!: (
    u: ToolUnit,
    opts: { running: boolean; active: boolean; progress?: Record<string, string> },
  ) => string;

  beforeAll(async () => {
    const toolDir = join(process.cwd(), "web", "src", "indirect-code", "components", "tool");
    const virtualEntryPath = join(toolDir, "__ssr_test_entry__.tsx");

    const buildRes = await Bun.build({
      entrypoints: [virtualEntryPath],
      target: "bun",
      format: "esm",
      external: ["solid-js", "solid-js/web", "highlight.js", "katex"],
      plugins: [
        {
          name: "tool-body-ssr-test-plugin",
          setup(build) {
            build.onResolve({ filter: /__ssr_test_entry__\.tsx$/ }, () => ({
              path: virtualEntryPath,
            }));
            build.onLoad({ filter: /__ssr_test_entry__\.tsx$/ }, async () => {
              const entryCode = `
                import { renderToString } from "solid-js/web";
                import { ToolBody } from "./ToolBody";
                import { useToolUnitModel } from "./toolUnitModel";

                export function renderToolBodySsr(u, opts) {
                  const ctx = {
                    toolProgress: () => opts.progress ?? {},
                    toolTick: () => 0,
                    pendingApproval: () => null,
                    pendingQuestion: () => null,
                    cancelBgJob: () => {},
                    openFile: () => {},
                  };
                  return renderToString(() => {
                    const m = useToolUnitModel(ctx, "msg_ssr", u, 0, () => opts.running, () => opts.active);
                    return <ToolBody ctx={ctx} u={u} m={m} running={opts.running} active={opts.active} />;
                  });
                }
              `;
              const transformed = await transformAsync(entryCode, {
                filename: virtualEntryPath,
                presets: [[solidPreset, { generate: "ssr", hydratable: false }]],
                babelrc: false,
                configFile: false,
              });
              return { contents: transformed?.code ?? entryCode, loader: "js" };
            });

            build.onResolve({ filter: /^virtual:icons$/ }, () => ({
              path: "virtual:icons",
              namespace: "virtual-icons",
            }));
            build.onLoad({ filter: /.*/, namespace: "virtual-icons" }, () => ({
              contents: "export const registry = {}; export const icons = {};",
              loader: "js",
            }));

            build.onLoad({ filter: /\.css$/ }, () => ({
              contents: "",
              loader: "js",
            }));

            build.onLoad({ filter: /TarnavMarkdown\.tsx$/ }, async (args) => {
              const ssrStub = `
                export function TarnavMarkdown(props: { children: string; noNestedScroll?: boolean }) {
                  return (
                    <div data-ssr-markdown={props.noNestedScroll ? "no-nested-scroll" : "default"}>
                      {props.children}
                    </div>
                  );
                }
              `;
              const out = await transformAsync(ssrStub, {
                filename: args.path,
                presets: [
                  [solidPreset, { generate: "ssr", hydratable: false }],
                  [tsPreset, { isTSX: true, allExtensions: true }],
                ],
                babelrc: false,
                configFile: false,
              });
              return { contents: out?.code ?? ssrStub, loader: "js" };
            });

            build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
              if (args.path.endsWith("__ssr_test_entry__.tsx") || args.path.endsWith("TarnavMarkdown.tsx")) {
                return undefined;
              }
              const code = await readFile(args.path, "utf8");
              const isTs = args.path.endsWith(".tsx") || args.path.endsWith(".ts");
              const out = await transformAsync(code, {
                filename: args.path,
                presets: [
                  [solidPreset, { generate: "ssr", hydratable: false }],
                  ...(isTs ? [[tsPreset, { isTSX: true, allExtensions: true }]] : []),
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
      throw new Error(`Failed to bundle SSR ToolBody test harness: ${JSON.stringify(buildRes.logs)}`);
    }
    const jsText = await buildRes.outputs[0]!.text();
    const mod = await import(`data:text/javascript;base64,${Buffer.from(jsText, "utf8").toString("base64")}`);
    renderToolBodySsr = mod.renderToolBodySsr;
  });

  function stripHtmlVisibleText(html: string): string {
    // Strip footer block first so `<ToolFooter>` cannot mask an empty tool body!
    const withoutFooter = html.replace(/<div[^>]*data-tool-footer[^>]*>[\s\S]*?<\/div>/g, "");
    return withoutFooter
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function defaultArgsFor(tool: string): Record<string, unknown> {
    switch (tool) {
      case "bash":
        return { command: "true" };
      case "exec_script":
      case "python":
        return { script: "const x = 1;" };
      case "read":
        return { path: "empty.txt" };
      case "write":
        return { path: "empty.txt", content: "" };
      case "edit":
      case "patch":
        return { path: "src/app.ts", edits: [] };
      case "glob":
        return { pattern: "**/*.nonexistent" };
      case "search":
        return { pattern: "NONEXISTENT_SYMBOL" };
      case "inspect":
        return { path: "empty-dir" };
      case "search_web":
        return { query: "obscure query" };
      case "fetch_url":
        return { url: "https://docs.example.com/empty" };
      case "bg_check":
      case "bg_tail":
      case "bg_cancel":
        return { job_id: "1a2b3c4d5e6f7a8b_0000111122223333" };
      case "question":
        return { questions: [] };
      case "summary":
        return { for_user: "", for_me: "private" };
      case "finish_entire_request":
        return { final_message_to_user: "" };
      case "session_history":
        return { action: "search", query: "missing_term" };
      case "explore":
        return { task: "Check empty module" };
      case "use_skill":
        return { name: "generative_ui" };
      case "widget_set":
        return { id: "demo-widget", content: "" };
      case "widget_read":
      case "widget_lint":
        return { id: "demo-widget" };
      case "widget_edit":
        return { id: "demo-widget", edits: [] };
      default:
        return {};
    }
  }

  test("renders non-empty visible body content and zero empty <code class=\"tok\"> blocks across all 5 lifecycle states for every expandable builtin + MCP tool", () => {
    const expandableTools = [
      ...DAEMON_BUILTIN_TOOLS.filter((t) => !isHeaderOnlySleep(t, true)),
      "mcp__github__search_issues",
    ];
    expect(expandableTools.length).toBeGreaterThanOrEqual(31);

    for (const tool of expandableTools) {
      const args = defaultArgsFor(tool);

      // 1. Running active with zero output/progress yet
      const htmlRunning = renderToolBodySsr(mkUnit(tool, args), { running: true, active: true });
      const textRunning = stripHtmlVisibleText(htmlRunning);
      if (!textRunning) {
        throw new Error(`Tool "${tool}" rendered empty <ToolBody> in State A (running active empty): ${htmlRunning}`);
      }
      expect(htmlRunning).not.toMatch(/<code[^>]*class="tok"[^>]*>\s*<\/code>/);

      // 2. Stopped / cancelled without result (`!u.result && !props.active`)
      const htmlStopped = renderToolBodySsr(mkUnit(tool, args), { running: false, active: false });
      const textStopped = stripHtmlVisibleText(htmlStopped);
      if (!textStopped) {
        throw new Error(`Tool "${tool}" rendered empty <ToolBody> in State B (stopped without result): ${htmlStopped}`);
      }
      expect(htmlStopped).not.toMatch(/<code[^>]*class="tok"[^>]*>\s*<\/code>/);

      // 3. Completed 0-match / 0-byte / empty output LIVE (including LinePrefixNotice-only display for read/write/widget_read)
      const liveEmptyDetails =
        tool === "read" || tool === "write" || tool === "widget_read"
          ? { display: LINE_PREFIX_NOTICE, total_lines: 0 }
          : {};
      const htmlLiveEmpty = renderToolBodySsr(
        mkUnit(tool, args, { text: tool === "read" ? LINE_PREFIX_NOTICE : "", details: liveEmptyDetails }),
        { running: false, active: false },
      );
      const textLiveEmpty = stripHtmlVisibleText(htmlLiveEmpty);
      if (!textLiveEmpty) {
        throw new Error(`Tool "${tool}" rendered empty <ToolBody> in State C (completed 0-output live): ${htmlLiveEmpty}`);
      }
      expect(htmlLiveEmpty).not.toMatch(/<code[^>]*class="tok"[^>]*>\s*<\/code>/);

      // 4. Completed 0-match / 0-byte / empty output POST-RELOAD WAL (`<tool_result type="ok"></tool_result>` without toolDetails)
      const walBody = tool === "read" ? LINE_PREFIX_NOTICE : "";
      const htmlWalEmpty = renderToolBodySsr(
        mkUnit(tool, args, { text: `<tool_result type="ok">${walBody}</tool_result>` }),
        { running: false, active: false },
      );
      const textWalEmpty = stripHtmlVisibleText(htmlWalEmpty);
      if (!textWalEmpty) {
        throw new Error(`Tool "${tool}" rendered empty <ToolBody> in State D (completed 0-output WAL): ${htmlWalEmpty}`);
      }
      expect(htmlWalEmpty).not.toMatch(/<code[^>]*class="tok"[^>]*>\s*<\/code>/);

      // 5. Error (`isError: true`) with empty body
      const htmlError = renderToolBodySsr(
        mkUnit(tool, args, { text: `<tool_result type="error" error="Execution failed"></tool_result>`, isError: true }),
        { running: false, active: false },
      );
      const textError = stripHtmlVisibleText(htmlError);
      if (!textError) {
        throw new Error(`Tool "${tool}" rendered empty <ToolBody> in State E (isError empty body): ${htmlError}`);
      }
      expect(htmlError).not.toMatch(/<code[^>]*class="tok"[^>]*>\s*<\/code>/);
    }
  });

  test("bg_cancel renders live cancellation status while running, and post-reload edit + fetch_url + markdown tools preserve full fidelity", () => {
    // bg_cancel while running
    const bgRunningHtml = renderToolBodySsr(mkUnit("bg_cancel", { job_id: "job_123" }), {
      running: true,
      active: true,
    });
    expect(stripHtmlVisibleText(bgRunningHtml)).toContain("Canceling background task");

    // Post-reload WAL `edit`: empty `<tool_result>` body + `args.edits` -> renders diff, never "No changes"
    const editWalHtml = renderToolBodySsr(
      mkUnit(
        "edit",
        {
          path: "src/service.ts",
          edits: [{ old_text: "export const MAX_RETRIES = 2;", new_text: "export const MAX_RETRIES = 4;" }],
        },
        {
          text: `<tool_result type="ok" info="Successfully replaced 1 block(s) in src/service.ts." path="src/service.ts" edits="1"></tool_result>`,
        },
      ),
      { running: false, active: false },
    );
    expect(editWalHtml).toContain("src/service.ts");
    expect(editWalHtml).toContain("rc-diff-word-add");
    expect(editWalHtml.replace(/<[^>]+>/g, "")).toContain("export const MAX_RETRIES = 4;");
    expect(editWalHtml).not.toContain("No changes");

    // Failed `edit` (`isError: true`) -> renders error message, never "No changes" or false applied diff
    const editErrHtml = renderToolBodySsr(
      mkUnit(
        "edit",
        {
          path: "src/service.ts",
          edits: [{ old_text: "missing", new_text: "replacement" }],
        },
        {
          text: `<tool_result type="error" error="old_text not found in src/service.ts">old_text not found in src/service.ts</tool_result>`,
          isError: true,
        },
      ),
      { running: false, active: false },
    );
    expect(editErrHtml).toContain("old_text not found in src/service.ts");
    expect(editErrHtml).not.toContain("No changes");

    // Post-reload WAL `fetch_url` -> reconstructs host badge "D", host "docs.example.com", title, and noNestedScroll markdown
    const fetchWalHtml = renderToolBodySsr(
      mkUnit(
        "fetch_url",
        { url: "https://docs.example.com/guide" },
        {
          text: `<tool_result type="ok" info="Fetched https://docs.example.com/guide (44 chars)" url="https://docs.example.com/guide" chars="44"># System Guide\nClean body text</tool_result>`,
        },
      ),
      { running: false, active: false },
    );
    expect(fetchWalHtml).toContain("docs.example.com");
    expect(fetchWalHtml).toContain("System Guide");
    expect(fetchWalHtml).toContain(">D<");
    expect(fetchWalHtml).not.toContain(">?<");
    expect(fetchWalHtml).toContain('data-ssr-markdown="no-nested-scroll"');

    // `explore` also passes `noNestedScroll` to `<StreamingMarkdown>` and uses wrapped inner container
    const exploreWalHtml = renderToolBodySsr(
      mkUnit(
        "explore",
        { task: "Inspect architecture" },
        {
          text: `<tool_result type="ok" turns="2" tool_calls="3" duration="1.4s">### Findings\nAll good.</tool_result>`,
        },
      ),
      { running: false, active: false },
    );
    expect(exploreWalHtml).toContain('data-ssr-markdown="no-nested-scroll"');
    expect(exploreWalHtml).toContain("w-full min-w-0 max-w-full");
  });
});
