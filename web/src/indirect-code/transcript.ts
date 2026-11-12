import type { ChatMessage, ContentBlock, RenderBlock, ToolUnit, TurnBalloon, TurnEntry } from "./types";
import { formatDurationSecs } from "./utils/format";
import { displayToolArgs, withoutContinueNudges, withoutTodoActivity } from "./live";
import { parseExploreView, parseSessionHistoryView } from "./utils/contextTools";
import { stripToolEnvelopeDetailed } from "./utils/envelope";
import { extractTodoItems, resolveWidgetId } from "./utils/tools";

/** bg_cancel/bg_check kind: exec_script vs terminal. The daemon includes the
 * kind in the result header ("Background Task (exec_script) — …"); fall back
 * to the job registry via toolDetails when present. */
function bgTaskKind(args: any, res: string, env?: Record<string, string>): "bash" | "exec_script" | "python" {
  const k = String(env?.kind || "").toLowerCase();
  if (k === "exec_script" || k === "python" || k === "bash") return k;
  const m = /Background Task \((bash|exec_script|python)\)/.exec(res || "");
  if (m) return m[1] as "bash" | "exec_script" | "python";
  const ak = String((args as any)?.kind || "").toLowerCase();
  if (ak === "exec_script" || ak === "python") return ak;
  return "bash";
}
function bgCancelKind(args: any, res: string, env?: Record<string, string>): string {
  return bgTaskKind(args, res, env);
}
function bgCheckKind(args: any, res: string, env?: Record<string, string>): string {
  return bgTaskKind(args, res, env);
}
/** Extracts the "LX-Y" range from a bg_check result (envelope page attr,
 * legacy header "Lines X–Y of N") for the row target. */
function bgCheckRange(res: string, env?: Record<string, string>): string {
  const pm = /^(\d+)-(\d+)\//.exec(env?.page || "");
  if (pm) return `L${pm[1]}-${pm[2]}`;
  const m = /Lines (\d+)[–-](\d+) of \d+/.exec(res || "");
  if (m) return `L${m[1]}-${m[2]}`;
  return "";
}

function hasVisibleText(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "text" && !!b.text?.trim());
}

function hasToolActivity(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "tool_call" || b.type === "tool_result");
}

/**
 * Ephemeral interim text (Talk-style turns): a plain assistant text segment
 * is shown while it streams, but once a tool call, a new thinking run or an
 * image lands after it in the same turn, the segment is superseded and stops
 * rendering — only the turn's trailing text stays visible as the final
 * answer. Summary (`hasSummary`) and completion (`hasCompletion`) texts are
 * deliberate user-facing signals and are never superseded, so workspace
 * turns (whose only visible texts are those projections) are unaffected.
 * Display-only: raw messages and srcIdx mapping are untouched, and messages
 * are kept even when emptied so turn structure stays stable.
 */
function stripEphemeralTurnText(turnMsgs: ChatMessage[]): ChatMessage[] {
  let ordinal = 0;
  let lastSuperseder = -1;
  const candidateAt = new Map<string, number>(); // "msg:block" -> ordinal
  for (let mi = 0; mi < turnMsgs.length; mi++) {
    const m = turnMsgs[mi];
    const candidate =
      m.role === "assistant" && !m.hasCompletion && !m.hasSummary;
    for (let bi = 0; bi < m.blocks.length; bi++) {
      const b = m.blocks[bi];
      if (candidate && b.type === "text" && !!b.text?.trim()) {
        candidateAt.set(`${mi}:${bi}`, ordinal);
      } else if (
        b.type === "tool_call" ||
        b.type === "image" ||
        (b.type === "reasoning" && !!b.reasoning?.trim())
      ) {
        lastSuperseder = ordinal;
      }
      ordinal++;
    }
  }
  if (lastSuperseder < 0 || candidateAt.size === 0) return turnMsgs;
  let changed = false;
  const out = turnMsgs.map((m, mi) => {
    const blocks = m.blocks.filter((_, bi) => {
      const at = candidateAt.get(`${mi}:${bi}`);
      return at === undefined || at > lastSuperseder;
    });
    if (blocks.length === m.blocks.length) return m;
    changed = true;
    return { ...m, blocks };
  });
  return changed ? out : turnMsgs;
}

/** Per-row session costs with the output bucket split pro-rata between
 * plain output and reasoning (same unit price, so the split is exact).
 * Null when the daemon reported no pricing — callers then hide costs. */
export function usageCosts(usage: {
  outTok: number; reasoningTok: number; costUsd: number;
  costInUsd?: number; costCacheUsd?: number; costOutUsd?: number;
}): { total: number; input: number; cache: number; output: number; reasoning: number } | null {
  const ci = usage.costInUsd || 0;
  const cc = usage.costCacheUsd || 0;
  const co = usage.costOutUsd || 0;
  if (ci + cc + co <= 0 && !(usage.costUsd > 0)) return null;
  const out = Math.max(0, usage.outTok || 0);
  const reason = Math.min(Math.max(0, usage.reasoningTok || 0), out);
  const reasoningShare = out > 0 ? (co * reason) / out : 0;
  return {
    total: usage.costUsd || 0,
    input: ci,
    cache: cc,
    output: co - reasoningShare,
    reasoning: reasoningShare,
  };
}

/** USD with 2 decimals, truncated (never rounded up): $0.001 shows
 * as $0.00. */
export function fmtUsd(v: number): string {
  const n = Number(v) || 0;
  return (Math.floor(n * 100) / 100).toFixed(2);
}

