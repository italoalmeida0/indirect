/**
 * Host-side bridge of the generative_ui sandbox. Every widget runs in an
 * opaque-origin iframe (`sandbox="allow-scripts"`); the only channel out is
 * `window.parent.postMessage({ __gu, ... })`. This module validates those
 * messages before any of them reaches application code.
 *
 * Threat model: the widget document contains model-generated JS. It is not
 * trusted. The bridge accepts exactly four ops, clamps every value and
 * never forwards the raw message.
 */

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
  /**
   * Optional host interaction gate checked before auto-sending a widget prompt.
   * When false (e.g. fire-on-mount without user interaction with the iframe),
   * sendPrompt downgrades to onPrefillPrompt so the user must explicitly send.
   */
  canAutoSend?: () => boolean;
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
/** Follow-up prompt text is user-visible content; keep it sane. */
const MAX_PROMPT_CHARS = 2000;
/** Error text is user-visible content too; keep it one short line. */
const MAX_ERROR_CHARS = 500;
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

  const handler = (event: MessageEvent) => {
    if (event.source !== frameWindow()) return;
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
        data.__gu !== "escape")
    ) return;
    if (data.__gu === "ready") {
      ops.onReady?.();
      return;
    }
    if (data.__gu === "escape") {
      ops.onEscape?.();
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
