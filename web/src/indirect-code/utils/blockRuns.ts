import type { RenderBlock, TurnEntry, ToolUnit } from "../types";

/** Pure extractions from TranscriptBlocks render logic (no Solid dependency).
 *
 * `isBlockRunning` owns the running-tail predicate; `groupToolRuns` maps a
 * series' entries to the tool run each `tools` row renders. */

/** A block runs only while it is the transcript tail AND no visible message
 * has landed on it yet: text only reaches the transcript once the work before
 * it produced an answer, so an aggregate that carries its own text message
 * (`textMsg`) is done — and so is any aggregate a message block appeared
 * after (it is no longer the tail). Only that last, still-silent aggregate
 * of a running session spins/auto-opens; older aggregates stop the moment a
 * message separates them from the tail (the message IS the end-of-work
 * signal). Message blocks themselves never run. */
export function isBlockRunning(blocks: RenderBlock[], block: RenderBlock, sessionStatus: string): boolean {
  if (sessionStatus !== "running") return false;
  if (block.kind !== "series" || block.textMsg) return false;
  const last = blocks.at(-1);
  return last != null && (last === block || last.msg.id === block.msg.id);
}

/** One run per contiguous tools entry. ANY other entry — thinking or image,
 * visible or hidden — is a run boundary: merging across a hidden thinking row
 * duplicated the first row's units and left the second row empty. */
export function groupToolRuns(entries: TurnEntry[]): Map<string | undefined, ToolUnit[]> {
  const runs = new Map<string | undefined, ToolUnit[]>();
  let run: ToolUnit[] | undefined;
  for (const entry of entries) {
    if (entry.kind === "tools") {
      if (!run) { run = []; runs.set(entry.id, run); }
      run.push(...entry.units);
    } else {
      run = undefined;
    }
  }
  return runs;
}