/** Share of input tokens served from cache: cache / (fresh + cache).
 * Null when nothing was read yet — the caller then shows bare "Cache". */
export function cacheHitPct(usage: { inTok: number; cacheTok: number }): number | null {
  const total = (usage.inTok || 0) + (usage.cacheTok || 0);
  if (total <= 0) return null;
  return Math.round((100 * (usage.cacheTok || 0)) / total);
}

/** Max chars for the live turn hint shown next to "Working · <time>". */
const TURN_HINT_MAX_CHARS = 100;

/** Single-line text of an assistant message (whitespace collapsed). */
function assistantSingleLine(message: ChatMessage): string {
  return message.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Latest short (<100 chars) assistant text of the current turn: the turn
 * is the max stamped turnIndex, or — when nothing is stamped yet (live
 * streaming) — the tail after the last user turn-start message. Walks
 * back so a long/streaming bubble falls through to an earlier short one. */
export function latestShortTurnMessage(messages: ChatMessage[]): string {
  if (!messages || messages.length === 0) return "";
  let maxStamped = 0;
  for (const m of messages) {
    if (typeof m.turnIndex === "number" && m.turnIndex > maxStamped) maxStamped = m.turnIndex;
  }
  let turnMsgs: ChatMessage[];
  if (maxStamped > 0) {
    let start = messages.findIndex((m) => m.turnIndex === maxStamped);
    for (let i = messages.length - 1; i > start; i--) {
      if (isTurnStartMessage(messages[i]) && messages[i].turnIndex !== maxStamped) { start = i + 1; break; }
    }
    turnMsgs = messages.slice(start);
  } else {
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnStartMessage(messages[i])) { start = i + 1; break; }
    }
    turnMsgs = messages.slice(start);
  }
  // Use the same successful-signal projection as the transcript. Pending or
  // rejected summary arguments must not leak through the Working hint.
  const visible = withoutTodoActivity(turnMsgs);
  for (let i = visible.length - 1; i >= 0; i--) {
    if (!visible[i].hasSummary) continue;
    const text = assistantSingleLine(visible[i]);
    if (text) return text.length > TURN_HINT_MAX_CHARS ? text.slice(0, TURN_HINT_MAX_CHARS - 1) + "…" : text;
  }

  // In tool turns without an explicit summary tool call, suppress conversational chatter hints.
  if (turnMsgs.some(hasToolActivity)) {
    return "";
  }

  for (let i = turnMsgs.length - 1; i >= 0; i--) {
    const m = turnMsgs[i];
    if (m.role !== "assistant") continue;
    const text = assistantSingleLine(m);
    if (text && text.length < TURN_HINT_MAX_CHARS) return text;
  }
  return "";
}

/** Pair tool calls with results across a turn, in display order.
 * Duplicate calls with the same id (pre-created card + finalized call)
 * merge into one unit so no result-less orphan lingers mid-list. */
function pushCallUnit(units: ToolUnit[], byId: Map<string, ToolUnit>, block: ContentBlock): void {
  const existing = block.toolId ? byId.get(block.toolId) : undefined;
  if (existing) {
    existing.call = block;
    return;
  }
  const unit: ToolUnit = { id: block.toolId, call: block };
  units.push(unit);
  if (block.toolId) byId.set(block.toolId, unit);
}

function pairTurnUnits(turnMsgs: ChatMessage[]): ToolUnit[] {
  const units: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  for (const message of turnMsgs) {
    for (const block of message.blocks) {
      if (block.type === "tool_call") {
        pushCallUnit(units, byId, block);
      } else if (block.type === "tool_result") {
        const unit = block.toolId ? byId.get(block.toolId) : undefined;
        if (unit) unit.result = block;
        else {
          const orphan = { id: block.toolId, result: block };
          units.push(orphan);
          if (block.toolId) byId.set(block.toolId, orphan);
        }
      }
    }
  }
  return units;
}

/** Ordered aggregate rows for a tool/thinking block, in stored (daemon) block order.
 * Tool runs stay merged across messages until a thinking/image entry breaks them. */
function buildTurnEntries(turnMsgs: ChatMessage[]): TurnEntry[] {
  const entries: TurnEntry[] = [];
  let run: ToolUnit[] = [];
  let runMsg: ChatMessage | null = null;
  const byId = new Map<string, ToolUnit>();
  const flushRun = () => {
    if (run.length && runMsg) entries.push({ kind: "tools", msg: runMsg, units: run });
    run = [];
    runMsg = null;
  };
  for (const message of turnMsgs) {
    const reasoning = message.blocks.filter((b) => b.type === "reasoning" && !!b.reasoning?.trim());
    // Stored (daemon) order, newest first; stored[0] is the live one.
    for (let r = 0; r < reasoning.length; r++) {
      flushRun();
      entries.push({ kind: "thinking", msg: message, block: reasoning[r], nth: r, isNewest: r === 0 });
    }
    for (const block of message.blocks) {
      if (block.type === "tool_call") {
        if (!runMsg) runMsg = message;
        pushCallUnit(run, byId, block);
      } else if (block.type === "tool_result") {
        const unit = block.toolId ? byId.get(block.toolId) : undefined;
        if (unit) {
          unit.result = block;
        } else {
          if (!runMsg) runMsg = message;
          const orphan = { id: block.toolId, result: block };
          run.push(orphan);
          if (block.toolId) byId.set(block.toolId, orphan);
        }
      } else if (block.type === "image") {
        flushRun();
        entries.push({ kind: "image", msg: message, block });
      }
    }
  }
  flushRun();
  return entries.map((entry, index) => ({
    ...entry,
    id: entry.kind === "tools"
      ? `${entry.msg.id}:tools:${entry.units[0]?.id || index}`
      : `${entry.msg.id}:${entry.kind}:${"nth" in entry ? entry.nth : index}`,
  }));
}

