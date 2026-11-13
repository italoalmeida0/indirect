import { MentionMenu } from "./MentionMenu";
import { batch, createMemo, For, Show, type JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
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

const INLINE_USER_CODE_RE = /(?<!`)`([^`\n]+)`(?!`)/g;

/** Style inline single-backtick code spans in user messages while keeping whitespace/plain text intact. */
function renderUserText(text: string): JSX.Element {
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
      <code class="rounded-xs bg-surface px-1.5 py-0.5 font-mono text-xs text-fg border border-border-subtle">
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
  ref={t.setChatContainerRef}
  onScroll={t.onChatScroll}
  onWheel={(e) => { if (e.deltaY < 0) t.transcriptScroll.detach(); }}
  onPointerDown={() => t.transcriptScroll.detach()}
  onTouchMove={() => t.transcriptScroll.detach()}
  onKeyDown={(e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) t.transcriptScroll.detach(); }}
  tabindex="0"
  aria-label="Conversation"
  class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 sm:px-6 lg:px-8 select-text [overflow-anchor:none]"
>
<div ref={t.setChatContentRef} class="pt-6 pb-8 space-y-5"
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
        onPointerDown={(e) => {
          if (!t.loadingOlder()) press(e.currentTarget);
        }}
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
  <For each={t.visibleBlocks()}>
    {(block, bi) => {
      const msg = block.msg;
      const blockId = block.id || block.msg.id;
      const isLast = () => blockId === t.lastVisibleBlockId();
      const rawIdx = () => t.blockRawIdx(block);
      const isHighlighted = () => {
        const h = t.highlightedMsgIdx();
        if (h === null) return false;
        const r = rawIdx();
        if (h === r) return true;
        if (h < r) return false;
        const vis = t.visibleBlocks();
        const next = vis[bi() + 1];
        if (next) return h < t.blockRawIdx(next);
        if (block.kind === "series") {
          const lastExtra = block.extras.at(-1);
          const maxSrc = Math.max(
            r,
            block.textMsg?.srcIdx ?? r,
            lastExtra?.srcIdx ?? r,
          );
          return h <= maxSrc + 2;
        }
        return h <= r + 1;
      };
      const isFirstKeptBlock = () => {
        if (!shouldShowCompactionBalloon()) return false;
        const keptIdx = firstKeptBlockIdx();
        if (keptIdx !== -1) return bi() === keptIdx;
        return isLast();
      };
      const rctx = renderCtx();
      const textOf = () => messageText(block.kind === "series" && block.textMsg ? block.textMsg : msg);
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
            data-transcript-id={blockId}
            data-raw-idx={rawIdx()}
            data-highlighted={isHighlighted() ? "true" : undefined}
            class={`group/msg flex flex-col w-full ${ui.convWidthClass()} mx-auto transition-colors duration-300 ${
              isHighlighted() ? "rounded-surface ring-1 ring-accent bg-accent-subtle p-1 -m-1" : ""
            } ${
              msg.role === "user" && !isEditing() ? "items-end" : "items-start"
            }`}
          >
          {/* ===== USER ===== */}
          <Show when={msg.role === "user"}>
            <div class={isEditing() ? "w-full" : "flex min-w-0 flex-col items-end max-w-[90%] sm:max-w-[80%]"}>
              <Show when={!isEditing() && msg.attachments && msg.attachments.length > 0}>
                <div class={`flex flex-wrap gap-1.5 mb-1.5 ${isEditing() ? "justify-start" : "justify-end"}`}>
                  <For each={msg.attachments || []}>
                    {(file) => (
                      <button type="button" data-rc-tip="Open preview" onPointerDown={(e) => press(e.currentTarget)} onClick={() => m.openStoredPreview(s.activeSessionId(), file.id)} class="text-2xs bg-surface-subtle border border-border hover:border-border-strong px-2.5 py-1 rounded-control text-fg-secondary hover:text-fg flex items-center gap-1.5 transition-colors cursor-pointer">
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
                      <p class="whitespace-pre-line break-words text-sm leading-relaxed">{renderUserText(textOf())}</p>
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
                      <button type="button" disabled={t.savingEdit()} data-rc-tip="Remove attachment" aria-label={`Remove ${file.name}`} onClick={() => t.setEditingAttachments((prev) => prev.filter((a) => a.id !== file.id))} class="inline-flex items-center justify-center px-1 py-0.5 rounded-inner cursor-pointer text-fg-muted hover:text-danger hover:bg-danger-subtle transition-colors disabled:opacity-40">×</button>
                    </span>}</For>
                    <For each={t.editAttachments.pendingAttachments()}>{(file) => <span class="flex items-center gap-1.5 rounded-inner border border-border bg-surface-subtle pl-2 pr-1 py-0.5 text-xs text-fg-secondary">
                      <FileIcon path={file.name} size={13} />
                      <button type="button" data-rc-tip="Open preview" onClick={() => m.previewPending(file)} class="cursor-pointer hover:underline hover:text-fg truncate max-w-[12rem]">{file.name}</button>
                      <button type="button" disabled={t.savingEdit()} data-rc-tip="Remove attachment" aria-label={`Remove ${file.name}`} onClick={() => t.editAttachments.removePendingAttachment(file.key)} class="inline-flex items-center justify-center px-1 py-0.5 rounded-inner cursor-pointer text-fg-muted hover:text-danger hover:bg-danger-subtle transition-colors disabled:opacity-40">×</button>
                    </span>}</For>
                    <Show when={t.editAttachments.preparingAttachments()}><span role="status" class="text-xs text-fg-muted">Preparing files...</span></Show>
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
                        t.saveEditMsg(rawIdx(), msg);
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
                      onClick={() => t.saveEditMsg(rawIdx(), msg)}
                    >
                      Save and Send
                    </Btn>
                  </div>
                </div>
              </Show>
              <Show when={!isEditing()}>
                <UserMsgActions
                  forking={t.forking()}
                  canFork={(block.kind === "series" ? block.extras.at(-1) || msg : msg).srcIdx != null}
                  showCopy={textOf().trim() !== ""}
                  copied={t.copiedMsgId() === msg.id}
                  onFork={() => t.forkMessage(block)}
                  onCopy={() => t.copyMsg(msg.id, textOf())}
                  onEdit={() => t.startEditMsg(rawIdx(), msg)}
                />
              </Show>
            </div>
          </Show>

          {/* ===== ASSISTANT ===== */}
          <Show when={msg.role !== "user"}>
            <div class="w-full min-w-0 flex flex-col items-start">
              {/* Loading dots while the first tokens arrive */}
              <Show
                when={
                  t.sessionStatus() === "running" &&
                  isLast() &&
                  msg.blocks.length === 0
                }
              >
                <div class="dot-typing flex items-center gap-1.5 px-1 py-2">
                  <span class="w-1.5 h-1.5 bg-fg-muted rounded-full inline-block" />
                  <span class="w-1.5 h-1.5 bg-fg-muted rounded-full inline-block" />
                  <span class="w-1.5 h-1.5 bg-fg-muted rounded-full inline-block" />
                </div>
              </Show>

              <AssistantTurnContent ctx={rctx} block={block} finished={t.sessionStatus() !== "running" || !isLast()} />

              {/* Hover actions (chatbot-style) */}
              <Show when={(t.sessionStatus() !== "running" || !isLast()) && !isEditing()}>
                <AssistantMsgActions
                  duration={blockTurnDuration(block) != null ? elapsedLabel(blockTurnDuration(block)!) : undefined}
                  forking={t.forking()}
                  canFork={(block.kind === "series" ? block.textMsg || block.extras.at(-1) || msg : msg).srcIdx != null}
                  showCopy={textOf().trim() !== ""}
                  copied={t.copiedMsgId() === (block.kind === "series" && block.textMsg ? block.textMsg.id : msg.id)}
                  onFork={() => t.forkMessage(block)}
                  onCopy={() => t.copyMsg(block.kind === "series" && block.textMsg ? block.textMsg.id : msg.id, textOf())}
                  onRegenerate={() => t.regenerateMsg(rawIdx())}
                />
              </Show>
            </div>
          </Show>
        </div>

        {/* Persistent per-turn file-changes balloon (never deleted) */}
        <For each={balloonsForBlock(block).filter((b) => (b.files?.length || 0) > 0)}>
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
    setYoloMode={c.setYoloMode}
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
