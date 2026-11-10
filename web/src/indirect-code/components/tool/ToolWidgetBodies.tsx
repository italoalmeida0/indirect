import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { CodeBlock, DiffView } from "../CodeBlock";
import { StreamingMarkdown } from "../StreamingMarkdown";
import { diffStat } from "../../transcript";
import { parseEditResults, type FileEditSection } from "../../utils/toolEdits";
import { extractTodoItems, resolveWidgetId } from "../../utils/tools";
import type { ToolPartProps } from "./toolUnitModel";

interface ParsedWidgetLintError {
  phase: string;
  message: string;
  line?: number;
}

interface ParsedWidgetLint {
  id: string;
  ok: boolean;
  skipped: boolean;
  durationMs?: number;
  errors: ParsedWidgetLintError[];
  notes: string[];
  output: string;
}

interface ParsedWidgetListItem {
  id: string;
  size?: string;
  lines?: number;
  placeholder?: string;
  mtime?: string;
}

interface ParsedWidgetList {
  total: number;
  entries: ParsedWidgetListItem[];
}

function isLintReportText(raw: string): boolean {
  const t = (raw || "").trim();
  if (!t) return false;
  return (
    /^lint skipped\b/im.test(t) ||
    /^LINT (?:OK|FAILED):/m.test(t) ||
    /^\[(?:compile|audit|render|test|lint|note)\]\s+/m.test(t)
  );
}

