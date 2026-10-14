/**
 * Code frames for widget lint errors (pure, no DOM).
 *
 * The lint reports point at lines of the MODEL'S source (not the compiled
 * module), so the frame marks the exact region the model must fix — the
 * caret is decorative only (no fancy arrows, Windows terminals included).
 *
 * Derived from tweakgrid/packages/eval-esm createCodeFrame: gutter of
 * `NN | ` with `|` as the seam, one caret row under the target line.
 */
export type CodeFrameOptions = {
  /** 1-indexed line in the source text. */
  line: number;
  /** 1-indexed column (optional — the caret is omitted without it). */
  column?: number;
  /** Lines of context above and below (default 2). */
  context?: number;
};

export function createCodeFrame(source: string, opts: CodeFrameOptions): string {
  const lines = (source || "").split("\n");
  const target = Math.min(Math.max(opts.line, 1), Math.max(lines.length, 1));
  const context = Math.max(opts.context ?? 2, 1);
  const first = Math.max(target - context, 1);
  const last = Math.min(target + context, lines.length);
  const gutterWidth = String(last).length;
  const pad = (n: number) => String(n).padStart(gutterWidth, " ");

  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    out.push(`${pad(n)} | ${lines[n - 1] ?? ""}`);
    if (n === target && typeof opts.column === "number" && opts.column > 0) {
      // The caret row repeats the real gutter so the caret lands under the
      // right column even when earlier rows carry line numbers.
      out.push(`${" ".repeat(gutterWidth)} | ${" ".repeat(Math.max(opts.column - 1, 0))}^`);
    }
  }
  return out.join("\n");
}
