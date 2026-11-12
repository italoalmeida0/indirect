import { createSignal } from "solid-js";
import type { DaemonCommand, WireSessionOptions } from "../daemon-protocol";
import { normalizeMidTurnSend, type MidTurnDelivery } from "../utils/settingsValidation";
import type { QueuedMessage } from "../viewTypes";
import { createAttachmentDraft } from "./useAttachmentDraft";

function normalizeQueuedOptions(raw: unknown): WireSessionOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const skills = Array.isArray(r.skills)
    ? r.skills
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as any).name === "string")
        .map((s) => ({
          name: String(s.name),
          ...(typeof s.usable === "string" ? { usable: s.usable } : {}),
        }))
    : [];
  return {
    effort: typeof r.effort === "string" && r.effort ? r.effort : "medium",
    mode: typeof r.mode === "string" && r.mode ? r.mode : "talk",
    skills,
    access: typeof r.access === "string" && r.access ? r.access : "full",
  };
}

/**
 * Message queue (per session).
 *
 * While a turn is running, composer messages can wait in the passive queue,
 * stage for the next AI step ("steer"), or interrupt the active step
 * ("interrupt"). The daemon owns the queue (persisted in the session file)
 * and broadcasts `session_queue`; `session_data` snapshots carry it too.
 */
