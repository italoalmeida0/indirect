/**
 * Pure, framework-free parsers and formatters for context-management tools
 * (`session_history`, `explore`) and foreground >20KB `brain/` arrival spills.
 *
 * Kept free of DOM and SolidJS imports so `bun test` exercises both live
 * `toolDetails` payloads and reloaded `<tool_result ...attrs...>body</tool_result>`
 * transcripts directly.
 */

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export interface SessionHistoryHit {
  rank: number;
  kind: "block" | "message";
  blockId?: string;
  retiredBy?: string;
  tier?: number;
  startIdx?: number;
  endIdx?: number;
  topic?: string;
  msgIdx?: number;
  role?: string;
  score: number;
  snippet: string;
}

export interface SessionHistorySearchView {
  action: "search";
  query: string;
  includeLiveTail: boolean;
  indexed?: number;
  hitCount: number;
  hitCountKnown: boolean;
  hits: SessionHistoryHit[];
  rawText: string;
}

export interface RecalledHistoryMessage {
  msgIdx: number;
  role: string;
  blockId: string;
  content: string;
}

export interface SessionHistoryRecallView {
  action: "recall";
  blockId?: string;
  startMsg?: number;
  endMsg?: number;
  offsetChars?: number;
  totalChars?: number;
  truncated: boolean;
  nextOffset?: number;
  messages: RecalledHistoryMessage[];
  cleanText: string;
}

export type SessionHistoryView = SessionHistorySearchView | SessionHistoryRecallView;

export interface ExploreView {
  task: string;
  focusPaths: string[];
  turns?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  durationLabel?: string;
  turnCapReached: boolean;
  synthesis: string;
}

export interface ArrivalSpillInfo {
  spilled: boolean;
  fileName?: string;
  fullPath?: string;
  lines?: number;
  bytes?: number;
  cleanBody: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFiniteInt(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

function unescapeGoQuoted(raw: string): string {
  return raw.replace(/\\(["\\ntr])/g, (_m, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return ch;
    }
  });
}

function splitCamelSubTokens(seg: string): string[] {
  if (!seg) return [];
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i < seg.length; i++) {
    const prev = seg[i - 1]!;
    const cur = seg[i]!;
    const prevLowerOrDigit = (prev >= "a" && prev <= "z") || (prev >= "0" && prev <= "9");
    const curUpper = cur >= "A" && cur <= "Z";
    const prevUpper = prev >= "A" && prev <= "Z";
    const nextLower = i + 1 < seg.length && seg[i + 1]! >= "a" && seg[i + 1]! <= "z";
    if ((prevLowerOrDigit && curUpper) || (prevUpper && curUpper && nextLower)) {
      parts.push(seg.slice(start, i));
      start = i;
    }
  }
  parts.push(seg.slice(start));
  return parts;
}

function extractHighlightTerms(query: string): string[] {
  const q = (query || "").trim();
  if (!q) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    // Allow single CJK characters; require >= 2 chars for ASCII/Latin fragments.
    const isSingleAscii = t.length === 1 && t.charCodeAt(0) < 0x3000;
    if (isSingleAscii) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };

