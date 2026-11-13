import { createSignal } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";
import type { ChatMessage, ContentBlock } from "../types";

export const DEFAULT_BLOB_URL_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export function base64ToBytes(raw: string): Uint8Array {
  const comma = raw.startsWith("data:") ? raw.indexOf(",") : -1;
  const clean = (comma >= 0 ? raw.slice(comma + 1) : raw).replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function fastInlineBlobKey(base64: string, mediaType = "image/jpeg"): string {
  const len = base64.length;
  const head = base64.slice(0, 24);
  const mid = len > 48 ? base64.slice(len >> 1, (len >> 1) + 24) : "";
  const tail = len > 24 ? base64.slice(-24) : "";
  let hash = 2166136261;
  const sample = `${mediaType}|${len}|${head}|${mid}|${tail}`;
  for (let i = 0; i < sample.length; i++) {
    hash ^= sample.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `inline:${len}:${(hash >>> 0).toString(16)}`;
}

interface CacheEntry {
  url: string;
  bytes: number;
  mediaType: string;
  sessions?: Set<string>;
}

interface InFlightBlob {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  sessions: Set<string>;
  hadSession: boolean;
}

export interface BlobUrlCacheOptions {
  maxBytes?: number;
  requestTimeoutMs?: number;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

export function createBlobUrlCache(options: BlobUrlCacheOptions = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_BLOB_URL_CACHE_MAX_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const createUrl =
    options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl =
    options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));

  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlightBlob>();
  const failedShas = new Set<string>();
  const evictedSessions = new Set<string>();
  let currentBytes = 0;
  let reqSeq = 0;

  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  function noteActiveSession(sessionId?: string) {
    if (sessionId) evictedSessions.delete(sessionId);
  }

  function rememberEvictedSession(sessionId: string) {
    evictedSessions.delete(sessionId);
    evictedSessions.add(sessionId);
    while (evictedSessions.size > 256) {
      const oldest = evictedSessions.values().next().value;
      if (oldest === undefined) break;
      evictedSessions.delete(oldest);
    }
  }

  function touch(key: string, entry: CacheEntry) {
    entries.delete(key);
    entries.set(key, entry);
  }

  function evictToFit(incomingBytes: number) {
    while (entries.size > 0 && currentBytes + incomingBytes > maxBytes) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = entries.get(oldestKey);
      entries.delete(oldestKey);
      if (oldest) {
        currentBytes = Math.max(0, currentBytes - oldest.bytes);
        try {
          revokeUrl(oldest.url);
        } catch {}
      }
    }
  }

  function get(key: string, sessionId?: string): string | undefined {
    version();
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (sessionId) {
      noteActiveSession(sessionId);
      if (!entry.sessions) entry.sessions = new Set();
      entry.sessions.add(sessionId);
    }
    touch(key, entry);
    return entry.url;
  }

  function peek(key: string): string | undefined {
    return entries.get(key)?.url;
  }

  function putBytes(
    key: string,
    bytes: Uint8Array,
    mediaType = "application/octet-stream",
    sessionId?: string,
  ): string {
    noteActiveSession(sessionId);
    const existing = entries.get(key);
    if (existing) {
      if (sessionId) {
        if (!existing.sessions) existing.sessions = new Set();
        existing.sessions.add(sessionId);
      }
      touch(key, existing);
      return existing.url;
    }
    const byteLength = bytes.byteLength;
    evictToFit(byteLength);
    const blob = new Blob([bytes as BlobPart], {
      type: mediaType || "application/octet-stream",
    });
    const url = createUrl(blob);
    const sessions = sessionId ? new Set([sessionId]) : undefined;
    entries.set(key, { url, bytes: byteLength, mediaType, sessions });
    currentBytes += byteLength;
    bump();
    return url;
  }

  function putBase64(
    key: string,
    base64: string,
    mediaType = "image/jpeg",
    sessionId?: string,
  ): string {
    noteActiveSession(sessionId);
    const existing = entries.get(key);
    if (existing) {
      if (sessionId) {
        if (!existing.sessions) existing.sessions = new Set();
        existing.sessions.add(sessionId);
      }
      touch(key, existing);
      return existing.url;
    }
    const bytes = base64ToBytes(base64);
    return putBytes(key, bytes, mediaType, sessionId);
  }

  function evict(key: string): boolean {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    currentBytes = Math.max(0, currentBytes - entry.bytes);
    try {
      revokeUrl(entry.url);
    } catch {}
    bump();
    return true;
  }

  function evictSession(sessionId: string): number {
    if (!sessionId) return 0;
    rememberEvictedSession(sessionId);
    let cancelledFlight = false;
    for (const [sha, pending] of [...inFlight.entries()]) {
      if (!pending.sessions.has(sessionId)) continue;
      pending.sessions.delete(sessionId);
      if (pending.hadSession && pending.sessions.size === 0) {
        clearTimeout(pending.timer);
        inFlight.delete(sha);
        cancelledFlight = true;
      }
    }
    if (entries.size === 0) {
      if (cancelledFlight) bump();
      return 0;
    }
    let removed = 0;
    for (const [key, entry] of [...entries.entries()]) {
      if (!entry.sessions?.has(sessionId)) continue;
      entry.sessions.delete(sessionId);
      if (entry.sessions.size === 0) {
        entries.delete(key);
        currentBytes = Math.max(0, currentBytes - entry.bytes);
        try {
          revokeUrl(entry.url);
        } catch {}
        removed++;
      }
    }
    if (removed > 0 || cancelledFlight) bump();
    return removed;
  }

  function clear() {
    for (const pending of inFlight.values()) {
      clearTimeout(pending.timer);
    }
    inFlight.clear();
    failedShas.clear();
    evictedSessions.clear();
    if (entries.size === 0) return;
    for (const entry of entries.values()) {
      try {
        revokeUrl(entry.url);
      } catch {}
    }
    entries.clear();
    currentBytes = 0;
    bump();
  }

  function requestBlob(
    sha256: string,
    send?: (cmd: DaemonCommand) => void,
    sessionId?: string,
  ): string | undefined {
    if (!sha256) return undefined;
    noteActiveSession(sessionId);
    const key = `sha256:${sha256}`;
    const cached = get(key, sessionId);
    if (cached) return cached;
    const existingFlight = inFlight.get(sha256);
    if (existingFlight) {
      if (sessionId) {
        existingFlight.sessions.add(sessionId);
        existingFlight.hadSession = true;
      }
      return undefined;
    }
    if (!send || failedShas.has(sha256)) {
      return undefined;
    }
    const requestId = `blob_${++reqSeq}`;
    const timer = setTimeout(() => {
      const cur = inFlight.get(sha256);
      if (cur?.requestId === requestId) {
        inFlight.delete(sha256);
        bump();
      }
    }, requestTimeoutMs);
    inFlight.set(sha256, {
      requestId,
      timer,
      sessions: sessionId ? new Set([sessionId]) : new Set(),
      hadSession: Boolean(sessionId),
    });
    send({
      type: "get_blob",
      sha256,
      requestId,
      ...(sessionId ? { sessionId } : {}),
    });
    return undefined;
  }

  function noteBlobData(msg: {
    sha256?: string;
    requestId?: string;
    sessionId?: string;
    mediaType?: string;
    mimeType?: string;
    data?: string;
    error?: string;
  }): string | undefined {
    let sha = typeof msg.sha256 === "string" ? msg.sha256 : "";
    if (!sha && msg.requestId) {
      for (const [candidate, pending] of inFlight.entries()) {
        if (pending.requestId === msg.requestId) {
          sha = candidate;
          break;
        }
      }
    }
    if (!sha) return undefined;
    const pending = inFlight.get(sha);
    if (pending) {
      clearTimeout(pending.timer);
      inFlight.delete(sha);
    }
    if (msg.error || typeof msg.data !== "string" || !msg.data) {
      if (msg.error && msg.error !== "Host busy") {
        failedShas.add(sha);
      }
      bump();
      return undefined;
    }
    const sessionsToAttach = new Set<string>();
    if (pending) {
      for (const sid of pending.sessions) {
        if (!evictedSessions.has(sid)) sessionsToAttach.add(sid);
      }
    }
    if (typeof msg.sessionId === "string" && msg.sessionId) {
      if (!evictedSessions.has(msg.sessionId)) {
        sessionsToAttach.add(msg.sessionId);
      } else if (!pending) {
        return undefined;
      }
    }
    if (pending?.hadSession && sessionsToAttach.size === 0) {
      return undefined;
    }
    failedShas.delete(sha);
    const mediaType = msg.mediaType || msg.mimeType || "image/png";
    const key = `sha256:${sha}`;
    const firstSid = sessionsToAttach.values().next().value;
    const url = putBase64(key, msg.data, mediaType, firstSid);
    if (sessionsToAttach.size > 1) {
      const entry = entries.get(key);
      if (entry) {
        if (!entry.sessions) entry.sessions = new Set();
        for (const sid of sessionsToAttach) entry.sessions.add(sid);
      }
    }
    return url;
  }

  function internContentBlock(block: ContentBlock, sessionId?: string): ContentBlock {
    if (block.type !== "image" || !block.imageData) return block;
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return block;
    }
    const mime = block.imageMime || "image/jpeg";
    const key = block.imageSha256
      ? `sha256:${block.imageSha256}`
      : block.blobKey || fastInlineBlobKey(block.imageData, mime);
    try {
      putBase64(key, block.imageData, mime, sessionId);
      const next: ContentBlock = {
        ...block,
        blobKey: key,
      };
      delete next.imageData;
      return next;
    } catch {
      return block;
    }
  }

  function internMessages(messages: ChatMessage[], sessionId?: string): ChatMessage[] {
    let mutatedAny = false;
    const out = messages.map((m) => {
      let blockMutated = false;
      const nextBlocks = m.blocks.map((b) => {
        if (b.type !== "image" || !b.imageData) return b;
        const nextB = internContentBlock(b, sessionId);
        if (nextB !== b) blockMutated = true;
        return nextB;
      });
      if (!blockMutated) return m;
      mutatedAny = true;
      return { ...m, blocks: nextBlocks };
    });
    return mutatedAny ? out : messages;
  }

  function resolveImageBlock(
    block: ContentBlock,
    send?: (cmd: DaemonCommand) => void,
    sessionId?: string,
  ): string | undefined {
    version();
    if (block.blobKey) {
      const hit = get(block.blobKey, sessionId);
      if (hit) return hit;
    }
    if (block.imageSha256) {
      const hit = get(`sha256:${block.imageSha256}`, sessionId);
      if (hit) return hit;
    }
    if (block.imageData) {
      const mime = block.imageMime || "image/jpeg";
      const key = block.imageSha256
        ? `sha256:${block.imageSha256}`
        : block.blobKey || fastInlineBlobKey(block.imageData, mime);
      try {
        const url = putBase64(key, block.imageData, mime, sessionId);
        block.blobKey = key;
        block.imageData = undefined;
        return url;
      } catch {
        return `data:${mime};base64,${block.imageData}`;
      }
    }
    if (block.imageSha256) {
      return requestBlob(block.imageSha256, send, sessionId);
    }
    return undefined;
  }

  return {
    get,
    peek,
    putBytes,
    putBase64,
    evict,
    evictSession,
    clear,
    requestBlob,
    noteBlobData,
    internContentBlock,
    internMessages,
    resolveImageBlock,
    totalBytes: () => currentBytes,
    size: () => entries.size,
    maxBytes,
    version,
    isLoading: (sha256: string) => {
      version();
      return inFlight.has(sha256);
    },
  };
}

export type BlobUrlCache = ReturnType<typeof createBlobUrlCache>;

export const sharedBlobUrlCache = createBlobUrlCache();
