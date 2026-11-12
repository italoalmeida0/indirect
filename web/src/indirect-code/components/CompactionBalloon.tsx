import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { DisclosureBody } from "./Disclosure";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { FileIcon } from "../presentation";
import { baseNameOf } from "../transcript";
import { compactTokens } from "../context";
import { copyWithToast } from "../../ui";
import type {
  CompactionState,
  FoldBlockFailedCommand,
  FoldBlockInfo,
} from "../types";

export interface CompactionBalloonProps {
  compaction?: CompactionState | null;
  summary?: string;
  hasOlderAbove?: boolean;
}

const MAX_HEADER_FILES = 8;
const SPLIT_TURN_MARKER = "**Turn Context (split turn):**";

/** Strips synthetic <system-reminder> tags and ## Context Summary (compacted) wrappers. */
export function sanitizeCompactionSummary(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/<\/?system-reminder>/gi, "")
    .replace(/^[ \t]*## Context Summary \(compacted\)[^\r\n]*(?:\r?\n|$)/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strips markdown formatting for the screen-reader collapsed preview snippet. */
export function stripCompactionPreviewMarkdown(cleaned: string): string {
  return cleaned
    .replace(/^#+\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/^[-\s*]{3,}$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Filters active (non-retired) FoldBlocks in chronological raw-index order. */
export function getActiveFoldBlocks(compaction?: CompactionState | null): FoldBlockInfo[] {
  const blocks = compaction?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  return blocks
    .filter((b): b is FoldBlockInfo => Boolean(b) && !b.retiredByBlockId)
    .sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);
}

function dedupeStrings(lists: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

export interface CompactionViewModel {
  mode: "legacy" | "eras";
  activeBlocks: FoldBlockInfo[];
  retiredBlockCount: number;
  cleanedSummary: string;
  previewText: string;
  copyText: string;
  isSplitTurn: boolean;
  headerModifiedFiles: string[];
  headerReadFiles: string[];
  totalRawTokens: number;
  totalBlockTokens: number;
}

/** Resolves legacy vs multi-era LSM presentation model without Solid dependencies. */
export function resolveCompactionViewModel(
  compaction?: CompactionState | null,
  summaryOverride?: string,
): CompactionViewModel {
  const allBlocks = Array.isArray(compaction?.blocks) ? compaction.blocks : [];
  const activeBlocks = summaryOverride ? [] : getActiveFoldBlocks(compaction);
  const retiredBlockCount = summaryOverride
    ? 0
    : allBlocks.filter((b) => Boolean(b?.retiredByBlockId)).length;
  const cleanedSummary = sanitizeCompactionSummary(
    summaryOverride || compaction?.previousSummary || "",
  );

  const mode: "legacy" | "eras" = activeBlocks.length > 0 ? "eras" : "legacy";
  const blockBodies = activeBlocks.map((b) => sanitizeCompactionSummary(b.summary));

  const isSplitTurn =
    cleanedSummary.includes(SPLIT_TURN_MARKER) ||
    blockBodies.some((body) => body.includes(SPLIT_TURN_MARKER));

  const previewSource =
    cleanedSummary || blockBodies.filter(Boolean).join(" ");
  const previewText = stripCompactionPreviewMarkdown(previewSource);

  const copyText =
    mode === "eras"
      ? activeBlocks
          .map((b, idx) => {
            const body = blockBodies[idx] || "";
            const title = `### ${b.id}${b.topic ? ` — ${b.topic}` : ""} (msgs #${b.startIdx}–#${b.endIdx})`;
            return body ? `${title}\n\n${body}` : title;
          })
          .join("\n\n") || cleanedSummary
      : cleanedSummary;

  const cumulativeModified = dedupeStrings([
    compaction?.modifiedFiles,
    ...activeBlocks.map((b) => b.modifiedFiles),
  ]);
  const cumulativeRead = dedupeStrings([
    compaction?.readFiles,
    ...activeBlocks.map((b) => b.readFiles),
  ]);

  let headerModifiedFiles = cumulativeModified;
  let headerReadFiles = cumulativeRead;
  if (mode === "eras" && activeBlocks.length === 1) {
    // Single active era is expanded by default: avoid repeating identical file chips twice.
    const singleMod = new Set(activeBlocks[0]!.modifiedFiles || []);
    const singleRead = new Set(activeBlocks[0]!.readFiles || []);
    headerModifiedFiles = cumulativeModified.filter((f) => !singleMod.has(f));
    headerReadFiles = cumulativeRead.filter((f) => !singleRead.has(f));
  }

  let totalRawTokens = 0;
  let totalBlockTokens = 0;
  for (const b of activeBlocks) {
    if ((b.rawTokens ?? 0) > 0) totalRawTokens += b.rawTokens!;
    if ((b.blockTokens ?? 0) > 0) totalBlockTokens += b.blockTokens!;
  }

  return {
    mode,
    activeBlocks,
    retiredBlockCount,
    cleanedSummary,
    previewText,
    copyText,
    isSplitTurn,
    headerModifiedFiles,
    headerReadFiles,
    totalRawTokens,
    totalBlockTokens,
  };
}

export function formatFailedCommandTip(cmd: FoldBlockFailedCommand): string {
  const parts = [cmd.command.trim()];
  if (cmd.exitCode != null && String(cmd.exitCode).trim() !== "") {
    parts.push(`exit ${String(cmd.exitCode).trim()}`);
  }
  if (cmd.firstError?.trim()) {
    parts.push(cmd.firstError.trim());
  }
  return parts.filter(Boolean).join(" · ");
}

function FileChipGroup(props: {
  label: string;
  files: string[];
  maxVisible?: number;
}) {
  const visibleFiles = () =>
    props.maxVisible && props.files.length > props.maxVisible
      ? props.files.slice(0, props.maxVisible)
      : props.files;
  const hiddenFiles = () =>
    props.maxVisible && props.files.length > props.maxVisible
      ? props.files.slice(props.maxVisible)
      : [];

  return (
    <Show when={props.files.length > 0}>
      <div class="flex items-start gap-2">
        <span class="text-fg-muted shrink-0 pt-0.5">{props.label}</span>
        <div class="flex flex-wrap gap-1 min-w-0">
          <For each={visibleFiles()}>
            {(file) => (
              <span
                data-rc-tip={file}
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-border/70 text-fg-secondary font-mono text-[10px]"
              >
                <FileIcon path={file} size={11} />
                <span>{baseNameOf(file)}</span>
              </span>
            )}
          </For>
          <Show when={hiddenFiles().length > 0}>
            <span
              data-rc-tip={hiddenFiles().join(", ")}
              class="inline-flex items-center px-1.5 py-0.5 rounded bg-surface-subtle border border-border/70 text-fg-muted font-mono text-[10px] tabular-nums"
            >
              +{hiddenFiles().length} more
            </span>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function EraTimelineSection(props: {
  block: FoldBlockInfo;
  open: boolean;
  onToggle: () => void;
}) {
  const eraSummary = createMemo(() => sanitizeCompactionSummary(props.block.summary));
  const modFiles = () => props.block.modifiedFiles || [];
  const rdFiles = () => props.block.readFiles || [];
  const failedCmds = () => props.block.failedCommands || [];
  const sourceIds = () => props.block.sourceBlockIds || [];
  const activatedTools = () => props.block.activatedTools || [];
  const isMergedTier = () => (props.block.tier ?? 1) >= 2;
  const hasTokenPair = () =>
    (props.block.rawTokens ?? 0) > 0 && (props.block.blockTokens ?? 0) > 0;
  const hasSingleBlockTok = () =>
    !hasTokenPair() && (props.block.blockTokens ?? 0) > 0;
  const hasMetaRows = () =>
    sourceIds().length > 0 ||
    modFiles().length > 0 ||
    rdFiles().length > 0 ||
    activatedTools().length > 0 ||
    failedCmds().length > 0;

  return (
    <div class="rounded-lg border border-border/75 bg-surface/75 overflow-hidden transition-colors">
      <button
        type="button"
        aria-expanded={props.open}
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={() => props.onToggle()}
        class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-muted/50 transition-colors cursor-pointer min-w-0"
      >
        <Iconify
          icon="lucide:chevron-right"
          size={12}
          class={`shrink-0 text-fg-muted transition-transform duration-150 ${props.open ? "rotate-90" : ""}`}
        />
        <span class="inline-flex items-center rounded px-1.5 py-px font-mono text-[10px] font-medium bg-surface-muted text-fg border border-border/80 shrink-0">
          {props.block.id}
        </span>
        <Show when={isMergedTier()}>
          <span
            data-rc-tip={
              sourceIds().length > 0
                ? `Tier ${props.block.tier} rollup merged from ${sourceIds().join(", ")}`
                : `Tier ${props.block.tier} merged rollup`
            }
            class="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium bg-accent-subtle text-accent border border-accent/25 shrink-0"
          >
            Tier {props.block.tier} · Merged
          </span>
        </Show>
        <span class="font-mono text-[10px] text-fg-muted tabular-nums shrink-0">
          msgs #{props.block.startIdx}–#{props.block.endIdx}
        </span>
        <Show when={props.block.topic?.trim()}>
          <span
            data-rc-tip={props.block.topic}
            class="text-[11px] font-medium text-fg truncate min-w-0"
          >
            {props.block.topic}
          </span>
        </Show>

        <span class="ml-auto flex items-center gap-1.5 shrink-0">
          <Show when={failedCmds().length > 0}>
            <span
              data-rc-tip={`${failedCmds().length} failed ${failedCmds().length === 1 ? "command" : "commands"} in era ${props.block.id}`}
              class="inline-flex items-center gap-1 rounded-full px-1.5 py-px font-mono text-[10px] bg-warning-subtle text-warning border border-warning/25 tabular-nums"
            >
              <Iconify icon="lucide:alert-circle" size={10} class="shrink-0" />
              <span>{failedCmds().length}</span>
            </span>
          </Show>
          <Show when={hasTokenPair()}>
            <span
              data-rc-tip={`Compressed ${props.block.rawTokens!.toLocaleString()} raw tokens into ${props.block.blockTokens!.toLocaleString()} summary tokens`}
              class="inline-flex items-center gap-1 rounded-full bg-surface-subtle border border-border/75 px-1.5 py-px font-mono text-[10px] text-fg-muted tabular-nums"
            >
              {compactTokens(props.block.rawTokens!)} → {compactTokens(props.block.blockTokens!)}
            </span>
          </Show>
          <Show when={hasSingleBlockTok()}>
            <span class="inline-flex items-center rounded-full bg-surface-subtle border border-border/75 px-1.5 py-px font-mono text-[10px] text-fg-muted tabular-nums">
              {compactTokens(props.block.blockTokens!)}
            </span>
          </Show>
        </span>
      </button>

      <DisclosureBody open={props.open}>
        <div class="border-t border-border/55 bg-surface-subtle/35 px-3 py-2.5 space-y-2">
          <Show when={hasMetaRows()}>
            <div class="space-y-1.5 text-[11px]">
              <Show when={sourceIds().length > 0}>
                <div class="flex items-start gap-2">
                  <span class="text-fg-muted shrink-0 pt-0.5">Merged</span>
                  <div class="flex flex-wrap gap-1">
                    <For each={sourceIds()}>
                      {(srcId) => (
                        <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-surface border border-border/70 text-fg-muted font-mono text-[10px]">
                          {srcId}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <FileChipGroup label="Modified" files={modFiles()} />
              <FileChipGroup label="Read" files={rdFiles()} />

              <Show when={activatedTools().length > 0}>
                <div class="flex items-start gap-2">
                  <span class="text-fg-muted shrink-0 pt-0.5">Tools</span>
                  <div class="flex flex-wrap gap-1">
                    <For each={activatedTools()}>
                      {(tool) => (
                        <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-surface border border-border/70 text-fg-secondary font-mono text-[10px]">
                          {tool}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={failedCmds().length > 0}>
                <div class="flex items-start gap-2">
                  <span class="text-warning shrink-0 pt-0.5">Failed</span>
                  <div class="flex flex-wrap gap-1 min-w-0">
                    <For each={failedCmds()}>
                      {(cmd) => (
                        <span
                          data-rc-tip={formatFailedCommandTip(cmd)}
                          class="inline-flex items-center gap-1.5 max-w-full px-1.5 py-0.5 rounded bg-warning-subtle border border-warning/25 text-fg font-mono text-[10px]"
                        >
                          <Iconify icon="lucide:alert-circle" size={11} class="text-warning shrink-0" />
                          <span class="truncate max-w-[200px]">{cmd.command}</span>
                          <Show when={cmd.exitCode != null && String(cmd.exitCode).trim() !== ""}>
                            <span class="text-warning shrink-0">exit {cmd.exitCode}</span>
                          </Show>
                          <Show when={cmd.firstError?.trim()}>
                            <span class="text-fg-muted truncate max-w-[220px]">
                              · {cmd.firstError}
                            </span>
                          </Show>
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          <Show
            when={eraSummary()}
            fallback={
              <div class="text-xs text-fg-muted italic">No summary text available.</div>
            }
          >
            <div
              class={`rc-markdown text-xs max-h-80 overflow-y-auto ${
                hasMetaRows() ? "border-t border-border/50 pt-2" : ""
              }`}
            >
              <StreamingMarkdown class="text-xs">{eraSummary()}</StreamingMarkdown>
            </div>
          </Show>
        </div>
      </DisclosureBody>
    </div>
  );
}

export function CompactionBalloon(props: CompactionBalloonProps) {
  const [expanded, setExpanded] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [eraOpenOverrides, setEraOpenOverrides] = createSignal<Record<string, boolean>>({});

  const viewModel = createMemo(() =>
    resolveCompactionViewModel(props.compaction, props.summary),
  );
  const activeBlocks = () => viewModel().activeBlocks;
  const retiredBlockCount = () => viewModel().retiredBlockCount;
  const isEraMode = () => viewModel().mode === "eras";
  const cleanedSummary = () => viewModel().cleanedSummary;
  const copyText = () => viewModel().copyText;
  const previewSnippet = () => viewModel().previewText;
  const isSplitTurn = () => viewModel().isSplitTurn;

  const usage = () => props.compaction?.usage;
  const inTok = () => usage()?.input_tokens ?? 0;
  const outTok = () => usage()?.output_tokens ?? 0;
  const cacheTok = () =>
    (usage()?.cache_read_tokens ?? 0) +
    (usage()?.cache_write_tokens ?? 0);
  const reasoningTok = () => usage()?.reasoning_tokens ?? 0;
  const costUsd = () => usage()?.cost_usd ?? 0;

  const hasUsage = () => inTok() > 0 || outTok() > 0;
  const totalRawTok = () => viewModel().totalRawTokens;
  const totalBlockTok = () => viewModel().totalBlockTokens;
  const hasBlockTokRatio = () => totalRawTok() > 0 && totalBlockTok() > 0;

  const headerModifiedFiles = () => viewModel().headerModifiedFiles;
  const headerReadFiles = () => viewModel().headerReadFiles;
  const hasHeaderFiles = () =>
    headerModifiedFiles().length > 0 || headerReadFiles().length > 0;

  const count = () => props.compaction?.count ?? 0;

  const isEraOpen = (id: string, isLatest: boolean): boolean => {
    const ov = eraOpenOverrides()[id];
    return ov !== undefined ? ov : isLatest;
  };

  const allErasExpanded = createMemo(() => {
    const blocks = activeBlocks();
    const overrides = eraOpenOverrides();
    if (blocks.length === 0) return false;
    return blocks.every((b, idx) => {
      const ov = overrides[b.id];
      return ov !== undefined ? ov : idx === blocks.length - 1;
    });
  });

  function toggleEra(id: string, isLatest: boolean) {
    setEraOpenOverrides((prev) => ({
      ...prev,
      [id]: !isEraOpen(id, isLatest),
    }));
  }

  function toggleAllEras(e: MouseEvent) {
    e.stopPropagation();
    const blocks = activeBlocks();
    const nextOpen = !allErasExpanded();
    const next: Record<string, boolean> = {};
    for (const b of blocks) next[b.id] = nextOpen;
    setEraOpenOverrides(next);
  }

  function handleCopy(e: MouseEvent) {
    e.stopPropagation();
    const text = copyText();
    if (!text) return;
    copyWithToast(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div class="w-full my-3 select-text">
      <Show when={props.hasOlderAbove}>
        <div
          data-compaction-boundary-caption
          class="mb-1.5 flex items-center justify-center gap-1.5 px-2 text-center text-[10.5px] text-fg-muted border-border/60"
        >
          <span>
            Context boundary · earlier turns above are folded into eras and searchable via{" "}
            <span class="font-mono text-fg-secondary">session_history</span>
          </span>
        </div>
      </Show>
      {/* Minimal horizontal timeline divider */}
      <div class="flex items-center gap-3">
        <div class="h-px flex-1 bg-border/65" />
        <button
          type="button"
          aria-expanded={expanded()}
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => setExpanded(!expanded())}
          class="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface-subtle px-2.5 py-1 text-[11px] text-fg-secondary hover:text-fg hover:border-border-strong transition-colors cursor-pointer"
        >
          <Iconify icon="lucide:archive" size={11} class="text-fg-muted shrink-0" />
          <span class="font-medium">Context Compacted</span>
          <Show when={activeBlocks().length > 1}>
            <span class="rounded-full bg-accent-subtle px-1.5 py-px font-mono text-[10px] text-accent tabular-nums">
              {activeBlocks().length} eras
            </span>
          </Show>
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
          <Show when={!hasUsage() && hasBlockTokRatio()}>
            <span class="hidden sm:inline font-mono text-[10px] text-fg-muted tabular-nums">
              · {compactTokens(totalRawTok())}→{compactTokens(totalBlockTok())}
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
          <div class="flex items-center justify-between gap-2 text-[11px] text-fg-muted flex-wrap">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono tabular-nums">
              <Show when={isEraMode()}>
                <span class="font-sans font-medium text-fg-secondary">
                  {activeBlocks().length} {activeBlocks().length === 1 ? "era" : "eras"}
                </span>
                <Show when={retiredBlockCount() > 0}>
                  <span
                    data-rc-tip={`${retiredBlockCount()} earlier Tier 1 ${retiredBlockCount() === 1 ? "block" : "blocks"} merged into Tier 2 rollups`}
                    class="text-fg-muted"
                  >
                    ({retiredBlockCount()} merged)
                  </span>
                </Show>
              </Show>
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
              <Show when={!hasUsage() && hasBlockTokRatio()}>
                <span>
                  {compactTokens(totalRawTok())} → {compactTokens(totalBlockTok())}
                </span>
              </Show>
            </div>

            <div class="flex items-center gap-1 ml-auto shrink-0">
              <Show when={activeBlocks().length > 1}>
                <button
                  type="button"
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={toggleAllEras}
                  data-rc-tip={allErasExpanded() ? "Collapse all eras" : "Expand all eras"}
                  class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                >
                  <Iconify
                    icon={allErasExpanded() ? "lucide:chevrons-down-up" : "lucide:chevrons-up-down"}
                    size={12}
                  />
                  <span>{allErasExpanded() ? "Collapse all" : "Expand all"}</span>
                </button>
              </Show>
              <Show when={copyText()}>
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
          </div>

          <Show when={hasHeaderFiles()}>
            <div class="space-y-1.5 text-[11px] border-t border-border/55 pt-2.5">
              <FileChipGroup
                label="Modified"
                files={headerModifiedFiles()}
                maxVisible={isEraMode() ? MAX_HEADER_FILES : undefined}
              />
              <FileChipGroup
                label="Read"
                files={headerReadFiles()}
                maxVisible={isEraMode() ? MAX_HEADER_FILES : undefined}
              />
            </div>
          </Show>

          <Show
            when={isEraMode()}
            fallback={
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
            }
          >
            <div class="space-y-2 border-t border-border/55 pt-2.5">
              <For each={activeBlocks()}>
                {(block, idx) => {
                  const isLatest = () => idx() === activeBlocks().length - 1;
                  return (
                    <EraTimelineSection
                      block={block}
                      open={isEraOpen(block.id, isLatest())}
                      onToggle={() => toggleEra(block.id, isLatest())}
                    />
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </DisclosureBody>
    </div>
  );
}
