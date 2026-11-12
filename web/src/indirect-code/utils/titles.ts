import type { ToolUnit } from "../types";

export function groupTitle(cat: "explore" | "command", units: ToolUnit[]): string {
  if (cat === "command") {
    return `Ran ${units.length} command${units.length === 1 ? "" : "s"}`;
  }
  const files = units.filter((u) => u.call?.toolName === "read").length;
  const searches = units.filter((u) => u.call?.toolName === "glob" || u.call?.toolName === "search").length;
  const inspections = units.filter((u) => u.call?.toolName === "inspect").length;
  const history = units.filter((u) => u.call?.toolName === "session_history").length;
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (searches > 0) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  if (inspections > 0) parts.push(`${inspections} director${inspections === 1 ? "y" : "ies"}`);
  if (history > 0) parts.push(`${history} history ${history === 1 ? "lookup" : "lookups"}`);
  return parts.length > 0 ? `Explored ${parts.join(", ")}` : "Explored workspace";
}

/**
 * One-line activity summary for the turn aggregate card: counts per
 * activity (explored files, searches, directories, commands, edits, skills,
 * background jobs, task plans, widgets…) so a 20-call turn stays one readable
 * line and daemon builtins never degrade to generic "N calls".
 */
export function specialTitle(units: ToolUnit[], extra?: { texts?: number; thoughts?: number }): string {
  const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  const names = units.map((u) => u.call?.toolName || "");
  const count = (...ns: string[]) => names.filter((n) => ns.includes(n)).length;

  const files = count("read");
  const searches = count("glob", "search");
  const inspections = count("inspect");
  const commands = count("bash", "exec_script", "python", "bg_await");
  const edits = count("edit", "write", "patch");
  const questions = count("question");
  const web = count("fetch_url", "search_web");
  const bgChecks = count("bg_check", "bg_list", "bg_tail");
  const bgCancels = count("bg_cancel");
  const todoWrites = count("todo", "todowrite");
  const todoReads = count("todoread");
  const skills = count("use_skill");
  const widgetUpdates = count("widget_set", "widget_edit");
  const widgetLints = count("widget_lint");
  const widgetInspects = count("widget_read", "widget_list");
  const summaries = count("summary");
  const finishes = count("finish_entire_request");
  const historyLookups = count("session_history");
  const explorations = count("explore");
  const mcp = names.filter((n) => n.startsWith("mcp__")).length;

  const accounted =
    files +
    searches +
    inspections +
    commands +
    edits +
    questions +
    web +
    bgChecks +
    bgCancels +
    todoWrites +
    todoReads +
    skills +
    widgetUpdates +
    widgetLints +
    widgetInspects +
    summaries +
    finishes +
    historyLookups +
    explorations +
    mcp;
  const others = Math.max(0, units.length - accounted);

  const parts: string[] = [];
  const exploreParts: string[] = [];
  if (files > 0) exploreParts.push(plural(files, "file"));
  if (searches > 0) exploreParts.push(plural(searches, "search", "searches"));
  if (inspections > 0) exploreParts.push(plural(inspections, "directory", "directories"));
  if (exploreParts.length > 0) parts.push(`Explored ${exploreParts.join(", ")}`);

  if (commands > 0) parts.push(`Ran ${plural(commands, "command")}`);
  if (edits > 0) parts.push(`Made ${plural(edits, "edit")}`);
  if (questions > 0) parts.push(`Asked ${plural(questions, "question")}`);
  if (web > 0) parts.push(`Checked ${plural(web, "page")}`);
  if (bgChecks > 0) parts.push(`Checked ${plural(bgChecks, "job")}`);
  if (bgCancels > 0) parts.push(`Stopped ${plural(bgCancels, "job")}`);
  if (todoWrites > 0) parts.push("Updated task plan");
  if (todoReads > 0) parts.push("Checked task plan");
  if (skills > 0) parts.push(`Loaded ${plural(skills, "skill")}`);
  if (widgetUpdates > 0) parts.push(`Updated ${plural(widgetUpdates, "widget")}`);
  if (widgetLints > 0) parts.push(`Linted ${plural(widgetLints, "widget")}`);
  if (widgetInspects > 0) parts.push(`Inspected ${plural(widgetInspects, "widget")}`);
  if (summaries > 0) parts.push(`Recorded ${plural(summaries, "summary", "summaries")}`);
  if (finishes > 0) parts.push("Completed response");
  if (historyLookups > 0) parts.push(`Searched ${plural(historyLookups, "history query", "history queries")}`);
  if (explorations > 0) parts.push(`Delegated ${plural(explorations, "investigation")}`);
  if (mcp > 0) parts.push(`Used ${plural(mcp, "MCP tool")}`);
  if (others > 0) parts.push(plural(others, "call"));
  if ((extra?.texts || 0) > 0) parts.push(plural(extra!.texts!, "note"));
  if (parts.length === 0) return (extra?.thoughts || 0) > 0 ? "Thinking" : "Tools";
  return parts.join(" · ");
}
export function toolRowKey(msgId: string, u: ToolUnit, fallback: number) {
  return `${msgId}:${u.call?.toolId || u.result?.toolId || "u" + fallback}`;
}
