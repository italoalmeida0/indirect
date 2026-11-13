import { createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import { Shimmer } from "../../web/src/ds/components/controls";
import { StatusBanners } from "../../web/src/indirect-code/components/composer/StatusBanners";
import { QueueCard } from "../../web/src/indirect-code/components/QueueCard";
import { AssistantTurnContent, type TranscriptRenderCtx } from "../../web/src/indirect-code/components/TranscriptBlocks";
import { TurnChangesBalloon } from "../../web/src/indirect-code/components/TurnChangesBalloon";
import { RemoteCodeProvider } from "../../web/src/indirect-code/ctx";
import { createQueue } from "../../web/src/indirect-code/hooks/useQueue";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { createTurnChanges } from "../../web/src/indirect-code/hooks/useTurnChanges";
import { elapsedLabel } from "../../web/src/indirect-code/utils/format";

const api: Record<string, any> = {};
(window as any).shimmerUI = api;

render(() => {
  const [sid] = createSignal("s-shimmer");
  const [host] = createSignal("h-shimmer");
  const [lateMount, setLateMount] = createSignal(false);
  const [composerCollapsed, setComposerCollapsed] = createSignal(false);
  const sent: unknown[] = [];

  const t = createTranscript({
    send: (p) => sent.push(p),
    isOpen: () => true,
    getSessionId: sid,
    getHostId: host,
    toast: () => {},
    showChoice: async () => null,
    onTurnIdle: () => {},
    onUsageContext: () => {},
  });

  const tc = createTurnChanges({
    send: (p) => sent.push(p),
    getSessionId: sid,
    toast: () => {},
  });

  const q = createQueue({
    send: (p) => sent.push(p),
    getSessionId: sid,
    isOpen: () => true,
    isHostOnline: () => true,
    isSessionRunning: () => t.sessionStatus() === "running",
    toast: () => {},
  });

  const rctx: TranscriptRenderCtx = {
    renderBlocks: t.renderBlocks,
    messages: t.messages,
    sessionStatus: t.sessionStatus,
    isPinned: t.transcriptScroll.isPinned,
    thinkingStart: t.thinkingStart,
    thinkingElapsed: t.thinkingElapsed,
    thinkingIndex: t.thinkingIndex,
    toolProgress: t.toolProgress,
    toolStarts: t.toolStarts,
    turnClock: t.turnClock,
    elapsedLabel,
    specialProgress: t.specialProgress,
    backgroundJobs: () => [],
    bgOutput: () => ({}),
    bgClock: () => 0,
    verboseChat: () => true,
    hideToolMessages: () => false,
    setPreviewFile: () => {},
    activeSession: () => ({ id: "s-shimmer", title: "Shimmer Audit", cwd: "/repo", updatedAt: Date.now() } as any),
    activeSessionId: sid,
    pendingApproval: t.pendingApproval,
    projects: () => [],
  };

  const ctxValues = {
    host: {
      activeHost: () => ({ id: "h-shimmer", name: "Workstation", status: "online" }),
      connectionState: () => "connected",
      wsOpen: () => true,
      send: (p: unknown) => sent.push(p),
    },
    session: {
      activeSessionId: sid,
      draftMode: () => false,
      workspaceBlocked: () => false,
      activeSession: () => ({ id: "s-shimmer", cwd: "/repo" }),
      projects: () => [],
    },
    transcript: t,
    turnChanges: tc,
    composer: {
      setInputPrompt: () => {},
      sendPrompt: async () => {},
      activeModel: () => "claude-sonnet",
      yoloMode: () => false,
      effort: () => "high",
      agentMode: () => "agentic",
      selectedSkills: () => [],
      skillUsables: () => ({}),
      approvalMode: () => "ask",
    },
    queue: q,
    background: {
      sessionJobs: () => [],
      output: () => ({}),
      clock: () => 0,
    },
    modal: {
      openStoredPreview: () => {},
      previewPending: () => {},
    },
    ui: {
      composerCollapsed,
      setComposerCollapsed,
      toggleComposerCollapsed: () => setComposerCollapsed((v) => !v),
      convWidthClass: () => "max-w-3xl",
      verboseChat: () => true,
      hideToolMessages: () => false,
      historyView: () => false,
      isMobile: () => false,
    },
  } as unknown as Parameters<typeof RemoteCodeProvider>[0];

  let streamSeq = 0;

  function seedActiveWorkspace() {
    const now = Date.now();
    t.applySnapshot("s-shimmer", {
      status: "running",
      turn: { startedAt: now - 9100, status: "running" },
      thinkingStartedAt: null,
      todos: [
        { text: "Audit CSS background-position period math", status: "completed" },
        { text: "Verify monotonic shimmer wave across 90+ rAF frames", status: "in_progress" },
      ],
      todosOpen: true,
      toolStarts: { call_cmd_1: now - 800 },
      messages: [
        { id: "u1", role: "user", turnIndex: 1, content: [{ type: "text", text: "Verify frontend shimmer polish" }] },
        {
          id: "a1",
          role: "assistant",
          turnIndex: 1,
          streaming: true,
          content: [
            { type: "reasoning", summary: "Checking background-size and keyframe wraparound continuity…" },
            { type: "tool_call", id: "call_cmd_1", name: "bash", arguments: { command: "bun scripts/check-design-tokens.ts" } },
          ],
        },
      ],
      transcript: { stream: `shimmer-run-${++streamSeq}`, seq: 1 },
    });

    tc.noteBalloon(
      {
        turnIndex: 1,
        files: [
          {
            path: "web/src/ds/components.css",
            status: "modified",
            additions: 24,
            deletions: 5,
            diff: "@@ -545,5 +545,24 @@\n+.ui-shimmer {}",
          },
        ],
      },
      true,
    );

    q.noteQueue("s-shimmer", [
      {
        id: "q-int-1",
        text: "Capture light & dark contact sheet once checks pass",
        attachmentIds: [],
        model: "claude-sonnet",
        yolo: false,
        createdAt: 1700000000001,
        delivery: "interrupt",
      },
    ]);
  }

  function seedThinkingPhase() {
    const now = Date.now();
    t.applySnapshot("s-shimmer", {
      status: "running",
      turn: { startedAt: now - 4100, status: "running" },
      thinkingStartedAt: now - 1100,
      todos: [
        { text: "Audit CSS background-position period math", status: "in_progress" },
      ],
      todosOpen: true,
      toolStarts: {},
      messages: [
        { id: "u1", role: "user", turnIndex: 1, content: [{ type: "text", text: "Verify frontend shimmer polish" }] },
        {
          id: "a1",
          role: "assistant",
          turnIndex: 1,
          streaming: true,
          content: [
            { type: "reasoning", summary: "Checking background-size and keyframe wraparound continuity…" },
          ],
        },
      ],
      transcript: { stream: `shimmer-think-${++streamSeq}`, seq: 1 },
    });
  }

  seedActiveWorkspace();

  Object.assign(api, {
    t,
    tc,
    q,
    setLateMount,
    seedThinkingPhase,
    seedActiveWorkspace,
  });

  return (
    <RemoteCodeProvider {...ctxValues}>
      <div
        id="shimmer-stage"
        data-density="compact"
        class="min-h-screen bg-bg text-fg p-6 flex flex-col gap-4 max-w-3xl mx-auto"
      >
        <div id="ds-shimmer-card" class="rounded-xl border border-border bg-surface p-3.5 flex items-center justify-between gap-4 text-xs">
          <Shimmer class="font-medium">
            Synthesizing <span>provider</span> telemetry…
          </Shimmer>
          <Show when={lateMount()}>
            <span data-late-shimmer>
              <Shimmer class="font-medium">Phase-locked mid-turn join</Shimmer>
            </span>
          </Show>
        </div>

        <div id="transcript-card" class="rounded-xl border border-border bg-surface p-4 space-y-3">
          <For each={t.renderBlocks()}>
            {(block) => (
              <Show when={block.msg.role !== "user"}>
                <AssistantTurnContent ctx={rctx} block={block} finished={t.sessionStatus() !== "running"} />
              </Show>
            )}
          </For>
          <div id="live-changes">
            <For each={tc.balloons()}>
              {(b) => (
                <TurnChangesBalloon
                  balloon={b}
                  expanded={false}
                  onToggle={() => {}}
                  live={b.live}
                />
              )}
            </For>
          </div>
          <QueueCard />
        </div>

        <div id="composer-banners" class="rounded-xl border border-border bg-surface p-4">
          <StatusBanners />
        </div>
      </div>
    </RemoteCodeProvider>
  );
}, document.getElementById("root")!);
