import { createStore, reconcile } from "solid-js/store";
import { createSignal, untrack } from "solid-js";
import type { TurnBalloon, TurnChangedFile } from "../types";
import type { DaemonCommand } from "../daemon-protocol";

export type { TurnBalloon, TurnChangedFile };

export type DiffStatCell = "add" | "del" | "neutral";

/** Computes a 5-block proportional +/- visual stat bar (GitHub / VS Code style). */
export function diffStatBlocks(adds: number, dels: number): DiffStatCell[] {
  const a = Math.max(0, Math.floor(adds || 0));
  const d = Math.max(0, Math.floor(dels || 0));
  const total = a + d;
  if (total === 0) return ["neutral", "neutral", "neutral", "neutral", "neutral"];
  let addCount = 0;
  let delCount = 0;
  if (total <= 5) {
    addCount = a;
    delCount = d;
  } else if (a === 0) {
    delCount = 5;
  } else if (d === 0) {
    addCount = 5;
  } else {
    addCount = Math.min(4, Math.max(1, Math.round((a / total) * 5)));
    delCount = 5 - addCount;
  }
  const out: DiffStatCell[] = [];
  for (let i = 0; i < addCount; i++) out.push("add");
  for (let i = 0; i < delCount; i++) out.push("del");
  while (out.length < 5) out.push("neutral");
  return out;
}

/** Accept the old daemon's disk-shaped broadcasts as well as current wire data. */
function normalizeBalloon(b: any): TurnBalloon {
  return { ...b, turnIndex: b?.turnIndex ?? b?.turn_index,
    messageIndex: b?.messageIndex ?? b?.message_index,
    files: Array.isArray(b?.files) ? b.files : [] };
}

/** Per-turn file changes (snapshot-based, no git).
 *
 * The frontend only knows "changes": one balloon per finished turn (sitting
 * below its turn, persistent) plus at most one live balloon for the running
 * turn (floating above the composer). The daemon's incoming snapshot is an
 * internal detail — it only ever surfaces as live changes here.
 */
