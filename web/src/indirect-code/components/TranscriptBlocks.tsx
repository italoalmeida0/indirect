import { createEffect, createMemo, For, Show, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { press } from "../../ds/motion/press";
import { createShimmerStyle } from "../../ds/motion/shimmer";
import { createDisclosure, DisclosureBody, DisclosureTrigger } from "./Disclosure";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { followTail } from "../utils/scrollMemory";
import { Icon as Iconify } from "../../components/icon";
import type { ChatMessage, ContentBlock, RenderBlock, RenderBlockSeries, ToolUnit, TurnEntry } from "../types";
import { partitionToolSegs } from "../utils/toolSegs";
import type { ToolSeg } from "../utils/toolSegs";
import { groupTitle, specialTitle } from "../utils/titles";
import { isBlockRunning, groupToolRuns } from "../utils/blockRuns";
import { formatDurationSecs } from "../utils/format";
import { useToolUnitModel } from "./tool/toolUnitModel";
import { ToolUnitHeader } from "./tool/ToolUnitHeader";
import { ToolBody } from "./tool/ToolBody";
import { sharedBlobUrlCache } from "../utils/blobUrlCache";


/** Reactive transcript state shared by aggregate rows. */
export interface TranscriptRenderCtx {
  renderBlocks: () => RenderBlock[];
  sessionStatus: () => string;
  isPinned?: () => boolean;
  messages: () => ChatMessage[];
  thinkingStart: () => number | null;
  thinkingElapsed: () => number;
  toolProgress: () => Record<string, string>;
  elapsedLabel: (ms: number) => string;
  specialProgress: (units: ToolUnit[]) => string | undefined;
  thinkingIndex: () => number;
  verboseChat: () => boolean;
  hideToolMessages: () => boolean;
  setPreviewFile: (v: import("../types").PreviewFile | null) => void;
  turnClock: () => number;
  toolStarts: () => Record<string, number>;
  activeSession: () => import("../types").SessionSummary | null;
  activeSessionId?: () => string;
  pendingApproval: () => import("../types").PendingApproval | null;
  projects: () => import("../types").Project[];
  /** Live background job registry — lets bash/exec_script rows keep spinning
   * and streaming after their detach, independent of the turn. */
  backgroundJobs: () => import("../hooks/useBackground").BgTask[];
  /** Per-job streamed output (bg_output chunks + bg_tail seed). */
  bgOutput: () => Record<string, string>;
  /** 1s ticker while any job runs, for elapsed labels. */
  bgClock: () => number;
  /** Optional daemon command sender for lazy CAS blob resolution (`get_blob`). */
  send?: (payload: import("../daemon-protocol").DaemonCommand) => void;
}

/** Thinking as a tool-style row: header (label + timer, no icon) with an
 * incremental Markdown body. Open by default while the turn runs, closed after —
 * unless the user toggled it explicitly. */
function renderThinkingRow(
  ctx: TranscriptRenderCtx,
  entry: Extract<TurnEntry, { kind: "thinking" }>,
  openByDefault: () => boolean,
  hidden: () => boolean,
  live: () => boolean,
  streaming: () => boolean,
  running: () => boolean,
  suppressHeader: () => boolean = () => false,
) {
  const key = `${entry.msg.id}:think:${entry.nth}`;
  const { open, toggle } = createDisclosure(() => `${running()}:${live()}`, openByDefault, ctx.isPinned);
  const shimmerStyle = createShimmerStyle(live);
  const effectiveOpen = () => (suppressHeader() ? true : open());
  const label = () =>
    live()
      ? `Thinking ${formatDurationSecs(ctx.thinkingElapsed())}`
      : entry.msg.thinkingDuration !== undefined
        ? `Thought ${formatDurationSecs(entry.msg.thinkingDuration)}`
        : open()
          ? "Hide thinking"
          : "Thought";
  return (
    <div class="w-full flex flex-col" style={hidden() ? { display: "none" } : undefined} data-thinking-row={key}>
      <Show when={!suppressHeader()}>
        <DisclosureTrigger
          open={open()}
          aria-expanded={open()}
          aria-label={label()}
          onClick={toggle}
          class="text-xs"
        >
          <span class={`truncate min-w-0 tabular-nums ${live() ? "ui-shimmer font-medium text-fg-secondary" : "text-fg-muted group-hover/disc:text-fg-secondary"}`} style={shimmerStyle()}>{label()}</span>
        </DisclosureTrigger>
      </Show>
      <DisclosureBody open={effectiveOpen()} keepMounted={running()}>
        <div
          ref={(el) => onCleanup(followTail(el, () => effectiveOpen() && streaming()))}
          class={`rc-markdown w-full text-xs leading-relaxed break-words overflow-x-auto overflow-y-auto max-h-64 ${suppressHeader() ? "pl-0" : "pl-5"} py-1 text-fg-muted`}
        >
          <StreamingMarkdown basic streaming={streaming()} active={effectiveOpen() && !hidden()}>
            {entry.block.reasoning || "(thinking…)"}
          </StreamingMarkdown>
        </div>
      </DisclosureBody>
    </div>
  );
}

/**
 * The turn aggregate: one card per contiguous tool execution/thinking run.
 * Open by default while the turn runs, closed once it ends — unless toggled explicitly.
 * Questions stay collapsed here; the questionnaire renders separately.
 */
function renderTurnAggregate(
  ctx: TranscriptRenderCtx,
  series: RenderBlockSeries,
) {
  // NOTE: ctx.renderBlocks() is the FULL list (sealed blocks + live
  // tail; the <For> in TranscriptView slices by seal); the running turn
  // is always the newest block, which always renders.
  const running = createMemo(() => isBlockRunning(ctx.renderBlocks(), series, ctx.sessionStatus()));
  const summary = createMemo(() => specialTitle(series.units, {
    thoughts: series.entries.filter((e) => e.kind === "thinking").length,
  }));
  const { open, toggle } = createDisclosure(() => String(running()), running, ctx.isPinned);
  const lastTurnId = () => series.extras.at(-1)?.id ?? series.msg.id;
  /** Live tail: the turn's latest call, or any call with live progress
   * (parallel in-flight). Only the tail spins/auto-opens; when a new
   * entry arrives the previous one falls back to closed on its own. */
  const tailCall = () => [...series.units].reverse().find((u) => u.call) ?? null;
  const isActive = (u: ToolUnit) =>
    running() && !u.result && !!u.call?.toolId && (
      ctx.toolStarts()[u.call.toolId] != null || ctx.toolProgress()[u.call.toolId] != null ||
      ctx.pendingApproval()?.callId === u.call.toolId ||
      ((series.extras.at(-1) ?? series.msg).streaming === true &&
        (series.extras.at(-1) ?? series.msg).blocks.some((b) => b.toolId === u.call?.toolId) &&
        u.call.toolId === tailCall()?.call?.toolId));
  const isPending = (u: ToolUnit) => running() && !u.result && !!u.call?.toolId &&
    (series.extras.at(-1) ?? series.msg).blocks.some((b) => b.type === "tool_call" && b.toolId === u.call?.toolId);
  const lastEntryIdx = () => (series.entries?.length ?? 0) - 1;
  /** A stale thinking timer (snapshot restart mid-tools) must not spin:
   * live only while the turn's tail is still thinking. */
  const tailIsThinking = () => series.entries?.[lastEntryIdx()]?.kind === "thinking";
  const thinkingHidden = () => !ctx.verboseChat();
  const visibleRuns = createMemo(() => groupToolRuns(series.entries));
  const onlyThinking = createMemo(() => series.entries.every((e) => e.kind === "thinking") && series.units.length === 0);
  const singleThinking = createMemo(() => onlyThinking() && series.entries.length === 1);
  const singleThinkingEntry = () => {
    const first = series.entries[0];
    return singleThinking() && first?.kind === "thinking" ? first : undefined;
  };
  const singleThinkingLive = () => {
    const e = singleThinkingEntry();
    return Boolean(e && tailIsThinking() && running() && e.isNewest && e.msg.id === lastTurnId() && ctx.thinkingStart() !== null);
  };
  const headerShimmerActive = createMemo(() => (singleThinking() ? singleThinkingLive() : running()));
  const shimmerStyle = createShimmerStyle(headerShimmerActive);
  const headerLabel = () => {
    const e = singleThinkingEntry();
    if (e) {
      if (singleThinkingLive()) return `Thinking ${formatDurationSecs(ctx.thinkingElapsed())}`;
      return e.msg.thinkingDuration !== undefined
        ? `Thought ${formatDurationSecs(e.msg.thinkingDuration)}`
        : "Thought";
    }
    return summary();
  };
  return (
    <div class="w-full flex flex-col my-0.5" style={onlyThinking() && thinkingHidden() ? { display: "none" } : undefined}>
      <DisclosureTrigger
        open={open()}
        aria-expanded={open()}
        onClick={toggle}
        data-step-rail-header=""
        chevronSize={13}
        class="text-xs text-fg-muted hover:text-fg"
      >
        <span class={`truncate min-w-0 tabular-nums ${headerShimmerActive() ? "ui-shimmer font-medium text-fg-secondary" : ""}`} style={shimmerStyle()}>
          {headerLabel()}
        </span>
        <Show when={ctx.specialProgress(series.units)}>
          {(t) => (
            <span class="font-mono text-2xs text-fg-muted truncate max-w-[40%] sm:max-w-[14rem]">
              {t()}
            </span>
          )}
        </Show>
      </DisclosureTrigger>
      <DisclosureBody open={open() && !(onlyThinking() && thinkingHidden())} keepMounted={running()}>
        <div class="ml-[6.5px] mt-1 mb-1.5 pl-[12.5px] border-l border-border space-y-0.5">
          <For each={series.entries}>
            {(entry, ei) => {
              const tail = () => ei() === lastEntryIdx();
              if (entry.kind === "tools") {
                return renderToolSegs(ctx, entry.msg.id, () => visibleRuns().get(entry.id) ?? [], running, isActive, isPending);
              }
              if (entry.kind === "thinking") {
                // Stale snapshot restarts must not spin: live only while
                // the tail is still thinking AND the clock is actually on.
                const live = () => tail() && tailIsThinking() && running() && entry.isNewest &&
                  entry.msg.id === lastTurnId() && ctx.thinkingStart() !== null;
                const content = () => (entry.block.reasoning || "").trim() !== "";
                return renderThinkingRow(ctx, entry, () => (live() && content()) || (open() && onlyThinking()), thinkingHidden, live, live, running, singleThinking);
              }
              return renderImageBlock(ctx, entry.block);
            }}
          </For>
        </div>
      </DisclosureBody>
    </div>
  );
}

/** Assistant content: series renders aggregate (if any) + message text together in one balloon. */
export function AssistantTurnContent(props: { ctx: TranscriptRenderCtx; block: RenderBlock; finished: boolean }) {
  return (
    <Show when={props.block.kind === "series" ? props.block : undefined}
      fallback={renderSingleAssistant(props.ctx, props.block.msg)}>
      {(series) => (
        <div data-assistant-message={series().textMsg?.id || series().msg.id} class="w-full space-y-2.5">
          <Show when={series().entries.length > 0}>
            {renderTurnAggregate(props.ctx, series())}
          </Show>
          <Show when={series().textMsg}>
            {(textMsg) => (
              <For each={textMsg().blocks.filter((b) => b.type === "image" || (b.type === "text" && !!b.text?.trim()))}>
                {(block) => block.type === "image" ? renderImageBlock(props.ctx, block) : (
                  <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto">
                    <StreamingMarkdown streaming={textMsg().streaming}>{block.text}</StreamingMarkdown>
                  </div>
                )}
              </For>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Plain assistant bubble for turns with no tools and no thinking. */
function renderSingleAssistant(ctx: TranscriptRenderCtx, msg: ChatMessage) {
  return (
    <div data-assistant-message={msg.id} class="w-full space-y-2.5">
      <For each={msg.blocks.filter((b) => b.type === "image" || (b.type === "text" && !!b.text?.trim()))}>
        {(block) => block.type === "image" ? renderImageBlock(ctx, block) : (
          <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto">
            <StreamingMarkdown streaming={msg.streaming}>{block.text}</StreamingMarkdown>
          </div>
        )}
      </For>
    </div>
  );
}


function renderImageBlock(ctx: TranscriptRenderCtx, block: ContentBlock) {
  const src = () =>
    sharedBlobUrlCache.resolveImageBlock(
      block,
      ctx.send,
      ctx.activeSessionId?.() || ctx.activeSession()?.id,
    ) ||
    (block.imageData ? `data:${block.imageMime || "image/jpeg"};base64,${block.imageData}` : undefined);
  return (
    <Show
      when={src()}
      fallback={
        <div class="flex items-center gap-1.5 text-2xs text-fg-muted border border-border rounded-control px-2.5 py-1.5">
          <Iconify icon="lucide:image" size={12} />
          <span>{block.imageSha256 && ctx.send ? "Loading image…" : `[attached ${block.text || "image"}]`}</span>
        </div>
      }
    >
      <button
        type="button"
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={() =>
          ctx.setPreviewFile({
            name: "attached image",
            mime: block.imageMime || "image/jpeg",
            dataUrl: src(),
          })
        }
        class="block rounded-control overflow-hidden border border-border hover:border-border-strong transition-colors cursor-pointer"
        data-rc-tip="Open preview" aria-label="Open preview"
      >
        <img src={src()} class="max-h-64 max-w-full object-contain" />
      </button>
    </Show>
  );
}

/**
 * Per-run collapsible sub-groups (explore/command runs) inside the
 * aggregate card. Same grouping as before, keyed on the series card so
 * state never collides across fused messages.
 */
function renderToolSegs(ctx: TranscriptRenderCtx, msgId: string, units: () => ToolUnit[], running: () => boolean, isActive: (u: ToolUnit) => boolean = running, isPending = isActive) {
  // Partition consecutive explore/command runs into collapsible groups
  // (pure helper — algorithm lives in utils/toolSegs, covered by tests).
  const [state, setState] = createStore<{ segs: (ToolSeg & { id: string })[] }>({ segs: [] });
  createEffect(() => setState("segs", reconcile(
    partitionToolSegs(units(), true).map((seg) => ({ ...seg, id: segKey(seg) })), { merge: true },
  )));
  // Key by the first call so a growing subgroup retains its DOM and scroll.
  const segKey = (seg: ToolSeg) =>
    seg.kind === "unit"
      ? `u:${seg.unit.call?.toolId || seg.unit.result?.toolId || "i" + seg.idx}`
      : `g:${seg.cat}:${seg.units[0]?.call?.toolId || seg.units[0]?.result?.toolId || "0"}`;
  return (
    <div class="w-full space-y-0.5" style={{ "overflow-anchor": "none" }}>
      <For each={state.segs}>
        {(seg) => {
          if (seg.kind === "unit")
            return (
              <div data-toolseg={segKey(seg)} style={{ "overflow-anchor": "none" }}>
                {renderToolUnit(ctx, msgId, seg.unit, seg.idx, running, () => isActive(seg.unit))}
              </div>
            );
          const active = () => running() && seg.units.some(isPending);
          // Sub-groups open while they hold live work; a finished group
          // (and its rows) falls back to closed on its own.
          const { open, toggle } = createDisclosure(() => `${running()}:${active()}`, active, ctx.isPinned);
          return (
            <div class="w-full flex flex-col" data-toolseg={segKey(seg)} style={{ "overflow-anchor": "none" }}>
              <Show when={seg.units.length > 1}>
                <DisclosureTrigger
                  open={open()}
                  aria-expanded={open()}
                  onClick={toggle}
                  class="text-xs text-fg-muted hover:text-fg"
                >
                  <span class="truncate min-w-0">{groupTitle(seg.cat, seg.units)}</span>
                </DisclosureTrigger>
              </Show>
              <DisclosureBody open={seg.units.length === 1 || open()} keepMounted={running()}>
                <div class={seg.units.length > 1 ? "ml-[6.5px] border-l border-border-subtle pl-[12.5px] space-y-0.5 mt-0.5" : "space-y-0.5"} style={{ "overflow-anchor": "none" }}>
                  <For each={seg.units}>
                    {(u) => {
                      // Keep fallback keys relative to the complete tool run.
                      const gi = units().findIndex((item) => item.call?.toolId === u.call?.toolId);
                      return renderToolUnit(ctx, msgId, u, gi >= 0 ? gi : 0, running, () => isActive(u));
                    }}
                  </For>
                </div>
              </DisclosureBody>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function renderToolUnit(ctx: TranscriptRenderCtx, msgId: string, u: ToolUnit, ui: number, running: () => boolean, active: () => boolean) {
  const m = useToolUnitModel(ctx, msgId, u, ui, running, active);
  const part = { ctx, msgId, u, m, get running() { return running(); }, get active() { return active(); } };
  return (
    <div class="w-full flex flex-col">
      <ToolUnitHeader {...part} />
      <DisclosureBody open={m.openBody()} keepMounted={running()}>
        <ToolBody {...part} />
      </DisclosureBody>
    </div>
  );
}
