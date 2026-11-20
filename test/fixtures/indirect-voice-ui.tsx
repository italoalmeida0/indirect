import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { setReducedMotionOverride } from "../../web/src/ds/motion/reduced";
import { Composer } from "../../web/src/indirect-code/components/Composer";
import { RemoteCodeProvider } from "../../web/src/indirect-code/ctx";
import { createComposer } from "../../web/src/indirect-code/hooks/useComposer";
import { createQueue } from "../../web/src/indirect-code/hooks/useQueue";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { createTurnChanges } from "../../web/src/indirect-code/hooks/useTurnChanges";
import { VoiceProvider } from "../../web/src/indirect-code/voice/VoiceContext";
import { createVoiceController } from "../../web/src/indirect-code/voice/useVoice";

interface ToastEntry {
  id: number;
  message: string;
  kind: "ok" | "err";
}

const api: Record<string, any> = {
  commands: [],
  toasts: [] as ToastEntry[],
  sendCount: 0,
};
(window as any).voiceFixture = api;

render(() => {
  const [sid, setSid] = createSignal("s-voice-1");
  const [host, setHost] = createSignal("h-voice-1");
  const [online] = createSignal(true);
  const [composerCollapsed, setComposerCollapsed] = createSignal(false);
  const [toasts, setToasts] = createSignal<ToastEntry[]>([]);
  const [effortMenuOpen, setEffortMenuOpen] = createSignal(false);
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [usageOpen, setUsageOpen] = createSignal(false);
  const [modeMenuOpen, setModeMenuOpen] = createSignal(false);
  const [accessMenuOpen, setAccessMenuOpen] = createSignal(false);
  const [addContextOpen, setAddContextOpen] = createSignal(false);
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);
  const [mobile, setMobile] = createSignal(false);
  let toastSeq = 0;

  const pushToast = (message: string, kind: "ok" | "err" = "ok") => {
    const entry: ToastEntry = { id: ++toastSeq, message, kind };
    api.toasts.push(entry);
    setToasts((prev) => [...prev.slice(-4), entry]);
  };

  const send = (command: any) => {
    api.commands.push(command);
    if (command.type === "prompt") {
      api.sendCount++;
      if (command.requestId) {
        queueMicrotask(() => c.notePromptReply(command.requestId));
      }
    }
  };

  const baseOpts = {
    send,
    toast: (msg: string) => pushToast(msg, "ok"),
    isOpen: online,
    getSessionId: sid,
    getHostId: host,
    getProjectId: () => "proj-voice",
    isHostOnline: online,
  };

  const t = createTranscript({
    ...baseOpts,
    showChoice: async () => null,
    onTurnIdle: () => {},
    onUsageContext: () => {},
  });

  const tc = createTurnChanges({
    send,
    getSessionId: sid,
    toast: (msg: string) => pushToast(msg, "ok"),
  });

  const q = createQueue({
    send,
    getSessionId: sid,
    isOpen: online,
    isHostOnline: online,
    isSessionRunning: () => t.sessionStatus() === "running",
    toast: (msg: string) => pushToast(msg, "ok"),
  });

  const c = createComposer({
    ...baseOpts,
    isDisposed: () => false,
    getModel: () => "claude-sonnet-4-6",
    getOptions: () => ({
      effort: "high",
      mode: "build",
      skills: [],
      access: "auto",
    }),
    isSessionRunning: () => t.sessionStatus() === "running",
    isWorkspaceBlocked: () => false,
    checkWorkspace: () => {},
    t,
    o: {
      configureSession: () => {},
      setActiveModel: () => {},
      setEffort: () => {},
      setModeMenuOpen,
    },
    onClearConversation: () => setSid(""),
    onBeginConversation: () => {},
    isCreatingSession: () => false,
  });

  const voice = createVoiceController({
    getHostId: host,
    getSessionId: sid,
    getInputPrompt: () => c.inputPrompt(),
    setInputPrompt: (value) => c.setInputPrompt(value),
    setCaret: (pos) => c.mentions.setCaret(pos),
    onBeforeStart: () => {
      setEffortMenuOpen(false);
      setModelMenuOpen(false);
      setModeMenuOpen(false);
      setAccessMenuOpen(false);
      setAddContextOpen(false);
      setUsageOpen(false);
      if (composerCollapsed()) setComposerCollapsed(false);
    },
    onToast: pushToast,
    isMobile: mobile,
    getAuthToken: () => "fixture-voice-token",
  });

  // Mirror IndirectCodePage.tsx keyboard handling for active voice
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        !e.isComposing &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        voice.state() === "listening"
      ) {
        const target = e.target as HTMLElement | null;
        if (target && target.closest("button, a, [role='button'], [role='menuitem']")) {
          return;
        }
        e.preventDefault();
        voice.confirm();
        return;
      }
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        if (voice.isActive()) {
          e.preventDefault();
          voice.cancel();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const clearToasts = () => {
    api.toasts.length = 0;
    setToasts([]);
  };

  Object.assign(api, {
    voice,
    c,
    t,
    q,
    setSid,
    setHost,
    setMobile,
    composerCollapsed,
    setComposerCollapsed,
    setReducedMotionOverride,
    clearToasts,
    setTheme: (theme: "dark" | "light" | "high-contrast") => {
      document.documentElement.dataset.theme = theme;
    },
  });

  const closeMenus = () => {
    setEffortMenuOpen(false);
    setModelMenuOpen(false);
    setModeMenuOpen(false);
    setAccessMenuOpen(false);
    setAddContextOpen(false);
    setUsageOpen(false);
    setProjectMenuOpen(false);
  };

  const ctxProps = {
    host: {
      activeHost: () => ({ id: host(), name: "Workstation", status: "online" }),
      activeHostId: host,
      hosts: () => [{ id: host(), name: "Workstation", status: "online" }],
      connectionState: () => "connected",
      wsOpen: () => true,
      send,
    },
    session: {
      activeSessionId: sid,
      activeSession: () =>
        sid()
          ? { id: sid(), title: "Voice Flow", cwd: "/repo", model: "claude-sonnet-4-6", status: t.sessionStatus() }
          : null,
      activeProject: () => ({ id: "proj-voice", name: "indirect", path: "/repo" }),
      currentProject: () => ({ id: "proj-voice", name: "indirect", path: "/repo" }),
      projects: () => [{ id: "proj-voice", name: "indirect", path: "/repo" }],
      creatingSession: () => false,
      draftMode: () => !sid(),
      workspaceBlocked: () => false,
      workspaceState: () => "available",
      workspacePath: () => "/repo",
      checkWorkspace: () => {},
      openNewProjectModal: () => {},
      pickProject: () => {},
      projectMenuOpen,
      setProjectMenuOpen,
    },
    transcript: t,
    turnChanges: tc,
    composer: {
      ...c,
      activeModel: () => "claude-sonnet-4-6",
      activeModelName: () => "Claude Sonnet",
      effort: () => "high",
      effortPreviewing: () => false,
      agentMode: () => "build",
      setAgentMode: () => {},
      configureSession: () => {},
      selectedSkills: () => ["build"],
      skillUsables: () => ({}),
      syncSkills: () => {},
      accessMode: () => "auto",
      setAccessMode: () => {},
      isFullAccess: () => false,
      addContextOpen,
      setAddContextOpen,
      addContextSubView: () => "main",
      setAddContextSubView: () => {},
      modeMenuOpen,
      setModeMenuOpen,
      accessMenuOpen,
      setAccessMenuOpen,
      activeContext: () => ({ percent: 18, label: "36k / 200k (18%)", tokensLabel: "36k / 200k" }),
      effortPickerBody: () => null,
      modelPickerBody: () => null,
    },
    queue: q,
    background: {
      jobs: () => [],
      sessionJobs: () => [],
      running: () => [],
      output: () => ({}),
      clock: () => 0,
    },
    modal: {
      previewPending: () => {},
      openStoredPreview: () => {},
      savedSkills: () => ({}),
      skillsLoaded: () => false,
      skillErrors: () => [],
    },
    ui: {
      isMobile: mobile,
      historyView: () => false,
      composerCollapsed,
      toggleComposerCollapsed: () => {
        if (voice.isActive()) return;
        setComposerCollapsed((v) => !v);
      },
      convWidthClass: () => "max-w-3xl",
      verboseChat: () => false,
      hideToolMessages: () => false,
      closeMenus,
      effortMenuOpen,
      setEffortMenuOpen,
      modelMenuOpen,
      setModelMenuOpen,
      modelFromEffort: () => false,
      setModelFromEffort: () => {},
      usageOpen,
      setUsageOpen,
    },
  } as unknown as Parameters<typeof RemoteCodeProvider>[0];

  return (
    <RemoteCodeProvider {...ctxProps}>
      <VoiceProvider value={voice}>
        <div
          id="voice-stage"
          class="min-h-screen bg-background text-fg flex flex-col justify-end pb-8"
        >
          <Show when={toasts().length > 0}>
            <div
              data-voice-toast-stack
              class="fixed top-4 right-4 z-[60] flex flex-col gap-1.5 max-w-sm"
            >
              <For each={toasts()}>
                {(item) => (
                  <div
                    role="status"
                    data-voice-toast
                    data-toast-kind={item.kind}
                    class={`rounded-panel border px-3 py-2 text-xs font-medium ${
                      item.kind === "err"
                        ? "border-danger bg-danger-subtle text-danger"
                        : "border-border bg-surface-raised text-fg"
                    }`}
                  >
                    {item.message}
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Composer />
        </div>
      </VoiceProvider>
    </RemoteCodeProvider>
  );
}, document.getElementById("root")!);
