/**
 * Host-side bridge of the generative_ui sandbox. Every widget runs in an
 * opaque-origin iframe (`sandbox="allow-scripts"`); the only channel out is
 * `window.parent.postMessage({ __gu, ... })`. This module validates those
 * messages before any of them reaches application code.
 *
 * Threat model: the widget document contains model-generated JS. It is not
 * trusted. The bridge accepts only allowlisted ops, clamps every value,
 * rate-limits per category, and never forwards the raw message.
 */

export interface WidgetAttachPayload {
  /** Optional stable slot id within this widget: repeated calls replace in-place. */
  key?: string;
  name: string;
  mime: string;
  content?: string;
  dataUrl?: string;
}

export interface WidgetAttachmentSummary {
  key?: string;
  name: string;
  mime: string;
  size: number;
  updatedAt?: number;
}

export interface WidgetAiModelInfo {
  id: string;
  name: string;
  provider: string;
  context: number;
  output: number;
}

export interface WidgetAiEffortInfo {
  id: string;
  label: string;
  description: string;
}

export interface WidgetAiContext {
  model: string;
  modelName: string;
  effort: string;
  efforts: WidgetAiEffortInfo[];
  models: WidgetAiModelInfo[];
}

export interface WidgetAiRequestPayload {
  reqId: string;
  stream: boolean;
  json: boolean;
  model?: string;
  effort?: string;
  system?: string;
  prompt?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

export type WidgetAiEvent =
  | { op: "aiDelta"; reqId: string; text: string }
  | { op: "aiReasoning"; reqId: string; text: string }
  | {
      op: "aiDone";
      reqId: string;
      text: string;
      reasoning: string;
      model: string;
      effort: string | null;
      finishReason: string;
      usage: {
        inputTokens: number;
        cacheTokens: number;
        outputTokens: number;
        reasoningTokens: number;
      };
    }
  | {
      op: "aiError";
      reqId: string;
      error: string;
      code?: string;
      status?: number;
      aborted?: boolean;
    };

export type GuBridgeOps = {
  onSendPrompt: (text: string) => void;
  /** Paste text into the composer without sending (follow-up drafting). */
  onPrefillPrompt?: (text: string) => void;
  onOpenLink: (url: string) => void;
  onResize: (height: number) => void;
  /** Runtime error reported by the widget (shown in the host error footer). */
  onError?: (message: string) => void;
  /** Explicit (non-reactive) state save: widget calls window.__gu.saveState(). */
  onState?: (stateJSON: string) => void;
  /** Fired when the widget runtime finishes booting and is ready for host theme/accent sync. */
  onReady?: () => void;
  /** Fired on unhandled Escape while fullscreen so host exits fullscreen cleanly. */
  onEscape?: () => void;
  /** Fired on the first trusted user gesture observed by the nonce'd widget runtime. */
  onGesture?: () => void;
  /** Attach (or update in-place when `key` is set) a structured/image payload into the composer. */
  onAttach?: (payload: WidgetAttachPayload) => void;
  /** Remove a keyed attachment (or all attachments owned by this widget when `key` omitted). */
  onDetach?: (key?: string) => void;
  /** Embedded AI completion/streaming request originating from window.__gu.ai. */
  onAiRequest?: (payload: WidgetAiRequestPayload) => void;
  /** Abort one or all in-flight embedded AI requests for this widget. */
  onAiAbort?: (reqId?: string) => void;
  /**
   * Optional host interaction gate checked before auto-sending a widget prompt.
   * When false (e.g. fire-on-mount without user interaction with the iframe),
   * sendPrompt downgrades to onPrefillPrompt so the user must explicitly send.
   */
  canAutoSend?: () => boolean;
  /**
   * Optional host interaction gate checked before accepting widget-initiated
   * composer attachments so reopening transcripts cannot silently inject files.
   */
  canAttach?: () => boolean;
  /**
   * Optional host interaction gate checked before executing embedded AI calls
   * so opening old transcripts never burns LLM budget automatically on mount.
   */
  canUseAi?: () => boolean;
};

export type WidgetAccent =
  | "teal"
  | "neutral"
  | "violet"
  | "blue"
  | "green"
  | "amber"
  | "orange"
  | "coral"
  | "rose";

const VALID_ACCENTS = new Set<string>([
  "teal",
  "neutral",
  "violet",
  "blue",
  "green",
  "amber",
  "orange",
  "coral",
  "rose",
]);

/** A widget may ask for follow-ups, but never spam: cap the op rate. */
const MAX_OPS_PER_MINUTE = 60;
/** State saves get their own generous bucket so resizes never drop a save. */
const MAX_STATE_SAVES_PER_MINUTE = 240;
/** Layout resize reports get their own high ceiling so dynamic widgets never freeze height. */
const MAX_RESIZES_PER_MINUTE = 600;
/** Composer attachments get a dedicated bucket for interactive form/state sync. */
const MAX_ATTACH_PER_MINUTE = 120;
/** Embedded AI requests get a dedicated bucket aligned with server RPM limits. */
const MAX_AI_PER_MINUTE = 60;
/** Follow-up prompt text is user-visible content; keep it sane. */
const MAX_PROMPT_CHARS = 2000;
/** Error text is user-visible content too; keep it one short line. */
const MAX_ERROR_CHARS = 500;
/** Text attachment ceiling (1 MB characters). */
const MAX_ATTACH_TEXT_CHARS = 1_048_576;
/** Image data-URL ceiling (~2.5 MB decoded). */
const MAX_ATTACH_DATAURL_CHARS = 3_600_000;
/** Inert text MIME types allowed for widget text attachments (never active HTML/SVG). */
const ALLOWED_ATTACH_TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
]);
const DATA_URL_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AI_SYSTEM_CHARS = 32_768;
const MAX_AI_MSG_CHARS = 65_536;
const MAX_AI_MESSAGES = 64;
const MAX_AI_TOTAL_CHARS = 160_000;
/** Saved state snapshots are bounded (widget state, not bulk storage). */
export const MAX_STATE_CHARS = 65_536;
/** Reported heights are clamped so a hostile widget cannot blow up layout. */
export const MIN_FRAME_HEIGHT = 64;
export const MAX_FRAME_HEIGHT = 4000;