function buildTurnBlocks(turnMsgs: ChatMessage[], turnKey: string): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let currentGroup: ChatMessage[] = [];

  const flushGroup = (textMsg?: ChatMessage) => {
    if (currentGroup.length === 0 && !textMsg) return;
    const groupMsgs = textMsg && !currentGroup.includes(textMsg)
      ? [...currentGroup, textMsg]
      : [...currentGroup];
    const entries = buildTurnEntries(groupMsgs);
    const leadMsg = groupMsgs[0] || textMsg!;
    const blockId = textMsg ? textMsg.id : leadMsg.id;

    if (entries.length > 0) {
      blocks.push({
        kind: "series",
        id: blockId,
        turnKey,
        msg: leadMsg,
        extras: groupMsgs.slice(1),
        units: pairTurnUnits(groupMsgs),
        entries,
        textMsg,
      });
    } else {
      blocks.push({ kind: "single", turnKey, msg: textMsg || leadMsg });
    }
    currentGroup = [];
  };

  for (const m of turnMsgs) {
    if (hasVisibleText(m)) {
      currentGroup.push(m);
      flushGroup(m);
    } else {
      currentGroup.push(m);
    }
  }
  flushGroup(undefined);
  return blocks;
}

type RenderCache = Map<string, { messages: ChatMessage[]; blocks: RenderBlock[] }>;

/** Per-view cache: immutable message identities invalidate only changed turns.
 * Keeping only the latest turn set bounds retention across session switches. */
export function createRenderBlockBuilder() {
  const cache: RenderCache = new Map();
  return (messages: ChatMessage[]) => buildRenderBlocks(messages, cache);
}

/** One aggregate per contiguous tool execution/thinking run; visible text
 * messages (summaries, completions, direct answers) separate as individual
 * bubbles. Source indices remain attached to the original daemon messages. */
export function buildRenderBlocks(
  messages: ChatMessage[], cache?: RenderCache,
): RenderBlock[] {
  const list = withoutContinueNudges(withoutTodoActivity(messages));
  const result: RenderBlock[] = [];
  const nextCache: RenderCache = new Map();

  for (let i = 0; i < list.length; i++) {
    const head = list[i];
    // Turn identity shared by every block of the turn: the daemon's turn
    // sequence keeps mid-turn steering splits unified, and the group's lead
    // message id covers legacy messages without a stamped turnIndex. Live
    // state is turn-scoped — consumers match this key, never block position.
    const turnKey = head.turnIndex != null ? `turn:${head.turnIndex}` : `msg:${head.id}`;
    if (head.role === "user") { result.push({ kind: "single", turnKey, msg: head }); continue; }

    let turnEnd = i;
    while (turnEnd + 1 < list.length && list[turnEnd + 1].role !== "user" &&
      !(head.turnIndex && list[turnEnd + 1].turnIndex && head.turnIndex !== list[turnEnd + 1].turnIndex)) turnEnd++;
    const turnMsgs = list.slice(i, turnEnd + 1);
    const cached = cache?.get(head.id);
    if (cached && cached.messages.length === turnMsgs.length && cached.messages.every((m, index) => m === turnMsgs[index])) {
      result.push(...cached.blocks); nextCache.set(head.id, cached); i = turnEnd; continue;
    }
    const blocks = buildTurnBlocks(stripEphemeralTurnText(turnMsgs), turnKey);
    result.push(...blocks);
    nextCache.set(head.id, { messages: turnMsgs, blocks });
    i = turnEnd;
  }
  if (cache) { cache.clear(); for (const [key, value] of nextCache) cache.set(key, value); }
  return result;
}

/** Wall-clock duration belongs to the turn, regardless of its presentation. */
export function blockTurnDuration(block: RenderBlock): number | undefined {
  const messages = block.kind === "series"
    ? (block.textMsg ? [block.textMsg, block.msg, ...block.extras] : [block.msg, ...block.extras])
    : [block.msg];
  return messages.find((m) => Number.isFinite(m.turnDurationMs) && (m.turnDurationMs ?? 0) > 0)?.turnDurationMs;
}

/** Strip only the daemon's terminal footer. Preserve actual command output. */
export function terminalPresentation(text: string): {output:string; durationMs?:number} {
  const match = /\n\[exit -?\d+\](?: \(full output: ([^\n]+)\))? {2}Took ((?:\d+h ?)?(?:\d+m ?)?(?:[\d.]+s)?)\s*$/.exec(text);
  if (!match) return {output:text};
  return {output:text.slice(0, match.index).trimEnd() + (match[1] ? `\n\nFull output: ${match[1]}` : ""),
    durationMs:Array.from(match[2].matchAll(/([\d.]+)([hms])/g)).reduce((sum, part) => sum + Number(part[1])*({h:3600000,m:60000,s:1000}[part[2]] || 0), 0)};
}

export function baseNameOf(p?: string): string {
  if (!p) return "";
  const t = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

export function diffStat(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const ln of (text || "").split("\n")) {
    const clean = ln.replace(/^\d+:/, "");
    if (clean.startsWith("+") && !clean.startsWith("+++")) add++;
    else if (clean.startsWith("-") && !clean.startsWith("---")) del++;
  }
  return { add, del };
}

export interface ToolSummary {
  icon: string;
  verb: string;
  target: string;
  stat?: string;
  statAdd?: number;
  statDel?: number;
}