export function createQueue(opts: {
  send: (payload: DaemonCommand) => void;
  getSessionId: () => string;
  isOpen: () => boolean;
  isHostOnline: () => boolean;
  isSessionRunning?: () => boolean;
  toast: (msg: string, kind?: "ok" | "err") => void;
}) {
  const [queues, setQueues] = createSignal<Record<string, QueuedMessage[]>>({});
  const [queueCollapsed, setQueueCollapsed] = createSignal<Record<string, boolean>>({});
  // Item being edited inline in the card (queueId -> draft text).
  const [editingQueueId, setEditingQueueId] = createSignal<string | null>(null);
  const [editingQueueText, setEditingQueueText] = createSignal("");

  // Draft for the item being edited (attachments upload, same pipeline
  // as the composer). Preloaded with the item's stored attachments as
  // serverIds so saving reuses them without re-uploading.
  const editDraft = createAttachmentDraft({
    send: opts.send,
    isOpen: opts.isOpen,
    toast: opts.toast,
  });

  function queueOf(sid: string): QueuedMessage[] {
    return queues()[sid] || [];
  }

  function stagedItems(sid: string): QueuedMessage[] {
    return queueOf(sid).filter((q) => q.delivery === "steer" || q.delivery === "interrupt");
  }

  function passiveItems(sid: string): QueuedMessage[] {
    return queueOf(sid).filter((q) => q.delivery === "queue");
  }

  function noteQueue(sessionId: string | undefined, queue: unknown) {
    if (!sessionId || !Array.isArray(queue)) return;
    const list: QueuedMessage[] = (queue as any[]).map((q) => {
      const options = normalizeQueuedOptions(q?.options);
      return {
        id: String(q?.id || ""),
        text: String(q?.text || ""),
        attachmentIds: Array.isArray(q?.attachmentIds) ? q.attachmentIds.map(String) : [],
        model: String(q?.model || ""),
        yolo: q?.yolo === true,
        ...(options ? { options } : {}),
        createdAt: typeof q?.createdAt === "number" ? q.createdAt : 0,
        delivery: normalizeMidTurnSend(q?.delivery),
      };
    });
    setQueues((prev) => ({ ...prev, [sessionId]: list }));
    const editId = editingQueueId();
    if (editId && sessionId === opts.getSessionId()) {
      const stillPassive = list.some((item) => item.id === editId && item.delivery === "queue");
      if (!stillPassive) {
        setEditingQueueId(null);
        editDraft.clearAttachments();
      }
    }
  }

  function purgeQueue(sessionId: string) {
    setQueues((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    if (sessionId === opts.getSessionId() && editingQueueId()) {
      setEditingQueueId(null);
      editDraft.clearAttachments();
    }
  }

  function addToQueue(
    text: string,
    attachmentIds: string[],
    model: string,
    yolo: boolean,
    delivery?: MidTurnDelivery,
    options?: WireSessionOptions,
  ) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({
      type: "queue_add",
      sessionId: sid,
      text,
      model,
      yolo,
      attachmentIds,
      ...(delivery ? { delivery } : {}),
      ...(options ? { options } : {}),
    });
  }

  function updateQueued(queueId: string, text: string, attachmentIds?: string[]) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    // Tri-state contract (daemon): omitted = attachments UNCHANGED (partial
    // update); [] = cleared; [ids] = full replacement. A text-only edit must
    // omit the field or the daemon replaces the set (dropping any id the
    // draft does not carry).
    opts.send(
      attachmentIds === undefined
        ? { type: "queue_update", sessionId: sid, queueId, text }
        : { type: "queue_update", sessionId: sid, queueId, text, attachmentIds },
    );
    setEditingQueueId(null);
  }

  function removeQueued(queueId: string) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_remove", sessionId: sid, queueId });
    if (editingQueueId() === queueId) {
      setEditingQueueId(null);
      editDraft.clearAttachments();
    }
  }

  function sendNow(queueId: string) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_send_now", sessionId: sid, queueId });
    if (editingQueueId() === queueId) {
      setEditingQueueId(null);
      editDraft.clearAttachments();
    }
  }

  function cancelSend(queueId: string) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_cancel_send", sessionId: sid, queueId });
  }

  function interruptNow(queueId: string) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_interrupt_now", sessionId: sid, queueId });
    if (editingQueueId() === queueId) {
      setEditingQueueId(null);
      editDraft.clearAttachments();
    }
  }

  function moveQueued(queueId: string, dir: -1 | 1) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    const passive = passiveItems(sid);
    const idx = passive.findIndex((item) => item.id === queueId);
    const targetIdx = idx + dir;
    if (idx < 0 || targetIdx < 0 || targetIdx >= passive.length) return;
    const reordered = [...passive];
    const [moved] = reordered.splice(idx, 1);
    if (!moved) return;
    reordered.splice(targetIdx, 0, moved);
    const queueIds = [
      ...stagedItems(sid).map((item) => item.id),
      ...reordered.map((item) => item.id),
    ];
    opts.send({ type: "queue_reorder", sessionId: sid, queueIds });
  }

  function clearQueued() {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    opts.send({ type: "queue_clear", sessionId: sid });
    if (editingQueueId()) {
      setEditingQueueId(null);
      editDraft.clearAttachments();
    }
  }

  function toggleCollapsed(sid: string) {
    setQueueCollapsed((prev) => ({ ...prev, [sid]: !prev[sid] }));
  }

  function beginEdit(
    item: QueuedMessage,
    stored: { id: string; name: string; mime: string; size: number }[],
  ) {
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
      const ids = await Promise.all(
        pending.map((a) => editDraft.uploadOneAttachment(sid, a)),
      );
      // Same membership as the item's stored list → text-only edit: omit the
      // field (partial update). Any change sends the FULL new list — the
      // daemon treats a present array as a full replacement (and [] clears).
      const current = queueOf(sid).find((q) => q.id === queueId);
      const unchanged =
        !!current &&
        ids.length === current.attachmentIds.length &&
        ids.every((id) => current.attachmentIds.includes(id));
      updateQueued(queueId, editingQueueText(), unchanged ? undefined : ids);
      editDraft.clearAttachments();
      return true;
    } catch (e) {
      opts.toast(
        e instanceof Error ? e.message : "Attachment upload failed",
        "err",
      );
      return false;
    }
  }

  return {
    queues,
    queueOf,
    stagedItems,
    passiveItems,
    queueCollapsed,
    toggleCollapsed,
    editingQueueId,
    setEditingQueueId,
    editingQueueText,
    setEditingQueueText,
    editDraft,
    beginEdit,
    saveEdit,
    noteQueue,
    purgeQueue,
    addToQueue,
    removeQueued,
    sendNow,
    cancelSend,
    interruptNow,
    moveQueued,
    clearQueued,
  };
}

export type Queue = ReturnType<typeof createQueue>;
