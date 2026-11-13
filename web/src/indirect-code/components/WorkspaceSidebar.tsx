import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { handleBackToGatewayClick } from "../../route-nav";
import { Icon as Iconify } from "../../components/icon";
import { SegmentedControl } from "../../ds/components/segmented";
import { press } from "../../ds/motion/press";
import { copyWithToast, Kbd } from "../../ui";
import { useHost, useModal, useSession, useTranscriptCtx, useUI } from "../ctx";
import { SessionRow, type SessionRowCtx } from "./SessionSidebar";
import { FloatMenu } from "./FloatMenu";
import { HostCard } from "./HostCard";
import { SidebarToggle } from "./SidebarToggle";
import { RadialSpokeSpinner, UnreadDot } from "./LiveIndicators";
import type { Project, SessionSummary } from "../types";

interface SessionMenuState {
  sessionId: string;
  anchor: HTMLElement;
  fallback: SessionSummary;
}

interface ProjectMenuState {
  projectId: string;
  anchor: HTMLElement;
  fallback: Project;
}

export function WorkspaceSidebar() {
  const hosts = useHost();
  const s = useSession();
  const t = useTranscriptCtx();
  const m = useModal();
  const ui = useUI();
  const [narrowViewport, setNarrowViewport] = createSignal(
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? Boolean(window.matchMedia("(max-width: 767.98px)")?.matches)
      : false,
  );
  onMount(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(max-width: 767.98px)");
    if (!mql) return;
    setNarrowViewport(Boolean(mql.matches));
    const onChange = () => setNarrowViewport(Boolean(mql.matches));
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      onCleanup(() => mql.removeEventListener("change", onChange));
    }
  });
  const overlaySidebar = () => ui.isMobile() || narrowViewport();

  const [localSessionMenu, setLocalSessionMenu] = createSignal<SessionMenuState | null>(null);
  const [localProjectMenu, setLocalProjectMenu] = createSignal<ProjectMenuState | null>(null);
  const sessionMenu = () => (s.sessionMenu ? s.sessionMenu() : localSessionMenu());
  const setSessionMenu = (
    v: SessionMenuState | null | ((prev: SessionMenuState | null) => SessionMenuState | null),
  ) => (s.setSessionMenu ? s.setSessionMenu(v as any) : setLocalSessionMenu(v as any));
  const projectMenu = () => (s.projectMenu ? s.projectMenu() : localProjectMenu());
  const setProjectMenu = (
    v: ProjectMenuState | null | ((prev: ProjectMenuState | null) => ProjectMenuState | null),
  ) => (s.setProjectMenu ? s.setProjectMenu(v as any) : setLocalProjectMenu(v as any));
  let activeLongPressCancel: (() => void) | null = null;
  const cancelActiveLongPress = () => {
    activeLongPressCancel?.();
    activeLongPressCancel = null;
  };
  const closeSessionMenu = () => setSessionMenu(null);
  const closeProjectMenu = () => setProjectMenu(null);
  const openSessionMenu = (sess: SessionSummary, anchor: HTMLElement) => {
    ui.closeMenus?.();
    setProjectMenu(null);
    setSessionMenu({ sessionId: sess.id, anchor, fallback: sess });
  };
  const resolveMenuSession = (menu: SessionMenuState): SessionSummary =>
    s.sessions?.().find((item) => item.id === menu.sessionId) ?? menu.fallback;
  const resolveMenuProject = (menu: ProjectMenuState): Project =>
    s.projects?.().find((item) => item.id === menu.projectId) ?? menu.fallback;

  createEffect(() => {
    if (!ui.sidebarOpen()) {
      cancelActiveLongPress();
      setSessionMenu(null);
      setProjectMenu(null);
      if (overlaySidebar() && s.renamingId()) {
        s.setRenamingId(null);
      }
    }
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
    isSessionUnread: (sess) => Boolean(s.isSessionUnread?.(sess)),
    sessionAttentionLabel: (sess) => s.sessionAttentionLabel?.(sess) ?? "Unread update",
    openContextMenu: openSessionMenu,
    contextMenuSessionId: () => sessionMenu()?.sessionId ?? null,
    registerLongPressCancel: (cancel) => {
      activeLongPressCancel = cancel;
    },
  });
  const renderRow = (sess: SessionSummary) => SessionRow(rowCtx(), sess);
  const renderListToggle = (key: string, count: number) => (
    <Show when={count > 10}>
      <button
        type="button"
        data-session-list-toggle={key}
        class="inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs text-fg-muted hover:text-fg transition-colors cursor-pointer rounded-md"
        aria-expanded={Boolean(s.isSessionListExpanded?.(key))}
        onClick={() => s.toggleSessionListExpanded?.(key)}
      >
        <span>{s.isSessionListExpanded?.(key) ? "Show less" : `See all (${count})`}</span>
        <Show when={Boolean(s.hasHiddenUnreadSessions?.(key))}>
          <UnreadDot size="sm" label="Unread conversations hidden" />
        </Show>
      </button>
    </Show>
  );
  const currentView = () => s.sidebarView?.() ?? "projects";
  const projectsTabUnread = () =>
    currentView() === "talk" &&
    (s.sessions?.() ?? []).some(
      (item) => !(s.isTalkSession?.(item) ?? false) && Boolean(s.isSessionUnread?.(item)),
    );
  const talkTabUnread = () =>
    currentView() === "projects" &&
    (s.talkSessions?.() ?? []).some((item) => Boolean(s.isSessionUnread?.(item)));
  return (
<>
<Show when={overlaySidebar() && ui.sidebarOpen()}>
  <div
    class="fixed inset-0 z-30 bg-(--overlay-scrim) transition-opacity"
    onClick={() => ui.setSidebarOpen(false)}
  />
</Show>
<aside
  inert={!ui.sidebarOpen() || undefined}
  aria-hidden={!ui.sidebarOpen() || undefined}
  class={`rc-sidebar bg-surface-subtle border-r border-border flex flex-col shrink-0 transition-all duration-200 ${
    ui.sidebarOpen()
      ? overlaySidebar()
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
  <nav aria-label="Workspace navigation" class="px-2.5 pt-2 pb-1.5 space-y-0.5 shrink-0">
    <a
      href="#/"
      onClick={handleBackToGatewayClick}
      onPointerDown={(e) => press(e.currentTarget)}
      class="rc-nav-row text-fg-muted hover:text-fg hover:bg-surface-muted/75"
    >
      <span aria-hidden="true" class="rc-nav-icon">
        <Iconify icon="lucide:arrow-left" size={14} />
      </span>
      <span class="truncate">Back to gateway</span>
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
          ? "bg-surface-strong/70 font-medium text-fg"
          : "text-fg-secondary hover:text-fg hover:bg-surface-muted/75"
      }`}
    >
      <span aria-hidden="true" class="rc-nav-icon text-fg-muted">
        <Iconify icon="lucide:square-pen" size={14} />
      </span>
      <span class="truncate">New conversation</span>
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
          ? "bg-surface-strong/70 font-medium text-fg"
          : "text-fg-secondary hover:text-fg hover:bg-surface-muted/75"
      }`}
    >
      <span aria-hidden="true" class="rc-nav-icon text-fg-muted">
        <Iconify icon="lucide:history" size={14} />
      </span>
      <span class="min-w-0 flex-1 truncate">Conversation history</span>
      <Show when={!overlaySidebar()}>
        <Kbd class="shrink-0">Ctrl K</Kbd>
      </Show>
    </button>
  </nav>

  <div class="mx-2.5 border-t border-border-subtle shrink-0" />

  {/* Projects & Sessions */}
  <div
    onScroll={() => {
      cancelActiveLongPress();
      if (sessionMenu()) setSessionMenu(null);
      if (projectMenu()) setProjectMenu(null);
    }}
    class="flex-1 overflow-y-auto px-2.5 pt-2 pb-2 space-y-2 min-h-0"
  >
      <div class="flex items-center justify-between gap-1.5 pb-0.5">
        <Show
          when={s.selectionMode()}
          fallback={
            <SegmentedControl
              size="sm"
              label="Sidebar list view"
              class="[&_.ui-segment]:px-2.5 [&_.ui-segment]:text-[11px] [&_.ui-segment]:gap-1.5"
              value={currentView()}
              onChange={(next) => s.setSidebarView?.(next)}
              options={[
                {
                  value: "projects" as const,
                  label: (
                    <>
                      <span>Projects</span>
                      <Show when={projectsTabUnread()}>
                        <UnreadDot size="sm" label="Unread project conversations" />
                      </Show>
                    </>
                  ),
                },
                {
                  value: "talk" as const,
                  label: (
                    <>
                      <span>Talk</span>
                      <Show when={talkTabUnread()}>
                        <UnreadDot size="sm" label="Unread talk conversations" />
                      </Show>
                    </>
                  ),
                },
              ]}
            />
          }
        >
          <div class="flex items-center gap-2">
            <span class="text-2xs font-medium text-fg-secondary tabular-nums">
              {s.selectedSessions().size} selected
            </span>
            <button
              type="button"
              onClick={() => s.selectAllSessions()}
              class="px-2 py-0.5 rounded-md text-2xs font-medium text-fg-muted hover:text-fg hover:bg-surface-muted cursor-pointer transition-colors"
            >
              {s.sessions().length > 0 && s.selectedSessions().size === s.sessions().length ? "Deselect All" : "Select All"}
            </button>
          </div>
        </Show>
        <div class="flex items-center gap-0.5 shrink-0">
          {/* Selection mode toggle */}
          <button
            type="button"
            onClick={() => {
              if (s.selectionMode()) s.exitSelectionMode();
              else s.setSelectionMode(true);
            }}
            class={`ui-icon-button h-6.5 w-6.5 rounded-md ${s.selectionMode() ? "bg-surface-muted text-fg" : "text-fg-muted hover:text-fg hover:bg-surface-muted"}`}
            data-rc-tip={s.selectionMode() ? "Exit selection mode" : "Select conversations"} aria-label={s.selectionMode() ? "Exit selection mode" : "Select conversations"}
          >
            <Iconify icon={s.selectionMode() ? "lucide:x" : "lucide:list-checks"} size={14} />
          </button>
          <Show when={currentView() === "projects"}>
            <div>
              <button
                type="button"
                ref={(el) => (s.newProjBtn = el)}
                data-menubtn
                aria-expanded={s.newProjectMenuOpen()}
                onClick={(e) => {
                  e.stopPropagation();
                  const next = !s.newProjectMenuOpen();
                  ui.closeMenus?.();
                  s.setNewProjectMenuOpen(next);
                }}
                class="ui-icon-button h-6.5 w-6.5 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted"
                data-rc-tip="Create new project" aria-label="Create new project"
              >
                <Iconify icon="lucide:folder-plus" size={14} />
              </button>
              <FloatMenu
                anchor={() => s.newProjBtn}
                open={s.newProjectMenuOpen()}
                onClose={() => s.setNewProjectMenuOpen(false)}
                placement="bottom-end"
                width="11.5rem"
              >
                <button
                  type="button"
                  onClick={() => {
                    s.newProjBtn?.focus();
                    s.setNewProjectMenuOpen(false);
                    s.openNewProjectModal();
                  }}
                  class="ui-menu-item rounded-lg px-2.5 py-1.5 text-xs text-fg hover:bg-surface-muted"
                >
                  <Iconify icon="lucide:folder-plus" size={13} class="text-fg-muted shrink-0" />
                  <span>New project</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    s.newProjBtn?.focus();
                    s.setNewProjectMenuOpen(false);
                    s.quickStartProject();
                  }}
                  class="ui-menu-item rounded-lg px-2.5 py-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-muted"
                >
                  <Iconify icon="lucide:zap" size={13} class="text-warning shrink-0" />
                  <span>Quick start</span>
                </button>
              </FloatMenu>
            </div>
          </Show>
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
          {renderListToggle("talk", (s.talkSessions?.() ?? []).length)}
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
       <div class="space-y-1">
            <For each={s.projects()}>
              {(p) => {
                const list = () => s.projectSessions(p.id);
                const activeProj = () => {
                  if (s.draftMode?.()) {
                    const draftProjId = s.currentProject?.()?.id || s.activeProjectId() || s.activeProject()?.id || "";
                    return draftProjId === p.id;
                  }
                  return (s.currentProject?.()?.id || "") === p.id;
                };
                const folderHasUnread = () =>
                  !s.isProjectExpanded(p) && list().some((sess) => Boolean(s.isSessionUnread?.(sess)));
                const folderHasRunning = () =>
                  !s.isProjectExpanded(p) &&
                  list().some(
                    (sess) =>
                      sess.status === "running" ||
                      (sess.id === s.activeSessionId() && t.sessionStatus() === "running"),
                  );
                return (
                  <div data-project-id={p.id}>
                    <div
                      class={`group flex h-7.5 items-center gap-1 pr-1 rounded-lg text-[12.5px] transition-colors ${
                        activeProj()
                          ? "bg-surface-strong/70 font-medium text-fg"
                          : folderHasUnread()
                            ? "font-medium text-fg hover:bg-surface-muted/75"
                            : "font-normal text-fg-secondary hover:bg-surface-muted/75 hover:text-fg"
                      }`}
                      data-rc-tip={p.path}
                    >
                      <button
                        type="button"
                        aria-label="Toggle project"
                        aria-expanded={s.isProjectExpanded(p)}
                        data-rc-tip="Toggle project"
                        onPointerDown={(e) => press(e.currentTarget)}
                        onClick={() => {
                          s.pickProject(p.id);
                          s.toggleProjectExpanded(p.id);
                        }}
                        class="flex items-center gap-1.5 min-w-0 flex-1 h-7.5 pl-2 pr-1 text-left cursor-pointer rounded-lg"
                      >
                        <span aria-hidden="true" class="inline-flex h-4 w-4 shrink-0 items-center justify-center text-fg-muted">
                          <Iconify
                            icon="lucide:chevron-right"
                            size={12}
                            class={`shrink-0 transition-transform ${s.isProjectExpanded(p) ? "rotate-90" : ""}`}
                          />
                        </span>
                        <Iconify icon="lucide:folder" size={13} class="shrink-0 text-fg-muted" />
                        <span class={`truncate flex-1 ${activeProj() || folderHasUnread() ? "font-medium text-fg" : "font-normal"}`}>{p.name}</span>
                      </button>
                      <div class="flex items-center justify-end gap-0.5 shrink-0">
                        <Show when={folderHasUnread() || folderHasRunning()}>
                          {/* The roll-up stays visible while the row is hovered or focused:
                              desktop row actions slide in to its left so the glyph never moves. */}
                          <span
                            data-project-collapsed-status={folderHasUnread() ? "unread" : "running"}
                            class={`pointer-events-none flex h-6 w-6 items-center justify-center ${
                              !overlaySidebar() ? "order-last" : ""
                            }`}
                          >
                            <Show
                              when={folderHasUnread()}
                              fallback={<RadialSpokeSpinner size={12} class="text-fg-muted" />}
                            >
                              <UnreadDot label="Unread conversation in project" />
                            </Show>
                          </span>
                        </Show>
                        <Show
                          when={!overlaySidebar()}
                          fallback={
                            <button
                              type="button"
                              data-project-menubtn
                              aria-label={`Project actions for ${p.name}`}
                              aria-haspopup="menu"
                              aria-expanded={projectMenu()?.projectId === p.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                ui.closeMenus?.();
                                setSessionMenu(null);
                                setProjectMenu((prev) =>
                                  prev?.projectId === p.id
                                    ? null
                                    : { projectId: p.id, anchor: e.currentTarget, fallback: p },
                                );
                              }}
                              class="ui-icon-button ui-icon-button-xs text-fg-muted hover:text-fg hover:bg-surface-subtle"
                            >
                              <Iconify icon="lucide:ellipsis" size={14} />
                            </button>
                          }
                        >
                          <div class="rc-row-actions hidden group-hover:flex group-focus-within:flex items-center gap-0.5">
                            <button
                              type="button"
                              aria-label={`Copy path for ${p.name}`}
                              data-rc-tip="Copy project path"
                              onClick={(e) => {
                                e.stopPropagation();
                                void copyWithToast(p.path);
                              }}
                              class="rc-row-action flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer"
                            >
                              <Iconify icon="lucide:copy" size={12} />
                            </button>
                            <button
                              type="button"
                              aria-label={`New conversation in ${p.name}`}
                              data-rc-tip="New conversation in this project"
                              onClick={(e) => { e.stopPropagation(); s.startNewConversation(p.id); }}
                              class="rc-row-action flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer"
                            >
                              <Iconify icon="lucide:plus" size={13} />
                            </button>
                            <Show when={!p.protected}>
                              <button
                                type="button"
                                onClick={(e) => s.deleteProject(p.id, e)}
                                class="rc-row-action flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:text-danger hover:bg-danger-subtle cursor-pointer shrink-0"
                                data-rc-tip="Remove project" aria-label={`Remove ${p.name}`}
                              >
                                <Iconify icon="lucide:x" size={12} />
                              </button>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </div>
                    <Show when={s.isProjectExpanded(p)}>
                      <div class="ml-[17.5px] mt-0.5 space-y-0.5 border-l border-border pl-2">
                        <For each={s.visibleSessions(p.id, list())}>
                          {(sess) => renderRow(sess)}
                        </For>
                        {renderListToggle(p.id, list().length)}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={s.looseSessions().length > 0}>
              <div class="pt-2 mt-1.5 border-t border-border-subtle">
                <div class="px-2.5 pb-1 text-2xs font-medium text-fg-muted select-none">
                  Other
                </div>
                <div class="space-y-0.5">
                  <For each={s.visibleSessions("loose", s.looseSessions())}>
                    {(sess) => renderRow(sess)}
                  </For>
                  {renderListToggle("loose", s.looseSessions().length)}
                </div>
              </div>
            </Show>
          </div>
      </Show>
      </Show>
    </div>
  {/* Mobile project actions FloatMenu */}
  <Show when={projectMenu()} keyed>
    {(menu) => {
      const proj = () => resolveMenuProject(menu);
      return (
        <FloatMenu
          anchor={() => (menu.anchor.isConnected ? menu.anchor : undefined)}
          open={true}
          placement="bottom-end"
          width="13rem"
          aria-label="Project actions"
          onClose={closeProjectMenu}
        >
          <div class="px-2.5 py-1.5 mb-0.5 border-b border-border-subtle text-2xs font-medium text-fg-muted truncate select-none">
            {proj().name}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = proj();
              closeProjectMenu();
              s.startNewConversation(target.id);
              ui.closeSidebarOnMobile();
            }}
            class="ui-menu-item rounded-lg px-2.5 py-1.5 text-xs text-fg hover:bg-surface-muted"
          >
            <Iconify icon="lucide:plus" size={13} class="text-fg-muted shrink-0" />
            <span>New conversation</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = proj();
              closeProjectMenu();
              void copyWithToast(target.path);
            }}
            class="ui-menu-item rounded-lg px-2.5 py-1.5 text-xs text-fg hover:bg-surface-muted"
          >
            <Iconify icon="lucide:copy" size={13} class="text-fg-muted shrink-0" />
            <span>Copy project path</span>
          </button>
          <Show when={!proj().protected}>
            <div role="separator" class="my-1 border-t border-border-subtle" />
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                const target = proj();
                closeProjectMenu();
                s.deleteProject(target.id, e);
              }}
              class="ui-menu-item ui-menu-item-danger rounded-lg px-2.5 py-1.5 text-xs hover:bg-danger-subtle"
            >
              <Iconify icon="lucide:trash-2" size={13} class="shrink-0" />
              <span>Remove project</span>
            </button>
          </Show>
        </FloatMenu>
      );
    }}
  </Show>
  {/* Session long-press / right-click context menu */}
  <Show when={sessionMenu()} keyed>
    {(menu) => {
      const target = () => resolveMenuSession(menu);
      return (
        <FloatMenu
          anchor={() => (menu.anchor.isConnected ? menu.anchor : undefined)}
          containAnchor={false}
          open={true}
          placement="bottom-start"
          width="13.5rem"
          aria-label="Conversation actions"
          onClose={closeSessionMenu}
        >
          <div
            data-session-menu-header
            class="px-2.5 py-1.5 mb-0.5 border-b border-border-subtle text-2xs font-medium text-fg-muted truncate select-none"
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
            class="ui-menu-item rounded-lg px-2.5 py-1.5 text-xs text-fg hover:bg-surface-muted"
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
            class="ui-menu-item rounded-lg px-2.5 py-1.5 text-xs text-fg hover:bg-surface-muted"
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
            class="ui-menu-item rounded-lg px-2.5 py-1.5 text-xs text-fg hover:bg-surface-muted"
          >
            <Iconify icon="lucide:check-square" size={13} class="text-fg-muted shrink-0" />
            <span>Select</span>
          </button>
          <div role="separator" class="my-1 border-t border-border-subtle" />
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              const sess = target();
              closeSessionMenu();
              void s.deleteSession(sess.id, e);
            }}
            class="ui-menu-item ui-menu-item-danger rounded-lg px-2.5 py-1.5 text-xs hover:bg-danger-subtle"
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
    <div class="px-2.5 py-2 border-t border-border bg-surface">
      <div class="flex items-center justify-between gap-2">
        <span class="text-2xs text-fg-muted truncate tabular-nums">
          {s.selectedSessions().size > 0
            ? `${s.selectedSessions().size} selected`
            : "Select conversations to delete"}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={s.pinSelected}
            disabled={s.selectedSessions().size === 0}
            class={`px-2 py-1 rounded-lg text-2xs font-medium border border-border transition-colors ${
              s.selectedSessions().size > 0
                ? "bg-surface-subtle text-fg-secondary hover:text-fg hover:bg-surface-muted cursor-pointer"
                : "opacity-50 cursor-not-allowed bg-surface-subtle text-fg-muted"
            }`}
          >
            Pin / unpin
          </button>
          <button
            type="button"
            onClick={s.deleteSelected}
            disabled={s.selectedSessions().size === 0}
            class={`px-2 py-1 rounded-lg text-2xs font-medium border transition-colors ${
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

  <div class="px-2.5 py-2 border-t border-border space-y-0.5 bg-surface-subtle shrink-0">
    {/* Daemon update: primary concentric rounded-lg button above host selector */}
    <Show when={(() => { const i = ui.daemonUpdate.info(); return !!i && !!i.available && i.available !== i.current; })()}>{(() => {
      const i = ui.daemonUpdate.info()!;
      const busy = ui.daemonUpdate.applying() || hosts.activeHost()?.status === "updating";
      return (
        <div class="pb-1.5">
          <button
            type="button"
            onClick={() => ui.daemonUpdate.apply()}
            disabled={busy}
            data-rc-tip={i.current ? `Update daemon (${i.current} → ${i.available})` : `Update daemon to ${i.available}`}
            class="ui-button ui-button-primary w-full rounded-full h-6 min-h-6 py-0 px-3 text-xs gap-1.5"
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
      onClick={() => {
        m.openSettings?.();
      }}
      data-rc-tip="Host & agent settings"
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
