/**
 * Universal request profile (IR): per-upstream-target normalization rules.
 *
 * Thesis: protocol equality does NOT imply semantic equality. Anthropic from
 * provider XYZ is a different *dialect* than Anthropic from provider ABC
 * (id formats, supported blocks, output-limit names, temperature policy).
 * So EVERY attempt — including same-protocol ("passthrough") ones — goes
 * through normalizeForTarget(): parse to a canonical shape, apply the
 * target's profile rules, serialize for the wire. Fixes live here, once,
 * instead of scattered across point-to-point bridges.
 *
 * Design notes:
 * - Profiles are DERIVED from data the gateway already has (base URLs,
 *   strip_params blocklist, model id heuristics). No new DB columns, no
 *   migration, no admin UI changes: existing providers get sane defaults,
 *   and strip_params keeps working as the manual override escape hatch.
 * - Normalization is idempotent and conservative: bodies that already
 *   comply are returned untouched (same object reference), so well-behaved
 *   providers see byte-identical payloads to before.
 * - compactToolIds() lives HERE (moved from the deleted pairwise bridge);
 *   the profile decides WHEN it applies (strict targets), the function
 *   decides HOW.
 */

import type { Proto } from "../db";

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const MAX_TOOL_ID_LENGTH = 64;

/** Strict OpenAI-compatible upstreams (openai.com) reject `tool_calls[].id`
 *  longer than 64 chars (`string_above_max_length`). Foreign ids replayed
 *  mid-conversation (failover/model-swap, accumulated prefixes) can exceed
 *  that, so the gateway compacts over-long ids per attempt: `tc1`, `tc2`, …
 *  in first-seen order, applied consistently to the call and its result.
 *  Ids within the limit pass through untouched (byte-fidelity rule stands
 *  for every well-behaved provider).
 *
 *  `maxLen` is the target's accepted cap (profile.maxToolIdLength);
 *  `Infinity` (or any non-finite value) disables compaction entirely.
 *  Never mutates the input: failover reuses one body across attempts, so
 *  each attempt gets its own containers and the caller's stays intact. */
