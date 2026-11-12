import { For, Show, createMemo } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { compactTokens } from "../../context";
import { FileIcon } from "../../presentation";
import {
  parseExploreView,
  parseSessionHistoryView,
  splitHighlightSegments,
  type SessionHistoryRecallView,
  type SessionHistorySearchView,
} from "../../utils/contextTools";
import { stripToolEnvelopeDetailed } from "../../utils/envelope";
import { CodeBlock } from "../CodeBlock";
import { StreamingMarkdown } from "../StreamingMarkdown";
import type { ToolPartProps } from "./toolUnitModel";

function roleBadgeClass(role?: string): string {
  const norm = (role || "").trim().toLowerCase();
  if (norm === "user") return "bg-accent-subtle text-accent border-accent/25";
  if (norm === "assistant") return "bg-surface border-border/70 text-fg-secondary";
  return "bg-surface-muted border-border/65 text-fg-muted";
}

function formatRecallWindow(rv: SessionHistoryRecallView): string | undefined {
  if (rv.totalChars === undefined || rv.totalChars < 0) return undefined;
  const offset = rv.offsetChars ?? 0;
  if (offset > 0 || rv.truncated) {
    const end =
      rv.nextOffset !== undefined
        ? rv.nextOffset
        : Math.min(rv.totalChars, offset + rv.cleanText.length);
    return `${offset.toLocaleString()}..${end.toLocaleString()} / ${rv.totalChars.toLocaleString()} chars`;
  }
  return `${rv.totalChars.toLocaleString()} chars`;
}

