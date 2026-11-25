import { MentionMenu } from "./MentionMenu";
import { batch, createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { reducedMotion } from "../../ds/motion/reduced";
import { CompactionBalloon } from "./CompactionBalloon";
import { FileIcon } from "../presentation";
import { elapsedLabel, messageText } from "../utils/format";
import type { TranscriptRenderCtx } from "./TranscriptBlocks";
import { AssistantTurnContent } from "./TranscriptBlocks";
import { HistoryView } from "./HistoryView";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionPanel } from "./QuestionModal";
import { QueueCard } from "./QueueCard";
import { BackgroundCard } from "./BackgroundCard";
import { AssistantMsgActions, UserMsgActions } from "./MsgActions";
import { useComposerCtx, useHost, useSession, useTranscriptCtx, useModal, useUI, useTurnChanges, useBackground } from "../ctx";
import { Btn } from "../../ui";
import { TurnChangesBalloon } from "./TurnChangesBalloon";
import { blockTurnDuration, mapBalloonsToBlocks } from "../transcript";
import type { RenderBlock } from "../types";

const INLINE_USER_CODE_RE = /(?<!`)`([^`\n]+)`(?!`)/g;

/** One visual turn group: an initiating user prompt (when present) plus its
 * following assistant blocks, keeping original RenderBlock identities intact. */
export interface TurnSlice {
  id: string;
  startIdx: number;
  userBlock: RenderBlock | null;
  assistantBlocks: RenderBlock[];
}

/** Group visible transcript blocks into turn sections so each user prompt owns
 * the assistant work beneath it without mutating or cloning RenderBlock items. */
export function groupBlocksIntoTurns(blocks: readonly RenderBlock[]): TurnSlice[] {
  const turns: TurnSlice[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const blockId = block.id || block.msg.id || `turn-${i}`;
    if (block.msg.role === "user") {
      turns.push({
        id: blockId,
        startIdx: i,
        userBlock: block,
        assistantBlocks: [],
      });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last) {
      last.assistantBlocks.push(block);
    } else {
      turns.push({
        id: `orphan:${blockId}`,
        startIdx: i,
        userBlock: null,
        assistantBlocks: [block],
      });
    }
  }
  return turns;
}

/** Compact single-flow preview text for a stuck user prompt header. */
export function formatStickyPromptPreview(
  text: string,
  attachments?: readonly { name?: string }[],
): string {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  if (compact) return compact;
  if (attachments && attachments.length > 0) {
    const first = (attachments[0]?.name || "").trim() || "Attached file";
    return attachments.length === 1 ? first : `${first} +${attachments.length - 1}`;
  }
  return "";
}

export interface StickyTurnMetrics {
  id: string;
  /** In-flow user prompt bottom relative to scroll container top. */
  userBottomRel: number;
  /** Turn section bottom relative to scroll container top. */
  sectionBottomRel: number;
  /** True when the turn has visible sticky preview text and is not being edited. */
  eligible: boolean;
}

export interface StickyTurnResult {
  turnId: string | null;
  /** Negative Y translation while the next turn pushes the current sticky bar out. */
  pushY: number;
}

/** Determine which turn's user prompt should stick at the top of the transcript
 * scroll viewport and its push-out offset as the next turn arrives. */
export function resolveStickyTurnState(
  turns: readonly StickyTurnMetrics[],
  barHeight: number,
  scrollTop: number,
): StickyTurnResult {
  if (scrollTop <= 2 || turns.length === 0) return { turnId: null, pushY: 0 };
  const effectiveBarH = barHeight > 0 ? barHeight : 44;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (!turn.eligible) continue;
    if (turn.userBottomRel <= 4 && turn.sectionBottomRel > 8) {
      const pushY = turn.sectionBottomRel < effectiveBarH
        ? Math.round(turn.sectionBottomRel - effectiveBarH)
        : 0;
      return { turnId: turn.id, pushY };
    }
  }
  return { turnId: null, pushY: 0 };
}

/** Style inline single-backtick code spans in user messages while keeping whitespace/plain text intact. */
function renderUserText(text: string, compact = false): JSX.Element {
  if (!text.includes("`")) return text;
  const parts: JSX.Element[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE_USER_CODE_RE.lastIndex = 0;
  while ((match = INLINE_USER_CODE_RE.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    parts.push(
      <code
        class={
          compact
            ? "rounded-xs bg-surface-muted px-1 py-px font-mono text-2xs text-fg border border-border-subtle [overflow-wrap:anywhere]"
            : "rounded-xs bg-surface px-1.5 py-0.5 font-mono text-xs text-fg border border-border-subtle"
        }
      >
        {match[1]}
      </code>,
    );
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function TranscriptView() {
  const t = useTranscriptCtx();
  const s = useSession();
  const h = useHost();
  const c = useComposerCtx();
  const m = useModal();
  const ui = useUI();
  const tc = useTurnChanges();
  const bg = useBackground();
  // Persistent balloons anchored to the last block of their turn.
  // When a new turn starts, the previous turn's balloon stays anchored above
  // the new turn's initiating message, never jumping to the tail.
  const balloonsByBlockId = createMemo(() =>
    mapBalloonsToBlocks(t.renderBlocks(), tc.balloons(), t.historyOldestTurn()),
  );
  const balloonsForBlock = (block: any) =>
    balloonsByBlockId().get(block.id || block.msg.id) || [];
  const compaction = () => t.sessionCompaction();
  const shouldShowCompactionBalloon = () =>
    Boolean(compaction()?.previousSummary);
  const firstKeptBlockIdx = createMemo(() => {
    const cp = compaction();
    if (!cp) return -1;
    const cut = cp.keepFrom ?? 0;
    return t.visibleBlocks().findIndex((b) => (b.msg.srcIdx ?? t.blockRawIdx(b)) >= cut);
  });

  // Per-turn grouping with primitive-ID stability so streaming tokens or
  // appended assistant blocks inside a turn never remount the turn section.
  const turnSlices = createMemo(() => groupBlocksIntoTurns(t.visibleBlocks()));
  const turnSliceMap = createMemo(() => {
    const map = new Map<string, TurnSlice>();
    for (const slice of turnSlices()) map.set(slice.id, slice);
    return map;
  });
  const turnIds = createMemo(
    () => turnSlices().map((slice) => slice.id),
    [],
    { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) },
  );

  // Sticky user prompt tracking: reads DOM rects only on scroll/resize/turn
  // changes (coalesced via rAF) and keeps zero in-flow layout height.
  const [stuckTurnId, setStuckTurnId] = createSignal<string | null>(null);
  const [stickyPushY, setStickyPushY] = createSignal(0);
  const sectionEls = new Map<string, HTMLElement>();
  const userPromptEls = new Map<string, HTMLElement>();
  let scrollEl: HTMLDivElement | null = null;
  let stickyShellEl: HTMLDivElement | null = null;
  let stickyFrame = 0;

  const syncStickyPrompt = () => {
    if (!scrollEl || ui.historyView() || s.draftMode()) {
      setStuckTurnId(null);
      setStickyPushY(0);
      return;
    }
    const slices = turnSlices();
    if (slices.length === 0 || scrollEl.scrollTop <= 2) {
      setStuckTurnId(null);
      setStickyPushY(0);
      return;
    }
    const containerTop = scrollEl.getBoundingClientRect().top;
    const editingIdx = t.editingMsgIdx();
    const metrics: StickyTurnMetrics[] = [];
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]!;
      const userBlock = slice.userBlock;
      if (!userBlock) continue;
      const sectionEl = sectionEls.get(slice.id);
      const userEl = userPromptEls.get(slice.id);
      if (!sectionEl || !userEl) continue;
      const rawIdx = t.blockRawIdx(userBlock);
      const preview = formatStickyPromptPreview(messageText(userBlock.msg), userBlock.msg.attachments);
      const eligible = preview !== "" && editingIdx !== rawIdx;
      const userRect = userEl.getBoundingClientRect();
      const sectionRect = sectionEl.getBoundingClientRect();
      metrics.push({
        id: slice.id,
        userBottomRel: userRect.bottom - containerTop,
        sectionBottomRel: sectionRect.bottom - containerTop,
        eligible,
      });
    }
    const barH = stickyShellEl?.offsetHeight || 48;
    const next = resolveStickyTurnState(metrics, barH, scrollEl.scrollTop);
    setStuckTurnId(next.turnId);
    setStickyPushY(next.pushY);
  };

  const scheduleStickySync = () => {
    if (stickyFrame || typeof requestAnimationFrame !== "function") return;
    stickyFrame = requestAnimationFrame(() => {
      stickyFrame = 0;
      syncStickyPrompt();
    });
  };

  onCleanup(() => {
    if (stickyFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(stickyFrame);
      stickyFrame = 0;
    }
  });

  createEffect(() => {
    // Re-sync whenever turns, edit state, lane width, session, or view mode change.
    turnSlices();
    t.editingMsgIdx();
    ui.convWidthClass();
    s.activeSessionId();
    const hidden = ui.historyView() || s.draftMode();
    if (hidden) {
      setStuckTurnId(null);
      setStickyPushY(0);
      return;
    }
    scheduleStickySync();
  });

  const stuckTurn = createMemo(() => {
    const id = stuckTurnId();
    if (!id) return null;
    const slice = turnSliceMap().get(id);
    if (!slice?.userBlock) return null;
    if (t.editingMsgIdx() === t.blockRawIdx(slice.userBlock)) return null;
    const preview = formatStickyPromptPreview(messageText(slice.userBlock.msg), slice.userBlock.msg.attachments);
    if (!preview) return null;
    return {
      id,
      preview,
      attachmentCount: slice.userBlock.msg.attachments?.length ?? 0,
    };
  });

  const scrollToUserPrompt = (turnId: string) => {
    const container = scrollEl;
    const userEl = userPromptEls.get(turnId);
    if (!container || !userEl) return;
    t.transcriptScroll.detach();
    const containerTop = container.getBoundingClientRect().top;
    const userTop = userEl.getBoundingClientRect().top;
    const targetTop = Math.max(0, container.scrollTop + (userTop - containerTop) - 24);
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: targetTop, behavior: reducedMotion() ? "auto" : "smooth" });
    } else {
      container.scrollTop = targetTop;
    }
    scheduleStickySync();
  };

  const renderCtx = (): TranscriptRenderCtx => ({
    renderBlocks: t.renderBlocks,
    sessionStatus: t.sessionStatus,
    isPinned: t.transcriptScroll.isPinned,
    messages: t.messages,
    thinkingStart: t.thinkingStart,
    thinkingElapsed: t.thinkingElapsed,
    toolProgress: t.toolProgress,
    elapsedLabel,
    specialProgress: t.specialProgress,
    thinkingIndex: t.thinkingIndex,
    verboseChat: ui.verboseChat,
    hideToolMessages: () => !ui.verboseChat() || ui.hideToolMessages(),
    setPreviewFile: m.setPreviewFile,
    turnClock: t.turnClock,
    toolStarts: t.toolStarts,
    activeSession: s.activeSession,
    activeSessionId: s.activeSessionId,
    pendingApproval: t.pendingApproval,
    projects: s.projects,
    backgroundJobs: bg.sessionJobs,
    bgOutput: bg.output,
    bgClock: bg.clock,
    send: h.send,
  });
  let lastEditInputCaret: number | null = null;

  const renderBlockItem = (getBlock: () => RenderBlock, bi: () => number, registerUserEl?: (el: HTMLElement) => void) => {
    const msg = () => getBlock().msg;
    const blockId = () => getBlock().id || getBlock().msg.id;
    const isLast = () => blockId() === t.lastVisibleBlockId();
    const rawIdx = () => t.blockRawIdx(getBlock());
    const isHighlighted = () => {
      const hIdx = t.highlightedMsgIdx();
      if (hIdx === null) return false;
      const r = rawIdx();
      if (hIdx === r) return true;
      if (hIdx < r) return false;
      const vis = t.visibleBlocks();
      const next = vis[bi() + 1];
      if (next) return hIdx < t.blockRawIdx(next);
      const block = getBlock();
      if (block.kind === "series") {
        const lastExtra = block.extras.at(-1);
        const maxSrc = Math.max(
          r,
          block.textMsg?.srcIdx ?? r,
          lastExtra?.srcIdx ?? r,
        );
        return hIdx <= maxSrc + 2;
      }
      return hIdx <= r + 1;
    };
    const isFirstKeptBlock = () => {
      if (!shouldShowCompactionBalloon()) return false;
      const keptIdx = firstKeptBlockIdx();
      if (keptIdx !== -1) return bi() === keptIdx;
      return isLast();
    };
    const rctx = renderCtx();
    const textOf = () => {
      const block = getBlock();
      return messageText(block.kind === "series" && block.textMsg ? block.textMsg : block.msg);
    };
    const isEditing = () => t.editingMsgIdx() === rawIdx();
    return (
      <>
        <Show when={isFirstKeptBlock()}>
          <div class={`w-full ${ui.convWidthClass()} mx-auto`}>
            <CompactionBalloon
              compaction={compaction()}
              hasOlderAbove={bi() > 0 || t.historyHasOlder() || t.hiddenSeals() > 0}
            />
          </div>
        </Show>
        <div
          ref={(el) => {
            registerUserEl?.(el);
          }}
          data-transcript-id={blockId()}
          data-raw-idx={rawIdx()}
          data-highlighted={isHighlighted() ? "true" : undefined}
          class={`group/msg flex flex-col w-full ${ui.convWidthClass()} mx-auto transition-colors duration-300 ${
            isHighlighted() ? "rounded-surface ring-1 ring-accent bg-accent-subtle p-1 -m-1" : ""
          } ${
            msg().role === "user" && !isEditing() ? "items-end" : "items-start"
          }`}
        >
        {/* ===== USER ===== */}
        <Show when={msg().role === "user"}>
          <div class={isEditing() ? "w-full" : "flex min-w-0 flex-col items-end max-w-[90%] sm:max-w-[80%]"}>
            <Show when={!isEditing() && msg().attachments && msg().attachments!.length > 0}>
              <div class={`flex flex-wrap gap-1.5 mb-1.5 ${isEditing() ? "justify-start" : "justify-end"}`}>
                <For each={msg().attachments || []}>
                  {(file) => (
                    <button type="button" ref={press} data-rc-tip="Open preview" onClick={() => m.openStoredPreview(s.activeSessionId(), file.id)} class="text-2xs bg-surface-subtle border border-border hover:border-border-strong px-2.5 py-1 rounded-control text-fg-secondary hover:text-fg flex items-center gap-1.5 transition-colors cursor-pointer">
                      <FileIcon path={file.name} size={13} />
                      <span class="truncate max-w-[14rem]">{file.name}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            {/* Inline edit mode (chatbot) */}
            <Show
              when={isEditing()}
              fallback={
                <Show when={textOf().trim()}>
                  <div class="rc-user-bubble bg-surface-muted border border-border text-fg px-4 py-2.5 rounded-panel">
                    <p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{renderUserText(textOf())}</p>
                  </div>
                </Show>
              }
            >
              <div class="w-full p-2.5 rounded-panel border border-border-strong bg-surface">
                <MentionMenu mentions={t.editMentions} inputId="rc-editing-msg" />
                <div class="flex flex-wrap gap-1.5 mb-2">
                  <For each={t.editingAttachments()}>{(file) => <span class="flex items-center gap-1.5 rounded-inner border border-border bg-surface-subtle pl-2 pr-1 py-0.5 text-xs text-fg-secondary">
                    <FileIcon path={file.name} size={13} />
                    <button type="button" data-rc-tip="Open preview" onClick={() => m.openStoredPreview(s.activeSessionId(), file.id)} class="cursor-pointer hover:underline hover:text-fg truncate max-w-[12rem]">{file.name}</button>
                    <button type="button" disabled={t.savingEdit()} data-rc-tip="Remove attachment" aria-label={`Remove ${file.name}`} onClick={() => t.setEditingAttachments((prev) => prev.filter((a) => a.id !== file.id))} class="inline-flex items-center justify-center p-1 rounded-inner cursor-pointer text-fg-muted hover:text-danger hover:bg-danger-subtle transition-colors disabled:opacity-40"><Iconify icon="lucide:x" size={11} /></button>
                  </span>}</For>
                  <For each={t.editAttachments.pendingAttachments()}>{(file) => <span class="flex items-center gap-1.5 rounded-inner border border-border bg-surface-subtle pl-2 pr-1 py-0.5 text-xs text-fg-secondary">
                    <FileIcon path={file.name} size={13} />
                    <button type="button" data-rc-tip="Open preview" onClick={() => m.previewPending(file)} class="cursor-pointer hover:underline hover:text-fg truncate max-w-[12rem]">{file.name}</button>
                    <button type="button" disabled={t.savingEdit()} data-rc-tip="Remove attachment" aria-label={`Remove ${file.name}`} onClick={() => t.editAttachments.removePendingAttachment(file.key)} class="inline-flex items-center justify-center p-1 rounded-inner cursor-pointer text-fg-muted hover:text-danger hover:bg-danger-subtle transition-colors disabled:opacity-40"><Iconify icon="lucide:x" size={11} /></button>
                  </span>}</For>
                  <Show when={t.editAttachments.preparingAttachments()}><span role="status" class="text-xs text-fg-muted">Preparing files…</span></Show>
                </div>
                <textarea
                  id="rc-editing-msg"
                  disabled={t.savingEdit()}
                  onFocus={() => t.editMentions.setFocused(true)}
                  onSelect={(e) => t.editMentions.setCaret(e.currentTarget.selectionStart)}
                  onClick={(e) => t.editMentions.setCaret(e.currentTarget.selectionStart)}
                  onKeyUp={(e) => {
                    const pos = e.currentTarget.selectionStart;
                    if (lastEditInputCaret === pos) {
                      lastEditInputCaret = null;
                      return;
                    }
                    lastEditInputCaret = null;
                    t.editMentions.setCaret(pos);
                  }}
                  onPaste={(e) => { const files = Array.from(e.clipboardData?.files || []); if (files.length) { e.preventDefault(); void t.editAttachments.handleFiles(files); } }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {e.preventDefault(); void t.editAttachments.handleFiles(Array.from(e.dataTransfer?.files || []));}}
                  value={t.editingMsgText()}
                  onInput={(e) => {
                    const value = e.currentTarget.value;
                    const pos = e.currentTarget.selectionStart;
                    lastEditInputCaret = pos;
                    batch(() => {
                      t.updateEditingMsgText(value);
                      t.editMentions.setCaret(pos);
                    });
                  }}
                  onBlur={() => {t.editMentions.setFocused(false);}}
                  onKeyDown={(e) => {
                    if (e.isComposing || t.editMentions.keyDown(e)) return;
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      // Works on mobile too (hardware keyboards); plain Enter
                      // keeps inserting newlines there.
                      e.preventDefault();
                      t.saveEditMsg(rawIdx(), msg());
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      t.cancelEditMsg();
                    }
                  }}
                  class="w-full bg-transparent text-fg text-sm outline-none resize-y min-h-[96px] leading-relaxed"
                  rows={4}
                  ref={(el) => {
                    const active = document.activeElement;
                    if (!active || active === document.body || active === el) {
                      setTimeout(() => el?.focus(), 40);
                    }
                  }}
                />
                <div class="flex justify-end items-center gap-2 mt-2 pt-2 border-t border-border-subtle">
                  <label data-rc-tip="Attach files" class="mr-auto relative inline-flex items-center justify-center p-1.5 rounded-control cursor-pointer text-fg-muted hover:text-fg hover:bg-surface-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring transition-colors" aria-label="Attach files">
                    <Iconify icon="lucide:paperclip" size={16} />
                    <input type="file" multiple disabled={t.savingEdit()} class="sr-only" onChange={(e) => {void t.editAttachments.handleFiles(e.currentTarget.files || []); e.currentTarget.value="";}} />
                  </label>
                  <Btn
                    variant="outline"
                    size="sm"
                    onClick={t.cancelEditMsg}
                  >
                    Cancel
                  </Btn>
                  <Btn
                    size="sm"
                    disabled={t.savingEdit() || t.editAttachments.preparingAttachments() > 0}
                    onClick={() => t.saveEditMsg(rawIdx(), msg())}
                  >
                    Save and send
                  </Btn>
                </div>
              </div>
            </Show>
            <Show when={!isEditing()}>
              <UserMsgActions
                forking={t.forking()}
                canFork={(() => { const b = getBlock(); return (b.kind === "series" ? b.extras.at(-1) || b.msg : b.msg).srcIdx != null; })()}
                showCopy={textOf().trim() !== ""}
                copied={t.copiedMsgId() === msg().id}
                onFork={() => t.forkMessage(getBlock())}
                onCopy={() => t.copyMsg(msg().id, textOf())}
                onEdit={() => t.startEditMsg(rawIdx(), msg())}
              />
            </Show>
          </div>
        </Show>

        {/* ===== ASSISTANT ===== */}
        <Show when={msg().role !== "user"}>
          <div class="w-full min-w-0 flex flex-col items-start">
            {/* Loading dots while the first tokens arrive */}
            <Show
              when={
                t.sessionStatus() === "running" &&
                isLast() &&
                msg().blocks.length === 0
              }
            >
              <div class="dot-typing flex items-center gap-1.5 px-1 py-2">
                <span class="w-1.5 h-1.5 bg-fg-muted rounded-full inline-block" />
                <span class="w-1.5 h-1.5 bg-fg-muted rounded-full inline-block" />
                <span class="w-1.5 h-1.5 bg-fg-muted rounded-full inline-block" />
              </div>
            </Show>

            <AssistantTurnContent ctx={rctx} block={getBlock()} finished={t.sessionStatus() !== "running" || !isLast()} />

            {/* Hover actions (chatbot-style) */}
            <Show when={(t.sessionStatus() !== "running" || !isLast()) && !isEditing()}>
              <AssistantMsgActions
                duration={blockTurnDuration(getBlock()) != null ? elapsedLabel(blockTurnDuration(getBlock())!) : undefined}
                forking={t.forking()}
                canFork={(() => { const b = getBlock(); return (b.kind === "series" ? b.textMsg || b.extras.at(-1) || b.msg : b.msg).srcIdx != null; })()}
                showCopy={textOf().trim() !== ""}
                copied={t.copiedMsgId() === (() => { const b = getBlock(); return b.kind === "series" && b.textMsg ? b.textMsg.id : b.msg.id; })()}
                onFork={() => t.forkMessage(getBlock())}
                onCopy={() => { const b = getBlock(); t.copyMsg(b.kind === "series" && b.textMsg ? b.textMsg.id : b.msg.id, textOf()); }}
                onRegenerate={() => t.regenerateMsg(rawIdx())}
              />
            </Show>
          </div>
        </Show>
      </div>

      {/* Persistent per-turn file-changes balloon (never deleted) */}
      <For each={balloonsForBlock(getBlock()).filter((b) => (b.files?.length || 0) > 0)}>
        {(b) => (
          <div class={`w-full ${ui.convWidthClass()} mx-auto`}>
            <TurnChangesBalloon
              balloon={b}
              expanded={tc.isExpanded(`turn-${b.turnIndex}`)}
              onToggle={() => tc.toggleExpanded(`turn-${b.turnIndex}`)}
              live={b.live}
              onReview={() => tc.requestBalloons()}
            />
          </div>
        )}
      </For>
      </>
    );
  };

  return (
<>


{/* Chat Stream Viewport */}
<Show
  when={!ui.historyView()}
  fallback={
    <HistoryView
      sessionFilter={s.sessionFilter}
      setSessionFilter={s.setSessionFilter}
      queueDaemonSearch={s.queueDaemonSearch}
      searchResults={s.searchResults}
      setSearchResults={s.setSearchResults}
      setHistoryView={ui.setHistoryView}
      selectSession={s.selectSession}
      sessions={s.sessions}
      matchQuery={s.matchQuery}
      matchedByCwd={s.matchedByCwd}
      sortedSessions={s.sortedSessions}
      isMobile={ui.isMobile}
      isSessionUnread={s.isSessionUnread}
      sessionAttentionLabel={s.sessionAttentionLabel}
      activeSessionId={s.activeSessionId}
      sessionStatus={t.sessionStatus}
    />
  }
>
<Show when={!s.draftMode()}>
<div
  ref={(el) => {
    scrollEl = el;
    t.setChatContainerRef(el);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => scheduleStickySync());
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    }
    onCleanup(() => {
      if (scrollEl === el) scrollEl = null;
    });
  }}
  onScroll={() => {
    t.onChatScroll();
    scheduleStickySync();
  }}
  onWheel={(e) => { if (e.deltaY < 0) t.transcriptScroll.detach(); }}
  onPointerDown={() => t.transcriptScroll.detach()}
  onTouchMove={() => t.transcriptScroll.detach()}
  onKeyDown={(e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) t.transcriptScroll.detach(); }}
  tabindex="0"
  aria-label="Conversation"
  class="rc-transcript-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-4 sm:px-6 lg:px-8 select-text [overflow-anchor:none]"
>
{/* Zero-height sticky prompt anchor: sticks cleanly at top: 0 when scrolled below
    a turn's user message and inherits exact conversation lane alignment. */}
<Show when={stuckTurn()}>
  {(stuck) => (
    <div class="rc-sticky-prompt-anchor">
      <div
        ref={(el) => {
          stickyShellEl = el;
          scheduleStickySync();
          onCleanup(() => { if (stickyShellEl === el) stickyShellEl = null; });
        }}
        data-sticky-prompt-shell={stuck().id}
        data-stuck="true"
        class="rc-sticky-prompt-shell -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8"
        style={stickyPushY() ? { transform: `translateY(${stickyPushY()}px)` } : undefined}
      >
        <div class={`w-full ${ui.convWidthClass()} mx-auto`}>
          <button
            type="button"
            data-sticky-prompt={stuck().id}
            onClick={() => scrollToUserPrompt(stuck().id)}
            aria-label="Scroll to prompt"
            class="rc-sticky-prompt-btn group/sticky pointer-events-auto w-full flex items-center gap-2.5 text-left px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-control cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span class="min-w-0 flex-1 text-xs sm:text-[13px] leading-snug text-fg line-clamp-2 break-words [overflow-wrap:anywhere]">
              {renderUserText(stuck().preview, true)}
            </span>
            <Show when={stuck().attachmentCount > 0}>
              <span class="inline-flex items-center gap-1 shrink-0 rounded-inner border border-border bg-surface-muted px-1.5 py-0.5 text-2xs text-fg-secondary tabular-nums">
                <Iconify icon="lucide:paperclip" size={11} class="text-fg-muted shrink-0" />
                <span>{stuck().attachmentCount}</span>
              </span>
            </Show>
            <Iconify
              icon="lucide:arrow-up"
              size={13}
              class="shrink-0 text-fg-muted group-hover/sticky:text-fg transition-colors"
            />
          </button>
        </div>
      </div>
    </div>
  )}
</Show>
<div
  ref={(el) => {
    t.setChatContentRef(el);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => scheduleStickySync());
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    }
  }}
  class="pt-6 pb-8 space-y-5"
