import { createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { hasFileIcon } from "../files";
import { FileIcon } from "../presentation";
import { extractTodoItems, tryParseArgs } from "../utils/tools";
import { formatDurationSecs } from "../utils/format";
import { useBackground } from "../ctx";
import type {
  AccessMode,
  ApprovalDecision,
  PendingApproval,
  PermissionCapability,
  PermissionRule,
} from "../types";
import { ShellCmd } from "./CodeBlock";

/** Tool call & runtime capability approval card (narrow props instead of the god-ctx). */
export interface ApprovalCardProps {
  pendingApproval: () => PendingApproval | null;
  convWidthClass: () => string;
  respondApproval: (decision: ApprovalDecision) => void;
  accessMode?: () => AccessMode;
}

interface ApprovalEditHunk {
  oldText: string;
  newText: string;
}

function normalizeApprovalEdits(args: Record<string, unknown>): ApprovalEditHunk[] {
  const raw = args.edits;
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
      else if (parsed && typeof parsed === "object") list = [parsed];
    } catch {
      // Ignore malformed JSON string
    }
  } else if (raw && typeof raw === "object") {
    list = [raw];
  } else {
    const topOld = args.old_text ?? args.old_string ?? args.old;
    const topNew = args.new_text ?? args.new_string ?? args.new;
    if (typeof topOld === "string" || typeof topNew === "string") {
      list = [{ old_text: topOld ?? "", new_text: topNew ?? "" }];
    }
  }

  const out: ApprovalEditHunk[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const rawOld = rec.old_text ?? rec.old_string ?? rec.old;
    const rawNew = rec.new_text ?? rec.new_string ?? rec.new;
    out.push({
      oldText: typeof rawOld === "string" ? rawOld.replace(/\r\n/g, "\n") : "",
      newText: typeof rawNew === "string" ? rawNew.replace(/\r\n/g, "\n") : "",
    });
  }
  return out;
}

function scalarText(val: unknown): string {
  if (typeof val === "string") return val.trim();
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  return "";
}

function resolveFallbackTarget(args: Record<string, unknown>): string {
  return (
    scalarText(args.url) ||
    scalarText(args.query) ||
    scalarText(args.path) ||
    scalarText(args.skill) ||
    scalarText(args.id) ||
    scalarText(args.widget_id) ||
    scalarText(args.pattern) ||
    scalarText(args.name)
  );
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  exec_script: "JavaScript",
  search_web: "Web search",
  web_search: "Web search",
  fetch_url: "Fetch URL",
  bg_await: "Wait",
  bg_cancel: "Stop task",
  use_skill: "Load skill",
};

const SHOWN_ARG_KEYS: Record<string, Set<string>> = {
  bash: new Set(["command", "description"]),
  exec_script: new Set(["code", "script", "work_dir", "env", "stdin", "legacy_lang"]),
  python: new Set(["code", "script", "work_dir", "env", "stdin", "legacy_lang"]),
  read: new Set(["path", "offset", "limit"]),
  write: new Set(["path", "content"]),
  edit: new Set(["path", "edits", "old_text", "new_text", "old_string", "new_string", "old", "new"]),
  glob: new Set(["pattern", "path"]),
  bg_await: new Set(["max_wait_seconds", "reason"]),
  bg_cancel: new Set(["job_id"]),
  todo: new Set(["items", "todos"]),
  todowrite: new Set(["items", "todos"]),
};

function displayToolName(tool: string): string {
  return TOOL_DISPLAY_NAMES[tool] ?? tool;
}

function hasUnshownArgs(
  name: string,
  rawArgs: Record<string, unknown>,
  rawStr: string | undefined,
  fallbackTarget: string,
): boolean {
  const keys = Object.keys(rawArgs);
  if (keys.length === 0) {
    return Boolean(rawStr?.trim() && rawStr.trim() !== "{}");
  }
  const shown = SHOWN_ARG_KEYS[name];
  if (shown) {
    return keys.some((k) => !shown.has(k));
  }
  if (fallbackTarget && keys.length === 1 && scalarText(rawArgs[keys[0]!]) === fallbackTarget) {
    return false;
  }
  return true;
}