function isCleanQuestionLabel(text: any): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("[") || t.startsWith("{") || t.includes('"header"') || t.includes('"options"') || t.includes('{"')) {
    return false;
  }
  return true;
}

function extractQuestionItems(args: any): any[] {
  if (!args) return [];
  if (Array.isArray(args)) return args;

  const raw = args.questions ?? args.question;
  if (!raw) return [];

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") {
          return Array.isArray(parsed.questions)
            ? parsed.questions
            : Array.isArray(parsed.question)
              ? parsed.question
              : [parsed];
        }
      } catch {
        return [];
      }
    }
    if (isCleanQuestionLabel(trimmed)) {
      return [{ question: trimmed }];
    }
    return [];
  }

  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    if (Array.isArray(raw.questions)) return raw.questions;
    if (Array.isArray(raw.question)) return raw.question;
    return [raw];
  }

  return [];
}


function editsLineStat(edits: unknown): { add: number; del: number } {
  if (!Array.isArray(edits)) return { add: 0, del: 0 };
  let add = 0;
  let del = 0;
  for (const item of edits) {
    if (!item || typeof item !== "object") continue;
    const oldRaw = (item as any).old_text ?? (item as any).old;
    const newRaw = (item as any).new_text ?? (item as any).new;
    if (typeof oldRaw !== "string" && typeof newRaw !== "string") continue;
    const oldLines = typeof oldRaw === "string" && oldRaw.length > 0 ? oldRaw.split("\n") : [];
    const newLines = typeof newRaw === "string" && newRaw.length > 0 ? newRaw.split("\n") : [];
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix++;
    }
    del += oldLines.length - prefix - suffix;
    add += newLines.length - prefix - suffix;
  }
  return { add, del };
}

function shortBgJobId(raw: string): string {
  const id = raw.trim();
  if (id.length <= 20) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function countBgListJobs(res: string, details: any): number | null {
  if (Array.isArray(details?.jobs)) return details.jobs.length;
  if (Array.isArray(details?.tasks)) return details.tasks.length;
  if (typeof details?.total === "number") return details.total;
  const trimmed = (res || "").trim();
  if (!trimmed) return null;
  if (/^(?:\(none\b|no (?:active |running )?background\b)/i.test(trimmed)) return 0;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.length;
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.jobs)) return parsed.jobs.length;
        if (Array.isArray(parsed.tasks)) return parsed.tasks.length;
      }
    } catch {
      // ignore non-JSON output
    }
  }
  const headerCount = /\((\d+)\s+(?:job|jobs|task|tasks|entr(?:y|ies))\)/i.exec(trimmed);
  if (headerCount) return Number(headerCount[1]);
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(?:background (?:jobs|tasks)|jobs|tasks)\b[:\s]*$/i.test(l));
  if (lines.length === 1 && /\b(?:none|0 jobs|0 tasks)\b/i.test(lines[0])) return 0;
  return lines.length > 0 ? lines.length : null;
}

function unwrapToolSummaryInput(res: string, details: any): { cleanRes: string; mergedDetails: any } {
  if (!res || !res.includes("<tool_result")) {
    return { cleanRes: res, mergedDetails: details };
  }
  const stripped = stripToolEnvelopeDetailed(res);
  if (Object.keys(stripped.attrs).length === 0) {
    return { cleanRes: stripped.body, mergedDetails: details };
  }
  return {
    cleanRes: stripped.body,
    mergedDetails: {
      ...(details && typeof details === "object" ? details : {}),
      env: { ...stripped.attrs, ...(details?.env || {}) },
    },
  };
}

function compactCharCount(chars: number): string {
  if (chars >= 1000) {
    const rounded = (Math.round(chars / 100) / 10).toFixed(1).replace(/\.0$/, "");
    return `${rounded}k chars`;
  }
  return `${chars} chars`;
}

