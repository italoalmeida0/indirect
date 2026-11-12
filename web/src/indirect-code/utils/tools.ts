import { displayToolArgs } from "../live";
import type { ToolCat } from "../types";

export function tryParseArgs(a?: string): any {
  return displayToolArgs(a);
}

/** Authoritative catalog of Go daemon builtin tool names and supported runtime/legacy aliases. */
export const DAEMON_BUILTIN_TOOLS = [
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "search",
  "inspect",
  "bash",
  "exec_script",
  "python",
  "search_web",
  "fetch_url",
  "bg_check",
  "bg_list",
  "bg_tail",
  "bg_await",
  "bg_cancel",
  "question",
  "todo",
  "todowrite",
  "todoread",
  "use_skill",
  "widget_set",
  "widget_list",
  "widget_lint",
  "widget_read",
  "widget_edit",
  "summary",
  "finish_entire_request",
  "session_history",
  "explore",
] as const;

const DAEMON_BUILTIN_SET: ReadonlySet<string> = new Set<string>(DAEMON_BUILTIN_TOOLS);

export function isDaemonBuiltinTool(name?: string): boolean {
  return Boolean(name && DAEMON_BUILTIN_SET.has(name));
}

interface NormalizedTodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

function normalizeTodoStatus(raw: unknown): "pending" | "in_progress" | "completed" {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "completed" || s === "done") return "completed";
  if (s === "in_progress" || s === "in-progress" || s === "active" || s === "running") return "in_progress";
  return "pending";
}

function normalizeTodoArray(arr: unknown[]): NormalizedTodoItem[] {
  const out: NormalizedTodoItem[] = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] as any;
    if (!it || typeof it !== "object") continue;
    const text = String(it.text ?? it.content ?? it.title ?? "").trim();
    if (!text) continue;
    const id = String(it.id ?? i + 1).trim() || String(i + 1);
    out.push({ id, text, status: normalizeTodoStatus(it.status) });
  }
  return out;
}

/** Extracts normalized checklist items from toolDetails, call args, or JSON result text. */
export function extractTodoItems(args: any, resText?: string, details?: any): NormalizedTodoItem[] {
  if (Array.isArray(details?.items)) {
    const items = normalizeTodoArray(details.items);
    if (items.length > 0 || details.items.length === 0) return items;
  }
  if (Array.isArray(args?.items)) {
    return normalizeTodoArray(args.items);
  }
  if (Array.isArray(args?.todos)) {
    return normalizeTodoArray(args.todos);
  }
  const trimmed = String(resText || "").trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normalizeTodoArray(parsed);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.items)) return normalizeTodoArray(parsed.items);
        if (Array.isArray(parsed.todos)) return normalizeTodoArray(parsed.todos);
      }
    } catch {
      // ignore non-JSON or partial stream text
    }
  }
  return [];
}

/** Resolves widget identifier across args (`id` or `widget_id`) and `toolDetails`. */
export function resolveWidgetId(args: any, details?: any): string {
  return String(args?.id || args?.widget_id || details?.id || details?.path || "").trim();
}

export function toolCatOf(name?: string): ToolCat {
  if (
    name === "read" ||
    name === "glob" ||
    name === "search" ||
    name === "inspect" ||
    name === "session_history"
  ) {
    return "explore";
  }
  if (name === "bash" || name === "exec_script" || name === "python") return "command";
  if (name === "edit" || name === "write" || name === "patch") return "edit";
  return "other";
}