export function clampFrameHeight(height: number): number {
  if (!Number.isFinite(height)) return MIN_FRAME_HEIGHT;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(height)));
}

/**
 * Parse and validate a serialized widget state snapshot. Only plain JSON
 * objects (non-null, non-array) within MAX_STATE_CHARS are accepted so
 * truncated/corrupt/primitive values can never brick a widget on reload.
 */
export function parseSavedStateJSON(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_STATE_CHARS) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the initial stateJSON sent to a widget document: valid saved state
 * keys win over the fence `state:` default (shallow-merged so partial saves
 * like `saveState({ bestScore })` preserve sibling default props).
 */
export function resolveWidgetStateJSON(
  defaultState: Record<string, unknown> | undefined,
  savedRaw: string | null | undefined,
): string {
  const base =
    defaultState && typeof defaultState === "object" && !Array.isArray(defaultState)
      ? defaultState
      : {};
  const saved = parseSavedStateJSON(savedRaw);
  if (!saved) return JSON.stringify(base);
  return JSON.stringify({ ...base, ...saved });
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeAttachKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw.trim().replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 64);
  return clean || undefined;
}

function sanitizeAttachName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const clean = raw.replace(/[\\/\r\n\t\0]+/g, "_").trim().slice(0, 120);
  if (!clean || clean === "." || clean === "..") return fallback;
  return clean;
}

function parseAttachMessage(data: any): WidgetAttachPayload | null {
  const key = sanitizeAttachKey(data.key);
  if (typeof data.dataUrl === "string" && data.dataUrl.length > 0) {
    const du = data.dataUrl.trim();
    if (du.length > MAX_ATTACH_DATAURL_CHARS || !DATA_URL_IMAGE_RE.test(du)) return null;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(du);
    if (!match) return null;
    const mime = match[1]!;
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const name = sanitizeAttachName(data.name, `${key || "widget-snapshot"}.${ext}`);
    return { key, name, mime, dataUrl: du };
  }
  if (typeof data.content !== "string") return null;
  if (data.content.length === 0 || data.content.length > MAX_ATTACH_TEXT_CHARS) return null;
  const rawMime = typeof data.mime === "string" ? data.mime.trim().toLowerCase() : "text/plain";
  const mime = ALLOWED_ATTACH_TEXT_MIMES.has(rawMime) ? rawMime : "text/plain";
  const defExt =
    mime === "application/json"
      ? ".json"
      : mime === "text/markdown"
        ? ".md"
        : mime === "text/csv"
          ? ".csv"
          : ".txt";
  const name = sanitizeAttachName(data.name, `${key || "widget-data"}${defExt}`);
  return { key, name, mime, content: data.content };
}

