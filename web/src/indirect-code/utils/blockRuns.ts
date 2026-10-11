import type { RenderBlock, TurnEntry, ToolUnit } from "../types";

/** Pure extractions from TranscriptBlocks render logic (no Solid dependency).
 *
 * `isBlockRunning` owns the running-tail predicate; `groupToolRuns` maps a
 * series' entries to the tool run each `tools` row renders. */

/** Live state is turn-scoped: a multi-text turn spans several render blocks,
 * and every one of them shows live state (spinner/auto-open/isActive) while
 * its turn runs — not just the transcript's last block. */
export function isBlockRunning(blocks: RenderBlock[], block: RenderBlock, sessionStatus: string): boolean {
  const last = blocks.at(-1);
  return sessionStatus === "running" && last != null && last.turnKey === block.turnKey;
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
