/**
 * VS Code / GitHub-style intra-line word & character diffing and HTML span
 * overlay for unified diffs.
 *
 * Pure, dependency-free pipeline:
 *  1. Fine-grained subword / number / whitespace / punctuation tokenization
 *     preserving Unicode surrogate pairs (`[start, end)` UTF-16 code units).
 *  2. Myers O(ND) shortest-edit-script over token streams, plus alphabetic
 *     stem prefix/suffix refinement and coalescing of tiny 1–2 char unchanged
 *     islands between adjacent edits so highlights read cleanly without
 *     ransom-note confetti.
 *  3. Similarity gating (`similarity >= 0.32` on trimmed content or a shared
 *     non-trivial word-bearing prefix/suffix) and monotonic DP line pairing
 *     for multi-line `-` / `+` replacement blocks.
 *  4. `applyInlineDiffToHtml` overlays `<span class="rc-diff-word-del|add">`
 *     onto syntax-highlighted HTML by tracking decoded character offsets
 *     (HTML entities count as their exact decoded UTF-16 length) and cleanly
 *     closing/re-opening at every `<span class="tok-*">` boundary so emitted
 *     HTML is strictly well-nested and token foreground colors remain intact.
 */

import type { ParsedDiffLine } from "./diffLines";
import {
  escapeHtml,
  highlightCodeLines,
  highlightCodeLinesSync,
  isCodeHighlightReady,
} from "./lang";

export interface InlineDiffRange {
  /** Inclusive UTF-16 code-unit start offset in the raw line string. */
  start: number;
  /** Exclusive UTF-16 code-unit end offset in the raw line string. */
  end: number;
}

export interface DiffRow {
  lineNum: string;
  oldLineNum?: string;
  newLineNum?: string;
  marker: string;
  codeHtml: string;
  rawCode: string;
  kind: ParsedDiffLine["kind"];
  hunkHeader?: ParsedDiffLine["hunkHeader"];
}

export interface InlineLineDiff {
  delRanges: InlineDiffRange[];
  addRanges: InlineDiffRange[];
  similarity: number;
  paired: boolean;
}

interface DiffToken {
  text: string;
  start: number;
  end: number;
}

interface EditChunk {
  delStart: number;
  delEnd: number;
  addStart: number;
  addEnd: number;
}

const TOKEN_RE = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{L}+|\p{N}+|[ \t]|./gu;
const PURE_ALPHA_RE = /^\p{L}+$/u;
const WORD_CHAR_RE = /[\p{L}\p{N}_$]/u;
const SIMILARITY_THRESHOLD = 0.32;
const MAX_TOKEN_DIFF_CHARS = 1200;
const MAX_MYERS_TOKENS = 600;
const MAX_COALESCE_ISLAND_CHARS = 2;

/** Split a raw source line into contiguous, non-overlapping subword/char tokens. */
export function tokenizeForInlineDiff(line: string): DiffToken[] {
  if (!line) return [];
  const tokens: DiffToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    const text = m[0];
    tokens.push({
      text,
      start: m.index,
      end: m.index + text.length,
    });
  }
  return tokens;
}

function isLowSurrogateAt(str: string, idx: number): boolean {
  if (idx <= 0 || idx >= str.length) return false;
  const prev = str.charCodeAt(idx - 1);
  const cur = str.charCodeAt(idx);
  return prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff;
}

function commonCharPrefixLen(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let k = 0;
  while (k < limit && a.charCodeAt(k) === b.charCodeAt(k)) {
    k++;
  }
  if (isLowSurrogateAt(a, k) || isLowSurrogateAt(b, k)) {
    k--;
  }
  return k;
}

function commonCharSuffixLen(a: string, b: string, prefixLen = 0): number {
  const maxSuffix = Math.min(a.length, b.length) - prefixLen;
  let k = 0;
  while (
    k < maxSuffix &&
    a.charCodeAt(a.length - 1 - k) === b.charCodeAt(b.length - 1 - k)
  ) {
    k++;
  }
  if (
    isLowSurrogateAt(a, a.length - k) ||
    isLowSurrogateAt(b, b.length - k)
  ) {
    k--;
  }
  return k;
}

