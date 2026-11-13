import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { shimmerPhaseStyle } from "../../ds/motion/shimmer";
import { FileIcon } from "../presentation";
import { MsgIconBtn } from "./MsgActions";
import { Btn } from "../../ui";
import { useComposerCtx, useModal, useQueue, useSession, useTranscriptCtx, useUI } from "../ctx";
import type { QueuedMessage } from "../viewTypes";

/**
 * Transcript staging zone:
 * Renders armed `Next step` ("steer") / `Sending now…` ("interrupt") items
 * as a right-aligned pending user chat bubble matching the user's own sent
 * bubbles. Passive `Queued` items dock onto `.rc-composer` via
 * `ComposerQueueShelf` below.
 */
export function QueueCard() {
  const q = useQueue();
  const s = useSession();
  const ui = useUI();

  const sid = () => s.activeSessionId();
  const staged = () => q.stagedItems?.(sid()) ?? [];

  return (
    <Show when={staged().length > 0}>
      <div
        class={`w-full ${ui.convWidthClass()} mx-auto pt-1 flex flex-col items-end gap-1.5`}
        data-queue-card
        data-queue-staged
      >
        <For each={staged()}>
          {(item) => (
            <div
              data-queue-item-state={item.delivery === "interrupt" ? "interrupt" : "steer"}
              class="ml-auto w-fit max-w-[94%] sm:max-w-[86%] overflow-hidden rounded-panel border border-dashed border-border-strong bg-surface px-3.5 py-2"
            >
              <div class="flex items-center gap-2 min-w-0">
                <Show
                  when={item.delivery === "interrupt"}
                  fallback={
                    <span
                      class="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-2xs font-medium text-accent shrink-0"
                      data-rc-tip="Sends automatically when current step finishes"
                    >
                      <Iconify icon="lucide:corner-down-right" size={10} />
                      Next step
                    </span>
                  }
                >
                  <span class="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-2xs font-medium text-accent shrink-0">
                    <Iconify icon="lucide:zap" size={10} />
                    <span class="ui-shimmer ui-shimmer-accent font-medium" style={shimmerPhaseStyle(true)}>Sending now…</span>
                  </span>
                </Show>
                <span
                  class="text-[13px] text-fg truncate min-w-0"
                  data-rc-tip={item.text && item.text.length > 60 ? item.text : undefined}
                >
                  {item.text || "(Attachment message)"}
                </span>
                <Show when={item.attachmentIds.length > 0}>
                  <span
                    data-rc-tip={`${item.attachmentIds.length} ${item.attachmentIds.length === 1 ? "attachment" : "attachments"}`}
                    class="shrink-0 inline-flex items-center gap-1 rounded-inner border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-muted tabular-nums"
                  >
                    <Iconify icon="lucide:paperclip" size={10} />
                    {item.attachmentIds.length}
                  </span>
                </Show>
                <span class="h-3.5 w-px bg-border shrink-0 mx-0.5" aria-hidden="true" />
                <div class="flex items-center gap-0.5 shrink-0 -mr-1">
                  <Show when={item.delivery !== "interrupt"}>
                    <button
                      type="button"
                      data-action="queue-interrupt-now"
                      data-rc-tip="Interrupt current step and send now"
                      aria-label="Interrupt current step and send now"
                      onClick={() => q.interruptNow(item.id)}
                      class="shrink-0 inline-flex items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                    >
                      <Iconify icon="lucide:zap" size={12} />
                    </button>
                  </Show>
                  <button
                    type="button"
                    data-action="queue-cancel-send"
                    data-rc-tip="Return to queue"
                    aria-label={
                      item.delivery === "interrupt"
                        ? "Cancel interrupt send and return to queue"
                        : "Cancel next-step send and return to queue"
                    }
                    onClick={() => q.cancelSend(item.id)}
                    class="shrink-0 inline-flex items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    <Iconify icon="lucide:x" size={12} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * Recessed composer shelf docked seamlessly onto the top lip of `.rc-composer`
 * for passive `Queued` items (`01`, `02`).
 */
export function ComposerQueueShelf() {
  const q = useQueue();
  const m = useModal();
  const s = useSession();
  const t = useTranscriptCtx();
  const c = useComposerCtx();

  const sid = () => s.activeSessionId();
  const passive = () => q.passiveItems?.(sid()) ?? [];
  const collapsed = () => q.queueCollapsed?.()[sid()] ?? false;
  const isRunning = () => t.sessionStatus() === "running";
  const currentModel = () => c.activeModel?.() || s.activeSession?.()?.model || "";
  const hasShelf = () => Boolean(sid() && !s.draftMode() && passive().length > 0);

  return (
    <Show when={hasShelf()}>
      <div
        data-composer-queue-shelf
        class="@container rounded-t-surface border border-b-0 border-border-strong bg-surface-subtle overflow-hidden relative z-10"
      >
        {/* Passive Queue Shelf */}
        <div data-queue-passive>
          <div class="flex items-center gap-1.5 px-3.5">
            <button
              type="button"
              onClick={() => q.toggleCollapsed(sid())}
              aria-expanded={!collapsed()}
              data-rc-tip={collapsed() ? "Expand queue" : "Collapse queue"}
              aria-label={collapsed() ? "Expand queue" : "Collapse queue"}
              class="flex-1 min-w-0 flex items-center gap-2 pt-1.5 pb-1 text-left cursor-pointer group/qhdr"
            >
              <span class="text-2xs font-medium text-fg-secondary group-hover/qhdr:text-fg transition-colors shrink-0">
                Queued
              </span>
              <span class="shrink-0 inline-flex items-center justify-center rounded-inner bg-surface-muted px-1.5 py-0.5 font-mono text-2xs leading-none text-fg-secondary tabular-nums">
                {passive().length}
              </span>
              <span class="text-2xs text-fg-muted truncate min-w-0">
                {isRunning() ? "After turn finishes" : "Paused, ready to send"}
              </span>
              <span class="flex-1" />
              <Iconify
                icon="lucide:chevron-down"
                size={13}
                class={`shrink-0 text-fg-muted group-hover/qhdr:text-fg transition-transform ${collapsed() ? "" : "rotate-180"}`}
              />
            </button>
            <Show when={passive().length >= 2}>
              <button
                type="button"
                data-action="queue-clear"
                data-rc-tip="Clear queued messages"
                aria-label="Clear queued messages"
                onClick={() => q.clearQueued()}
                class="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
              >
                Clear
              </button>
            </Show>
          </div>
          <Show when={!collapsed()}>
            <div class="border-t border-border-subtle px-3.5 py-1 space-y-0.5">
              <For each={passive()}>
                {(item, idx) => (
                  <PassiveQueueLine
                    item={item}
                    idx={idx()}
                    total={passive().length}
                    isRunning={isRunning()}
                    currentModel={currentModel()}
                    isEditing={q.editingQueueId() === item.id}
                    onSendNow={() => q.sendNow(item.id)}
                    onInterruptNow={() => q.interruptNow(item.id)}
                    onMoveUp={() => q.moveQueued(item.id, -1)}
                    onMoveDown={() => q.moveQueued(item.id, 1)}
                    onEdit={() => q.beginEdit(item, m.sessionFiles?.()[sid()] || [])}
                    onRemove={() => q.removeQueued(item.id)}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function PassiveQueueLine(props: {
  item: QueuedMessage;
  idx: number;
  total: number;
  isRunning: boolean;
  currentModel: string;
  isEditing: boolean;
  onSendNow: () => void;
  onInterruptNow: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div data-queue-item-state="queue">
      <Show
        when={props.isEditing}
        fallback={
          <div class="group/qrow flex items-center gap-2 py-0.5 px-1.5 -mx-1.5 rounded-lg hover:bg-surface-muted transition-colors min-w-0">
            <span class="shrink-0 font-mono text-2xs text-fg-muted tabular-nums select-none w-4">
              {String(props.idx + 1).padStart(2, "0")}
            </span>
            <span
              data-queue-item-text
              class="truncate text-fg min-w-0 flex-1 text-xs"
              data-rc-tip={props.item.text && props.item.text.length > 60 ? props.item.text : undefined}
            >
              {props.item.text || "(Attachment message)"}
            </span>
            <Show when={props.item.attachmentIds.length > 0}>
              <span
                data-rc-tip={`${props.item.attachmentIds.length} ${props.item.attachmentIds.length === 1 ? "attachment" : "attachments"}`}
                class="shrink-0 inline-flex items-center gap-1 rounded-inner border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-muted tabular-nums"
              >
                <Iconify icon="lucide:paperclip" size={10} />
                {props.item.attachmentIds.length}
              </span>
            </Show>
            <Show when={Boolean(props.item.model && props.currentModel && props.item.model !== props.currentModel)}>
              <span
                data-rc-tip={`Model override: ${props.item.model}`}
                class="hidden @[440px]:inline-flex shrink-0 items-center rounded-inner border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs leading-tight text-fg-muted max-w-28 truncate"
              >
                {props.item.model.split("/").pop() || props.item.model}
              </span>
            </Show>
            <div class="flex items-center gap-0.5 shrink-0 text-fg-muted transition-colors">
              <Show
                when={props.isRunning}
                fallback={
                  <button
                    type="button"
                    data-action="queue-send-idle"
                    data-rc-tip="Send message now"
                    aria-label="Send message now"
                    onClick={props.onSendNow}
                    class="shrink-0 inline-flex items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface transition-colors cursor-pointer"
                  >
                    <Iconify icon="lucide:play" size={11.5} />
                  </button>
                }
              >
                <button
                  type="button"
                  data-action="queue-send-next"
                  data-rc-tip="Send on next AI step"
                  aria-label="Send on next AI step"
                  onClick={props.onSendNow}
                  class="shrink-0 inline-flex items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface transition-colors cursor-pointer"
                >
                  <Iconify icon="lucide:corner-up-right" size={11.5} />
                </button>
                <button
                  type="button"
                  data-action="queue-interrupt-now"
                  data-rc-tip="Stop current step and send now"
                  aria-label="Stop current step and send now"
                  onClick={props.onInterruptNow}
                  class="inline-flex shrink-0 items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface transition-colors cursor-pointer"
                >
                  <Iconify icon="lucide:zap" size={11.5} />
                </button>
              </Show>
              <Show when={props.total >= 2}>
                <button
                  type="button"
                  data-action="queue-move-up"
                  data-rc-tip="Move earlier in queue"
                  aria-label="Move earlier in queue"
                  disabled={props.idx === 0}
                  onClick={props.onMoveUp}
                  class="inline-flex shrink-0 items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer"
                >
                  <Iconify icon="lucide:chevron-up" size={11.5} />
                </button>
                <button
                  type="button"
                  data-action="queue-move-down"
                  data-rc-tip="Move later in queue"
                  aria-label="Move later in queue"
                  disabled={props.idx === props.total - 1}
                  onClick={props.onMoveDown}
                  class="inline-flex shrink-0 items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer"
                >
                  <Iconify icon="lucide:chevron-down" size={11.5} />
                </button>
              </Show>
              <button
                type="button"
                data-rc-tip="Edit queued message"
                aria-label="Edit queued message"
                onClick={props.onEdit}
                class="shrink-0 inline-flex items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface transition-colors cursor-pointer"
              >
                <Iconify icon="lucide:pencil" size={11.5} />
              </button>
              <button
                type="button"
                data-rc-tip="Remove from queue"
                aria-label="Remove from queue"
                onClick={props.onRemove}
                class="shrink-0 inline-flex items-center justify-center p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface transition-colors cursor-pointer"
              >
                <Iconify icon="lucide:x" size={12} />
              </button>
            </div>
          </div>
        }
      >
        <QueueEditRow queueId={props.item.id} />
      </Show>
    </div>
  );
}

function QueueEditRow(props: { queueId: string }) {
  const q = useQueue();
  const m = useModal();
  const s = useSession();
  let fileRef: HTMLInputElement | undefined;

  return (
    <div class="flex flex-col gap-2 py-1">
      <textarea
        value={q.editingQueueText()}
        onInput={(e) => q.setEditingQueueText(e.currentTarget.value)}
        rows={2}
        class="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg resize-y outline-none focus:border-accent placeholder:text-fg-muted transition-colors"
      />
      <Show when={q.editDraft.pendingAttachments().length > 0}>
        <div class="flex flex-wrap gap-1.5">
          <For each={q.editDraft.pendingAttachments()}>
            {(a) => (
              <span class="flex items-center gap-1.5 text-2xs bg-surface border border-border pl-2 pr-1 py-1 rounded-inner text-fg-secondary">
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
                  class="inline-grid h-5 w-5 place-items-center rounded-full text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                >
                  <Iconify icon="lucide:x" size={11} />
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
