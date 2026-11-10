import { createSignal, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { timeAgo } from "../utils/format";
import { sessionTimeLabel } from "../paths";
import type { SessionSummary } from "../types";

export function SessionStopButton(props: {
  sessionId: string;
  isCancelling: boolean;
  onCancel: (e: MouseEvent | KeyboardEvent) => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  return (
    <button
      type="button"
      onClick={(e) => props.onCancel(e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      disabled={props.isCancelling}
      class={`w-4.5 h-4.5 rounded flex items-center justify-center shrink-0 border border-transparent transition-colors ${
        props.isCancelling
          ? "text-ink-500 opacity-60 cursor-default"
          : hovered()
            ? "text-danger bg-danger-subtle border-danger/35 cursor-pointer"
            : "text-success cursor-pointer"
      } focus-visible:ring-1 focus-visible:ring-danger focus:outline-none`}
      data-rc-tip={props.isCancelling ? "Stopping…" : "Stop"}
      aria-label={props.isCancelling ? "Stopping turn" : "Stop turn"}
    >
      <Show
        when={!props.isCancelling && hovered()}
        fallback={
          <Iconify
            icon="lucide:loader-2"
            size={12}
            class={`animate-spin ${props.isCancelling ? "text-ink-500" : "text-success"}`}
          />
        }
      >
        <Iconify
          icon="lucide:square"
          size={9}
          class="text-danger fill-current"
        />
      </Show>
    </button>
  );
}

/** Sidebar session line (full row with inline rename + hover actions). */
export interface SessionRowCtx {
  activeSessionId: () => string | null;
  selectedSessions: () => Set<string>;
  selectionMode: () => boolean;
  renamingId: () => string | null;
  renameText: () => string;
  setRenameText: (v: string) => void;
  setRenamingId: (v: string | null) => void;
  submitRename: (id: string) => void;
  toggleSessionSelect: (id: string) => void;
  selectSession: (id: string) => void;
  setHistoryView: (v: boolean) => void;
  closeSidebarOnMobile: () => void;
  togglePin: (id: string, e: MouseEvent) => void;
  deleteSession: (id: string, e: MouseEvent) => void;
  sessionStatus: () => string;
  turnActivity: () => { status: string } | null;
  cancelTurnForSession: (id: string, e: MouseEvent | KeyboardEvent) => void;
}

export function SessionRow(ctx: SessionRowCtx, s: SessionSummary) {
  const isActive = () => s.id === ctx.activeSessionId();
  const selected = () => ctx.selectedSessions().has(s.id);
  return (
    <div
      onClick={() => {
        if (ctx.selectionMode()) {
          ctx.toggleSessionSelect(s.id);
          return;
        }
        ctx.setHistoryView(false);
        ctx.selectSession(s.id);
        ctx.closeSidebarOnMobile();
      }}
      onDblClick={() => {
        if (ctx.selectionMode()) return;
        ctx.setRenamingId(s.id);
        ctx.setRenameText(s.title);
      }}
      class={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
        isActive() && !ctx.selectionMode()
          ? "bg-surface-muted font-medium text-fg"
          : selected()
            ? "bg-accent-subtle text-fg ring-1 ring-accent/40"
            : "text-fg-secondary hover:bg-surface-muted/60 hover:text-fg"
      }`}
      data-rc-tip={`${s.title}\n${s.cwd}`}
    >
      <Show when={ctx.selectionMode()}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleSessionSelect(s.id);
          }}
          class={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
            selected() ? "bg-accent border-accent" : "border-border-strong bg-surface"
          }`}
          data-rc-tip="Select" aria-label="Select"
        >
          <Show when={selected()}>
            <Iconify icon="lucide:check" size={11} class="text-accent-foreground" />
          </Show>
        </button>
      </Show>
      <Show when={s.pinned && !ctx.selectionMode()}>
        <Iconify icon="lucide:pin" size={11} class="text-accent shrink-0" />
      </Show>
      <Show
        when={ctx.renamingId() === s.id}
        fallback={
          <>
            <span class="truncate flex-1 min-w-0">{s.title}</span>
            <Show when={s.status === "running" || (s.id === ctx.activeSessionId() && ctx.sessionStatus() === "running")}>
              <SessionStopButton
                sessionId={s.id}
                isCancelling={s.id === ctx.activeSessionId() && ctx.turnActivity()?.status === "cancelling"}
                onCancel={(e) => ctx.cancelTurnForSession(s.id, e)}
              />
            </Show>
            <div class="relative flex items-center justify-end shrink-0 min-w-[48px]">
              <span class="rc-row-time text-[10px] text-ink-500 transition-opacity group-hover:opacity-0 group-hover:pointer-events-none">
                {timeAgo(sessionTimeLabel(s))}
              </span>
              <Show when={!ctx.selectionMode()}>
                <div class="rc-row-actions absolute right-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => ctx.togglePin(s.id, e)}
                    class="rc-row-action p-0.5 text-ink-500 hover:text-ink-200 cursor-pointer"
                    data-rc-tip={s.pinned ? "Unpin" : "Pin"} aria-label={s.pinned ? "Unpin" : "Pin"}
                  >
                    <Iconify icon={s.pinned ? "lucide:pin-off" : "lucide:pin"} size={11} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      ctx.setRenamingId(s.id);
                      ctx.setRenameText(s.title);
                    }}
                    class="rc-row-action p-0.5 text-ink-600 hover:text-ink-200 cursor-pointer"
                    data-rc-tip="Rename" aria-label="Rename"
                  >
                    <Iconify icon="lucide:pencil" size={11} />
                  </button>
                  <button
                    onClick={(e) => ctx.deleteSession(s.id, e)}
                    class="rc-row-action p-0.5 text-ink-600 hover:text-danger cursor-pointer"
                    data-rc-tip="Delete" aria-label="Delete"
                  >
                    <Iconify icon="lucide:trash-2" size={11} />
                  </button>
                </div>
              </Show>
            </div>
          </>
        }
      >
        <input
          type="text"
          class="flex-1 min-w-0 bg-surface border border-accent rounded px-1.5 py-0.5 text-[13px] text-fg focus:outline-none"
          value={ctx.renameText()}
          onInput={(e) => ctx.setRenameText(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") ctx.submitRename(s.id);
            if (e.key === "Escape") ctx.setRenamingId(null);
          }}
          onBlur={() => {
            if (ctx.renamingId() === s.id) {
              if (ctx.renameText().trim() && ctx.renameText().trim() !== s.title) {
                ctx.submitRename(s.id);
              } else {
                ctx.setRenamingId(null);
              }
            }
          }}
          onClick={(e) => e.stopPropagation()}
          ref={(el) => setTimeout(() => el?.select(), 30)}
        />
      </Show>
    </div>
  );
}