  for (const token of q.split(/\s+/)) {
    const unquoted = token.replace(/^["'`]+|["'`.,;!?]+$/g, "");
    if (!unquoted) continue;
    add(unquoted);

    const stripped = unquoted.replace(/^[([{<]+|[)\]}>]+$/g, "");
    if (stripped && stripped !== unquoted) add(stripped);
    const base = stripped || unquoted;

    const noLine = base.replace(/:\d+(?:-\d+)?$/, "");
    if (noLine && noLine !== base) add(noLine);

    for (const seg of noLine.split(/[\\/:._-]+/)) {
      if (!seg) continue;
      if (seg.length >= 2) add(seg);
      for (const sub of splitCamelSubTokens(seg)) {
        if (sub.length >= 2) add(sub);
      }
    }
  }

  terms.sort((a, b) => b.length - a.length);
  return terms;
}

/**
 * Splits `text` into literal plain/matched segments for safe JSX `<mark>`
 * rendering. Longest terms win first so full identifiers and `file:line`
 * spans highlight contiguously without fragmenting on sub-tokens.
 */
export function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const terms = extractHighlightTerms(query);
  if (terms.length === 0) return [{ text, match: false }];

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const out: HighlightSegment[] = [];
  let cursor = 0;

  for (const m of text.matchAll(pattern)) {
    const idx = m.index ?? 0;
    const matched = m[0] || "";
    if (!matched) continue;
    if (idx > cursor) {
      out.push({ text: text.slice(cursor, idx), match: false });
    }
    if (out.length > 0 && out[out.length - 1]!.match) {
      out[out.length - 1]!.text += matched;
    } else {
      out.push({ text: matched, match: true });
    }
    cursor = idx + matched.length;
  }

  if (cursor < text.length) {
    out.push({ text: text.slice(cursor), match: false });
  }

  return out.length > 0 ? out : [{ text, match: false }];
}

const BLOCK_HIT_RE =
  /^\s*(\d+)\.\s*\[block\s+([^\s·]+)(?:\s*\(retired->([^)]+)\))?\s*·\s*tier\s+(\d+)\s*·\s*msgs\s+#(\d+)-#(\d+)(?:\s*·\s*(.+?))?\]\s*\(score\s+([0-9.]+)\)\s*$/;

const MSG_HIT_RE =
  /^\s*(\d+)\.\s*\[msg\s+#(\d+)\s*·\s*([^\s·]+)\s*·\s*block\s+([^\]]+)\]\s*\(score\s+([0-9.]+)\)\s*$/;

const RECALL_HINT_LINE_RE = /^\s+recall:\s*\{/;

function parseSearchHitsFromText(rawText: string): SessionHistoryHit[] {
  if (!rawText) return [];
  const lines = rawText.split(/\r?\n/);
  const hits: SessionHistoryHit[] = [];
  let current: SessionHistoryHit | null = null;
  let snippetParts: string[] = [];

  const flush = () => {
    if (!current) return;
    current.snippet = snippetParts.join(" ").trim();
    hits.push(current);
    current = null;
    snippetParts = [];
  };

  for (const line of lines) {
    const bm = BLOCK_HIT_RE.exec(line);
    if (bm) {
      flush();
      current = {
        rank: Number(bm[1]),
        kind: "block",
        blockId: bm[2]!.trim(),
        ...(bm[3] ? { retiredBy: bm[3].trim() } : {}),
        tier: Number(bm[4]) || 1,
        startIdx: Number(bm[5]),
        endIdx: Number(bm[6]),
        ...(bm[7]?.trim() ? { topic: bm[7].trim() } : {}),
        score: Number(bm[8]) || 0,
        snippet: "",
      };
      continue;
    }

    const mm = MSG_HIT_RE.exec(line);
    if (mm) {
      flush();
      current = {
        rank: Number(mm[1]),
        kind: "message",
        msgIdx: Number(mm[2]),
        role: mm[3]!.trim(),
        blockId: mm[4]!.trim(),
        score: Number(mm[5]) || 0,
        snippet: "",
      };
      continue;
    }

    if (current) {
      if (!line.trim()) {
        flush();
        continue;
      }
      if (RECALL_HINT_LINE_RE.test(line)) {
        continue;
      }
      if (/^\s+/.test(line)) {
        snippetParts.push(line.trim());
      }
    }
  }

  flush();
  return hits;
}

const RECALL_PAGINATED_TRAILER_RE =
  /(?:\r?\n)*\[\.\.\.\s*recall paginated:\s*offset_chars=(\d+),\s*next_offset=(\d+),\s*total_chars=(\d+),\s*truncated=(true|false)[^\]]*\]\s*$/;

const RECALL_PAST_END_RE =
  /^\[offset_chars=(\d+)\s+is at or past end of recalled text\s*\((\d+)\s+chars\)\]\s*$/;

const RECALL_HEADER_RE =
  /^===\s*\[msg\s+#(\d+)\s*·\s*([^\s·]+)\s*·\s*block\s+([^\]]+)\]\s*===[ \t]*(?:\r?\n|$)/gm;

function splitRecalledMessages(
  cleanText: string,
  fallbackStartMsg?: number,
  fallbackBlockId?: string,
): RecalledHistoryMessage[] {
  if (!cleanText) return [];
  const matches = Array.from(cleanText.matchAll(RECALL_HEADER_RE));
  if (matches.length === 0) return [];

  const messages: RecalledHistoryMessage[] = [];
  const firstIdx = matches[0]!.index ?? 0;
  if (firstIdx > 0) {
    const prefix = cleanText.slice(0, firstIdx).trimEnd();
    if (prefix.trim()) {
      const firstHeaderNum = Number(matches[0]![1]);
      messages.push({
        msgIdx: fallbackStartMsg ?? Math.max(0, firstHeaderNum - 1),
        role: "continued",
        blockId: fallbackBlockId || matches[0]![3]!.trim(),
        content: prefix,
      });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const bodyStart = (m.index ?? 0) + m[0].length;
    const bodyEnd = i + 1 < matches.length ? (matches[i + 1]!.index ?? cleanText.length) : cleanText.length;
    const content = cleanText.slice(bodyStart, bodyEnd).replace(/(?:\r?\n)+$/, "");
    messages.push({
      msgIdx: Number(m[1]),
      role: m[2]!.trim(),
      blockId: m[3]!.trim(),
      content,
    });
  }

  return messages;
}

/**
 * Parses `session_history` output across both live structured `toolDetails`
 * and reloaded raw `<tool_result>` text/attrs.
 */
export function parseSessionHistoryView(
  args: any,
  rawOutput: string,
  details?: any,
): SessionHistoryView {
  const env = (details?.env || {}) as Record<string, string>;
  const rawText = String(rawOutput || "");
  const explicitAction = String(details?.action || env.action || args?.action || "")
    .trim()
    .toLowerCase();

  const isRecall =
    explicitAction === "recall" ||
    (explicitAction !== "search" &&
      Boolean(
        args?.block_id ||
          args?.start_msg != null ||
          args?.end_msg != null ||
          details?.block_id ||
          details?.start_msg != null ||
          env.block_id ||
          env.start_msg != null ||
          /^===\s*\[msg #/m.test(rawText) ||
          RECALL_PAST_END_RE.test(rawText.trim()),
      ));

  if (isRecall) {
    const trailerMatch = RECALL_PAGINATED_TRAILER_RE.exec(rawText);
    const pastEndMatch = RECALL_PAST_END_RE.exec(rawText.trim());
    const cleanText = trailerMatch
      ? rawText.slice(0, trailerMatch.index).replace(/(?:\r?\n)+$/, "")
      : rawText.replace(/(?:\r?\n)+$/, "");

    const blockIdRaw = String(details?.block_id ?? env.block_id ?? args?.block_id ?? "").trim();
    const blockId = blockIdRaw || undefined;

    let startMsg = parseFiniteInt(details?.start_msg ?? env.start_msg ?? args?.start_msg);
    let endMsg = parseFiniteInt(details?.end_msg ?? env.end_msg ?? args?.end_msg);
    const offsetChars =
      parseFiniteInt(details?.offset_chars ?? env.offset_chars ?? args?.offset_chars) ??
      (trailerMatch ? Number(trailerMatch[1]) : pastEndMatch ? Number(pastEndMatch[1]) : undefined);
    const totalChars =
      parseFiniteInt(details?.total_chars ?? env.total_chars) ??
      (trailerMatch ? Number(trailerMatch[3]) : pastEndMatch ? Number(pastEndMatch[2]) : undefined);
    const truncated = Boolean(
      details?.truncated === true ||
        env.truncated === "true" ||
        (trailerMatch && trailerMatch[4] === "true"),
    );
    const rawNext =
      parseFiniteInt(details?.next_offset ?? env.next_offset) ??
      (trailerMatch ? Number(trailerMatch[2]) : undefined);
    const nextOffset = truncated && rawNext !== undefined && rawNext > 0 ? rawNext : undefined;

    const messages = splitRecalledMessages(cleanText, startMsg, blockId);
    if (startMsg === undefined && messages.length > 0) {
      startMsg = messages[0]!.msgIdx;
    }
    if (endMsg === undefined) {
      if (messages.length > 0) {
        endMsg = messages[messages.length - 1]!.msgIdx;
      } else if (startMsg !== undefined) {
        endMsg = startMsg;
      }
    }

    return {
      action: "recall",
      ...(blockId ? { blockId } : {}),
      ...(startMsg !== undefined ? { startMsg } : {}),
      ...(endMsg !== undefined ? { endMsg } : {}),
      ...(offsetChars !== undefined ? { offsetChars } : {}),
      ...(totalChars !== undefined ? { totalChars } : {}),
      truncated,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      messages,
      cleanText,
    };
  }

  // action === "search"
  const trimmed = rawText.trim();
  const foundHeader = /^Found\s+(\d+)\s+match\(es\)\s+for\s+"((?:\\.|[^"\\])*)"/m.exec(trimmed);
  const noMatchesHeader = /^No matches for\s+"((?:\\.|[^"\\])*)"(?:\s+across\s+(\d+)\s+indexed)?/m.exec(trimmed);
  const noCompactedHeader = /^No compacted history yet\b/m.test(trimmed);

  const rawQuery =
    typeof details?.query === "string" && details.query.trim()
      ? details.query.trim()
      : typeof args?.query === "string" && args.query.trim()
        ? args.query.trim()
        : foundHeader
          ? unescapeGoQuoted(foundHeader[2]!)
          : noMatchesHeader
            ? unescapeGoQuoted(noMatchesHeader[1]!)
            : "";

  const includeLiveTail = Boolean(
    details?.include_live_tail === true ||
      env.live_tail === "true" ||
      args?.include_live_tail === true,
  );

  const rawIndexed = parseFiniteInt(details?.indexed ?? env.indexed);
  const indexed =
    rawIndexed !== undefined && rawIndexed >= 0
      ? rawIndexed
      : noMatchesHeader?.[2]
        ? Number(noMatchesHeader[2])
        : noCompactedHeader
          ? 0
          : undefined;

  let hits: SessionHistoryHit[];
  if (Array.isArray(details?.hits)) {
    hits = details.hits
      .filter((h: any) => Boolean(h && typeof h === "object"))
      .map((h: any, idx: number): SessionHistoryHit => {
        const kind: "block" | "message" = h.kind === "block" ? "block" : "message";
        const tierNum = parseFiniteInt(h.tier);
        const startNum = parseFiniteInt(h.start_idx);
        const endNum = parseFiniteInt(h.end_idx);
        const msgNum = parseFiniteInt(h.msg_idx);
        const scoreNum = typeof h.score === "number" && Number.isFinite(h.score) ? h.score : Number(h.score) || 0;
        return {
          rank: typeof h.rank === "number" ? h.rank : idx + 1,
          kind,
          ...(h.block_id ? { blockId: String(h.block_id) } : {}),
          ...(h.retired_by ? { retiredBy: String(h.retired_by) } : {}),
          ...(kind === "block" ? { tier: tierNum && tierNum > 0 ? tierNum : 1 } : {}),
          ...(startNum !== undefined ? { startIdx: startNum } : {}),
          ...(endNum !== undefined ? { endIdx: endNum } : {}),
          ...(h.topic ? { topic: String(h.topic) } : {}),
          ...(msgNum !== undefined ? { msgIdx: msgNum } : {}),
          ...(h.role ? { role: String(h.role) } : {}),
          score: scoreNum,
          snippet: typeof h.snippet === "string" ? h.snippet.trim() : "",
        };
      });
  } else {
    hits = parseSearchHitsFromText(trimmed);
  }

  const attrHits = parseFiniteInt(env.hits);
  const hitCountKnown =
    Array.isArray(details?.hits) ||
    attrHits !== undefined ||
    Boolean(foundHeader) ||
    Boolean(noMatchesHeader) ||
    noCompactedHeader ||
    hits.length > 0;

  const hitCount =
    hits.length > 0
      ? Math.max(hits.length, attrHits ?? 0)
      : attrHits !== undefined && attrHits >= 0
        ? attrHits
        : foundHeader
          ? Number(foundHeader[1])
          : 0;

  return {
    action: "search",
    query: rawQuery,
    includeLiveTail,
    ...(indexed !== undefined ? { indexed } : {}),
    hitCount,
    hitCountKnown,
    hits,
    rawText: trimmed,
  };
}

