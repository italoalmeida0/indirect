import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";

/** Shared transcript action button with mouse, keyboard and touch targets. */
export function MsgIconBtn(props: {
  tip: string;
  icon: string;
  size?: number;
  compact?: boolean;
  danger?: boolean;
  disabled?: boolean;
  copied?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        if (!props.disabled) press(e.currentTarget);
      }}
      onClick={props.onClick}
      disabled={props.disabled}
      class={
        props.compact
          ? `rc-msg-action relative inline-flex items-center justify-center p-1 rounded-inner text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer disabled:opacity-40 ${props.danger ? "hover:text-danger hover:bg-danger-subtle" : ""}`
          : `rc-msg-action relative inline-flex items-center justify-center p-1.5 rounded-inner text-fg-muted hover:text-fg ${props.danger ? "hover:text-danger hover:bg-danger-subtle" : "hover:bg-surface-muted"} transition-colors cursor-pointer disabled:opacity-40`
      }
      data-rc-tip={props.copied ? "Copied" : props.tip}
      aria-label={props.tip}
    >
      <Iconify icon={props.copied ? "lucide:check" : props.icon} size={props.size ?? (props.compact ? 13 : 14)} class={props.copied ? "text-success" : ""} />
    </button>
  );
}

export interface MsgActionState {
  forking: boolean;
  canFork: boolean;
  showCopy: boolean;
  copied: boolean;
  onFork: () => void;
  onCopy: () => void;
}

/** Hover actions for user bubbles (fork/copy/edit). */
export function UserMsgActions(props: MsgActionState & { onEdit: () => void }) {
  return (
    <div class="rc-message-actions flex items-center gap-0.5 [@media(pointer:coarse)]:gap-2 -mr-1.5 mt-1 transition-opacity">
      <MsgIconBtn tip="Fork conversation from here" icon="lucide:git-branch" disabled={props.forking || !props.canFork} onClick={props.onFork} />
      <Show when={props.showCopy}>
        <MsgIconBtn tip="Copy" icon="lucide:copy" copied={props.copied} onClick={props.onCopy} />
      </Show>
      <MsgIconBtn tip="Edit and resend" icon="lucide:pencil" onClick={props.onEdit} />
    </div>
  );
}

/** Hover actions for assistant bubbles (fork/copy/regenerate). */
export function AssistantMsgActions(props: MsgActionState & { onRegenerate: () => void; duration?: string }) {
  return (
    <div class="rc-message-actions flex items-center gap-0.5 [@media(pointer:coarse)]:gap-2 -ml-1.5 mt-1 transition-opacity">
      <MsgIconBtn tip="Fork conversation from here" icon="lucide:git-branch" disabled={props.forking || !props.canFork} onClick={props.onFork} />
      <Show when={props.showCopy}>
        <MsgIconBtn tip="Copy" icon="lucide:copy" copied={props.copied} onClick={props.onCopy} />
      </Show>
      <MsgIconBtn tip="Regenerate response" icon="lucide:rotate-cw" onClick={props.onRegenerate} />
      <Show when={props.duration}>
        <span data-turn-duration data-rc-tip={`Turn duration: ${props.duration}`} class="ml-1.5 text-2xs text-fg-muted tabular-nums" aria-label={`Turn duration: ${props.duration}`}>{props.duration}</span>
      </Show>
    </div>
  );
}
