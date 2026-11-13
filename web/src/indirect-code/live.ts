import type { ChatMessage, ContentBlock } from "./types";

// Read complete characters from a streamed JSON string without guessing a
// missing escape or displaying the raw JSON around the tool's file content.
function partialString(raw: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let i = start + 1;
  for (; i < raw.length; i++) {
    if (raw[i] === '"') { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return undefined; } }
    if (raw[i] === "\\") {
      if (i + 1 >= raw.length) break;
      if (raw[i + 1] === "u") { if (!/^[0-9a-f]{4}$/i.test(raw.slice(i + 2, i + 6))) break; i += 5; }
      else i++;
    }
  }
  try { return JSON.parse(raw.slice(start, i) + '"'); } catch { return undefined; }
}

export function displayToolArgs(raw?: string): Record<string, any> {
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : {}; } catch { /* incomplete argument stream */ }
  const values: Record<string, any> = { _raw: raw };
  for (const field of ["path", "command", "code", "script", "content", "pattern", "old_text", "new_text"]) {
    const text = partialString(raw, field);
    if (text !== undefined) values[field] = text;
  }
  if (values.old_text !== undefined || values.new_text !== undefined) values.edits = [{old_text:values.old_text || "", new_text:values.new_text || ""}];
  return values;
}
export const SIGNAL_TOOL_NAMES = new Set(["todo", "finish_entire_request", "summary"]);
export const COMPLETION_TOOL_NAMES = new Set(["finish_entire_request"]);

/** Prefix of the daemon's summary-gate tool refusals (core.SummaryGateBlockPrefix).
 * Kept in sync with indirect-code-daemon/packages/core/agent.go. */
export const SUMMARY_GATE_BLOCK_PREFIX =
  "Blocked: a progress summary is required first. Other tools are on hold until the progress summary is recorded.";

/** Prefix of the daemon's ephemeral skill-deactivation notice
 * (skillNoticeMessage in indirect-code-daemon/cmd/daemon/skill_prefix.go). */
export const SKILL_DEACTIVATION_NOTICE_PREFIX = "[system notice] The user deactivated the skill ";

/** Detects synthetic system prompt nudges. Transcript-real (sent to the provider)
 * but never shown as a user bubble in the chat UI. */
export function isSyntheticNudge(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>")) ||
    (trimmed.startsWith("<system_prompt>") && trimmed.endsWith("</system_prompt>")) ||
    (trimmed.startsWith("<system-warn>") && trimmed.endsWith("</system-warn>")) ||
    trimmed.startsWith(SKILL_DEACTIVATION_NOTICE_PREFIX) ||
    trimmed.startsWith(SUMMARY_GATE_BLOCK_PREFIX)
  );
}

export function sanitizeUserText(text: string): string {
  let res = text;
  for (const tag of ["system-reminder", "system_prompt", "system-warn"]) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const trimmed = res.trim();
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
      res = trimmed.slice(open.length, -close.length).trim();
    } else if (res.includes(open) || res.includes(close)) {
      res = res.replaceAll(open, "").replaceAll(close, "").trim();
    }
  }
  return res;
}

/** Strips a leading <system-reminder>...</system-reminder>, <system_prompt>...</system_prompt>,
 * or <system-warn>...</system-warn> block from a user message so the chat UI displays only the user's actual text. */
export function stripLeadingSystemPrompt(text: string): string {
  const trimmed = text.trim();
  for (const tag of ["<system-reminder>", "<system_prompt>", "<system-warn>"]) {
    const closeTag = tag.replace("<", "</");
    if (trimmed.startsWith(tag)) {
      const endIdx = trimmed.indexOf(closeTag);
      if (endIdx !== -1) {
        return trimmed.slice(endIdx + closeTag.length).trim();
      }
    }
  }
  return text;
}

export function withoutContinueNudges(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => {
    if (m.role !== "user") return true;
    const text = m.blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return !isSyntheticNudge(text);
  });
}
interface TodoActivityPassthroughEntry {
  kind: "passthrough";
  toolResultIds: string[];
}

interface TodoActivityTransformedEntry {
  kind: "transformed";
  depCallIds: string[];
  depResults: (ContentBlock | undefined)[];
  otherResultIds: string[];
  otherResultInIds: boolean[];
  out: ChatMessage | null;
}

type TodoActivityCacheEntry = TodoActivityPassthroughEntry | TodoActivityTransformedEntry;

const todoActivityCache = new WeakMap<ChatMessage, TodoActivityCacheEntry>();

/** Keep canonical messages untouched. Signal calls and results are always
 * internal; only successful summaries/completions become user-facing text. */
