import { describe, expect, test } from "bun:test";
import { nextHistoryCursor, type HistoryCursor } from "../web/src/indirect-code/transcript/history";

// Regression: a paginated session's tail snapshot (`session_data`) overwrote
// the history cursor with the tail window's frontier after the reader had
// loaded older turns. `applySnapshot` now routes through nextHistoryCursor,
// so the scenario is exercised here without the browser hook.
describe("history cursor survives a later tail snapshot", () => {
  test("keeps the older frontier after noteHistoryPage loaded 1..5", () => {
    // Initial tail window: turns 6..10 (cursor 6, hasOlder true).
    const initialTail = nextHistoryCursor(null, { oldestTurn: 6, hasOlder: true, totalTurns: 10 }, []);
    expect(initialTail).toEqual({ oldestTurn: 6, hasOlder: true, totalTurns: 10 });

    // get_history page 1..5 seals as a block and becomes the frontier.
    const afterPage = nextHistoryCursor(initialTail, { oldestTurn: 1, hasOlder: false, totalTurns: 10 }, [
      { oldestTurn: 1 },
      { oldestTurn: 6 },
    ]);
    expect(afterPage).toEqual({ oldestTurn: 1, hasOlder: false, totalTurns: 10 });

    // A turn finished: the daemon sends the NEW tail window (7..11).
    const afterTail = nextHistoryCursor(
      afterPage,
      { oldestTurn: 7, hasOlder: true, totalTurns: 11 },
      [{ oldestTurn: 1 }, { oldestTurn: 6 }, { oldestTurn: 7 }],
    );

    // The frontier stays at the loaded older turns: no phantom button and no
    // hidden balloons below turn 7. totalTurns follows the newest snapshot.
    expect(afterTail).toEqual({ oldestTurn: 1, hasOlder: false, totalTurns: 11 });
  });

  test("preserves hasOlder when the older cursor still reports more", () => {
    const prev: HistoryCursor = { oldestTurn: 3, hasOlder: true, totalTurns: 10 };
    expect(nextHistoryCursor(prev, { oldestTurn: 7, hasOlder: true, totalTurns: 11 }, [{ oldestTurn: 3 }]))
      .toEqual({ oldestTurn: 3, hasOlder: true, totalTurns: 11 });
  });

  test("an empty seal store lets the snapshot set the frontier again", () => {
    // Fresh load / session switch / truncation: no older pages are on screen.
    const prev: HistoryCursor = { oldestTurn: 1, hasOlder: false, totalTurns: 10 };
    expect(nextHistoryCursor(prev, { oldestTurn: 3, hasOlder: true, totalTurns: 7 }, []))
      .toEqual({ oldestTurn: 3, hasOlder: true, totalTurns: 7 });
  });

  test("no cursor yet: the tail snapshot is authoritative", () => {
    expect(nextHistoryCursor(null, { oldestTurn: 3, hasOlder: true, totalTurns: 7 }, [{ oldestTurn: 1 }]))
      .toEqual({ oldestTurn: 3, hasOlder: true, totalTurns: 7 });
  });

  test("equal or newer prev yields to the tail window", () => {
    const prev: HistoryCursor = { oldestTurn: 7, hasOlder: false, totalTurns: 10 };
    expect(nextHistoryCursor(prev, { oldestTurn: 7, hasOlder: true, totalTurns: 11 }, [{ oldestTurn: 7 }]))
      .toEqual({ oldestTurn: 7, hasOlder: true, totalTurns: 11 });
    expect(nextHistoryCursor(prev, { oldestTurn: 2, hasOlder: true, totalTurns: 11 }, [{ oldestTurn: 7 }]))
      .toEqual({ oldestTurn: 2, hasOlder: true, totalTurns: 11 });
  });

  test("totalTurns falls back to the preserved cursor when the tail omits it", () => {
    const prev: HistoryCursor = { oldestTurn: 1, hasOlder: false, totalTurns: 10 };
    expect(nextHistoryCursor(prev, { oldestTurn: 7, hasOlder: true }, [{ oldestTurn: 1 }]))
      .toEqual({ oldestTurn: 1, hasOlder: false, totalTurns: 10 });
  });
});