type MyersOp = "eq" | "del" | "add";

/**
 * Myers O(ND) shortest edit script over two token slices. Returns an ordered
 * sequence of `"eq" | "del" | "add"` operations.
 */
function myersDiffTokens(a: DiffToken[], b: DiffToken[]): MyersOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return new Array<MyersOp>(m).fill("add");
  if (m === 0) return new Array<MyersOp>(n).fill("del");

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  v.fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  let finished = false;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[idx - 1]! < v[idx + 1]!)) {
        x = v[idx + 1]!;
      } else {
        x = v[idx - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x]!.text === b[y]!.text) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) {
        finished = true;
        break;
      }
    }
    if (finished) break;
  }

  // Backtrack to recover exact edit script.
  const ops: MyersOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prevV = trace[d]!;
    const k = x - y;
    const idx = offset + k;
    let prevK: number;
    if (k === -d || (k !== d && prevV[idx - 1]! < prevV[idx + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prevV[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push("eq");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("add");
      y--;
    } else {
      ops.push("del");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("eq");
    x--;
    y--;
  }
  while (x > 0) {
    ops.push("del");
    x--;
  }
  while (y > 0) {
    ops.push("add");
    y--;
  }

  ops.reverse();
  return ops;
}

/**
 * Refine a single alphabetic subword replacement when both sides share a
 * ≥3-character alphabetic stem (e.g. `Item` → `Items` narrows to `+s`, while
 * `get` → `set` or `1000` → `5000` stays whole-token).
 */
function refineAlphabeticStem(rawDel: string, rawAdd: string, chunk: EditChunk): EditChunk {
  const delText = rawDel.slice(chunk.delStart, chunk.delEnd);
  const addText = rawAdd.slice(chunk.addStart, chunk.addEnd);
  if (!delText || !addText) return chunk;
  if (!PURE_ALPHA_RE.test(delText) || !PURE_ALPHA_RE.test(addText)) return chunk;

  const pref = commonCharPrefixLen(delText, addText);
  const suff = commonCharSuffixLen(delText, addText, pref);
  if (pref + suff < 3) return chunk;

  return {
    delStart: chunk.delStart + pref,
    delEnd: chunk.delEnd - suff,
    addStart: chunk.addStart + pref,
    addEnd: chunk.addEnd - suff,
  };
}

function buildEditChunks(rawDel: string, rawAdd: string): EditChunk[] {
  if (
    rawDel.length > MAX_TOKEN_DIFF_CHARS ||
    rawAdd.length > MAX_TOKEN_DIFF_CHARS
  ) {
    const pref = commonCharPrefixLen(rawDel, rawAdd);
    const suff = commonCharSuffixLen(rawDel, rawAdd, pref);
    return [
      {
        delStart: pref,
        delEnd: rawDel.length - suff,
        addStart: pref,
        addEnd: rawAdd.length - suff,
      },
    ];
  }

  const delToks = tokenizeForInlineDiff(rawDel);
  const addToks = tokenizeForInlineDiff(rawAdd);

  let p = 0;
  const minLen = Math.min(delToks.length, addToks.length);
  while (p < minLen && delToks[p]!.text === addToks[p]!.text) {
    p++;
  }
  if (p === delToks.length && p === addToks.length) {
    return [];
  }

  let s = 0;
  while (
    s < minLen - p &&
    delToks[delToks.length - 1 - s]!.text === addToks[addToks.length - 1 - s]!.text
  ) {
    s++;
  }

  const midDel = delToks.slice(p, delToks.length - s);
  const midAdd = addToks.slice(p, addToks.length - s);

  if (midDel.length + midAdd.length > MAX_MYERS_TOKENS) {
    const delStart = midDel.length > 0 ? midDel[0]!.start : (p < delToks.length ? delToks[p]!.start : rawDel.length);
    const delEnd = midDel.length > 0 ? midDel[midDel.length - 1]!.end : delStart;
    const addStart = midAdd.length > 0 ? midAdd[0]!.start : (p < addToks.length ? addToks[p]!.start : rawAdd.length);
    const addEnd = midAdd.length > 0 ? midAdd[midAdd.length - 1]!.end : addStart;
    return [{ delStart, delEnd, addStart, addEnd }];
  }

  const ops = myersDiffTokens(midDel, midAdd);
  const rawChunks: EditChunk[] = [];
  let di = 0;
  let ai = 0;
  let k = 0;

  while (k < ops.length) {
    if (ops[k] === "eq") {
      di++;
      ai++;
      k++;
      continue;
    }
    const delBeginIdx = di;
    const addBeginIdx = ai;
    while (k < ops.length && ops[k] !== "eq") {
      if (ops[k] === "del") di++;
      else ai++;
      k++;
    }
    const delStart =
      delBeginIdx < di
        ? midDel[delBeginIdx]!.start
        : di < midDel.length
          ? midDel[di]!.start
          : s > 0
            ? delToks[delToks.length - s]!.start
            : rawDel.length;
    const delEnd = delBeginIdx < di ? midDel[di - 1]!.end : delStart;

    const addStart =
      addBeginIdx < ai
        ? midAdd[addBeginIdx]!.start
        : ai < midAdd.length
          ? midAdd[ai]!.start
          : s > 0
            ? addToks[addToks.length - s]!.start
            : rawAdd.length;
    const addEnd = addBeginIdx < ai ? midAdd[ai - 1]!.end : addStart;

    rawChunks.push(
      refineAlphabeticStem(rawDel, rawAdd, { delStart, delEnd, addStart, addEnd }),
    );
  }

  // Coalesce tiny 1–2 char unchanged islands between adjacent edits.
  const coalesced: EditChunk[] = [];
  for (const chunk of rawChunks) {
    if (chunk.delStart === chunk.delEnd && chunk.addStart === chunk.addEnd) {
      continue;
    }
    const prev = coalesced[coalesced.length - 1];
    if (prev) {
      const delGap = chunk.delStart - prev.delEnd;
      const addGap = chunk.addStart - prev.addEnd;
      if (delGap <= MAX_COALESCE_ISLAND_CHARS && addGap <= MAX_COALESCE_ISLAND_CHARS) {
        prev.delEnd = chunk.delEnd;
        prev.addEnd = chunk.addEnd;
        continue;
      }
    }
    coalesced.push({ ...chunk });
  }

  return coalesced;
}

function leadingWhitespaceLen(str: string): number {
  let i = 0;
  while (i < str.length && (str[i] === " " || str[i] === "\t")) i++;
  return i;
}

function trailingWhitespaceLen(str: string, leadLen: number): number {
  let i = str.length;
  while (i > leadLen && (str[i - 1] === " " || str[i - 1] === "\t")) i--;
  return str.length - i;
}

function hasNonTrivialAffix(trimmedDel: string, trimmedAdd: string): boolean {
  const pref = commonCharPrefixLen(trimmedDel, trimmedAdd);
  if (pref >= 6 && WORD_CHAR_RE.test(trimmedDel.slice(0, pref))) {
    return true;
  }
  const suff = commonCharSuffixLen(trimmedDel, trimmedAdd, pref);
  if (suff >= 6 && WORD_CHAR_RE.test(trimmedDel.slice(trimmedDel.length - suff))) {
    return true;
  }
  return false;
}

/**
 * Compute intra-line diff ranges and similarity gating for one `(rawDel, rawAdd)`
 * candidate pair. Unrelated replacement lines (`paired === false`) return empty
 * ranges so callers render clean whole-line tints instead of noisy confetti.
 */
export function computeInlineDiff(rawDel: string, rawAdd: string): InlineLineDiff {
  if (rawDel === rawAdd) {
    return { delRanges: [], addRanges: [], similarity: 1, paired: true };
  }

  const delLead = leadingWhitespaceLen(rawDel);
  const addLead = leadingWhitespaceLen(rawAdd);
  const delTrail = trailingWhitespaceLen(rawDel, delLead);
  const addTrail = trailingWhitespaceLen(rawAdd, addLead);
  const trimmedDel = rawDel.slice(delLead, rawDel.length - delTrail);
  const trimmedAdd = rawAdd.slice(addLead, rawAdd.length - addTrail);

  // Never pair blank/whitespace-only lines with code lines.
  if (trimmedDel.length === 0 || trimmedAdd.length === 0) {
    return { delRanges: [], addRanges: [], similarity: 0, paired: false };
  }

  const chunks = buildEditChunks(rawDel, rawAdd);

  // Compute unchanged characters strictly inside the trimmed body on both sides
  // so shared leading indentation never inflates similarity between unrelated lines.
  const delTrimEnd = rawDel.length - delTrail;
  const addTrimEnd = rawAdd.length - addTrail;

  let changedDelInBody = 0;
  let changedAddInBody = 0;
  for (const c of chunks) {
    const ds = Math.max(delLead, c.delStart);
    const de = Math.min(delTrimEnd, c.delEnd);
    if (de > ds) changedDelInBody += de - ds;

    const as = Math.max(addLead, c.addStart);
    const ae = Math.min(addTrimEnd, c.addEnd);
    if (ae > as) changedAddInBody += ae - as;
  }

  const unchangedDelBody = Math.max(0, trimmedDel.length - changedDelInBody);
  const unchangedAddBody = Math.max(0, trimmedAdd.length - changedAddInBody);
  const unchangedBody = Math.min(unchangedDelBody, unchangedAddBody);
  const denom = trimmedDel.length + trimmedAdd.length;
  const similarity = denom > 0 ? (2 * unchangedBody) / denom : 1;

  // Ensure at least one non-whitespace character stayed unchanged so 100%-replaced
  // bodies keep clean whole-line backgrounds instead of redundant full-line spans.
  let hasUnchangedNonSpace = false;
  let cursor = delLead;
  for (const c of chunks) {
    const segEnd = Math.min(delTrimEnd, c.delStart);
    if (segEnd > cursor) {
      const seg = rawDel.slice(cursor, segEnd);
      if (/\S/.test(seg)) {
        hasUnchangedNonSpace = true;
        break;
      }
    }
    cursor = Math.max(cursor, c.delEnd);
  }
  if (!hasUnchangedNonSpace && cursor < delTrimEnd) {
    if (/\S/.test(rawDel.slice(cursor, delTrimEnd))) {
      hasUnchangedNonSpace = true;
    }
  }

  const paired =
    hasUnchangedNonSpace &&
    (similarity >= SIMILARITY_THRESHOLD || hasNonTrivialAffix(trimmedDel, trimmedAdd));

  if (!paired) {
    return { delRanges: [], addRanges: [], similarity, paired: false };
  }

  const delRanges: InlineDiffRange[] = [];
  const addRanges: InlineDiffRange[] = [];
  for (const c of chunks) {
    if (c.delEnd > c.delStart) {
      delRanges.push({ start: c.delStart, end: c.delEnd });
    }
    if (c.addEnd > c.addStart) {
      addRanges.push({ start: c.addStart, end: c.addEnd });
    }
  }

  return { delRanges, addRanges, similarity, paired: true };
}

export interface BlockInlineDiffResult {
  /** Keyed by local index in `delLines` (`0 .. delLines.length - 1`). */
  delRangesByIndex: Map<number, InlineDiffRange[]>;
  /** Keyed by local index in `addLines` (`0 .. addLines.length - 1`). */
  addRangesByIndex: Map<number, InlineDiffRange[]>;
}

const MAX_DP_BLOCK_LINES = 12;

/**
 * Pair a contiguous run of removed lines (`delLines`) with an adjacent run of
 * added lines (`addLines`), using order-preserving maximum-similarity DP so
 * inserted/deleted lines inside an edited block do not misalign sibling pairs.
 */
export function pairReplacementBlock(
  delLines: string[],
  addLines: string[],
): BlockInlineDiffResult {
  const delRangesByIndex = new Map<number, InlineDiffRange[]>();
  const addRangesByIndex = new Map<number, InlineDiffRange[]>();
  const m = delLines.length;
  const n = addLines.length;
  if (m === 0 || n === 0) {
    return { delRangesByIndex, addRangesByIndex };
  }

  if (m === 1 && n === 1) {
    const diff = computeInlineDiff(delLines[0]!, addLines[0]!);
    if (diff.paired) {
      if (diff.delRanges.length > 0) delRangesByIndex.set(0, diff.delRanges);
      if (diff.addRanges.length > 0) addRangesByIndex.set(0, diff.addRanges);
    }
    return { delRangesByIndex, addRangesByIndex };
  }

  if (m <= MAX_DP_BLOCK_LINES && n <= MAX_DP_BLOCK_LINES) {
    const pairDiffs: Array<Array<InlineLineDiff | null>> = Array.from({ length: m }, () =>
      new Array<InlineLineDiff | null>(n).fill(null),
    );
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0),
    );

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        const diff = computeInlineDiff(delLines[i]!, addLines[j]!);
        let best = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
        if (diff.paired) {
          pairDiffs[i]![j] = diff;
          // Slight tie-breaker favoring diagonal index alignment when equal.
          const bonus = i === j ? 1e-4 : 0;
          const cand = diff.similarity + bonus + dp[i + 1]![j + 1]!;
          if (cand > best) best = cand;
        }
        dp[i]![j] = best;
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      const diff = pairDiffs[i]![j];
      if (diff) {
        const bonus = i === j ? 1e-4 : 0;
        const cand = diff.similarity + bonus + dp[i + 1]![j + 1]!;
        if (cand >= dp[i + 1]![j]! && cand >= dp[i]![j + 1]!) {
          if (diff.delRanges.length > 0) delRangesByIndex.set(i, diff.delRanges);
          if (diff.addRanges.length > 0) addRangesByIndex.set(j, diff.addRanges);
          i++;
          j++;
          continue;
        }
      }
      if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        i++;
      } else {
        j++;
      }
    }

    return { delRangesByIndex, addRangesByIndex };
  }

  // Fallback for large replacement blocks: linear 1:1 pairing up to min(m, n).
  const limit = Math.min(m, n);
  for (let i = 0; i < limit; i++) {
    const diff = computeInlineDiff(delLines[i]!, addLines[i]!);
    if (diff.paired) {
      if (diff.delRanges.length > 0) delRangesByIndex.set(i, diff.delRanges);
      if (diff.addRanges.length > 0) addRangesByIndex.set(i, diff.addRanges);
    }
  }
  return { delRangesByIndex, addRangesByIndex };
}

