import type { ChatMessage } from "../types";

/** Maximum turns kept mounted/retained in the sliding history window when idle or browsing history. */
export const MAX_WINDOW_TURNS = 180;

/** Server-driven history pagination cursor (turn blocks). */
export interface HistoryCursor {
  oldestTurn: number;
  newestTurn?: number;
  hasOlder: boolean;
  hasNewer?: boolean;
  totalTurns: number;
  firstIndex?: number;
  targetMsgIdx?: number;
}

/** The pagination window a `session_data` tail snapshot carries. */
export interface HistoryWindow {
  oldestTurn: number;
  newestTurn?: unknown;
  hasOlder?: unknown;
  hasNewer?: unknown;
  totalTurns?: unknown;
  firstIndex?: unknown;
  targetMsgIdx?: unknown;
}

function attachOptionalCursorFields(base: HistoryCursor, src: HistoryWindow | HistoryCursor): HistoryCursor {
  if (typeof src.newestTurn === "number") base.newestTurn = src.newestTurn;
  if (typeof src.hasNewer === "boolean") base.hasNewer = src.hasNewer;
  if (typeof src.firstIndex === "number") base.firstIndex = src.firstIndex;
  if (typeof src.targetMsgIdx === "number") base.targetMsgIdx = src.targetMsgIdx;
  return base;
}

/**
 * Next pagination frontier after a tail snapshot.
 *
 * The daemon's tail window always starts at the OLDEST turn it still ships
 * (e.g. 6..10, then 7..11 after a turn completes). Once the reader has
 * pulled older pages, that window is no longer the frontier of what is
 * loaded: taking it would re-show "Load older turns" and hide the already
 * visible turn balloons (TurnIndex-keyed). Keep the older cursor and its
 * `hasOlder` flag while a seal proves those turns are on screen; otherwise
 * (fresh load, session switch, truncation) the snapshot sets the frontier.
 */
export function nextHistoryCursor(
  prev: HistoryCursor | null,
  tail: HistoryWindow,
  sealedBlocks: readonly { oldestTurn: number; newestTurn?: number }[],
): HistoryCursor {
  if (prev?.hasNewer && !tail.hasNewer && tail.targetMsgIdx == null) {
    // Detached mid-history window: keep its frontier until reloadLatest() or an around-jump resets it.
    return {
      ...prev,
      totalTurns: typeof tail.totalTurns === "number" ? tail.totalTurns : prev.totalTurns,
    };
  }
  if (
    prev && prev.oldestTurn > 0 && prev.oldestTurn < tail.oldestTurn &&
    sealedBlocks.some((s) => s.oldestTurn === prev.oldestTurn)
  ) {
    const out: HistoryCursor = {
      oldestTurn: prev.oldestTurn,
      hasOlder: prev.hasOlder,
      totalTurns: typeof tail.totalTurns === "number" ? tail.totalTurns : prev.totalTurns,
    };
    if (typeof tail.newestTurn === "number") out.newestTurn = tail.newestTurn;
    else if (typeof prev.newestTurn === "number") out.newestTurn = prev.newestTurn;
    if (typeof tail.hasNewer === "boolean") out.hasNewer = tail.hasNewer;
    else if (typeof prev.hasNewer === "boolean") out.hasNewer = prev.hasNewer;
    if (typeof prev.firstIndex === "number") out.firstIndex = prev.firstIndex;
    return out;
  }
  return attachOptionalCursorFields(
    {
      oldestTurn: tail.oldestTurn,
      hasOlder: !!tail.hasOlder,
      totalTurns: typeof tail.totalTurns === "number" ? tail.totalTurns : 0,
    },
    tail,
  );
}

export interface SlidingSealLike {
  oldestTurn: number;
  newestTurn: number;
  firstIndex: number;
  msgCount: number;
  hasOlderBelow: boolean;
}

export interface SlideWindowResult<TSeal extends SlidingSealLike = SlidingSealLike> {
  messages: ChatMessage[];
  seals: TSeal[];
  cursor: HistoryCursor;
  prunedTurns: number;
}