export function compactToolIds(
  body: Record<string, unknown>,
  maxLen: number = MAX_TOOL_ID_LENGTH,
): Record<string, unknown> {
  if (!Number.isFinite(maxLen)) return body;
  const map = new Map<string, string>();
  let seq = 0;
  // Reserve existing ids before allocating replacements, including results
  // that precede their calls in the input.
  const reserved = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    for (const [key, child] of Object.entries(value)) {
      if (["id", "call_id", "tool_call_id", "tool_use_id"].includes(key) && typeof child === "string") reserved.add(child);
      else visit(child);
    }
  };
  visit(body);
  const short = (id: unknown): unknown => {
    if (typeof id !== "string") return id;
    const known = map.get(id);
    if (known) return known;
    if (id.length <= maxLen) return id;
    do { seq += 1; } while (reserved.has(`tc${seq}`));
    const replacement = `tc${seq}`;
    reserved.add(replacement);
    map.set(id, replacement);
    return replacement;
  };
  // Copy-on-write: rebuild only the arrays/objects whose ids changed.
  // Unchanged siblings keep their exact references (and the whole body is
  // returned as-is when nothing needed a shorter id).
  const compactArray = (items: unknown[], compact: (item: unknown) => unknown): unknown[] | null => {
    let next: unknown[] | null = null;
    items.forEach((item, idx) => {
      const compacted = compact(item);
      if (compacted === item) return;
      if (!next) next = [...items];
      next[idx] = compacted;
    });
    return next;
  };
  // Chat + Anthropic-messages shapes share role/message layout; Responses
  // `input` items carry the same ids under different keys.
  const compactMessage = (raw: unknown): unknown => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const m = raw as Record<string, unknown>;
    let next: Record<string, unknown> | null = null;
    const replace = (key: string, value: unknown): void => {
      if (!next) next = { ...m };
      next[key] = value;
    };
    if (m.role === "assistant") {
      const calls = m.tool_calls;
      if (Array.isArray(calls)) {
        const compacted = compactArray(calls, (rawCall) => {
          const tc = asRecord(rawCall);
          if (!("id" in tc)) return rawCall;
          const id = short(tc.id);
          return id === tc.id ? rawCall : { ...tc, id };
        });
        if (compacted) replace("tool_calls", compacted);
      }
      const blocks = m.content;
      if (Array.isArray(blocks)) {
        const compacted = compactArray(blocks, (rawBlock) => {
          const block = asRecord(rawBlock);
          if (block.type !== "tool_use" || !("id" in block)) return rawBlock;
          const id = short(block.id);
          return id === block.id ? rawBlock : { ...block, id };
        });
        if (compacted) replace("content", compacted);
      }
    } else if (m.role === "tool" && "tool_call_id" in m) {
      const id = short(m.tool_call_id);
      if (id !== m.tool_call_id) replace("tool_call_id", id);
    } else {
      const blocks = m.content;
      if (Array.isArray(blocks)) {
        const compacted = compactArray(blocks, (rawBlock) => {
          const block = asRecord(rawBlock);
          if (block.type !== "tool_result" || !("tool_use_id" in block)) return rawBlock;
          const id = short(block.tool_use_id);
          return id === block.tool_use_id ? rawBlock : { ...block, tool_use_id: id };
        });
        if (compacted) replace("content", compacted);
      }
    }
    return next ?? raw;
  };
  let out: Record<string, unknown> | null = null;
  const messages = body.messages;
  if (Array.isArray(messages)) {
    const compacted = compactArray(messages, compactMessage);
    if (compacted) out = { ...body, messages: compacted };
  }
  const input = body.input;
  if (Array.isArray(input)) {
    const compacted = compactArray(input, (rawItem) => {
      const item = asRecord(rawItem);
      if (!("call_id" in item)) return rawItem;
      const id = short(item.call_id);
      return id === item.call_id ? rawItem : { ...item, call_id: id };
    });
    if (compacted) out = { ...(out ?? body), input: compacted };
  }
  return out ?? body;
}
/** Per-target normalization profile: what THIS upstream attempt accepts. */
export interface TargetProfile {
  /** Forward the `reasoning_effort` hint (MuseSpark-class models need it to
   *  terminate; others ignore unknown keys or have it stripped below). */
  forwardReasoningEffort: boolean;
  /** Max accepted tool-call id length (strict OpenAI-likes: 64). Above this,
   *  ids are compacted to tc1, tc2, … per attempt. Infinity = no cap. */
  maxToolIdLength: number;
  /** Output-limit key the target accepts on chat bodies. Strict new models
   *  (gpt-5.6-luna class) take only `max_completion_tokens`; legacy models
   *  take only `max_tokens`. "both" is never emitted: strict upstreams 400
   *  on the unknown sibling either way. */
  outputLimitKey: "max_completion_tokens" | "max_tokens";
  /** Anthropic `temperature` policy on translated requests: reasoning-only
   *  models 400 non-default values, so only `1` (the default) is forwarded. */
  temperaturePolicy: "drop-non-default" | "pass";
  /** Block types that must be dropped when rendering for this target
   *  (Anthropic-dialect targets that never implemented them, e.g.
   *  citations/document/mcp on narrow providers). Names are the Anthropic
   *  content-block `type` values. Empty = keep everything. */
  dropBlockTypes: string[];
}

/** Conservative default: classic `max_tokens` (portable chat name),
 *  cap ids at 64 (the strictest known upstream limit — harmless for
 *  providers without the cap since compacted ids are still valid ids).
 *  Strict upstreams (luna class) are renamed per attempt by
 *  profileForTarget; unknown-param-strict upstreams (Meta chat rejects
 *  `max_completion_tokens`) accept the classic name as-is. */