/** Compute the decoded UTF-16 code-unit length of an HTML entity token (`&...;`). */
function decodedEntityUtf16Length(entity: string): number {
  if (
    entity === "&amp;" ||
    entity === "&lt;" ||
    entity === "&gt;" ||
    entity === "&quot;" ||
    entity === "&apos;"
  ) {
    return 1;
  }
  if (entity.startsWith("&#x") || entity.startsWith("&#X")) {
    const cp = parseInt(entity.slice(3, -1), 16);
    if (!Number.isNaN(cp) && cp >= 0 && cp <= 0x10ffff) {
      return cp > 0xffff ? 2 : 1;
    }
    return 1;
  }
  if (entity.startsWith("&#")) {
    const cp = parseInt(entity.slice(2, -1), 10);
    if (!Number.isNaN(cp) && cp >= 0 && cp <= 0x10ffff) {
      return cp > 0xffff ? 2 : 1;
    }
    return 1;
  }
  return 1;
}

/**
 * Overlay `<span class="rc-diff-word-del|add">` ranges onto a syntax-highlighted
 * HTML line. Tracks decoded UTF-16 source offsets across HTML entities and
 * closes/re-opens word-diff spans at every `<span class="tok-*">` boundary so
 * emitted HTML is strictly well-formed and syntax foreground colors stay intact.
 */