function collectOrderedTurns(messages: ChatMessage[]): number[] {
  const seen = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const t = messages[i].turnIndex;
    if (typeof t === "number" && t > 0) seen.add(t);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Pure two-ended sliding window cap (`maxTurns = MAX_WINDOW_TURNS = 180`).
 *
 * - When `direction === "older"` and loaded turns exceed `maxTurns`, drops
 *   excess newest turns from the bottom and sets `hasNewer: true` + `newestTurn`.
 * - When `direction === "newer"` and loaded turns exceed `maxTurns`, drops
 *   excess oldest turns from the top and sets `hasOlder: true` + `oldestTurn`.
 */
export function enforceSlidingTurnWindow<TSeal extends SlidingSealLike>(
  messages: ChatMessage[],
  seals: readonly TSeal[],
  cursor: HistoryCursor,
  direction: "older" | "newer",
  maxTurns = MAX_WINDOW_TURNS,
): SlideWindowResult<TSeal> {
  const turns = collectOrderedTurns(messages);
  if (turns.length <= maxTurns) {
    const oldestTurn = turns.length > 0 ? Math.min(cursor.oldestTurn || turns[0], turns[0]) : cursor.oldestTurn;
    const newestTurn = turns.length > 0
      ? Math.max(typeof cursor.newestTurn === "number" ? cursor.newestTurn : turns[turns.length - 1], turns[turns.length - 1])
      : cursor.newestTurn;
    return {
      messages,
      seals: [...seals],
      cursor: {
        ...cursor,
        oldestTurn,
        ...(typeof newestTurn === "number" ? { newestTurn } : {}),
      },
      prunedTurns: 0,
    };
  }

  if (direction === "older") {
    const keptTurns = turns.slice(0, maxTurns);
    const maxKeptTurn = keptTurns[keptTurns.length - 1];
    const prunedTurns = turns.length - keptTurns.length;
    const nextMessages = messages.filter((m) => {
      const t = m.turnIndex;
      if (typeof t !== "number" || t <= 0) return false;
      return t <= maxKeptTurn;
    });
    const nextSeals = seals
      .filter((s) => s.oldestTurn <= maxKeptTurn)
      .map((s) => (s.newestTurn > maxKeptTurn ? { ...s, newestTurn: maxKeptTurn } : s));
    return {
      messages: nextMessages,
      seals: nextSeals,
      cursor: {
        ...cursor,
        oldestTurn: keptTurns[0],
        newestTurn: maxKeptTurn,
        hasNewer: true,
        totalTurns: Math.max(cursor.totalTurns || 0, turns[turns.length - 1]),
      },
      prunedTurns,
    };
  }

  // direction === "newer": prune oldest turns from top
  const keptTurns = turns.slice(turns.length - maxTurns);
  const minKeptTurn = keptTurns[0];
  const maxKeptTurn = keptTurns[keptTurns.length - 1];
  const prunedTurns = turns.length - keptTurns.length;
  const nextMessages = messages.filter((m) => {
    const t = m.turnIndex;
    if (typeof t !== "number" || t <= 0) return true;
    return t >= minKeptTurn;
  });
  const firstSrcIdx = nextMessages.find((m) => typeof m.srcIdx === "number")?.srcIdx;
  const nextSeals = seals
    .filter((s) => s.newestTurn >= minKeptTurn)
    .map((s) => (s.oldestTurn < minKeptTurn ? { ...s, oldestTurn: minKeptTurn, hasOlderBelow: true } : s));
  return {
    messages: nextMessages,
    seals: nextSeals,
    cursor: {
      ...cursor,
      oldestTurn: minKeptTurn,
      newestTurn: maxKeptTurn,
      hasOlder: true,
      ...(typeof firstSrcIdx === "number" ? { firstIndex: firstSrcIdx } : {}),
      totalTurns: Math.max(cursor.totalTurns || 0, maxKeptTurn),
    },
    prunedTurns,
  };
}