export const DEFAULT_PROFILE: TargetProfile = {
  forwardReasoningEffort: true,
  maxToolIdLength: 64,
  outputLimitKey: "max_tokens",
  temperaturePolicy: "drop-non-default",
  dropBlockTypes: [],
};

export interface ProfileSource {
  openai_base_url?: string | null;
  anthropic_base_url?: string | null;
  responses_base_url?: string | null;
  strip_params?: unknown;
  /** Egress capability of this attempt (selects the API family from the
   *  matching base URL). The caller in server/proxy/index.ts sets it per
   *  attempt; defaults to "openai" when omitted. */
  via?: WireProto;
  /** Upstream model id for this attempt. ONLY model-level exceptions live
   *  here (a model that defies its own API's rules) — the API family from
   *  `via` + base URLs owns every rule. */
  upstreamModel?: string;
}

/** Derive a target profile: the API family (from `via` + base URLs) owns
 *  every rule; the model id contributes ONLY documented exceptions (a
 *  model that defies its own API). Live A/B 2026-09-22: the "luna"
 *  strictness (max_tokens/temperature 400s) belongs to api.openai.com —
 *  the same luna via OpenRouter accepts both — so strictness moved to the
 *  `openai` family and the model check below is a backstop for custom
 *  OpenAI-compatible bases that behave strictly. */
export function profileForTarget(src: ProfileSource): TargetProfile {
  const profile: TargetProfile = { ...DEFAULT_PROFILE, dropBlockTypes: [] };
  const via: WireProto = src.via ?? "openai";
  const base =
    via === "responses" ? src.responses_base_url : via === "anthropic" ? src.anthropic_base_url : src.openai_base_url;
  const family = apiFamilyForBaseUrl(base);
  const model = (src.upstreamModel ?? "").toLowerCase();
  if (family === "openai") {
    // api.openai.com: strict output-limit name + default temperature only.
    // (Detected live: max_tokens -> 400 unsupported_parameter;
    // temperature 0.5 -> 400 unsupported_value; same luna via OpenRouter
    // accepts both, so this is API behavior, not model behavior.)
    profile.outputLimitKey = "max_completion_tokens";
    profile.temperaturePolicy = "drop-non-default";
  } else if (family === "meta") {
    // api.meta.ai: strict classic — max_tokens only (the modern name is
    // an unknown parameter), mutually-exclusive pair is deduped by
    // applyOutputLimitKey regardless of family.
    profile.outputLimitKey = "max_tokens";
  }
  // Model-level EXCEPTION (backstop): a strictly-behaving custom
  // OpenAI-compatible base serving a luna-class model still gets the
  // strict rule even though the family is unknown.
  if (family !== "openai" && family !== "openrouter" && model.includes("luna")) {
    profile.outputLimitKey = "max_completion_tokens";
    profile.temperaturePolicy = "drop-non-default";
  }
  // NOTE (corrected by live A/B 2026-09-22): an earlier revision stripped
  // `reasoning_effort` for glm/z-ai targets, assuming it caused infinite
  // thinking. A controlled A/B on z-ai/glm-5.3-flash proved the opposite —
  // WITHOUT effort: 4000/4000 reasoning, finish:length, zero text (28s);
  // WITH effort:"low": finish:stop, 3388 chars of code, 0 reasoning (8s).
  // So effort is FORWARDED (including the IR default "high").
  return profile;
}

/** True when the upstream model accepts a Responses `reasoning` object
 *  (reasoning families only — gpt-4o-mini class 400s it). */
export function isReasoningTarget(upstreamModel: string): boolean {
  const m = upstreamModel.toLowerCase();
  return (
    m.includes("luna") ||
    m.includes("muse-spark") ||
    m.includes("muse-spark") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4") ||
    m.includes("reasoner") ||
    m.includes("thinking") ||
    m.includes("reasoning") ||
    m.includes("deepseek") ||
    m.includes("qwen") ||
    m.includes("kimi") ||
    m.includes("glm") ||
    m.includes("grok") ||
    m.includes("gemini") ||
    m.includes("claude") ||
    m.includes("gpt-5")
  );
}

