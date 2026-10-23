import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WorkspaceSidebar } from "../../web/src/indirect-code/components/WorkspaceSidebar";
import { NewProjectModal } from "../../web/src/indirect-code/modals/NewProjectModal";
import { createProjects } from "../../web/src/indirect-code/hooks/useProjects";
import { RemoteCodeProvider } from "../../web/src/indirect-code/ctx";
import type { Project, SessionSummary } from "../../web/src/indirect-code/types";

const initialProjects: Project[] = [
  { id: "proj-1", name: "Alpha API", path: "/home/user/alpha", hostId: "h1", createdAt: 1000 },
  { id: "proj-2", name: "Beta Web", path: "/home/user/beta", hostId: "h1", createdAt: 1000 },
];

const initialSessions: SessionSummary[] = [
  { id: "s-1", title: "Alpha Auth Refactor", cwd: "/home/user/alpha", pinned: false, updatedAt: 1000, hostId: "h1", model: "test-model", status: "idle", createdAt: 1000 },
  { id: "s-2", title: "Alpha Rate Limiting", cwd: "/home/user/alpha", pinned: true, updatedAt: 2000, hostId: "h1", model: "test-model", status: "idle", createdAt: 1000 },
  { id: "s-3", title: "Beta Frontend UI", cwd: "/home/user/beta", pinned: false, updatedAt: 3000, hostId: "h1", model: "test-model", status: "idle", createdAt: 1000 },
  { id: "s-4", title: "Loose Helper Script", cwd: "/home/user/scratch", pinned: false, updatedAt: 4000, hostId: "h1", model: "test-model", status: "idle", createdAt: 1000 },
];

function Fixture() {
  const [sessions, setSessions] = createSignal<SessionSummary[]>(initialSessions);
  const [projectsList, setProjectsList] = createSignal<Project[]>(initialProjects);
  const [activeSessionId, setActiveSessionId] = createSignal<string>("s-1");
  const [historyView, setHistoryView] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [commands, setCommands] = createSignal<any[]>([]);
  const submittedRenames: Array<{ id: string; title: string }> = [];

  const send = (cmd: any) => {
    setCommands((prev) => [...prev, cmd]);
    if (cmd.type === "rename_session") {
      submittedRenames.push({ id: cmd.sessionId, title: cmd.title });
      setSessions((prev) =>
        prev.map((s) => (s.id === cmd.sessionId ? { ...s, title: cmd.title } : s))
      );
    }
    if (cmd.type === "toggle_pin") {
      setSessions((prev) =>
        prev.map((s) => (s.id === cmd.sessionId ? { ...s, pinned: !s.pinned } : s))
      );
    }
  };

  const p = createProjects({
    send,
    isOpen: () => true,
    getHostId: () => "h1",
    sessions,
    projects: projectsList,
    toast: (msg) => console.log("Toast:", msg),
    showConfirm: async () => true,
    isHostOnline: () => true,
  });

  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  const [hostMenuAnchor, setHostMenuAnchor] = createSignal<string | null>(null);

  const hostValue: any = {
    hosts: () => [{ id: "h1", name: "Host 1", status: "online" }],
    activeHost: () => ({ id: "h1", name: "Host 1", status: "online" }),
    activeHostId: () => "h1",
    connectionState: () => "connected",
    wsOpen: () => true,
    hostMenuOpen,
    setHostMenuOpen,
    hostMenuAnchor,
    setHostMenuAnchor,
    send,
  };

  const sessionValue: any = {
    ...p,
    sessions,
    projects: projectsList,
    activeSession: () => sessions().find((s) => s.id === activeSessionId()) || null,
    currentProject: () => projectsList().find((pr) => pr.id === p.activeProjectId()) || null,
    activeSessionId,
    draftMode: () => false,
    creatingSession: () => false,
    selectSession: (id: string) => setActiveSessionId(id),
    startNewConversation: () => {},
    deleteSession: (id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
    },
    workspace: () => null,
    workspaceBlocked: () => false,
    workspacePath: () => "/home/user/alpha",
    workspaceState: () => "idle",
    checkWorkspace: () => {},
    newProjBtn: undefined,
    projBtn: undefined,
  };

  const transcriptValue: any = {
    sessionStatus: () => "idle",
    turnActivity: () => null,
    cancelTurnForSession: () => {},
  };

  const modalValue: any = {
    openSettings: () => {},
  };

  const uiValue: any = {
    isMobile: () => false,
    sidebarOpen,
    setSidebarOpen,
    setHistoryView,
    closeSidebarOnMobile: () => {},
    daemonUpdate: {
      info: () => null,
      toggle: () => {},
      apply: () => {},
      applying: () => false,
    },
  };

  (window as any).sidebarTestApi = {
    p,
    sessions,
    setSessions,
    projectsList,
    setProjectsList,
    activeSessionId,
    setActiveSessionId,
    historyView,
    setHistoryView,
    commands,
    submittedRenames,
    sessionValue,
  };

  return (
    <RemoteCodeProvider
      host={hostValue}
      session={sessionValue}
      transcript={transcriptValue}
      turnChanges={{} as any}
      composer={{} as any}
      queue={{ queues: () => ({}), queueOf: () => [] } as any}
      background={{ jobs: () => [], sessionJobs: () => [], running: () => [], output: () => ({}), clock: () => 0 } as any}
      modal={modalValue}
      ui={uiValue}
    >
      <div class="flex h-screen bg-ink-950 text-ink-100 font-sans">
        <WorkspaceSidebar />
        <NewProjectModal />
        <main class="flex-1 p-8 space-y-4">
          <h1 class="text-xl font-bold">Main Content Area</h1>
          <button
            id="outside-click-target"
            class="px-4 py-2 rounded bg-ink-800 text-ink-100 hover:bg-ink-700 focus:ring-2 focus:ring-brand-500"
          >
            Outside Target Button
          </button>
        </main>
      </div>
    </RemoteCodeProvider>
  );
}

render(() => <Fixture />, document.getElementById("root")!);
