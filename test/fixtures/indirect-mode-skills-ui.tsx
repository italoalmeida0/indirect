import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createComposer } from "../../web/src/indirect-code/hooks/useComposer";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { createReview } from "../../web/src/indirect-code/hooks/useReview";
import { createSessionOptions } from "../../web/src/indirect-code/hooks/useSessionOptions";
import { createProjects } from "../../web/src/indirect-code/hooks/useProjects";
import { ToolbarContext } from "../../web/src/indirect-code/components/composer/ToolbarContext";
import { ComposerFooter } from "../../web/src/indirect-code/components/composer/ComposerFooter";
import { WorkspaceSidebar } from "../../web/src/indirect-code/components/WorkspaceSidebar";
import { RemoteCodeProvider } from "../../web/src/indirect-code/ctx";
import { baseMode, effectiveModeSkills } from "../../web/src/indirect-code/utils/modeSkills";
import type { SkillConfig } from "../../web/src/indirect-code/types";

const api: any = { commands: [] };
(window as any).modeSkillsUI = api;
render(() => {
  const [sid, setSid] = createSignal("");
  const [draftMode, setDraftMode] = createSignal(true);
  const [official, setOfficial] = createSignal<Record<string, SkillConfig>>({});
  const [loaded, setLoaded] = createSignal(false);
  const send = (command: any) => {
    api.commands.push(command);
  };
  const baseSession = { hostId: "host-a", model: "m", status: "idle", pinned: false, createdAt: 1 };
  const [sessions] = createSignal<any[]>([
    { ...baseSession, id: "talk-1", cwd: "/home/tester", title: "Talk about cats", updatedAt: 300, options: { effort: "medium", mode: "talk", skills: [], access: "full" }, skills: { talk: { priority: 1, active: true, usable: "" } } },
    { ...baseSession, id: "talk-2", cwd: "/home/tester", title: "Talk about rust", updatedAt: 200, options: { effort: "medium", mode: "talk", skills: [], access: "full" }, skills: { talk: { priority: 1, active: true, usable: "" } } },
    { ...baseSession, id: "agent-1", cwd: "/work/proj", title: "Build the thing", updatedAt: 100, options: { effort: "medium", mode: "agentic", skills: [], access: "ask" }, skills: { build: { priority: 1, active: true, usable: "" } } },
  ]);
  const [projectsList] = createSignal<any[]>([
    { id: "home", hostId: "host-a", name: "Home", path: "/home/tester", createdAt: 1, protected: true },
    { id: "p1", hostId: "host-a", name: "Proj", path: "/work/proj", createdAt: 2 },
  ]);
  const opts = {
    send,
    toast: () => {},
    isOpen: () => true,
    getSessionId: sid,
    getHostId: () => "host-a",
    getProjectId: () => "project",
    isHostOnline: () => true,
  };
  const t = createTranscript({
    ...opts,
    showChoice: async () => "resend",
    onTurnIdle: () => {},
    onUsageContext: () => {},
  });
  const review = createReview({
    ...opts,
    isSessionRunning: () => false,
    showConfirm: async () => true,
  });
  const projects = createProjects({
    send,
    isOpen: () => true,
    getHostId: () => "host-a",
    sessions,
    projects: projectsList,
    toast: () => {},
    showConfirm: async () => true,
    isHostOnline: () => true,
  });
  /** Mirrors IndirectCodePage.lockedSessionMode: an existing session's
   * mode is fixed; undefined in draft. */
  function lockedSessionMode(): "agentic" | "talk" | undefined {
    if (draftMode() || !sid()) return undefined;
    return baseMode(sessions().find((s) => s.id === sid())?.options?.mode || options.agentMode());
  }
  // Wired exactly like IndirectCodePage: official daemon list wins, the
  // 4-skill cache answers before it loads.
  const options = createSessionOptions({
    send,
    getSessionId: sid,
    getSkill: (name) => {
      const real = official()[name];
      if (real) return { mode: real.mode, usable: real.usable };
      const cached = effectiveModeSkills(undefined, false).find((m) => m.name === name);
      return cached ? { mode: cached.mode, usable: cached.usable } : undefined;
    },
    listModeSkills: () => {
      const list = effectiveModeSkills(official(), loaded());
      const locked = lockedSessionMode();
      return (locked ? list.filter((m) => baseMode(m.mode) === locked) : list).map((m) => m.name);
    },
    getLockedMode: () => lockedSessionMode(),
  });
  const c = createComposer({
    ...opts,
    isDisposed: () => false,
    getModel: () => "m",
    getOptions: () => options.sessionOptions(),
    isSessionRunning: () => false,
    isWorkspaceBlocked: () => false,
    checkWorkspace: () => {},
    t,
    o: {
      configureSession: () => options.configureSession(),
      setActiveModel: () => {},
      setEffort: () => {},
    },
    onClearConversation: () => {},
    onBeginConversation: () => {},
    isCreatingSession: () => false,
  });
  function selectSession(id: string) {
    setSid(id);
    setDraftMode(false);
    const sess = sessions().find((s) => s.id === id);
    if (sess) {
      options.applyOptions(sess.options);
      options.applySessionSkills(sess.skills);
    }
  }
  function startNewConversation(projectId?: string) {
    if (projectId) projects.setActiveProjectId(projectId);
    setSid("");
    setDraftMode(true);
    options.ensureSelection();
  }
  Object.assign(api, { options, c, t, projects, setOfficial, setLoaded, setSid, setDraftMode, selectSession, draftMode, sid });
  const composerValue = {
    ...c,
    activeModel: options.activeModel,
    activeModelName: () => "m",
    effort: options.effort,
    agentMode: options.agentMode,
    setAgentMode: options.setAgentMode,
    selectedSkills: options.selectedSkills,
    setSelectedSkills: options.setSelectedSkills,
    syncSkills: options.syncSkills,
    pendingMode: options.pendingMode,
    approvalMode: options.approvalMode,
    skillUsables: options.skillUsables,
    cycleSkillUsable: options.cycleSkillUsable,
    yoloMode: options.yoloMode,
    setYoloMode: options.setYoloMode,
    modeMenuOpen: options.modeMenuOpen,
    setModeMenuOpen: options.setModeMenuOpen,
    accessMenuOpen: options.accessMenuOpen,
    setAccessMenuOpen: options.setAccessMenuOpen,
    modeBtn: options.modeBtn,
    accessBtn: options.accessBtn,
    configureSession: options.configureSession,
    modelPickerBody: () => <div>models</div>,
    activeContext: () => ({ label: "0%", window: 0, percent: null }),
    addBtn: undefined,
    modelBtn: undefined,
  };
  const modalValue = { ...review, savedSkills: official, skillsLoaded: loaded, openSettings: () => {}, generatePairingToken: async () => {} };
  const sessionValue = {
    ...projects,
    sessions,
    projects: projectsList,
    activeSession: () => sessions().find((s) => s.id === sid()) ?? null,
    currentProject: () => projectsList()[0],
    activeSessionId: sid,
    draftMode,
    creatingSession: () => false,
    selectSession,
    startNewConversation,
    deleteSession: () => {},
    workspace: () => "ready",
    workspaceBlocked: () => false,
    workspacePath: () => "",
    workspaceState: () => "ready",
    checkWorkspace: () => {},
    newProjBtn: undefined,
    projBtn: undefined,
  };
  const hostValue = {
    hostMenuOpen: () => false,
    hostMenuAnchor: () => "",
    setHostMenuAnchor: () => {},
    setHostMenuOpen: () => {},
    activeHost: () => ({ name: "Test host", hostname: "test", status: "online" }),
    connectionState: () => "connected",
    hosts: () => [],
    activeHostId: () => "host-a",
    setActiveHostId: () => {},
    loadHosts: async () => {},
    removeHost: async () => {},
  };
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const uiValue = {
    isMobile: () => false,
    closeMenus: () => {},
    setModelMenuOpen: () => {},
    sidebarOpen,
    setSidebarOpen,
    setHistoryView: () => {},
    closeSidebarOnMobile: () => {},
    daemonUpdate: { info: () => null, applying: () => false, apply: () => {} },
    usageOpen: () => false,
    setUsageOpen: () => {},
    contextBtn: undefined,
  };
  return (
    <RemoteCodeProvider
      host={hostValue as any}
      session={sessionValue as any}
      transcript={t as any}
      turnChanges={{} as any}
      composer={composerValue as any}
      queue={{ queues: () => ({}), queueOf: () => [] } as any}
      background={{ jobs: () => [], sessionJobs: () => [], running: () => [], output: () => ({}), clock: () => 0 } as any}
      modal={modalValue as any}
      ui={uiValue as any}
    >
      <div style={{ display: "flex", height: "100vh" }}>
        <WorkspaceSidebar />
        <div style={{ flex: "1", display: "flex", "flex-direction": "column", "justify-content": "flex-end", padding: "24px" }}>
          <div style={{ display: "flex", gap: "8px" }}>
            <ToolbarContext />
          </div>
          <ComposerFooter />
        </div>
      </div>
    </RemoteCodeProvider>
  );
}, document.getElementById("root")!);