function parseAiRequestMessage(
  data: any,
):
  | { ok: true; payload: WidgetAiRequestPayload }
  | { ok: false; error: string; code: string; status: number } {
  const reqId = typeof data.reqId === "string" ? data.reqId.trim().slice(0, 64) : "";
  if (!reqId) {
    return { ok: false, error: "Missing AI request id.", code: "invalid_request", status: 400 };
  }
  const model = typeof data.model === "string" && data.model.trim() ? data.model.trim().slice(0, 128) : undefined;
  const effort = typeof data.effort === "string" && data.effort.trim() ? data.effort.trim().slice(0, 24) : undefined;
  const system = typeof data.system === "string" && data.system.trim() ? data.system.slice(0, MAX_AI_SYSTEM_CHARS) : undefined;
  const prompt = typeof data.prompt === "string" && data.prompt.trim() ? data.prompt.slice(0, MAX_AI_MSG_CHARS) : undefined;
  let total = (system?.length ?? 0) + (prompt?.length ?? 0);
  if (total > MAX_AI_TOTAL_CHARS) {
    return {
      ok: false,
      error: `AI request exceeds maximum size (${MAX_AI_TOTAL_CHARS} chars).`,
      code: "payload_too_large",
      status: 413,
    };
  }
  let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> | undefined;
  if (Array.isArray(data.messages)) {
    messages = [];
    for (const item of data.messages.slice(0, MAX_AI_MESSAGES)) {
      if (!item || typeof item !== "object") continue;
      const role = item.role;
      if (role !== "system" && role !== "user" && role !== "assistant") continue;
      if (typeof item.content !== "string") continue;
      const content = item.content.slice(0, MAX_AI_MSG_CHARS);
      total += content.length;
      if (total > MAX_AI_TOTAL_CHARS) {
        return {
          ok: false,
          error: `AI request exceeds maximum size (${MAX_AI_TOTAL_CHARS} chars).`,
          code: "payload_too_large",
          status: 413,
        };
      }
      messages.push({ role, content });
    }
  }
  if (!prompt && (!messages || !messages.some((m) => m.role !== "system" && m.content.trim().length > 0))) {
    return {
      ok: false,
      error: "Invalid AI request payload (provide a non-empty prompt or messages).",
      code: "invalid_request",
      status: 400,
    };
  }
  const maxTokens =
    typeof data.maxTokens === "number" && Number.isFinite(data.maxTokens)
      ? Math.min(8192, Math.max(1, Math.floor(data.maxTokens)))
      : undefined;
  const temperature =
    typeof data.temperature === "number" && Number.isFinite(data.temperature)
      ? Math.min(2, Math.max(0, data.temperature))
      : undefined;
  return {
    ok: true,
    payload: {
      reqId,
      stream: data.stream === true,
      json: data.json === true,
      model,
      effort,
      system,
      prompt,
      messages,
      maxTokens,
      temperature,
    },
  };
}

/**
 * Attaches the message listener for one widget frame. Returns the detach
 * function. Messages must come from the given window and match the __gu
 * protocol; anything else is dropped silently (widgets also post benign
 * messages like focus events from inner elements).
 */