/**
 * Parses human duration labels emitted in daemon envelope attrs
 * (e.g. `"450ms"`, `"2.4s"`, `"14s"`, `"1m 12s"`, `"1h 2m 3s"`) into ms.
 */
export function parseHumanDurationMs(raw?: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  const msOnly = /^(\d+(?:\.\d+)?)ms$/i.exec(s);
  if (msOnly) return Math.round(Number(msOnly[1]));

  let totalMs = 0;
  let matched = false;
  for (const part of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    const val = Number(part[1]);
    const unit = part[2]!.toLowerCase();
    if (!Number.isFinite(val)) continue;
    matched = true;
    if (unit === "ms") totalMs += val;
    else if (unit === "s") totalMs += val * 1000;
    else if (unit === "m") totalMs += val * 60_000;
    else if (unit === "h") totalMs += val * 3_600_000;
  }
  return matched ? Math.round(totalMs) : undefined;
}

/**
 * Parses `explore` subagent call arguments, live `toolDetails`, and durable
 * `<tool_result>` envelope attributes into a single presentation model.
 */
export function parseExploreView(
  args: any,
  rawOutput: string,
  details?: any,
): ExploreView {
  const env = (details?.env || {}) as Record<string, string>;
  const task = typeof args?.task === "string" ? args.task.trim() : "";
  const rawFocus = details?.focus_paths ?? args?.focus_paths;
  const focusPaths = Array.isArray(rawFocus)
    ? rawFocus.map((p: unknown) => String(p ?? "").trim()).filter(Boolean)
    : [];

  const synthesis = String(rawOutput || "").trim();
  const capNoteMatch = /\[Note:\s*explore reached its (\d+)-turn cap after (\d+) tool call\(s\)\.\]/i.exec(synthesis);
  const stoppedFallbackMatch =
    /^Explore subagent stopped after (\d+) turn\(s\) and (\d+) read-only tool call\(s\)/m.exec(synthesis);

  const turns =
    parseFiniteInt(details?.turns ?? env.turns) ??
    (capNoteMatch ? Number(capNoteMatch[1]) : stoppedFallbackMatch ? Number(stoppedFallbackMatch[1]) : undefined);
  const toolCalls =
    parseFiniteInt(details?.tool_calls ?? env.tool_calls) ??
    (capNoteMatch ? Number(capNoteMatch[2]) : stoppedFallbackMatch ? Number(stoppedFallbackMatch[2]) : undefined);

  const inTok = parseFiniteInt(details?.input_tokens ?? env.in_tokens);
  const outTok = parseFiniteInt(details?.output_tokens ?? env.out_tokens);
  const durationLabel = typeof env.duration === "string" && env.duration.trim() ? env.duration.trim() : undefined;
  const durationMs =
    parseFiniteInt(details?.duration_ms) ??
    parseHumanDurationMs(durationLabel);

  const turnCapReached = Boolean(
    details?.turn_cap_reached === true ||
      env.turn_cap_reached === "true" ||
      Boolean(capNoteMatch),
  );

  return {
    task,
    focusPaths,
    ...(turns !== undefined && turns >= 0 ? { turns } : {}),
    ...(toolCalls !== undefined && toolCalls >= 0 ? { toolCalls } : {}),
    ...(inTok !== undefined && inTok > 0 ? { inputTokens: inTok } : {}),
    ...(outTok !== undefined && outTok > 0 ? { outputTokens: outTok } : {}),
    ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
    ...(durationLabel ? { durationLabel } : {}),
    turnCapReached,
    synthesis,
  };
}

