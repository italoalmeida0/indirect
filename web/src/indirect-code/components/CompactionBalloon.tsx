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
    <div class="w-full my-3 select-text">
      {/* Minimal horizontal timeline divider */}
      <div class="flex items-center gap-3">
        <div class="h-px flex-1 bg-border/65" />
        <button
          type="button"
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => setExpanded(!expanded())}
          class="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface-subtle px-2.5 py-1 text-[11px] text-fg-secondary hover:text-fg hover:border-border-strong transition-colors cursor-pointer"
        >
          <Iconify icon="lucide:archive" size={11} class="text-fg-muted shrink-0" />
          <span class="font-medium">Context Compacted</span>
          <Show when={count() > 0}>
            <span class="font-mono text-[10px] text-fg-muted">#{count()}</span>
          </Show>
          <Show when={isSplitTurn()}>
            <span class="text-[10px] text-fg-muted">· Split Turn</span>
          </Show>
          <Show when={hasUsage()}>
            <span class="hidden sm:inline font-mono text-[10px] text-fg-muted tabular-nums">
              · {compactTokens(inTok())}→{compactTokens(outTok())}
            </span>
          </Show>
          <Show when={!expanded() && previewSnippet()}>
            <span class="sr-only">{previewSnippet()}</span>
          </Show>
          <Iconify
            icon="lucide:chevron-right"
            size={11}
            class={`text-fg-muted transition-transform duration-150 ${expanded() ? "rotate-90" : ""}`}
          />
        </button>
        <div class="h-px flex-1 bg-border/65" />
      </div>

      {/* Expanded Summary Sheet */}
      <DisclosureBody open={expanded()}>
        <div class="mt-2.5 rounded-xl border border-border/75 bg-surface-subtle/60 p-3.5 space-y-3">
          <div class="flex items-center justify-between gap-2 text-[11px] text-fg-muted">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono tabular-nums">
              <Show when={hasUsage()}>
                <span>In {compactTokens(inTok())}</span>
                <Show when={cacheTok() > 0}>
                  <span>Cache {compactTokens(cacheTok())}</span>
                </Show>
                <span>Out {compactTokens(outTok())}</span>
                <Show when={reasoningTok() > 0}>
                  <span>Think {compactTokens(reasoningTok())}</span>
                </Show>
                <Show when={costUsd() > 0}>
                  <span>${costUsd().toFixed(4)}</span>
                </Show>
              </Show>
            </div>
            <Show when={cleanedSummary()}>
              <button
                type="button"
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={handleCopy}
                class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                data-rc-tip={copied() ? "Copied" : "Copy summary"}
                aria-label="Copy compaction summary"
              >
                <Iconify icon={copied() ? "lucide:check" : "lucide:copy"} size={12} class={copied() ? "text-success" : ""} />
                <span>{copied() ? "Copied" : "Copy"}</span>
              </button>
            </Show>
          </div>

          <Show when={hasFiles()}>
            <div class="space-y-1.5 text-[11px] border-t border-border/55 pt-2.5">
              <Show when={modifiedFiles().length > 0}>
                <div class="flex items-start gap-2">
                  <span class="text-fg-muted shrink-0 pt-0.5">Modified</span>
                  <div class="flex flex-wrap gap-1">
                    <For each={modifiedFiles()}>
                      {(file) => (
                        <span data-rc-tip={file} class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-border/70 text-fg-secondary font-mono text-[10px]">
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
                  <span class="text-fg-muted shrink-0 pt-0.5">Read</span>
                  <div class="flex flex-wrap gap-1">
                    <For each={readFiles()}>
                      {(file) => (
                        <span data-rc-tip={file} class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-border/70 text-fg-secondary font-mono text-[10px]">
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

          <Show
            when={cleanedSummary()}
            fallback={
              <div class="text-xs text-fg-muted italic">No summary text available.</div>
            }
          >
            <div class="rc-markdown text-xs max-h-96 overflow-y-auto border-t border-border/55 pt-2.5">
              <StreamingMarkdown class="text-xs">{cleanedSummary()}</StreamingMarkdown>
            </div>
          </Show>
        </div>
      </DisclosureBody>
    </div>
  );
}