function parseWidgetLint(details: any, rawText: string, fallbackId: string): ParsedWidgetLint | null {
  const lintObj = details?.lint;
  if (lintObj && typeof lintObj === "object") {
    const errors: ParsedWidgetLintError[] = Array.isArray(lintObj.errors)
      ? lintObj.errors
          .filter((e: any) => e && typeof e === "object")
          .map((e: any) => ({
            phase: String(e.phase || "lint"),
            message: String(e.message || "").trim(),
            ...(typeof e.line === "number" && e.line > 0 ? { line: e.line } : {}),
          }))
      : [];
    const notes: string[] = Array.isArray(lintObj.notes)
      ? lintObj.notes.map((n: any) => String(n || "").trim()).filter(Boolean)
      : [];
    const skipped = Boolean(lintObj.skipped);
    const ok = skipped ? true : Boolean(lintObj.ok ?? details?.lint_ok ?? errors.length === 0);
    return {
      id: String(details?.id || fallbackId || "widget"),
      ok,
      skipped,
      ...(typeof lintObj.durationMs === "number" ? { durationMs: lintObj.durationMs } : {}),
      errors,
      notes,
      output: String(lintObj.output || "").trimEnd(),
    };
  }

  const trimmed = (rawText || "").trim();
  if (!trimmed) {
    if (typeof details?.lint_ok === "boolean") {
      return {
        id: String(details?.id || fallbackId || "widget"),
        ok: details.lint_ok,
        skipped: false,
        errors: [],
        notes: [],
        output: "",
      };
    }
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  const errors: ParsedWidgetLintError[] = [];
  const notes: string[] = [];
  const frameLines: string[] = [];
  let skipped = false;
  let ok: boolean | undefined = typeof details?.lint_ok === "boolean" ? details.lint_ok : undefined;
  let durationMs: number | undefined;
  let parsedId = String(details?.id || fallbackId || "widget");
  let sawStructuredLine = false;

  for (const line of lines) {
    const skipMatch = /^lint skipped[^:]*:\s*(.+)$/i.exec(line.trim());
    if (skipMatch) {
      skipped = true;
      ok = true;
      sawStructuredLine = true;
      if (skipMatch[1]?.trim()) parsedId = skipMatch[1].trim();
      continue;
    }
    if (/^widget saved but NOT validated$/i.test(line.trim())) {
      sawStructuredLine = true;
      continue;
    }
    const okMatch = /^LINT OK:\s*(\S+)(?:\s*\((\d+)ms\))?/i.exec(line.trim());
    if (okMatch) {
      ok = true;
      sawStructuredLine = true;
      if (okMatch[1]) parsedId = okMatch[1];
      if (okMatch[2] !== undefined) durationMs = Number(okMatch[2]);
      continue;
    }
    const failMatch = /^LINT FAILED:\s*(\S+)/i.exec(line.trim());
    if (failMatch) {
      ok = false;
      sawStructuredLine = true;
      if (failMatch[1]) parsedId = failMatch[1];
      continue;
    }
    const noteMatch = /^\[note\]\s*(.+)$/i.exec(line);
    if (noteMatch) {
      notes.push(noteMatch[1].trim());
      sawStructuredLine = true;
      continue;
    }
    const errMatch = /^\[([a-zA-Z0-9_-]+)\]\s*(?:line\s+(\d+):\s*)?(.+)$/.exec(line);
    if (errMatch) {
      errors.push({
        phase: errMatch[1].toLowerCase(),
        ...(errMatch[2] ? { line: Number(errMatch[2]) } : {}),
        message: errMatch[3].trim(),
      });
      sawStructuredLine = true;
      continue;
    }
    frameLines.push(line);
  }

  if (!sawStructuredLine && ok === undefined) return null;
  const resolvedOk = skipped ? true : ok !== undefined ? ok : errors.length === 0;
  return {
    id: parsedId,
    ok: resolvedOk,
    skipped,
    ...(durationMs !== undefined ? { durationMs } : {}),
    errors,
    notes,
    output: frameLines.join("\n").trimEnd(),
  };
}

function parseWidgetList(rawText: string, details: any): ParsedWidgetList | null {
  if (Array.isArray(details?.widgets)) {
    const entries: ParsedWidgetListItem[] = details.widgets
      .filter((w: any) => w && typeof w === "object")
      .map((w: any) => ({
        id: String(w.id || w.widget_id || "widget"),
        ...(w.size != null ? { size: typeof w.size === "number" ? `${w.size} B` : String(w.size) } : {}),
        ...(typeof w.lines === "number" ? { lines: w.lines } : {}),
        ...(w.placeholder ? { placeholder: String(w.placeholder) } : {}),
        ...(w.mtime ? { mtime: String(w.mtime) } : {}),
      }));
    return {
      total: typeof details.total === "number" ? details.total : entries.length,
      entries,
    };
  }

  const trimmed = (rawText || "").trim();
  if (!trimmed && typeof details?.total !== "number") return null;

  const lines = trimmed ? trimmed.split(/\r?\n/) : [];
  let headerTotal: number | undefined = typeof details?.total === "number" ? details.total : undefined;
  const entries: ParsedWidgetListItem[] = [];
  let sawHeaderOrEmpty = false;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const t = ln.trim();
    if (!t) continue;
    if (i === 0) {
      const hm = /^widgets\s*\((\d+)\s+entr(?:y|ies)\)/i.exec(t);
      if (hm) {
        sawHeaderOrEmpty = true;
        if (headerTotal === undefined) headerTotal = Number(hm[1]);
        continue;
      }
    }
    if (/^\(none\b/i.test(t) || /^no widgets\b/i.test(t)) {
      sawHeaderOrEmpty = true;
      continue;
    }
    const rowMatch = /^([^\s(]+)\s*\((.+)\)\s*$/.exec(t);
    if (!rowMatch) continue;
    const id = rowMatch[1];
    const metaRaw = rowMatch[2];
    const parts: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let c = 0; c < metaRaw.length; c++) {
      const ch = metaRaw[c];
      if (ch === "\"" && metaRaw[c - 1] !== "\\") {
        inQuotes = !inQuotes;
        cur += ch;
      } else if (ch === "," && !inQuotes) {
        parts.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur.trim());

    let size: string | undefined;
    let lineCount: number | undefined;
    let placeholder: string | undefined;
    let mtime: string | undefined;

    for (const p of parts) {
      const lm = /^(\d+)\s+lines?$/i.exec(p);
      if (lm) {
        lineCount = Number(lm[1]);
        continue;
      }
      if (p.startsWith("\"") && p.endsWith("\"") && p.length >= 2) {
        placeholder = p.slice(1, -1).replace(/\\"/g, "\"");
        continue;
      }
      if (/^\d{4}-\d{2}-\d{2}/.test(p)) {
        mtime = p;
        continue;
      }
      if (!size) {
        size = p;
      } else if (!mtime) {
        mtime = p;
      }
    }
    entries.push({ id, size, lines: lineCount, placeholder, mtime });
  }

  if (!sawHeaderOrEmpty && entries.length === 0) return null;
  return {
    total: headerTotal !== undefined ? headerTotal : entries.length,
    entries,
  };
}

function synthesizeEditsDiff(edits: unknown[], widgetId: string): FileEditSection[] {
  const blocks: string[] = [];
  for (let idx = 0; idx < edits.length; idx++) {
    const item = edits[idx] as any;
    if (!item || typeof item !== "object") continue;
    const oldText = typeof (item.old_text ?? item.old) === "string" ? String(item.old_text ?? item.old) : "";
    const newText = typeof (item.new_text ?? item.new) === "string" ? String(item.new_text ?? item.new) : "";
    if (!oldText && !newText) continue;
    const oldLines = oldText ? oldText.split("\n") : [];
    const newLines = newText ? newText.split("\n") : [];
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix++;
    }
    const hunkLines: string[] = [`@@ edit ${idx + 1} @@`];
    const ctxStart = Math.max(0, prefix - 2);
    for (let i = ctxStart; i < prefix; i++) hunkLines.push(` ${oldLines[i]}`);
    for (let i = prefix; i < oldLines.length - suffix; i++) hunkLines.push(`-${oldLines[i]}`);
    for (let i = prefix; i < newLines.length - suffix; i++) hunkLines.push(`+${newLines[i]}`);
    const ctxEnd = Math.min(oldLines.length, oldLines.length - suffix + 2);
    for (let i = oldLines.length - suffix; i < ctxEnd; i++) hunkLines.push(` ${oldLines[i]}`);
    blocks.push(hunkLines.join("\n"));
  }
  if (blocks.length === 0) return [];
  return [{ file: widgetId, status: "applied", diff: blocks.join("\n") }];
}

function WidgetEditCard(props: { sec: FileEditSection; scrollKey?: string }) {
  const [open, setOpen] = createSignal(true);
  const stat = () => diffStat(props.sec.diff);
  const highlightName = () => (props.sec.file.includes(".") ? props.sec.file : `${props.sec.file || "widget"}.tsx`);

  return (
    <div class="border-b border-border/60 last:border-b-0">
      <div
        onClick={() => setOpen(!open())}
        class="group/file flex items-center justify-between gap-2 px-3 py-1.5 bg-surface-subtle/70 hover:bg-surface-muted/70 text-[12px] cursor-pointer transition-colors select-none"
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <Iconify icon="lucide:layout-template" size={13} class="shrink-0 text-accent/85" />
          <span class="font-mono font-medium text-fg truncate">{props.sec.file || "widget"}</span>
          <span class="shrink-0 rounded border border-border/70 bg-surface-muted/80 px-1.5 py-px font-mono text-[10px] text-fg-secondary">
            tsx
          </span>
          <Show when={props.sec.status === "error"}>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-danger-subtle text-danger font-mono">
              failed
            </span>
          </Show>
          <Show when={stat().add > 0 || stat().del > 0}>
            <span class="font-mono text-[10.5px] shrink-0 tabular-nums">
              <Show when={stat().add > 0}>
                <span class="text-success">+{stat().add}</span>
              </Show>
              <Show when={stat().add > 0 && stat().del > 0}>
                <span class="text-fg-muted"> </span>
              </Show>
              <Show when={stat().del > 0}>
                <span class="text-danger">-{stat().del}</span>
              </Show>
            </span>
          </Show>
        </div>
        <Iconify
          icon="lucide:chevron-down"
          size={12}
          class={`shrink-0 text-fg-muted transition-transform ${open() ? "rotate-180" : ""}`}
        />
      </div>
      <Show when={open()}>
        <Show when={props.sec.error}>
          <div class="px-3 py-2 text-[11.5px] text-danger font-mono bg-danger-subtle border-t border-danger/20">
            {props.sec.error}
          </div>
        </Show>
        <Show when={props.sec.diff}>
          <div class="border-t border-border/50">
            <DiffView text={props.sec.diff} max={60} name={highlightName()} scrollKey={props.scrollKey} embedded />
          </div>
        </Show>
      </Show>
    </div>
  );
}

function WidgetLintFindings(props: { lint: ParsedWidgetLint; scrollKey: string }) {
  return (
    <>
      <Show when={props.lint.errors.length > 0}>
        <ul class="border-b border-border/55 bg-danger-subtle/35 px-3 py-2 space-y-1.5">
          <For each={props.lint.errors}>
            {(err) => (
              <li class="flex items-start gap-2 text-[11.5px] leading-snug">
                <span class="shrink-0 rounded border border-danger/35 bg-danger-subtle px-1.5 py-px font-mono text-[10px] text-danger">
                  {err.phase}
                </span>
                <Show when={err.line && err.line > 0}>
                  <span class="shrink-0 rounded border border-border/70 bg-surface px-1.5 py-px font-mono text-[10px] text-fg-secondary tabular-nums">
                    L{err.line}
                  </span>
                </Show>
                <span class="min-w-0 flex-1 font-mono text-fg break-words">{err.message}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.lint.output}>
        <div class="border-b border-border/55 bg-surface/40">
          <CodeBlock
            embedded
            text={props.lint.output}
            language={undefined}
            plain
            wrap={false}
            scrollKey={`${props.scrollKey}:lint-frame`}
          />
        </div>
      </Show>
      <Show when={props.lint.notes.length > 0}>
        <ul class="border-b border-border/55 bg-surface/35 px-3 py-1.5 space-y-1">
          <For each={props.lint.notes}>
            {(note) => (
              <li class="flex items-start gap-1.5 text-[11px] leading-snug text-fg-secondary">
                <Iconify icon="lucide:info" size={12} class="mt-0.5 shrink-0 text-fg-muted" />
                <span class="min-w-0 flex-1">{note}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}

/**
 * Bespoke expanded tool bodies for Generative UI widgets (`widget_*`),
 * session task checklists (`todo`, `todowrite`, `todoread`), and skill
 * activations (`use_skill`). All inner blocks stay `overflow-visible` /
 * `embedded` so `ToolBody` remains the single scroll surface.
 */
export function ToolWidgetBodies(props: ToolPartProps) {
  const toolName = () => props.m.name();
  const details = () => (props.u.result?.toolDetails as any) || undefined;
  const widgetId = () => resolveWidgetId(props.m.args(), details()) || "widget";

  const parsedLint = createMemo<ParsedWidgetLint | null>(() => {
    const n = toolName();
    if (n !== "widget_lint" && n !== "widget_set") return null;
    const raw =
      n === "widget_lint"
        ? String(details()?.display ?? props.m.output() ?? props.m.prog() ?? "")
        : String(props.m.output() || "");
    return parseWidgetLint(details(), raw, widgetId());
  });

  const widgetSetSource = createMemo(() => {
    if (toolName() !== "widget_set") return "";
    const d = details();
    if (d?.deleted || props.m.args().delete) return "";
    if (typeof d?.display === "string" && d.display.trim()) return d.display;
    const argContent = props.m.args().content;
    if (typeof argContent === "string" && argContent.trim()) return argContent;
    const prog = props.m.prog();
    if (prog && prog.trim()) return prog;
    const out = props.m.output() || "";
    if (out.trim() && !isLintReportText(out)) return out;
    return "";
  });

  const widgetEditSections = createMemo<FileEditSection[]>(() => {
    if (toolName() !== "widget_edit") return [];
    const d = details();
    const raw = String(d?.display ?? d?.diff ?? props.m.output() ?? "");
    const parsed = raw.trim() ? parseEditResults(raw, widgetId()) : [];
    if (parsed.length > 0) return parsed;
    const edits = props.m.args().edits;
    if (Array.isArray(edits) && edits.length > 0) {
      return synthesizeEditsDiff(edits, widgetId());
    }
    return [];
  });

  const widgetList = createMemo<ParsedWidgetList | null>(() => {
    if (toolName() !== "widget_list") return null;
    const raw = String(details()?.display ?? props.m.output() ?? "");
    return parseWidgetList(raw, details());
  });

  const todoItems = createMemo(() => {
    const n = toolName();
    if (n !== "todo" && n !== "todowrite" && n !== "todoread") return [];
    return extractTodoItems(props.m.args(), props.m.output(), details());
  });

  return (
    <>
      {/* widget_set */}
      <Show when={toolName() === "widget_set"}>
        <Show
          when={!(props.m.args().delete || details()?.deleted)}
          fallback={
            <div class="flex items-center justify-between gap-2 px-3 py-2 text-[12px]">
              <div class="flex items-center gap-2 min-w-0">
                <Iconify icon="lucide:trash-2" size={13} class="shrink-0 text-fg-muted" />
                <span class="font-mono font-medium text-fg truncate">{widgetId()}</span>
                <span class="text-fg-muted truncate">Removed from session widget store</span>
              </div>
              <span class="shrink-0 rounded border border-border/70 bg-surface-muted px-1.5 py-px font-mono text-[10px] text-fg-secondary">
                deleted
              </span>
            </div>
          }
        >
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-surface/50 px-3 py-1.5 text-[11.5px]">
            <div class="flex items-center gap-1.5 min-w-0">
              <Iconify icon="lucide:layout-template" size={13} class="shrink-0 text-accent/85" />
              <span class="font-mono font-medium text-fg truncate">{widgetId()}</span>
              <span class="shrink-0 rounded border border-border/70 bg-surface-muted/80 px-1.5 py-px font-mono text-[10px] text-fg-secondary">
                tsx
              </span>
              <Show when={props.m.args().src_file}>
                <span class="inline-flex items-center gap-1 truncate font-mono text-[10.5px] text-fg-muted">
                  <Iconify icon="lucide:arrow-left" size={10} class="shrink-0" />
                  {String(props.m.args().src_file)}
                </span>
              </Show>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <Show when={Number(details()?.total_lines || 0) > 0}>
                <span class="font-mono text-[10.5px] text-fg-muted tabular-nums">
                  {Number(details()?.total_lines)} {Number(details()?.total_lines) === 1 ? "line" : "lines"}
                </span>
              </Show>
              <Show when={props.u.result && parsedLint()}>
                {(lint) => (
                  <Show
                    when={!lint().skipped}
                    fallback={
                      <span class="inline-flex items-center gap-1 rounded border border-border/70 bg-surface-muted px-1.5 py-px font-mono text-[10px] text-fg-muted">
                        lint skipped
                      </span>
                    }
                  >
                    <Show
                      when={lint().ok}
                      fallback={
                        <span class="inline-flex items-center gap-1 rounded border border-danger/35 bg-danger-subtle px-1.5 py-px font-mono text-[10px] text-danger">
                          <Iconify icon="lucide:shield-alert" size={11} />
                          lint failed{lint().errors.length > 0 ? ` · ${lint().errors.length}` : ""}
                        </span>
                      }
                    >
                      <span class="inline-flex items-center gap-1 rounded border border-success/35 bg-success-subtle px-1.5 py-px font-mono text-[10px] text-success">
                        <Iconify icon="lucide:shield-check" size={11} />
                        lint ok{lint().durationMs !== undefined ? ` · ${lint().durationMs}ms` : ""}
                      </span>
                    </Show>
                  </Show>
                )}
              </Show>
            </div>
          </div>
          <Show when={parsedLint()}>
            {(lint) => <WidgetLintFindings lint={lint()} scrollKey={props.m.key()} />}
          </Show>
          <Show
            when={widgetSetSource()}
            fallback={
              <div class="px-3 py-2 text-[11.5px] text-fg-muted">
                {props.m.args().src_file
                  ? `Imported widget source from ${String(props.m.args().src_file)}`
                  : props.active
                    ? "Saving widget…"
                    : "Widget saved."}
              </div>
            }
          >
            <CodeBlock
              embedded
              numbered
              follow={() => props.m.open() && props.running}
              text={widgetSetSource()}
              language="tsx"
              wrap={false}
              scrollKey={props.m.key()}
            />
          </Show>
        </Show>
      </Show>

      {/* widget_read */}
      <Show when={toolName() === "widget_read"}>
        <div class="flex items-center justify-between gap-2 border-b border-border/55 bg-surface/45 px-3 py-1.5 text-[11.5px]">
          <div class="flex items-center gap-1.5 min-w-0">
            <Iconify icon="lucide:code-2" size={13} class="shrink-0 text-fg-muted" />
            <span class="font-mono font-medium text-fg truncate">{widgetId()}</span>
            <span class="shrink-0 rounded border border-border/70 bg-surface-muted/80 px-1.5 py-px font-mono text-[10px] text-fg-secondary">
              tsx
            </span>
          </div>
          <Show when={Number(details()?.total_lines || 0) > 0}>
            <span class="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">
              {Number(details()?.total_lines)} {Number(details()?.total_lines) === 1 ? "line" : "lines"}
            </span>
          </Show>
        </div>
        <Show
          when={details()?.display || props.m.output() || props.m.prog()}
          fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Reading widget…" : "Empty widget source."}</div>}
        >
          <CodeBlock
            embedded
            numbered
            follow={() => props.m.open() && props.running}
            text={String((details()?.display ?? props.m.output()) || props.m.prog() || "")}
            language="tsx"
            wrap={false}
            scrollKey={props.m.key()}
          />
        </Show>
      </Show>

      {/* widget_edit */}
      <Show when={toolName() === "widget_edit"}>
        <Show
          when={widgetEditSections().length > 0}
          fallback={
            <div class="px-3 py-2 text-[11px] text-fg-muted">
              {props.active ? "Applying widget edit…" : "No changes"}
            </div>
          }
        >
          <For each={widgetEditSections()}>
            {(sec) => <WidgetEditCard sec={sec} scrollKey={`${props.m.key()}:${sec.file}`} />}
          </For>
        </Show>
      </Show>

      {/* widget_lint */}
      <Show when={toolName() === "widget_lint"}>
        <Show
          when={parsedLint()}
          fallback={
            <Show
              when={details()?.display || props.m.output() || props.m.prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Linting widget…" : "Waiting for lint result…"}</div>}
            >
              <CodeBlock
                embedded
                follow={() => props.m.open() && props.running}
                text={String(details()?.display || props.m.output() || props.m.prog() || "")}
                language={undefined}
                plain
                wrap={false}
                scrollKey={props.m.key()}
              />
            </Show>
          }
        >
          {(lint) => (
            <>
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-surface/50 px-3 py-2 text-[12px]">
                <div class="flex items-center gap-2 min-w-0">
                  <Show
                    when={!lint().skipped}
                    fallback={<Iconify icon="lucide:shield" size={14} class="shrink-0 text-fg-muted" />}
                  >
                    <Iconify
                      icon={lint().ok ? "lucide:shield-check" : "lucide:shield-alert"}
                      size={14}
                      class={`shrink-0 ${lint().ok ? "text-success" : "text-danger"}`}
                    />
                  </Show>
                  <span class={`font-medium ${lint().skipped ? "text-fg-secondary" : lint().ok ? "text-success" : "text-danger"}`}>
                    {lint().skipped ? "Lint skipped" : lint().ok ? "Lint passed" : "Lint failed"}
                  </span>
                  <span class="font-mono text-fg truncate">{lint().id}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <Show when={!lint().ok && lint().errors.length > 0}>
                    <span class="rounded border border-danger/35 bg-danger-subtle px-1.5 py-px font-mono text-[10px] text-danger tabular-nums">
                      {lint().errors.length} {lint().errors.length === 1 ? "error" : "errors"}
                    </span>
                  </Show>
                  <Show when={lint().durationMs !== undefined}>
                    <span class="font-mono text-[10.5px] text-fg-muted tabular-nums">{lint().durationMs}ms</span>
                  </Show>
                </div>
              </div>
              <WidgetLintFindings lint={lint()} scrollKey={props.m.key()} />
              <Show when={lint().errors.length === 0 && !lint().output && lint().notes.length === 0}>
                <div class="px-3 py-2 text-[11.5px] text-fg-secondary">
                  {lint().skipped
                    ? "Gateway linter unavailable — widget stored without smoke-render validation."
                    : "Compiled TSX, passed sandbox import audit, and smoke-rendered cleanly."}
                </div>
              </Show>
              <Show when={typeof props.m.args().test === "string" && String(props.m.args().test).trim()}>
                <div class="border-t border-border/55">
                  <div class="px-3 py-1 bg-surface/40 border-b border-border/45 font-mono text-[10.5px] text-fg-muted">
                    test module
                  </div>
                  <CodeBlock
                    embedded
                    text={String(props.m.args().test)}
                    language="tsx"
                    wrap={false}
                    scrollKey={`${props.m.key()}:test`}
                  />
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>

      {/* widget_list */}
      <Show when={toolName() === "widget_list"}>
        <Show
          when={widgetList()}
          fallback={
            <Show
              when={props.m.output() || props.m.prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Listing widgets…" : "No widgets stored in this session."}</div>}
            >
              <CodeBlock
                embedded
                follow={() => props.m.open() && props.running}
                text={props.m.output() || props.m.prog() || ""}
                language={undefined}
                plain
                wrap={false}
                scrollKey={props.m.key()}
              />
            </Show>
          }
        >
          {(wl) => (
            <>
              <div class="px-3 py-1.5 border-b border-border/50 bg-surface/40 font-mono text-[11px] text-fg-muted tabular-nums">
                widgets · {wl().total} {wl().total === 1 ? "entry" : "entries"}
              </div>
              <Show
                when={wl().entries.length > 0}
                fallback={<div class="px-3 py-2 text-[11.5px] text-fg-muted">No widgets stored in this session.</div>}
              >
                <ul class="px-1.5 py-1">
                  <For each={wl().entries}>
                    {(item) => (
                      <li class="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-surface-muted/65 text-[12px] transition-colors">
                        <div class="flex items-center gap-1.5 min-w-0 flex-1">
                          <Iconify icon="lucide:layout-template" size={13} class="shrink-0 text-accent/85" />
                          <span class="font-mono font-medium text-fg shrink-0">{item.id}</span>
                          <Show when={item.placeholder}>
                            <span class="truncate text-[11.5px] text-fg-muted">· {item.placeholder}</span>
                          </Show>
                        </div>
                        <span class="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">
                          {[
                            item.size,
                            item.lines !== undefined ? `${item.lines} ${item.lines === 1 ? "line" : "lines"}` : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          <Show when={item.mtime}>
                            <span class="hidden sm:inline">{" · " + item.mtime}</span>
                          </Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </>
          )}
        </Show>
      </Show>

      {/* todo / todowrite / todoread */}
      <Show when={toolName() === "todo" || toolName() === "todowrite" || toolName() === "todoread"}>
        {(() => {
          const total = () => todoItems().length;
          const done = () => todoItems().filter((it) => it.status === "completed").length;
          const pct = () => (total() > 0 ? Math.round((done() * 100) / total()) : 0);
          return (
            <>
              <div class="flex items-center justify-between gap-3 border-b border-border/55 bg-surface/45 px-3 py-1.5 text-[11.5px]">
                <div class="flex items-center gap-2 min-w-0">
                  <Iconify icon="lucide:list-checks" size={13} class="shrink-0 text-fg-muted" />
                  <span class="font-medium text-fg-secondary">Task checklist</span>
                  <Show when={total() > 0}>
                    <span class="font-mono text-[10.5px] text-fg-muted tabular-nums">
                      {done()}/{total()} completed
                    </span>
                  </Show>
                </div>
                <Show when={total() > 0}>
                  <div class="flex items-center gap-2 shrink-0">
                    <div class="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
                      <div
                        class="h-full rounded-full bg-success transition-all"
                        style={{ width: `${pct()}%` }}
                      />
                    </div>
                    <span class="font-mono text-[10.5px] text-fg-muted tabular-nums">{pct()}%</span>
                  </div>
                </Show>
              </div>
              <Show
                when={todoItems().length > 0}
                fallback={
                  <div class="px-3 py-2 text-[11.5px] text-fg-muted">
                    {props.active && !props.u.result ? "Updating task checklist…" : "No tasks in checklist."}
                  </div>
                }
              >
                <ul class="px-2 py-1.5 space-y-0.5">
                  <For each={todoItems()}>
                    {(item) => (
                      <li class="flex items-start gap-2 rounded-md px-1.5 py-1 text-[12px] leading-snug">
                        <Iconify
                          icon={
                            item.status === "completed"
                              ? "lucide:check-circle-2"
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
                                : "text-fg-muted/70"
                          }`}
                        />
                        <span
                          class={`min-w-0 flex-1 ${
                            item.status === "completed"
                              ? "text-fg-muted line-through"
                              : item.status === "in_progress"
                                ? "font-medium text-fg"
                                : "text-fg-secondary"
                          }`}
                        >
                          {item.text}
                        </span>
                        <Show when={item.status === "in_progress"}>
                          <span class="shrink-0 rounded border border-accent/30 bg-accent-subtle px-1.5 py-px font-mono text-[10px] text-accent">
                            active
                          </span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </>
          );
        })()}
      </Show>

      {/* use_skill */}
      <Show when={toolName() === "use_skill"}>
        {(() => {
          const skillName = () =>
            String(props.m.args().name || props.m.args().skill || details()?.skill || "skill").trim();
          const once = () => Boolean(props.m.args().once);
          const rawBody = () => (props.m.output() || "").trim();
          const isAckPlaceholder = () => /^<skill\b[^>]*>$/i.test(rawBody());
          return (
            <>
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/55 bg-surface/45 px-3 py-1.5 text-[11.5px]">
                <div class="flex items-center gap-1.5 min-w-0">
                  <Iconify icon="lucide:sparkles" size={13} class="shrink-0 text-accent" />
                  <span class="font-mono font-medium text-fg truncate">{skillName()}</span>
                </div>
                <span class="shrink-0 rounded border border-border/70 bg-surface-muted px-1.5 py-px font-mono text-[10px] text-fg-secondary">
                  {once() ? "this turn only" : "session active"}
                </span>
              </div>
              <Show
                when={rawBody() && !isAckPlaceholder()}
                fallback={
                  <div class="px-3 py-2 text-[11.5px] text-fg-secondary">
                    {!props.u.result
                      ? props.active
                        ? "Loading skill instructions…"
                        : "Pending skill activation."
                      : "Skill instructions are loaded and active in session context."}
                  </div>
                }
              >
                <div class="px-3 py-2 text-xs leading-relaxed text-fg rc-markdown">
                  <StreamingMarkdown basic={true}>{rawBody()}</StreamingMarkdown>
                </div>
              </Show>
            </>
          );
        })()}
      </Show>
    </>
  );
}