export function toolSummary(u: ToolUnit): ToolSummary {
  const name = u.call?.toolName || "tool";
  const args = displayToolArgs(u.call?.toolArgs);
  const res = u.result?.toolResult || "";
  const details = u.result?.toolDetails as any;
  if (name.startsWith("mcp__")) {
    return { icon: "lucide:plug", verb: "MCP", target: name.slice(5).replace(/_[a-f0-9]{12}$/, "").replaceAll("__", " / "), stat: u.result ? (u.result.isError ? "Failed" : "Complete") : undefined };
  }
  switch (name) {
    case "question": {
      const qList = extractQuestionItems(args);
      const targets = qList
        .map((q: any) => {
          if (typeof q === "string") return isCleanQuestionLabel(q) ? q.trim() : "";
          const label = q?.header || q?.question || "";
          return isCleanQuestionLabel(label) ? label.trim() : "";
        })
        .filter(Boolean);
      return {
        icon: "lucide:message-circle",
        verb: u.result ? "Asked" : "Asking",
        target: targets.join(" · ") || "Questions",
      };
    }
    case "read": {
      // Daemon offset is 1-indexed (schema: "Line number to start reading
      // from (1-indexed)"); the display block numbers lines with startLine+i+1,
      // so the label must use off directly, not off+1.
      const off = Math.max(1, Number(args.offset || 1));
      const lines = res ? res.split("\n").length : 0;
      const lim = Number(args.limit || 0);
      const end = lim > 0 ? off + lim - 1 : off + lines - 1;
      return {
        icon: "lucide:file-text",
        verb: "Analyzed",
        target: `${baseNameOf(args.path) || args.path || "file"}#L${off}-${Math.max(end, off)}`,
      };
    }
    case "glob": {
      const n = res ? res.split("\n").filter((l) => l.trim()).length : 0;
      return {
        icon: "lucide:search",
        verb: "Searched",
        target: String(args.pattern || ""),
        stat: n > 0 ? `${n} match${n === 1 ? "" : "es"}` : undefined,
      };
    }
    case "bash": {
      const cmd = String(args.command || "").replace(/\s+/g, " ").trim();
      const bg = details?.background_job_id;
      // Detached runs (placeholder or folded result) read as background
      // work in the turn and the card, never as a plain synchronous run.
      const verb = typeof bg === "string" && bg ? "Background" : "Ran";
      return {
        icon: "lucide:terminal",
        verb,
        target: cmd.length > 90 ? cmd.slice(0, 90) + "…" : cmd,
      };
    }
    case "bg_await": {
      const s = Number(args.max_wait_seconds);
      const elapsedMs = u.result?.toolDurationMs;
      const target = u.result && elapsedMs != null
        ? formatDurationSecs(Math.round(elapsedMs / 1000))
        : (Number.isFinite(s) ? formatDurationSecs(s) : "");
      return {
        icon: "lucide:timer",
        verb: u.result ? "Waited" : "Awaiting",
        target,
      };
    }
    case "bg_cancel": {
      // Clean UI: never show the id. "Canceled <kind> Background Task".
      const env = details?.env;
      const kind = bgCancelKind(args, res, env);
      const isErr = Boolean(u.result && (u.result.isError || env?.error));
      const notCancelled = Boolean(
        u.result &&
        (details?.cancelled === false ||
          (env && (env.cancelled === false || env.cancelled === "false")))
      );
      return {
        icon: kind === "exec_script" ? "mdi:language-javascript" : kind === "python" ? "mdi:language-python" : "lucide:terminal",
        verb: !u.result ? "Canceling" : isErr ? "Failed" : notCancelled ? "Checked" : "Canceled",
        target: `${kind === "exec_script" || kind === "python" ? "Script" : "Terminal"} Background Task`,
      };
    }
    case "bg_check": {
      // Reads like a file: "Background Task#Lfrom-to", kind icon.
      const env = details?.env;
      const kind = bgCheckKind(args, res, env);
      const range = bgCheckRange(res, env);
      return {
        icon: kind === "exec_script" ? "mdi:language-javascript" : kind === "python" ? "mdi:language-python" : "lucide:terminal",
        verb: "Read",
        target: range ? `Background Task#${range}` : "Background Task",
      };
    }
    case "bg_tail": {
      const env = details?.env;
      const kind = bgCheckKind(args, res, env);
      const range = bgCheckRange(res, env);
      const rawId = String(args.job_id || args.id || details?.background_job_id || "").trim();
      const label = rawId ? shortBgJobId(rawId) : "Background Task";
      return {
        icon: kind === "exec_script" ? "mdi:language-javascript" : kind === "python" ? "mdi:language-python" : "lucide:terminal",
        verb: u.result ? "Tailed" : "Tailing",
        target: range ? `${label}#${range}` : label,
        stat: env?.status ? String(env.status) : undefined,
      };
    }
    case "bg_list": {
      const jobCount = u.result ? countBgListJobs(res, details) : null;
      return {
        icon: "lucide:layers",
        verb: u.result ? "Checked" : "Checking",
        target: "Background jobs",
        stat: jobCount !== null ? `${jobCount} job${jobCount === 1 ? "" : "s"}` : undefined,
      };
    }
    case "search": {
      const pat = String(args.pattern || "").replace(/\s+/g, " ").trim();
      const scope = args.path && String(args.path) !== "." ? ` in ${baseNameOf(args.path) || args.path}` : "";
      const target = `${pat.length > 80 ? pat.slice(0, 80) + "…" : pat}${scope}`;
      return {
        icon: "lucide:search",
        verb: "Search",
        target: target || "pattern",
      };
    }
    case "inspect": {
      const target = args.path && String(args.path) !== "." ? String(args.path) : "workspace";
      return { icon: "lucide:folder-tree", verb: "Inspect", target };
    }
    case "patch":
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const files = [...new Set([
        args.path ? (baseNameOf(args.path) || args.path) : null,
        args.file ? (baseNameOf(args.file) || args.file) : null,
        ...edits.map((e: any) => baseNameOf(e?.file || e?.path) || e?.file || e?.path),
      ].filter(Boolean))];
      const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? ` +${files.length - 3}` : "");
      const isPreview = details?.dry_run === true;
      const verb = isPreview ? (name === "patch" ? "Preview patch" : "Preview edit") : (name === "patch" ? "Patch" : "Edited");
      // Prefer the frontend-only display rendering (details.display); the
      // AI-visible text is a one-line confirmation with no diff.
      const st = diffStat(details?.display ?? res);
      return {
        icon: "lucide:file-diff",
        verb,
        target: shown || (baseNameOf(args.path) || args.path || `${edits.length} edit${edits.length === 1 ? "" : "s"}`),
        ...(st.add > 0 || st.del > 0 ? { statAdd: st.add, statDel: st.del } : {}),
      };
    }
    case "search_web": {
      const q = String(args.query || "").replace(/\s+/g, " ").trim();
      return {
        icon: "lucide:globe",
        verb: "Web search",
        target: q.length > 90 ? q.slice(0, 90) + "…" : q || "query",
      };
    }
    case "fetch_url": {
      let host = String(args.url || "");
      try {
        host = new URL(String(args.url || "")).hostname.replace(/^www\./, "");
      } catch {
        // keep raw url string
      }
      return {
        icon: "lucide:link",
        verb: "Fetch",
        target: host.length > 90 ? host.slice(0, 90) + "…" : host || "url",
      };
    }
    case "exec_script":
    case "python": {
      const codeStr = String(args.code || "");
      const scriptStr = String(args.script || "");
      const extractFirstCodeLine = (src: string): string => {
        let i = 0;
        const n = src.length;
        while (i < n) {
          while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\r" || src[i] === "\n")) i++;
          if (i >= n) break;
          if ((src[i] === "/" && src[i + 1] === "/") || src[i] === "#") {
            while (i < n && src[i] !== "\n") i++;
            continue;
          }
          if (src[i] === "/" && src[i + 1] === "*") {
            i += 2;
            while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
            if (i < n) i += 2;
            continue;
          }
          let lineEnd = src.indexOf("\n", i);
          if (lineEnd < 0) lineEnd = n;
          return src.slice(i, lineEnd).trim();
        }
        return "";
      };
      const first = codeStr.trim()
        ? extractFirstCodeLine(codeStr)
        : scriptStr.trim()
          ? [baseNameOf(scriptStr) || scriptStr, ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(" ")
          : "";
      const one = (first || "snippet").replace(/\s+/g, " ").trim();
      const bg = details?.background_job_id;
      const verb = typeof bg === "string" && bg ? "Background" : "Ran";
      const legacyLang = typeof args.legacy_lang === "string" ? args.legacy_lang.trim().toLowerCase() : "";
      const isLegacyPython = name === "python" || legacyLang === "python" || legacyLang === "python3" || (!codeStr.trim() && Boolean(scriptStr.trim()));
      return {
        icon: isLegacyPython ? "mdi:language-python" : "mdi:language-javascript",
        verb,
        target: one.length > 90 ? one.slice(0, 90) + "…" : one,
      };
    }
    case "write": {
      const content = String(args.content || "");
      const n = content ? content.split("\n").length : 0;
      return {
        icon: "lucide:file-text",
        verb: "Created",
        target: baseNameOf(args.path) || args.path || "file",
        stat: n > 0 ? `${n} lines` : undefined,
      };
    }
    case "use_skill": {
      const skillName = String(args.name || args.skill || details?.skill || "").trim();
      return {
        icon: "lucide:sparkles",
        verb: u.result ? "Loaded skill" : "Loading skill",
        target: skillName || "skill",
        stat: args.once ? "this turn" : undefined,
      };
    }
    case "todo":
    case "todowrite": {
      const items = extractTodoItems(args, res, details);
      const total = items.length > 0 ? items.length : Number(details?.total || 0);
      const done = items.length > 0
        ? items.filter((it) => it.status === "completed").length
        : Number(details?.done || 0);
      const activeItem = items.find((it) => it.status === "in_progress");
      const rawTarget = activeItem?.text
        ? activeItem.text
        : total > 0 && done === total
          ? "All tasks completed"
          : "Task plan";
      return {
        icon: "lucide:list-todo",
        verb: u.result ? "Updated plan" : "Updating plan",
        target: rawTarget.length > 80 ? rawTarget.slice(0, 80) + "…" : rawTarget,
        stat: total > 0 ? `${done}/${total} done` : undefined,
      };
    }
    case "todoread": {
      const items = extractTodoItems(args, res, details);
      const total = items.length > 0 ? items.length : Number(details?.total || 0);
      const done = items.length > 0
        ? items.filter((it) => it.status === "completed").length
        : Number(details?.done || 0);
      const activeItem = items.find((it) => it.status === "in_progress");
      const rawTarget = activeItem?.text ? activeItem.text : "Task plan";
      return {
        icon: "lucide:list-checks",
        verb: u.result ? "Checked plan" : "Checking plan",
        target: rawTarget.length > 80 ? rawTarget.slice(0, 80) + "…" : rawTarget,
        stat: total > 0 ? `${done}/${total} done` : undefined,
      };
    }
    case "widget_set": {
      const id = resolveWidgetId(args, details);
      const srcFile = args.src_file ? (baseNameOf(String(args.src_file)) || String(args.src_file)) : "";
      if (args.delete || details?.deleted) {
        return {
          icon: "lucide:trash-2",
          verb: u.result ? "Deleted widget" : "Deleting widget",
          target: id || "widget",
        };
      }
      const target = id && srcFile ? `${id} ← ${srcFile}` : (id || srcFile || "widget");
      const content = String(args.content || "");
      const totalLines = Number(details?.total_lines || 0) || (content ? content.split("\n").length : 0);
      const lintFailed = details?.lint_ok === false || details?.lint?.ok === false || /LINT FAILED:/i.test(res);
      const st = details?.diff ? diffStat(String(details.diff)) : { add: 0, del: 0 };
      return {
        icon: lintFailed ? "lucide:shield-alert" : "lucide:layout-template",
        verb: !u.result ? "Saving widget" : srcFile ? "Imported widget" : "Saved widget",
        target,
        ...(lintFailed
          ? { stat: "lint failed" }
          : st.add > 0 || st.del > 0
            ? { statAdd: st.add, statDel: st.del }
            : totalLines > 0
              ? { stat: `${totalLines} line${totalLines === 1 ? "" : "s"}` }
              : {}),
      };
    }
    case "widget_read": {
      const id = resolveWidgetId(args, details) || "widget";
      const off = Math.max(1, Number(args.offset || details?.start_line || 1));
      const lines = res ? res.split("\n").length : Number(details?.total_lines || 0);
      const lim = Number(args.limit || 0);
      const end = lim > 0 ? off + lim - 1 : (lines > 0 ? off + lines - 1 : 0);
      const hasRange = end > 0 || Boolean(args.offset) || Boolean(args.limit);
      return {
        icon: "lucide:code-2",
        verb: "Read widget",
        target: hasRange ? `${id}#L${off}-${Math.max(end, off)}` : id,
      };
    }
    case "widget_edit": {
      const id = resolveWidgetId(args, details) || "widget";
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const fromResult = diffStat(String(details?.display ?? details?.diff ?? res));
      const st = fromResult.add > 0 || fromResult.del > 0 ? fromResult : editsLineStat(edits);
      return {
        icon: "lucide:file-diff",
        verb: u.result ? "Edited widget" : "Editing widget",
        target: id,
        ...(st.add > 0 || st.del > 0
          ? { statAdd: st.add, statDel: st.del }
          : edits.length > 0
            ? { stat: `${edits.length} edit${edits.length === 1 ? "" : "s"}` }
            : {}),
      };
    }
    case "widget_list": {
      const total = typeof details?.total === "number"
        ? details.total
        : (() => {
            const m = /^widgets \((\d+) entr/m.exec(res);
            return m ? Number(m[1]) : null;
          })();
      return {
        icon: "lucide:layout-grid",
        verb: "Listed",
        target: "widgets",
        stat: total !== null ? `${total} widget${total === 1 ? "" : "s"}` : undefined,
      };
    }
    case "widget_lint": {
      const id = resolveWidgetId(args, details) || "widget";
      const lint = details?.lint;
      const failed = details?.lint_ok === false || lint?.ok === false || /LINT FAILED:/i.test(res);
      const skipped = Boolean(lint?.skipped || /lint skipped/i.test(res));
      const errCount = Array.isArray(lint?.errors)
        ? lint.errors.length
        : (() => {
            const m = /LINT FAILED:.*\((\d+)\s+error/i.exec(res);
            return m ? Number(m[1]) : 0;
          })();
      const dur = typeof lint?.durationMs === "number"
        ? lint.durationMs
        : (() => {
            const m = /LINT OK:.*\((\d+)ms\)/i.exec(res);
            return m ? Number(m[1]) : null;
          })();
      return {
        icon: failed ? "lucide:shield-alert" : "lucide:shield-check",
        verb: !u.result ? "Linting widget" : failed ? "Lint failed" : "Linted widget",
        target: id,
        stat: !u.result
          ? undefined
          : skipped
            ? "skipped"
            : failed
              ? (errCount > 0 ? `${errCount} error${errCount === 1 ? "" : "s"}` : "failed")
              : dur !== null
                ? `${dur}ms`
                : "passed",
      };
    }
    case "summary": {
      const snippet = typeof args.for_user === "string" ? args.for_user.replace(/\s+/g, " ").trim() : "";
      return {
        icon: "lucide:milestone",
        verb: "Summary",
        target: snippet ? (snippet.length > 80 ? snippet.slice(0, 80) + "…" : snippet) : "Progress checkpoint",
      };
    }
    case "finish_entire_request": {
      const snippet = typeof args.final_message_to_user === "string"
        ? args.final_message_to_user.replace(/\s+/g, " ").trim()
        : "";
      return {
        icon: "lucide:check-circle-2",
        verb: "Completed",
        target: snippet ? (snippet.length > 80 ? snippet.slice(0, 80) + "…" : snippet) : "Final response",
      };
    }
    case "session_history": {
      const { cleanRes, mergedDetails } = unwrapToolSummaryInput(res, details);
      const view = parseSessionHistoryView(args, cleanRes, mergedDetails);
      if (view.action === "recall") {
        const rawTarget = view.blockId
          ? view.startMsg !== undefined
            ? `era ${view.blockId} (msgs #${view.startMsg}–#${view.endMsg ?? view.startMsg})`
            : `era ${view.blockId}`
          : view.startMsg !== undefined
            ? view.endMsg !== undefined && view.endMsg !== view.startMsg
              ? `msgs #${view.startMsg}–#${view.endMsg}`
              : `msg #${view.startMsg}`
            : "transcript";
        const stat =
          u.result && !u.result.isError
            ? view.truncated
              ? "paginated"
              : view.totalChars && view.totalChars > 0
                ? compactCharCount(view.totalChars)
                : undefined
            : undefined;
        return {
          icon: "lucide:history",
          verb: u.result ? "Recalled history" : "Recalling history",
          target: rawTarget.length > 90 ? rawTarget.slice(0, 90) + "…" : rawTarget,
          ...(stat ? { stat } : {}),
        };
      }
      const q = view.query.replace(/\s+/g, " ").trim();
      const rawTarget = q || "transcript";
      const stat =
        u.result && !u.result.isError && view.hitCountKnown
          ? `${view.hitCount} ${view.hitCount === 1 ? "match" : "matches"}`
          : undefined;
      return {
        icon: "lucide:history",
        verb: u.result ? "Searched history" : "Searching history",
        target: rawTarget.length > 90 ? rawTarget.slice(0, 90) + "…" : rawTarget,
        ...(stat ? { stat } : {}),
      };
    }
    case "explore": {
      const { cleanRes, mergedDetails } = unwrapToolSummaryInput(res, details);
      const view = parseExploreView(args, cleanRes, mergedDetails);
      const task = view.task.replace(/\s+/g, " ").trim();
      const turns = view.turns ?? 0;
      const calls = view.toolCalls ?? 0;
      const stat =
        u.result && !u.result.isError && turns > 0
          ? calls > 0
            ? `${turns} ${turns === 1 ? "turn" : "turns"} · ${calls} ${calls === 1 ? "call" : "calls"}`
            : `${turns} ${turns === 1 ? "turn" : "turns"}`
          : undefined;
      return {
        icon: "lucide:compass",
        verb: u.result ? "Explored" : "Exploring",
        target: task ? (task.length > 90 ? task.slice(0, 90) + "…" : task) : "codebase",
        ...(stat ? { stat } : {}),
      };
    }
    default: {
      // Result without its call (a late or replayed tool_result): label it as
      // a result and let the body carry the text. The target repeats the
      // daemon's command label when it knows one; never echo body lines.
      if (!u.call?.toolName) {
        const env = details?.env || {};
        return { icon: "lucide:file-text", verb: "Result", target: String(env.command || "") };
      }
      return { icon: "lucide:wrench", verb: name, target: "" };
    }
  }
}

/** bg_await rows are header-only in every state: while the timer runs the
 * live remaining counter renders in the label, and once the result lands
 * ("Woken early …" / "Timed out …") the header summary carries the outcome.
 * No body and no chevron, ever. Single source of truth for the row model
 * and the body gate — they must agree, or expanding a bg_await shows an
 * empty body. */
export function isHeaderOnlySleep(toolName: string, _hasResult: boolean): boolean {
  return toolName === "bg_await";
}

/** Determines if a chat message marks the beginning of an agent turn.
 * User messages initiate a turn by default, unless explicitly marked
 * as a mid-turn follow-up (midTurn: true or isTurnStart: false). */
export function isTurnStartMessage(msg: ChatMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.isTurnStart === "boolean") return msg.isTurnStart;
  if (msg.midTurn) return false;
  return true;
}

