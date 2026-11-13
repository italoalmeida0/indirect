import { createTranscriptOrder, type TranscriptCursor } from "../transcript/order";
import {
  enforceSlidingTurnWindow,
  MAX_WINDOW_TURNS,
  nextHistoryCursor,
  type HistoryCursor,
} from "../transcript/history";
import type { DaemonCommand } from "../daemon-protocol";
import { batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { copyText } from "../../ds/primitives/clipboard";
import { clearToolScrolls } from "../utils/scrollMemory";
import { sharedBlobUrlCache } from "../utils/blobUrlCache";
import { createTranscriptScroll } from "../scroll";
import { createRenderBlockBuilder, latestShortTurnMessage } from "../transcript";
import { elapsedLabel, messageText } from "../utils/format";
import { prettyArgs, parseContentBlocks } from "../utils/wire";
import { stripToolEnvelopeDetailed } from "../utils/envelope";
import {
  appendReasoningDelta as reduceReasoningDelta,
  appendTextDelta as reduceTextDelta,
  appendToolArgsDelta as reduceToolArgs,
  appendToolResult as reduceToolResult,
  cutTail,
  finishTurn,
  mergeAssistantMessage,
  mergeUsage,
  normalizeSessionMessages,
  normalizeTurnActivity,
  mergeTranscriptTail,
  orderedMessages,
  preserveTransientToolPreviews,
  pushAssistantCarrier,
  stampDuration,
  upsertToolCall as reduceToolCall,
} from "../transcript/updaters";
import type { PendingQuestion } from "../components/QuestionModal";
import type {
  AgentEvent, SessionStatusEvent, ToolApprovalRequestEvent,
} from "../daemon-protocol";
import type { SessionContext } from "../context";
import type {
  ChatMessage, CompactionState, PendingApproval, RenderBlock, SessionUsage, ToolUnit,
} from "../types";
import { createAttachmentDraft } from "./useAttachmentDraft";
import { createMentions } from "./useMentions";
import type { StoredAttachment, TodoItem, TurnActivity } from "../viewTypes";

/** Transcript domain: messages, turn state, thinking, live tools,
 * scroll, render blocks, and per-message ops (extracted verbatim from RemoteCodePage —
 * only the source of collaborators changes: passed via params). */
export function createTranscript(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  getHostId: () => string;
  getProjectId?: () => string;
  toast: (message: string, kind?: "ok" | "err") => void;
  showChoice: (o: { title: string; message: string; options: { id: string; label: string; hint?: string; primary?: boolean }[] }) => Promise<string | null>;
  /** Turn became idle: the page refreshes the review. */
  onTurnIdle: () => void;
  /** Context received in usage: the page compares it with the catalog. */
  onUsageContext: (ctx: SessionContext) => void;
  onDiscardResendOrRegenerate?: (sessionId: string) => void;
  onForkKind?: (kind: "resend" | "regenerate" | "fork") => void;
}) {
  const [editingAttachments, setEditingAttachments] = createSignal<StoredAttachment[]>([]);
  const editAttachments = createAttachmentDraft({ ...opts, additionalCount: () => editingAttachments().length });
  const [savingEdit, setSavingEdit] = createSignal(false);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [sessionStatus, setSessionStatus] = createSignal<"idle" | "running">("idle");
  const [sessionCompaction, setSessionCompaction] = createSignal<CompactionState | null>(null);
  const [turnActivity, setTurnActivity] = createSignal<TurnActivity | null>(null);
  const [todos, setTodos] = createSignal<TodoItem[]>([]);
  const [todosOpen, setTodosOpen] = createSignal(true);
  let pendingTodosOpen: { value: boolean; time: number } | undefined;

  function toggleTodosOpen() {
    const next = !todosOpen();
    setTodosOpen(next);
    pendingTodosOpen = { value: next, time: Date.now() };
    const sid = opts.getSessionId();
    if (sid && opts.isOpen()) {
      opts.send({ type: "set_todos_open", sessionId: sid, open: next });
    }
  }

  function applyTodosOpenFromRemote(remote: boolean) {
    if (pendingTodosOpen) {
      if (pendingTodosOpen.value === remote) {
        // Confirmed by SignalDB / daemon
        pendingTodosOpen = undefined;
        return;
      }
      if (Date.now() - pendingTodosOpen.time < 4000) {
        return;
      }
      pendingTodosOpen = undefined;
    }
    setTodosOpen(remote);
  }
  const [compactingText, setCompactingText] = createSignal("");
  const clearCompacting = () => setCompactingText("");
  const [turnClock, setTurnClock] = createSignal(Date.now());
  createEffect(() => {
    if (!turnActivity()?.startedAt || sessionStatus() !== "running") return;
    setTurnClock(Date.now());
    const timer = setInterval(() => setTurnClock(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const turnLabel = () => {
    const compact = compactingText();
    const turn = turnActivity();
    if (compact) {
      if (turn?.startedAt && turn.status === "running" && sessionStatus() === "running") {
        const elapsed = elapsedLabel((turn.endedAt || turnClock()) - turn.startedAt);
        return `${compact} · ${elapsed}`;
      }
      return compact;
    }
    if (!turn) return "";
    const elapsed = elapsedLabel((turn.endedAt || turnClock()) - turn.startedAt);
    const label = turn.status === "running" && pendingQuestion() ? "Waiting for your answers" : turn.status === "running" && pendingApproval() ? "Waiting for approval" : { running: "Working", cancelling: "Stopping turn", cancelled: "Turn cancelled", completed: "Turn completed", failed: "Turn failed" }[turn.status];
    return `${label} · ${elapsed}`;
  };
  /** Last short assistant text of the running turn (single-line hint). */
  const turnHint = createMemo(() => {
    if (turnActivity()?.status !== "running" || sessionStatus() !== "running") return "";
    return latestShortTurnMessage(messages());
  });
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null);
  const [pendingQuestion, setPendingQuestion] = createSignal<PendingQuestion | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = createSignal(false);
  const [questionError, setQuestionError] = createSignal("");
  // Replay guard (audit bug 81): these request events ride the wire without a
  // transcript cursor, so a late replay can re-raise a card whose id was
  // already resolved — the user's answer would then hit the daemon's stale
  // branch and be dropped silently. Remember resolved ids and ignore their
  // late re-requests. Capped: a session raises a handful of these.
  const resolvedAsks = new Set<string>();
  function rememberResolvedAsk(prefix: string, id: string) {
    resolvedAsks.add(prefix + id);
    if (resolvedAsks.size > 256) {
      for (const key of resolvedAsks) {
        resolvedAsks.delete(key);
        if (resolvedAsks.size <= 128) break;
      }
    }
  }
  const askResolved = (prefix: string, id: string) => resolvedAsks.has(prefix + id);
  function showQuestion(question: PendingQuestion | null) {
    if (question && askResolved("q:", question.id)) return; // late replay: dead id
    if (question && pendingQuestion()?.id === question.id) return;
    if (question) {
      const raw = (question as any).questions ?? (question as any).question;
      const normalized: PendingQuestion["questions"] = Array.isArray(raw)
        ? raw.map((q: any) => typeof q === "string" ? { header: "Question", question: q, options: [] } : { header: q?.header || "Question", question: q?.question || "", options: Array.isArray(q?.options) ? q.options : [], multiple: !!q?.multiple, custom: q?.custom, recommend: q?.recommend, decide_later: q?.decide_later })
        : raw && typeof raw === "object"
          ? [{ header: raw.header || "Question", question: raw.question || "", options: Array.isArray(raw.options) ? raw.options : [], multiple: !!raw.multiple, custom: raw.custom, recommend: raw.recommend, decide_later: raw.decide_later }]
          : typeof raw === "string" && raw.trim()
            ? [{ header: "Question", question: raw.trim(), options: [] }]
            : [];
      if (!normalized.length) {
        setPendingQuestion(null);
        setQuestionSubmitting(false);
        setQuestionError("");
        return;
      }
      question = { ...question, questions: normalized };
    }
    setPendingQuestion(question);
    setQuestionSubmitting(false);
    setQuestionError("");
    if (question) scrollToBottom();
  }
  function answerQuestion(answers: string[][]) {
    const question = pendingQuestion();
    if (!question || !opts.isOpen() || questionSubmitting()) return;
    setQuestionSubmitting(true);
    setQuestionError("");
    opts.send({ type: "question_response", sessionId: opts.getSessionId(), questionId: question.id, answers });
  }
  // Live usage per session (from daemon usage/turn_end events).
  const [sessionUsage, setSessionUsage] = createSignal<Record<string, SessionUsage>>({});
  /** Usage of the active session, or null — keeps "" session ids out of the union. */
  const activeUsage = createMemo<SessionUsage | null>(() => {
    const id = opts.getSessionId();
    return id ? (sessionUsage()[id] ?? null) : null;
  });
  const [sessionContexts, setSessionContexts] = createSignal<Record<string, SessionContext | null>>({});
  // Live tool progress text per tool call id (cleared on result/turn_end).
  const [toolStarts, setToolStarts] = createSignal<Record<string, number>>({});
  const [toolProgress, setToolProgress] = createSignal<Record<string, string>>({});
  // Copied-message feedback.
  const [copiedMsgId, setCopiedMsgId] = createSignal<string | null>(null);
  function copyMsg(id: string, text: string) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    void copyText(trimmed).then((ok) => {
      if (ok) {
        setCopiedMsgId(id);
        setTimeout(() => setCopiedMsgId((cur) => (cur === id ? null : cur)), 1500);
      } else {
        opts.toast("Could not copy automatically. Select the text and copy it manually", "err");
      }
    });
  }

  // Live thinking timer (chatbot thinkingElapsed). thinkingIndex tracks
  // WHICH reasoning block of the live assistant message the timer belongs
  // to, so the clock + ticking dots stick to the right panel when one
  // message carries several thinkings.
  const [thinkingStart, setThinkingStart] = createSignal<number | null>(null);
  const [thinkingElapsed, setThinkingElapsed] = createSignal(0);
  const [thinkingIndex, setThinkingIndex] = createSignal(0);
  let thinkingTimer: any = null;
  function startThinkingTimer(startedAt = Date.now()) {
    // Monotonic: never rewind a running clock. Snapshots re-send the
    // daemon's thinkingStartedAt on every pull; restarting here reset the
    // visible count back to 0s and the trailing stop then stamped ~0 over
    // the real duration. A null clock (fresh load, new phase) starts.
    if (thinkingStart() !== null) return;
    setThinkingStart(startedAt);
    setThinkingElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    thinkingTimer = setInterval(() => {
      const s = thinkingStart();
      if (s) setThinkingElapsed(Math.floor((Date.now() - s) / 1000));
    }, 1000);
  }
  function stopThinkingTimer(): number {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    const s = thinkingStart();
    const d = s ? Math.floor((Date.now() - s) / 1000) : 0;
    setThinkingStart(null);
    setThinkingElapsed(0);
    return d;
  }
  onCleanup(() => stopThinkingTimer());

  // Inline message editing (chatbot editingMessageIndex).
  const [editingMsgIdx, setEditingMsgIdx] = createSignal<number | null>(null);
  const [editingMsgText, setEditingMsgText] = createSignal("");

  // Scroll / viewport
  const [isAtBottom, setIsAtBottom] = createSignal(true);
  const [chatContainerRef, setChatContainerRef] = createSignal<HTMLDivElement | null>(null);
  const [chatContentRef, setChatContentRef] = createSignal<HTMLDivElement | null>(null);
  const transcriptScroll = createTranscriptScroll({
    element: chatContainerRef,
    running: () => sessionStatus() === "running",
    atBottom: setIsAtBottom,
  });
  createEffect(() => {
    const content = chatContentRef();
    if (!content) return;
    const observer = new ResizeObserver(() => transcriptScroll.schedule());
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => transcriptScroll.dispose());
  function scrollToBottom(force = false) { transcriptScroll.schedule(force); }
  /** Explicit "Pin at bottom": jump to the tail and follow streaming again. */
  function pinAtBottom() { transcriptScroll.pin(); }

  // Keep ingesting ordered state while hidden, but derive the view only once
  // on return. There is no backlog of per-token DOM work to replay.
  const [pageVisible, setPageVisible] = createSignal(!document.hidden);
  const onVisibility = () => setPageVisible(!document.hidden);
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));

  // Render blocks (incrementally reconciled store: unchanged cached turns
  // keep their exact store proxy without O(total_AST) deep walks).
  const buildRenderBlocks = createRenderBlockBuilder();
  const [renderState, setRenderState] = createStore<{ blocks: (RenderBlock & { id: string })[] }>({ blocks: [] });
  let prevRawBlocks: (RenderBlock & { id: string })[] = [];
  let prevRawById = new Map<string, RenderBlock & { id: string }>();
  let prevProxyById = new Map<string, RenderBlock & { id: string }>();
  createEffect(() => {
    if (!pageVisible()) return;
    const nextRaw = buildRenderBlocks(messages()) as (RenderBlock & { id: string })[];
    transcriptScroll.preserveReadingPosition();

    let sameIds = nextRaw.length === prevRawBlocks.length;
    if (sameIds) {
      for (let i = 0; i < nextRaw.length; i++) {
        const id = nextRaw[i].id || nextRaw[i].msg.id;
        const prevId = prevRawBlocks[i].id || prevRawBlocks[i].msg.id;
        if (id !== prevId) {
          sameIds = false;
          break;
        }
      }
    }

    if (sameIds) {
      batch(() => {
        for (let i = 0; i < nextRaw.length; i++) {
          const block = nextRaw[i];
          if (block === prevRawBlocks[i]) continue;
          const blockWithId = block.id ? block : { ...block, id: block.msg.id };
          setRenderState("blocks", i, reconcile(blockWithId, { merge: true }));
          const id = blockWithId.id;
          prevRawById.set(id, block);
          prevProxyById.set(id, untrack(() => renderState.blocks[i]));
        }
      });
      prevRawBlocks = nextRaw;
      return;
    }

    const nextStoreList: (RenderBlock & { id: string })[] = new Array(nextRaw.length);
    const nextRawMap = new Map<string, RenderBlock & { id: string }>();
    const nextProxyMap = new Map<string, RenderBlock & { id: string }>();
    const dirtyIndices: number[] = [];

    for (let i = 0; i < nextRaw.length; i++) {
      const block = nextRaw[i];
      const id = block.id || block.msg.id;
      const prevRaw = prevRawById.get(id);
      const prevProxy = prevProxyById.get(id);
      if (prevRaw === block && prevProxy) {
        nextStoreList[i] = prevProxy;
      } else if (prevProxy) {
        nextStoreList[i] = prevProxy;
        dirtyIndices.push(i);
      } else {
        nextStoreList[i] = block.id ? block : { ...block, id };
      }
      nextRawMap.set(id, block);
    }

    batch(() => {
      setRenderState("blocks", nextStoreList);
      for (let k = 0; k < dirtyIndices.length; k++) {
        const idx = dirtyIndices[k];
        const block = nextRaw[idx];
        const blockWithId = block.id ? block : { ...block, id: block.msg.id };
        setRenderState("blocks", idx, reconcile(blockWithId, { merge: true }));
      }
      untrack(() => {
        for (let i = 0; i < nextRaw.length; i++) {
          const id = nextRaw[i].id || nextRaw[i].msg.id;
          nextProxyMap.set(id, renderState.blocks[i]);
        }
      });
    });

    prevRawBlocks = nextRaw;
    prevRawById = nextRawMap;
    prevProxyById = nextProxyMap;
  });
  const renderBlocks = () => renderState.blocks;

  /**
   * Sealed history blocks: the daemon ships whole turns per page
   * (get_session tail + get_history pages), and the frontend renders
   * whole sealed blocks — never a slice cut mid-block. Each entry notes
   * its turn range [oldestTurn, newestTurn] plus whether the daemon said
   * more exists below (hasOlder at seal time). Block seams always fall
   * on turn boundaries, so balloons (keyed by TurnIndex) can never land
   * on the wrong turn.
   *
   * The live tail (streaming turn + anything appended after the last
   * seal) renders above the seals and is NOT a block: it grows until
   * the next snapshot/page seals it. Solid's <For> only creates DOM for
   * sealed blocks + tail, so a huge session mounts a few dozen bubbles.
   */
  interface SealedBlock {
    oldestTurn: number;
    newestTurn: number;
    /** First raw message index of the block (srcIdx base). */
    firstIndex: number;
    /** Message count at seal time (detects tail growth). */
    msgCount: number;
    /** hasOlder reported by the daemon when this block was sealed. */
    hasOlderBelow: boolean;
  }
  const [sealedBlocks, setSealedBlocks] = createSignal<SealedBlock[]>([]);
  /** Turn-anchored render budget: how many NEWEST sealed blocks render.
   * Grows by whole blocks only (never +N bubbles mid-block). */
  const [sealedBudget, setSealedBudget] = createSignal(1);
  // Server-driven history pagination (turn blocks): the daemon sends the
  // tail block plus a cursor; older/newer/around blocks arrive via get_history.
  // historyArmed starts FALSE so the initial top-scroll never auto-loads
  // (the button shows first; the first click arms scroll loading).
  const [historyCursor, setHistoryCursor] = createSignal<HistoryCursor | null>(null);
  const [historyArmed, setHistoryArmed] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [loadingNewer, setLoadingNewer] = createSignal(false);
  const [highlightedMsgIdx, setHighlightedMsgIdx] = createSignal<number | null>(null);
  let highlightClearTimer: ReturnType<typeof setTimeout> | null = null;
  function flashHighlightedMessage(msgIdx: number) {
    if (highlightClearTimer != null) clearTimeout(highlightClearTimer);
    setHighlightedMsgIdx(msgIdx);
    highlightClearTimer = setTimeout(() => {
      highlightClearTimer = null;
      setHighlightedMsgIdx((cur) => (cur === msgIdx ? null : cur));
    }, 2200);
  }
  /**
   * Visible seals: the newest `sealedBudget` sealed blocks, by turn.
   * Messages are filtered to the visible turn range — the live tail
   * (anything past the newest seal) always renders. When nothing is
   * sealed yet (small session, pre-pagination), everything renders.
   */
  const visibleTurnFloor = createMemo(() => {
    const seals = sealedBlocks();
    if (seals.length === 0) return 0;
    const show = seals.slice(Math.max(0, seals.length - sealedBudget()));
    if (show.length === 0) return 0;
    return show[0].oldestTurn;
  });
  const visibleBlocks = createMemo(() => {
    const floor = visibleTurnFloor();
    if (floor <= 0) return renderState.blocks;
    const seals = sealedBlocks();
    const newestSealTop = seals.length > 0 ? seals[seals.length - 1].newestTurn : 0;
    return renderState.blocks.filter((b) => {
      const t = typeof b.msg.turnIndex === "number" && b.msg.turnIndex > 0 ? b.msg.turnIndex : 0;
      // Unstamped (turn 0) system notices ride with the tail — always show.
      // Stamped blocks below the floor belong to hidden seals.
      // Blocks ABOVE the newest seal (live tail) always show.
      if (t <= 0) return true;
      if (newestSealTop > 0 && t > newestSealTop) return true;
      return t >= floor;
    });
  });
  const lastVisibleBlockId = createMemo(() => {
    const vis = visibleBlocks();
    if (vis.length === 0) return "";
    const last = vis[vis.length - 1];
    return last.id || last.msg.id;
  });
  /** Sealed blocks not yet revealed (whole blocks, never bubbles). */
  const hiddenSeals = () => Math.max(0, sealedBlocks().length - sealedBudget());
  /** Reveal one more sealed block (whole turns, never mid-block). */
  function revealSeal() {
    setSealedBudget((n) => Math.min(n + 1, Math.max(1, sealedBlocks().length)));
  }
  /** Clear all seal notes (session switch / truncate): the next
   * snapshot or page re-seals from scratch. */
  function clearSeals() {
    setSealedBlocks([]);
    setSealedBudget(1);
  }
  function resetHistory() {
    historyRequestId = "";
    pendingHistoryRequests.clear();
    if (highlightClearTimer != null) {
      clearTimeout(highlightClearTimer);
      highlightClearTimer = null;
    }
    setHighlightedMsgIdx(null);
    setHistoryCursor(null);
    setHistoryArmed(false);
    setLoadingOlder(false);
    setLoadingNewer(false);
    clearSeals();
  }
  /** Unified "load older": reveal one more sealed block, fetching it
   * first when the daemon holds older turns. Every click moves exactly
   * one whole-turn seal (the counter always moves while hasOlder). Once
   * everything is loaded AND revealed, the button hides. The first click
   * arms scroll loading until the session is switched. */
  function loadOlder() {
    // First manual request arms scroll-driven loading from here on.
    setHistoryArmed(true);
    if (historyHasOlder() && !loadingOlder()) {
      requestOlderHistory();
      return;
    }
    if (hiddenSeals() > 0) {
      revealSeal();
      return;
    }
    // Nothing revealed-pending and daemon says more exists (cursor race
    // after truncate): fetch it.
    requestOlderHistory();
  }
  const historyHasOlder = () => historyCursor()?.hasOlder ?? false;
  const historyHasNewer = () => historyCursor()?.hasNewer ?? false;
  /** Oldest turn loaded locally (pagination frontier for balloons).
   * 0 when no cursor (full transcript) — everything renders. */
  const historyOldestTurn = () => historyCursor()?.oldestTurn ?? 0;
  const historyNewestTurn = () => historyCursor()?.newestTurn ?? 0;
  const historyHiddenTurns = () => {
    const cur = historyCursor();
    if (!cur || !cur.hasOlder) return 0;
    return Math.max(0, cur.oldestTurn - 1);
  };
  /** Ask the daemon for older/newer/around turn blocks. */
  let historyRequestId = "";
  const pendingHistoryRequests = new Map<string, "older" | "newer" | "around">();
  function requestOlderHistory() {
    const sid = opts.getSessionId();
    const cur = historyCursor();
    if (!sid || !cur || !cur.hasOlder || cur.oldestTurn <= 0 || loadingOlder()) return;
    setLoadingOlder(true);
    const reqId = crypto.randomUUID();
    historyRequestId = reqId;
    pendingHistoryRequests.set(reqId, "older");
    opts.send({ type: "get_history", sessionId: sid, beforeTurn: cur.oldestTurn, requestId: reqId });
  }
  function requestNewerHistory() {
    const sid = opts.getSessionId();
    const cur = historyCursor();
    if (!sid || !cur || !cur.hasNewer || loadingNewer()) return;
    let afterTurn = typeof cur.newestTurn === "number" && cur.newestTurn > 0 ? cur.newestTurn : 0;
    if (afterTurn <= 0) {
      const msgs = untrack(messages);
      for (let i = 0; i < msgs.length; i++) {
        const t = msgs[i].turnIndex;
        if (typeof t === "number" && t > afterTurn) afterTurn = t;
      }
    }
    if (afterTurn <= 0) return;
    setLoadingNewer(true);
    const reqId = crypto.randomUUID();
    pendingHistoryRequests.set(reqId, "newer");
    opts.send({ type: "get_history", sessionId: sid, afterTurn, requestId: reqId });
  }
  function requestAroundHistory(aroundMsgIdx: number) {
    const sid = opts.getSessionId();
    if (!sid || aroundMsgIdx < 0) return;
    pendingHistoryRequests.clear();
    historyRequestId = "";
    setLoadingOlder(false);
    setLoadingNewer(false);
    const reqId = crypto.randomUUID();
    pendingHistoryRequests.set(reqId, "around");
    pendingScrollMsgIdx = aroundMsgIdx;
    opts.send({ type: "get_history", sessionId: sid, aroundMsgIdx, requestId: reqId });
  }
  function buildSealList(prev: SealedBlock[], rawMsgs: any[], history: any): SealedBlock[] {
    if (!history || typeof history.oldestTurn !== "number") return prev;
    const oldestTurn = history.oldestTurn;
    const newestTurn = typeof history.newestTurn === "number" ? history.newestTurn : oldestTurn;
    const firstIndex = typeof history.firstIndex === "number" ? history.firstIndex : 0;
    if (prev.some((s) => s.oldestTurn === oldestTurn && s.newestTurn === newestTurn)) return prev;
    const next = [...prev, {
      oldestTurn,
      newestTurn,
      firstIndex,
      msgCount: Array.isArray(rawMsgs) ? rawMsgs.length : 0,
      hasOlderBelow: !!history.hasOlder,
    }];
    next.sort((a, b) => a.oldestTurn - b.oldestTurn);
    return next;
  }
  /** Seal a daemon block: note its turn range + raw base. Duplicate
   * seals (same oldestTurn) are ignored — retries never double-note. */
  function sealBlock(rawMsgs: any[], history: any) {
    if (!history || typeof history.oldestTurn !== "number") return;
    setSealedBlocks((prev) => buildSealList(prev, rawMsgs, history));
  }
  function captureViewportAnchor(el: HTMLDivElement | null, keepIds: Set<string>): { id: string; top: number } | null {
    if (!el) return null;
    const containerTop = el.getBoundingClientRect?.()?.top ?? 0;
    const nodes = el.querySelectorAll<HTMLElement>("[data-transcript-id]");
    let fallback: { id: string; top: number } | null = null;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const id = node.getAttribute("data-transcript-id") || "";
      if (!id || !keepIds.has(id)) continue;
      const rect = node.getBoundingClientRect?.();
      if (!rect) continue;
      const relTop = rect.top - containerTop;
      if (!fallback) fallback = { id, top: relTop };
      if (rect.bottom >= containerTop) {
        return { id, top: relTop };
      }
    }
    return fallback;
  }
  function restoreViewportAnchor(el: HTMLDivElement | null, anchor: { id: string; top: number } | null): boolean {
    if (!el || !anchor) return false;
    const nodes = el.querySelectorAll<HTMLElement>("[data-transcript-id]");
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.getAttribute("data-transcript-id") === anchor.id) {
        const containerTop = el.getBoundingClientRect?.()?.top ?? 0;
        const rect = node.getBoundingClientRect?.();
        if (!rect) return false;
        const delta = (rect.top - containerTop) - anchor.top;
        if (delta !== 0) {
          el.scrollTop += delta;
          return true;
        }
        return false;
      }
    }
    return false;
  }
  /** Apply a daemon history page (`older`, `newer`, or `around`), anchoring scroll and capping window to 180 turns. */
  async function noteHistoryPage(
    rawMsgs: any[],
    history: any,
    requestId?: string,
    onApplied?: () => void,
    wireDirection?: "older" | "newer" | "around",
  ) {
    let direction: "older" | "newer" | "around";
    if (requestId) {
      const tracked = pendingHistoryRequests.get(requestId);
      if (tracked) {
        pendingHistoryRequests.delete(requestId);
        direction = wireDirection || tracked;
      } else if (requestId === historyRequestId) {
        direction = wireDirection || "older";
      } else {
        return;
      }
    } else {
      direction = wireDirection || (history?.targetMsgIdx != null ? "around" : "older");
    }

    const version = contextVersion;
    const sid = opts.getSessionId();
    const host = opts.getHostId();
    const base = typeof history?.firstIndex === "number" ? history.firstIndex : 0;
    const el = chatContainerRef();
    const rawPage = await normalizeAsync(rawMsgs, base);
    const page = sharedBlobUrlCache.internMessages(rawPage, sid);
    // Stale guard: session switched or attached container disconnected while worker ran.
    if (version !== contextVersion || sid !== opts.getSessionId() || host !== opts.getHostId()) return;
    if (el && !el.isConnected) {
      setLoadingOlder(false);
      setLoadingNewer(false);
      return;
    }

    if (direction === "around") {
      transcriptScroll.detach();
      const targetIdx = typeof history?.targetMsgIdx === "number"
        ? history.targetMsgIdx
        : pendingScrollMsgIdx;
      pendingScrollMsgIdx = null;
      batch(() => {
        setMessages(orderedMessages(page));
        setSealedBlocks(buildSealList([], rawMsgs, history));
        setSealedBudget(1);
        if (history && typeof history.oldestTurn === "number") {
          setHistoryCursor({
            oldestTurn: history.oldestTurn,
            ...(typeof history.newestTurn === "number" ? { newestTurn: history.newestTurn } : {}),
            hasOlder: !!history.hasOlder,
            ...(typeof history.hasNewer === "boolean" ? { hasNewer: history.hasNewer } : {}),
            totalTurns: history.totalTurns ?? 0,
            ...(typeof history.firstIndex === "number" ? { firstIndex: history.firstIndex } : {}),
            ...(typeof history.targetMsgIdx === "number" ? { targetMsgIdx: history.targetMsgIdx } : {}),
          });
        }
        setLoadingOlder(false);
        setLoadingNewer(false);
        onApplied?.();
      });
      if (typeof targetIdx === "number") {
        flashHighlightedMessage(targetIdx);
        scrollToMessage(targetIdx);
      }
      return;
    }

    if (direction === "newer") {
      const prevMsgs = untrack(messages);
      const prevSeals = untrack(sealedBlocks);
      const prevCur = untrack(historyCursor);
      const known = new Set(prevMsgs.map((m) => m.id));
      const merged = preserveTransientToolPreviews(
        prevMsgs,
        orderedMessages([...prevMsgs, ...page.filter((m) => !known.has(m.id))]),
      );
      const rawSeals = buildSealList(prevSeals, rawMsgs, history);
      const baseCursor: HistoryCursor = {
        oldestTurn: prevCur?.oldestTurn ?? (typeof history?.oldestTurn === "number" ? history.oldestTurn : 1),
        newestTurn: typeof history?.newestTurn === "number" ? history.newestTurn : prevCur?.newestTurn,
        hasOlder: prevCur ? prevCur.hasOlder : !!history?.hasOlder,
        hasNewer: typeof history?.hasNewer === "boolean" ? history.hasNewer : false,
        totalTurns: typeof history?.totalTurns === "number" ? history.totalTurns : (prevCur?.totalTurns ?? 0),
        ...(typeof prevCur?.firstIndex === "number" ? { firstIndex: prevCur.firstIndex } : {}),
      };
      const canSlide = untrack(sessionStatus) !== "running" || Boolean(baseCursor.hasNewer) || Boolean(prevCur?.hasNewer);
      const slid = canSlide
        ? enforceSlidingTurnWindow(merged, rawSeals, baseCursor, "newer", MAX_WINDOW_TURNS)
        : { messages: merged, seals: rawSeals, cursor: baseCursor, prunedTurns: 0 };

      const keepIds = new Set(slid.messages.map((m) => m.id));
      const anchor = slid.prunedTurns > 0 ? captureViewportAnchor(el, keepIds) : null;
      const prevHeight = el ? el.scrollHeight : 0;
      const prevTop = el ? el.scrollTop : 0;

      batch(() => {
        setMessages(slid.messages);
        setSealedBlocks(slid.seals);
        setSealedBudget((n) => Math.min(Math.max(1, slid.seals.length), n + 1));
        setHistoryCursor(slid.cursor);
        setLoadingNewer(false);
        onApplied?.();
      });

      if (slid.prunedTurns > 0 && el) {
        if (!restoreViewportAnchor(el, anchor)) {
          const shrunk = prevHeight - el.scrollHeight;
          if (shrunk > 0) el.scrollTop = Math.max(0, prevTop - shrunk);
        }
      }
      return;
    }

    // direction === "older"
    const prevMsgs = untrack(messages);
    const prevSeals = untrack(sealedBlocks);
    const prevCur = untrack(historyCursor);
    const known = new Set(prevMsgs.map((m) => m.id));
    const merged = preserveTransientToolPreviews(
      prevMsgs,
      orderedMessages([...page.filter((m) => !known.has(m.id)), ...prevMsgs]),
    );
    const rawSeals = buildSealList(prevSeals, rawMsgs, history);
    const baseCursor: HistoryCursor = history && typeof history.oldestTurn === "number"
      ? {
          oldestTurn: history.oldestTurn,
          ...(typeof prevCur?.newestTurn === "number"
            ? { newestTurn: prevCur.newestTurn }
            : typeof history.newestTurn === "number"
              ? { newestTurn: history.newestTurn }
              : {}),
          hasOlder: !!history.hasOlder,
          ...(prevCur?.hasNewer ? { hasNewer: true } : typeof history.hasNewer === "boolean" ? { hasNewer: history.hasNewer } : {}),
          totalTurns: history.totalTurns ?? prevCur?.totalTurns ?? 0,
          ...(typeof history.firstIndex === "number" ? { firstIndex: history.firstIndex } : {}),
        }
      : {
          oldestTurn: prevCur?.oldestTurn ?? 0,
          ...(typeof prevCur?.newestTurn === "number" ? { newestTurn: prevCur.newestTurn } : {}),
          hasOlder: false,
          ...(prevCur?.hasNewer ? { hasNewer: true } : {}),
          totalTurns: prevCur?.totalTurns ?? 0,
        };

    const canSlide = untrack(sessionStatus) !== "running" || Boolean(prevCur?.hasNewer);
    const slid = canSlide
      ? enforceSlidingTurnWindow(merged, rawSeals, baseCursor, "older", MAX_WINDOW_TURNS)
      : { messages: merged, seals: rawSeals, cursor: baseCursor, prunedTurns: 0 };

    if (slid.prunedTurns > 0) {
      transcriptScroll.detach();
    }
    const keepIds = new Set(slid.messages.map((m) => m.id));
    const anchor = captureViewportAnchor(el, keepIds);
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;

    batch(() => {
      setMessages(slid.messages);
      setSealedBlocks(slid.seals);
      setSealedBudget((n) => (slid.prunedTurns > 0 ? Math.max(1, slid.seals.length) : n + 1));
      setHistoryCursor(slid.cursor);
      setLoadingOlder(false);
      onApplied?.();
    });

    if (el) {
      if (!restoreViewportAnchor(el, anchor)) {
        const grown = el.scrollHeight - prevHeight;
        if (grown > 0) el.scrollTop = prevTop + grown;
      }
    }
  }
  function onChatScroll() {
    transcriptScroll.measure();
    const el = chatContainerRef();
    if (!el) return;
    if (historyHasNewer() && !loadingNewer() && el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
      requestNewerHistory();
    }
    if (el.scrollTop >= 400) return;
    // Button-first: nothing loads on scroll until the user opts in with
    // one click on the load-older button (arming resets on session
    // switch, like pin-at-bottom re-pinning). Without a click, scroll
    // does nothing — opening a session at the top never auto-loads.
    if (!historyArmed()) return;
    // Same rule as the button: fetch-then-reveal, one whole seal at a
    // time. Revealing a hidden seal needs no fetch.
    if (historyHasOlder()) {
      if (!loadingOlder()) requestOlderHistory();
      return;
    }
    if (hiddenSeals() > 0) {
      revealSeal();
      return;
    }
  }
  // The live tail always renders (no window to pin): streaming needs
  // no budget adjustment. Sealed blocks below stay as the reader left
  // them until "load older" reveals more.

  // Rendered position → raw daemon transcript index (normalization merges
  // tool envelopes, so naive For indices mismatch the raw array).
  function rawIdx(idx: number): number {
    return messages()[idx]?.srcIdx ?? idx;
  }
  /** Raw daemon index of a render block's lead message. */
  function blockRawIdx(block: RenderBlock): number {
    if (block.msg.srcIdx != null) return block.msg.srcIdx;
    const i = messages().findIndex((msg) => msg.id === block.msg.id);
    return i >= 0 ? i : 0;
  }

  /** Newest in-flight tool progress line inside a series (spinner sidecar). */
  function specialProgress(units: ToolUnit[]): string | undefined {
    for (let i = units.length - 1; i >= 0; i--) {
      const id = units[i].call?.toolId;
      const t = id ? toolProgress()[id] : undefined;
      if (t) return t;
    }
    return undefined;
  }

  // --- History worker (normalize off the main thread) ---
  // Pages/snapshots above this size go through the worker; small ones
  // stay synchronous (no postMessage round-trip overhead).
  const WORKER_MIN_MESSAGES = 15;
  const WORKER_MIN_CHARS = 16_384;
  function shouldUseHistoryWorker(rawMsgs: any[]): boolean {
    const len = rawMsgs?.length ?? 0;
    if (len >= WORKER_MIN_MESSAGES) return true;
    let chars = 0;
    for (let i = 0; i < len; i++) {
      const c = rawMsgs[i]?.content;
      if (typeof c === "string") {
        chars += c.length;
        if (chars >= WORKER_MIN_CHARS) return true;
      } else if (Array.isArray(c)) {
        for (let j = 0; j < c.length; j++) {
          const part = c[j];
          chars += (typeof part?.text === "string" ? part.text.length : 0) + (typeof part?.data === "string" ? part.data.length : 0);
          if (chars >= WORKER_MIN_CHARS) return true;
        }
      }
    }
    return false;
  }
  let historyWorker: Worker | null = null;
  let historyWorkerSeq = 0;
  const historyWorkerWaiters = new Map<number, { resolve: (page: ChatMessage[]) => void; fallback: () => ChatMessage[] }>();
  function getHistoryWorker(): Worker | null {
    if (historyWorker) return historyWorker;
    try {
      // Served from dist/workers/history-worker.js (separate build
      // entry in build.ts); same-origin with the dashboard always.
      historyWorker = new Worker("workers/history-worker.js", { type: "module" });
      historyWorker.onmessage = (ev: MessageEvent<{ seq: number; page: ChatMessage[] }>) => {
        const w = historyWorkerWaiters.get(ev.data?.seq);
        if (w) {
          historyWorkerWaiters.delete(ev.data.seq);
          w.resolve(Array.isArray(ev.data.page) ? ev.data.page : []);
        }
      };
      historyWorker.onerror = () => {
        historyWorker?.terminate(); historyWorker = null;
        const waiters = [...historyWorkerWaiters.values()]; historyWorkerWaiters.clear();
        for (const waiter of waiters) waiter.resolve(waiter.fallback());
      };
    } catch {
      historyWorker = null;
    }
    return historyWorker;
  }
  /** Normalize via worker when large, synchronously when small/absent. */
  function normalizeAsync(rawMsgs: any[], indexBase: number): Promise<ChatMessage[]> | ChatMessage[] {
    const w = shouldUseHistoryWorker(rawMsgs) ? getHistoryWorker() : null;
    if (!w) return normalizeSessionMessages(rawMsgs, [], indexBase);
    return new Promise((resolve) => {
      const seq = ++historyWorkerSeq;
      const fallback = () => normalizeSessionMessages(rawMsgs, [], indexBase);
      historyWorkerWaiters.set(seq, { resolve, fallback });
      try { w.postMessage({ seq, rawMsgs, indexBase }); }
      catch { historyWorkerWaiters.delete(seq); resolve(fallback()); }
    });
  }

  // --- Session fetch (get_session with dedicated requestId) ---
  // Pending fetch ids: a single "current id" used to drop a resync response
  // when a concurrent fetchSession overwrote it (audit bug 79 — waiting stuck
  // forever, transcript frozen). Every issued id stays acceptable until its
  // answer arrives; the session guard still rejects foreign-session snapshots.
  const pendingFetchIds = new Set<string>();
  let initialScrollSession = "";
  let pendingScrollMsgIdx: number | null = null;
  function fetchSession(sessionId: string, fetchOpts?: { aroundMsgIdx?: number; aroundTurn?: number }) {
    const requestId = crypto.randomUUID();
    pendingFetchIds.add(requestId);
    opts.send({
      type: "get_session",
      sessionId,
      requestId,
      ...(typeof fetchOpts?.aroundMsgIdx === "number" ? { aroundMsgIdx: fetchOpts.aroundMsgIdx } : {}),
      ...(typeof fetchOpts?.aroundTurn === "number" ? { aroundTurn: fetchOpts.aroundTurn } : {}),
    });
  }
  /** Marks the session whose next full snapshot triggers initial scroll. */
  function beginLoad(sessionId: string, targetMsgIdx?: number) {
    initialScrollSession = sessionId;
    pendingScrollMsgIdx = typeof targetMsgIdx === "number" ? targetMsgIdx : null;
  }
  function scrollToMessage(msgIdx: number) {
    transcriptScroll.detach();
    const tryScroll = () => {
      const container = chatContainerRef();
      if (!container) return false;
      const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-raw-idx]"));
      let targetEl: HTMLElement | null = null;
      for (const el of elements) {
        const raw = parseInt(el.getAttribute("data-raw-idx") || "-1", 10);
        if (raw === msgIdx) {
          targetEl = el;
          break;
        }
        if (raw < msgIdx) {
          targetEl = el;
        }
      }
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      setTimeout(tryScroll, 100);
    }
  }
  /** Same-session search/history jump: scroll immediately if loaded, else request centered window. */
  function jumpToMessage(msgIdx: number) {
    const msgs = untrack(messages);
    if (msgs.length > 0) {
      let minSrc = Infinity;
      let maxSrc = -Infinity;
      for (let i = 0; i < msgs.length; i++) {
        const s = msgs[i].srcIdx;
        if (typeof s === "number") {
          if (s < minSrc) minSrc = s;
          if (s > maxSrc) maxSrc = s;
        }
      }
      if (minSrc <= maxSrc && msgIdx >= minSrc && msgIdx <= maxSrc) {
        const vis = untrack(visibleBlocks);
        const firstVisSrc = vis.length > 0 ? untrack(() => blockRawIdx(vis[0])) : minSrc;
        if (msgIdx < firstVisSrc && hiddenSeals() > 0) {
          setSealedBudget(Math.max(1, untrack(sealedBlocks).length));
        }
        flashHighlightedMessage(msgIdx);
        scrollToMessage(msgIdx);
        return;
      }
    }
    requestAroundHistory(msgIdx);
  }
  /** Return from detached older history back to the live latest window and pin at bottom. */
  function reloadLatest() {
    const sid = opts.getSessionId();
    if (!sid) return;
    pendingHistoryRequests.clear();
    historyRequestId = "";
    setLoadingOlder(false);
    setLoadingNewer(false);
    setHistoryCursor(null);
    clearSeals();
    initialScrollSession = sid;
    pendingScrollMsgIdx = null;
    transcriptScroll.pin();
    setIsAtBottom(true);
    fetchSession(sid);
  }
  const transcriptOrder = createTranscriptOrder(() => { const sid=opts.getSessionId(); if(sid && opts.isOpen()) fetchSession(sid); });
  let contextVersion = 0;
  let snapshotVersion = 0;
  let pendingSnapshot: { replay: (() => void)[] } | null = null;
  let lastAppliedTranscriptSig: { sid: string; host: string; sig: string } | null = null;

  function hashFeedStr(h: { a: number; b: number; chars: number }, s: string) {
    let a = (h.a ^ s.length) | 0;
    let b = (h.b + s.length) | 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      a = Math.imul(a ^ code, 16777619);
      b = (Math.imul(b, 31) + code) | 0;
    }
    h.a = a;
    h.b = b;
    h.chars += s.length;
  }

  function hashFeedVal(h: { a: number; b: number; chars: number }, v: any, depth: number) {
    if (v === null || v === undefined) {
      hashFeedStr(h, v === null ? "N" : "U");
      return;
    }
    const t = typeof v;
    if (t === "string") {
      hashFeedStr(h, "S:");
      hashFeedStr(h, v);
      return;
    }
    if (t === "number" || t === "boolean") {
      hashFeedStr(h, `${t[0]}:${String(v)};`);
      return;
    }
    if (depth > 5) return;
    if (Array.isArray(v)) {
      hashFeedStr(h, `[${v.length}:`);
      for (let i = 0; i < v.length; i++) hashFeedVal(h, v[i], depth + 1);
      hashFeedStr(h, "]");
      return;
    }
    if (t === "object") {
      const keys = Object.keys(v);
      hashFeedStr(h, `{${keys.length}:`);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        hashFeedStr(h, k);
        hashFeedVal(h, v[k], depth + 1);
      }
      hashFeedStr(h, "}");
    }
  }

  function hashTranscriptPayload(rawMsgs: any[], compaction: any, history: any): string {
    const h = { a: -2128831035, b: 5381, chars: 0 };
    const len = Array.isArray(rawMsgs) ? rawMsgs.length : 0;
    hashFeedVal(h, rawMsgs, 0);
    hashFeedVal(h, compaction ?? null, 0);
    hashFeedVal(h, history ?? null, 0);
    const firstId = len > 0 ? String(rawMsgs[0]?.id ?? rawMsgs[0]?.role ?? "") : "";
    const lastId = len > 0 ? String(rawMsgs[len - 1]?.id ?? rawMsgs[len - 1]?.role ?? "") : "";
    return `${len}:${h.chars}:${h.a >>> 0}:${h.b >>> 0}:${firstId}:${lastId}`;
  }

  async function applySessionContent(sessionId: string, rawMsgs: any[], compaction?: any, history?: any, overlay?: any) {
    if(sessionId!==opts.getSessionId()) return;
    // Preserve detached mid-history window against unsolicited background tail updates.
    if (
      untrack(historyHasNewer) &&
      !history?.hasNewer &&
      history?.targetMsgIdx == null &&
      !overlay?.requestId &&
      initialScrollSession !== sessionId &&
      pendingScrollMsgIdx == null
    ) {
      batch(() => {
        overlay?.applyMetadata?.();
        if (compaction !== undefined) {
          setSessionCompaction(compaction);
          setCompactingText("");
        }
      });
      return;
    }
    const version = ++snapshotVersion;
    const host = opts.getHostId();
    const rawInput = rawMsgs;
    const isLiveOverlay = Boolean(
      overlay?.status === "running" || overlay?.liveMessage || overlay?.pendingToolResults?.length,
    );
    if (isLiveOverlay) lastAppliedTranscriptSig = null;
    if (overlay?.liveMessage) rawMsgs=[...rawMsgs,overlay.liveMessage];
    if (overlay?.pendingToolResults?.length) {
      // A transient result can only decorate a call in this snapshot. Older
      // daemons retained committed results beyond the page containing the call.
      const calls = new Set(rawMsgs.flatMap(m => parseContentBlocks(m).filter(b => b.type === "tool_call").map(b => b.toolId)));
      const pending = overlay.pendingToolResults.filter((r: any) => calls.has(r.call_id || r.tool_use_id || r.id));
      if (pending.length) rawMsgs=[...rawMsgs,{role:"tool",content:pending}];
    }
    pendingSnapshot = null;
    const paged = history && typeof history.oldestTurn === "number";
    const base = paged && typeof history.firstIndex === "number" ? history.firstIndex : 0;
    const normalized = !paged && !shouldUseHistoryWorker(rawMsgs)
      ? normalizeSessionMessages(rawMsgs, messages()) : normalizeAsync(rawMsgs, base);
    let tail: ChatMessage[];
    if (Array.isArray(normalized)) {
      // Small snapshots commit synchronously, before the next wire event.
      tail = sharedBlobUrlCache.internMessages(normalized, sessionId);
    } else {
      pendingSnapshot = { replay: [] };
      tail = sharedBlobUrlCache.internMessages(await normalized, sessionId);
    }
    if (version !== snapshotVersion || sessionId !== opts.getSessionId() || host !== opts.getHostId()) return;
    const orderedReplay: (() => void)[] | null =
      overlay?.preOrderedReplay !== undefined
        ? overlay.preOrderedReplay
        : transcriptOrder.snapshot(overlay?.transcript);
    if (orderedReplay===null) { pendingSnapshot=null; return; }
    const replay = overlay?.transcript ? orderedReplay : pendingSnapshot?.replay || [];
    pendingSnapshot = null;
    const isAroundSnapshot = Boolean(history?.hasNewer || typeof history?.targetMsgIdx === "number");
    if (isAroundSnapshot || pendingScrollMsgIdx != null) {
      transcriptScroll.detach();
    }
    batch(() => {
      overlay?.applyMetadata?.();
      if (isAroundSnapshot) {
        setMessages(orderedMessages(tail));
        setSealedBlocks(buildSealList([], rawMsgs, history));
        setSealedBudget(1);
        setHistoryCursor({
          oldestTurn: history.oldestTurn,
          ...(typeof history.newestTurn === "number" ? { newestTurn: history.newestTurn } : {}),
          hasOlder: !!history.hasOlder,
          ...(typeof history.hasNewer === "boolean" ? { hasNewer: history.hasNewer } : {}),
          totalTurns: history.totalTurns ?? 0,
          ...(typeof history.firstIndex === "number" ? { firstIndex: history.firstIndex } : {}),
          ...(typeof history.targetMsgIdx === "number" ? { targetMsgIdx: history.targetMsgIdx } : {}),
        });
      } else if (paged) {
        setMessages((prev) => {
          return mergeTranscriptTail(prev, tail, base);
        });
        sealBlock(rawMsgs, history);
        setSealedBudget((n) => Math.max(n, sealedBlocks().length));
        if (!overlay?.applyMetadata) {
          setHistoryCursor((prev) => nextHistoryCursor(prev, history, sealedBlocks()));
        }
      } else {
        setMessages((prev) => preserveTransientToolPreviews(prev, tail));
        if (!overlay?.applyMetadata) {
          setHistoryCursor(null);
        }
      }
      restoreEditDraft();
      if (compaction !== undefined) {
        setSessionCompaction(compaction);
        setCompactingText("");
      }
      // A worker snapshot must not overwrite deltas/status received while it
      // was normalizing. Replay only the events after this exact snapshot.
      for (const apply of replay) apply();
    });
    if (!isLiveOverlay && replay.length === 0) {
      lastAppliedTranscriptSig = {
        sid: sessionId,
        host,
        sig: hashTranscriptPayload(rawInput, compaction, history),
      };
    } else {
      lastAppliedTranscriptSig = null;
    }
    const targetMsg = pendingScrollMsgIdx ?? (typeof history?.targetMsgIdx === "number" ? history.targetMsgIdx : null);
    if (initialScrollSession === sessionId) {
      initialScrollSession = "";
      if (targetMsg != null) {
        pendingScrollMsgIdx = null;
        flashHighlightedMessage(targetMsg);
        setTimeout(() => scrollToMessage(targetMsg), 50);
      } else {
        if (transcriptScroll.isPinned() && !untrack(historyHasNewer)) scrollToBottom(true);
      }
    } else if (targetMsg != null) {
      pendingScrollMsgIdx = null;
      flashHighlightedMessage(targetMsg);
      setTimeout(() => scrollToMessage(targetMsg), 50);
    } else if (!untrack(historyHasNewer)) {
      scrollToBottom();
    }
  }
  onCleanup(() => {
    snapshotVersion++;
    pendingSnapshot = null;
    lastAppliedTranscriptSig = null;
    if (highlightClearTimer != null) {
      clearTimeout(highlightClearTimer);
      highlightClearTimer = null;
    }
    historyWorker?.terminate();
    for (const waiter of historyWorkerWaiters.values()) waiter.resolve([]);
    historyWorkerWaiters.clear();
  });
  function applyUsage(sessionId: string, u: any, cum: any) {
    setSessionUsage((prev) => mergeUsage(prev, sessionId, u, cum));
  }

  /** Transcript-owned block of the session_data event (model/options live in
   * the options domain; workspace in the workspace domain — the page composes). */
  function applySnapshot(sid: string, r: any, onApplied?:()=>void, snapOpts?: { requestId?: string }) {
    const applyMetadata = () => {
    if (r.workspace) setWorkspaceSnapshot(r.workspace);
    setSessionStatus(r.status === "running" ? "running" : "idle");
    setSessionCompaction(r.compaction ?? null);
    setCompactingText("");
    setTurnActivity(previous => normalizeTurnActivity(r.turn, previous));
    setTurnClock(Date.now());
    if (r.history && typeof r.history.oldestTurn === "number") {
      const tailHistory = r.history;
      // A tail snapshot must not regress the pagination frontier once the
      // reader pulled older turns and a seal proves they are loaded.
      setHistoryCursor((prev) => nextHistoryCursor(prev, tailHistory, sealedBlocks()));
    } else {
      setHistoryCursor(null);
    }
    setLoadingOlder(false);
    setTodos(r.todos || []);
    if (typeof r.todosOpen === "boolean") applyTodosOpenFromRemote(r.todosOpen);

    showQuestion(r.question || null);
    // Progress text may embed raw envelope XML (streamed/replayed
    // snapshots): strip it at ingestion so it never renders in a body.
    setToolProgress(Object.fromEntries(Object.entries(r.toolProgress || {}).map(([k, v]) => [k, stripToolEnvelopeDetailed(String(v)).body])));
    setToolStarts(r.toolStarts || {});
    setPendingApproval(r.pendingApproval ? { ...r.pendingApproval, args: prettyArgs(r.pendingApproval.args) } : null);
    if (r.thinkingStartedAt && r.status === "running") startThinkingTimer(r.thinkingStartedAt);
    else stopThinkingTimer();
    if (r.usage) applyUsage(sid, r.usage, null);
    setSessionContexts((prev) => ({ ...prev, [sid]: r.context ?? null }));
    onApplied?.();
    };

    const rawMsgs = r.messages || r.Messages || [];
    if (
      !snapOpts?.requestId &&
      sid === opts.getSessionId() &&
      initialScrollSession !== sid &&
      pendingSnapshot === null &&
      r.status !== "running" &&
      untrack(sessionStatus) !== "running" &&
      !r.liveMessage &&
      !(r.pendingToolResults?.length) &&
      lastAppliedTranscriptSig !== null &&
      lastAppliedTranscriptSig.sid === sid &&
      lastAppliedTranscriptSig.host === opts.getHostId()
    ) {
      const nextSig = hashTranscriptPayload(rawMsgs, r.compaction, r.history);
      if (nextSig === lastAppliedTranscriptSig.sig) {
        const orderedReplay = transcriptOrder.snapshot(r.transcript);
        if (orderedReplay === null) return;
        if (orderedReplay.length === 0) {
          snapshotVersion++;
          batch(() => {
            applyMetadata();
          });
          return;
        }
        applySessionContent(sid, rawMsgs, r.compaction, r.history, {
          ...r,
          applyMetadata,
          preOrderedReplay: orderedReplay,
        });
        return;
      }
    }

    applySessionContent(sid, rawMsgs, r.compaction, r.history, { ...r, applyMetadata });
  }

  // Point-in-time workspace received in the snapshot — redirected by the page via
  // setWorkspaceSink (avoids coupling the transcript to the workspace domain).
  let workspaceSink: ((w: any) => void) | null = null;
  function setWorkspaceSink(fn: (w: any) => void) {
    workspaceSink = fn;
  }
  function setWorkspaceSnapshot(w: any) {
    workspaceSink?.(w);
  }

  function stampThinkingDuration(dur: number) {
    setMessages((prev) => stampDuration(prev, dur));
  }
  function appendReasoningDelta(delta: string) {
    if (!delta) return;
    lastAppliedTranscriptSig = null;
    if (thinkingStart() === null) startThinkingTimer();
    setMessages((prev) => reduceReasoningDelta(prev, delta));
    // The live clock/ticks belong to this message's first reasoning block.
    setThinkingIndex(0);
  }
  function appendToolArgsDelta(callId: string, delta: string) {
    if (!delta) return;
    lastAppliedTranscriptSig = null;
    setMessages((prev) => reduceToolArgs(prev, callId, delta));
  }
  function appendToolResult(callId: string, result: string | undefined, isError?: boolean, startedAt?: number, durationMs?: number, details?: any, messageId?:string) {
    lastAppliedTranscriptSig = null;
    setMessages((prev) => reduceToolResult(prev, callId, result, isError, startedAt, durationMs, details, messageId));
  }
  function cancelTurnForSession(sessionId: string, e?: MouseEvent | KeyboardEvent) {
    e?.stopPropagation();
    if (!sessionId || !opts.isOpen()) return;
    // Stop-spam guard: the sidebar button already disables itself while
    // "cancelling", but the composer Stop button and keyboard paths
    // don't — and the daemon treats a second cancel as a no-op anyway.
    // Skip the duplicate send so an anxious double-click can't stack
    // redundant cancels behind a slow relay.
    if (sessionId === opts.getSessionId() && turnActivity()?.status === "cancelling") return;
    opts.send({ type: "cancel", sessionId });
    if (sessionId === opts.getSessionId()) {
      setTurnActivity((turn) => turn ? { ...turn, status: "cancelling" } : null);
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      transcriptScroll.detach();
    }
  }
  function cancelCurrentTurn() {
    cancelTurnForSession(opts.getSessionId());
  }
  function respondApproval(approved: boolean, always = false) {
    const p = pendingApproval();
    if (!p || !opts.getSessionId()) return;
    opts.send({
      type: "tool_approval_response",
      sessionId: opts.getSessionId(),
      callId: p.callId,
      approved,
      always,
    });
    setPendingApproval(null);
  }

  const [forking, setForking] = createSignal(false);
  let forkRequestId = "";
  let forkHostId = "";
  let forkSessionId = "";
  let forkEditPending = false;
  let forkEditSource: typeof editSource = null;
  let forkEditFingerprint = "";
  function forkMessage(block: RenderBlock) {
    const sid = opts.getSessionId();
    const host = opts.getHostId();
    if (!sid || !opts.isOpen() || forking()) return;
    const last = block.kind === "series" ? block.extras.at(-1) || block.msg : block.msg;
    if (last.srcIdx == null) return;
    forkRequestId = crypto.randomUUID();
    forkHostId = host;
    forkSessionId = sid;
    forkEditPending = false;
    forkEditSource = null;
    forkEditFingerprint = "";
    setForking(true);
    opts.onForkKind?.("fork");
    opts.send({ type: "fork_session", sessionId: sid, index: last.srcIdx, requestId: forkRequestId });
  }
  // Regenerate from message idx: the daemon drops that message and everything
  // after it, then re-runs the turn (chatbot regenerateMessage semantics).
  // Offers fork-vs-resend: fork preserves the current timeline in a copy.
  async function regenerateMsg(idx: number, getModel: () => string, getYolo: () => boolean) {
    const sid = opts.getSessionId();
    const host = opts.getHostId();
    if (!sid || !opts.isOpen()) return;
    if (sessionStatus() === "running") {
      opts.toast("Stop the current turn first", "err");
      return;
    }

    const msgs = messages();
    // Locate the user message that prompted this assistant turn.
    // Search backwards from idx in messages() for the preceding user message.
    let userMsg: ChatMessage | null = null;
    for (let k = msgs.length - 1; k >= 0; k--) {
      if (msgs[k]?.role === "user" && (msgs[k].srcIdx ?? k) <= idx) {
        userMsg = msgs[k];
        break;
      }
    }
    if (!userMsg) return;
    const userText = userMsg ? messageText(userMsg) : "";

    const choice = await opts.showChoice({
      title: "Regenerate response?",
      message: "Everything from this point down will be discarded and the turn re-runs from the previous user message.\n\nFork keeps the current timeline in a copy and regenerates there instead.",
      options: [
        { id: "resend", label: "Discard & regenerate", hint: "Discards the tail and resends here", primary: true },
        { id: "fork", label: "Fork & regenerate", hint: "Preserves here, regenerates in a copy" },
      ],
    });
    if (!choice || opts.getHostId() !== host || opts.getSessionId() !== sid || !opts.isOpen() || sessionStatus() === "running") return;
    if (choice === "fork") {
      forkRequestId = crypto.randomUUID();
      forkHostId = host;
      forkSessionId = sid;
      forkEditPending = false;
      setForking(true);
      opts.onForkKind?.("regenerate");
      opts.send({
        type: "fork_and_resend",
        sessionId: sid,
        requestId: forkRequestId,
        turnId: userMsg?.turnIndex || 0,
        text: userText,
        model: getModel(),
        yolo: getYolo(),
        attachmentIds: userMsg?.attachments?.map((a) => a.id),
      });
      return;
    }
    // ATOMIC discard&resend (empty text = regenerate: the daemon reuses
    // the boundary row's original text).
    resendRequestId = crypto.randomUUID();
    resendHostId = host;
    resendSessionId = sid;
    resendEditSource = null;
    resendEditFingerprint = "";
    opts.onForkKind?.("regenerate");
    opts.send({
      type: "discard_and_resend",
      sessionId: sid,
      requestId: resendRequestId,
      turnId: userMsg?.turnIndex || 0,
      text: userText,
      model: getModel(),
      yolo: getYolo(),
      attachmentIds: userMsg?.attachments?.map((a) => a.id),
    });
    setSessionStatus("running");
  }

  /** discard_and_resend / edit_message ACK: the daemon committed (or
   * refused). On success the originating edit buffer may be cleared after
   * the daemon ACK; transcript cuts remain event-driven. On error the text
   * STAYS on screen — nothing was lost. */
  function noteResendResult(msg: any) {
    if (!resendRequestId || msg.requestId !== resendRequestId || msg.sessionId !== resendSessionId ||
      opts.getSessionId() !== resendSessionId || (msg.hostId !== undefined && msg.hostId !== resendHostId) ||
      opts.getHostId() !== resendHostId) return;
    if (msg.ok) {
      if (resendEditSource && editSource === resendEditSource && editingMsgIdx() === resendEditSource.idx &&
        editFingerprint() === resendEditFingerprint) cancelEditMsg();
      resendEditSource = null;
      resendEditFingerprint = "";
      resendRequestId = "";
      resendHostId = "";
      resendSessionId = "";
      return;
    }
    resendEditSource = null;
    resendEditFingerprint = "";
    resendRequestId = "";
    resendHostId = "";
    resendSessionId = "";
    setSessionStatus("idle");
    opts.toast(msg.error || "Could not resend the message", "err");
  }
  let resendRequestId = "";
  let resendHostId = "";
  let resendSessionId = "";
  let resendEditSource: typeof editSource = null;
  let resendEditFingerprint = "";
  let editSource: { host: string; sid: string; idx: number; source: string } | null = null;
  function editDraftPrefix() {
    return `llmgw-edit:${opts.getHostId()}:${opts.getSessionId()}:`;
  }
  function sourceOf(m: ChatMessage) {
    return JSON.stringify([m.role, messageText(m), (m.attachments || []).map((a) => a.id)]);
  }
  function editFingerprint() {
    return JSON.stringify([
      editingMsgText(),
      editingAttachments().map((a) => a.id),
      editAttachments.pendingAttachments().map((a) => a.key),
    ]);
  }

  const EDIT_DRAFT_DEBOUNCE_MS = 250;
  let editDraftTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelEditDraftTimer() {
    if (editDraftTimer !== null) {
      clearTimeout(editDraftTimer);
      editDraftTimer = null;
    }
  }

  function persistEditDraft() {
    cancelEditDraftTimer();
    if (!editSource || editSource.host !== opts.getHostId() || editSource.sid !== opts.getSessionId() || editingMsgIdx() !== editSource.idx) return;
    try {
      localStorage.setItem(`${editDraftPrefix()}${editSource.idx}`, JSON.stringify({
        source: editSource.source, text: editingMsgText(), attachmentIds: editingAttachments().map((a) => a.id),
      }));
      localStorage.setItem(`${editDraftPrefix()}active`, String(editSource.idx));
    } catch {}
  }

  function schedulePersistEditDraft() {
    cancelEditDraftTimer();
    editDraftTimer = setTimeout(() => {
      editDraftTimer = null;
      persistEditDraft();
    }, EDIT_DRAFT_DEBOUNCE_MS);
  }

  function flushEditDraft() {
    if (editDraftTimer !== null) {
      persistEditDraft();
    }
  }

  if (typeof document !== "undefined") {
    const onVisibilityDraftFlush = () => {
      if (document.visibilityState === "hidden") flushEditDraft();
    };
    document.addEventListener("visibilitychange", onVisibilityDraftFlush);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibilityDraftFlush));
  }
  if (typeof window !== "undefined") {
    const onPageHideDraftFlush = () => flushEditDraft();
    window.addEventListener("pagehide", onPageHideDraftFlush);
    onCleanup(() => window.removeEventListener("pagehide", onPageHideDraftFlush));
  }
  onCleanup(() => flushEditDraft());

  function clearEditDraft(idx: number) {
    cancelEditDraftTimer();
    try {
      localStorage.removeItem(`${editDraftPrefix()}${idx}`);
      localStorage.removeItem(`${editDraftPrefix()}active`);
    } catch {}
  }
  createEffect(() => {
    editingAttachments();
    untrack(() => persistEditDraft());
  });

  function restoreEditDraft() {
    if (editingMsgIdx() != null) {
      const idx = editingMsgIdx() ?? -1;
      const current = messages().find((m) => m.srcIdx === idx);
      if (current && sourceOf(current) === editSource?.source) return;
      // The message moved (truncation/compaction/resend): the edit follows it
      // by content instead of being cancelled — the typed text is never lost.
      const source = editSource?.source;
      const moved = source === undefined
        ? undefined
        : messages().find((m) => m.role === "user" && sourceOf(m) === source);
      if (moved && typeof moved.srcIdx === "number" && source !== undefined) {
        const targetIdx = moved.srcIdx;
        batch(() => {
          editSource = { host: opts.getHostId(), sid: opts.getSessionId(), idx: targetIdx, source: source };
          setEditingMsgIdx(targetIdx);
          persistEditDraft();
        });
        return;
      }
      // Message gone: drop the in-progress edit but keep the typed draft in
      // localStorage for manual recovery (never delete the user's text here).
      batch(() => {
        editAttachments.clearAttachments();
        setEditingAttachments([]);
        editSource = null;
        setEditingMsgIdx(null);
        setEditingMsgText("");
      });
      return;
    }
    try {
      const saved = localStorage.getItem(`${editDraftPrefix()}active`);
      if (saved == null) return;
      const idx = Number(saved);
      const draft = JSON.parse(localStorage.getItem(`${editDraftPrefix()}${idx}`) || "null");
      if (typeof draft?.text !== "string" || typeof draft?.source !== "string") return;
      // The message may sit at another srcIdx now: match it by content and
      // re-anchor the draft there. A lookup miss KEEPS the draft for manual
      // recovery — deleting it silently lost the user's typed text.
      const msg = messages().find((m) => m.srcIdx === idx && m.role === "user" && sourceOf(m) === draft.source)
        ?? messages().find((m) => m.role === "user" && sourceOf(m) === draft.source);
      const target = msg?.srcIdx;
      if (msg == null || target == null) return;
      if (target !== idx) {
        // Re-anchor: the old key stays (manual recovery); the pointer and a
        // copy move to the message's new home.
        localStorage.setItem(`${editDraftPrefix()}${target}`, JSON.stringify(draft));
        localStorage.setItem(`${editDraftPrefix()}active`, String(target));
      }
      startEditMsg(target, msg);
    } catch {}
  }

  const editMentions = createMentions({ ...opts, getProjectId: () => opts.getProjectId?.() || "",
    text: editingMsgText, setText: updateEditingMsgText, inputId: "rc-editing-msg" });

  // Inline edit (chatbot startEditMessage): user edits resubmit, assistant
  // edits just save. The in-progress text stays in this browser only
  // (localStorage per host+session+message) and is restored on reopen.
  function startEditMsg(idx: number, m: ChatMessage) {
    batch(() => {
      editAttachments.clearAttachments();
      setEditingAttachments(m.attachments || []);
      setEditingMsgIdx(idx);
      editSource = { host: opts.getHostId(), sid: opts.getSessionId(), idx, source: sourceOf(m) };
      let text = messageText(m);
      try {
        const saved = JSON.parse(localStorage.getItem(`${editDraftPrefix()}${idx}`) || "null");
        if (saved?.source === editSource.source && typeof saved.text === "string") {
          text = saved.text;
          if (Array.isArray(saved.attachmentIds)) setEditingAttachments((m.attachments || []).filter((a) => saved.attachmentIds.includes(a.id)));
        }
      } catch {}
      setEditingMsgText(text);
      persistEditDraft();
    });
  }
  function updateEditingMsgText(text: string) {
    setEditingMsgText(text);
    schedulePersistEditDraft();
  }
  function cancelEditMsg() {
    batch(() => {
      editAttachments.clearAttachments();
      setEditingAttachments([]);
      const idx = editingMsgIdx();
      if (idx != null) clearEditDraft(idx);
      editSource = null;
      setEditingMsgIdx(null);
      setEditingMsgText("");
    });
  }
  async function saveEditMsg(idx: number, m: ChatMessage, getModel: () => string, getYolo: () => boolean) {
    flushEditDraft();
    const sid = opts.getSessionId();
    const host = opts.getHostId();
    const source = editSource;
    const initialEditFingerprint = editFingerprint();
    const text = editingMsgText().trim();
    if (savingEdit()) return;
    if (editAttachments.preparingAttachments()) { opts.toast("Wait for files to finish extracting", "err"); return; }
    if (!sid || !opts.isOpen()) { opts.toast("Reconnect the host before saving", "err"); return; }
    if (!text && !editingAttachments().length && !editAttachments.pendingAttachments().length) {
      opts.toast("Message cannot be empty", "err");
      return;
    }
    const regen = m.role === "user";
    if (regen && sessionStatus() === "running") {
      opts.toast("Stop the current turn first", "err");
      return;
    }
    const targetRawIdx = typeof m.srcIdx === "number" ? m.srcIdx : idx;
    setSavingEdit(true);
    let attachmentIds: string[] | undefined;
    try {
    if (regen) {
      const choice = await opts.showChoice({
        title: "Resend edited message?",
        message: "Everything from this message down will be discarded and the turn re-runs with your edited text.\n\nFork keeps the current timeline in a copy and resends there instead.",
        options: [
          { id: "resend", label: "Discard & resend", hint: "Discards the tail and resends here", primary: true },
          { id: "fork", label: "Fork & resend", hint: "Preserves here, resends in a copy" },
        ],
      });
      if (!choice || editFingerprint() !== initialEditFingerprint || opts.getHostId() !== host || opts.getSessionId() !== sid || editSource !== source || editingMsgIdx() !== idx || !opts.isOpen() || sessionStatus() === "running") return;
      attachmentIds = [...editingAttachments().map((a) => a.id), ...await Promise.all(editAttachments.pendingAttachments().map((a) => editAttachments.uploadOneAttachment(sid, a)))];
      if (editFingerprint() !== initialEditFingerprint || opts.getHostId() !== host || opts.getSessionId() !== sid || editSource !== source || editingMsgIdx() !== idx || !opts.isOpen() || sessionStatus() === "running") return;
      if (choice === "fork") {
        // Fork at this message carrying the edited text: the daemon
        // applies it to the boundary user message and resends from there.
        forkRequestId = crypto.randomUUID();
        forkHostId = host;
        forkSessionId = sid;
        forkEditPending = true;
        forkEditSource = source;
        forkEditFingerprint = editFingerprint();
        setForking(true);
        opts.onForkKind?.("resend");
        opts.send({ type: "fork_session", sessionId: sid, index: targetRawIdx, requestId: forkRequestId, editText: text, model: getModel(), yolo: getYolo(), attachmentIds });
        return;
      }
      // ATOMIC discard&resend: the daemon cuts + inserts + starts in one
      // durable commit and ALWAYS answers (discard_and_resend_result).
      // The editor is cleared only after a matching successful ACK; the
      // daemon persists the row BEFORE the turn starts, so nothing can be lost.
      resendRequestId = crypto.randomUUID();
      resendHostId = host;
      resendSessionId = sid;
      resendEditSource = source;
      resendEditFingerprint = editFingerprint();
      opts.send({
        type: "discard_and_resend",
        sessionId: sid,
        requestId: resendRequestId,
        turnId: m.turnIndex || 0,
        text,
        model: getModel(),
        yolo: getYolo(),
        attachmentIds,
      });
      setSessionStatus("running");
      return;
    }
    // Non-regen edit (save only): same ack contract (edit_message_result).
    resendRequestId = crypto.randomUUID();
    resendHostId = host;
    resendSessionId = sid;
    resendEditSource = source;
    resendEditFingerprint = editFingerprint();
    opts.send({
      type: "edit_message",
      sessionId: sid,
      requestId: resendRequestId,
      index: targetRawIdx,
      text,
      model: getModel(),
      yolo: getYolo(),
      regenerate: false,
      attachmentIds,
    });
    } catch (e) { if (opts.getHostId() === host && opts.getSessionId() === sid) opts.toast(e instanceof Error ? e.message : "Could not save message", "err"); }
    finally { setSavingEdit(false); }
  }
  // --- Daemon events (called by the page dispatcher) ---
  function noteSessionDataRequestGuard(requestId: string | undefined): boolean {
    // Consumed on accept: each issued fetch id is good for exactly one
    // response (concurrent ids coexist in the set until each arrives).
    if (requestId && !pendingFetchIds.delete(requestId)) return true;
    return false;
  }
  function handleTruncated(sessionId: string | undefined, keep: number, cursor?: TranscriptCursor, onApplied?: () => void) {
    if(sessionId!==opts.getSessionId()) return;
    if(cursor) { transcriptOrder.event(cursor,()=>handleTruncated(sessionId,keep,undefined,onApplied)); return; }
    if (pendingSnapshot && sessionId === opts.getSessionId()) {
      pendingSnapshot.replay.push(() => handleTruncated(sessionId, keep,undefined,onApplied)); return;
    }
    // Authoritative tail cut after edit/regenerate (daemon broadcast).
    // keepIndex is the last RAW message to keep; drop rendered messages
    // whose srcIdx exceeds it, then let the following session_content
    // (or the new turn) repaint. cutTail owns the cut rules: unstamped
    // echoes die with the tail and hoisted tool results are pruned by
    // their own raw envelope index, not their carrier's.
    if (sessionId !== opts.getSessionId()) return;
    if (keep >= -1) {
      contextVersion++;
      lastAppliedTranscriptSig = null;
      setMessages((prev: ChatMessage[]) => cutTail(prev, keep));
      // The past changed: drop seals + cursor (a fresh tail arrives
      // next and re-seals).
      resetHistory();
      showQuestion(null);
      onApplied?.();
    }
  }
  function handleStatusEvent(msg: SessionStatusEvent) {
    if(msg.sessionId!==opts.getSessionId()) return;
    if(msg.transcript) { const {transcript,...event}=msg; transcriptOrder.event(transcript,()=>handleStatusEvent(event)); return; }
    if (pendingSnapshot && msg.sessionId === opts.getSessionId()) {
      pendingSnapshot.replay.push(() => handleStatusEvent(msg)); return;
    }
    // Composer responsiveness only (stop button state) — the collections
    // get the same truth via the sessions change ping.
    if (msg.sessionId === opts.getSessionId()) {
      setSessionStatus(msg.status === "running" ? "running" : "idle");
      if (msg.turn) setTurnActivity(previous => normalizeTurnActivity(msg.turn, previous, msg.status));
      if (msg.status === "idle") {
        showQuestion(null);
        setCompactingText("");
        setTurnActivity((turn) => finishTurn(turn));
        opts.onTurnIdle();
        setPendingApproval(null);
        setToolProgress({}); setToolStarts({});
        if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      }
    }
  }
  function handleAgentEvent(sessionId: string, ev: AgentEvent | undefined, cursor?: TranscriptCursor) {
    if(sessionId!==opts.getSessionId() || !ev) return;
    if(cursor) { transcriptOrder.event(cursor,()=>handleAgentEvent(sessionId,ev)); return; }
    if (!ev || sessionId !== opts.getSessionId()) return;
    if (pendingSnapshot) { pendingSnapshot.replay.push(() => handleAgentEvent(sessionId, ev)); return; }
    if (ev.type !== "usage" && ev.type !== "todo_update" && ev.type !== "tool_progress" && ev.type !== "tool_execution_start" && ev.type !== "compact_progress") {
      lastAppliedTranscriptSig = null;
    }
    if (ev.type === "turn_start") {
      setSessionStatus("running");
      setTurnActivity((turn) => !turn || turn.endedAt ? { startedAt: Date.now(), status: "running" } : turn);
    } else if (ev.type === "user_message") {
      const normalizedUser = normalizeSessionMessages([ev.message])[0];
      const user = normalizedUser ? sharedBlobUrlCache.internMessages([normalizedUser], sessionId)[0] : undefined;
      if (user) setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === user.id || (typeof ev.index === "number" && m.srcIdx === ev.index) || (m.role === "user" && m.srcIdx == null));
        const next = { ...user, id: ev.message?.id || (i >= 0 ? prev[i].id : `msg_${ev.index}`), srcIdx: ev.index, turnIndex: ev.turnIndex };
        return i >= 0 ? [...prev.slice(0,i),next,...prev.slice(i+1)] : orderedMessages([...prev,next]);
      });
    } else if (ev.type === "todo_update") {
      setTodos(ev.items || []);
    } else if (ev.type === "assistant_message") {
      setCompactingText("");
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setMessages((prev) => mergeAssistantMessage(prev, ev));
    } else if (ev.type === "assistant_start") {
      setCompactingText("");
      // Each model step gets its own carrier. Tool loops cannot merge new
      // thinking into the previous assistant response.
      setMessages((prev) => pushAssistantCarrier(prev, ev.index, ev.turnIndex, ev.messageId));
    } else if (ev.type === "text_delta") {
      setCompactingText("");
      // First content chunk freezes the thinking clock (chatbot-style).
      if (thinkingStart() !== null) {
        const dur = stopThinkingTimer();
        stampThinkingDuration(dur);
      }
      setMessages(prev=>reduceTextDelta(prev,ev.delta,ev.messageId));
    } else if (ev.type === "reasoning_delta") {
      setCompactingText("");
      if (thinkingStart() === null) startThinkingTimer();
      setMessages(prev=>reduceReasoningDelta(prev,ev.delta || "",ev.messageId));
      setThinkingIndex(0);
    } else if (ev.type === "tool_use_start") {
      setCompactingText("");
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      // Pre-render a live "composing call" card while args stream in.
      setMessages(prev=>reduceToolCall(prev,ev.id,ev.name,"",ev.messageId));
    } else if (ev.type === "tool_use_args") {
      setMessages(prev=>reduceToolArgs(prev,ev.id,ev.delta,ev.messageId));
    } else if (ev.type === "tool_use_end") {
      // No-op: the final tool_call event carries the full block.
    } else if (ev.type === "tool_execution_start") {
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setToolStarts((prev) => ({ ...prev, [ev.id]: ev.startedAt }));
    } else if (ev.type === "tool_progress") {
      setToolProgress((prev) => ({ ...prev, [ev.id]: ((prev[ev.id] || "") + stripToolEnvelopeDetailed(String(ev.text || "")).body).slice(-65536) }));
    } else if (ev.type === "tool_call") {
      setCompactingText("");
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setMessages(prev=>reduceToolCall(prev,ev.id,ev.name,ev.args,ev.messageId));
    } else if (ev.type === "tool_result") {
      setPendingApproval(null);
      setToolProgress((prev) => {
        const next = { ...prev };
        delete next[ev.id];
        return next;
      });
      appendToolResult(ev.id, ev.result ?? ev.content, ev.isError, ev.startedAt, ev.durationMs, ev.details, ev.messageId);
      setToolStarts((prev) => { const next = { ...prev }; delete next[ev.id]; return next; });
    } else if (ev.type === "usage") {
      applyUsage(sessionId, ev.usage, ev.cumulative);
      const uctx = ev.context;
      if (uctx) {
        setSessionContexts((prev) => ({ ...prev, [sessionId]: uctx }));
        opts.onUsageContext(uctx);
      }
    } else if (ev.type === "compact_progress") {
      setCompactingText(typeof ev.text === "string" ? ev.text.trim() : "");
    } else if (ev.type === "retry") {
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setMessages((prev) => prev.filter((m) => ev.index == null ? !m.streaming : m.srcIdx == null || m.srcIdx < ev.index));
    } else if (ev.type === "turn_end") {
      setCompactingText("");
      setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
      // This ends one model call; tools and subsequent steps may still run.
      if (thinkingStart() !== null) {
        const dur = stopThinkingTimer();
        stampThinkingDuration(dur);
      }
      if (ev.usage || ev.cumulative) applyUsage(sessionId, ev.usage, ev.cumulative);
      if (ev.cancelled || (ev.stop === "aborted" && turnActivity()?.status === "cancelling")) {
        showQuestion(null);
        setTurnActivity((turn) => turn ? { ...turn, status: "cancelled", endedAt: Date.now() } : null);
        setPendingApproval(null);
      } else if (ev.error) opts.toast(ev.error, "err");
      // The daemon sends the final snapshot and idle status after the task.
    } else if (ev.type === "done") {
      setCompactingText("");
      // Compatibility with daemons that predate final session snapshots.
      fetchSession(sessionId);
    } else if (ev.type === "error") {
      setCompactingText("");
      opts.toast(ev.message || "Agent error", "err");
      fetchSession(sessionId);
    }
    scrollToBottom();
  }
  /** tool_approval_request event (with session guard). */
  function noteApprovalRequest(msg: ToolApprovalRequestEvent) {
    if (msg.sessionId === opts.getSessionId()) {
      if (askResolved("a:", msg.callId)) return; // late replay: already resolved
      setPendingApproval({
        callId: msg.callId,
        tool: msg.tool,
        args:
          typeof msg.args === "string"
            ? msg.args
            : JSON.stringify(msg.args, null, 2),
      });
    }
  }
  function noteApprovalResolved(sessionId: string | undefined, callId: string) {
    rememberResolvedAsk("a:", callId);
    if (sessionId === opts.getSessionId() && pendingApproval()?.callId === callId) {
      setPendingApproval(null);
    }
  }
  function forkAckMatches(msg: any): boolean {
    return !!forkRequestId && msg?.requestId === forkRequestId &&
      (msg?.sessionId === undefined || msg.sessionId === forkSessionId) &&
      (msg?.hostId === undefined || msg.hostId === forkHostId) &&
      opts.getSessionId() === forkSessionId && opts.getHostId() === forkHostId;
  }
  function noteForkSessionResult(msg: any): boolean {
    if (!forkAckMatches(msg)) return false;
    setForking(false);
    const origin = forkEditSource;
    if (forkEditPending && msg?.session?.id && origin && origin === editSource &&
      editingMsgIdx() === origin.idx && editFingerprint() === forkEditFingerprint) cancelEditMsg();
    forkRequestId = "";
    forkHostId = "";
    forkSessionId = "";
    forkEditPending = false;
    forkEditSource = null;
    forkEditFingerprint = "";
    return true;
  }
  function noteForkAndResendResult(msg: any): boolean {
    if (!forkAckMatches(msg)) return false;
    setForking(false);
    const origin = forkEditSource;
    if (msg?.ok && forkEditPending && origin && origin === editSource &&
      editingMsgIdx() === origin.idx && editFingerprint() === forkEditFingerprint) cancelEditMsg();
    if (!msg?.ok) opts.toast(msg.error || "Could not fork and resend", "err");
    forkRequestId = "";
    forkHostId = "";
    forkSessionId = "";
    forkEditPending = false;
    forkEditSource = null;
    forkEditFingerprint = "";
    return true;
  }
  /** question_resolved event (with session/question guard). */
  function noteQuestionResolved(sessionId: string | undefined, questionId: string) {
    rememberResolvedAsk("q:", questionId); // a resolved id is dead forever
    if (sessionId === opts.getSessionId() && pendingQuestion()?.id === questionId) showQuestion(null);
  }
  /** question_error event (with session/question guard). */
  function noteQuestionError(sessionId: string | undefined, questionId: string, message: string | undefined) {
    if (sessionId === opts.getSessionId() && pendingQuestion()?.id === questionId) {
      setQuestionSubmitting(false);
      setQuestionError(message || "Could not submit answers");
    }
  }
  /** Session switch reset (remaining items — review/options/composer — are
   * cleaned up by their own domains; the page orchestrates).
   */
  function resetForSession() {
    flushEditDraft();
    contextVersion++; transcriptOrder.reset();
    pendingFetchIds.clear();
    snapshotVersion++; pendingSnapshot = null;
    lastAppliedTranscriptSig = null;
    forkRequestId = "";
    forkHostId = "";
    forkSessionId = "";
    forkEditPending = false;
    forkEditSource = null;
    forkEditFingerprint = "";
    setForking(false);
    resendRequestId = "";
    resendHostId = "";
    resendSessionId = "";
    resendEditSource = null;
    resendEditFingerprint = "";
    editSource = null;
    editAttachments.clearAttachments();
    setEditingAttachments([]);
    clearToolScrolls();
    setTurnActivity(null); setTodos([]); setToolProgress({}); setToolStarts({});
    showQuestion(null);
    transcriptScroll.reset();
    resetHistory();
    setMessages([]);
    setSessionCompaction(null);
    setCompactingText("");
    setSessionStatus("idle");
    setPendingApproval(null);
    setEditingMsgIdx(null);
    setEditingMsgText("");
    stopThinkingTimer();
  }
  /** Clears per-session caches when switching hosts (different daemon). */
  function resetCaches() {
    setSessionUsage({});
    setSessionContexts({});
  }
  /** Cleans up leftovers of sessions removed from the mirror (usage + contexts). */
  function purgeSession(sessionId: string) {
    setSessionUsage((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setSessionContexts((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }
  function pushUserMessage(msg: ChatMessage) {
    lastAppliedTranscriptSig = null;
    const interned = sharedBlobUrlCache.internMessages([msg], opts.getSessionId())[0] || msg;
    setMessages((prev) => [...prev, interned]);
  }
  /** Marks turn start in composer (status + activity + tail). */
  function beginTurn() {
    lastAppliedTranscriptSig = null;
    const wasDetached = untrack(historyHasNewer);
    setSessionStatus("running");
    // Sending a message re-engages the pin: the reader expects to follow
    // their own turn even while reading further up.
    transcriptScroll.reset();
    setIsAtBottom(true);
    if (wasDetached) {
      resetHistory();
      const sid = opts.getSessionId();
      if (sid && opts.isOpen()) fetchSession(sid);
    } else {
      // Collapse to the newest seal (fresh tail): the reader already
      // reviewed the past before sending (ocultar, not descarregar —
      // data AND seal notes stay, only the reveal budget shrinks).
      // Older seals stay one click away on the load-older button.
      setSealedBudget(1);
    }
    setTurnActivity({ startedAt: Date.now(), status: "running" });
  }

  return {
    // state
    messages, sessionStatus, setSessionStatus, turnActivity,
    todos, todosOpen, toggleTodosOpen, applyTodosOpenFromRemote, turnClock, turnLabel, turnHint,
    compactingText, clearCompacting,
    sessionCompaction,
    pendingApproval, pendingQuestion,
    questionSubmitting, questionError, showQuestion, answerQuestion,
    activeUsage, sessionContexts, setSessionContexts,
    toolStarts, toolProgress,
    copiedMsgId, copyMsg,
    thinkingStart, thinkingElapsed, thinkingIndex,
    stopThinkingTimer,
    editingMsgIdx, editingMsgText, updateEditingMsgText, flushEditDraft,
    isAtBottom,
    chatContainerRef, setChatContainerRef, chatContentRef, setChatContentRef,
    transcriptScroll, scrollToBottom, scrollToMessage, jumpToMessage, reloadLatest, pinAtBottom, onChatScroll,
    renderBlocks, visibleBlocks, lastVisibleBlockId, hiddenSeals, revealSeal,
    loadOlder, historyCursor, historyHasOlder, historyHasNewer, historyHiddenTurns, historyOldestTurn, historyNewestTurn,
    loadingOlder, loadingNewer, highlightedMsgIdx,
    noteHistoryPage, requestOlderHistory, requestNewerHistory, requestAroundHistory,
    rawIdx, blockRawIdx, specialProgress,
    // session
    fetchSession, beginLoad, applySessionContent, applyUsage, applySnapshot,
    setWorkspaceSink, noteSessionDataRequestGuard,
    handleTruncated, handleStatusEvent, handleAgentEvent,
    noteApprovalRequest, noteQuestionResolved, noteQuestionError,
    noteApprovalResolved,
    appendReasoningDelta,
    appendToolArgsDelta, appendToolResult,
    cancelTurnForSession, cancelCurrentTurn, respondApproval,
    forking, forkRequestId: () => forkRequestId,
    clearForkRequest: () => { forkRequestId = ""; forkHostId = ""; forkSessionId = ""; forkEditPending = false; forkEditSource = null; forkEditFingerprint = ""; }, setForking,
    forkMessage, forkAckMatches, noteForkSessionResult, noteForkAndResendResult,
    regenerateMsg, startEditMsg, cancelEditMsg, saveEditMsg,
    editAttachments, editingAttachments, setEditingAttachments, savingEdit, editMentions,
    noteResendResult,
    resetForSession, resetCaches, purgeSession, pushUserMessage, beginTurn,
  };
}

export type Transcript = ReturnType<typeof createTranscript>;
