import { createSignal, onCleanup } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";
import type { PendingAttachment, StoredAttachment } from "../viewTypes";

export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

export interface WidgetAttachmentInput {
  owner: string;
  slot?: string;
  name: string;
  mime: string;
  content?: string;
  dataUrl?: string;
}

export interface WidgetAttachmentResult {
  ok: boolean;
  updated: boolean;
  error?: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function hasValidImageMagic(mime: string, bytes: Uint8Array): boolean {
  if (mime === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return false;
}

function decodeImageDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array; b64: string } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  const mime = match[1]!;
  const b64 = match[2]!;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!hasValidImageMagic(mime, bytes)) return null;
    return { mime, bytes, b64 };
  } catch {
    return null;
  }
}

/** Owns one draft's asynchronous reads, object URLs and correlated uploads. */
export function createAttachmentDraft(opts: {
  send: (command: DaemonCommand) => void;
  isOpen: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
  additionalCount?: () => number;
}) {
  const [pendingAttachments, setPendingAttachments] = createSignal<
    PendingAttachment[]
  >([]);
  const [preparingAttachments, setPreparingAttachments] = createSignal(0);
  let inFlightBytes = 0;
  let epoch = 0;
  const waiters = new Map<
    string,
    {
      key: string;
      sid: string;
      promise: Promise<string>;
      ok: (id: string) => void;
      fail: (reason: string) => void;
    }
  >();

  async function handleFiles(files: FileList | File[]) {
    const generation = epoch;
    // Reserve slots before the first await, including simultaneous paste/drop events.
    const currentCount =
      pendingAttachments().length +
      preparingAttachments() +
      (opts.additionalCount?.() || 0);
    const room = Math.max(0, MAX_ATTACHMENTS - currentCount);
    if (room <= 0) {
      opts.toast(`Max ${MAX_ATTACHMENTS} attachments per message`, "err");
      return;
    }
    // Trim instead of rejecting the batch: dropping twenty files with ten slots
    // free must attach the ten that fit, not discard the whole gesture. Slicing
    // before any await keeps the reservation made above authoritative.
    const list = Array.from(files).slice(0, room);
    if (!list.length) return;
    if (list.length < files.length) {
      opts.toast(`Only ${room} more attachment${room === 1 ? "" : "s"} fit in this message`, "err");
    }
    const currentBytes = pendingAttachments().reduce(
      (sum, a) => sum + (a.size || 0),
      0,
    );
    const incomingBytes = list.reduce(
      (sum, f) => sum + (f.size || 0),
      0,
    );
    if (currentBytes + inFlightBytes + incomingBytes > MAX_TOTAL_BYTES) {
      opts.toast("Total attachments exceed 25MB limit", "err");
      return;
    }
    setPreparingAttachments((n) => n + list.length);
    inFlightBytes += incomingBytes;
    try {
      const { sniffFile, extractText, uint8ToB64 } = await import(
        "../../office"
      );
      for (const file of list) {
        if (generation !== epoch) return;
        try {
          if (file.size > MAX_ATTACHMENT_BYTES)
            throw new Error(`'${file.name}' too large (max 4MB)`);
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (generation !== epoch) return;
          const sniff = sniffFile(file, bytes);
          if (sniff.blocked) throw new Error(sniff.blocked);
          const isImage = sniff.kind === "image";
          if (isImage && bytes.length > MAX_IMAGE_BYTES)
            throw new Error(`'${file.name}' too large (max 2.5MB for images)`);
          const text = isImage
            ? undefined
            : await extractText(bytes, file.name, sniff.officeFormat);
          if (generation !== epoch) return;
          setPendingAttachments((prev) => [
            ...prev,
            {
              key: crypto.randomUUID(),
              name: file.name,
              mime: sniff.mime || file.type || "text/plain",
              size: bytes.length,
              dataB64: uint8ToB64(bytes),
              text,
              objectUrl: isImage
                ? URL.createObjectURL(
                    new Blob([bytes], { type: sniff.mime || file.type }),
                  )
                : undefined,
            },
          ]);
        } catch (e) {
          if (generation === epoch)
            opts.toast(
              e instanceof Error ? e.message : `Could not read '${file.name}'`,
              "err",
            );
        } finally {
          inFlightBytes = Math.max(0, inFlightBytes - file.size);
          if (generation === epoch)
            setPreparingAttachments((n) => Math.max(0, n - 1));
        }
      }
    } catch (e) {
      if (generation === epoch) {
        inFlightBytes = 0;
        setPreparingAttachments(0);
        opts.toast(
          e instanceof Error ? e.message : "Could not load file conversion",
          "err",
        );
      }
    }
  }

  function removePendingAttachment(key: string) {
    for (const w of waiters.values())
      if (w.key === key) w.fail("Attachment removed");
    const hit = pendingAttachments().find((p) => p.key === key);
    if (hit?.objectUrl) URL.revokeObjectURL(hit.objectUrl);
    setPendingAttachments((prev) => prev.filter((p) => p.key !== key));
  }

  /** Attach or update in-place a Generative UI widget payload in the composer draft. */
  function upsertWidgetAttachment(input: WidgetAttachmentInput): WidgetAttachmentResult {
    const owner = input.owner.trim();
    if (!owner) return { ok: false, updated: false, error: "Invalid widget owner" };
    const slot = input.slot?.trim() || undefined;
    const prevList = pendingAttachments();
    // Match strictly by (widgetOwner, widgetSlot) tuple — never a delimited
    // string key that can collide when widget_id or slot contains ':'.
    const existing = slot
      ? prevList.find((p) => p.widgetOwner === owner && p.widgetSlot === slot)
      : undefined;

    let bytes: Uint8Array;
    let mime: string;
    let dataB64: string;
    let text: string | undefined;
    let isImage = false;

    if (input.dataUrl) {
      const decoded = decodeImageDataUrl(input.dataUrl);
      if (!decoded) {
        opts.toast("Unsupported widget image attachment", "err");
        return { ok: false, updated: false, error: "Unsupported image format" };
      }
      if (decoded.bytes.length === 0 || decoded.bytes.length > MAX_IMAGE_BYTES) {
        const msg = `'${input.name}' too large (max 2.5MB for images)`;
        opts.toast(msg, "err");
        return { ok: false, updated: false, error: msg };
      }
      bytes = decoded.bytes;
      mime = decoded.mime;
      dataB64 = decoded.b64;
      isImage = true;
    } else if (typeof input.content === "string") {
      bytes = new TextEncoder().encode(input.content);
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
        const msg = `'${input.name}' too large (max 4MB)`;
        opts.toast(msg, "err");
        return { ok: false, updated: false, error: msg };
      }
      mime = input.mime || "text/plain";
      dataB64 = uint8ToBase64(bytes);
      text = input.content;
    } else {
      return { ok: false, updated: false, error: "Missing attachment content" };
    }

    if (!existing) {
      const currentCount =
        prevList.length + preparingAttachments() + (opts.additionalCount?.() || 0);
      if (currentCount >= MAX_ATTACHMENTS) {
        const msg = `Max ${MAX_ATTACHMENTS} attachments per message`;
        opts.toast(msg, "err");
        return { ok: false, updated: false, error: msg };
      }
    }

    const currentBytes = prevList.reduce((sum, a) => sum + (a.size || 0), 0);
    const nextTotal = currentBytes - (existing?.size || 0) + inFlightBytes + bytes.length;
    if (nextTotal > MAX_TOTAL_BYTES) {
      const msg = "Total attachments exceed 25MB limit";
      opts.toast(msg, "err");
      return { ok: false, updated: false, error: msg };
    }

    // Mint a fresh key on every revision so an in-flight sendPrompt() detects
    // the mid-send mutation and never sends stale bytes or deletes the newer revision.
    const nextKey = crypto.randomUUID();
    if (existing) {
      for (const w of waiters.values()) {
        if (w.key === existing.key) w.fail("Attachment updated");
      }
      if (existing.objectUrl) {
        try {
          URL.revokeObjectURL(existing.objectUrl);
        } catch {}
      }
    }

    let objectUrl: string | undefined;
    if (isImage && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    }

    const nextEntry: PendingAttachment = {
      key: nextKey,
      name: input.name,
      mime,
      size: bytes.length,
      dataB64,
      text,
      objectUrl,
      widgetOwner: owner,
      widgetSlot: slot,
      updatedAt: Date.now(),
    };

    if (existing) {
      const prevKey = existing.key;
      setPendingAttachments((prev) => prev.map((p) => (p.key === prevKey ? nextEntry : p)));
      return { ok: true, updated: true };
    }
    setPendingAttachments((prev) => [...prev, nextEntry]);
    return { ok: true, updated: false };
  }

  /** Remove one keyed attachment (or all attachments) owned by a widget. */
  function removeWidgetAttachment(owner: string, slot?: string): boolean {
    const cleanOwner = owner.trim();
    if (!cleanOwner) return false;
    const cleanSlot = slot?.trim() || undefined;
    const targets = pendingAttachments().filter(
      (p) => p.widgetOwner === cleanOwner && (cleanSlot ? p.widgetSlot === cleanSlot : true),
    );
    if (!targets.length) return false;
    const removeKeys = new Set(targets.map((t) => t.key));
    for (const w of waiters.values()) {
      if (removeKeys.has(w.key)) w.fail("Attachment removed");
    }
    for (const t of targets) {
      if (t.objectUrl) {
        try {
          URL.revokeObjectURL(t.objectUrl);
        } catch {}
      }
    }
    setPendingAttachments((prev) => prev.filter((p) => !removeKeys.has(p.key)));
    return true;
  }

  function uploadOneAttachment(
    sid: string,
    a: PendingAttachment,
  ): Promise<string> {
    if (a.serverId && a.serverSessionId === sid)
      return Promise.resolve(a.serverId);
    for (const w of waiters.values())
      if (w.key === a.key && w.sid === sid) return w.promise;
    if (!opts.isOpen())
      return Promise.reject(new Error("Reconnect the host before uploading"));
    const requestId = a.uploadKey || crypto.randomUUID();
    let ok!: (id: string) => void;
    let fail!: (reason: string) => void;
    const promise = new Promise<string>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(requestId);
        setPendingAttachments((prev) =>
          prev.map((p) => (p.key === a.key ? { ...p, uploading: false } : p)),
        );
      };
      const timer = setTimeout(
        () => fail(`Upload timed out for '${a.name}'`),
        20000,
      );
      ok = (id) => {
        finish();
        resolve(id);
      };
      fail = (reason) => {
        finish();
        reject(new Error(reason));
      };
    });
    waiters.set(requestId, { key: a.key, sid, promise, ok, fail });
    setPendingAttachments((prev) =>
      prev.map((p) =>
        p.key === a.key ? { ...p, uploading: true, uploadKey: requestId } : p,
      ),
    );
    try {
      opts.send({
        type: "upload_attachment",
        requestId,
        sessionId: sid,
        name: a.name,
        mime: a.mime,
        data: a.dataB64,
        text:
          a.text == null
            ? undefined
            : Array.from(a.text)
                .slice(0, 512 * 1024)
                .join(""),
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Upload failed");
    }
    return promise;
  }

  function noteAttachmentUploaded(
    requestId: string | undefined,
    a: StoredAttachment,
    sid?: string,
  ) {
    const w = requestId ? waiters.get(requestId) : undefined;
    if (!w || sid !== w.sid || !a.id) return false;
    setPendingAttachments((prev) =>
      prev.map((p) =>
        p.key === w.key ? { ...p, serverId: a.id, serverSessionId: sid } : p,
      ),
    );
    w.ok(a.id);
    return true;
  }
  function failUpload(requestId: string | undefined, message: string) {
    const w = requestId ? waiters.get(requestId) : undefined;
    if (!w) return false;
    w.fail(message);
    return true;
  }
  function cancelUploads(
    message = "Upload interrupted. Reconnect and send again.",
  ) {
    for (const w of waiters.values()) w.fail(message);
  }
  function clearAttachments() {
    epoch++;
    inFlightBytes = 0;
    cancelUploads("Attachment draft changed");
    for (const p of pendingAttachments())
      if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
    setPendingAttachments([]);
    setPreparingAttachments(0);
  }
  onCleanup(clearAttachments);
  return {
    pendingAttachments,
    setPendingAttachments,
    preparingAttachments,
    handleFiles,
    removePendingAttachment,
    upsertWidgetAttachment,
    removeWidgetAttachment,
    uploadOneAttachment,
    noteAttachmentUploaded,
    failUpload,
    cancelUploads,
    clearAttachments,
  };
}
