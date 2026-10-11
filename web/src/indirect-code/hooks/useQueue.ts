import { createSignal } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";
import type { QueuedMessage } from "../viewTypes";
import { createAttachmentDraft } from "./useAttachmentDraft";

/**
 * Message queue (per session).
 *
 * While a turn is running, new composer messages wait here instead of
 * being refused. The daemon owns the queue (persisted in the session
 * file) and broadcasts `session_queue`; `session_data` snapshots carry
 * it too. The head auto-starts when a turn completes normally — a
 * cancelled turn never drains.
 */
export function createQueue(opts: {
  send: (payload: DaemonCommand) => void;
  getSessionId: () => string;
  isOpen: () => boolean;
  isHostOnline: () => boolean;
  toast: (msg: string, kind?: "ok" | "err") => void;
}) {
  const [queues, setQueues] = createSignal<Record<string, QueuedMessage[]>>({});
  const [queueCollapsed, setQueueCollapsed] = createSignal<Record<string, boolean>>({});
  // Item being edited inline in the card (queueId -> draft text).
  const [editingQueueId, setEditingQueueId] = createSignal<string | null>(null);
  const [editingQueueText, setEditingQueueText] = createSignal("");

  function queueOf(sid: string): QueuedMessage[] {
    return queues()[sid] || [];
  }

  function noteQueue(sessionId: string | undefined, queue: unknown) {
    if (!sessionId || !Array.isArray(queue)) return;
    const list = (queue as any[]).map((q) => ({
      id: String(q.id || ""),
      text: String(q.text || ""),
      attachmentIds: Array.isArray(q.attachmentIds) ? q.attachmentIds.map(String) : [],
      model: String(q.model || ""),
      yolo: q.yolo === true,
      createdAt: typeof q.createdAt === "number" ? q.createdAt : 0,
    }));
    setQueues((prev) => ({ ...prev, [sessionId]: list }));
  }

  function purgeQueue(sessionId: string) {
    setQueues((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

  function addToQueue(text: string, attachmentIds: string[], model: string, yolo: boolean) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_add", sessionId: sid, text, model, yolo, attachmentIds });
  }

  function updateQueued(queueId: string, text: string, attachmentIds?: string[]) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    // Tri-state contract (daemon): omitted = attachments UNCHANGED (partial
    // update); [] = cleared; [ids] = full replacement. A text-only edit must
    // omit the field or the daemon replaces the set (dropping any id the
    // draft does not carry).
    opts.send(attachmentIds === undefined
      ? { type: "queue_update", sessionId: sid, queueId, text }
      : { type: "queue_update", sessionId: sid, queueId, text, attachmentIds });
    setEditingQueueId(null);
  }

  function removeQueued(queueId: string) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_remove", sessionId: sid, queueId });
    if (editingQueueId() === queueId) setEditingQueueId(null);
  }

  function sendNow(queueId: string) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_send_now", sessionId: sid, queueId });
    if (editingQueueId() === queueId) setEditingQueueId(null);
    opts.toast("Sending now — steering next step", "ok");
  }

  function toggleCollapsed(sid: string) {
    setQueueCollapsed((prev) => ({ ...prev, [sid]: !prev[sid] }));
  }

  // Draft for the item being edited (attachments upload, same pipeline
  // as the composer). Preloaded with the item's stored attachments as
  // serverIds so saving reuses them without re-uploading.
  const editDraft = createAttachmentDraft({
    send: opts.send,
    isOpen: opts.isOpen,
    toast: opts.toast,
  });

  function beginEdit(item: QueuedMessage, stored: { id: string; name: string; mime: string; size: number }[]) {
    setEditingQueueId(item.id);
    setEditingQueueText(item.text);
    // The item's own attachmentIds is the source of truth; `stored` only
    // supplies display metadata. Every id must be preloaded — dropping the
    // ones without metadata made the next save replace the set without them.
    const metaById = new Map(stored.map((a) => [a.id, a]));
    editDraft.setPendingAttachments(
      item.attachmentIds.map((id) => {
        const meta = metaById.get(id);
        return {
          key: crypto.randomUUID(),
          name: meta?.name ?? id,
          mime: meta?.mime ?? "",
          size: meta?.size ?? 0,
          dataB64: "",
          serverId: id,
          serverSessionId: opts.getSessionId(),
        };
      }),
    );
  }

  async function saveEdit(queueId: string): Promise<boolean> {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return false;
    const pending = editDraft.pendingAttachments();
    if (pending.some((a) => a.loading)) {
      opts.toast("Wait for files to finish extracting", "err");
      return false;
    }
    try {
      const ids = await Promise.all(pending.map((a) => editDraft.uploadOneAttachment(sid, a)));
      // Same membership as the item's stored list → text-only edit: omit the
      // field (partial update). Any change sends the FULL new list — the
      // daemon treats a present array as a full replacement (and [] clears).
      const current = queueOf(sid).find((q) => q.id === queueId);
      const unchanged = !!current && ids.length === current.attachmentIds.length &&
        ids.every((id) => current.attachmentIds.includes(id));
      updateQueued(queueId, editingQueueText(), unchanged ? undefined : ids);
      editDraft.clearAttachments();
      return true;
    } catch (e) {
      opts.toast(e instanceof Error ? e.message : "Attachment upload failed", "err");
      return false;
    }
  }

  return {
    queues, queueOf, queueCollapsed, toggleCollapsed,
    editingQueueId, setEditingQueueId, editingQueueText, setEditingQueueText,
    editDraft, beginEdit, saveEdit,
    noteQueue, purgeQueue, addToQueue, removeQueued, sendNow,
  };
}

export type Queue = ReturnType<typeof createQueue>;
