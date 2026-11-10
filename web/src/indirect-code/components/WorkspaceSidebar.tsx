import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { createGlide } from "../../ds/motion/glide";
import { press } from "../../ds/motion/press";
import { copyWithToast } from "../../ui";
import { useHost, useModal, useSession, useTranscriptCtx, useUI } from "../ctx";
import { SessionRow, type SessionRowCtx } from "./SessionSidebar";
import { FloatMenu } from "./FloatMenu";
import { HostCard } from "./HostCard";
import { SidebarToggle } from "./SidebarToggle";
import type { SessionSummary } from "../types";

interface SessionMenuState {
  sessionId: string;
  anchor: HTMLElement;
  fallback: SessionSummary;
}

export function WorkspaceSidebar() {
  const hosts = useHost();
  const s = useSession();
  const t = useTranscriptCtx();
  const m = useModal();
  const ui = useUI();
  const [sessionMenu, setSessionMenu] = createSignal<SessionMenuState | null>(null);
  let activeLongPressCancel: (() => void) | null = null;
  const cancelActiveLongPress = () => {
    activeLongPressCancel?.();
    activeLongPressCancel = null;
  };
  const closeSessionMenu = () => setSessionMenu(null);
  const openSessionMenu = (sess: SessionSummary, anchor: HTMLElement) => {
    ui.closeMenus?.();
    setSessionMenu({ sessionId: sess.id, anchor, fallback: sess });
  };
  const resolveMenuSession = (menu: SessionMenuState): SessionSummary =>
    s.sessions?.().find((item) => item.id === menu.sessionId) ?? menu.fallback;

  createEffect(() => {
    if (!ui.sidebarOpen()) {
      cancelActiveLongPress();
      setSessionMenu(null);
    }
  });

  createEffect(() => {
    const menu = sessionMenu();
    if (!menu) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-floatmenu]")) return;
      setSessionMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSessionMenu(null);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  const rowCtx = (): SessionRowCtx => ({
    isMobile: ui.isMobile,
    activeSessionId: s.activeSessionId,
    selectedSessions: s.selectedSessions,
    selectionMode: s.selectionMode,
    renamingId: s.renamingId,
    renameText: s.renameText,
    setRenameText: s.setRenameText,
    setRenamingId: s.setRenamingId,
    submitRename: s.submitRename,
    toggleSessionSelect: s.toggleSessionSelect,
    selectSession: s.selectSession,
    setHistoryView: ui.setHistoryView,
    closeSidebarOnMobile: ui.closeSidebarOnMobile,
    togglePin: s.togglePin,
    deleteSession: (id, e) => void s.deleteSession(id, e),
    sessionStatus: t.sessionStatus,
    turnActivity: t.turnActivity,
    cancelTurnForSession: t.cancelTurnForSession,
    openContextMenu: openSessionMenu,
    contextMenuSessionId: () => sessionMenu()?.sessionId ?? null,
    registerLongPressCancel: (cancel) => {
      activeLongPressCancel = cancel;
    },
  });
  const renderRow = (sess: SessionSummary) => SessionRow(rowCtx(), sess);
  const [viewSwitchEl, setViewSwitchEl] = createSignal<HTMLDivElement>();
  const [viewSwitchInd, setViewSwitchInd] = createSignal<HTMLSpanElement>();
  createGlide({
    container: viewSwitchEl,
    indicator: viewSwitchInd,
    target: () => {
      void (s.sidebarView?.() ?? "projects");
      return viewSwitchEl()?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null;
    },
  });
  return (
<>
<Show when={ui.isMobile() && ui.sidebarOpen()}>
  <div
    class="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm md:hidden"
    onClick={() => ui.setSidebarOpen(false)}
  />
</Show>
<aside
  inert={!ui.sidebarOpen() || undefined}
  aria-hidden={!ui.sidebarOpen() || undefined}
  class={`rc-sidebar bg-surface-subtle border-r border-border flex flex-col shrink-0 transition-all duration-200 ${
    ui.sidebarOpen()
      ? ui.isMobile()
        ? "fixed inset-y-0 left-0 z-40 w-[85vw] max-w-xs shadow-floating"
        : "w-64"
      : "w-0 overflow-hidden border-r-0 pointer-events-none"
  }`}
>
  {/* Brand Header */}
  <div class="rc-workspace-header rc-sidebar-header flex items-center justify-between gap-2 px-3.5 shrink-0 border-b border-border/60 select-none">
    <div class="flex items-center gap-2.5 min-w-0">
      <img
        src="/indirect-icon.svg"
        alt="Indirect"
        class="w-4.5 h-4.5 shrink-0 object-contain rounded"
      />
      <span class="text-[13px] font-medium tracking-tight text-fg truncate">
        Indirect Code
      </span>
    </div>
    <Show when={ui.sidebarOpen()}><SidebarToggle /></Show>
  </div>

  {/* Primary Navigation — single strict optical grid */}
  <nav aria-label="Workspace navigation" class="px-2 pt-2 pb-1.5 space-y-0.5 shrink-0">
    <a
      href="#/"
      onPointerDown={(e) => press(e.currentTarget)}
      class="rc-nav-row text-fg-muted hover:text-fg hover:bg-surface-muted/75"
    >
      <span aria-hidden="true" class="rc-nav-icon">
        <Iconify icon="lucide:arrow-left" size={14} />
      </span>
      <span class="truncate">Back to Gateway</span>
    </a>
    <button
      type="button"
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={() => {
        s.startNewConversation();
        ui.closeSidebarOnMobile();
      }}
      class={`rc-nav-row text-left cursor-pointer ${
        s.draftMode?.() && !ui.historyView?.()
          ? "bg-surface-muted font-medium text-fg"
          : "text-fg-secondary hover:text-fg hover:bg-surface-muted/75"
      }`}
    >
      <span aria-hidden="true" class="rc-nav-icon text-fg-muted">
        <Iconify icon="lucide:square-pen" size={14} />
      </span>
      <span class="truncate">New Conversation</span>
    </button>
    <button
      type="button"
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={() => {
        ui.setHistoryView(true);
        ui.closeSidebarOnMobile();
      }}
      class={`rc-nav-row text-left cursor-pointer ${
        ui.historyView?.()
          ? "bg-surface-muted font-medium text-fg"
          : "text-fg-secondary hover:text-fg hover:bg-surface-muted/75"
      }`}
    >
      <span aria-hidden="true" class="rc-nav-icon text-fg-muted">
        <Iconify icon="lucide:history" size={14} />
      </span>
      <span class="min-w-0 flex-1 truncate">Conversation History</span>
      <Show when={!ui.isMobile()}>
        <span aria-hidden="true" class="shrink-0 font-mono text-[10.5px] text-fg-muted/75">
          Ctrl K
        </span>
      </Show>
    </button>
  </nav>

  <div class="mx-2.5 border-t border-border/60 shrink-0" />

  {/* Projects & Sessions */}
  <div
    onScroll={() => {
      cancelActiveLongPress();
      if (sessionMenu()) setSessionMenu(null);
    }}
    class="flex-1 overflow-y-auto px-2 pt-2 pb-2 space-y-2 min-h-0 [scrollbar-gutter:stable]"
  >
      <div class="flex items-center justify-between px-1 pb-0.5">
        <Show
          when={s.selectionMode()}
          fallback={
            /* Projects | Talk view switch (persisted across reloads) */
            <div
              ref={setViewSwitchEl}
              data-glide=""
              class="ui-segmented ui-segmented-sm"
              role="group"
              aria-label="Sidebar list view"
            >
              <span ref={setViewSwitchInd} class="ui-segmented-indicator" aria-hidden="true" />
              <button
                type="button"
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => s.setSidebarView?.("projects")}
                aria-pressed={(s.sidebarView?.() ?? "projects") === "projects"}
                class="ui-segment px-2.5 text-[11px] cursor-pointer"
              >
                Projects
              </button>
              <button
                type="button"
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => s.setSidebarView?.("talk")}
                aria-pressed={(s.sidebarView?.() ?? "projects") === "talk"}
                class="ui-segment px-2.5 text-[11px] cursor-pointer"
              >
                Talk
              </button>
            </div>
          }
        >
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-medium text-fg-secondary tabular-nums">
              {s.selectedSessions().size} selected
            </span>
            <button
              type="button"
              onClick={() => s.selectAllSessions()}
              class="px-1.5 py-0.5 rounded text-[11px] font-medium text-fg-muted hover:text-fg hover:bg-surface-muted cursor-pointer transition-colors"
            >
              {s.sessions().length > 0 && s.selectedSessions().size === s.sessions().length ? "Deselect All" : "Select All"}
            </button>
          </div>
        </Show>
        <div class="flex items-center gap-0.5">
          {/* Selection mode toggle */}
          <button
            type="button"
            onClick={() => {
              if (s.selectionMode()) s.exitSelectionMode();
              else s.setSelectionMode(true);
            }}
            class={`flex h-6.5 w-6.5 items-center justify-center rounded-md transition-colors cursor-pointer ${s.selectionMode() ? "bg-surface-muted text-fg" : "text-fg-muted hover:text-fg hover:bg-surface-muted/75"}`}
            data-rc-tip={s.selectionMode() ? "Exit selection mode" : "Select conversations"} aria-label={s.selectionMode() ? "Exit selection mode" : "Select conversations"}
          >
            <Iconify icon={s.selectionMode() ? "lucide:x" : "lucide:list-checks"} size={13} />
          </button>
        <div>
          <button
            type="button"
            ref={(el) => (s.newProjBtn = el)}
            data-menubtn
            onClick={(e) => {
              e.stopPropagation();
              s.setNewProjectMenuOpen(!s.newProjectMenuOpen());
            }}
            class="flex h-6.5 w-6.5 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted/75 transition-colors cursor-pointer"
            data-rc-tip="Create new project" aria-label="Create new project"
          >
            <Iconify icon="lucide:folder-plus" size={13} />
          </button>
          <FloatMenu anchor={() => s.newProjBtn} open={s.newProjectMenuOpen()} placement="bottom-start" width="11.5rem">
              <button
                type="button"
                onClick={() => {
                  s.newProjBtn?.focus();
                  s.setNewProjectMenuOpen(false);
                  s.openNewProjectModal();
                }}
                class="w-full text-left px-2 py-1.5 rounded-md text-fg hover:bg-surface-muted flex items-center gap-2 cursor-pointer transition-colors"
              >
                <Iconify icon="lucide:folder-plus" size={13} class="text-fg-muted" />
                <span>New Project</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  s.newProjBtn?.focus();
                  s.setNewProjectMenuOpen(false);
                  s.quickStartProject();
                }}
                class="w-full text-left px-2 py-1.5 rounded-md text-fg-secondary hover:text-fg hover:bg-surface-muted flex items-center gap-2 cursor-pointer transition-colors"
              >
                <Iconify icon="lucide:zap" size={13} class="text-warning" />
                <span>Quick Start</span>
              </button>
          </FloatMenu>
          </div>
        </div>
      </div>
      <Show when={(s.sidebarView?.() ?? "projects") === "talk"}>
        <div class="space-y-0.5">
          <For
            each={s.visibleSessions("talk", s.talkSessions?.() ?? [])}
            fallback={<div class="px-2.5 py-2 text-xs text-fg-muted">No talk conversations yet.</div>}
          >
            {(sess) => renderRow(sess)}
          </For>
          {s.sessionListToggle?.("talk", (s.talkSessions?.() ?? []).length)}
        </div>
      </Show>
      <Show when={(s.sidebarView?.() ?? "projects") === "projects"}>
      <Show
        when={s.projects().length > 0}
        fallback={
          <button
            type="button"
            onClick={s.openNewProjectModal}
            class="w-full text-left px-2.5 py-2 rounded-lg border border-dashed border-border text-xs text-fg-muted hover:text-fg hover:border-border-strong transition-colors cursor-pointer"
          >
            + Select a project folder on the host
          </button>
        }
      >
       <div class="space-y-1.5">
            <For each={s.projects()}>
              {(p) => {
                const list = () => s.projectSessions(p.id);
                const activeProj = () => s.activeProjectId() === p.id || p.id === (s.activeProject()?.id || "");
                return (
                  <div>
                    <div
                      onClick={() => {
                        s.pickProject(p.id);
                      }}
                      class={`group flex h-7.5 items-center gap-1.5 px-2 rounded-md cursor-pointer text-[12.5px] transition-colors ${
                        activeProj()
                          ? "bg-surface-muted/55 font-medium text-fg hover:bg-surface-muted/80"
                          : "text-fg-secondary hover:bg-surface-muted/65 hover:text-fg"
                      }`}
                      data-rc-tip={p.path}
                    >
                      <button
                        type="button"
                        aria-label="Toggle project"
                        aria-expanded={s.isProjectExpanded(p)}
                        onClick={(e) => {
                          e.stopPropagation();
                          s.toggleProjectExpanded(p.id);
                        }}
                        class="p-0.5 -ml-0.5 rounded text-fg-muted hover:text-fg hover:bg-surface-muted cursor-pointer shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      >
                        <Iconify
                          icon="lucide:chevron-right"
                          size={12}
                          class={`shrink-0 transition-transform ${s.isProjectExpanded(p) ? "rotate-90" : ""}`}
                        />
                      </button>
                      <button
                        type="button"
                        aria-label={p.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          s.pickProject(p.id);
                        }}
                        class="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
                      >
                        <Iconify icon="lucide:folder" size={13} class="shrink-0 text-fg-muted" />
                        <span class="truncate flex-1 font-medium">{p.name}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Copy path for ${p.name}`}
                        data-rc-tip="Copy project path"
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyWithToast(p.path);
                        }}
                        class="rc-row-actions opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 rounded p-0.5 text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer"
                      >
                        <Iconify icon="lucide:copy" size={11} />
                      </button>
                      <button
                        type="button"
                        aria-label={`New conversation in ${p.name}`}
                        data-rc-tip="New conversation in this project"
                        onClick={(e) => { e.stopPropagation(); s.startNewConversation(p.id); }}
                        class="rc-row-actions opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 rounded p-0.5 text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer"
                      >
                        <Iconify icon="lucide:plus" size={13} />
                      </button>
                      <Show when={!p.protected}>
                        <button
                          type="button"
                          onClick={(e) => s.deleteProject(p.id, e)}
                          class="rc-row-actions opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 rounded p-0.5 text-fg-muted hover:text-danger hover:bg-danger-subtle cursor-pointer shrink-0"
                          data-rc-tip="Remove project" aria-label={`Remove ${p.name}`}
                        >
                          <Iconify icon="lucide:x" size={12} />
                        </button>
                      </Show>
                    </div>
                    <Show when={s.isProjectExpanded(p)}>
                      <div class="ml-[15px] mt-0.5 space-y-0.5 border-l border-border/60 pl-2">
                        <For each={s.visibleSessions(p.id, list())}>
                          {(sess) => renderRow(sess)}
                        </For>
                        {s.sessionListToggle(p.id, list().length)}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={s.looseSessions().length > 0}>
              <div>
                <div class="px-2 py-1 text-[11px] font-medium text-fg-muted">
                  Not in Project
                </div>
                <div class="space-y-0.5">
                  <For each={s.visibleSessions("loose", s.looseSessions())}>
                    {(sess) => renderRow(sess)}
                  </For>
                  {s.sessionListToggle("loose", s.looseSessions().length)}
                </div>
              </div>
            </Show>
          </div>
      </Show>
      </Show>
    </div>
  {/* Session long-press / right-click context menu */}
  <Show when={sessionMenu()} keyed>
    {(menu) => {
      const target = () => resolveMenuSession(menu);
      return (
        <FloatMenu
          anchor={() => (menu.anchor.isConnected ? menu.anchor : undefined)}
          open={true}
          placement="bottom-start"
          width="13.5rem"
          aria-label="Conversation actions"
          onClose={closeSessionMenu}
        >
          <div
            data-session-menu-header
            class="px-2.5 py-1.5 mb-0.5 border-b border-border/60 text-[11px] font-medium text-fg-muted truncate select-none"
          >
            {target().title}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              const sess = target();
              closeSessionMenu();
              s.togglePin(sess.id, e);
            }}
            class="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 min-h-8 text-left text-xs text-fg hover:bg-surface-muted transition-colors cursor-pointer select-none"
          >
            <Iconify
              icon={target().pinned ? "lucide:pin-off" : "lucide:pin"}
              size={13}
              class="text-fg-muted shrink-0"
            />
            <span>{target().pinned ? "Unpin conversation" : "Pin conversation"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const sess = target();
              closeSessionMenu();
              s.setRenameText(sess.title);
              s.setRenamingId(sess.id);
            }}
            class="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 min-h-8 text-left text-xs text-fg hover:bg-surface-muted transition-colors cursor-pointer select-none"
          >
            <Iconify icon="lucide:pencil" size={13} class="text-fg-muted shrink-0" />
            <span>Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const sess = target();
              closeSessionMenu();
              if (!s.selectionMode()) s.setSelectionMode?.(true);
              s.toggleSessionSelect(sess.id);
            }}
            class="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 min-h-8 text-left text-xs text-fg hover:bg-surface-muted transition-colors cursor-pointer select-none"
          >
            <Iconify icon="lucide:check-square" size={13} class="text-fg-muted shrink-0" />
            <span>Select</span>
          </button>
          <div role="separator" class="my-1 border-t border-border/70" />
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              const sess = target();
              closeSessionMenu();
              void s.deleteSession(sess.id, e);
            }}
            class="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 min-h-8 text-left text-xs text-danger hover:bg-danger-subtle transition-colors cursor-pointer select-none"
          >
            <Iconify icon="lucide:trash-2" size={13} class="shrink-0" />
            <span>Delete</span>
          </button>
        </FloatMenu>
      );
    }}
  </Show>
  {/* Batch bar (selection mode) */}
  <Show when={s.selectionMode()}>
    <div class="p-2 border-t border-border/70 bg-surface">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-fg-muted pl-1 truncate tabular-nums">
          {s.selectedSessions().size > 0
            ? `${s.selectedSessions().size} selected`
            : "Select conversations to delete"}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={s.pinSelected}
            disabled={s.selectedSessions().size === 0}
            class={`px-2 py-1 rounded-md text-[11px] font-medium border border-border transition-colors ${
              s.selectedSessions().size > 0
                ? "bg-surface-subtle text-fg-secondary hover:text-fg hover:bg-surface-muted cursor-pointer"
                : "opacity-50 cursor-not-allowed bg-surface-subtle text-fg-muted"
            }`}
          >
            Pin / Unpin
          </button>
          <button
            type="button"
            onClick={s.deleteSelected}
            disabled={s.selectedSessions().size === 0}
            class={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
              s.selectedSessions().size > 0
                ? "bg-danger-subtle border-danger/35 text-danger hover:opacity-90 cursor-pointer"
                : "opacity-50 cursor-not-allowed bg-surface-subtle border-border text-fg-muted"
            }`}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </Show>

  <div class="px-2 py-2 border-t border-border/60 space-y-0.5 bg-surface-subtle shrink-0">
    {/* Daemon update: primary rounded-full button above host selector */}
    <Show when={(() => { const i = ui.daemonUpdate.info(); return !!i && !!i.available && i.available !== i.current; })()}>{(() => {
      const i = ui.daemonUpdate.info()!;
      const busy = ui.daemonUpdate.applying() || hosts.activeHost()?.status === "updating";
      return (
        <div class="px-0.5 pb-1">
          <button
            type="button"
            onClick={() => ui.daemonUpdate.apply()}
            disabled={busy}
            class="ui-button ui-button-primary w-full rounded-full h-[1.5rem] min-h-[1.5rem] py-0 text-xs gap-1.5"
          >
            <Iconify icon="lucide:arrow-down-to-line" size={13} />
            <span>{busy ? "Updating…" : `Update to ${i.available}`}</span>
          </button>
        </div>
      );
    })()}</Show>
    <HostCard id="sidebar" />
    {/* () => … — openSettings takes an optional section id; passing it
        directly would feed the MouseEvent in as the section. */}
    <button
      type="button"
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={() => m.openSettings?.()}
      aria-label="Host & agent settings: Settings"
      class="rc-nav-row text-left text-fg-secondary hover:text-fg hover:bg-surface-muted/75 cursor-pointer"
    >
      <span aria-hidden="true" class="rc-nav-icon text-fg-muted">
        <Iconify icon="lucide:settings" size={14} />
      </span>
      <span class="truncate">Settings</span>
    </button>
  </div>
</aside>
</>
  );
}
