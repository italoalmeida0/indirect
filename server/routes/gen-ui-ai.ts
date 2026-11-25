import { db, type ApiKeyRow, type RemoteHostRow } from "../db";
import { requireAuth } from "../auth";
import { ApiError, baseHeaders, clientIp, err, json, rateLimitError, readJsonBody } from "../http";
import { allowedModels, modelAllowed } from "../model-policy";
import { DEFAULT_MODEL_CONTEXT, DEFAULT_MODEL_OUTPUT, listableModels, routerSnapshot } from "../models";
import { requireKeyProject } from "../projects";
import { handleProxyWithKey } from "../proxy/index";

/**
 * Embedded AI endpoints for Generative UI widgets:
 *
 *  GET  /api/indirect-code/gen-ui/ai/models   -> allowed model catalog + effort tiers
 *  POST /api/indirect-code/gen-ui/ai/complete -> text/JSON/streaming LLM completion
 *
 * Security & billing contract:
 *  - Authenticated via the user's dashboard session (requireAuth); widgets run
 *    in an opaque-origin sandbox iframe and NEVER see API keys or direct network.
 *  - Dispatches through the gateway's real proxy pipeline (handleProxyWithKey)
 *    using the user's Indirect Code host API key (or an active user key), so
 *    USD budgets, model policy, rate/concurrency limits, failover, IR reasoning
 *    translation, and usage accounting are 100% identical to /v1/*.
 *  - Strictly text-only chat/completion: no tool definitions, no tool calls,
 *    and no daemon/filesystem access.
 */

export const GEN_UI_EFFORTS = [
  { id: "none", label: "Off", description: "Responds immediately without extended thinking" },
  { id: "minimum", label: "Min", description: "Minimal thinking for quick, routine tasks" },
  { id: "low", label: "Low", description: "Quick reasoning for everyday tasks" },
  { id: "medium", label: "Medium", description: "Balances speed and reasoning depth" },
  { id: "high", label: "High", description: "Thorough reasoning for complex problems" },
  { id: "xhigh", label: "X-High", description: "Deep multi-step reasoning for complex problems" },
  { id: "max", label: "Max", description: "Deepest reasoning for the hardest problems" },
] as const;

export type GenUiEffort = (typeof GEN_UI_EFFORTS)[number]["id"];

const EFFORT_ALIASES: Record<string, GenUiEffort> = {
  none: "none",
  off: "none",
  disabled: "none",
  minimum: "minimum",
  minimal: "minimum",
  min: "minimum",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  max: "max",
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SYSTEM_CHARS = 32 * 1024;
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_TOTAL_CHARS = 160 * 1024;
const MAX_MESSAGES = 64;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_OUTPUT_TOKENS = 8192;
const GEN_UI_AI_RPM = 60;
const SSE_PING_BYTES = new TextEncoder().encode(": ping\n\n") as Uint8Array<ArrayBuffer>;

const JSON_SYSTEM_INSTRUCTION =
  "Return ONLY valid JSON with no markdown code fences, prose, or extra commentary.";

// Dedicated per-user burst bucket for widget-initiated AI calls so a buggy
// widget loop fails fast with 429 before saturating the user's other keys.
const userAiBuckets = new Map<string, { used: number; resetAt: number }>();
const aiBucketSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of userAiBuckets) {
    if (b.resetAt <= now) userAiBuckets.delete(k);
  }
  if (userAiBuckets.size > 10_000) userAiBuckets.clear();
}, 60_000);
aiBucketSweep.unref();

function genUiAiRateHit(userId: string): number {
  const now = Date.now();
  let b = userAiBuckets.get(userId);
  if (!b || b.resetAt <= now) {
    b = { used: 0, resetAt: now + 60_000 };
    userAiBuckets.set(userId, b);
  }
  if (b.used + 1 > GEN_UI_AI_RPM) {
    return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  }
  b.used++;
  return 0;
}

/** @test-hook Clear per-user Gen-UI AI rate limiter buckets. */
export function resetGenUiAiLimiter(): void {
  userAiBuckets.clear();
}

export function normalizeGenUiEffort(raw: unknown): GenUiEffort | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return undefined;
  return EFFORT_ALIASES[raw.trim().toLowerCase()];
}

