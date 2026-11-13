import { For, Show, createMemo } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { compactTokens } from "../../context";
import { FileIcon } from "../../presentation";
import {
  latestExploreProgress,
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
  if (norm === "user") return "bg-accent-subtle text-accent border-border-subtle";
  if (norm === "assistant") return "bg-surface border-border text-fg-secondary";
  return "bg-surface-muted border-border-subtle text-fg-muted";
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
          <div data-tool-context="explore" class="overflow-visible min-w-0 max-w-full">
            <div class="bg-surface-subtle border-b border-border-subtle px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-1.5 min-w-0">
                <Iconify icon="lucide:compass" size={13} class="shrink-0 text-accent" />
                <span class="text-xs font-medium text-fg-secondary">
                  {!props.u.result && props.active ? "Investigating…" : "Read-only investigation"}
                </span>
                <Show when={view().turnCapReached}>
                  <span class="inline-flex items-center gap-1 rounded-pill border border-border-subtle bg-warning-subtle px-1.5 py-px font-mono text-2xs font-medium text-warning">
                    turn cap
                  </span>
                </Show>
              </div>
              <div class="flex items-center gap-1.5 flex-wrap font-mono text-2xs text-fg-muted tabular-nums ml-auto">
                <Show when={view().turns !== undefined}>
                  <span class="rounded-xs border border-border bg-surface px-1.5 py-px">
                    {view().turns} {view().turns === 1 ? "turn" : "turns"}
                  </span>
                </Show>
                <Show when={view().toolCalls !== undefined}>
                  <span class="rounded-xs border border-border bg-surface px-1.5 py-px">
                    {view().toolCalls} {view().toolCalls === 1 ? "tool call" : "tool calls"}
                  </span>
                </Show>
                <Show when={(view().inputTokens ?? 0) > 0 || (view().outputTokens ?? 0) > 0}>
                  <span class="rounded-xs border border-border bg-surface px-1.5 py-px">
                    {compactTokens(view().inputTokens ?? 0)} + {compactTokens(view().outputTokens ?? 0)} tok
                  </span>
                </Show>
              </div>
            </div>

            <Show when={view().task || view().focusPaths.length > 0}>
              <div class="border-b border-border-subtle bg-surface px-3 py-2 space-y-1.5 min-w-0">
                <Show when={view().task}>
                  <p class="text-xs text-fg-secondary leading-snug [overflow-wrap:anywhere] break-words">{view().task}</p>
                </Show>
                <Show when={view().focusPaths.length > 0}>
                  <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                    <For each={view().focusPaths}>
                      {(p) => (
                        <span class="inline-flex items-center gap-1 min-w-0 max-w-full rounded-xs border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-2xs text-fg-secondary">
                          <FileIcon path={p} size={12} />
                          <span class="truncate">{p}</span>
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
                <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
                  {props.m.rawOutput() || String(props.m.mergedEnv()?.error || "Explore subagent failed.")}
                </div>
              }
            >
              <Show
                when={Boolean(props.u.result)}
                fallback={
                  <div class="px-3 py-2 flex items-center gap-2 text-xs text-fg-muted min-w-0">
                    <Show when={props.active}>
                      <span class="w-3.5 h-3.5 ui-spinner text-accent shrink-0" />
                    </Show>
                    <span class="font-mono truncate">
                      {latestExploreProgress(props.m.prog()) ||
                        (props.active ? "Running isolated read-only subagent…" : "Investigation did not complete.")}
                    </span>
                  </div>
                }
              >
                <div class="px-3 py-2 text-xs leading-relaxed text-fg rc-markdown min-w-0 max-w-full [overflow-wrap:anywhere] break-words">
                  <StreamingMarkdown basic={false} noNestedScroll>
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
          <div data-tool-context="session-history" class="overflow-visible min-w-0 max-w-full">
            <Show
              when={view().action === "recall"}
              fallback={(() => {
                const sv = () => view() as SessionHistorySearchView;
                return (
                  <>
                    <div class="bg-surface-subtle border-b border-border-subtle px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap">
                      <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                        <Iconify icon="lucide:history" size={13} class="shrink-0 text-accent" />
                        <span class="text-xs font-medium text-fg-secondary">BM25 history search</span>
                        <Show when={sv().query}>
                          <span class="rounded-xs border border-border bg-surface px-1.5 py-px font-mono text-2xs text-fg truncate max-w-full sm:max-w-[18rem]">
                            {sv().query}
                          </span>
                        </Show>
                        <span class="rounded-xs border border-border-subtle bg-surface-muted px-1.5 py-px font-mono text-2xs text-fg-secondary">
                          {sv().includeLiveTail ? "compacted + live" : "compacted"}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5 flex-wrap font-mono text-2xs text-fg-muted tabular-nums ml-auto shrink-0">
                        <Show when={props.u.result && !props.u.result.isError && sv().hitCountKnown}>
                          <span>
                            {sv().hitCount} {sv().hitCount === 1 ? "match" : "matches"}
                          </span>
                        </Show>
                        <Show when={sv().indexed !== undefined}>
                          <span class="text-fg-muted">
                            {props.u.result && !props.u.result.isError && sv().hitCountKnown ? "· " : ""}
                            {sv().indexed} indexed
                          </span>
                        </Show>
                      </div>
                    </div>

                    <Show
                      when={!props.u.result?.isError}
                      fallback={
                        <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
                          {props.m.rawOutput() || String(props.m.mergedEnv()?.error || "History search failed.")}
                        </div>
                      }
                    >
                      <Show
                        when={sv().hits.length > 0}
                        fallback={
                          <div class="px-3 py-2 text-xs text-fg-muted [overflow-wrap:anywhere] break-words">
                            {sv().rawText ||
                              (!props.u.result
                                ? props.active
                                  ? "Searching compacted history…"
                                  : "History search did not complete."
                                : "No matching history entries.")}
                          </div>
                        }
                      >
                        <ul class="divide-y divide-border-subtle">
                          <For each={sv().hits}>
                            {(hit) => (
                              <li class="px-3 py-2 hover:bg-surface-muted/40 transition-colors min-w-0">
                                <div class="flex items-center justify-between gap-2 flex-wrap">
                                  <div class="flex items-center gap-1.5 min-w-0 flex-wrap text-xs">
                                    <span class="font-mono text-2xs text-fg-muted tabular-nums">
                                      #{hit.rank}
                                    </span>
                                    <Show
                                      when={hit.kind === "block"}
                                      fallback={
                                        <>
                                          <span class="rounded-xs border border-border bg-surface px-1.5 py-px font-mono text-2xs font-medium text-fg tabular-nums">
                                            msg #{hit.msgIdx ?? 0}
                                          </span>
                                          <span
                                            class={`rounded-xs border px-1.5 py-px font-mono text-2xs ${roleBadgeClass(hit.role)}`}
                                          >
                                            {hit.role || "message"}
                                          </span>
                                          <Show when={hit.blockId}>
                                            <span class="rounded-xs border border-border-subtle bg-surface-subtle px-1.5 py-px font-mono text-2xs text-fg-muted">
                                              era {hit.blockId}
                                            </span>
                                          </Show>
                                        </>
                                      }
                                    >
                                      <span class="rounded-xs border border-border bg-surface-muted px-1.5 py-px font-mono text-2xs font-medium text-fg">
                                        {hit.blockId || "block"}
                                      </span>
                                      <span
                                        class={`rounded-pill border px-1.5 py-px font-mono text-2xs font-medium ${
                                          (hit.tier ?? 1) >= 2
                                            ? "bg-accent-subtle text-accent border-border-subtle"
                                            : "bg-surface border-border text-fg-secondary"
                                        }`}
                                      >
                                        Tier {hit.tier ?? 1}
                                      </span>
                                      <Show when={hit.retiredBy}>
                                        <span class="rounded-xs border border-border-subtle bg-surface-subtle px-1.5 py-px font-mono text-2xs text-fg-muted">
                                          retired → {hit.retiredBy}
                                        </span>
                                      </Show>
                                      <Show when={hit.startIdx !== undefined && hit.endIdx !== undefined}>
                                        <span class="font-mono text-2xs text-fg-muted tabular-nums">
                                          msgs #{hit.startIdx}–#{hit.endIdx}
                                        </span>
                                      </Show>
                                      <Show when={hit.topic}>
                                        <span class="text-xs font-medium text-fg truncate max-w-full sm:max-w-[18rem]">
                                          {hit.topic}
                                        </span>
                                      </Show>
                                    </Show>
                                  </div>
                                  <span class="ml-auto shrink-0 font-mono tabular-nums text-2xs text-fg-muted">
                                    score {hit.score.toFixed(2)}
                                  </span>
                                </div>

                                <Show when={hit.snippet}>
                                  <p class="mt-1 text-xs leading-relaxed text-fg-secondary font-mono [overflow-wrap:anywhere] break-words">
                                    <For each={splitHighlightSegments(hit.snippet, sv().query)}>
                                      {(seg) =>
                                        seg.match ? (
                                          <mark class="bg-accent-subtle text-fg rounded-xs px-0.5 font-medium">
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
                    <div class="bg-surface-subtle border-b border-border-subtle px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap">
                      <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                        <Iconify icon="lucide:book-open" size={13} class="shrink-0 text-accent" />
                        <span class="text-xs font-medium text-fg-secondary">Verbatim history recall</span>
                        <Show when={rv().blockId}>
                          <span class="rounded-xs border border-border bg-surface-muted px-1.5 py-px font-mono text-2xs font-medium text-fg">
                            era {rv().blockId}
                          </span>
                        </Show>
                        <Show when={rv().startMsg !== undefined}>
                          <span class="rounded-xs border border-border bg-surface px-1.5 py-px font-mono text-2xs text-fg-secondary tabular-nums">
                            {rv().endMsg !== undefined && rv().endMsg !== rv().startMsg
                              ? `msgs #${rv().startMsg}–#${rv().endMsg}`
                              : `msg #${rv().startMsg}`}
                          </span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-1.5 flex-wrap font-mono text-2xs text-fg-muted tabular-nums ml-auto shrink-0">
                        <Show when={windowLabel()}>
                          <span>{windowLabel()}</span>
                        </Show>
                        <Show when={rv().truncated}>
                          <span class="rounded-xs border border-border-subtle bg-accent-subtle px-1.5 py-px font-mono text-2xs font-medium text-accent">
                            paginated
                          </span>
                        </Show>
                      </div>
                    </div>

                    <Show
                      when={!props.u.result?.isError}
                      fallback={
                        <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
                          {props.m.rawOutput() || String(props.m.mergedEnv()?.error || "History recall failed.")}
                        </div>
                      }
                    >
                      <Show
                        when={Boolean(props.u.result) || Boolean(rv().cleanText)}
                        fallback={
                          <div class="px-3 py-2 text-xs text-fg-muted">
                            {props.active ? "Recalling verbatim transcript…" : "History recall did not complete."}
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
                              text={rv().cleanText.trim() ? rv().cleanText : "(empty recall)"}
                              scrollKey={props.m.key()}
                            />
                          }
                        >
                          <div class="divide-y divide-border-subtle min-w-0">
                            <For each={rv().messages}>
                              {(m) => (
                                <div class="overflow-visible min-w-0">
                                  <div class="bg-surface-subtle border-b border-border-subtle px-3 py-1 flex items-center gap-2 flex-wrap text-xs">
                                    <span class="font-mono text-2xs font-medium text-fg tabular-nums">
                                      msg #{m.msgIdx}
                                    </span>
                                    <span
                                      class={`rounded-xs border px-1.5 py-px font-mono text-2xs ${roleBadgeClass(m.role)}`}
                                    >
                                      {m.role}
                                    </span>
                                    <Show when={m.blockId}>
                                      <span class="rounded-xs border border-border-subtle bg-surface px-1.5 py-px font-mono text-2xs text-fg-muted">
                                        block {m.blockId}
                                      </span>
                                    </Show>
                                  </div>
                                  <CodeBlock
                                    embedded
                                    plain
                                    wrap={true}
                                    text={m.content.trim() ? m.content : "(empty message)"}
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
        <Show
          when={!props.u.result?.isError}
          fallback={
            <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
              {props.m.rawOutput() || String(props.m.mergedEnv()?.error || "Summary failed.")}
            </div>
          }
        >
          <div
            data-tool-context="summary"
            class="px-3 py-2 text-xs leading-relaxed text-fg-secondary rc-markdown min-w-0 max-w-full [overflow-wrap:anywhere] break-words"
          >
            <StreamingMarkdown basic={true} noNestedScroll>
              {String(props.m.args().for_user || props.m.output() || "").trim() ||
                (!props.u.result
                  ? props.active
                    ? "Recording progress checkpoint…"
                    : "Progress checkpoint did not complete."
                  : "Progress checkpoint recorded.")}
            </StreamingMarkdown>
          </div>
        </Show>
      </Show>

      <Show when={props.m.name() === "finish_entire_request"}>
        <Show
          when={!props.u.result?.isError}
          fallback={
            <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
              {props.m.rawOutput() || String(props.m.mergedEnv()?.error || "Failed to finish response.")}
            </div>
          }
        >
          <div
            data-tool-context="finish-entire-request"
            class="px-3 py-2 text-xs leading-relaxed text-fg rc-markdown min-w-0 max-w-full [overflow-wrap:anywhere] break-words"
          >
            <StreamingMarkdown basic={true} noNestedScroll>
              {String(props.m.args().final_message_to_user || props.m.output() || "").trim() ||
                (!props.u.result
                  ? props.active
                    ? "Composing final response…"
                    : "Final response did not complete."
                  : "Final response delivered.")}
            </StreamingMarkdown>
          </div>
        </Show>
      </Show>
    </>
  );
}
