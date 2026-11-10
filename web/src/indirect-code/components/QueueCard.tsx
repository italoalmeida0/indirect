import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { FileIcon } from "../presentation";
import { MsgIconBtn } from "./MsgActions";
import { Btn } from "../../ui";
import { useModal, useQueue, useSession, useUI } from "../ctx";

/**
 * Queued messages card.
 *
 * Lives at the bottom of the transcript (below the question panel),
 * never in the composer. While a turn runs, composer sends land here;
 * when a turn completes normally the head auto-starts. Each row offers
 * send-now (cancels the turn and sends immediately), edit (text +
 * attachments) and delete.
 */
export function QueueCard() {
  const q = useQueue();
  const m = useModal();
  const s = useSession();
  const ui = useUI();

  const sid = () => s.activeSessionId();
  const items = () => q.queueOf(sid());
  const collapsed = () => q.queueCollapsed()[sid()] ?? false;

  return (
    <Show when={items().length > 0}>
      <div class={`${ui.convWidthClass()} mx-auto`}>
        <div class="rounded-xl border border-border/75 bg-surface-subtle/60 px-3 py-2">
          <div class="flex items-center gap-2">
            <Iconify icon="lucide:list-end" size={13} class="text-fg-muted shrink-0" />
            <span class="text-xs font-medium text-fg">Queued Messages</span>
            <span class="font-mono text-[11px] text-fg-muted tabular-nums">
              ({items().length})
            </span>
            <span class="text-[11px] text-fg-muted hidden sm:inline">· Sends after current turn</span>
            <span class="flex-1" />
            <button
              type="button"
              onClick={() => q.toggleCollapsed(sid())}
              class="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
              aria-label={collapsed() ? "Expand queue" : "Collapse queue"}
            >
              <Iconify icon={collapsed() ? "lucide:chevron-up" : "lucide:chevron-down"} size={13} />
            </button>
          </div>
          <Show when={!collapsed()}>
            <div class="mt-1.5 pt-1.5 border-t border-border/60 flex flex-col divide-y divide-border/50">
              <For each={items()}>
                {(item) => (
                  <div class="py-1.5 first:pt-0 last:pb-0">
                    <Show
                      when={q.editingQueueId() === item.id}
                      fallback={
                        <div class="flex items-center gap-1.5 min-w-0">
                          <span class="flex-1 truncate text-sm text-fg">{item.text}</span>
                          <Show when={item.attachmentIds.length > 0}>
                            <span class="inline-flex items-center gap-1 rounded-md border border-border bg-surface-subtle px-1.5 py-0.5 text-[10px] font-mono text-fg-secondary shrink-0">
                              <Iconify icon="lucide:paperclip" size={10} />
                              {item.attachmentIds.length}
                            </span>
                          </Show>
                          <MsgIconBtn tip="Send now (steers next step)" icon="lucide:arrow-right" compact onClick={() => q.sendNow(item.id)} />
                          <MsgIconBtn tip="Edit queued message" icon="lucide:pencil" compact onClick={() => q.beginEdit(item, m.sessionFiles()[sid()] || [])} />
                          <MsgIconBtn tip="Remove from queue" icon="lucide:trash-2" compact danger onClick={() => q.removeQueued(item.id)} />
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
                  onClick={() => a.serverId ? m.openStoredPreview(s.activeSessionId(), a.serverId) : m.previewPending(a)}
                  class="hover:underline truncate max-w-40 cursor-pointer"
                >
                  {a.name}
                </button>
                <button
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
        <MsgIconBtn tip="Add attachments" icon="lucide:paperclip" compact onClick={() => fileRef?.click()} />
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
        <Btn
          size="sm"
          onClick={() => void q.saveEdit(props.queueId)}
        >
          Save
        </Btn>
      </div>
    </div>
  );
}