/** Rename the Anthropic output-limit key to the target's accepted name.
 *  Returns the same object when already compliant (or absent). Both keys
 *  present is a hard 400 upstream (Meta: "mutually exclusive") — drop the
 *  legacy one whenever the modern one exists, whatever the target key. */
export function applyOutputLimitKey(
  body: Record<string, unknown>,
  key: TargetProfile["outputLimitKey"],
): Record<string, unknown> {
  const legacy = body.max_tokens;
  const modern = body.max_completion_tokens;
  if (typeof modern === "number" && typeof legacy === "number") {
    const { max_tokens: _drop, ...rest } = body;
    if (key === "max_completion_tokens") return rest;
    const { max_completion_tokens: _modern, ...withoutLimits } = rest;
    return { ...withoutLimits, max_tokens: modern };
  }
  if (key === "max_completion_tokens") {
    if (typeof legacy === "number" && typeof modern !== "number") {
      const { max_tokens: _drop, ...rest } = body;
      return { ...rest, max_completion_tokens: legacy };
    }
    return body;
  }
  if (typeof modern === "number" && typeof legacy !== "number") {
    const { max_completion_tokens: _drop, ...rest } = body;
    return { ...rest, max_tokens: modern };
  }
  return body;
}

/** Drop non-portable Anthropic content blocks for narrow targets.
 *  Returns the same object when nothing matches (or no messages). */
export function applyBlockFilter(body: Record<string, unknown>, dropTypes: string[]): Record<string, unknown> {
  if (dropTypes.length === 0) return body;
  const drop = new Set(dropTypes);
  let changed = false;
  const filterBlocks = (blocks: unknown[]): unknown[] => {
    const kept = blocks.filter((b) => !drop.has(asRecord(b).type as string));
    if (kept.length !== blocks.length) {
      changed = true;
      return kept;
    }
    return blocks;
  };
  for (const m of asArr(body.messages)) {
    const msg = asRecord(m);
    const content = msg.content;
    if (Array.isArray(content)) {
      const kept = filterBlocks(content);
      if (kept !== content) msg.content = kept;
    }
  }
  if (!changed) return body;
  return { ...body };
}

/** True for an explicit reasoning-off value in any client dialect. */
function effortIsOff(v: unknown): boolean {
  return typeof v === "string" && ["off", "none", "disabled"].includes(v.trim().toLowerCase());
}

/**
 * Normalize ANY request body for a concrete upstream attempt — including
 * same-protocol ("passthrough") ones. This is the universal pass every
 * attempt flows through:
 *   1. output-limit key rename (max_tokens <-> max_completion_tokens),
 *   2. over-long tool-id compaction (see compactToolIds),
 *   3. non-portable block filtering for narrow targets.
 * Bodies already compliant are returned untouched (same reference).
 */
