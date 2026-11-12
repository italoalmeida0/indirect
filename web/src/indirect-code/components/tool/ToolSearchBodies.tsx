import { For, Show, createMemo, onCleanup } from "solid-js";
import { followTail } from "../../utils/scrollMemory";
import { StreamingMarkdown } from "../StreamingMarkdown";
import { Icon as Iconify } from "../../../components/icon";
import { CodeBlock } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import { extractArrivalSpillInfo, formatSpillBytes, type ArrivalSpillInfo } from "../../utils/contextTools";
import { parseGlobList, parseInspectTree } from "../../utils/toolTrees";
import { isDaemonBuiltinTool } from "../../utils/tools";
import type { ToolPartProps } from "./toolUnitModel";

interface ParsedBgJobItem {
  id: string;
  kind: "bash" | "exec_script" | "python";
  status: string;
  label: string;
  exitCode?: number;
}

function normalizeBgKind(raw: unknown): "bash" | "exec_script" | "python" {
  const k = String(raw || "").trim().toLowerCase();
  if (k === "exec_script" || k === "javascript" || k === "js") return "exec_script";
  if (k === "python" || k === "py") return "python";
  return "bash";
}

function parseBgListJobs(rawText: string, details: any): { jobs: ParsedBgJobItem[] } | null {
  const fromObjArray = (arr: unknown[]): { jobs: ParsedBgJobItem[] } => ({
    jobs: arr
      .filter((it): it is Record<string, any> => Boolean(it && typeof it === "object"))
      .map((it, idx) => ({
        id: String(it.id ?? it.job_id ?? idx + 1),
        kind: normalizeBgKind(it.kind),
        status: String(it.status || "running").toLowerCase(),
        label: String(it.label ?? it.command ?? it.code ?? it.id ?? it.job_id ?? "Background task").trim(),
        ...(typeof it.exit_code === "number"
          ? { exitCode: it.exit_code }
          : typeof it.exitCode === "number"
            ? { exitCode: it.exitCode }
            : {}),
      })),
  });

  if (Array.isArray(details?.jobs)) return fromObjArray(details.jobs);
  if (Array.isArray(details?.tasks)) return fromObjArray(details.tasks);

  const trimmed = (rawText || "").trim();
  if (!trimmed) return null;
  if (/^(?:\(none\b|no (?:active |running )?background\b)/i.test(trimmed)) {
    return { jobs: [] };
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return fromObjArray(parsed);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.jobs)) return fromObjArray(parsed.jobs);
        if (Array.isArray(parsed.tasks)) return fromObjArray(parsed.tasks);
      }
    } catch {
      // fall through to line parser
    }
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const jobs: ParsedBgJobItem[] = [];
  let sawHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (i === 0 && /^(?:background (?:jobs|tasks)|jobs|tasks)\b/i.test(ln)) {
      sawHeader = true;
      continue;
    }
    if (/^\(none\b/i.test(ln)) {
      sawHeader = true;
      continue;
    }
    const bracketMatch = /^(?:[-*•]\s*)?\[([a-z_-]+)\]\s*(\S+)(?:\s*\((bash|exec_script|python)\))?(?:\s*[—:-]\s*(.+))?$/i.exec(ln);
    if (bracketMatch) {
      jobs.push({
        status: bracketMatch[1].toLowerCase(),
        id: bracketMatch[2],
        kind: normalizeBgKind(bracketMatch[3]),
        label: (bracketMatch[4] || bracketMatch[2]).trim(),
      });
      continue;
    }
    const parenMatch = /^(?:[-*•]\s*)?(\S+)\s*\(([^)]+)\)(?:\s*[:—-]\s*(.+))?$/.exec(ln);
    if (parenMatch) {
      const meta = parenMatch[2].split(",").map((s) => s.trim());
      const kindPart = meta.find((m) => /^(?:bash|exec_script|python)$/i.test(m));
      const statusPart = meta.find((m) => /^(?:running|completed|done|failed|exited|cancelled|canceled|stopped)$/i.test(m));
      const exitMatch = meta.map((m) => /^exit\s+(-?\d+)$/i.exec(m)).find(Boolean);
      if (statusPart || kindPart) {
        jobs.push({
          id: parenMatch[1],
          kind: normalizeBgKind(kindPart),
          status: (statusPart || "running").toLowerCase(),
          label: (parenMatch[3] || parenMatch[1]).trim(),
          ...(exitMatch ? { exitCode: Number(exitMatch[1]) } : {}),
        });
        continue;
      }
    }
    return null;
  }
  if (!sawHeader && jobs.length === 0) return null;
  return { jobs };
}