export function applyInlineDiffToHtml(
  highlightedLineHtml: string,
  ranges: InlineDiffRange[],
  className: "rc-diff-word-del" | "rc-diff-word-add",
): string {
  if (!highlightedLineHtml || ranges.length === 0) return highlightedLineHtml;

  const openMark = `<span class="${className}">`;
  let out = "";
  let srcOffset = 0;
  let rangeIdx = 0;
  let inHighlight = false;
  let pos = 0;

  const advanceRanges = () => {
    while (rangeIdx < ranges.length && srcOffset >= ranges[rangeIdx]!.end) {
      if (inHighlight) {
        out += "</span>";
        inHighlight = false;
      }
      rangeIdx++;
    }
  };

  while (pos < highlightedLineHtml.length) {
    advanceRanges();
    const ch = highlightedLineHtml[pos]!;

    // Syntax `<span>` or `</span>` tag: zero source characters. Close any active
    // word-diff span before emitting the syntax tag so tags never cross-nest.
    if (ch === "<") {
      const closeBracket = highlightedLineHtml.indexOf(">", pos);
      if (closeBracket !== -1) {
        if (inHighlight) {
          out += "</span>";
          inHighlight = false;
        }
        out += highlightedLineHtml.slice(pos, closeBracket + 1);
        pos = closeBracket + 1;
        continue;
      }
    }

    // Determine the next source text unit (an HTML entity `&...;` or 1 UTF-16
    // code unit — or a surrogate pair of 2 UTF-16 code units).
    let rawToken: string;
    let srcUnitLen: number;
    if (ch === "&") {
      const semi = highlightedLineHtml.indexOf(";", pos + 1);
      if (semi !== -1 && semi - pos <= 12 && /^&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z0-9]+);$/.test(highlightedLineHtml.slice(pos, semi + 1))) {
        rawToken = highlightedLineHtml.slice(pos, semi + 1);
        srcUnitLen = decodedEntityUtf16Length(rawToken);
        pos = semi + 1;
      } else {
        rawToken = ch;
        srcUnitLen = 1;
        pos++;
      }
    } else {
      const code = highlightedLineHtml.charCodeAt(pos);
      if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        pos + 1 < highlightedLineHtml.length
      ) {
        const nextCode = highlightedLineHtml.charCodeAt(pos + 1);
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          rawToken = highlightedLineHtml.slice(pos, pos + 2);
          srcUnitLen = 2;
          pos += 2;
        } else {
          rawToken = ch;
          srcUnitLen = 1;
          pos++;
        }
      } else {
        rawToken = ch;
        srcUnitLen = 1;
        pos++;
      }
    }

    const active = rangeIdx < ranges.length ? ranges[rangeIdx]! : null;
    const shouldHighlight =
      active !== null && srcOffset >= active.start && srcOffset < active.end;

    if (shouldHighlight && !inHighlight) {
      out += openMark;
      inHighlight = true;
    } else if (!shouldHighlight && inHighlight) {
      out += "</span>";
      inHighlight = false;
    }

    out += rawToken;
    srcOffset += srcUnitLen;
  }

  if (inHighlight) {
    out += "</span>";
  }

  return out;
}