export function normalizeForTarget(
  body: Record<string, unknown>,
  profile: TargetProfile,
  upstreamModel?: string,
  via: WireProto = "openai",
): Record<string, unknown> {
  let out = via === "openai" ? applyOutputLimitKey(body, profile.outputLimitKey) : body;
  // Explicit reasoning-off is represented by ABSENCE on chat/responses
  // wires (strict upstreams reject "none" as an effort value) and by
  // thinking:{type:"disabled"} on Anthropic wires.
  if (effortIsOff(out.reasoning_effort)) {
    const { reasoning_effort: _dropOff, ...rest } = out;
    out = rest;
  }
  if (effortIsOff(asRecord(out.reasoning).effort)) {
    const { reasoning: _dropOffReasoning, ...rest } = out;
    out = rest;
  }
  if (via === "anthropic" && "output_config" in out) {
    if (effortIsOff(asRecord(out.output_config).effort)) {
      const { output_config: _dropCfg, ...rest } = out;
      out = "thinking" in rest ? rest : { ...rest, thinking: { type: "disabled" } };
    } else if (asRecord(out.thinking).type === "enabled") {
      // Dual-encoded clients (manual budget + adaptive tier): a native
      // Anthropic attempt speaks the manual form; the tier is for the
      // gateway's translated egresses and must not ride along.
      const { output_config: _dropCfg, ...rest } = out;
      out = rest;
    }
  }
  if (!profile.forwardReasoningEffort && "reasoning_effort" in out) {
    const { reasoning_effort: _drop, ...rest } = out;
    out = rest;
  }
  // `reasoning_effort` is rejected by strict non-reasoning models
  // (gpt-4o-mini class: 400 "Unrecognized request argument supplied" —
  // live 2026-09-26 on an anthropic->chat translation). Mirror the
  // `reasoning` rule below: only reasoning families keep it, whether it
  // came from the client or the IR default.
  if (via === "openai" && "reasoning_effort" in out && !isReasoningTarget(upstreamModel ?? "")) {
    const { reasoning_effort: _dropEffort, ...rest } = out;
    out = rest;
  }
  // Responses `reasoning: {effort}` is rejected by non-reasoning models
  // (gpt-4o-mini class: 400 unsupported_parameter). Only reasoning families
  // (luna, muse-spark, o-series, deepseek-reasoner, gemini-thinking, grok
  // reasoning, qwen reasoning...) accept it — default is to strip.
  if ("reasoning" in out && !isReasoningTarget(upstreamModel ?? "")) {
    const { reasoning: _drop2, ...rest } = out;
    out = rest;
  }
  // compactToolIds is itself conservative (same reference when compliant).
  // The profile owns the cap: Infinity means the target accepts any length.
  if (Number.isFinite(profile.maxToolIdLength)) {
    out = compactToolIds(out, profile.maxToolIdLength);
  }
  out = applyBlockFilter(out, profile.dropBlockTypes);
  return out;
}

/** Convenience: derive the profile and normalize in one call. */
export function normalizeAttemptBody(body: Record<string, unknown>, src: ProfileSource): Record<string, unknown> {
  return normalizeForTarget(body, profileForTarget(src), src.upstreamModel ?? undefined, src.via);
}

/** Which upstream API family serves this attempt, derived from the
 *  provider's base URL for the egress capability. Model quirks are the
 *  EXCEPTION, never the rule: live A/B (2026-09-22) proved the "luna"
 *  strictness (max_tokens/temperature 400s) belongs to api.openai.com,
 *  not to the model — the same luna via OpenRouter accepts both.
 *  Unknown/custom bases fall back to "generic" (portable defaults). */
export type ApiFamily =
  | "openai" // api.openai.com: strict (max_completion_tokens, default temperature only)
  | "openrouter" // openrouter.ai: tolerant normalizer (accepts legacy names/values)
  | "meta" // api.meta.ai: strict classic (max_tokens only, never the modern name)
  | "synthetic" // api.synthetic.new: hf: namespace, reasoning-heavy
  | "google" // generativelanguage: thought_signature rules
  | "xai" // api.x.ai: well-behaved OpenAI dialect
  | "anthropic" // api.anthropic.com: native
  | "generic";

export function apiFamilyForBaseUrl(baseUrl: string | null | undefined): ApiFamily {
  const u = (baseUrl ?? "").toLowerCase();
  if (!u) return "generic";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("api.meta.ai")) return "meta";
  if (u.includes("api.synthetic.new") || u.includes("synthetic")) return "synthetic";
  if (u.includes("generativelanguage") || u.includes("googleapis")) return "google";
  if (u.includes("api.x.ai") || u.includes("x.ai")) return "xai";
  if (u.includes("api.anthropic.com")) return "anthropic";
  return "generic";
}

/** Wire protocol of this attempt (selects the egress base URL). */
export type WireProto = Proto;

/** Egress capability of this attempt (selects the profile's API family).
 *  Defaults to "openai" — the caller in server/proxy/index.ts overrides
 *  per attempt. */