/** Anchors per-turn file change balloons (both live changes of the current
 * turn and persistent changes of finished turns) to the final block of
 * their corresponding turn. If subsequent turns exist, the balloon sits
 * right above the next turn's initiating message; for the latest turn,
 * it sits at the bottom of the active conversation. */
export function mapBalloonsToBlocks(
  blocks: (RenderBlock & { id?: string })[],
  balloons: TurnBalloon[],
  oldestLoadedTurn = 0,
): Map<string, TurnBalloon[]> {
  const result = new Map<string, TurnBalloon[]>();
  if (!blocks || blocks.length === 0) return result;

  // Pagination frontier: committed balloons of turns below the oldest
  // loaded turn are not rendered yet — hide them instead of pinning
  // them onto the nearest visible block (that fallback stays for
  // pruned/compacted turns AT or ABOVE the frontier). Live balloons
  // always show (current turn). 0/undefined = everything loaded.
  const validBalloons = (balloons || []).filter((b) => {
    if ((b.files?.length || 0) === 0) return false;
    if (b.live) return true;
    const tIdx = typeof b.turnIndex === "number" ? b.turnIndex : 0;
    if (oldestLoadedTurn > 0 && tIdx > 0 && tIdx < oldestLoadedTurn) return false;
    return true;
  });
  if (validBalloons.length === 0) return result;

  // Deduplicate by turnIndex: finished balloon (live === false) supersedes live balloon
  const byTurn = new Map<number, TurnBalloon>();
  for (const b of validBalloons) {
    const existing = byTurn.get(b.turnIndex);
    if (!existing || (existing.live && !b.live)) {
      byTurn.set(b.turnIndex, b);
    }
  }
  const turnBalloons = Array.from(byTurn.values());

  let currentTurn = 0;
  const lastBlockOfTurn = new Map<number, string>();
  // Highest daemon-stamped turn seen: separates "turn not rendered yet"
  // (attach at the end) from "turn gone" (attach at nearest older turn).
  let maxStampedTurn = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockId = (block as any).id || block.msg.id;
    // Prefer the daemon-stamped session turn sequence carried on every
    // message; fall back to counting visible user bubbles only for
    // unstamped (legacy) messages.
    const stamped = typeof block.msg.turnIndex === "number" && block.msg.turnIndex > 0 ? block.msg.turnIndex : 0;
    if (stamped > 0) {
      currentTurn = stamped;
      if (stamped > maxStampedTurn) maxStampedTurn = stamped;
      lastBlockOfTurn.set(stamped, blockId);
    } else {
      if (isTurnStartMessage(block.msg)) {
        currentTurn++;
      }
      const tIdx = currentTurn > 0 ? currentTurn : 1;
      lastBlockOfTurn.set(tIdx, blockId);
    }
  }

  const lastBlockId = (blocks[blocks.length - 1] as any).id || blocks[blocks.length - 1].msg.id;
  const firstBlockId = (blocks[0] as any).id || blocks[0].msg.id;

  for (const b of turnBalloons) {
    const tIdx = typeof b.turnIndex === "number" && b.turnIndex > 0 ? b.turnIndex : 1;
    let targetId = lastBlockOfTurn.get(tIdx);

    if (!targetId) {
      if (tIdx > maxStampedTurn) {
        // Turn not rendered yet (live/current): pin to the end.
        targetId = lastBlockId;
      } else {
        // Turn gone (pruned/compacted): walk back to the nearest older
        // rendered turn instead of piling onto the first block.
        for (let t = tIdx - 1; t >= 1 && !targetId; t--) {
          targetId = lastBlockOfTurn.get(t);
        }
        targetId = targetId || firstBlockId;
      }
    }

    if (targetId) {
      const existing = result.get(targetId);
      if (existing) {
        existing.push(b);
        existing.sort((x, y) => x.turnIndex - y.turnIndex);
      } else {
        result.set(targetId, [b]);
      }
    }
  }

  return result;
}
