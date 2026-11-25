import { authFetch } from "../../../api";
import type {
  WidgetAiContext,
  WidgetAiEvent,
  WidgetAiRequestPayload,
} from "./bridge";

const MAX_CONCURRENT_AI_PER_WIDGET = 4;

export interface WidgetAiController {
  start(
    req: WidgetAiRequestPayload,
    ctx: WidgetAiContext & { hostId?: string },
    emit: (ev: WidgetAiEvent) => void,
  ): void;
  abort(reqId?: string): void;
  activeCount(): number;
}

/**
 * Host-side orchestrator for embedded AI calls originating from one
 * Generative UI widget iframe.
 *
 * - Defaults `model` and `effort` from the active session context when omitted.
 * - Caps concurrent in-flight requests per widget.
 * - Streams normalized gateway SSE events (`delta`, `reasoning`, `done`, `error`)
 *   back to the iframe and immediately cancels upstream on `abort()` / unmount.
 */
export function createWidgetAiController(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response> = authFetch,
): WidgetAiController {
  const inFlight = new Map<string, AbortController>();

  function abort(reqId?: string) {
    if (reqId) {
      const c = inFlight.get(reqId);
      if (c) {
        inFlight.delete(reqId);
        try {
          c.abort();
        } catch {}
      }
      return;
    }
    const entries = Array.from(inFlight.values());
    inFlight.clear();
    for (const c of entries) {
      try {
        c.abort();
      } catch {}
    }
  }

  function start(
    req: WidgetAiRequestPayload,
    ctx: WidgetAiContext & { hostId?: string },
    emit: (ev: WidgetAiEvent) => void,
  ) {
    const reqId = req.reqId;
    if (inFlight.has(reqId)) {
      emit({ op: "aiError", reqId, error: "Duplicate AI request id", code: "duplicate_request" });
      return;
    }
    if (inFlight.size >= MAX_CONCURRENT_AI_PER_WIDGET) {
      emit({
        op: "aiError",
        reqId,
        error: `Too many concurrent AI requests (max ${MAX_CONCURRENT_AI_PER_WIDGET})`,
        code: "concurrency_limit",
        status: 429,
      });
      return;
    }

    const model = (req.model || ctx.model || "").trim();
    if (!model) {
      emit({
        op: "aiError",
        reqId,
        error: "No model is selected in this session.",
        code: "no_model",
        status: 400,
      });
      return;
    }
    const effort = (req.effort || ctx.effort || "").trim() || undefined;

    const controller = new AbortController();
    inFlight.set(reqId, controller);

    const payload: Record<string, unknown> = {
      model,
      stream: req.stream,
      json: req.json,
    };
    if (ctx.hostId) payload.hostId = ctx.hostId;
    if (effort) payload.effort = effort;
    if (req.system) payload.system = req.system;
    if (req.prompt) payload.prompt = req.prompt;
    if (req.messages && req.messages.length > 0) payload.messages = req.messages;
    if (typeof req.maxTokens === "number") payload.maxTokens = req.maxTokens;
    if (typeof req.temperature === "number") payload.temperature = req.temperature;

    void (async () => {
      try {
        const res = await fetchImpl("/api/indirect-code/gen-ui/ai/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          let errMsg = `AI request failed (HTTP ${res.status})`;
          let errCode: string | undefined;
          try {
            const j = (await res.json()) as Record<string, unknown>;
            if (typeof j?.error === "string" && j.error.trim()) errMsg = j.error.trim();
            if (typeof j?.code === "string" && j.code) errCode = j.code;
          } catch {}
          emit({ op: "aiError", reqId, error: errMsg, code: errCode, status: res.status });
          return;
        }

        if (!req.stream) {
          const j = (await res.json()) as Record<string, unknown>;
          if (j?.success === false) {
            emit({
              op: "aiError",
              reqId,
              error: typeof j.error === "string" ? j.error : "AI request failed",
              code: typeof j.code === "string" ? j.code : undefined,
              status: res.status,
            });
            return;
          }
          emit({
            op: "aiDone",
            reqId,
            text: typeof j.text === "string" ? j.text : "",
            reasoning: typeof j.reasoning === "string" ? j.reasoning : "",
            model: typeof j.model === "string" ? j.model : model,
            effort: typeof j.effort === "string" ? j.effort : effort ?? null,
            finishReason: typeof j.finishReason === "string" ? j.finishReason : "stop",
            usage: parseUsageObj(j.usage),
          });
          return;
        }

        // Streaming SSE response
        if (!res.body) {
          emit({
            op: "aiDone",
            reqId,
            text: "",
            reasoning: "",
            model,
            effort: effort ?? null,
            finishReason: "stop",
            usage: { inputTokens: 0, cacheTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let fullText = "";
        let fullReasoning = "";
        let settled = false;

        const handleLine = (line: string) => {
          const trimmed = line.replace(/\r$/, "");
          if (!trimmed.startsWith("data:")) return;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr) return;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(dataStr) as Record<string, unknown>;
          } catch {
            return;
          }
          const t = frame.type;
          if (t === "delta" && typeof frame.text === "string") {
            fullText += frame.text;
            emit({ op: "aiDelta", reqId, text: frame.text });
          } else if (t === "reasoning" && typeof frame.text === "string") {
            fullReasoning += frame.text;
            emit({ op: "aiReasoning", reqId, text: frame.text });
          } else if (t === "done") {
            settled = true;
            emit({
              op: "aiDone",
              reqId,
              text: typeof frame.text === "string" ? frame.text : fullText,
              reasoning: typeof frame.reasoning === "string" ? frame.reasoning : fullReasoning,
              model: typeof frame.model === "string" ? frame.model : model,
              effort: typeof frame.effort === "string" ? frame.effort : effort ?? null,
              finishReason: typeof frame.finishReason === "string" ? frame.finishReason : "stop",
              usage: parseUsageObj(frame.usage),
            });
          } else if (t === "error") {
            settled = true;
            emit({
              op: "aiError",
              reqId,
              error: typeof frame.error === "string" ? frame.error : "AI stream error",
              code: typeof frame.code === "string" ? frame.code : "stream_error",
            });
          }
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || !value.byteLength) continue;
            buf += decoder.decode(value, { stream: true });
            const nl = buf.lastIndexOf("\n");
            if (nl >= 0) {
              const complete = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              for (const line of complete.split("\n")) handleLine(line);
              if (settled) break;
            }
          }
          if (!settled) {
            buf += decoder.decode();
            if (buf) {
              for (const line of buf.split("\n")) handleLine(line);
            }
          }
          if (!settled && !controller.signal.aborted) {
            emit({
              op: "aiError",
              reqId,
              error: "AI stream ended unexpectedly before completion",
              code: "stream_truncated",
            });
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      } catch (e) {
        if (controller.signal.aborted) {
          emit({ op: "aiError", reqId, error: "AI request aborted", code: "aborted", aborted: true });
        } else {
          emit({
            op: "aiError",
            reqId,
            error: e instanceof Error ? e.message : "AI request failed",
            code: "network_error",
          });
        }
      } finally {
        if (inFlight.get(reqId) === controller) inFlight.delete(reqId);
      }
    })();
  }

  return {
    start,
    abort,
    activeCount: () => inFlight.size,
  };
}

function parseUsageObj(raw: unknown) {
  const u = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    inputTokens: typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : 0,
    cacheTokens: typeof u.cacheTokens === "number" && Number.isFinite(u.cacheTokens) ? u.cacheTokens : 0,
    outputTokens: typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens) ? u.outputTokens : 0,
    reasoningTokens: typeof u.reasoningTokens === "number" && Number.isFinite(u.reasoningTokens) ? u.reasoningTokens : 0,
  };
}
