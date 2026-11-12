import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { FileIcon } from "../presentation";
import { MsgIconBtn } from "./MsgActions";
import { Btn } from "../../ui";
import { useComposerCtx, useModal, useQueue, useSession, useTranscriptCtx, useUI } from "../ctx";

/**
 * Two-zone queued messages card.
 *
 * Lives at the bottom of the transcript (below the question panel), never
 * inside the composer:
 * - Zone 1 (Active Intermediate Staging): always visible when items are staged
 *   for the next AI step ("steer") or actively interrupting ("interrupt"),
 *   even if the passive queue below is collapsed.
 * - Zone 2 (Passive Queue): holds messages waiting for the turn to finish
 *   (or paused when idle), with promote, force-interrupt, reorder, inline edit,
 *   remove, and clear actions.
 */
export function QueueCard() {
  const q = useQueue();
  const m = useModal();
  const s = useSession();
  const t = useTranscriptCtx();
  const c = useComposerCtx();
  const ui = useUI();

  const sid = () => s.activeSessionId();
  const items = () => q.queueOf(sid());
  const staged = () => q.stagedItems(sid());
  const passive = () => q.passiveItems(sid());
  const collapsed = () => q.queueCollapsed()[sid()] ?? false;
  const isRunning = () => t.sessionStatus() === "running";
  const currentModel = () => c.activeModel?.() || s.activeSession?.()?.model || "";

  return (
    <Show when={items().length > 0}>
      <div class={`${ui.convWidthClass()} mx-auto space-y-2`} data-queue-card>
        {/* Zone 1: Active Intermediate Staging Zone (always visible even when passive queue is collapsed) */}
        <Show when={staged().length > 0}>
          <div class="space-y-2" data-queue-staged>
            <For each={staged()}>
              {(item) => (
                <Show
                  when={item.delivery === "interrupt"}
                  fallback={
                    <div
                      data-queue-item-state="steer"
                      class="rounded-xl border border-accent/35 bg-accent-subtle/40 px-3 py-2.5"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
                        <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                          <span
                            class="h-2 w-2 rounded-full bg-accent animate-pulse shrink-0"
                            aria-hidden="true"
                          />
                          <Iconify
                            icon="lucide:corner-down-right"
                            size={13}
                            class="text-accent shrink-0"
                          />
                          <span class="text-xs font-medium text-fg">
                            Sending on next step
                          </span>
                          <span class="text-[11px] text-fg-muted">
                            Leaves queue as soon as current step finishes
                          </span>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            data-action="queue-interrupt-now"
                            data-rc-tip="Interrupt current step and send immediately"
                            aria-label="Interrupt current step and send immediately"
                            onClick={() => q.interruptNow(item.id)}
                            class="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-fg hover:border-warning/40 hover:bg-warning-subtle hover:text-warning transition-colors cursor-pointer"
                          >
                            <Iconify icon="lucide:zap" size={12} class="text-warning shrink-0" />
                            <span>Send immediately</span>
                          </button>
                          <button
                            type="button"
                            data-action="queue-cancel-send"
                            data-rc-tip="Cancel send — return to queue"
                            aria-label="Cancel next-step send and return to queue"
                            onClick={() => q.cancelSend(item.id)}
                            class="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface text-fg-secondary hover:border-danger/35 hover:bg-danger-subtle hover:text-danger transition-colors cursor-pointer shrink-0"
                          >
                            <Iconify icon="lucide:x" size={14} />
                          </button>
                        </div>
                      </div>
                      <div class="mt-1.5 flex items-start gap-2 min-w-0">
                        <p class="flex-1 min-w-0 text-sm text-fg line-clamp-2 break-words">
                          {item.text || "(Attachment message)"}
                        </p>
                        <Show when={item.attachmentIds.length > 0}>
                          <span
                            data-rc-tip={`${item.attachmentIds.length} ${item.attachmentIds.length === 1 ? "attachment" : "attachments"}`}
                            class="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-fg-secondary shrink-0"
                          >
                            <Iconify icon="lucide:paperclip" size={10} />
                            {item.attachmentIds.length} {item.attachmentIds.length === 1 ? "file" : "files"}
                          </span>
                        </Show>
                      </div>
                    </div>
                  }
                >
                  <div
                    data-queue-item-state="interrupt"
                    class="rounded-xl border border-warning/40 bg-warning-subtle/45 px-3 py-2.5"
                  >
                    <div class="flex flex-wrap items-center gap-2 min-w-0">
                      <Iconify
                        icon="lucide:loader-2"
                        size={13}
                        class="animate-spin text-warning shrink-0"
                      />
                      <span class="text-xs font-medium text-warning">
                        Interrupting — sending immediately…
                      </span>
                    </div>
                    <div class="mt-1.5 flex items-start gap-2 min-w-0">
                      <p class="flex-1 min-w-0 text-sm text-fg line-clamp-2 break-words">
                        {item.text || "(Attachment message)"}
                      </p>
                      <Show when={item.attachmentIds.length > 0}>
                        <span
                          data-rc-tip={`${item.attachmentIds.length} ${item.attachmentIds.length === 1 ? "attachment" : "attachments"}`}
                          class="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-fg-secondary shrink-0"
                        >
                          <Iconify icon="lucide:paperclip" size={10} />
                          {item.attachmentIds.length} {item.attachmentIds.length === 1 ? "file" : "files"}
                        </span>
                      </Show>
                    </div>
                  </div>
                </Show>
              )}
            </For>
          </div>
        </Show>

        {/* Zone 2: Passive Queue Zone */}
        <Show when={passive().length > 0}>
          <div
            data-queue-passive
            class="rounded-xl border border-border/75 bg-surface-subtle/60 px-3 py-2"
          >
            <div class="flex items-center gap-2 min-w-0">
              <Iconify icon="lucide:list-end" size={13} class="text-fg-muted shrink-0" />
              <span class="text-xs font-medium text-fg shrink-0">
                Queued ({passive().length})
              </span>
              <span class="text-[11px] text-fg-muted truncate">
                · {isRunning() ? "Waits until turn finishes" : "Paused — ready to send"}
              </span>
              <span class="flex-1" />
              <Show when={passive().length >= 2}>
                <button
                  type="button"
                  data-action="queue-clear"
                  data-rc-tip="Clear queued messages"
                  aria-label="Clear queued messages"
                  onClick={() => q.clearQueued()}
                  class="rounded-md px-2 py-0.5 text-[11px] font-medium text-fg-muted hover:bg-danger-subtle hover:text-danger transition-colors cursor-pointer shrink-0"
                >
                  Clear
                </button>
              </Show>
              <button
                type="button"
                onClick={() => q.toggleCollapsed(sid())}
                class="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer shrink-0"
                data-rc-tip={collapsed() ? "Expand queue" : "Collapse queue"}
                aria-label={collapsed() ? "Expand queue" : "Collapse queue"}
              >
                <Iconify icon={collapsed() ? "lucide:chevron-up" : "lucide:chevron-down"} size={13} />
              </button>
            </div>
            <Show when={!collapsed()}>
              <div class="mt-1.5 pt-1.5 border-t border-border/60 flex flex-col divide-y divide-border/50">
                <For each={passive()}>
                  {(item, idx) => (
                    <div class="py-1.5 first:pt-0 last:pb-0" data-queue-item-state="queue">
                      <Show
                        when={q.editingQueueId() === item.id}
                        fallback={
                          <div class="flex flex-col sm:flex-row sm:items-center gap-1.5 min-w-0">
                            <div class="flex items-start sm:items-center gap-1.5 flex-1 min-w-0">
                              <span class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-fg-muted tabular-nums">
                                {`#${idx() + 1}`}
                              </span>
                              <span class="flex-1 min-w-0 text-sm text-fg line-clamp-2 sm:truncate break-words">
                                {item.text || "(Attachment message)"}
                              </span>
                              <Show when={item.attachmentIds.length > 0}>
                                <span
                                  data-rc-tip={`${item.attachmentIds.length} ${item.attachmentIds.length === 1 ? "attachment" : "attachments"}`}
                                  class="inline-flex items-center gap-1 rounded-md border border-border bg-surface-subtle px-1.5 py-0.5 text-[10px] font-mono text-fg-secondary shrink-0"
                                >
                                  <Iconify icon="lucide:paperclip" size={10} />
                                  {item.attachmentIds.length}
                                </span>
                              </Show>
                              <Show when={Boolean(item.model && currentModel() && item.model !== currentModel())}>
                                <span
                                  data-rc-tip={`Model override: ${item.model}`}
                                  class="inline-flex items-center rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-fg-muted max-w-28 truncate shrink-0"
                                >
                                  {item.model.split("/").pop() || item.model}
                                </span>
                              </Show>
                            </div>
                            <div class="flex items-center justify-end gap-0.5 shrink-0">
                              <Show
                                when={isRunning()}
                                fallback={
                                  <button
                                    type="button"
                                    data-action="queue-send-idle"
                                    data-rc-tip="Send message now"
                                    aria-label="Send message now"
                                    onClick={() => q.sendNow(item.id)}
                                    class="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-accent-subtle hover:text-accent transition-colors cursor-pointer"
                                  >
                                    <Iconify icon="lucide:play" size={13} />
                                  </button>
                                }
                              >
                                <button
                                  type="button"
                                  data-action="queue-send-next"
                                  data-rc-tip="Send on next AI step"
                                  aria-label="Send on next AI step"
                                  onClick={() => q.sendNow(item.id)}
                                  class="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-accent-subtle hover:text-accent transition-colors cursor-pointer"
                                >
                                  <Iconify icon="lucide:corner-up-right" size={13} />
                                </button>
                                <button
                                  type="button"
                                  data-action="queue-interrupt-now"
                                  data-rc-tip="Stop current step and send immediately"
                                  aria-label="Stop current step and send immediately"
                                  onClick={() => q.interruptNow(item.id)}
                                  class="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-warning-subtle hover:text-warning transition-colors cursor-pointer"
                                >
                                  <Iconify icon="lucide:zap" size={13} />
                                </button>
                              </Show>
                              <Show when={passive().length >= 2}>
                                <button
                                  type="button"
                                  data-action="queue-move-up"
                                  data-rc-tip="Move earlier in queue"
                                  aria-label="Move earlier in queue"
                                  disabled={idx() === 0}
                                  onClick={() => q.moveQueued(item.id, -1)}
                                  class="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-muted hover:text-fg disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer"
                                >
                                  <Iconify icon="lucide:chevron-up" size={13} />
                                </button>
                                <button
                                  type="button"
                                  data-action="queue-move-down"
                                  data-rc-tip="Move later in queue"
                                  aria-label="Move later in queue"
                                  disabled={idx() === passive().length - 1}
                                  onClick={() => q.moveQueued(item.id, 1)}
                                  class="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-muted hover:text-fg disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer"
                                >
                                  <Iconify icon="lucide:chevron-down" size={13} />
                                </button>
                              </Show>
                              <MsgIconBtn
                                tip="Edit queued message"
                                icon="lucide:pencil"
                                compact
                                onClick={() => q.beginEdit(item, m.sessionFiles?.()[sid()] || [])}
                              />
                              <MsgIconBtn
                                tip="Remove from queue"
                                icon="lucide:trash-2"
                                compact
                                danger
                                onClick={() => q.removeQueued(item.id)}
                              />
                            </div>
                          </div>
                        }
                      >
                        <QueueEditRow queueId={item.id} />
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function QueueEditRow(props: { queueId: string }) {
  const q = useQueue();
  const m = useModal();
  const s = useSession();
  let fileRef: HTMLInputElement | undefined;

  return (
    <div class="flex flex-col gap-2 py-0.5">
      <textarea
        value={q.editingQueueText()}
        onInput={(e) => q.setEditingQueueText(e.currentTarget.value)}
        rows={2}
        class="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-fg resize-y focus:outline-none focus:border-accent placeholder:text-fg-muted transition-colors"
      />
      <Show when={q.editDraft.pendingAttachments().length > 0}>
        <div class="flex flex-wrap gap-1.5">
          <For each={q.editDraft.pendingAttachments()}>
            {(a) => (
              <span class="flex items-center gap-1 text-[11px] bg-surface-subtle border border-border px-2 py-1 rounded-lg text-fg-secondary">
                <FileIcon path={a.name} size={13} />
                <button
                  type="button"
                  data-rc-tip="Open preview"
                  onClick={() =>
                    a.serverId
                      ? m.openStoredPreview(s.activeSessionId(), a.serverId)
                      : m.previewPending(a)
                  }
                  class="hover:underline truncate max-w-40 cursor-pointer"
                >
                  {a.name}
                </button>
                <button
                  type="button"
                  data-rc-tip="Remove attachment"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => q.editDraft.removePendingAttachment(a.key)}
                  class="cursor-pointer px-0.5 text-fg-muted hover:text-danger transition-colors"
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          class="hidden"
          onChange={(e) => {
            if (e.currentTarget.files) q.editDraft.handleFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
        <MsgIconBtn
          tip="Add attachments"
          icon="lucide:paperclip"
          compact
          onClick={() => fileRef?.click()}
        />
        <span class="flex-1" />
        <Btn
          variant="outline"
          size="sm"
          onClick={() => {
            q.setEditingQueueId(null);
            q.editDraft.clearAttachments();
          }}
        >
          Cancel
        </Btn>
        <Btn size="sm" onClick={() => void q.saveEdit(props.queueId)}>
          Save
        </Btn>
      </div>
    </div>
  );
}