function tipIfLong(text: string, min = 48): string | undefined {
  return text.length > min ? text : undefined;
}

function capabilityBadgeMeta(
  capability: PermissionCapability | undefined,
  reason: string | undefined,
): { label: string; icon: string } {
  const lowerReason = (reason || "").toLowerCase();
  switch (capability) {
    case "exec":
      return { label: "Command", icon: "lucide:terminal" };
    case "fs_read":
      if (
        lowerReason.includes("secret") ||
        lowerReason.includes("credential") ||
        lowerReason.includes("protected") ||
        lowerReason.includes(".env")
      ) {
        return { label: "Protected file", icon: "lucide:folder-lock" };
      }
      return { label: "Read outside workspace", icon: "lucide:folder-lock" };
    case "fs_write":
      return { label: "Write file", icon: "lucide:file-pen-line" };
    case "net":
      return { label: "Network access", icon: "lucide:globe" };
    case "tool":
      return { label: "Tool", icon: "lucide:wrench" };
    default:
      return { label: "Permission check", icon: "lucide:shield-alert" };
  }
}

function formatProposedRuleScope(rule: PermissionRule): string {
  const effect = rule.effect === "deny" ? "deny" : "allow";
  switch (rule.kind) {
    case "exec":
      return `Scope: ${effect} command "${rule.pattern}"`;
    case "net":
      return `Scope: ${effect} host "${rule.pattern}"`;
    case "fs_read":
      return `Scope: ${effect} read path "${rule.pattern}"`;
    case "fs_write":
      return `Scope: ${effect} path "${rule.pattern}"`;
    case "tool":
      return `Scope: ${effect} tool "${rule.pattern}"`;
  }
}

