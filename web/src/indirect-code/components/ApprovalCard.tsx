import { createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { hasFileIcon } from "../files";
import { FileIcon } from "../presentation";
import { extractTodoItems, tryParseArgs } from "../utils/tools";
import { formatDurationSecs } from "../utils/format";
import { useBackground } from "../ctx";
import type { PendingApproval } from "../types";
import { ShellCmd } from "./CodeBlock";

/** Tool call approval card (narrow props instead of the god-ctx). */
export interface ApprovalCardProps {
  pendingApproval: () => PendingApproval | null;
  convWidthClass: () => string;
  respondApproval: (approved: boolean, always?: boolean) => void;
  setYoloMode: (v: boolean) => void;
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

function tipIfLong(text: string, min = 48): string | undefined {
  return text.length > min ? text : undefined;
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
        const hasRawArgs =
          Object.keys(rawArgs).length > 0 ||
          Boolean(pa.args?.trim() && pa.args.trim() !== "{}");
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

        return (
          <section
            aria-label="Tool approval request"
            data-approval-card
            class={`w-full ${props.convWidthClass()} mx-auto py-1`}
          >
            <div class="rounded-panel border border-border bg-surface overflow-hidden">
              <div class="px-3.5 py-2.5 border-b border-border-subtle bg-surface-subtle flex items-center gap-2 min-w-0">
                <Iconify icon="lucide:shield-alert" size={14} class="text-warning shrink-0" />
                <span class="text-xs font-medium text-fg shrink-0">Review tool call</span>
                <span
                  class="inline-flex items-center rounded-inner border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-secondary truncate"
                  data-rc-tip={tipIfLong(name, 32)}
                >
                  {name}
                </span>
                <span class="ml-auto inline-flex items-center gap-1.5 text-2xs text-fg-muted shrink-0">
                  <span class="h-1.5 w-1.5 rounded-full bg-warning shrink-0" aria-hidden="true" />
                  Safe mode
                </span>
              </div>

              <div class="px-3.5 py-2.5 text-xs space-y-2">
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
                  <p class="text-2xs text-fg-muted">
                    Moves to the background automatically after 10s.
                  </p>
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
                  <p class="text-2xs text-fg-muted">
                    {isUnsupportedLegacyPython
                      ? "Legacy Python execution was removed. Reject so the agent rewrites the snippet as JavaScript."
                      : "Moves to the background automatically after 10s."}
                  </p>
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
                    <span class="font-mono text-fg shrink-0">{name}</span>
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

              <Show when={hasRawArgs}>
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

              <div class="px-3.5 py-2 border-t border-border-subtle bg-surface-subtle flex items-center justify-between gap-2 flex-wrap">
                <button
                  type="button"
                  data-action="approval-reject"
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => props.respondApproval(false)}
                  class="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-1 min-h-7 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                >
                  Reject
                </button>
                <Show when={!isUnsupportedLegacyPython}>
                  <div class="flex items-center gap-2 ml-auto">
                    <button
                      type="button"
                      data-action="approval-always"
                      data-rc-tip="Enable Full access and allow all tool calls"
                      aria-label="Always allow (enable Full access)"
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => {
                        props.setYoloMode(true);
                        props.respondApproval(true, true);
                      }}
                      class="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-1 min-h-7 text-xs font-medium text-fg-secondary hover:border-border-strong hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                    >
                      Always allow
                    </button>
                    <button
                      type="button"
                      data-action="approval-once"
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => props.respondApproval(true)}
                      class="inline-flex items-center justify-center rounded-lg bg-fg text-background hover:opacity-90 px-3.5 py-1 min-h-7 text-xs font-medium transition-opacity cursor-pointer"
                    >
                      Allow once
                    </button>
                  </div>
                </Show>
              </div>
            </div>
          </section>
        );
      }}
    </Show>
  );
}