export function attachGuBridge(
  frameWindow: () => Window | null | undefined,
  ops: GuBridgeOps,
): () => void {
  const makeBucket = (limit: number) => {
    let windowStart = 0;
    let count = 0;
    return () => {
      const now = Date.now();
      if (now - windowStart > 60_000) {
        windowStart = now;
        count = 0;
      }
      if (count >= limit) return false;
      count++;
      return true;
    };
  };
  const actionRateOk = makeBucket(MAX_OPS_PER_MINUTE);
  const stateRateOk = makeBucket(MAX_STATE_SAVES_PER_MINUTE);
  const resizeRateOk = makeBucket(MAX_RESIZES_PER_MINUTE);
  const attachRateOk = makeBucket(MAX_ATTACH_PER_MINUTE);
  const aiRateOk = makeBucket(MAX_AI_PER_MINUTE);

  const handler = (event: MessageEvent) => {
    const fw = frameWindow();
    if (!fw || event.source !== fw) return;
    const data: any = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      (data.__gu !== "sendPrompt" &&
        data.__gu !== "prefillPrompt" &&
        data.__gu !== "openLink" &&
        data.__gu !== "resize" &&
        data.__gu !== "error" &&
        data.__gu !== "state" &&
        data.__gu !== "ready" &&
        data.__gu !== "escape" &&
        data.__gu !== "gesture" &&
        data.__gu !== "attach" &&
        data.__gu !== "detach" &&
        data.__gu !== "aiRequest" &&
        data.__gu !== "aiAbort")
    ) return;
    if (data.__gu === "ready") {
      ops.onReady?.();
      return;
    }
    if (data.__gu === "escape") {
      ops.onEscape?.();
      return;
    }
    if (data.__gu === "gesture") {
      ops.onGesture?.();
      return;
    }
    switch (data.__gu) {
      case "resize": {
        if (!resizeRateOk()) return;
        ops.onResize(clampFrameHeight(Number(data.height)));
        return;
      }
      case "state": {
        if (!stateRateOk()) return;
        const parsed = parseSavedStateJSON(typeof data.state === "string" ? data.state : null);
        if (parsed && ops.onState) ops.onState(JSON.stringify(parsed));
        return;
      }
      case "sendPrompt": {
        if (!actionRateOk()) return;
        const text = typeof data.text === "string" ? data.text.slice(0, MAX_PROMPT_CHARS).trim() : "";
        if (!text) return;
        // Slash commands (e.g. /full, /yolo, /compact) can change session access
        // or trigger host actions: never auto-execute them from an untrusted
        // widget. Fall back to prefill so the human sees and submits explicitly.
        if (text.trimStart().startsWith("/")) {
          ops.onPrefillPrompt?.(text);
          return;
        }
        if (ops.canAutoSend && !ops.canAutoSend()) {
          ops.onPrefillPrompt?.(text);
          return;
        }
        ops.onSendPrompt(text);
        return;
      }
      case "prefillPrompt": {
        if (!actionRateOk()) return;
        const text = typeof data.text === "string" ? data.text.slice(0, MAX_PROMPT_CHARS).trim() : "";
        if (text && ops.onPrefillPrompt) ops.onPrefillPrompt(text);
        return;
      }
      case "openLink": {
        if (!actionRateOk()) return;
        const url = typeof data.url === "string" ? data.url.slice(0, 2048) : "";
        if (url && isHttpUrl(url)) ops.onOpenLink(url);
        return;
      }
      case "error": {
        if (!actionRateOk()) return;
        const message = typeof data.message === "string" ? data.message.slice(0, MAX_ERROR_CHARS).trim() : "";
        if (message) ops.onError?.(message);
        return;
      }
      case "attach": {
        if (!attachRateOk()) return;
        if (ops.canAttach && !ops.canAttach()) return;
        const parsed = parseAttachMessage(data);
        if (parsed && ops.onAttach) ops.onAttach(parsed);
        return;
      }
      case "detach": {
        if (!attachRateOk()) return;
        if (ops.canAttach && !ops.canAttach()) return;
        const key = sanitizeAttachKey(data.key);
        ops.onDetach?.(key);
        return;
      }
      case "aiRequest": {
        const reqId = typeof data.reqId === "string" ? data.reqId.trim().slice(0, 64) : "";
        if (!reqId) return;
        if (!ops.onAiRequest) {
          postGuAiEvent(fw, {
            op: "aiError",
            reqId,
            error: "Embedded AI is unavailable in this view.",
            code: "ai_unavailable",
          });
          return;
        }
        if (ops.canUseAi && !ops.canUseAi()) {
          postGuAiEvent(fw, {
            op: "aiError",
            reqId,
            error: "AI calls require a user click or interaction in the widget first.",
            code: "interaction_required",
          });
          return;
        }
        if (!aiRateOk()) {
          postGuAiEvent(fw, {
            op: "aiError",
            reqId,
            error: "Widget AI rate limit exceeded. Wait a moment and try again.",
            code: "rate_limited",
            status: 429,
          });
          return;
        }
        const parsed = parseAiRequestMessage(data);
        if (!parsed.ok) {
          postGuAiEvent(fw, {
            op: "aiError",
            reqId,
            error: parsed.error,
            code: parsed.code,
            status: parsed.status,
          });
          return;
        }
        ops.onAiRequest(parsed.payload);
        return;
      }
      case "aiAbort": {
        const reqId = typeof data.reqId === "string" ? data.reqId.trim().slice(0, 64) : undefined;
        ops.onAiAbort?.(reqId || undefined);
        return;
      }
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Current host theme for the widget document. */
export function widgetTheme(): "dark" | "light" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/** Current host accent for the widget document (defaults to "teal"). */
export function widgetAccent(): WidgetAccent {
  const attr = document.documentElement.getAttribute("data-accent");
  if (attr && VALID_ACCENTS.has(attr)) return attr as WidgetAccent;
  return "teal";
}

/** Sync host theme and/or accent into a mounted widget iframe. */
export function postGuTheme(
  frameWindow: Window | null | undefined,
  params: { theme?: "dark" | "light"; accent?: WidgetAccent },
): void {
  if (!frameWindow) return;
  try {
    frameWindow.postMessage(
      { __gu: "theme", theme: params.theme, accent: params.accent },
      "*",
    );
  } catch {}
}

/** Sync host fullscreen overlay state into a mounted widget iframe. */
export function postGuFullscreen(
  frameWindow: Window | null | undefined,
  expanded: boolean,
): void {
  if (!frameWindow) return;
  try {
    frameWindow.postMessage(
      { __gu: "fullscreen", expanded: !!expanded },
      "*",
    );
  } catch {}
}

/** Sync the widget's own active composer attachments back into the iframe. */
export function postGuAttachments(
  frameWindow: Window | null | undefined,
  items: WidgetAttachmentSummary[],
): void {
  if (!frameWindow) return;
  try {
    frameWindow.postMessage({ __gu: "attachments", items }, "*");
  } catch {}
}

/** Sync the session's active model/effort/catalog context into the iframe. */
export function postGuAiContext(
  frameWindow: Window | null | undefined,
  context: WidgetAiContext,
): void {
  if (!frameWindow) return;
  try {
    frameWindow.postMessage({ __gu: "aiContext", context }, "*");
  } catch {}
}

/** Forward one streaming/terminal embedded-AI event into the iframe. */
export function postGuAiEvent(
  frameWindow: Window | null | undefined,
  event: WidgetAiEvent,
): void {
  if (!frameWindow) return;
  try {
    const { op, ...rest } = event;
    frameWindow.postMessage({ __gu: op, ...rest }, "*");
  } catch {}
}

export type WidgetPublishResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Serializes widget publish requests with monotonic invalidation epochs so
 * resetState / reload / fullscreen sync never lose a re-publish behind an
 * in-flight POST and stale responses never overwrite newer state.
 */
export function createWidgetPublishController(deps: {
  canPublish: () => boolean;
  getKey: () => string;
  hasUrl: () => boolean;
  clearUrl: () => void;
  publish: () => Promise<WidgetPublishResult>;
  onSuccess: (url: string) => void;
  onError: (message: string) => void;
}) {
  let inFlight = false;
  let pending = false;
  let seq = 0;
  let publishedKey = "";
  let force = false;
  let disposed = false;

  const invalidate = (clearUrl = true) => {
    seq++;
    publishedKey = "";
    force = true;
    if (clearUrl) deps.clearUrl();
  };

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (!deps.canPublish()) return;
    if (inFlight) {
      pending = true;
      return;
    }
    const key = deps.getKey();
    if (!force && key === publishedKey && deps.hasUrl()) return;
    const mySeq = ++seq;
    force = false;
    inFlight = true;
    pending = false;
    try {
      const result = await deps.publish();
      if (disposed || mySeq !== seq || !deps.canPublish()) return;
      if (result.ok) {
        publishedKey = key;
        deps.onSuccess(result.url);
      } else {
        deps.onError(result.error);
      }
    } catch {
      if (disposed || mySeq !== seq || !deps.canPublish()) return;
      deps.onError("Widget could not be published (network error).");
    } finally {
      inFlight = false;
      if (pending && !disposed) {
        pending = false;
        void run();
      }
    }
  };

  return {
    get publishedKey() {
      return publishedKey;
    },
    invalidate,
    run,
    dispose() {
      disposed = true;
      seq++;
      pending = false;
    },
  };
}
