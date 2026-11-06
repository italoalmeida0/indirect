/** Server-driven history pagination cursor (turn blocks). */
export interface HistoryCursor {
  oldestTurn: number;
  hasOlder: boolean;
  totalTurns: number;
}

/** The pagination window a `session_data` tail snapshot carries. */
export interface HistoryWindow {
  oldestTurn: number;
  hasOlder?: unknown;
  totalTurns?: unknown;
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
  sealedBlocks: readonly { oldestTurn: number }[],
): HistoryCursor {
  if (
    prev && prev.oldestTurn > 0 && prev.oldestTurn < tail.oldestTurn &&
    sealedBlocks.some((s) => s.oldestTurn === prev.oldestTurn)
  ) {
    return {
      oldestTurn: prev.oldestTurn,
      hasOlder: prev.hasOlder,
      totalTurns: typeof tail.totalTurns === "number" ? tail.totalTurns : prev.totalTurns,
    };
  }
  return {
    oldestTurn: tail.oldestTurn,
    hasOlder: !!tail.hasOlder,
    totalTurns: typeof tail.totalTurns === "number" ? tail.totalTurns : 0,
  };
}