export function createTurnChanges(opts: {
  send: (payload: DaemonCommand) => void;
  getSessionId: () => string;
  toast?: (message: string, kind?: "ok" | "err") => void;
}) {
  const [state, setState] = createStore<{ balloons: TurnBalloon[] }>({ balloons: [] });
  const balloons = () => state.balloons;
  function setBalloons(value: TurnBalloon[] | ((prev: TurnBalloon[]) => TurnBalloon[])) {
    const next = typeof value === "function" ? untrack(() => value(state.balloons)) : value;
    // Reconcile identity: keys must be UNIQUE per row. A duplicated turnIndex
    // (live + committed halves) or a duplicated file path (modified + new)
    // used to collide here and corrupt the store on the next reconcile pass
    // (rows vanished or turned null). The first occurrence keeps its plain
    // key (stable DOM identity across updates); later ones get their
    // occurrence index appended.
    const turnOccurrences = new Map<string, number>();
    const rows = next.map((b) => {
      const turnKey = String(b.turnIndex);
      const nth = turnOccurrences.get(turnKey) ?? 0;
      turnOccurrences.set(turnKey, nth + 1);
      const pathOccurrences = new Map<string, number>();
      return {
        ...b,
        id: nth === 0 ? turnKey : `${turnKey}:${nth}`,
        files: b.files.map((f) => {
          const nthPath = pathOccurrences.get(f.path) ?? 0;
          pathOccurrences.set(f.path, nthPath + 1);
          return { ...f, id: nthPath === 0 ? f.path : `${f.path}:${nthPath}` };
        }),
      };
    });
    setState("balloons", reconcile(rows, { merge: true }));
  }
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  let lastSnapshotSig = "";

  function computeSnapshotSig(r: any): string {
    const raw = Array.isArray(r?.fileBalloons) ? r.fileBalloons : [];
    const running = r?.status === "running" ? 1 : 0;
    const seq = typeof r?.turnSeq === "number" ? r.turnSeq : 0;
    if (raw.length === 0) return `0|${running}|${seq}`;
    const parts: string[] = [`${raw.length}|${running}|${seq}`];
    for (let i = 0; i < raw.length; i++) {
      const b = raw[i];
      const ti = b?.turnIndex ?? b?.turn_index ?? "";
      const mi = b?.messageIndex ?? b?.message_index ?? "";
      const files = Array.isArray(b?.files) ? b.files : [];
      parts.push(`${ti}:${mi}:${files.length}`);
      for (let j = 0; j < files.length; j++) {
        const f = files[j];
        parts.push(`${f?.path || ""}:${f?.status || ""}:${f?.additions || 0}:${f?.deletions || 0}`);
      }
    }
    return parts.join("|");
  }

  function reset() {
    lastSnapshotSig = "";
    setBalloons([]);
    setExpanded({});
  }

  function applySnapshot(r: any) {
    const sig = computeSnapshotSig(r);
    if (lastSnapshotSig && sig === lastSnapshotSig) return;
    lastSnapshotSig = sig;
    const list = (Array.isArray(r?.fileBalloons) ? r.fileBalloons : []).map(normalizeBalloon);
    setBalloons((prev) => {
      // Dedupe by turn: the incoming list wins per turn (same rule as
      // noteHistoryBalloons). Without this every session_data re-append
      // duplicates the tail balloons.
      const incoming = (Array.isArray(list) ? list : [])
        .filter((b: any) => (b?.files?.length || 0) > 0)
        .map((b: any) => ({ ...b, live: false }));
      const incomingTurns = new Set(incoming.map((b: any) => b.turnIndex));
      return [
        ...prev.filter(
          (b) =>
            (b.live && r?.status === "running" && (!r.turnSeq || b.turnIndex === r.turnSeq) && !incomingTurns.has(b.turnIndex)) ||
            (!b.live && !incomingTurns.has(b.turnIndex)),
        ),
        ...incoming,
      ].sort((a, b) => a.turnIndex - b.turnIndex);
    });
  }

  /** Authoritative tail cut (edit/regenerate): drop balloons anchored
   * past the kept message prefix, mirroring the daemon's
   * dropBalloonsAbove. Unanchored balloons (no messageIndex) are kept. */
  function dropAbove(keepIndex: number) {
    lastSnapshotSig = "";
    setBalloons((prev) =>
      prev.filter(
        (b) =>
          typeof b.messageIndex !== "number" || b.messageIndex <= 0 || b.messageIndex <= keepIndex + 1,
      ),
    );
  }

  function upsert(balloon: any, live: boolean) {
    balloon = normalizeBalloon(balloon);
    if (!balloon || typeof balloon.turnIndex !== "number") return;
    lastSnapshotSig = "";
    const files = balloon.files || [];
    if (files.length === 0) {
      setBalloons((prev) => prev.filter((b) => b.turnIndex !== balloon.turnIndex || (live && !b.live)));
      return;
    }
    const next: TurnBalloon = {
      turnIndex: balloon.turnIndex,
      files,
      messageIndex: balloon.messageIndex,
      live,
    };
    setBalloons((prev) => {
      // Delayed live updates cannot replace the committed result.
      if (live && prev.some((b) => b.turnIndex === next.turnIndex && !b.live)) return prev;
      const out = [...prev.filter((b) => b.turnIndex !== next.turnIndex), next];
      out.sort((a, b) => a.turnIndex - b.turnIndex);
      return out;
    });
  }

  function noteBalloon(balloon: any, live: boolean) {
    upsert(balloon, live);
  }
  /** Prepend one history page's balloons (committed, dedupe by turn). */
  function noteHistoryBalloons(list: any[]) {
    if (!Array.isArray(list)) return;
    const pages = list.map(normalizeBalloon).filter((b: any) => b && typeof b.turnIndex === "number" && (b.files?.length || 0) > 0);
    if (pages.length === 0) return;
    lastSnapshotSig = "";
    setBalloons((prev) => {
      const known = new Set(prev.map((b) => b.turnIndex));
      const merged = [...pages.filter((b) => !known.has(b.turnIndex)).map((b) => ({ ...b, live: false })), ...prev];
      merged.sort((a, b) => a.turnIndex - b.turnIndex);
      return merged;
    });
  }

  function requestBalloons() {
    if (!opts.getSessionId()) return;
    opts.send({ type: "get_turn_changes", sessionId: opts.getSessionId(), requestId: crypto.randomUUID() });
  }

  function noteTurnChanges(msg: any) {
    if (msg?.error) return;
    lastSnapshotSig = "";
    const list: TurnBalloon[] = (Array.isArray(msg?.balloons) ? msg.balloons : [])
      .map(normalizeBalloon)
      .filter((b: any) => typeof b?.turnIndex === "number" && b?.files?.length > 0)
      .map((b: any) => ({ ...b, live: false }));
    if (typeof msg?.live?.turnIndex === "number" && msg.live.files?.length > 0 &&
      !list.some((b) => b.turnIndex === msg.live.turnIndex)) list.push({ ...msg.live, live: true });
    // A response WITHOUT a live half (older daemon, passivated session or
    // disk fallback) must not replace the floating live balloon with an
    // empty list — that made the balloon vanish on Refresh until the next
    // tool event repainted it. Keep the current live row when the reply
    // does not cover its turn.
    const liveTurns = new Set(list.filter((b) => b.live).map((b) => b.turnIndex));
    for (const b of untrack(() => state.balloons)) {
      if (b.live && !liveTurns.has(b.turnIndex) && !list.some((x) => x.turnIndex === b.turnIndex)) {
        list.push(b);
      }
    }
    // Apply once: clearing and re-adding live rows would remount their open diffs.
    setBalloons(list.sort((a, b) => a.turnIndex - b.turnIndex));
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function isExpanded(key: string) {
    return !!expanded()[key];
  }

  return {
    balloons,
    reset,
    dropAbove,
    applySnapshot,
    noteBalloon,
    noteHistoryBalloons,
    requestBalloons,
    noteTurnChanges,
    toggleExpanded,
    isExpanded,
  };
}