/**
 * Extracts the latest `step N · ...` progress line from a streamed
 * `tool_progress` buffer. `EvToolProgress` concatenates chunks across steps
 * (`"step 1 · glob **\/*.gostep 2 · read pkg/router.go"`), so slice from the
 * final `step <N> · ` marker.
 */
export function latestExploreProgress(raw?: string): string {
  const s = typeof raw === "string" ? raw : "";
  if (!s.trim()) return "";
  const matches = Array.from(s.matchAll(/step\s+\d+\s*·\s*/g));
  if (matches.length > 0) {
    const last = matches[matches.length - 1]!;
    return s.slice(last.index ?? 0).trim();
  }
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1]! : "";
}

const ARRIVAL_SPILL_TRAILER_RE =
  /(?:\r?\n)*\[Full output saved to (.+?) \((\d+) lines, (\d+) bytes\)\s*(?:—|--|-)[^\]]+\]\s*$/;

function baseNameFromAnyPath(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = norm.lastIndexOf("/");
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

/**
 * Extracts foreground >20KB `brain/` arrival-spill metadata from envelope
 * attributes and/or the LLM `[Full output saved to ...]` preview trailer,
 * returning `cleanBody` with the machine trailer stripped.
 */
export function extractArrivalSpillInfo(
  rawBody: string,
  env?: Record<string, string>,
): ArrivalSpillInfo {
  const text = typeof rawBody === "string" ? rawBody : "";
  const trailerMatch = ARRIVAL_SPILL_TRAILER_RE.exec(text);
  const spilledByAttr = env?.spilled === "true";

  if (!spilledByAttr && !trailerMatch) {
    return { spilled: false, cleanBody: text };
  }

  const cleanBody = trailerMatch
    ? text.slice(0, trailerMatch.index).replace(/(?:\r?\n)+$/, "")
    : text;

  const fullPath = trailerMatch?.[1]?.trim() || undefined;
  const attrFile = typeof env?.spill_file === "string" ? env.spill_file.trim() : "";
  const fileName =
    (attrFile ? baseNameFromAnyPath(attrFile) : "") ||
    (fullPath ? baseNameFromAnyPath(fullPath) : "") ||
    undefined;

  const lines =
    parseFiniteInt(env?.spill_lines) ??
    (trailerMatch?.[2] ? Number(trailerMatch[2]) : undefined);
  const bytes =
    parseFiniteInt(env?.spill_bytes) ??
    (trailerMatch?.[3] ? Number(trailerMatch[3]) : undefined);

  return {
    spilled: true,
    ...(fileName ? { fileName } : {}),
    ...(fullPath ? { fullPath } : {}),
    ...(lines !== undefined && lines >= 0 ? { lines } : {}),
    ...(bytes !== undefined && bytes >= 0 ? { bytes } : {}),
    cleanBody,
  };
}

export function formatSpillBytes(bytes?: number): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