export function withoutTodoActivity(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];

  const ids = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const blocks = messages[i].blocks;
    for (let j = 0; j < blocks.length; j++) {
      const b = blocks[j];
      if (b.type === "tool_call" && b.toolName && SIGNAL_TOOL_NAMES.has(b.toolName) && b.toolId) {
        ids.add(b.toolId);
      }
    }
  }

  const signalResults = new Map<string, ContentBlock>();
  if (ids.size > 0) {
    for (let i = 0; i < messages.length; i++) {
      const blocks = messages[i].blocks;
      for (let j = 0; j < blocks.length; j++) {
        const block = blocks[j];
        if (block.type === "tool_result" && block.toolId && ids.has(block.toolId)) {
          signalResults.set(block.toolId, block);
        }
      }
    }
  }

  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const cached = todoActivityCache.get(message);
    if (cached) {
      if (cached.kind === "passthrough") {
        let valid = true;
        if (ids.size > 0) {
          for (let k = 0; k < cached.toolResultIds.length; k++) {
            if (ids.has(cached.toolResultIds[k])) {
              valid = false;
              break;
            }
          }
        }
        if (valid) {
          result.push(message);
          continue;
        }
      } else {
        let valid = true;
        for (let k = 0; k < cached.depCallIds.length; k++) {
          const id = cached.depCallIds[k];
          const curRes = id ? signalResults.get(id) : undefined;
          if (curRes !== cached.depResults[k]) {
            valid = false;
            break;
          }
        }
        if (valid) {
          for (let k = 0; k < cached.otherResultIds.length; k++) {
            if (ids.has(cached.otherResultIds[k]) !== cached.otherResultInIds[k]) {
              valid = false;
              break;
            }
          }
        }
        if (valid) {
          if (cached.out) result.push(cached.out);
          continue;
        }
      }
    }

    let hadCompletion = message.hasCompletion || false;
    let hadSummary = message.hasSummary || false;
    let mutated = false;
    const newBlocks: ContentBlock[] = [];
    const depCallIds: string[] = [];
    const depResults: (ContentBlock | undefined)[] = [];
    const otherResultIds: string[] = [];
    const otherResultInIds: boolean[] = [];

    for (let j = 0; j < message.blocks.length; j++) {
      const b = message.blocks[j];
      if (b.type === "tool_call" && b.toolName && COMPLETION_TOOL_NAMES.has(b.toolName)) {
        mutated = true;
        const callId = b.toolId || "";
        const resBlock = callId ? signalResults.get(callId) : undefined;
        depCallIds.push(callId);
        depResults.push(resBlock);
        if (!resBlock || resBlock.isError) continue;
        hadCompletion = true;
        let summaryText = "";
        try {
          const parsed = JSON.parse(b.toolArgs || "{}");
          const candidate = parsed?.final_message_to_user;
          summaryText = typeof candidate === "string" ? candidate : "";
        } catch {}
        if (summaryText.trim()) {
          const trimmed = summaryText.trim();
          if (
            !newBlocks.some((existing) => existing.type === "text" && existing.text?.trim() === trimmed) &&
            !message.blocks.some((existing) => existing.type === "text" && existing.text?.trim() === trimmed)
          ) {
            newBlocks.push({ type: "text", text: trimmed });
          }
        }
        continue;
      }
      if (b.type === "tool_call" && b.toolName === "summary") {
        mutated = true;
        const callId = b.toolId || "";
        const resBlock = callId ? signalResults.get(callId) : undefined;
        depCallIds.push(callId);
        depResults.push(resBlock);
        if (!resBlock || resBlock.isError) continue;
        hadSummary = true;
        let forUser = "";
        try {
          const parsed = JSON.parse(b.toolArgs || "{}");
          forUser = typeof parsed?.for_user === "string" ? parsed.for_user : "";
        } catch {}
        if (forUser.trim()) {
          const trimmed = forUser.trim();
          if (
            !newBlocks.some((existing) => existing.type === "text" && existing.text?.trim() === trimmed) &&
            !message.blocks.some((existing) => existing.type === "text" && existing.text?.trim() === trimmed)
          ) {
            newBlocks.push({ type: "text", text: trimmed });
          }
        }
        continue;
      }
      if (b.type === "tool_call" || b.type === "tool_result") {
        const isNamedSignal = Boolean(b.toolName && SIGNAL_TOOL_NAMES.has(b.toolName));
        if (isNamedSignal) {
          mutated = true;
          continue;
        }
        if (b.toolId) {
          const inIds = ids.has(b.toolId);
          otherResultIds.push(b.toolId);
          otherResultInIds.push(inIds);
          if (inIds) {
            mutated = true;
            continue;
          }
        }
      }
      newBlocks.push(b);
    }

    if (!mutated) {
      todoActivityCache.set(message, {
        kind: "passthrough",
        toolResultIds: otherResultIds,
      });
      result.push(message);
      continue;
    }

    let out: ChatMessage | null = null;
    if (!(newBlocks.length === 0 && message.blocks.length > 0) && !newBlocks.every((b) => b.type === "text" && !b.text?.trim())) {
      out = { ...message, blocks: newBlocks, hasCompletion: hadCompletion, hasSummary: hadSummary };
    }
    todoActivityCache.set(message, {
      kind: "transformed",
      depCallIds,
      depResults,
      otherResultIds,
      otherResultInIds,
      out,
    });
    if (out) result.push(out);
  }

  return result;
}