export function ToolContextBodies(props: ToolPartProps) {
  const mergedDetails = () => {
    const raw = props.u.result?.toolResult || "";
    const d = props.u.result?.toolDetails as any;
    if (!raw.includes("<tool_result")) return d;
    const stripped = stripToolEnvelopeDetailed(raw);
    if (Object.keys(stripped.attrs).length === 0) return d;
    return {
      ...(d && typeof d === "object" ? d : {}),
      env: { ...stripped.attrs, ...(d?.env || {}) },
    };
  };

  const exploreView = createMemo(() => {
    if (props.m.name() !== "explore") return null;
    return parseExploreView(props.m.args(), props.m.rawOutput(), mergedDetails());
  });

  const historyView = createMemo(() => {
    if (props.m.name() !== "session_history") return null;
    return parseSessionHistoryView(props.m.args(), props.m.rawOutput(), mergedDetails());
  });

  return (
    <>
      <Show when={props.m.name() === "explore" && exploreView()}>
        {(view) => (
          <div data-tool-context="explore" class="overflow-visible">
            <div class="bg-surface/50 border-b border-border/60 px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-1.5 min-w-0">
                <Iconify icon="lucide:compass" size={13} class="shrink-0 text-accent/85" />
                <span class="text-[11.5px] font-medium text-fg-secondary">
                  {!props.u.result && props.active ? "Investigating…" : "Read-only investigation"}
                </span>
                <Show when={view().turnCapReached}>
                  <span class="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning-subtle px-1.5 py-px font-mono text-[10px] font-medium text-warning">
                    turn cap
                  </span>
                </Show>
              </div>
              <div class="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-muted tabular-nums ml-auto">
                <Show when={view().turns !== undefined}>
                  <span class="rounded border border-border/70 bg-surface px-1.5 py-px">
                    {view().turns} {view().turns === 1 ? "turn" : "turns"}
                  </span>
                </Show>
                <Show when={view().toolCalls !== undefined}>
                  <span class="rounded border border-border/70 bg-surface px-1.5 py-px">
                    {view().toolCalls} {view().toolCalls === 1 ? "tool call" : "tool calls"}
                  </span>
                </Show>
                <Show when={(view().inputTokens ?? 0) > 0 || (view().outputTokens ?? 0) > 0}>
                  <span class="rounded border border-border/70 bg-surface px-1.5 py-px">
                    {compactTokens(view().inputTokens ?? 0)} + {compactTokens(view().outputTokens ?? 0)} tok
                  </span>
                </Show>
              </div>
            </div>

            <Show when={view().task || view().focusPaths.length > 0}>
              <div class="border-b border-border/50 bg-surface-subtle/45 px-3 py-2 space-y-1.5">
                <Show when={view().task}>
                  <p class="text-[12px] text-fg-secondary leading-snug break-words">{view().task}</p>
                </Show>
                <Show when={view().focusPaths.length > 0}>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <For each={view().focusPaths}>
                      {(p) => (
                        <span class="inline-flex items-center gap-1 rounded border border-border/70 bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-fg-secondary">
                          <FileIcon path={p} size={12} />
                          <span>{p}</span>
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <Show
              when={!props.u.result?.isError}
              fallback={
                <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap">
                  {props.m.rawOutput() || "Explore subagent failed."}
                </div>
              }
            >
              <Show
                when={Boolean(props.u.result)}
                fallback={
                  <div class="px-3 py-2.5 flex items-center gap-2 text-[11.5px] text-fg-muted">
                    <Show when={props.active}>
                      <span class="w-3 h-3 border-[1.5px] border-fg-muted/70 border-t-accent rounded-full animate-spin shrink-0" />
                    </Show>
                    <span class="font-mono truncate">
                      {props.m.prog() ||
                        (props.active ? "Running isolated read-only subagent…" : "Pending investigation…")}
                    </span>
                  </div>
                }
              >
                <div class="px-3.5 py-2.5 text-xs leading-relaxed text-fg rc-markdown">
                  <StreamingMarkdown basic={false}>
                    {view().synthesis || "(empty synthesis)"}
                  </StreamingMarkdown>
                </div>
              </Show>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.m.name() === "session_history" && historyView()}>
        {(view) => (
          <div data-tool-context="session-history" class="overflow-visible">
            <Show
              when={view().action === "recall"}
              fallback={(() => {
                const sv = () => view() as SessionHistorySearchView;
                return (
                  <>
                    <div class="bg-surface/50 border-b border-border/60 px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap">
                      <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                        <Iconify icon="lucide:history" size={13} class="shrink-0 text-accent/85" />
                        <span class="text-[11.5px] font-medium text-fg-secondary">BM25 history search</span>
                        <Show when={sv().query}>
                          <span class="rounded border border-border/75 bg-surface px-1.5 py-px font-mono text-[11px] text-fg truncate max-w-[18rem]">
                            {sv().query}
                          </span>
                        </Show>
                        <span class="rounded border border-border/70 bg-surface-muted px-1.5 py-px font-mono text-[10px] text-fg-secondary">
                          {sv().includeLiveTail ? "compacted + live" : "compacted"}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-muted tabular-nums ml-auto shrink-0">
                        <Show when={props.u.result && !props.u.result.isError && sv().hitCountKnown}>
                          <span>
                            {sv().hitCount} {sv().hitCount === 1 ? "match" : "matches"}
                          </span>
                        </Show>
                        <Show when={sv().indexed !== undefined}>
                          <span class="text-fg-muted/80">
                            {props.u.result && !props.u.result.isError && sv().hitCountKnown ? "· " : ""}
                            {sv().indexed} indexed
                          </span>
                        </Show>
                      </div>
                    </div>

                    <Show
                      when={!props.u.result?.isError}
                      fallback={
                        <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap">
                          {props.m.rawOutput() || "History search failed."}
                        </div>
                      }
                    >
                      <Show
                        when={sv().hits.length > 0}
                        fallback={
                          <div class="px-3 py-2 text-[11.5px] text-fg-muted">
                            {sv().rawText ||
                              (props.active ? "Searching compacted history…" : "No matching history entries.")}
                          </div>
                        }
                      >
                        <ul class="divide-y divide-border/50">
                          <For each={sv().hits}>
                            {(hit) => (
                              <li class="px-3 py-2 hover:bg-surface-muted/40 transition-colors">
                                <div class="flex items-center justify-between gap-2 flex-wrap">
                                  <div class="flex items-center gap-1.5 min-w-0 flex-wrap text-[11px]">
                                    <span class="font-mono text-[10.5px] text-fg-muted tabular-nums">
                                      #{hit.rank}
                                    </span>
                                    <Show
                                      when={hit.kind === "block"}
                                      fallback={
                                        <>
                                          <span class="rounded border border-border/80 bg-surface px-1.5 py-px font-mono text-[10.5px] font-medium text-fg tabular-nums">
                                            msg #{hit.msgIdx ?? 0}
                                          </span>
                                          <span
                                            class={`rounded border px-1.5 py-px font-mono text-[10px] ${roleBadgeClass(hit.role)}`}
                                          >
                                            {hit.role || "message"}
                                          </span>
                                          <Show when={hit.blockId}>
                                            <span class="rounded border border-border/70 bg-surface-subtle px-1.5 py-px font-mono text-[10px] text-fg-muted">
                                              era {hit.blockId}
                                            </span>
                                          </Show>
                                        </>
                                      }
                                    >
                                      <span class="rounded border border-border/80 bg-surface-muted px-1.5 py-px font-mono text-[10.5px] font-medium text-fg">
                                        {hit.blockId || "block"}
                                      </span>
                                      <span
                                        class={`rounded-full border px-1.5 py-px font-mono text-[10px] font-medium ${
                                          (hit.tier ?? 1) >= 2
                                            ? "bg-accent-subtle text-accent border-accent/25"
                                            : "bg-surface border-border/70 text-fg-secondary"
                                        }`}
                                      >
                                        Tier {hit.tier ?? 1}
                                      </span>
                                      <Show when={hit.retiredBy}>
                                        <span class="rounded border border-border/65 bg-surface-subtle px-1.5 py-px font-mono text-[10px] text-fg-muted">
                                          retired → {hit.retiredBy}
                                        </span>
                                      </Show>
                                      <Show when={hit.startIdx !== undefined && hit.endIdx !== undefined}>
                                        <span class="font-mono text-[10.5px] text-fg-muted tabular-nums">
                                          msgs #{hit.startIdx}–#{hit.endIdx}
                                        </span>
                                      </Show>
                                      <Show when={hit.topic}>
                                        <span class="text-[11px] font-medium text-fg truncate max-w-[18rem]">
                                          {hit.topic}
                                        </span>
                                      </Show>
                                    </Show>
                                  </div>
                                  <span class="ml-auto shrink-0 font-mono tabular-nums text-[10px] text-fg-muted">
                                    score {hit.score.toFixed(2)}
                                  </span>
                                </div>

                                <Show when={hit.snippet}>
                                  <p class="mt-1 text-[11.5px] leading-relaxed text-fg-secondary font-mono break-words">
                                    <For each={splitHighlightSegments(hit.snippet, sv().query)}>
                                      {(seg) =>
                                        seg.match ? (
                                          <mark class="bg-accent-subtle text-fg rounded px-0.5 font-medium">
                                            {seg.text}
                                          </mark>
                                        ) : (
                                          <span>{seg.text}</span>
                                        )
                                      }
                                    </For>
                                  </p>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </Show>
                  </>
                );
              })()}
            >
              {(() => {
                const rv = () => view() as SessionHistoryRecallView;
                const windowLabel = () => formatRecallWindow(rv());
                return (
                  <>
                    <div class="bg-surface/50 border-b border-border/60 px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap">
                      <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                        <Iconify icon="lucide:book-open" size={13} class="shrink-0 text-accent/85" />
                        <span class="text-[11.5px] font-medium text-fg-secondary">Verbatim history recall</span>
                        <Show when={rv().blockId}>
                          <span class="rounded border border-border/80 bg-surface-muted px-1.5 py-px font-mono text-[10.5px] font-medium text-fg">
                            era {rv().blockId}
                          </span>
                        </Show>
                        <Show when={rv().startMsg !== undefined}>
                          <span class="rounded border border-border/70 bg-surface px-1.5 py-px font-mono text-[10.5px] text-fg-secondary tabular-nums">
                            {rv().endMsg !== undefined && rv().endMsg !== rv().startMsg
                              ? `msgs #${rv().startMsg}–#${rv().endMsg}`
                              : `msg #${rv().startMsg}`}
                          </span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-muted tabular-nums ml-auto shrink-0">
                        <Show when={windowLabel()}>
                          <span>{windowLabel()}</span>
                        </Show>
                        <Show when={rv().truncated}>
                          <span class="rounded border border-accent/25 bg-accent-subtle px-1.5 py-px font-mono text-[10px] font-medium text-accent">
                            paginated
                          </span>
                        </Show>
                      </div>
                    </div>

                    <Show
                      when={!props.u.result?.isError}
                      fallback={
                        <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap">
                          {props.m.rawOutput() || "History recall failed."}
                        </div>
                      }
                    >
                      <Show
                        when={Boolean(props.u.result) || Boolean(rv().cleanText)}
                        fallback={
                          <div class="px-3 py-2 text-[11.5px] text-fg-muted">
                            {props.active ? "Recalling verbatim transcript…" : "Pending recall…"}
                          </div>
                        }
                      >
                        <Show
                          when={rv().messages.length > 0}
                          fallback={
                            <CodeBlock
                              embedded
                              plain
                              wrap={true}
                              text={rv().cleanText || "(empty recall)"}
                              scrollKey={props.m.key()}
                            />
                          }
                        >
                          <div class="divide-y divide-border/55">
                            <For each={rv().messages}>
                              {(m) => (
                                <div class="overflow-visible">
                                  <div class="bg-surface/45 px-3 py-1 flex items-center gap-2 text-[11px]">
                                    <span class="font-mono text-[10.5px] font-medium text-fg tabular-nums">
                                      msg #{m.msgIdx}
                                    </span>
                                    <span
                                      class={`rounded border px-1.5 py-px font-mono text-[10px] ${roleBadgeClass(m.role)}`}
                                    >
                                      {m.role}
                                    </span>
                                    <Show when={m.blockId}>
                                      <span class="rounded border border-border/70 bg-surface-subtle px-1.5 py-px font-mono text-[10px] text-fg-muted">
                                        block {m.blockId}
                                      </span>
                                    </Show>
                                  </div>
                                  <CodeBlock
                                    embedded
                                    plain
                                    wrap={true}
                                    text={m.content}
                                    scrollKey={`${props.m.key()}:m${m.msgIdx}`}
                                  />
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.m.name() === "summary"}>
        <div
          data-tool-context="summary"
          class="px-3.5 py-2.5 text-xs leading-relaxed text-fg-secondary rc-markdown"
        >
          <StreamingMarkdown basic={true}>
            {String(props.m.args().for_user || props.m.output() || "Progress checkpoint recorded.")}
          </StreamingMarkdown>
        </div>
      </Show>

      <Show when={props.m.name() === "finish_entire_request"}>
        <div
          data-tool-context="finish-entire-request"
          class="px-3.5 py-2.5 text-xs leading-relaxed text-fg rc-markdown"
        >
          <StreamingMarkdown basic={true}>
            {String(props.m.args().final_message_to_user || props.m.output() || "Final response delivered.")}
          </StreamingMarkdown>
        </div>
      </Show>
    </>
  );
}
