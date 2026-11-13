import type { DaemonCommand } from "../daemon-protocol";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { PreviewFile } from "../types";
import type { AttachmentDataEvent } from "../daemon-protocol";
import type { StoredAttachment } from "../viewTypes";
import { base64ToBytes } from "../utils/blobUrlCache";

export const PREVIEW_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface PreviewCacheItem {
  name: string;
  mime: string;
  blob: Blob;
  objectUrl: string;
  byteLength: number;
  text?: string;
}

/** Review of changes + file preview + session attachments (extracted
 * verbatim from RemoteCodePage — collaborators via params). */
export function createReview(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  getHostId: () => string;
  isSessionRunning: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
  showConfirm: (o: {
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  isHostOnline: () => boolean;
}) {
  // Stored attachments per session (from session_data + uploads).
  const [sessionFiles, setSessionFiles] = createSignal<
    Record<string, StoredAttachment[]>
  >({});
  function noteSessionFiles(sid: string, atts: any[]) {
    if (Array.isArray(atts)) {
      setSessionFiles((prev) => ({
        ...prev,
        [sid]: atts.map((a: any) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size || 0,
        })),
      }));
    }
  }
  function addSessionFile(
    sessionId: string,
    a: { id: string; name: string; mime: string; size?: number },
  ) {
    setSessionFiles((prev) => {
      const list = prev[sessionId] || [];
      if (list.some((x) => x.id === a.id)) return prev;
      return {
        ...prev,
        [sessionId]: [
          ...list,
          { id: a.id, name: a.name, mime: a.mime, size: a.size || 0 },
        ],
      };
    });
  }

  function revokeEntry(item?: PreviewCacheItem) {
    if (!item?.objectUrl) return;
    try {
      URL.revokeObjectURL(item.objectUrl);
    } catch {}
  }

  // Fetched bytes cache for preview (attachmentId -> Blob + ObjectURL, capped at 8 MiB).
  const [previewCache, setPreviewCache] = createSignal<
    Record<string, PreviewCacheItem>
  >({});

  function clearPreviewCache() {
    setPreviewCache((prev) => {
      for (const item of Object.values(prev)) revokeEntry(item);
      return {};
    });
  }

  function pruneInactiveSessionFiles(activeSid = opts.getSessionId()) {
    setSessionFiles((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      if (!activeSid) return {};
      if (keys.length === 1 && keys[0] === activeSid) return prev;
      const keep = prev[activeSid];
      return keep ? { [activeSid]: keep } : {};
    });
  }

  function purgeSessionFiles(sessionId: string) {
    setSessionFiles((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    const prefix = `${sessionId}:`;
    setPreviewCache((prev) => {
      let changed = false;
      const next: Record<string, PreviewCacheItem> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (k.startsWith(prefix)) {
          changed = true;
          revokeEntry(v);
        } else {
          next[k] = v;
        }
      }
      return changed ? next : prev;
    });
  }

  let transientPreviewUrl: string | null = null;
  function revokeTransientPreviewUrl() {
    if (!transientPreviewUrl) return;
    try {
      URL.revokeObjectURL(transientPreviewUrl);
    } catch {}
    transientPreviewUrl = null;
  }

  // File preview modal target.
  const [previewFile, setPreviewFileState] = createSignal<PreviewFile | null>(
    null,
  );
  function setPreviewFile(file: PreviewFile | null) {
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    if (!file || file.dataUrl !== transientPreviewUrl) {
      revokeTransientPreviewUrl();
    }
    setPreviewCopied(false);
    setShowTruncateInput(false);
    return setPreviewFileState(file);
  }
  const [previewCopied, setPreviewCopied] = createSignal(false);
  const [truncateTokens, setTruncateTokens] = createSignal(16000);
  const [showTruncateInput, setShowTruncateInput] = createSignal(false);

  function downloadPreviewFile() {
    const f = previewFile();
    if (!f || (!f.blob && f.dataB64 == null && !f.dataUrl?.startsWith("blob:"))) {
      opts.toast("Original bytes unavailable for download", "err");
      return;
    }
    try {
      let url = "";
      let shouldRevoke = false;
      if (f.blob) {
        url = URL.createObjectURL(f.blob);
        shouldRevoke = true;
      } else if (f.dataUrl?.startsWith("blob:")) {
        url = f.dataUrl;
      } else if (f.dataB64 != null) {
        const bytes = base64ToBytes(f.dataB64);
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: f.mime }));
        shouldRevoke = true;
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (shouldRevoke) {
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch {
      opts.toast("Download failed", "err");
    }
  }

  function truncatePreviewFile() {
    const f = previewFile();
    const limit = Math.floor(truncateTokens());
    if (!Number.isFinite(limit) || limit < 1) {
      opts.toast("Enter a positive token limit", "err");
      return;
    }
    const maxChars = limit * 4;
    if (!f?.text || f.text.length <= maxChars) {
      opts.toast("File is already within the token limit", "err");
      return;
    }
    setPreviewFile({
      ...f,
      fullText: f.fullText || f.text,
      text: f.text.substring(0, maxChars),
      truncated: true,
    });
  }

  function restorePreviewFile() {
    const f = previewFile();
    if (f?.fullText) {
      setPreviewFile({
        ...f,
        text: f.fullText,
        fullText: undefined,
        truncated: false,
      });
    }
  }

  function previewPending(a: {
    name: string;
    mime: string;
    text?: string;
    objectUrl?: string;
    dataB64?: string;
    size?: number;
  }) {
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    revokeTransientPreviewUrl();
    const blob =
      a.dataB64 != null
        ? new Blob([base64ToBytes(a.dataB64) as BlobPart], {
            type: a.mime || "application/octet-stream",
          })
        : undefined;
    if (a.objectUrl || (blob && a.mime.startsWith("image/"))) {
      let dataUrl = a.objectUrl;
      if (!dataUrl && blob) {
        dataUrl = URL.createObjectURL(blob);
        transientPreviewUrl = dataUrl;
      }
      setPreviewFile({
        name: a.name,
        mime: a.mime,
        dataUrl,
        blob,
        size: a.size,
      });
    } else {
      setPreviewFile({
        name: a.name,
        mime: a.mime,
        text: a.text ?? "(still extracting...)",
        blob,
        size: a.size,
      });
    }
    setPreviewCopied(false);
  }

  function openStoredPreview(sessionId: string, attachmentId: string) {
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    const cached = previewCache()[`${sessionId}:${attachmentId}`];
    const meta = (sessionFiles()[sessionId] || []).find(
      (a) => a.id === attachmentId,
    );
    const name = cached?.name || meta?.name || "attachment";
    const mime = cached?.mime || meta?.mime || "";
    if (!cached) {
      if (opts.isOpen() && opts.isHostOnline()) {
        clearTimeout(previewTimer);
        const requestId = crypto.randomUUID();
        pendingPreview = { requestId, sessionId, attachmentId };
        opts.send({
          type: "get_attachment",
          requestId,
          sessionId,
          attachmentId,
        });
        previewTimer = setTimeout(
          () => failPreview(requestId, "Attachment preview timed out"),
          20000,
        );
      } else {
        opts.toast("Not connected to host", "err");
      }
      return;
    }
    if (mime.startsWith("image/")) {
      setPreviewFile({
        name,
        mime,
        dataUrl: cached.objectUrl,
        blob: cached.blob,
        size: meta?.size ?? cached.byteLength,
      });
      setPreviewCopied(false);
      return;
    }
    setPreviewFile({
      name,
      mime,
      text: cached.text ?? "(could not decode file)",
      blob: cached.blob,
      size: meta?.size ?? cached.byteLength,
    });
    setPreviewCopied(false);
  }

  let pendingPreview:
    | { requestId: string; sessionId: string; attachmentId: string }
    | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let currentHost = "";
  let currentSid: string | null = null;
  createEffect(() => {
    const host = opts.getHostId();
    const sid = opts.getSessionId();
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    setPreviewFile(null);
    if (host !== currentHost) {
      currentHost = host;
      currentSid = sid;
      clearPreviewCache();
      setSessionFiles({});
    } else if (currentSid !== null && sid !== currentSid) {
      currentSid = sid;
      pruneInactiveSessionFiles(sid);
    } else {
      currentSid = sid;
    }
  });
  onCleanup(() => {
    clearTimeout(previewTimer);
    revokeTransientPreviewUrl();
    clearPreviewCache();
  });
  function failPreview(requestId: string | undefined, message: string) {
    if (!requestId || pendingPreview?.requestId !== requestId) return false;
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    opts.toast(message, "err");
    return true;
  }
  // Relay broadcasts every response to all clients. Only the requesting view
  // may open the modal; out-of-order replies never replace a newer selection.
  function noteAttachmentData(msg: AttachmentDataEvent) {
    const a = msg.attachment;
    if (
      !a?.id ||
      typeof a.data !== "string" ||
      msg.requestId !== pendingPreview?.requestId ||
      msg.sessionId !== pendingPreview?.sessionId ||
      a.id !== pendingPreview?.attachmentId
    )
      return;
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    const key = `${msg.sessionId}:${a.id}`;
    const mime = String(a.mime || "application/octet-stream");
    const bytes = base64ToBytes(a.data);
    const byteLength = bytes.byteLength;
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    let text: string | undefined = typeof a.text === "string" ? a.text : undefined;
    if (text == null && !mime.startsWith("image/")) {
      try {
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        text = "(could not decode file)";
      }
    }
    setPreviewCache((prev) => {
      if (prev[key]) revokeEntry(prev[key]);
      const entries = Object.entries(prev).filter(([id]) => id !== key);
      // Bound retained preview bytes to 8 MiB across browsing sessions.
      let size = byteLength;
      const kept: [string, PreviewCacheItem][] = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const [id, value] = entries[i]!;
        if (size + value.byteLength > PREVIEW_CACHE_MAX_BYTES) {
          revokeEntry(value);
          continue;
        }
        size += value.byteLength;
        kept.push([id, value]);
      }
      const next: Record<string, PreviewCacheItem> = {};
      for (let i = kept.length - 1; i >= 0; i--) {
        const [id, value] = kept[i]!;
        next[id] = value;
      }
      next[key] = {
        name: a.name,
        mime,
        blob,
        objectUrl,
        byteLength,
        text,
      };
      return next;
    });
    openStoredPreview(msg.sessionId, a.id);
  }

  return {
    sessionFiles,
    noteSessionFiles,
    addSessionFile,
    purgeSessionFiles,
    pruneInactiveSessionFiles,
    previewCache,
    previewFile,
    setPreviewFile,
    previewCopied,
    setPreviewCopied,
    truncateTokens,
    setTruncateTokens,
    showTruncateInput,
    setShowTruncateInput,
    downloadPreviewFile,
    truncatePreviewFile,
    restorePreviewFile,
    previewPending,
    openStoredPreview,
    noteAttachmentData,
    failPreview,
  };
}

export type ReviewDomain = ReturnType<typeof createReview>;