function resolveUserProxyKey(
  userId: string,
  hostId?: string,
): { ok: true; key: ApiKeyRow } | { ok: false; status: number; message: string } {
  const now = Date.now();
  if (hostId) {
    const host = db
      .prepare<Pick<RemoteHostRow, "id" | "api_key_id">, [string, string]>(
        "SELECT id, api_key_id FROM remote_hosts WHERE id = ? AND user_id = ?",
      )
      .get(hostId, userId);
    if (!host) {
      return { ok: false, status: 404, message: "host not found" };
    }
    if (host.api_key_id) {
      const hostKey = db
        .prepare<ApiKeyRow, [string, string]>(
          "SELECT * FROM api_keys WHERE id = ? AND user_id = ?",
        )
        .get(host.api_key_id, userId);
      // Hand the host's key directly to the proxy even if revoked/exhausted so
      // budget/revocation policy on that host is enforced transparently.
      if (hostKey) return { ok: true, key: hostKey };
    }
  }

  // Fallback when hostId was omitted (or host had no bound key): prefer the
  // user's most recently active Indirect Code host key, then any active key.
  const recentHostKey = db
    .prepare<ApiKeyRow, [string, string, number]>(
      `SELECT k.* FROM remote_hosts h
       JOIN api_keys k ON k.id = h.api_key_id
       WHERE h.user_id = ? AND k.user_id = ? AND k.status = 'active'
         AND (k.expires_at IS NULL OR k.expires_at > ?)
       ORDER BY h.last_seen_at DESC, h.created_at DESC
       LIMIT 1`,
    )
    .get(userId, userId, now);
  if (recentHostKey) return { ok: true, key: recentHostKey };

  // Prefer a personal (non-project) key so omitted hostId never silently bills
  // an enterprise Financial Project or fails on an archived project when the user
  // also holds a personal key.
  const personalKey = db
    .prepare<ApiKeyRow, [string, number]>(
      `SELECT * FROM api_keys
       WHERE user_id = ? AND status = 'active' AND project_id IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(userId, now);
  if (personalKey) return { ok: true, key: personalKey };

  const projectKeys = db
    .prepare<ApiKeyRow, [string, number]>(
      `SELECT * FROM api_keys
       WHERE user_id = ? AND status = 'active' AND project_id IS NOT NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at ASC
       LIMIT 10`,
    )
    .all(userId, now);
  for (const k of projectKeys) {
    try {
      requireKeyProject(userId, k.project_id ?? null);
      return { ok: true, key: k };
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    status: 403,
    message: "Connect an Indirect Code host or create an active API key to use embedded AI.",
  };
}

interface ParsedUsage {
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function parseGatewayUsageHeader(raw: string | null): ParsedUsage | null {
  if (!raw) return null;
  const nums: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=");
    if (!k || v === undefined) continue;
    const n = Number(v.trim());
    if (Number.isFinite(n) && n >= 0) nums[k.trim()] = Math.round(n);
  }
  if (nums.in === undefined && nums.out === undefined && nums.cache === undefined) return null;
  return {
    inputTokens: nums.in ?? 0,
    cacheTokens: nums.cache ?? 0,
    outputTokens: nums.out ?? 0,
    reasoningTokens: nums.reason ?? 0,
  };
}

function parseBodyUsage(u: unknown): ParsedUsage {
  if (!u || typeof u !== "object") {
    return { inputTokens: 0, cacheTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  }
  const rec = u as Record<string, unknown>;
  const promptDetails = (rec.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const compDetails = (rec.completion_tokens_details ?? {}) as Record<string, unknown>;
  const cacheTokens = Number(promptDetails.cached_tokens ?? rec.cache_read_input_tokens ?? 0) || 0;
  const rawPrompt = Number(rec.prompt_tokens ?? rec.input_tokens ?? 0) || 0;
  // OpenAI prompt_tokens includes cached_tokens; normalize to separate input vs cache.
  const inputTokens = rec.prompt_tokens !== undefined ? Math.max(0, rawPrompt - cacheTokens) : rawPrompt;
  const outputTokens = Number(rec.completion_tokens ?? rec.output_tokens ?? 0) || 0;
  const reasoningTokens = Number(compDetails.reasoning_tokens ?? 0) || 0;
  return { inputTokens, cacheTokens, outputTokens, reasoningTokens };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (typeof part === "string") out += part;
      else if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
        out += String((part as Record<string, unknown>).text);
      }
    }
    return out;
  }
  return "";
}

function extractProxyError(status: number, bodyText: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const e = parsed?.error as Record<string, unknown> | string | undefined;
    if (e && typeof e === "object") {
      const msg = typeof e.message === "string" && e.message.trim() ? e.message.trim() : `AI request failed (HTTP ${status})`;
      const code = typeof e.code === "string" && e.code ? e.code : typeof e.type === "string" ? e.type : undefined;
      return { message: msg, code };
    }
    if (typeof e === "string" && e.trim()) return { message: e.trim() };
  } catch {}
  return { message: bodyText.trim().slice(0, 400) || `AI request failed (HTTP ${status})` };
}

function sseFrameText(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseFrame(payload: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(sseFrameText(payload)) as Uint8Array<ArrayBuffer>;
}

function streamProxyToGenUiSse(
  proxyRes: Response,
  fallbackModel: string,
  effort: GenUiEffort | undefined,
  req: Request,
): Response {
  const headers = baseHeaders(req);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Accel-Buffering", "no");

  const ct = (proxyRes.headers.get("content-type") || "").toLowerCase();
  if (!proxyRes.body) {
    const body = sseFrameText({
      type: "done",
      text: "",
      reasoning: "",
      model: fallbackModel,
      effort: effort ?? null,
      finishReason: "stop",
      usage: { inputTokens: 0, cacheTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    });
    return new Response(body, { status: 200, headers });
  }

  // Some providers ignore stream:true and reply with buffered JSON — project it
  // into the same delta + done SSE contract so clients never break.
  if (!ct.includes("text/event-stream")) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const raw = await proxyRes.text();
          const parsed = parseBufferedCompletion(raw, proxyRes.headers, fallbackModel, effort);
          if (parsed.reasoning) controller.enqueue(sseFrame({ type: "reasoning", text: parsed.reasoning }));
          if (parsed.text) controller.enqueue(sseFrame({ type: "delta", text: parsed.text }));
          controller.enqueue(sseFrame({ type: "done", ...parsed }));
        } catch (e) {
          controller.enqueue(
            sseFrame({ type: "error", error: e instanceof Error ? e.message : "AI stream failed" }),
          );
        } finally {
          try {
            controller.close();
          } catch {}
        }
      },
    });
    return new Response(stream, { status: 200, headers });
  }

  const reader = proxyRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let fullText = "";
  let fullReasoning = "";
  let modelName = fallbackModel;
  let finishReason = "stop";
  let usage: ParsedUsage = { inputTokens: 0, cacheTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let finished = false;
  let streamError: string | null = null;

  const processLine = (
    line: string,
    sink: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) return false;
    if (trimmed.startsWith(":")) {
      const m = /^:\s*x-gateway-usage\s+(.+)$/i.exec(trimmed);
      if (m) {
        const parsed = parseGatewayUsageHeader(m[1]!);
        if (parsed) usage = parsed;
        return false;
      }
      // Forward upstream/proxy SSE keepalive comments so reverse proxies and
      // widget-side 180s inactivity timers stay alive during long thinking spans.
      sink.enqueue(SSE_PING_BYTES);
      return true;
    }
    if (!trimmed.startsWith("data:")) return false;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return false;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (chunk.error) {
      if (typeof chunk.error === "string" && chunk.error.trim()) {
        streamError = chunk.error.trim();
      } else if (typeof chunk.error === "object") {
        const msg = (chunk.error as Record<string, unknown>).message;
        streamError = typeof msg === "string" && msg.trim() ? msg.trim() : "Upstream stream error";
      } else {
        streamError = "Upstream stream error";
      }
      return true;
    }
    if (typeof chunk.model === "string" && chunk.model) modelName = chunk.model;
    if (chunk.usage && typeof chunk.usage === "object") {
      const u = parseBodyUsage(chunk.usage);
      if (u.inputTokens || u.cacheTokens || u.outputTokens || u.reasoningTokens) {
        usage = u;
      }
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    if (!first) return false;
    if (typeof first.finish_reason === "string" && first.finish_reason) {
      finishReason = first.finish_reason;
    }
    const delta = (first.delta ?? first.message ?? {}) as Record<string, unknown>;
    let emitted = false;
    const rText =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (rText) {
      fullReasoning += rText;
      sink.enqueue(sseFrame({ type: "reasoning", text: rText }));
      emitted = true;
    }
    const contentText = extractTextContent(delta.content);
    if (contentText) {
      fullText += contentText;
      sink.enqueue(sseFrame({ type: "delta", text: contentText }));
      emitted = true;
    }
    return emitted;
  };

  let abortListenerCleaned = false;
  const onReqAbort = () => {
    finished = true;
    reader.cancel().catch(() => {});
  };
  req.signal.addEventListener("abort", onReqAbort, { once: true });
  if (req.signal.aborted) onReqAbort();
  const cleanupAbortListener = () => {
    if (abortListenerCleaned) return;
    abortListenerCleaned = true;
    req.signal.removeEventListener("abort", onReqAbort);
  };

  const closeSafe = (sink: ReadableStreamDefaultController<Uint8Array>) => {
    cleanupAbortListener();
    try {
      sink.close();
    } catch {}
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(sink) {
      if (finished) {
        closeSafe(sink);
        return;
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buf += decoder.decode();
            if (buf && !streamError) {
              for (const line of buf.split("\n")) {
                processLine(line, sink);
                if (streamError) break;
              }
              buf = "";
            }
            finished = true;
            if (streamError) {
              sink.enqueue(sseFrame({ type: "error", error: streamError }));
            } else {
              sink.enqueue(
                sseFrame({
                  type: "done",
                  text: fullText,
                  reasoning: fullReasoning,
                  model: modelName,
                  effort: effort ?? null,
                  finishReason,
                  usage,
                }),
              );
            }
            closeSafe(sink);
            return;
          }
          if (!value || !value.byteLength) continue;
          buf += decoder.decode(value, { stream: true });
          let emittedHere = false;
          const nl = buf.lastIndexOf("\n");
          if (nl >= 0) {
            const complete = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            for (const line of complete.split("\n")) {
              if (processLine(line, sink)) emittedHere = true;
              if (streamError) break;
            }
            if (streamError) {
              finished = true;
              sink.enqueue(sseFrame({ type: "error", error: streamError }));
              // Drain remaining upstream bytes cleanly (bounded) so the proxy
              // stream finishes terminal accounting (502) instead of 499 cancel.
              void (async () => {
                try {
                  for (let i = 0; i < 8; i++) {
                    const r = await reader.read();
                    if (r.done) break;
                  }
                } catch {}
                reader.cancel().catch(() => {});
              })();
              closeSafe(sink);
              return;
            }
          }
          if (emittedHere) return;
        }
      } catch {
        finished = true;
        if (!req.signal.aborted) {
          try {
            sink.enqueue(sseFrame({ type: "error", error: "AI stream interrupted" }));
          } catch {}
        }
        reader.cancel().catch(() => {});
        closeSafe(sink);
      }
    },
    cancel() {
      finished = true;
      cleanupAbortListener();
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, { status: 200, headers });
}

function parseBufferedCompletion(
  raw: string,
  headers: Headers,
  fallbackModel: string,
  effort: GenUiEffort | undefined,
) {
  let j: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      j = parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error("Invalid response from upstream model");
  }
  const choices = Array.isArray(j.choices) ? j.choices : [];
  if (j.error && choices.length === 0) {
    const errRec = typeof j.error === "object" ? (j.error as Record<string, unknown>) : null;
    const msg =
      typeof j.error === "string" && j.error.trim()
        ? j.error.trim()
        : errRec && typeof errRec.message === "string" && errRec.message.trim()
          ? errRec.message.trim()
          : "Upstream model returned an error";
    throw new Error(msg);
  }
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const msg = (first.message ?? {}) as Record<string, unknown>;
  const text = extractTextContent(msg.content);
  const reasoning =
    typeof msg.reasoning_content === "string"
      ? msg.reasoning_content
      : typeof msg.reasoning === "string"
        ? msg.reasoning
        : "";
  const finishReason = typeof first.finish_reason === "string" && first.finish_reason ? first.finish_reason : "stop";
  const model = typeof j.model === "string" && j.model ? j.model : fallbackModel;
  const headerUsage = parseGatewayUsageHeader(headers.get("x-gateway-usage"));
  const bodyUsage = parseBodyUsage(j.usage);
  const usage: ParsedUsage = headerUsage
    ? {
        ...headerUsage,
        reasoningTokens: headerUsage.reasoningTokens || bodyUsage.reasoningTokens,
      }
    : bodyUsage;
  return {
    text,
    reasoning,
    model,
    effort: effort ?? null,
    finishReason,
    usage,
  };
}

export async function handleGenUiAiRoute(
  path: string,
  req: Request,
  url: URL,
  server?: any,
): Promise<Response | null> {
  if (path === "/api/indirect-code/gen-ui/ai/models" && req.method === "GET") {
    const { user } = await requireAuth(req);
    const hostId = (url.searchParams.get("hostId") || "").trim().slice(0, 64);
    let projectId: string | null = null;
    if (hostId) {
      const host = db
        .prepare<Pick<RemoteHostRow, "id" | "api_key_id">, [string, string]>(
          "SELECT id, api_key_id FROM remote_hosts WHERE id = ? AND user_id = ?",
        )
        .get(hostId, user.id);
      if (!host) return err(404, "host not found", req);
      if (host.api_key_id) {
        const keyRow = db
          .prepare<Pick<ApiKeyRow, "user_id" | "project_id" | "status" | "expires_at">, [string]>(
            "SELECT user_id, project_id, status, expires_at FROM api_keys WHERE id = ?",
          )
          .get(host.api_key_id);
        const notExpired = keyRow && (keyRow.expires_at === null || keyRow.expires_at > Date.now());
        if (keyRow && keyRow.user_id === user.id && keyRow.status === "active" && notExpired && keyRow.project_id) {
          try {
            projectId = requireKeyProject(user.id, keyRow.project_id)?.project.id ?? null;
          } catch (error) {
            if (error instanceof ApiError) return err(error.status, error.message, req, error.code);
            throw error;
          }
        }
      }
    }
    const snap = await routerSnapshot();
    const allowed = allowedModels({ role: user.role, projectId });
    const models = listableModels(snap, "openai")
      .filter((m) => modelAllowed(allowed, m.id))
      .map((m) => {
        const first = (snap.targets.get(m.id) ?? []).find((t) => t.enabled);
        const provider = first ? (snap.providers.get(first.provider_id)?.row.name ?? "") : "";
        return {
          id: m.id,
          name: m.name || m.id,
          provider,
          context: m.context_length ?? DEFAULT_MODEL_CONTEXT,
          output: m.max_output_length ?? DEFAULT_MODEL_OUTPUT,
        };
      });
    const res = json({ success: true, models, efforts: GEN_UI_EFFORTS }, { req });
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  if (path === "/api/indirect-code/gen-ui/ai/complete" && req.method === "POST") {
    const { user } = await requireAuth(req);
    const retryAfter = genUiAiRateHit(user.id);
    if (retryAfter > 0) {
      return rateLimitError(
        `embedded AI rate limit exceeded (${GEN_UI_AI_RPM} req/min), retry in ${retryAfter}s`,
        retryAfter,
        req,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof ApiError) return err(e.status, e.message, req, e.code);
      return err(400, "invalid JSON body", req);
    }

    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model || model.length > 128) {
      return err(400, "`model` is required (1-128 chars)", req);
    }

    const hostId = typeof body.hostId === "string" ? body.hostId.trim().slice(0, 64) : "";
    if (body.hostId !== undefined && typeof body.hostId !== "string") {
      return err(400, "`hostId` must be a string", req);
    }

    let effort: GenUiEffort | undefined;
    if (body.effort !== undefined && body.effort !== null && body.effort !== "") {
      effort = normalizeGenUiEffort(body.effort);
      if (!effort) {
        return err(
          400,
          "`effort` must be one of none, minimum, low, medium, high, xhigh, max",
          req,
        );
      }
    }

    const systemRaw = body.system;
    if (systemRaw !== undefined && typeof systemRaw !== "string") {
      return err(400, "`system` must be a string", req);
    }
    const system = typeof systemRaw === "string" ? systemRaw.trim() : "";
    if (system.length > MAX_SYSTEM_CHARS) {
      return err(400, `\`system\` exceeds ${MAX_SYSTEM_CHARS} characters`, req);
    }

    const promptRaw = body.prompt;
    if (promptRaw !== undefined && typeof promptRaw !== "string") {
      return err(400, "`prompt` must be a string", req);
    }
    const prompt = typeof promptRaw === "string" ? promptRaw : "";
    if (prompt.length > MAX_MESSAGE_CHARS) {
      return err(400, `\`prompt\` exceeds ${MAX_MESSAGE_CHARS} characters`, req);
    }

    const wireMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    let totalChars = system.length + prompt.length;
    const jsonMode = body.json === true;

    const effectiveSystem = jsonMode
      ? system
        ? `${system}\n\n${JSON_SYSTEM_INSTRUCTION}`
        : JSON_SYSTEM_INSTRUCTION
      : system;
    if (effectiveSystem) {
      wireMessages.push({ role: "system", content: effectiveSystem });
    }

    if (body.messages !== undefined) {
      if (!Array.isArray(body.messages)) {
        return err(400, "`messages` must be an array", req);
      }
      if (body.messages.length > MAX_MESSAGES) {
        return err(400, `\`messages\` exceeds max of ${MAX_MESSAGES} entries`, req);
      }
      for (const item of body.messages) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return err(400, "each message must be an object with role and content", req);
        }
        const rec = item as Record<string, unknown>;
        const role = rec.role;
        if (role !== "system" && role !== "user" && role !== "assistant") {
          return err(400, "message role must be system, user, or assistant", req);
        }
        if (typeof rec.content !== "string") {
          return err(400, "message content must be a string", req);
        }
        if (rec.content.length > MAX_MESSAGE_CHARS) {
          return err(400, `message content exceeds ${MAX_MESSAGE_CHARS} characters`, req);
        }
        totalChars += rec.content.length;
        if (totalChars > MAX_TOTAL_CHARS) {
          return err(400, `total prompt content exceeds ${MAX_TOTAL_CHARS} characters`, req);
        }
        wireMessages.push({ role, content: rec.content });
      }
    }

    if (prompt.trim()) {
      wireMessages.push({ role: "user", content: prompt });
    }

    if (!wireMessages.some((m) => m.role !== "system" && m.content.trim().length > 0)) {
      return err(400, "provide a non-empty `prompt` or `messages`", req);
    }

    let maxTokens = DEFAULT_MAX_TOKENS;
    if (body.maxTokens !== undefined && body.maxTokens !== null) {
      if (typeof body.maxTokens !== "number" || !Number.isFinite(body.maxTokens)) {
        return err(400, "`maxTokens` must be a finite number", req);
      }
      maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(body.maxTokens)));
    }

    let temperature: number | undefined;
    if (body.temperature !== undefined && body.temperature !== null) {
      if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) {
        return err(400, "`temperature` must be a finite number", req);
      }
      temperature = Math.min(2, Math.max(0, body.temperature));
    }

    const wantStream = body.stream === true;

    const resolvedKey = resolveUserProxyKey(user.id, hostId || undefined);
    if (!resolvedKey.ok) {
      return err(resolvedKey.status, resolvedKey.message, req);
    }

    // Build a clean OpenAI chat-completions request: strictly text-only, NO
    // tools/functions/arbitrary passthrough keys.
    const proxyPayload: Record<string, unknown> = {
      model,
      messages: wireMessages,
      max_tokens: maxTokens,
      stream: wantStream,
    };
    if (temperature !== undefined) proxyPayload.temperature = temperature;
    if (effort !== undefined) proxyPayload.reasoning_effort = effort;

    const proxyHeaders = new Headers();
    proxyHeaders.set("Content-Type", "application/json");

    const proxyUrl = new URL("/v1/chat/completions", url.origin);
    const proxyReq = new Request(proxyUrl.toString(), {
      method: "POST",
      headers: proxyHeaders,
      body: JSON.stringify(proxyPayload),
      signal: req.signal,
    });

    const resolvedIp = clientIp(req, server);
    const proxyRes = await handleProxyWithKey(proxyReq, proxyUrl, server, resolvedKey.key, resolvedIp);

    if (!proxyRes.ok) {
      let errText = "";
      try {
        errText = await proxyRes.text();
      } catch {}
      const parsed = extractProxyError(proxyRes.status, errText);
      // Never forward HTTP 401 from the proxy/upstream: on /api/*, 401 signals
      // an expired dashboard JWT to authFetch() and triggers token rotation +
      // live WebSocket teardown. Remap upstream 401 to 502 (bad gateway) and
      // key/account admission 401 to 403.
      const clientStatus =
        proxyRes.status === 401
          ? proxyRes.headers.has("x-gateway-attempts")
            ? 502
            : 403
          : proxyRes.status;
      const out = err(clientStatus, parsed.message, req, parsed.code);
      const ra = proxyRes.headers.get("retry-after");
      if (ra) out.headers.set("Retry-After", ra);
      return out;
    }

    if (wantStream) {
      return streamProxyToGenUiSse(proxyRes, model, effort, req);
    }

    let respText: string;
    try {
      respText = await proxyRes.text();
    } catch {
      return err(502, "failed to read upstream AI response", req);
    }
    try {
      const result = parseBufferedCompletion(respText, proxyRes.headers, model, effort);
      const res = json({ success: true, ...result }, { req });
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (e) {
      return err(502, e instanceof Error ? e.message : "invalid upstream AI response", req);
    }
  }

  return null;
}
