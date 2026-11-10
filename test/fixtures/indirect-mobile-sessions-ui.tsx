import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WorkspaceLayout, WorkspaceShell } from "../../web/src/indirect-code/IndirectCodePage";
import { WorkspaceSidebar } from "../../web/src/indirect-code/components/WorkspaceSidebar";
import { HostCtx, ModalCtx, SessionCtx, TranscriptCtx, UICtx } from "../../web/src/indirect-code/ctx";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";
import { createProjects } from "../../web/src/indirect-code/hooks/useProjects";
import type { Project, SessionSummary } from "../../web/src/indirect-code/types";

const api: any = { commands: [] as any[] };
(window as any).mobileSessionsUI = api;
document.documentElement.classList.add("mobile");

render(() => {
  const now = Date.now();
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [mobile, setMobileState] = createSignal(true);
  const setMobile = (v: boolean) => {
    document.documentElement.classList.toggle("mobile", v);
    setMobileState(v);
  };
  const [activeSessionId, setActiveSessionId] = createSignal<string>("s1");
  const [draftMode, setDraftMode] = createSignal(false);
  const [historyView, setHistoryView] = createSignal(false);

  const [projectsList] = createSignal<Project[]>([
    { id: "p1", hostId: "h1", name: "indirect", path: "/workspace/indirect", createdAt: 1 },
  ]);

  const [sessions, setSessions] = createSignal<SessionSummary[]>([
    {
      id: "s1",
      hostId: "h1",
      cwd: "/workspace/indirect",
      title: "Refactor streaming diff highlighter",
      model: "claude-sonnet-4-6",
      status: "idle",
      pinned: false,
      createdAt: now - 7_200_000,
      updatedAt: now - 300_000,
    },
    {
      id: "s2",
      hostId: "h1",
      cwd: "/workspace/indirect",
      title: "Audit daemon builtin tool bodies",
      model: "claude-sonnet-4-6",
      status: "idle",
      pinned: false,
      createdAt: now - 10_800_000,
      updatedAt: now - 1_800_000,
    },
    {
      id: "s3",
      hostId: "h1",
      cwd: "/workspace/indirect",
      title: "Run live runner smoke verification",
      model: "claude-sonnet-4-6",
      status: "running",
      pinned: true,
      createdAt: now - 600_000,
      updatedAt: now - 60_000,
    },
  ]);

  const send = (cmd: any) => {
    api.commands.push(cmd);
    if (cmd.type === "rename_session") {
      setSessions((prev) =>
        prev.map((item) => (item.id === cmd.sessionId ? { ...item, title: cmd.title } : item)),
      );
    } else if (cmd.type === "toggle_pin") {
      setSessions((prev) =>
        prev.map((item) => (item.id === cmd.sessionId ? { ...item, pinned: !item.pinned } : item)),
      );
    } else if (cmd.type === "delete_session") {
      setSessions((prev) => prev.filter((item) => item.id !== cmd.sessionId));
    }
  };

  const du = createDaemonUpdate({
    send,
    toast: () => {},
    getHostId: () => "h1",
  });

  const projects = createProjects({
    send,
    isOpen: () => true,
    getHostId: () => "h1",
    sessions,
    projects: projectsList,
    toast: () => {},
    showConfirm: async () => true,
    isHostOnline: () => true,
  });

  const selectSession = (id: string) => {
    setActiveSessionId(id);
    setDraftMode(false);
  };

  const deleteSession = (id: string, e?: MouseEvent) => {
    e?.stopPropagation();
    send({ type: "delete_session", sessionId: id });
    projects.dropVanishedSession(id);
  };

  Object.assign(api, {
    sidebarOpen,
    setSidebarOpen,
    mobile,
    setMobile,
    activeSessionId,
    sessions,
    projects,
  });

  const host: any = {
    hosts: () => [{ id: "h1", name: "devbox", hostname: "devbox", status: "online" }],
    activeHost: () => ({ id: "h1", name: "devbox", hostname: "devbox", status: "online" }),
    activeHostId: () => "h1",
    setActiveHostId: () => {},
    loadHosts: () => Promise.resolve(),
    removeHost: () => Promise.resolve(),
    connectionState: () => "connected",
    hostMenuOpen: () => false,
    setHostMenuOpen: () => {},
    hostMenuAnchor: () => null,
    setHostMenuAnchor: () => {},
  };

  const sessionCtx: any = {
    ...projects,
    sessions,
    projects: projectsList,
    activeSession: () => sessions().find((item) => item.id === activeSessionId()) ?? null,
    currentProject: () => projectsList()[0] ?? null,
    activeSessionId,
    draftMode,
    creatingSession: () => false,
    selectSession,
    startNewConversation: () => {
      setDraftMode(true);
      setActiveSessionId("");
    },
    deleteSession,
    newProjBtn: undefined,
    projBtn: undefined,
  };

  const transcript: any = {
    sessionStatus: () =>
      sessions().find((item) => item.id === activeSessionId())?.status ?? "idle",
    turnActivity: () => null,
    cancelTurnForSession: (id: string, e: MouseEvent | KeyboardEvent) => {
      e.stopPropagation();
      send({ type: "cancel_turn", sessionId: id });
    },
  };

  const modal: any = {
    generatePairingToken: () => Promise.resolve(),
    openSettings: () => {},
  };

  const ui: any = {
    daemonUpdate: du,
    isMobile: mobile,
    sidebarOpen,
    setSidebarOpen,
    closeSidebarOnMobile: () => {
      if (mobile()) setSidebarOpen(false);
    },
    setHistoryView,
    historyView,
    closeMenus: () => {
      projects.setNewProjectMenuOpen(false);
    },
  };

  return (
    <HostCtx.Provider value={host}>
      <ModalCtx.Provider value={modal}>
        <SessionCtx.Provider value={sessionCtx}>
          <TranscriptCtx.Provider value={transcript}>
            <UICtx.Provider value={ui}>
              <WorkspaceShell>
                <WorkspaceLayout sidebar={<WorkspaceSidebar />}>
                  <div id="conversation" class="flex-1 min-h-0 overflow-y-auto px-4 py-6">
                    <p class="text-xs text-fg-muted">
                      Active session: {activeSessionId() || "draft"}
                    </p>
                  </div>
                </WorkspaceLayout>
              </WorkspaceShell>
            </UICtx.Provider>
          </TranscriptCtx.Provider>
        </SessionCtx.Provider>
      </ModalCtx.Provider>
    </HostCtx.Provider>
  );
}, document.getElementById("root")!);
