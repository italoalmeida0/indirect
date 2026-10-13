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
};

/** A widget may ask for follow-ups, but never spam: cap the op rate. */
const MAX_OPS_PER_MINUTE = 60;
/** Follow-up prompt text is user-visible content; keep it sane. */
const MAX_PROMPT_CHARS = 2000;
/** Error text is user-visible content too; keep it one short line. */
const MAX_ERROR_CHARS = 500;
/** Reported heights are clamped so a hostile widget cannot blow up layout. */
export const MIN_FRAME_HEIGHT = 64;
export const MAX_FRAME_HEIGHT = 4000;

export function clampFrameHeight(height: number): number {
  if (!Number.isFinite(height)) return MIN_FRAME_HEIGHT;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(height)));
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
  let opsWindowStart = 0;
  let opsInWindow = 0;
  const rateOk = () => {
    const now = Date.now();
    if (now - opsWindowStart > 60_000) {
      opsWindowStart = now;
      opsInWindow = 0;
    }
    if (opsInWindow >= MAX_OPS_PER_MINUTE) return false;
    opsInWindow++;
    return true;
  };

  const handler = (event: MessageEvent) => {
    if (event.source !== frameWindow()) return;
    const data: any = event.data;
    if (!data || typeof data !== "object" || data.__gu !== "sendPrompt" && data.__gu !== "prefillPrompt" && data.__gu !== "openLink" && data.__gu !== "resize" && data.__gu !== "error") return;
    if (!rateOk()) return;
    switch (data.__gu) {
      case "sendPrompt": {
        const text = typeof data.text === "string" ? data.text.slice(0, MAX_PROMPT_CHARS).trim() : "";
        if (text) ops.onSendPrompt(text);
        return;
      }
      case "prefillPrompt": {
        const text = typeof data.text === "string" ? data.text.slice(0, MAX_PROMPT_CHARS).trim() : "";
        if (text && ops.onPrefillPrompt) ops.onPrefillPrompt(text);
        return;
      }
      case "openLink": {
        const url = typeof data.url === "string" ? data.url.slice(0, 2048) : "";
        if (url && isHttpUrl(url)) ops.onOpenLink(url);
        return;
      }
      case "resize": {
        ops.onResize(clampFrameHeight(Number(data.height)));
        return;
      }
      case "error": {
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