function buildHunkSegmentRows(
  seg: ParsedDiffLine[],
  highlightStream: (lines: string[]) => string[],
): DiffRow[] {
  const oldSegIndices: number[] = [];
  const oldCodes: string[] = [];
  const newSegIndices: number[] = [];
  const newCodes: string[] = [];

  for (let i = 0; i < seg.length; i++) {
    const p = seg[i]!;
    if (p.kind === "context" || p.kind === "del") {
      oldSegIndices.push(i);
      oldCodes.push(p.code);
    }
    if (p.kind === "context" || p.kind === "add") {
      newSegIndices.push(i);
      newCodes.push(p.code);
    }
  }

  const oldHtmlList = oldCodes.length > 0 ? highlightStream(oldCodes) : [];
  const newHtmlList = newCodes.length > 0 ? highlightStream(newCodes) : [];

  const htmlBySegIdx = new Array<string>(seg.length);
  for (let k = 0; k < oldSegIndices.length; k++) {
    const idx = oldSegIndices[k]!;
    if (seg[idx]!.kind === "del") {
      htmlBySegIdx[idx] = oldHtmlList[k] ?? escapeHtml(seg[idx]!.code);
    }
  }
  for (let k = 0; k < newSegIndices.length; k++) {
    const idx = newSegIndices[k]!;
    htmlBySegIdx[idx] = newHtmlList[k] ?? escapeHtml(seg[idx]!.code);
  }
  for (let i = 0; i < seg.length; i++) {
    if (htmlBySegIdx[i] === undefined) {
      htmlBySegIdx[i] = escapeHtml(seg[i]!.code);
    }
  }

  // Pair contiguous `del` runs with immediately following `add` runs (skipping
  // non-code `meta` lines like `\ No newline at end of file` between `-` and `+`).
  let cursor = 0;
  while (cursor < seg.length) {
    if (seg[cursor]!.kind !== "del") {
      cursor++;
      continue;
    }

    const delIndices: number[] = [];
    while (cursor < seg.length && (seg[cursor]!.kind === "del" || seg[cursor]!.kind === "meta")) {
      if (seg[cursor]!.kind === "del") {
        delIndices.push(cursor);
      }
      cursor++;
    }

    const addIndices: number[] = [];
    while (cursor < seg.length && (seg[cursor]!.kind === "add" || seg[cursor]!.kind === "meta")) {
      if (seg[cursor]!.kind === "add") {
        addIndices.push(cursor);
      }
      cursor++;
    }

    if (delIndices.length > 0 && addIndices.length > 0) {
      const paired = pairReplacementBlock(
        delIndices.map((idx) => seg[idx]!.code),
        addIndices.map((idx) => seg[idx]!.code),
      );
      for (const [localDel, ranges] of paired.delRangesByIndex.entries()) {
        const segIdx = delIndices[localDel]!;
        htmlBySegIdx[segIdx] = applyInlineDiffToHtml(
          htmlBySegIdx[segIdx]!,
          ranges,
          "rc-diff-word-del",
        );
      }
      for (const [localAdd, ranges] of paired.addRangesByIndex.entries()) {
        const segIdx = addIndices[localAdd]!;
        htmlBySegIdx[segIdx] = applyInlineDiffToHtml(
          htmlBySegIdx[segIdx]!,
          ranges,
          "rc-diff-word-add",
        );
      }
    }
  }

  return seg.map((p, i) => ({
    lineNum: p.lineNum,
    oldLineNum: p.oldLineNum,
    newLineNum: p.newLineNum,
    marker: p.marker,
    codeHtml: htmlBySegIdx[i]!,
    rawCode: p.code,
    kind: p.kind,
    hunkHeader: p.hunkHeader,
  }));
}

