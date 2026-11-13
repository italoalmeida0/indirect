import { createSignal, onCleanup, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { timeAgo } from "../utils/format";
import { sessionTimeLabel } from "../paths";
import type { SessionSummary } from "../types";
import { RadialSpokeSpinner, UnreadDot } from "./LiveIndicators";

export function SessionStopButton(props: {
  sessionId: string;
  isCancelling: boolean;
  onCancel: (e: MouseEvent | KeyboardEvent) => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        props.onCancel(e);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      disabled={props.isCancelling}
      class={`rc-msg-action w-5 h-5 rounded-md flex items-center justify-center shrink-0 border border-transparent transition-colors ${
        props.isCancelling
          ? "text-fg-muted opacity-60 cursor-default"
          : hovered()
            ? "text-danger bg-danger-subtle border-danger/35 cursor-pointer"
            : "text-fg-muted cursor-pointer"
      }`}
      data-rc-tip={props.isCancelling ? "Stopping…" : "Stop"}
      aria-label={props.isCancelling ? "Stopping turn" : "Stop turn"}
    >
      <Show
        when={!props.isCancelling && hovered()}
        fallback={
          <RadialSpokeSpinner
            size={13}
            paused={props.isCancelling}
            class={props.isCancelling ? "text-fg-muted" : "text-fg-secondary"}
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

/** Sidebar session line (full row with inline rename + hover/context actions). */
export interface SessionRowCtx {
  isMobile: () => boolean;
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
  isSessionUnread?: (session: SessionSummary) => boolean;
  sessionAttentionLabel?: (session: SessionSummary) => string;
  openContextMenu?: (session: SessionSummary, anchor: HTMLElement) => void;
  contextMenuSessionId?: () => string | null;
  registerLongPressCancel?: (cancel: () => void) => void;
}

const LONG_PRESS_MS = 420;
const LONG_PRESS_MOVE_PX = 8;

export function SessionRow(ctx: SessionRowCtx, s: SessionSummary) {
  const isActive = () => s.id === ctx.activeSessionId();
  const selected = () => ctx.selectedSessions().has(s.id);
  const menuOpen = () => ctx.contextMenuSessionId?.() === s.id;
  const isRenaming = () => ctx.renamingId() === s.id;
  const isUnread = () => Boolean(ctx.isSessionUnread?.(s));
  const isRunning = () =>
    s.status === "running" || (s.id === ctx.activeSessionId() && ctx.sessionStatus() === "running");

  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;
  let longPressActive = false;
  let suppressClickUntil = 0;
  let cancellingRename = false;

  const clearLongPress = () => {
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  };
  onCleanup(clearLongPress);

  const commitRename = () => {
    if (cancellingRename) return;
    const trimmed = ctx.renameText().trim();
    if (trimmed && trimmed !== s.title) {
      ctx.submitRename(s.id);
    } else {
      ctx.setRenameText(s.title);
      ctx.setRenamingId(null);
    }
  };

  const cancelRename = () => {
    cancellingRename = true;
    ctx.setRenameText(s.title);
    ctx.setRenamingId(null);
    setTimeout(() => {
      cancellingRename = false;
    }, 150);
  };

  return (
    <div
      data-session-id={s.id}
      onPointerDown={(e) => {
        if (isRenaming()) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("button, input")) return;
        const isTouchHold = e.pointerType === "touch" || (ctx.isMobile() && e.button === 0);
        if (!isTouchHold || !ctx.openContextMenu) return;
        clearLongPress();
        longPressActive = false;
        startX = e.clientX;
        startY = e.clientY;
        const rowEl = e.currentTarget;
        ctx.registerLongPressCancel?.(clearLongPress);
        longPressTimer = setTimeout(() => {
          longPressTimer = undefined;
          longPressActive = true;
          ctx.openContextMenu?.(s, rowEl);
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(e) => {
        if (longPressTimer === undefined) return;
        if (
          Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_PX ||
          Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_PX
        ) {
          clearLongPress();
        }
      }}
      onPointerUp={(e) => {
        clearLongPress();
        if (longPressActive) {
          longPressActive = false;
          suppressClickUntil = Date.now() + 400;
          e.stopPropagation();
        }
      }}
      onPointerCancel={() => {
        clearLongPress();
        if (longPressActive) {
          longPressActive = false;
          suppressClickUntil = Date.now() + 400;
        }
      }}
      onContextMenu={(e) => {
        if (isRenaming() || !ctx.openContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        clearLongPress();
        if (e.button !== 2) {
          longPressActive = true;
          suppressClickUntil = Date.now() + 400;
        }
        ctx.openContextMenu(s, e.currentTarget);
      }}
      onClick={(e) => {
        if (longPressActive || Date.now() < suppressClickUntil) {
          longPressActive = false;
          suppressClickUntil = 0;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (isRenaming()) return;
        if (ctx.selectionMode()) {
          ctx.toggleSessionSelect(s.id);
          return;
        }
        ctx.setHistoryView(false);
        ctx.selectSession(s.id);
        ctx.closeSidebarOnMobile();
      }}
      role="button"
      tabIndex={isRenaming() ? -1 : 0}
      onKeyDown={(e) => {
        if (isRenaming() || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (ctx.selectionMode()) {
            ctx.toggleSessionSelect(s.id);
            return;
          }
          ctx.setHistoryView(false);
          ctx.selectSession(s.id);
          ctx.closeSidebarOnMobile();
        }
      }}
      onDblClick={() => {
        if (ctx.selectionMode() || ctx.isMobile()) return;
        ctx.setRenameText(s.title);
        ctx.setRenamingId(s.id);
      }}
      class={`group flex ${ctx.isMobile() ? "min-h-8 py-0.5" : "h-7.5"} items-center gap-1.5 px-2 rounded-lg cursor-pointer text-[12.5px] transition-colors touch-manipulation select-none [-webkit-touch-callout:none] ${
        isActive() && !ctx.selectionMode()
          ? "bg-surface-strong/70 font-medium text-fg"
          : selected()
            ? "bg-surface-muted text-fg ring-1 ring-inset ring-border-strong"
            : menuOpen()
              ? "bg-surface-muted text-fg"
              : isUnread()
                ? "font-medium text-fg hover:bg-surface-muted/75"
                : "text-fg-secondary hover:bg-surface-muted/75 hover:text-fg"
      }`}
      data-rc-tip={isRenaming() || menuOpen() ? undefined : `${s.title}\n${s.cwd}`}
    >
      <Show when={ctx.selectionMode()}>
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleSessionSelect(s.id);
          }}
          class={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
            selected() ? "bg-fg border-fg" : "border-border-strong bg-surface"
          }`}
          data-rc-tip="Select" aria-label="Select"
        >
          <Show when={selected()}>
            <Iconify icon="lucide:check" size={10} class="text-background" />
          </Show>
        </button>
      </Show>
      <Show when={s.pinned && !ctx.selectionMode()}>
        <Iconify icon="lucide:pin" size={11} class="text-fg-muted shrink-0" />
      </Show>
      <Show
        when={isRenaming()}
        fallback={
          <>
            <span class={`truncate flex-1 min-w-0 select-none ${isUnread() ? "font-medium text-fg" : ""}`}>
              {s.title}
            </span>
            <Show
              when={isUnread()}
              fallback={
                <Show when={isRunning()}>
                  <SessionStopButton
                    sessionId={s.id}
                    isCancelling={s.id === ctx.activeSessionId() && ctx.turnActivity()?.status === "cancelling"}
                    onCancel={(e) => ctx.cancelTurnForSession(s.id, e)}
                  />
                </Show>
              }
            >
              <span
                data-session-unread={s.id}
                class="w-5 h-5 flex items-center justify-center shrink-0"
              >
                <UnreadDot label={ctx.sessionAttentionLabel?.(s) ?? "Unread update"} />
              </span>
            </Show>
            {/* Desktop row actions fade in OVER a fixed trailing slot instead of
                reflowing the row: the title, unread dot and stop spinner never
                shift under the pointer when the row is hovered. */}
            <div
              class={`relative flex items-center justify-end shrink-0 ${
                !ctx.isMobile() && !ctx.selectionMode() ? "min-w-[3.5rem]" : ""
              }`}
            >
              <span
                class={`rc-row-time text-2xs text-fg-muted tabular-nums transition-opacity ${
                  !ctx.isMobile() && !ctx.selectionMode()
                    ? "group-hover:opacity-0 group-focus-within:opacity-0"
                    : ""
                }`}
              >
                {timeAgo(sessionTimeLabel(s))}
              </span>
              <Show when={!ctx.isMobile() && !ctx.selectionMode()}>
                <div class="rc-row-actions absolute inset-y-0 right-0 flex items-center opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                  <button
                    type="button"
                    onClick={(e) => ctx.togglePin(s.id, e)}
                    class="rc-row-action flex h-[18px] w-[18px] items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer"
                    data-rc-tip={s.pinned ? "Unpin" : "Pin"} aria-label={s.pinned ? "Unpin" : "Pin"}
                  >
                    <Iconify icon={s.pinned ? "lucide:pin-off" : "lucide:pin"} size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      ctx.setRenameText(s.title);
                      ctx.setRenamingId(s.id);
                    }}
                    class="rc-row-action flex h-[18px] w-[18px] items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer"
                    data-rc-tip="Rename" aria-label="Rename"
                  >
                    <Iconify icon="lucide:pencil" size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => ctx.deleteSession(s.id, e)}
                    class="rc-row-action flex h-[18px] w-[18px] items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-danger-subtle cursor-pointer"
                    data-rc-tip="Delete" aria-label="Delete"
                  >
                    <Iconify icon="lucide:trash-2" size={12} />
                  </button>
                </div>
              </Show>
            </div>
          </>
        }
      >
        <div
          class="flex-1 min-w-0 flex items-center gap-1"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDblClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            aria-label="Rename conversation"
            class="flex-1 min-w-0 h-6 bg-surface border border-border-strong rounded-md px-1.5 py-0.5 text-[12.5px] text-fg select-text focus:outline-none focus:border-accent"
            value={ctx.renameText()}
            onInput={(e) => ctx.setRenameText(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            onBlur={() => {
              if (cancellingRename || ctx.isMobile()) return;
              if (ctx.renamingId() === s.id) {
                if (ctx.renameText().trim() && ctx.renameText().trim() !== s.title) {
                  ctx.submitRename(s.id);
                } else {
                  ctx.setRenamingId(null);
                }
              }
            }}
            onClick={(e) => e.stopPropagation()}
            ref={(el) => setTimeout(() => { el?.focus(); el?.select(); }, 30)}
          />
          <button
            type="button"
            aria-label="Save rename"
            data-rc-tip="Save"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              commitRename();
            }}
            class="inline-flex h-6 w-6 items-center justify-center rounded-md shrink-0 text-accent hover:bg-surface-subtle cursor-pointer"
          >
            <Iconify icon="lucide:check" size={13} />
          </button>
          <button
            type="button"
            aria-label="Cancel rename"
            data-rc-tip="Cancel"
            onPointerDown={(e) => {
              cancellingRename = true;
              setTimeout(() => {
                cancellingRename = false;
              }, 250);
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              cancelRename();
            }}
            class="inline-flex h-6 w-6 items-center justify-center rounded-md shrink-0 text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer"
          >
            <Iconify icon="lucide:x" size={13} />
          </button>
        </div>
      </Show>
    </div>
  );
}