function looksLikeJsonPayload(raw: string): boolean {
  const t = (raw || "").trim();
  if (!(t.startsWith("{") && t.endsWith("}")) && !(t.startsWith("[") && t.endsWith("]"))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function flagBadge(flag: string) {
  if (!flag || flag === "•") return null;
  const color =
    flag === "M"
      ? "bg-warning-subtle text-warning"
      : flag === "A"
        ? "bg-success-subtle text-success"
        : flag === "D" || flag === "R"
          ? "bg-danger-subtle text-danger"
          : "bg-surface-muted text-fg-secondary";
  return (
    <span class={`shrink-0 rounded px-1 py-px font-mono text-[10px] ${color}`}>{flag}</span>
  );
}

function ArrivalSpillBanner(props: { spill: ArrivalSpillInfo }) {
  const sizeBadge = () => {
    const parts: string[] = [];
    if (props.spill.lines !== undefined) {
      parts.push(`${props.spill.lines.toLocaleString()} ${props.spill.lines === 1 ? "line" : "lines"}`);
    }
    const bytesLabel = formatSpillBytes(props.spill.bytes);
    if (bytesLabel) parts.push(bytesLabel);
    return parts.join(" · ");
  };

  return (
    <div
      data-arrival-spill
      class="bg-accent-subtle/40 border-b border-border/60 px-3 py-1.5 text-[11.5px] flex items-center justify-between gap-2 flex-wrap"
    >
      <div class="flex items-center gap-1.5 min-w-0">
        <Iconify icon="lucide:hard-drive-download" size={13} class="shrink-0 text-accent" />
        <span class="text-fg-secondary truncate">
          Full output preserved in{" "}
          <span class="font-mono text-fg">
            {props.spill.fileName ? `brain/${props.spill.fileName}` : "brain/"}
          </span>
        </span>
      </div>
      <Show when={sizeBadge()}>
        <span class="ml-auto shrink-0 rounded border border-border/70 bg-surface px-1.5 py-px font-mono text-[10px] text-fg-muted tabular-nums">
          {sizeBadge()}
        </span>
      </Show>
    </div>
  );
}

export function ToolSearchBodies(props: ToolPartProps) {
  const inspectTree = createMemo(() => {
    if (props.m.name() !== "inspect") return null;
    return parseInspectTree(props.m.terminal().output || props.m.output() || "");
  });
  const globList = createMemo(() => {
    if (props.m.name() !== "glob") return null;
    return parseGlobList(props.m.output() || "");
  });
  const bgListParsed = createMemo(() => {
    if (props.m.name() !== "bg_list") return null;
    return parseBgListJobs(props.m.output() || "", props.u.result?.toolDetails);
  });
  return (
<>
        <Show when={props.m.name() === "search"}>
          <Show
            when={props.m.output() || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Searching…" : null}</div>}
          >
            <div class="px-3 py-1.5 border-b border-border/55 bg-surface/45 text-[11px] text-fg-muted font-mono flex flex-wrap items-center gap-1.5">
              <span class="text-fg">/{String(props.m.args().pattern || "")}/</span>
              <span class="rounded border border-border/70 bg-surface-muted/80 px-1.5 py-px text-[10px] text-fg-secondary">regex</span>
              {props.m.args().path && String(props.m.args().path) !== "." ? <span>in {String(props.m.args().path)}</span> : null}
              {props.m.args().only_matching ? <span class="rounded border border-border/70 bg-surface-muted/80 px-1.5 py-px text-[10px] text-fg-secondary">only-matching</span> : null}
              {props.m.args().count ? <span class="rounded border border-border/70 bg-surface-muted/80 px-1.5 py-px text-[10px] text-fg-secondary">count</span> : null}
              {props.m.args().files_only ? <span class="rounded border border-border/70 bg-surface-muted/80 px-1.5 py-px text-[10px] text-fg-secondary">files-only</span> : null}
            </div>
            <CodeBlock embedded follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.m.output() || props.m.prog() || ""} language={undefined} plain wrap={false} scrollKey={props.m.key()} />
          </Show>
        </Show>
        <Show when={props.m.name() === "inspect"}>
          <Show
            when={props.m.output() || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Listing…" : null}</div>}
          >
            <Show
              when={inspectTree()}
              fallback={
                <CodeBlock embedded follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.m.output() || props.m.prog() || ""} language={undefined} plain wrap={false} scrollKey={props.m.key()} />
              }
            >
              {(t) => (
                <>
                  <div class="px-3 py-1.5 border-b border-border/50 bg-surface/40 font-mono text-[11px] text-fg-muted">
                    {t().scope && t().scope !== "./" ? t().scope : "workspace"} · {t().count} {t().count === 1 ? "entry" : "entries"}
                    {t().capped ? ` (capped at ${t().capped})` : ""}
                  </div>
                  <ul class="px-1.5 py-1">
                    <For each={t().entries}>
                      {(e) => (
                        <li class="flex items-center gap-1.5 rounded-md px-1.5 py-[3px] hover:bg-surface-muted/65 text-[12px] transition-colors">
                          <span style={{ "padding-left": `${e.depth * 14}px` }} class="flex min-w-0 flex-1 items-center gap-1.5">
                            <Show
                              when={e.isDir}
                              fallback={<FileIcon path={e.name} size={13} />}
                            >
                              <Iconify icon="lucide:folder" size={13} class="shrink-0 text-fg-muted" />
                            </Show>
                            <span class="truncate font-mono text-fg">
                              {e.name}
                              {e.isDir ? "/" : ""}
                            </span>
                          </span>
                          {flagBadge(e.flag)}
                          <Show when={e.flag === "•"}>
                            <span class="h-1 w-1 shrink-0 rounded-full bg-fg-muted" />
                          </Show>
                          <Show when={e.size}>
                            <span class="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">
                              {e.size}
                              {e.lines !== undefined ? ` · ${e.lines} lines` : ""}
                              <Show when={e.mtime}>
                                <span class="hidden sm:inline">{" · " + e.mtime}</span>
                              </Show>
                            </span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </>
              )}
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "glob"}>
          <Show
            when={props.m.output() || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Finding files…" : null}</div>}
          >
            <Show
              when={globList()}
              fallback={
                <CodeBlock embedded follow={() => props.m.open() && props.running} text={props.m.output() || props.m.prog() || ""} language={undefined} plain wrap={false} scrollKey={props.m.key()} />
              }
            >
              {(g) => (
                <>
                  <Show
                    when={!g().none}
                    fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">No files matched the pattern.</div>}
                  >
                    <div class="px-3 py-1.5 border-b border-border/50 bg-surface/40 font-mono text-[11px] text-fg-muted tabular-nums">
                      {g().files.length} {g().files.length === 1 ? "file" : "files"}
                    </div>
                    <ul ref={(el) => onCleanup(followTail(el, () => props.m.open() && props.running))} class="px-1.5 py-1">
                      <For each={g().files}>
                        {(f) => (
                          <li class="flex items-center gap-1.5 rounded-md px-1.5 py-[3px] hover:bg-surface-muted/65 text-[12px] transition-colors">
                            <Show when={f.endsWith("/")} fallback={<FileIcon path={f} size={13} />}>
                              <Iconify icon="lucide:folder" size={13} class="shrink-0 text-fg-muted" />
                            </Show>
                            <span class="truncate font-mono text-fg">{f}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={g().truncated}>
                      <p class="px-3 pb-2 text-[10px] text-fg-muted">Truncated: showing first {g().files.length} matches — narrow the pattern</p>
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "search_web"}>
          <Show
            when={props.m.output() || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Searching the web…" : null}</div>}
          >
            <div class="px-3 pt-2 pb-1.5 text-[11px] text-fg-muted">
              <span class="font-mono text-fg">“{String(props.m.args().query || props.m.webDetails()?.query || "")}”</span>
              <Show when={props.m.webDetails()?.cached}><span class="ml-1.5 rounded border border-border/70 bg-surface-muted px-1.5 py-px text-[10px] text-fg-secondary">cached</span></Show>
            </div>
            <Show when={(props.m.webDetails()?.results || []).length > 0} fallback={
              <CodeBlock embedded follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.m.output() || props.m.prog() || ""} language={undefined} plain wrap={false} scrollKey={`${props.m.key()}:results`} />
            }>
              <ol class="px-3 pb-2 space-y-1.5">
                <For each={(props.m.webDetails()?.results || []).slice(0, 10)}>{(r: any, i: () => number) =>
                  <li class="group rounded-lg border border-border/80 bg-surface px-2.5 py-1.5 transition-colors hover:border-border-strong">
                    <a href={String(r.url || "")} target="_blank" rel="noreferrer"
                       class="flex items-baseline gap-1.5 text-[12px] leading-snug">
                      <span class="shrink-0 font-mono text-[10px] text-fg-muted">{i() + 1}.</span>
                      <span class="font-medium text-fg group-hover:text-accent group-hover:underline line-clamp-1">{String(r.title || r.url || "")}</span>
                    </a>
                    <div class="mt-0.5 truncate font-mono text-[10px] text-fg-muted">{String(r.url || "")}</div>
                    <Show when={r.snippet}><p class="mt-0.5 text-[11px] leading-snug text-fg-secondary line-clamp-2">{String(r.snippet)}</p></Show>
                  </li>
                }</For>
              </ol>
              <Show when={(props.m.webDetails()?.results || []).length > 10}>
                <p class="px-3 pb-2 text-[10px] text-fg-muted">+{(props.m.webDetails()?.results || []).length - 10} more matches</p>
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "fetch_url"}>
          <Show
            when={props.m.output() || props.m.prog() || props.m.spill().spilled}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">Fetching {String(props.m.args().url || "URL")}{props.active ? "…" : ""}</div>}
          >
            <Show when={props.m.spill().spilled}>
              <ArrivalSpillBanner spill={props.m.spill()} />
            </Show>
            <div class="px-3 pt-2">
              <a href={String(props.m.fetchDetails()?.url || props.m.args().url || "")} target="_blank" rel="noreferrer"
                 class="flex items-center gap-2 rounded-lg border border-border/80 bg-surface px-2.5 py-2 transition-colors hover:border-border-strong">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-accent/25 bg-accent-subtle font-mono text-[11px] font-medium text-accent">
                  {(props.m.fetchDetails()?.host || "?").slice(0, 1).toUpperCase()}
                </span>
                <span class="min-w-0">
                  <span class="block truncate text-[12px] font-medium text-fg">{String(props.m.fetchDetails()?.title || props.m.fetchDetails()?.host || props.m.args().url || "Article")}</span>
                  <span class="block truncate font-mono text-[10px] text-fg-muted">{String(props.m.fetchDetails()?.host || "")}</span>
                </span>
                <Iconify icon="lucide:external-link" size={12} class="ml-auto shrink-0 text-fg-muted" />
              </a>
            </div>
            <Show when={props.m.fetchDetails()?.content} fallback={
              <div class="border-t border-border/60 mt-2">
                <CodeBlock embedded follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.m.output() || props.m.prog() || ""} language="markdown" plain wrap={false} scrollKey={`${props.m.key()}:content`} />
              </div>
            }>
              <div class="px-3 py-2 text-[12.5px] leading-relaxed text-fg article-body">
                <StreamingMarkdown basic={true}>{extractArrivalSpillInfo(String(props.m.fetchDetails()?.content || "")).cleanBody}</StreamingMarkdown>
              </div>
              <Show when={props.m.fetchDetails()?.truncated && !props.m.spill().spilled}>
                <p class="px-3 pb-1 text-[10px] text-fg-muted">Truncated</p>
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "bg_check" || props.m.name() === "bg_tail"}>
          {/* The task's command/code above the log (envelope command=): the
              label is the raw command for bash and the code for
              exec_script — same two-part layout as the bash body. */}
          <Show
            when={String(((props.u.result?.toolDetails as any)?.env?.command || "") as string)}
            fallback={
              <Show when={props.m.args().job_id || (props.u.result?.toolDetails as any)?.env?.status}>
                <div class="flex items-center justify-between gap-2 border-b border-border/55 bg-surface/45 px-3 py-1.5 text-[11px]">
                  <span class="font-mono text-fg-secondary truncate">
                    {String(props.m.args().job_id || "background task")}
                  </span>
                  <Show when={(props.u.result?.toolDetails as any)?.env?.status}>
                    <span class="shrink-0 rounded border border-border/70 bg-surface-muted px-1.5 py-px font-mono text-[10px] text-fg-secondary">
                      {String((props.u.result?.toolDetails as any)?.env?.status)}
                    </span>
                  </Show>
                </div>
              </Show>
            }
          >
            <div class="border-b border-border/60 bg-surface/50">
              <CodeBlock
                embedded
                text={String(((props.u.result?.toolDetails as any)?.env?.command || "") as string)}
                language={(() => {
                  const k = String(((props.u.result?.toolDetails as any)?.env?.kind || "") as string);
                  return k === "exec_script" ? "javascript" : k === "python" ? "python" : "bash";
                })()}
                wrap={false}
                scrollKey={`${props.m.key()}:cmd`}
              />
            </div>
          </Show>
          <Show
            when={props.m.output() || props.m.prog()}
            fallback={
              <div class="px-3 py-2 text-[11px] text-fg-muted">
                {String((props.u.result?.toolDetails as any)?.env?.info || "") ||
                  (props.active ? "Reading background task…" : "No log output yet.")}
              </div>
            }
          >
            {/* Log output: numbered, plain, unwrapped. Metadata sits in the footer. */}
            <CodeBlock embedded numbered follow={() => props.m.open() && props.running} text={props.m.output() || props.m.prog() || ""} language={undefined} plain wrap={false} scrollKey={props.m.key()} />
          </Show>
        </Show>
        <Show when={props.m.name() === "bg_list"}>
          <Show
            when={bgListParsed()}
            fallback={
              <Show
                when={props.m.output() || props.m.prog()}
                fallback={
                  <div class="px-3 py-2 text-[11px] text-fg-muted">
                    {props.active ? "Checking background jobs…" : "No background jobs in this session."}
                  </div>
                }
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
            {(list) => (
              <>
                <div class="px-3 py-1.5 border-b border-border/50 bg-surface/40 font-mono text-[11px] text-fg-muted tabular-nums">
                  background jobs · {list().jobs.length} {list().jobs.length === 1 ? "job" : "jobs"}
                </div>
                <Show
                  when={list().jobs.length > 0}
                  fallback={<div class="px-3 py-2 text-[11.5px] text-fg-muted">No background jobs in this session.</div>}
                >
                  <ul class="px-1.5 py-1">
                    <For each={list().jobs}>
                      {(job) => {
                        const isRunning = () => job.status === "running";
                        const isFailed = () =>
                          job.status === "failed" ||
                          (typeof job.exitCode === "number" && job.exitCode !== 0 && !isRunning());
                        const isDone = () =>
                          job.status === "completed" || job.status === "done" || (job.status === "exited" && !isFailed());
                        return (
                          <li class="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-surface-muted/65 text-[12px] transition-colors">
                            <div class="flex items-center gap-1.5 min-w-0 flex-1">
                              <Iconify
                                icon={
                                  job.kind === "exec_script"
                                    ? "mdi:language-javascript"
                                    : job.kind === "python"
                                      ? "mdi:language-python"
                                      : "lucide:terminal"
                                }
                                size={13}
                                class="shrink-0 text-fg-muted"
                              />
                              <span class="truncate font-mono text-fg">{job.label}</span>
                            </div>
                            <div class="flex items-center gap-1.5 shrink-0">
                              <Show when={typeof job.exitCode === "number" && !isRunning()}>
                                <span class="font-mono text-[10px] text-fg-muted tabular-nums">exit {job.exitCode}</span>
                              </Show>
                              <span
                                class={`rounded border px-1.5 py-px font-mono text-[10px] ${
                                  isRunning()
                                    ? "border-accent/35 bg-accent-subtle text-accent"
                                    : isFailed()
                                      ? "border-danger/35 bg-danger-subtle text-danger"
                                      : isDone()
                                        ? "border-success/35 bg-success-subtle text-success"
                                        : "border-border/70 bg-surface-muted text-fg-secondary"
                                }`}
                              >
                                {job.status}
                              </span>
                            </div>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Show>
              </>
            )}
          </Show>
        </Show>
        <Show when={props.m.name() === "bg_cancel" && !props.m.running()}>
          {(() => {
            const isErr = () => Boolean(props.u.result?.isError || (props.u.result?.toolDetails as any)?.env?.error);
            const alreadyDone = () =>
              Boolean(
                (props.u.result?.toolDetails as any)?.cancelled === false ||
                  (props.u.result?.toolDetails as any)?.env?.cancelled === false ||
                  (props.u.result?.toolDetails as any)?.env?.cancelled === "false",
              );
            return (
              <div class="flex items-center justify-between gap-2 px-3 py-2 text-[11.5px]">
                <div class="flex items-center gap-2 min-w-0">
                  <Iconify
                    icon={isErr() ? "lucide:alert-circle" : alreadyDone() ? "lucide:info" : "lucide:square"}
                    size={13}
                    class={`shrink-0 ${isErr() ? "text-danger" : "text-fg-muted"}`}
                  />
                  <span class={`truncate ${isErr() ? "text-danger" : "text-fg-secondary"}`}>
                    {isErr()
                      ? props.m.output() || String((props.u.result?.toolDetails as any)?.env?.error || "Failed to cancel background task.")
                      : alreadyDone()
                        ? props.m.output() || "Background task already finished."
                        : "Background task canceled."}
                  </span>
                </div>
                <span
                  class={`shrink-0 rounded border px-1.5 py-px font-mono text-[10px] ${
                    isErr()
                      ? "border-danger/35 bg-danger-subtle text-danger"
                      : "border-border/70 bg-surface-muted text-fg-secondary"
                  }`}
                >
                  {isErr() ? "failed" : alreadyDone() ? "finished" : "canceled"}
                </span>
              </div>
            );
          })()}
        </Show>
        <Show when={(props.m.name() === "exec_script" || props.m.name() === "python") && props.m.spill().spilled && !props.m.bgRunning()}>
          <ArrivalSpillBanner spill={props.m.spill()} />
        </Show>
        <Show when={props.m.name() === "bash"}>
          <Show when={props.m.spill().spilled && !props.m.bgRunning()}>
            <ArrivalSpillBanner spill={props.m.spill()} />
          </Show>
          <div class="border-b border-border/60 bg-surface/50">
            <CodeBlock embedded text={props.m.bashHeaderCmd()} language="bash" wrap={false} maxH="max-h-40" scrollKey={`${props.m.key()}:cmd`} />
          </div>
          <Show
            when={props.m.output() || props.m.prog() || props.m.bgRunning() || props.m.bgStream()}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Running…" : null}</div>}
          >
            <CodeBlock embedded
              follow={() => props.m.open() && props.running}
              text={props.m.bgRunning()
                ? (props.m.bgStream() || props.m.prog() || "Running in background…")
                : props.m.output() || props.m.prog() || "No output"}
              language={undefined}
              plain
              wrap={false}
              scrollKey={`${props.m.key()}:out`}
            />
          </Show>
        </Show>
        <Show when={!isDaemonBuiltinTool(props.m.name())}>
          <Show
            when={props.m.output() || props.m.prog() || props.m.bgRunning() || props.m.bgStream()}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.ctx.pendingApproval()?.callId === props.u.call?.toolId ? "Waiting for approval…" : props.active ? "Running…" : null}</div>}
          >
            {(() => {
              const text = () => props.m.output() || props.m.prog() || "";
              const isJson = () => looksLikeJsonPayload(text());
              return (
                <CodeBlock
                  embedded
                  follow={() => props.m.open() && props.running}
                  text={text()}
                  language={isJson() ? "json" : undefined}
                  plain={!isJson()}
                  wrap={false}
                  scrollKey={props.m.key()}
                />
              );
            })()}
          </Show>
        </Show>
</>
  );
}