>
  {/* Conversation Messages.
      buildRenderBlocks fuses consecutive assistant messages that
      are tool-only into one "series" block. Index bookkeeping
      below stays on RAW message positions: series extras are
      skipped for actions, and the lead keeps its own raw index so
      every per-message op still maps 1:1 to the daemon
      transcript — fusing is purely visual. */}
  <Show when={t.historyHasOlder() || t.hiddenSeals() > 0}>
    <div class="flex justify-center">
      <button
        type="button"
        ref={press}
        onClick={() => t.loadOlder()}
        disabled={t.loadingOlder()}
        class="flex items-center gap-1.5 px-3 py-1 rounded-pill text-xs text-fg-secondary border border-border bg-surface-subtle hover:text-fg hover:border-border-strong transition-colors cursor-pointer disabled:opacity-60"
      >
        <Iconify icon="lucide:chevron-up" size={13} class="text-fg-muted" />
        {/* Whole sealed blocks only: while older turns exist on the
            daemon the button fetches the next seal; otherwise it reveals
            the next hidden seal. No bubble math — seams always fall on
            turn boundaries. */}
        <span>{t.loadingOlder() ? "Loading…" : t.historyHasOlder()
          ? `Load older turns (${t.historyHiddenTurns()} hidden)`
          : `Load older turns (${t.hiddenSeals()} hidden)`}</span>
      </button>
    </div>
  </Show>
  <Show when={t.visibleBlocks().length === 0 && shouldShowCompactionBalloon()}>
    <div class={`w-full ${ui.convWidthClass()} mx-auto`}>
      <CompactionBalloon
        compaction={compaction()}
        hasOlderAbove={t.historyHasOlder() || t.hiddenSeals() > 0}
      />
    </div>
  </Show>
  <For each={turnIds()}>
    {(turnId) => {
      const slice = () => turnSliceMap().get(turnId);
      const userBlock = () => slice()?.userBlock ?? null;
      const assistantBlocks = () => slice()?.assistantBlocks ?? [];
      const startIdx = () => slice()?.startIdx ?? 0;
      return (
        <section
          data-turn-id={turnId}
          ref={(el) => {
            sectionEls.set(turnId, el);
            onCleanup(() => {
              if (sectionEls.get(turnId) === el) sectionEls.delete(turnId);
            });
          }}
          class="rc-turn-section space-y-5"
        >
          <Show when={userBlock()}>
            {(ub) => renderBlockItem(ub, startIdx, (el) => {
              userPromptEls.set(turnId, el);
              onCleanup(() => {
                if (userPromptEls.get(turnId) === el) userPromptEls.delete(turnId);
              });
            })}
          </Show>
          <For each={assistantBlocks()}>
            {(block, ai) => renderBlockItem(
              () => block,
              () => startIdx() + (userBlock() ? 1 : 0) + ai(),
            )}
          </For>
        </section>
      );
    }}
  </For>

  <Show when={s.activeSessionId() && t.pendingQuestion()?.id} keyed>{(id) =>
    <div class={`w-full ${ui.convWidthClass()} mx-auto`}>
      <QuestionPanel
        request={{ ...t.pendingQuestion()!, id }}
        connected={h.connectionState() === "connected" && h.activeHost()?.status === "online"}
        submitting={t.questionSubmitting()}
        error={t.questionError()}
        onSubmit={t.answerQuestion}
      />
    </div>
  }</Show>
  <ApprovalCard
    pendingApproval={t.pendingApproval}
    convWidthClass={ui.convWidthClass}
    respondApproval={t.respondApproval}
    accessMode={c.accessMode}
  />
  <BackgroundCard contextKey={`${h.activeHostId()}:${s.activeSessionId()}`} />
  <QueueCard />
  <Show when={t.historyHasNewer()}>
    <div aria-hidden="true" class="h-1 shrink-0" />
  </Show>
</div>
</div>
</Show>
</Show>
</>
  );
}
