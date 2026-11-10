import { createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { DisclosureBody } from "./Disclosure";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { FileIcon } from "../presentation";
import { baseNameOf } from "../transcript";
import { compactTokens } from "../context";
import { copyWithToast } from "../../ui";
import type { CompactionState } from "../types";

export interface CompactionBalloonProps {
  compaction?: CompactionState | null;
  summary?: string;
}

export function CompactionBalloon(props: CompactionBalloonProps) {
  const [expanded, setExpanded] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  const rawSummary = () => props.summary || props.compaction?.previousSummary || "";
  const cleanedSummary = () =>
    rawSummary()
      .replace(/^## Context Summary \(compacted\)\n\n/, "")
      .trim();

  const previewSnippet = () =>
    cleanedSummary()
      .replace(/^#+\s+/gm, "")
      .replace(/[*_~`]/g, "")
      .replace(/^[-\s*]{3,}$/gm, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

  const isSplitTurn = () =>
    cleanedSummary().includes("**Turn Context (split turn):**");

  const usage = () => props.compaction?.usage;
  const inTok = () => usage()?.input_tokens ?? 0;
  const outTok = () => usage()?.output_tokens ?? 0;
  const cacheTok = () =>
    (usage()?.cache_read_tokens ?? 0) +
    (usage()?.cache_write_tokens ?? 0);
  const reasoningTok = () => usage()?.reasoning_tokens ?? 0;
  const costUsd = () => usage()?.cost_usd ?? 0;

  const hasUsage = () => inTok() > 0 || outTok() > 0;

  const readFiles = () => props.compaction?.readFiles || [];
  const modifiedFiles = () => props.compaction?.modifiedFiles || [];
  const hasFiles = () => readFiles().length > 0 || modifiedFiles().length > 0;

  const count = () => props.compaction?.count ?? 0;

  function handleCopy(e: MouseEvent) {
    e.stopPropagation();
    const text = cleanedSummary();
    if (!text) return;
    copyWithToast(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div class="w-full flex justify-center my-3 select-text">
      <div class="rc-studio-card w-full max-w-2xl rounded-xl p-3.5 shadow-2xs transition-all">
        {/* Header Bar */}
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setExpanded(!expanded())}
            class="flex items-center gap-2 cursor-pointer text-left group focus:outline-none"
          >
            <div class="flex items-center justify-center w-6 h-6 rounded-lg bg-accent-subtle border border-accent/25 text-accent transition-colors">
              <Iconify icon="lucide:archive" size={13} />
            </div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-xs font-medium text-fg group-hover:text-accent transition-colors">
                Context Compacted
              </span>
              <Show when={count() > 0}>
                <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-surface-subtle text-fg-secondary border border-border">
                  #{count()}
                </span>
              </Show>
              <Show when={isSplitTurn()}>
                <span class="px-2 py-0.5 text-[10px] font-medium rounded-full bg-accent-subtle text-accent border border-accent/25">
                  Split Turn
                </span>
              </Show>
            </div>
          </button>

          {/* Right Action & Metric Pills */}
          <div class="flex items-center gap-1.5">
            <Show when={hasUsage()}>
              <div
                class="hidden sm:flex items-center gap-1.5 text-[11px] font-mono text-fg-secondary bg-surface-subtle px-2 py-0.5 rounded-md border border-border/80"
              >
                <Iconify icon="lucide:cpu" size={11} class="text-fg-muted" />
                <span>
                  {compactTokens(inTok())} in · {compactTokens(outTok())} out
                </span>
                <Show when={costUsd() > 0}>
                  <span class="text-fg-muted">(${costUsd().toFixed(4)})</span>
                </Show>
              </div>
            </Show>

            <Show when={cleanedSummary()}>
              <button
                type="button"
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={handleCopy}
                class="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                aria-label="Copy compaction summary"
              >
                <Iconify icon={copied() ? "lucide:check" : "lucide:copy"} size={13} class={copied() ? "text-success" : ""} />
              </button>
            </Show>

            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => setExpanded(!expanded())}
              class="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
            >
              <span>{expanded() ? "Hide" : "View"}</span>
              <Iconify
                icon={expanded() ? "lucide:chevron-up" : "lucide:chevron-down"}
                size={13}
              />
            </button>
          </div>
        </div>

        {/* Collapsed Snippet */}
        <Show when={!expanded() && previewSnippet()}>
          <div
            onClick={() => setExpanded(true)}
            class="mt-2 text-[11px] text-fg-muted hover:text-fg-secondary line-clamp-2 cursor-pointer select-none leading-relaxed"
          >
            {previewSnippet()}
          </div>
        </Show>

        {/* Expanded Content View */}
        <DisclosureBody open={expanded()}>
          <div class="mt-3 pt-3 border-t border-border/70 space-y-3">
            {/* File Operations Chips */}
            <Show when={hasFiles()}>
              <div class="space-y-2 text-[11px]">
                <Show when={modifiedFiles().length > 0}>
                  <div class="flex items-start gap-2">
                    <span class="text-fg-muted font-medium shrink-0 pt-0.5">Modified:</span>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={modifiedFiles()}>
                        {(file) => (
                          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-subtle border border-border text-fg-secondary font-mono text-[10px]">
                            <FileIcon path={file} size={11} />
                            <span>{baseNameOf(file)}</span>
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
                <Show when={readFiles().length > 0}>
                  <div class="flex items-start gap-2">
                    <span class="text-fg-muted font-medium shrink-0 pt-0.5">Read:</span>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={readFiles()}>
                        {(file) => (
                          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-subtle border border-border text-fg-secondary font-mono text-[10px]">
                            <FileIcon path={file} size={11} />
                            <span>{baseNameOf(file)}</span>
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Token Usage Details Bar */}
            <Show when={hasUsage()}>
              <div class="rc-studio-well flex flex-wrap items-center gap-x-4 gap-y-1 p-2.5 rounded-lg font-mono text-[11px] text-fg-secondary">
                <div>
                  <span class="text-fg-muted mr-1">Input:</span>
                  <span class="text-fg font-medium">{compactTokens(inTok())}</span>
                </div>
                <Show when={cacheTok() > 0}>
                  <div>
                    <span class="text-fg-muted mr-1">Cache:</span>
                    <span class="text-fg font-medium">{compactTokens(cacheTok())}</span>
                  </div>
                </Show>
                <div>
                  <span class="text-fg-muted mr-1">Output:</span>
                  <span class="text-fg font-medium">{compactTokens(outTok())}</span>
                </div>
                <Show when={reasoningTok() > 0}>
                  <div>
                    <span class="text-fg-muted mr-1">Reasoning:</span>
                    <span class="text-fg font-medium">{compactTokens(reasoningTok())}</span>
                  </div>
                </Show>
                <Show when={costUsd() > 0}>
                  <div class="border-l border-border pl-3">
                    <span class="text-fg-muted mr-1">Cost:</span>
                    <span class="text-fg font-medium">${costUsd().toFixed(4)}</span>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Markdown Summary Content */}
            <Show
              when={cleanedSummary()}
              fallback={
                <div class="text-xs text-fg-muted italic">No summary text available.</div>
              }
            >
              <div class="rc-markdown text-xs max-h-96 overflow-y-auto px-1 py-0.5">
                <StreamingMarkdown class="text-xs">{cleanedSummary()}</StreamingMarkdown>
              </div>
            </Show>
          </div>
        </DisclosureBody>
      </div>
    </div>
  );
}