function partitionAndBuild(
  currentLines: ParsedDiffLine[],
  highlightStream: (lines: string[]) => string[],
): DiffRow[] {
  const out: DiffRow[] = [];
  let segStart = 0;

  const flushSeg = (end: number) => {
    if (end > segStart) {
      out.push(...buildHunkSegmentRows(currentLines.slice(segStart, end), highlightStream));
    }
  };

  for (let i = 0; i < currentLines.length; i++) {
    const p = currentLines[i]!;
    if (p.kind === "header" || p.kind === "ellipsis") {
      flushSeg(i);
      out.push({
        lineNum: p.lineNum,
        oldLineNum: p.oldLineNum,
        newLineNum: p.newLineNum,
        marker: p.marker,
        codeHtml: escapeHtml(p.code),
        rawCode: p.code,
        kind: p.kind,
        hunkHeader: p.hunkHeader,
      });
      segStart = i + 1;
    }
  }
  flushSeg(currentLines.length);
  return out;
}

/**
 * Synchronous diff-row builder (uses preloaded highlight.js when ready; falls
 * back to escaped plain text without ever invoking `highlightAuto`).
 */
export function buildDiffRowsSync(
  currentLines: ParsedDiffLine[],
  language?: string,
): DiffRow[] {
  return partitionAndBuild(
    currentLines,
    (streamLines) => highlightCodeLinesSync(streamLines, language) ?? streamLines.map(escapeHtml),
  );
}

/**
 * Async diff-row builder that ensures highlight.js is loaded when `language`
 * is known, then builds stateful syntax-highlighted + intra-line diffed rows.
 */
export async function buildDiffRows(
  currentLines: ParsedDiffLine[],
  language?: string,
): Promise<DiffRow[]> {
  if (language && !isCodeHighlightReady()) {
    await highlightCodeLines([], language);
  }
  return buildDiffRowsSync(currentLines, language);
}