export function ApprovalCard(props: ApprovalCardProps) {
  const jobs = useBackground().sessionJobs;
  return (
    <Show when={props.pendingApproval()} keyed>
      {(pa) => {
        const [writeExpanded, setWriteExpanded] = createSignal(false);
        const [editsExpanded, setEditsExpanded] = createSignal(false);
        const rawArgs = (tryParseArgs(pa.args) ?? {}) as Record<string, unknown>;
        const name = pa.tool || "tool";
        const legacyLang =
          typeof rawArgs.legacy_lang === "string" ? rawArgs.legacy_lang.trim().toLowerCase() : "";
        const isUnsupportedLegacyPython =
          name === "python" ||
          (name === "exec_script" &&
            (legacyLang === "python" ||
              legacyLang === "python3" ||
              (!String(rawArgs.code || "").trim() && Boolean(String(rawArgs.script || "").trim()))));
        const editList = name === "edit" ? normalizeApprovalEdits(rawArgs) : [];
        const writeContent =
          name === "write" && rawArgs.content !== undefined && rawArgs.content !== null
            ? String(rawArgs.content).replace(/\r\n/g, "\n")
            : "";
        const writeLines = writeContent.length > 0 ? writeContent.split("\n") : [];
        const bashCmd = name === "bash" ? String(rawArgs.command || "").replace(/\r\n/g, "\n") : "";
        const bashDesc =
          name === "bash" && typeof rawArgs.description === "string"
            ? rawArgs.description.trim()
            : "";
        const envEntries =
          (name === "exec_script" || name === "python") &&
          rawArgs.env &&
          typeof rawArgs.env === "object" &&
          !Array.isArray(rawArgs.env)
            ? Object.entries(rawArgs.env as Record<string, unknown>)
            : [];
        const todoItems = name === "todo" || name === "todowrite" ? extractTodoItems(rawArgs) : [];
        const isDedicatedTool = [
          "bash",
          "exec_script",
          "python",
          "bg_await",
          "bg_cancel",
          "read",
          "write",
          "edit",
          "glob",
          "todo",
          "todowrite",
        ].includes(name);
        const fallbackTarget = !isDedicatedTool ? resolveFallbackTarget(rawArgs) : "";
        const toolLabel = displayToolName(name);
        const isMappedToolName = Boolean(TOOL_DISPLAY_NAMES[name]);
        const showRawArgs = hasUnshownArgs(name, rawArgs, pa.args, fallbackTarget);
        const formattedArgs = (() => {
          if (Object.keys(rawArgs).length > 0) {
            try {
              return JSON.stringify(rawArgs, null, 2);
            } catch {
              // Fall back to raw string
            }
          }
          return (pa.args || "").trim();
        })();
        const isHighRisk = pa.risk === "high";
        const effectiveAccess: "ask" | "auto" =
          pa.accessMode ?? (props.accessMode?.() === "auto" ? "auto" : "ask");
        const autoBadgeLabel = (() => {
          const lowerReason = (pa.reason || "").toLowerCase();
          if (
            (pa.capability === "fs_read" || pa.capability === "fs_write") &&
            !lowerReason.includes("secret") &&
            !lowerReason.includes("credential") &&
            !lowerReason.includes("protected") &&
            !lowerReason.includes(".env")
          ) {
            return "Auto · Outside workspace";
          }
          return "Auto";
        })();
        const headerIcon =
          isHighRisk
            ? "lucide:shield-alert"
            : pa.capability === "net"
              ? "lucide:globe"
              : pa.capability === "fs_read" || pa.capability === "fs_write"
                ? "lucide:folder-lock"
                : pa.capability === "exec"
                  ? "lucide:terminal"
                  : "lucide:shield-alert";
        const headerIconClass = isHighRisk
          ? "text-danger shrink-0"
          : pa.capability === "net"
            ? "text-accent shrink-0"
            : "text-warning shrink-0";
        const headerTitle = pa.capability ? "Review permission request" : "Review tool call";
        const hasCallout = Boolean(pa.capability || pa.target || pa.reason);
        const capMeta = capabilityBadgeMeta(pa.capability, pa.reason);
        const showAllowAlways =
          !isUnsupportedLegacyPython && (pa.canAllowAlways ?? Boolean(pa.proposedRule));
        const showAllowSession =
          !isUnsupportedLegacyPython && (pa.canAllowSession ?? Boolean(pa.proposedRule));
        const showScopedButtons = showAllowAlways || showAllowSession;
        const totalButtons =
          1 +
          (showAllowAlways ? 1 : 0) +
          (showAllowSession ? 1 : 0) +
          (!isUnsupportedLegacyPython ? 1 : 0);

        return (
          <section
            aria-label="Tool approval request"
            data-approval-card
            data-approval-risk={pa.risk || "default"}
            class={`w-full ${props.convWidthClass()} mx-auto py-1`}
          >
            <div class="rounded-panel border border-border bg-surface overflow-hidden">
              <div
                data-approval-header
                class="px-3 sm:px-3.5 py-2 sm:py-2.5 border-b border-border-subtle bg-surface-subtle flex flex-nowrap items-center gap-1.5 sm:gap-2 min-w-0"
              >
                <Iconify icon={headerIcon} size={14} class={headerIconClass} />
                <Show
                  when={Boolean(pa.capability)}
                  fallback={<span class="text-xs font-medium text-fg shrink-0">{headerTitle}</span>}
                >
                  <span class="text-xs font-medium text-fg shrink-0 sm:hidden">
                    Permission request
                  </span>
                  <span class="hidden sm:inline text-xs font-medium text-fg shrink-0">
                    {headerTitle}
                  </span>
                </Show>
                <span
                  class={`inline-flex items-center rounded-inner border border-border bg-surface px-1.5 py-0.5 text-2xs leading-tight text-fg-secondary min-w-0 max-w-28 sm:max-w-48 truncate ${
                    isMappedToolName ? "font-medium" : "font-mono"
                  }`}
                  data-rc-tip={isMappedToolName ? name : tipIfLong(name, 32)}
                >
                  {toolLabel}
                </span>
                <Show
                  when={isHighRisk}
                  fallback={
                    <Show
                      when={effectiveAccess === "auto"}
                      fallback={
                        <span
                          data-approval-badge="ask"
                          class="ml-auto inline-flex items-center gap-1.5 text-2xs text-fg-muted shrink-0 whitespace-nowrap"
                        >
                          <span class="h-1.5 w-1.5 rounded-full bg-warning shrink-0" aria-hidden="true" />
                          <span class="sm:hidden">Ask</span>
                          <span class="hidden sm:inline">Ask for approval</span>
                        </span>
                      }
                    >
                      <span
                        data-approval-badge="auto"
                        class="ml-auto inline-flex items-center gap-1.5 rounded-inner border border-accent/25 bg-accent-subtle px-2 py-0.5 text-2xs font-medium text-accent shrink-0 whitespace-nowrap"
                      >
                        <span class="h-1.5 w-1.5 rounded-full bg-accent shrink-0" aria-hidden="true" />
                        <span class="sm:hidden">Auto</span>
                        <span class="hidden sm:inline">{autoBadgeLabel}</span>
                      </span>
                    </Show>
                  }
                >
                  <span
                    data-approval-badge="high-risk"
                    class="ml-auto inline-flex items-center gap-1.5 rounded-inner border border-danger/30 bg-danger-subtle px-2 py-0.5 text-2xs font-medium text-danger shrink-0 whitespace-nowrap"
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-danger shrink-0" aria-hidden="true" />
                    High risk
                  </span>
                </Show>
              </div>

              <div class="px-3.5 py-2.5 text-xs space-y-2.5">
                <Show when={hasCallout}>
                  <div
                    data-approval-callout
                    class={`rounded-lg border px-3 py-2 space-y-1.5 ${
                      isHighRisk
                        ? "border-danger/30 bg-danger-subtle/35"
                        : "border-border bg-surface-subtle"
                    }`}
                  >
                    <Show when={pa.capability || pa.target}>
                      <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                        <Show when={pa.capability}>
                          <span
                            data-approval-capability={pa.capability}
                            class={`inline-flex items-center gap-1 rounded-inner border px-1.5 py-0.5 text-2xs font-medium shrink-0 ${
                              isHighRisk
                                ? "border-danger/30 bg-danger-subtle text-danger"
                                : "border-border bg-surface text-fg-secondary"
                            }`}
                          >
                            <Iconify
                              icon={capMeta.icon}
                              size={11}
                              class={isHighRisk ? "text-danger shrink-0" : "text-fg-muted shrink-0"}
                            />
                            <span>{capMeta.label}</span>
                          </span>
                        </Show>
                        <Show when={pa.target}>
                          <code
                            data-approval-target
                            class="font-mono text-xs text-fg break-words [overflow-wrap:anywhere] min-w-0"
                          >
                            {pa.target}
                          </code>
                        </Show>
                      </div>
                    </Show>
                    <Show when={pa.reason}>
                      <p class="text-xs text-fg-secondary leading-snug break-words">
                        {pa.reason}
                      </p>
                    </Show>
                    <Show when={pa.proposedRule && showScopedButtons}>
                      <div
                        data-approval-scope
                        class="pt-1.5 border-t border-border-subtle flex items-center gap-1.5 text-2xs text-fg-muted min-w-0"
                      >
                        <Iconify icon="lucide:shield-check" size={12} class="text-accent shrink-0" />
                        <span class="font-mono text-fg-secondary break-words [overflow-wrap:anywhere] min-w-0">
                          {formatProposedRuleScope(pa.proposedRule!)}
                        </span>
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={name === "bash"}>
                  <Show when={bashDesc}>
                    <div class="text-xs text-fg-secondary">{bashDesc}</div>
                  </Show>
                  <Show
                    when={bashCmd.includes("\n")}
                    fallback={
                      <div class="rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-xs text-fg whitespace-pre-wrap break-words [&>code]:whitespace-pre-wrap [&>code]:break-words max-h-56 overflow-y-auto">
                        <ShellCmd text={bashCmd} />
                      </div>
                    }
                  >
                    <pre class="rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-xs text-fg whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                      <span class="text-fg-muted select-none">$ </span>
                      {bashCmd}
                    </pre>
                  </Show>
                </Show>

                <Show when={name === "exec_script" || name === "python"}>
                  <div class="flex items-center gap-1.5 text-2xs font-medium text-fg-secondary">
                    <Iconify
                      icon={isUnsupportedLegacyPython ? "mdi:language-python" : "mdi:language-javascript"}
                      size={13}
                      class="text-fg-muted shrink-0"
                    />
                    <span>
                      {isUnsupportedLegacyPython ? "Unsupported legacy Python call" : "Run JavaScript"}
                    </span>
                  </div>
                  <pre class="rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-xs text-fg whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                    {String(rawArgs.code || rawArgs.script || "")}
                  </pre>
                  <Show when={Boolean(rawArgs.work_dir) || envEntries.length > 0 || Boolean(rawArgs.stdin)}>
                    <div class="flex flex-wrap items-center gap-1.5 text-2xs">
                      <Show when={rawArgs.work_dir}>
                        <span
                          class="inline-flex items-center gap-1 rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-fg-secondary max-w-full truncate"
                          data-rc-tip={tipIfLong(String(rawArgs.work_dir))}
                        >
                          <span class="text-fg-muted">cwd</span>
                          <span class="truncate">{String(rawArgs.work_dir)}</span>
                        </span>
                      </Show>
                      <Show when={envEntries.length > 0}>
                        <span class="inline-flex items-center gap-1 rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-fg-secondary max-w-full truncate">
                          <span class="text-fg-muted">env</span>
                          <span class="truncate">
                            {envEntries.map(([k, v]) => `${k}=${String(v ?? "")}`).join(" ")}
                          </span>
                        </span>
                      </Show>
                      <Show when={rawArgs.stdin}>
                        <span
                          class="inline-flex items-center gap-1 rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-fg-secondary max-w-full truncate"
                          data-rc-tip={tipIfLong(String(rawArgs.stdin))}
                        >
                          <span class="text-fg-muted">stdin</span>
                          <span class="truncate">{String(rawArgs.stdin)}</span>
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <Show when={isUnsupportedLegacyPython}>
                    <p class="text-2xs text-fg-muted">
                      Legacy Python execution was removed. Deny so the agent rewrites the snippet as JavaScript.
                    </p>
                  </Show>
                </Show>

                <Show when={name === "bg_await"}>
                  <div class="flex items-center gap-2 min-w-0">
                    <Iconify icon="lucide:timer" size={14} class="text-fg-secondary shrink-0" />
                    <span class="text-fg-muted shrink-0">Wait</span>
                    <Show when={rawArgs.max_wait_seconds}>
                      <span class="font-mono text-fg shrink-0 tabular-nums">
                        {formatDurationSecs(Number(rawArgs.max_wait_seconds))}
                      </span>
                    </Show>
                    <span class="text-2xs text-fg-muted truncate min-w-0">
                      {rawArgs.reason
                        ? String(rawArgs.reason)
                        : "Ends early when a background task finishes"}
                    </span>
                  </div>
                </Show>

                <Show when={name === "bg_cancel"}>
                  <div class="flex items-center gap-2 min-w-0">
                    <Iconify icon="lucide:octagon-x" size={14} class="text-danger shrink-0" />
                    <span class="text-fg-muted shrink-0">Stop background task</span>
                    <span class="font-mono text-fg truncate min-w-0">
                      {(() => {
                        const id = String(rawArgs.job_id || "");
                        const job = jobs().find((j) => j.id === id);
                        return job?.label || id || "unknown";
                      })()}
                    </span>
                  </div>
                </Show>

                <Show when={name === "read"}>
                  <div class="flex items-center gap-2 min-w-0">
                    <FileIcon path={String(rawArgs.path || "")} size={14} />
                    <span class="text-fg-muted shrink-0">Read</span>
                    <span
                      class="font-mono text-fg truncate min-w-0"
                      data-rc-tip={tipIfLong(String(rawArgs.path || ""))}
                    >
                      {String(rawArgs.path || "")}
                    </span>
                    <Show when={rawArgs.limit || rawArgs.offset}>
                      <span class="shrink-0 inline-flex items-center rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-muted tabular-nums">
                        {(() => {
                          const off = Math.max(1, Number(rawArgs.offset || 1));
                          const lim = Number(rawArgs.limit || 0);
                          return lim > 0 ? `L${off}-${off + lim - 1}` : `L${off}+`;
                        })()}
                      </span>
                    </Show>
                  </div>
                </Show>

                <Show when={name === "write"}>
                  <div class="flex items-center gap-2 min-w-0">
                    <FileIcon path={String(rawArgs.path || "")} size={14} />
                    <span class="text-fg-muted shrink-0">Create</span>
                    <span
                      class="font-mono text-fg truncate min-w-0"
                      data-rc-tip={tipIfLong(String(rawArgs.path || ""))}
                    >
                      {String(rawArgs.path || "")}
                    </span>
                    <Show when={writeLines.length > 0}>
                      <span class="shrink-0 inline-flex items-center rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-muted tabular-nums">
                        {writeLines.length} {writeLines.length === 1 ? "line" : "lines"}
                      </span>
                    </Show>
                  </div>
                  <Show when={writeLines.length > 0}>
                    <pre class={`rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-2xs text-fg-secondary whitespace-pre-wrap break-words ${writeExpanded() ? "max-h-72" : "max-h-36"} overflow-y-auto`}>
                      {(writeExpanded() ? writeLines : writeLines.slice(0, 12)).join("\n")}
                    </pre>
                    <Show when={writeLines.length > 12}>
                      <button
                        type="button"
                        data-action="approval-expand-write"
                        aria-expanded={writeExpanded()}
                        onClick={() => setWriteExpanded((v) => !v)}
                        class="inline-flex items-center gap-1 rounded-inner px-2 py-0.5 -ml-2 text-2xs font-medium text-fg-muted hover:text-fg hover:bg-surface-muted tabular-nums transition-colors cursor-pointer"
                      >
                        {writeExpanded() ? "Show fewer lines" : `+${writeLines.length - 12} more lines`}
                      </button>
                    </Show>
                  </Show>
                </Show>

                <Show when={name === "edit"}>
                  <div class="flex items-center gap-2 min-w-0">
                    <FileIcon path={String(rawArgs.path || "")} size={14} />
                    <span class="text-fg-muted shrink-0">Edit</span>
                    <span
                      class="font-mono text-fg truncate min-w-0"
                      data-rc-tip={tipIfLong(String(rawArgs.path || ""))}
                    >
                      {String(rawArgs.path || "")}
                    </span>
                    <Show when={editList.length > 0}>
                      <span class="shrink-0 inline-flex items-center rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-muted tabular-nums">
                        {editList.length} change{editList.length === 1 ? "" : "s"}
                      </span>
                    </Show>
                  </div>
                  <Show when={editList.length > 0}>
                    <div class="rounded-lg border border-border overflow-hidden divide-y divide-border-subtle font-mono text-2xs">
                      <For each={editsExpanded() ? editList : editList.slice(0, 2)}>
                        {(hunk) => {
                          const oldLines = hunk.oldText ? hunk.oldText.split("\n") : [];
                          const newLines = hunk.newText ? hunk.newText.split("\n") : [];
                          return (
                            <div data-edit-hunk>
                              <Show when={oldLines.length > 0 || newLines.length === 0}>
                                <div class={`px-3 py-1.5 bg-danger-subtle/40 text-fg whitespace-pre-wrap break-words ${editsExpanded() ? "max-h-60" : "max-h-24"} overflow-y-auto`}>
                                  <For each={editsExpanded() ? (oldLines.length > 0 ? oldLines : [""]) : (oldLines.length > 0 ? oldLines : [""]).slice(0, 6)}>
                                    {(line) => (
                                      <div class="flex items-start">
                                        <span
                                          class="select-none shrink-0 w-4 text-danger"
                                          aria-hidden="true"
                                        >
                                          -
                                        </span>
                                        <span class="min-w-0 flex-1">{line}</span>
                                      </div>
                                    )}
                                  </For>
                                  <Show when={!editsExpanded() && oldLines.length > 6}>
                                    <button type="button" onClick={() => setEditsExpanded(true)} class="pl-4 text-left text-fg-muted hover:text-fg cursor-pointer">…</button>
                                  </Show>
                                </div>
                              </Show>
                              <Show when={newLines.length > 0 || oldLines.length === 0}>
                                <div class={`px-3 py-1.5 bg-success-subtle/40 text-fg whitespace-pre-wrap break-words ${editsExpanded() ? "max-h-60" : "max-h-24"} overflow-y-auto`}>
                                  <For each={editsExpanded() ? (newLines.length > 0 ? newLines : [""]) : (newLines.length > 0 ? newLines : [""]).slice(0, 6)}>
                                    {(line) => (
                                      <div class="flex items-start">
                                        <span
                                          class="select-none shrink-0 w-4 text-success"
                                          aria-hidden="true"
                                        >
                                          +
                                        </span>
                                        <span class="min-w-0 flex-1">{line}</span>
                                      </div>
                                    )}
                                  </For>
                                  <Show when={!editsExpanded() && newLines.length > 6}>
                                    <button type="button" onClick={() => setEditsExpanded(true)} class="pl-4 text-left text-fg-muted hover:text-fg cursor-pointer">…</button>
                                  </Show>
                                </div>
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                      <Show when={editList.length > 2}>
                        <button
                          type="button"
                          data-action="approval-expand-edits"
                          aria-expanded={editsExpanded()}
                          onClick={() => setEditsExpanded((v) => !v)}
                          class="w-full text-left px-3 py-1.5 bg-surface-subtle hover:bg-surface-muted font-sans text-2xs font-medium text-fg-muted hover:text-fg tabular-nums transition-colors cursor-pointer"
                        >
                          {editsExpanded() ? "Show fewer changes" : `+${editList.length - 2} more changes`}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </Show>

                <Show when={name === "glob"}>
                  <div class="flex items-center gap-2 min-w-0">
                    <Iconify icon="lucide:search" size={14} class="text-fg-secondary shrink-0" />
                    <span class="text-fg-muted shrink-0">Search files</span>
                    <span
                      class="font-mono text-fg truncate min-w-0"
                      data-rc-tip={tipIfLong(String(rawArgs.pattern || ""))}
                    >
                      {String(rawArgs.pattern || "")}
                    </span>
                    <Show when={rawArgs.path}>
                      <span
                        class="font-mono text-2xs text-fg-muted truncate"
                        data-rc-tip={tipIfLong(String(rawArgs.path))}
                      >
                        {String(rawArgs.path)}
                      </span>
                    </Show>
                  </div>
                </Show>

                <Show when={name === "todo" || name === "todowrite"}>
                  <div class="flex items-center gap-2 min-w-0">
                    <Iconify icon="lucide:list-checks" size={14} class="text-accent shrink-0" />
                    <span class="font-medium text-fg">Update task plan</span>
                    <Show when={todoItems.length > 0}>
                      <span class="shrink-0 inline-flex items-center rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-muted tabular-nums">
                        {todoItems.length} {todoItems.length === 1 ? "task" : "tasks"}
                      </span>
                    </Show>
                  </div>
                  <Show when={todoItems.length > 0}>
                    <ul class="space-y-1.5 pt-0.5">
                      <For each={todoItems}>
                        {(item) => (
                          <li class="flex items-start gap-2 min-w-0" data-todo-status={item.status}>
                            <Iconify
                              icon={
                                item.status === "completed"
                                  ? "lucide:circle-check"
                                  : item.status === "in_progress"
                                    ? "lucide:circle-dot"
                                    : "lucide:circle"
                              }
                              size={13}
                              class={`mt-0.5 shrink-0 ${
                                item.status === "completed"
                                  ? "text-success"
                                  : item.status === "in_progress"
                                    ? "text-accent"
                                    : "text-fg-muted"
                              }`}
                            />
                            <span
                              class={
                                item.status === "completed"
                                  ? "text-fg-muted line-through break-words min-w-0"
                                  : "text-fg break-words min-w-0"
                              }
                            >
                              {item.text}
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>

                <Show when={!isDedicatedTool}>
                  <div class="flex items-center gap-2 min-w-0">
                    <Show
                      when={typeof rawArgs.path === "string" && hasFileIcon(rawArgs.path)}
                      fallback={
                        <Iconify
                          icon={
                            rawArgs.url ||
                            name === "fetch_url" ||
                            name === "web_search" ||
                            name === "search_web"
                              ? "lucide:globe"
                              : name === "patch"
                                ? "lucide:file-diff"
                                : "lucide:wrench"
                          }
                          size={14}
                          class="text-fg-secondary shrink-0"
                        />
                      }
                    >
                      <FileIcon path={String(rawArgs.path)} size={14} />
                    </Show>
                    <span class={isMappedToolName ? "font-medium text-fg shrink-0" : "font-mono text-fg shrink-0"}>{toolLabel}</span>
                    <Show when={fallbackTarget}>
                      <span
                        class="font-mono text-fg-secondary truncate min-w-0"
                        data-rc-tip={tipIfLong(fallbackTarget)}
                      >
                        {fallbackTarget}
                      </span>
                    </Show>
                  </div>
                </Show>
              </div>

              <Show when={showRawArgs}>
                <details class="group border-t border-border-subtle">
                  <summary class="list-none [&::-webkit-details-marker]:hidden px-3.5 py-1.5 flex items-center gap-1.5 text-2xs text-fg-muted hover:text-fg-secondary cursor-pointer select-none transition-colors">
                    <Iconify
                      icon="lucide:chevron-right"
                      size={12}
                      class="shrink-0 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-90"
                    />
                    <span>Arguments</span>
                  </summary>
                  <pre class="px-3.5 pb-2.5 font-mono text-2xs text-fg-secondary overflow-x-auto whitespace-pre-wrap break-words max-h-40">
                    {formattedArgs}
                  </pre>
                </details>
              </Show>

              <div
                class={
                  showScopedButtons
                    ? "px-3.5 py-2.5 border-t border-border-subtle bg-surface-subtle grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
                    : "px-3.5 py-2 border-t border-border-subtle bg-surface-subtle flex items-center justify-between gap-2 flex-wrap"
                }
              >
                <button
                  type="button"
                  ref={press}
                  data-action="approval-deny"
                  onClick={() => props.respondApproval("deny")}
                  class={`inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-1 min-h-7 text-xs font-medium text-fg-secondary hover:border-danger/35 hover:bg-danger-subtle hover:text-danger transition-colors cursor-pointer ${
                    showScopedButtons ? "sm:mr-auto" : ""
                  }`}
                >
                  Deny
                </button>
                <Show when={showAllowAlways}>
                  <button
                    type="button"
                    ref={press}
                    data-action="approval-always"
                    data-rc-tip="Save global allow rule in Settings → Permissions"
                    aria-label="Always allow"
                    onClick={() => props.respondApproval("always")}
                    class="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-1 min-h-7 text-xs font-medium text-fg-secondary hover:border-border-strong hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                  >
                    Always allow
                  </button>
                </Show>
                <Show when={showAllowSession}>
                  <button
                    type="button"
                    ref={press}
                    data-action="approval-session"
                    data-rc-tip="Allow matching requests in this conversation only"
                    aria-label="Allow for session"
                    onClick={() => props.respondApproval("session")}
                    class="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-1 min-h-7 text-xs font-medium text-fg hover:border-border-strong hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    Allow for session
                  </button>
                </Show>
                <Show when={!isUnsupportedLegacyPython}>
                  <button
                    type="button"
                    ref={press}
                    data-action="approval-once"
                    onClick={() => props.respondApproval("once")}
                    class={`inline-flex items-center justify-center rounded-lg bg-fg text-background hover:opacity-90 px-3.5 py-1 min-h-7 text-xs font-medium transition-opacity cursor-pointer ${
                      showScopedButtons && totalButtons === 3
                        ? "col-span-2 sm:col-span-1"
                        : !showScopedButtons
                          ? "ml-auto"
                          : ""
                    }`}
                  >
                    Allow once
                  </button>
                </Show>
              </div>
            </div>
          </section>
        );
      }}
    </Show>
  );
}
