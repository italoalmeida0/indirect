/**
 * Shared parsing for unified-style diffs rendered by <DiffView>. Two source
 * formats feed the same renderer:
 *  - edit tool results: "<number>:[ +-]<code>" rows (numbers embedded by the
 *    daemon, e.g. "12:+const x = 1")
 *  - turn-change balloons: standard unified diff text (---/+++/@@ hunks,
 *    "+"/-"/" " markers) — dual old/new numbers are derived from the @@ headers.
 */

export type DiffKind = "add" | "del" | "context" | "header" | "ellipsis" | "meta";

export interface HunkHeader {
  range: string;
  context: string;
}

export interface ParsedDiffLine {
  lineNum: string;
  oldLineNum?: string;
  newLineNum?: string;
  marker: string;
  code: string;
  kind: DiffKind;
  hunkHeader?: HunkHeader;
}

export interface DerivedDualNumber {
  lineNum: string;
  oldLineNum: string;
  newLineNum: string;
}

const HUNK_HEADER_RE = /^(@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@)\s?(.*)$/;
const NO_NEWLINE_RE = /^\\ No newline/i;

/** Parse one raw diff line into marker/kind, keeping any embedded number. */
export function parseDiffLine(rawLine: string): ParsedDiffLine {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line.startsWith("---") || line.startsWith("+++")) {
    return { lineNum: "", marker: "", code: line, kind: "header" };
  }
  if (NO_NEWLINE_RE.test(line)) {
    return { lineNum: "", marker: "", code: line, kind: "meta" };
  }
  if (line.startsWith("@@")) {
    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      return {
        lineNum: "",
        marker: "",
        code: line,
        kind: "ellipsis",
        hunkHeader: {
          range: hunkMatch[1]!,
          context: hunkMatch[6] || "",
        },
      };
    }
    return { lineNum: "", marker: "", code: line, kind: "ellipsis" };
  }
  if (line === "...") {
    return { lineNum: "", marker: "", code: line, kind: "ellipsis" };
  }
  const numMatch = line.match(/^(\d+):([ +-])?(.*)$/);
  if (numMatch) {
    const marker = numMatch[2] || "";
    const kind: DiffKind = marker === "+" ? "add" : marker === "-" ? "del" : "context";
    // Without an explicit marker the row is plain numbered context (read/write).
    return {
      lineNum: numMatch[1]!,
      marker,
      code: numMatch[3]!,
      kind: numMatch[2] ? kind : "context",
    };
  }
  const standardMatch = line.match(/^([ +-])(.*)$/);
  if (standardMatch) {
    const marker = standardMatch[1]!;
    const kind: DiffKind = marker === "+" ? "add" : marker === "-" ? "del" : "context";
    return { lineNum: "", marker, code: standardMatch[2]!, kind };
  }
  return { lineNum: "", marker: "", code: line, kind: "context" };
}

/** Split a diff into renderable rows, deriving @@-based numbers when absent. */
export function diffRows(text: string): ParsedDiffLine[] {
  const clean = cleanNotice(text).replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!clean) return [];
  const lines = clean
    .split("\n")
    .filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  const dual = deriveDualLineNumbers(clean);
  const parsed = lines.map(parseDiffLine);
  if (!dual) return parsed;
  return parsed.map((p, i) => {
    const d = dual[i];
    if (!d) return p;
    return {
      ...p,
      lineNum: p.lineNum || d.lineNum,
      oldLineNum: d.oldLineNum,
      newLineNum: d.newLineNum,
    };
  });
}

/** Strip the daemon's line-prefix identification notice. */
export function cleanNotice(text: string): string {
  return (text || "").replace(
    /^\[Note: The line prefix "[^"]+" is for line identification only and is not part of the file content\.\]\r?\n?/,
    "",
  );
}

/**
 * Derive old and new per-line numbers for a standard unified diff (`@@ -a,b +c,d @@`).
 * Returns null when the text carries no `@@` headers (edit-tool format with
 * embedded numbers, or hunkless snippets).
 */
export function deriveDualLineNumbers(text: string): DerivedDualNumber[] | null {
  const clean = (text || "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const lines = clean.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  if (!lines.some((l) => l.startsWith("@@"))) return null;

  const nums: DerivedDualNumber[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const hunk = line.match(HUNK_HEADER_RE);
    if (hunk) {
      oldLine = parseInt(hunk[2]!, 10);
      newLine = parseInt(hunk[4]!, 10);
      nums.push({ lineNum: "", oldLineNum: "", newLineNum: "" });
      continue;
    }
    if (NO_NEWLINE_RE.test(line) || line === "...") {
      nums.push({ lineNum: "", oldLineNum: "", newLineNum: "" });
      continue;
    }
    if (line.startsWith("+")) {
      const n = String(newLine);
      nums.push({ lineNum: n, oldLineNum: "", newLineNum: n });
      newLine++;
    } else if (line.startsWith("-")) {
      const o = String(oldLine);
      nums.push({ lineNum: o, oldLineNum: o, newLineNum: "" });
      oldLine++;
    } else {
      // Context row: populate both old and new columns; `lineNum` prefers the
      // old-file number and falls back to the new side for `@@ -0,0 +1,N @@`.
      const primary = String(oldLine > 0 ? oldLine : newLine);
      const o = oldLine > 0 ? String(oldLine) : "";
      const n = newLine > 0 ? String(newLine) : "";
      nums.push({ lineNum: primary, oldLineNum: o, newLineNum: n });
      oldLine++;
      newLine++;
    }
  }
  return nums;
}

/**
 * Derive primary per-line numbers for a plain unified diff by walking the @@
 * hunk headers. Returns null when the text carries no @@ headers.
 */
export function deriveLineNumbers(text: string): string[] | null {
  const dual = deriveDualLineNumbers(text);
  return dual ? dual.map((d) => d.lineNum) : null;
}
