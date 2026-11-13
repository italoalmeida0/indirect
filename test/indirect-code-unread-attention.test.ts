import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import type { DaemonCommand } from "../web/src/indirect-code/daemon-protocol";
import {
  sessionAttentionLabel,
  type createSessionAttention as CreateSessionAttentionFn,
  type LiveSessionAttentionOverlay,
} from "../web/src/indirect-code/hooks/useSessionAttention";
import {
  normalizeAttentionKind,
  normalizeSession,
  type RcProject,
} from "../web/src/indirect-code/store/sessions";
import type { SessionSummary } from "../web/src/indirect-code/types";

let clientSolid: {
  createRoot: typeof import("solid-js").createRoot;
  createSignal: typeof import("solid-js").createSignal;
  createSessionAttention: typeof CreateSessionAttentionFn;
};

beforeAll(async () => {
  const solidClientPath = join(process.cwd(), "node_modules", "solid-js", "dist", "solid.js");
  const entryPath = join(
    process.cwd(),
    "web",
    "src",
    "indirect-code",
    "__client_attention_entry__.ts",
  );
  const res = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "solid-client-attention-harness",
        setup(build) {
          build.onResolve({ filter: /__client_attention_entry__\.ts$/ }, () => ({
            path: entryPath,
          }));
          build.onLoad({ filter: /__client_attention_entry__\.ts$/ }, () => ({
            contents: `
              export { createRoot, createSignal } from "solid-js";
              export { createSessionAttention } from "./hooks/useSessionAttention";
            `,
            loader: "ts",
          }));
          build.onResolve({ filter: /^solid-js$/ }, () => ({
            path: solidClientPath,
          }));
        },
      },
    ],
  });
  if (!res.success || res.outputs.length === 0) {
    throw new Error(`Failed to bundle client Solid attention harness: ${JSON.stringify(res.logs)}`);
  }
  const js = await res.outputs[0]!.text();
  clientSolid = await import(
    `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`
  );
});

function flushReactive() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    hostId: overrides.hostId ?? "h1",
    cwd: overrides.cwd ?? "/work/app",
    title: overrides.title ?? `Session ${overrides.id}`,
    model: overrides.model ?? "claude-sonnet",
    status: overrides.status ?? "idle",
    pinned: overrides.pinned ?? false,
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 2000,
    attentionSeq: overrides.attentionSeq,
    seenSeq: overrides.seenSeq,
    attentionKind: overrides.attentionKind,
    options: overrides.options ?? {
      effort: "medium",
      mode: "agentic",
      skills: [{ name: "build" }],
      access: "full",
    },
  };
}

describe("normalizeSession & sessionAttentionLabel", () => {
  test("normalizes attentionSeq, seenSeq, and attentionKind from wire rows", () => {
    const s1 = normalizeSession(
      {
        id: "s1",
        title: "Build check",
        status: "running",
        createdAt: 100,
        updatedAt: 200,
        attentionSeq: 4,
        seenSeq: 2,
        attentionKind: "approval",
      },
      "host-a",
    );
    expect(s1.attentionSeq).toBe(4);
    expect(s1.seenSeq).toBe(2);
    expect(s1.attentionKind).toBe("approval");

    const s2 = normalizeSession(
      {
        id: "s2",
        title: "Clean row",
        status: "idle",
        createdAt: 100,
        updatedAt: 200,
        attentionSeq: 0,
        seenSeq: -3,
        attentionKind: "bogus-kind",
      },
      "host-a",
    );
    expect(s2.attentionSeq).toBeUndefined();
    expect(s2.seenSeq).toBeUndefined();
    expect(s2.attentionKind).toBeUndefined();
    expect(normalizeAttentionKind("question")).toBe("question");
    expect(normalizeAttentionKind("completed")).toBe("completed");
    expect(normalizeAttentionKind("error")).toBe("error");
    expect(normalizeAttentionKind("cancelled")).toBe("cancelled");
    expect(normalizeAttentionKind("")).toBeUndefined();
  });

  test("maps semantic attention kinds to concise tooltip labels", () => {
    expect(sessionAttentionLabel("approval")).toBe("Waiting for approval");
    expect(sessionAttentionLabel("question")).toBe("Waiting for your answer");
    expect(sessionAttentionLabel("error")).toBe("Turn failed");
    expect(sessionAttentionLabel("cancelled")).toBe("Turn cancelled");
    expect(sessionAttentionLabel("completed")).toBe("Unread update");
    expect(sessionAttentionLabel(undefined)).toBe("Unread update");
  });
});

describe("createSessionAttention cross-device & viewport lifecycle", () => {
  function withFakeViewport<T>(
    initial: { visibilityState?: "visible" | "hidden"; focused?: boolean; title?: string },
    run: (env: {
      setVisibility: (v: "visible" | "hidden") => void;
      setFocused: (v: boolean) => void;
      fireDoc: (type: string) => void;
      fireWin: (type: string) => void;
      getTitle: () => string;
    }) => Promise<T>,
  ): Promise<T> {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;
    let visibilityState: "visible" | "hidden" = initial.visibilityState ?? "visible";
    let focused = initial.focused ?? true;
    const docListeners = new Map<string, Set<() => void>>();
    const winListeners = new Map<string, Set<() => void>>();

    const fakeDoc: any = {
      get visibilityState() {
        return visibilityState;
      },
      title: initial.title ?? "Indirect Code",
      hasFocus: () => focused,
      addEventListener: (type: string, fn: () => void) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        docListeners.get(type)?.delete(fn);
      },
    };
    const fakeWin: any = {
      addEventListener: (type: string, fn: () => void) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        winListeners.get(type)?.delete(fn);
      },
    };

    (globalThis as any).document = fakeDoc;
    (globalThis as any).window = fakeWin;

    return run({
      setVisibility: (v) => {
        visibilityState = v;
      },
      setFocused: (v) => {
        focused = v;
      },
      fireDoc: (type) => {
        for (const fn of docListeners.get(type) ?? []) fn();
      },
      fireWin: (type) => {
        for (const fn of winListeners.get(type) ?? []) fn();
      },
      getTitle: () => fakeDoc.title,
    }).finally(() => {
      if (prevDoc === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDoc;
      if (prevWin === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWin;
    });
  }

  test("acknowledges unread session on selection, clears dot optimistically, updates title, and prunes optimistic map when mirror catches up", async () => {
    const { createRoot, createSignal, createSessionAttention } = clientSolid;
    await withFakeViewport({ visibilityState: "visible", focused: true }, async (env) => {
      const sent: DaemonCommand[] = [];
      const [activeSessionId, setActiveSessionId] = createSignal("s-read");
      const [draftMode, setDraftMode] = createSignal(false);
      const [sessions, setSessions] = createSignal<SessionSummary[]>([
        makeSession({ id: "s-read", attentionSeq: 2, seenSeq: 2 }),
        makeSession({ id: "s-unread", attentionSeq: 5, seenSeq: 3, attentionKind: "completed" }),
      ]);

      await createRoot(async (dispose) => {
        try {
          const att = createSessionAttention({
            send: (cmd) => sent.push(cmd),
            wsOpen: () => true,
            isHostOnline: () => true,
            activeHostId: () => "h1",
            activeSessionId,
            activeSession: () => sessions().find((s) => s.id === activeSessionId()) ?? null,
            draftMode,
            historyView: () => false,
            updating: () => false,
            isMobile: () => false,
            sidebarOpen: () => true,
            hosts: () => [{ id: "h1", status: "online" }],
            sessions,
            sessionsForHost: () => sessions(),
          });

          await flushReactive();
          expect(att.isSessionUnread(sessions()[0]!)).toBe(false);
          expect(att.isSessionUnread(sessions()[1]!)).toBe(true);
          expect(att.anyOnlineHostHasUnread()).toBe(true);
          expect(env.getTitle()).toBe("• Indirect Code");
          expect(sent).toHaveLength(0);

          // Select s-unread -> immediately clears unread dot via optimisticSeen and sends mark_session_seen
          setActiveSessionId("s-unread");
          await flushReactive();

          expect(sent).toEqual([
            {
              type: "mark_session_seen",
              hostId: "h1",
              sessionId: "s-unread",
              seenSeq: 5,
            },
          ]);
          expect(att.isSessionUnread(sessions()[1]!)).toBe(false);
          expect(att.optimisticSeen()["h1:s-unread"]).toBe(5);
          expect(att.anyOnlineHostHasUnread()).toBe(false);
          expect(env.getTitle()).toBe("Indirect Code");

          // Switching to draft mode keeps s-unread read even before mirror pull arrives
          setDraftMode(true);
          setActiveSessionId("");
          await flushReactive();
          expect(att.isSessionUnread(sessions()[1]!)).toBe(false);

          // Mirror catches up with seenSeq=5 -> optimisticSeen entry is pruned cleanly
          setSessions([
            makeSession({ id: "s-read", attentionSeq: 2, seenSeq: 2 }),
            makeSession({ id: "s-unread", attentionSeq: 5, seenSeq: 5, attentionKind: "completed" }),
          ]);
          await flushReactive();
          expect(att.optimisticSeen()["h1:s-unread"]).toBeUndefined();
          expect(att.isSessionUnread(sessions()[1]!)).toBe(false);
        } finally {
          dispose();
        }
      });
    });
  });

  test("withholds mark_session_seen while window is blurred or mobile drawer covers transcript, then acknowledges on focus / drawer close", async () => {
    const { createRoot, createSignal, createSessionAttention } = clientSolid;
    await withFakeViewport({ visibilityState: "visible", focused: false }, async (env) => {
      const sent: DaemonCommand[] = [];
      const [isMobile, setIsMobile] = createSignal(false);
      const [sidebarOpen, setSidebarOpen] = createSignal(true);
      const [liveOverlay, setLiveOverlay] = createSignal<LiveSessionAttentionOverlay | null>(null);
      const [sessions] = createSignal<SessionSummary[]>([
        makeSession({
          id: "s-live",
          status: "running",
          attentionSeq: 3,
          seenSeq: 1,
          attentionKind: "approval",
        }),
      ]);

      await createRoot(async (dispose) => {
        try {
          const att = createSessionAttention({
            send: (cmd) => sent.push(cmd),
            wsOpen: () => true,
            isHostOnline: () => true,
            activeHostId: () => "h1",
            activeSessionId: () => "s-live",
            activeSession: () => sessions()[0]!,
            draftMode: () => false,
            historyView: () => false,
            updating: () => false,
            isMobile,
            sidebarOpen,
            hosts: () => [{ id: "h1", status: "online" }],
            sessions,
            sessionsForHost: () => sessions(),
            liveSessionAttention: liveOverlay,
          });

          await flushReactive();
          // Window is unfocused -> active session stays unread and no command is sent
          expect(att.isViewportActive()).toBe(false);
          expect(att.isSessionUnread(sessions()[0]!)).toBe(true);
          expect(att.labelForSession(sessions()[0]!)).toBe("Waiting for approval");
          expect(env.getTitle()).toBe("• Indirect Code");
          expect(sent).toHaveLength(0);

          // Focus window, EXCEPT mobile drawer is open -> still withheld until drawer closes!
          setIsMobile(true);
          setSidebarOpen(true);
          env.setFocused(true);
          env.fireWin("focus");
          await flushReactive();
          expect(att.isViewportActive()).toBe(true);
          expect(att.isSessionUnread(sessions()[0]!)).toBe(true);
          expect(sent).toHaveLength(0);

          // Close mobile sidebar drawer -> acknowledges seenSeq: 3 immediately!
          setSidebarOpen(false);
          await flushReactive();
          expect(sent).toEqual([
            {
              type: "mark_session_seen",
              hostId: "h1",
              sessionId: "s-live",
              seenSeq: 3,
            },
          ]);
          expect(att.isSessionUnread(sessions()[0]!)).toBe(false);

          // Live session_data overlay delivers seq=4 ("question") while blurred -> marks unread until pointerdown
          env.setFocused(false);
          env.fireWin("blur");
          setLiveOverlay({
            hostId: "h1",
            sessionId: "s-live",
            attentionSeq: 4,
            seenSeq: 3,
            attentionKind: "question",
          });
          await flushReactive();
          expect(att.isSessionUnread(sessions()[0]!)).toBe(true);
          expect(att.labelForSession(sessions()[0]!)).toBe("Waiting for your answer");
          expect(sent).toHaveLength(1);

          env.setFocused(true);
          env.fireWin("pointerdown");
          await flushReactive();
          expect(sent).toHaveLength(2);
          expect(sent[1]).toEqual({
            type: "mark_session_seen",
            hostId: "h1",
            sessionId: "s-live",
            seenSeq: 4,
          });
          expect(att.isSessionUnread(sessions()[0]!)).toBe(false);
        } finally {
          dispose();
        }
      });
    });
  });

  test("computes multi-host unread rollups accurately and ignores offline hosts", async () => {
    const { createRoot, createSignal, createSessionAttention } = clientSolid;
    await withFakeViewport({ visibilityState: "visible", focused: true }, async (env) => {
      const h1Sessions = [makeSession({ id: "s1", hostId: "h1", attentionSeq: 2, seenSeq: 1 })];
      const h2Sessions = [makeSession({ id: "s2", hostId: "h2", attentionSeq: 4, seenSeq: 1 })];
      const h3OfflineSessions = [makeSession({ id: "s3", hostId: "h3", attentionSeq: 9, seenSeq: 0 })];
      const [hosts, setHosts] = createSignal([
        { id: "h1", status: "online" },
        { id: "h2", status: "online" },
        { id: "h3", status: "offline" },
      ]);

      await createRoot(async (dispose) => {
        try {
          const att = createSessionAttention({
            send: () => {},
            wsOpen: () => true,
            isHostOnline: () => true,
            activeHostId: () => "h1",
            activeSessionId: () => "",
            activeSession: () => null,
            draftMode: () => true,
            historyView: () => false,
            updating: () => false,
            isMobile: () => false,
            sidebarOpen: () => true,
            hosts,
            sessions: () => h1Sessions,
            sessionsForHost: (hid) =>
              hid === "h1" ? h1Sessions : hid === "h2" ? h2Sessions : h3OfflineSessions,
          });

          await flushReactive();
          expect(att.hostHasUnread("h1")).toBe(true);
          expect(att.hostHasUnread("h2")).toBe(true);
          expect(att.hostHasUnread("h3")).toBe(false);
          expect(att.anyOtherHostHasUnread()).toBe(true);
          expect(att.anyOnlineHostHasUnread()).toBe(true);

          // If h2 goes offline while h1 still has unread, anyOtherHostHasUnread becomes false!
          setHosts([
            { id: "h1", status: "online" },
            { id: "h2", status: "offline" },
            { id: "h3", status: "offline" },
          ]);
          await flushReactive();
          expect(att.hostHasUnread("h2")).toBe(false);
          expect(att.anyOtherHostHasUnread()).toBe(false);
          expect(att.anyOnlineHostHasUnread()).toBe(true);
          expect(env.getTitle()).toBe("• Indirect Code");
        } finally {
          dispose();
        }
      });
      // Dispose restores document.title cleanly
      expect(env.getTitle()).toBe("Indirect Code");
    });
  });
});

describe("SSR Unread Dot & 3-state indicator priority across all surfaces", () => {
  let ssr: {
    renderSessionRowSsr: (opts: {
      session: SessionSummary;
      isUnread: boolean;
      label?: string;
      activeSessionId?: string;
      sessionStatus?: string;
    }) => string;
    renderWorkspaceSidebarSsr: (opts: {
      projects: RcProject[];
      sessions: SessionSummary[];
      unreadIds: string[];
      sidebarView?: "projects" | "talk";
      sidebarOpen?: boolean;
      anyOnlineHostHasUnread?: boolean;
      anyOtherHostHasUnread?: boolean;
      hostUnreadIds?: string[];
      hostMenuOpen?: boolean;
    }) => string;
    renderHistoryViewSsr: (opts: {
      sessions: SessionSummary[];
      unreadIds: string[];
      searchResults?: Array<{
        sessionId: string;
        sessionTitle: string;
        snippet: string;
        messageIdx: number;
        updatedAt: number;
      }>;
    }) => string;
    renderSidebarToggleSsr: (opts: {
      sidebarOpen: boolean;
      anyOnlineHostHasUnread: boolean;
    }) => string;
    renderLiveChangesBalloonSsr: () => string;
  };

  beforeAll(async () => {
    const icDir = join(process.cwd(), "web", "src", "indirect-code");
    const virtualEntryPath = join(icDir, "__ssr_unread_attention_entry__.tsx");

    const buildRes = await Bun.build({
      entrypoints: [virtualEntryPath],
      target: "bun",
      format: "esm",
      external: ["solid-js", "solid-js/web", "@floating-ui/dom"],
      plugins: [
        {
          name: "unread-attention-ssr-plugin",
          setup(build) {
            build.onResolve({ filter: /__ssr_unread_attention_entry__\.tsx$/ }, () => ({
              path: virtualEntryPath,
            }));
            build.onLoad({ filter: /__ssr_unread_attention_entry__\.tsx$/ }, async () => {
              const entryCode = `
                import { renderToString } from "solid-js/web";
                import { RemoteCodeProvider } from "./ctx";
                import { SessionRow } from "./components/SessionSidebar";
                import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
                import { HistoryView } from "./components/HistoryView";
                import { SidebarToggle } from "./components/SidebarToggle";
                import { TurnChangesBalloon } from "./components/TurnChangesBalloon";
                import { createProjects } from "./hooks/useProjects";

                export function renderSessionRowSsr(opts) {
                  const ctx = {
                    isMobile: () => false,
                    activeSessionId: () => opts.activeSessionId ?? "",
                    selectedSessions: () => new Set(),
                    selectionMode: () => false,
                    renamingId: () => null,
                    renameText: () => "",
                    setRenameText: () => {},
                    setRenamingId: () => {},
                    submitRename: () => {},
                    toggleSessionSelect: () => {},
                    selectSession: () => {},
                    setHistoryView: () => {},
                    closeSidebarOnMobile: () => {},
                    togglePin: () => {},
                    deleteSession: () => {},
                    sessionStatus: () => opts.sessionStatus ?? "idle",
                    turnActivity: () => null,
                    cancelTurnForSession: () => {},
                    isSessionUnread: () => Boolean(opts.isUnread),
                    sessionAttentionLabel: () => opts.label ?? "Unread update",
                  };
                  return renderToString(() => SessionRow(ctx, opts.session));
                }

                export function renderWorkspaceSidebarSsr(opts) {
                  const unreadSet = new Set(opts.unreadIds || []);
                  const hostUnreadSet = new Set(opts.hostUnreadIds || []);
                  const sessions = () => opts.sessions || [];
                  const projects = () => opts.projects || [];
                  return renderToString(() => {
                    const proj = createProjects({
                      send: () => {},
                      isOpen: () => true,
                      getHostId: () => "h1",
                      sessions,
                      projects,
                      toast: () => {},
                      showConfirm: async () => false,
                      isHostOnline: () => true,
                      isSessionUnread: (s) => unreadSet.has(s.id),
                    });
                    if (opts.sidebarView) proj.setSidebarView(opts.sidebarView);
                    return (
                      <RemoteCodeProvider
                        host={{
                          activeHost: () => ({ id: "h1", name: "Primary Host", status: "online" }),
                          activeHostId: () => "h1",
                          hosts: () => [
                            { id: "h1", name: "Primary Host", status: "online", os: "linux" },
                            { id: "h2", name: "Build Runner", status: "online", os: "darwin" },
                          ],
                          setActiveHostId: () => {},
                          hostMenuOpen: () => Boolean(opts.hostMenuOpen),
                          setHostMenuOpen: () => {},
                          hostMenuAnchor: () => "sidebar",
                          setHostMenuAnchor: () => {},
                          loadHosts: async () => {},
                          connectionState: () => "connected",
                          wsOpen: () => true,
                          send: () => {},
                          hostHasUnread: (hid) => hostUnreadSet.has(hid),
                          anyOtherHostHasUnread: () => Boolean(opts.anyOtherHostHasUnread),
                        }}
                        session={{
                          ...proj,
                          sessions,
                          projects,
                          activeSession: () => null,
                          currentProject: () => projects()[0] ?? null,
                          activeSessionId: () => "",
                          draftMode: () => true,
                          creatingSession: () => false,
                          selectSession: () => {},
                          startNewConversation: () => {},
                          deleteSession: async () => {},
                          isSessionUnread: (s) => unreadSet.has(s.id),
                          sessionAttentionLabel: () => "Unread update",
                          workspace: () => null,
                          workspaceBlocked: () => false,
                          workspacePath: () => "",
                          workspaceState: () => "available",
                          checkWorkspace: () => {},
                        }}
                        transcript={{
                          sessionStatus: () => "idle",
                          turnActivity: () => null,
                          cancelTurnForSession: () => {},
                        }}
                        turnChanges={{}}
                        composer={{}}
                        queue={{}}
                        background={{}}
                        modal={{
                          openPairModal: () => {},
                          openSettings: () => {},
                        }}
                        ui={{
                          sidebarOpen: () => opts.sidebarOpen ?? true,
                          setSidebarOpen: () => {},
                          isMobile: () => false,
                          historyView: () => false,
                          setHistoryView: () => {},
                          closeSidebarOnMobile: () => {},
                          closeMenus: () => {},
                          anyOnlineHostHasUnread: () => Boolean(opts.anyOnlineHostHasUnread),
                          daemonUpdate: {
                            info: () => ({ current: "v1.0.0", autoUpdate: true }),
                            applying: () => false,
                            toggle: () => {},
                            checkNow: () => {},
                            apply: () => {},
                          },
                        }}
                      >
                        <WorkspaceSidebar />
                      </RemoteCodeProvider>
                    );
                  });
                }

                export function renderHistoryViewSsr(opts) {
                  const unreadSet = new Set(opts.unreadIds || []);
                  const list = opts.sessions || [];
                  return renderToString(() => (
                    <HistoryView
                      sessionFilter={() => (opts.searchResults?.length ? "deploy" : "")}
                      setSessionFilter={() => {}}
                      queueDaemonSearch={() => {}}
                      searchResults={() => opts.searchResults || []}
                      setSearchResults={() => {}}
                      setHistoryView={() => {}}
                      selectSession={() => {}}
                      sessions={() => list}
                      matchQuery={() => true}
                      sortedSessions={(arr) => arr}
                      isMobile={() => false}
                      isSessionUnread={(s) => unreadSet.has(s.id)}
                      sessionAttentionLabel={() => "Waiting for approval"}
                      activeSessionId={() => ""}
                      sessionStatus={() => "idle"}
                    />
                  ));
                }

                export function renderSidebarToggleSsr(opts) {
                  return renderToString(() => (
                    <RemoteCodeProvider
                      host={{}}
                      session={{}}
                      transcript={{}}
                      turnChanges={{}}
                      composer={{}}
                      queue={{}}
                      background={{}}
                      modal={{}}
                      ui={{
                        sidebarOpen: () => opts.sidebarOpen,
                        setSidebarOpen: () => {},
                        isMobile: () => false,
                        anyOnlineHostHasUnread: () => opts.anyOnlineHostHasUnread,
                      }}
                    >
                      <SidebarToggle />
                    </RemoteCodeProvider>
                  ));
                }

                export function renderLiveChangesBalloonSsr() {
                  return renderToString(() => (
                    <RemoteCodeProvider
                      host={{}}
                      session={{}}
                      transcript={{}}
                      turnChanges={{
                        requestDetail: () => {},
                        detailCache: () => ({}),
                        detailLoading: () => ({}),
                      }}
                      composer={{}}
                      queue={{}}
                      background={{}}
                      modal={{}}
                      ui={{
                        convWidthClass: () => "max-w-3xl",
                        isMobile: () => false,
                      }}
                    >
                      <TurnChangesBalloon
                        live
                        balloon={{
                          turnId: "t1",
                          files: [
                            { path: "web/src/app.tsx", status: "modified", additions: 8, deletions: 2 },
                          ],
                          totalAdditions: 8,
                          totalDeletions: 2,
                        }}
                      />
                    </RemoteCodeProvider>
                  ));
                }
              `;
              const transformed = await transformAsync(entryCode, {
                filename: virtualEntryPath,
                presets: [[solidPreset, { generate: "ssr", hydratable: false }]],
                babelrc: false,
                configFile: false,
              });
              return { contents: transformed?.code ?? entryCode, loader: "js" };
            });

            build.onResolve({ filter: /^virtual:icons$/ }, () => ({
              path: "virtual:icons",
              namespace: "virtual-icons",
            }));
            build.onLoad({ filter: /.*/, namespace: "virtual-icons" }, () => ({
              contents:
                "export const registry = {}; export const icons = {}; export default registry;",
              loader: "js",
            }));

            build.onLoad({ filter: /\.css$/ }, () => ({
              contents: "",
              loader: "js",
            }));

            build.onLoad({ filter: /FloatMenu\.tsx$/ }, async (args) => {
              const stub = `
                export function FloatMenu(props: any) {
                  return props.open ? <div data-floatmenu>{props.children}</div> : null;
                }
              `;
              const out = await transformAsync(stub, {
                filename: args.path,
                presets: [
                  [solidPreset, { generate: "ssr", hydratable: false }],
                  [tsPreset, { isTSX: true, allExtensions: true }],
                ],
                babelrc: false,
                configFile: false,
              });
              return { contents: out?.code ?? stub, loader: "js" };
            });

            build.onLoad({ filter: /web[\\/]src[\\/]ui\.tsx$/ }, async (args) => {
              const uiStub = `
                export function Icon(props: any) { return <span data-ui-icon={props.name} />; }
                export function Kbd(props: any) { return <kbd>{props.children}</kbd>; }
                export function Segmented(props: any) { return <div data-ui-segmented>{props.options?.map((o: any) => <button type="button">{o.label}</button>)}</div>; }
                export function Badge(props: any) { return <span data-ui-badge>{props.children}</span>; }
                export function Btn(props: any) { return <button type="button">{props.children}</button>; }
                export async function copyWithToast() { return false; }
              `;
              const out = await transformAsync(uiStub, {
                filename: args.path,
                presets: [
                  [solidPreset, { generate: "ssr", hydratable: false }],
                  [tsPreset, { isTSX: true, allExtensions: true }],
                ],
                babelrc: false,
                configFile: false,
              });
              return { contents: out?.code ?? uiStub, loader: "js" };
            });

            build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
              if (
                args.path.endsWith("__ssr_unread_attention_entry__.tsx") ||
                /FloatMenu\.tsx$/.test(args.path) ||
                /[\\/]web[\\/]src[\\/]ui\.tsx$/.test(args.path)
              ) {
                return undefined;
              }
              const code = await readFile(args.path, "utf8");
              const out = await transformAsync(code, {
                filename: args.path,
                presets: [
                  [solidPreset, { generate: "ssr", hydratable: false }],
                  [tsPreset, { isTSX: true, allExtensions: true }],
                ],
                sourceMaps: false,
                babelrc: false,
                configFile: false,
              });
              return { contents: out?.code ?? code, loader: "js" };
            });
          },
        },
      ],
    });

    if (!buildRes.success || buildRes.outputs.length === 0) {
      throw new Error(
        `Failed to bundle SSR unread attention harness: ${JSON.stringify(buildRes.logs)}`,
      );
    }
    const jsText = await buildRes.outputs[0]!.text();
    ssr = await import(
      `data:text/javascript;base64,${Buffer.from(jsText, "utf8").toString("base64")}`
    );
  });

  test("SessionRow enforces 3-state indicator priority: UnreadDot > RadialSpokeSpinner > empty", () => {
    // 1. Running + Unread (e.g. mid-turn approval): UnreadDot wins over Stop button so clicking row opens approval!
    const runningUnreadHtml = ssr.renderSessionRowSsr({
      session: makeSession({ id: "s-approval", status: "running", title: "Deploy approval" }),
      isUnread: true,
      label: "Waiting for approval",
    });
    expect(runningUnreadHtml).toContain('data-session-unread="s-approval"');
    expect(runningUnreadHtml).toContain('data-indicator="unread-dot"');
    expect(runningUnreadHtml).toContain('data-rc-tip="Waiting for approval"');
    expect(runningUnreadHtml).toContain("font-medium text-fg");
    expect(runningUnreadHtml).not.toContain('aria-label="Stop turn"');
    expect(runningUnreadHtml).not.toContain('data-indicator="radial-spokes"');

    // 2. Running + Read: RadialSpokeSpinner stop button shows cleanly
    const runningReadHtml = ssr.renderSessionRowSsr({
      session: makeSession({ id: "s-running", status: "running", title: "Running build" }),
      isUnread: false,
    });
    expect(runningReadHtml).toContain('aria-label="Stop turn"');
    expect(runningReadHtml).toContain('data-indicator="radial-spokes"');
    expect(runningReadHtml).not.toContain('data-indicator="unread-dot"');

    // 3. Idle + Unread: static UnreadDot + medium foreground title
    const idleUnreadHtml = ssr.renderSessionRowSsr({
      session: makeSession({ id: "s-done", status: "idle", title: "Finished refactor" }),
      isUnread: true,
    });
    expect(idleUnreadHtml).toContain('data-session-unread="s-done"');
    expect(idleUnreadHtml).toContain('data-indicator="unread-dot"');
    expect(idleUnreadHtml).toContain("font-medium text-fg");
    expect(idleUnreadHtml).not.toContain('data-indicator="radial-spokes"');

    // 4. Idle + Read: zero indicators
    const idleReadHtml = ssr.renderSessionRowSsr({
      session: makeSession({ id: "s-idle", status: "idle", title: "Quiet session" }),
      isUnread: false,
    });
    expect(idleReadHtml).not.toContain('data-indicator="unread-dot"');
    expect(idleReadHtml).not.toContain('data-indicator="radial-spokes"');
    expect(idleReadHtml).toContain("text-fg-secondary");
  });

  test("WorkspaceSidebar rolls up collapsed project folders, See all (N) overflow, Projects | Talk tabs, and HostCard badges", () => {
    const projects: RcProject[] = [
      { id: "p-unread", hostId: "h1", name: "UnreadRepo", path: "/work/unread", createdAt: 1, collapsed: true },
      { id: "p-running", hostId: "h1", name: "RunningRepo", path: "/work/running", createdAt: 2, collapsed: true },
      { id: "p-open", hostId: "h1", name: "OpenRepo", path: "/work/open", createdAt: 3, collapsed: false },
    ];
    const openSessions = Array.from({ length: 12 }, (_, idx) =>
      makeSession({
        id: `open-${idx + 1}`,
        cwd: "/work/open",
        updatedAt: 5000 - idx,
        title: `Open task ${idx + 1}`,
      }),
    );
    const sessions: SessionSummary[] = [
      makeSession({ id: "u-1", cwd: "/work/unread", status: "running", updatedAt: 9000 }),
      makeSession({ id: "r-1", cwd: "/work/running", status: "running", updatedAt: 8000 }),
      makeSession({
        id: "talk-1",
        cwd: "",
        options: { effort: "medium", mode: "talk", skills: [{ name: "talk" }], access: "full" },
        updatedAt: 7000,
      }),
      ...openSessions,
    ];

    // Item #11 (`open-11`), collapsed `u-1`, and `talk-1` are unread; host h2 also has unread
    const html = ssr.renderWorkspaceSidebarSsr({
      projects,
      sessions,
      unreadIds: ["u-1", "open-11", "talk-1"],
      sidebarView: "projects",
      anyOnlineHostHasUnread: true,
      anyOtherHostHasUnread: true,
      hostUnreadIds: ["h1", "h2"],
      hostMenuOpen: true,
    });

    // Collapsed folder rollups: UnreadRepo -> unread, RunningRepo -> running
    expect(html).toContain('data-project-collapsed-status="unread"');
    expect(html).toContain('data-project-collapsed-status="running"');
    // Hidden #11 session in OpenRepo triggers See all (12) unread dot
    expect(html).toContain("See all (12)");
    expect(html).toContain('data-rc-tip="Unread conversations hidden"');
    // Talk segmented button shows unread dot while viewing Projects
    expect(html).toContain("Talk");
    // HostCard preserves bg-success connection dot AND renders other-host + per-host unread dots
    expect(html).toContain("bg-success");
    expect(html).toContain("data-other-host-unread");
    expect(html).toContain('data-host-unread="h1"');
    expect(html).toContain('data-host-unread="h2"');

    // When active host alone has unread (anyOtherHostHasUnread = false), closed HostCard hides data-other-host-unread
    const singleHostHtml = ssr.renderWorkspaceSidebarSsr({
      projects: [projects[2]!],
      sessions: openSessions.slice(0, 2),
      unreadIds: ["open-1"],
      sidebarView: "projects",
      anyOnlineHostHasUnread: true,
      anyOtherHostHasUnread: false,
      hostUnreadIds: ["h1"],
      hostMenuOpen: false,
    });
    expect(singleHostHtml).not.toContain("data-other-host-unread");
  });

  test("HistoryView and SidebarToggle render unread indicators and TurnChangesBalloon uses shimmer without loader-circle", () => {
    const historyHtml = ssr.renderHistoryViewSsr({
      sessions: [
        makeSession({ id: "h-unread", status: "running", title: "Deploy pipeline" }),
        makeSession({ id: "h-running", status: "running", title: "Active indexing" }),
        makeSession({ id: "h-idle", status: "idle", title: "Archived note" }),
      ],
      unreadIds: ["h-unread"],
      searchResults: [
        {
          sessionId: "h-unread",
          sessionTitle: "Deploy pipeline",
          snippet: "deploy check waiting",
          messageIdx: 2,
          updatedAt: 3000,
        },
      ],
    });
    expect(historyHtml).toContain('data-history-hit-id="h-unread"');
    expect(historyHtml).toContain('data-history-session-id="h-unread"');
    expect(historyHtml).toContain('data-rc-tip="Waiting for approval"');
    expect(historyHtml.match(/data-indicator="unread-dot"/g)?.length).toBe(2);
    expect(historyHtml).toContain('data-indicator="radial-spokes"');

    // SidebarToggle corner badge appears only when sidebar is collapsed and online host has unread
    const closedUnreadToggle = ssr.renderSidebarToggleSsr({
      sidebarOpen: false,
      anyOnlineHostHasUnread: true,
    });
    expect(closedUnreadToggle).toContain("data-sidebar-unread-badge");

    const openUnreadToggle = ssr.renderSidebarToggleSsr({
      sidebarOpen: true,
      anyOnlineHostHasUnread: true,
    });
    expect(openUnreadToggle).not.toContain("data-sidebar-unread-badge");

    // Live TurnChangesBalloon uses shimmer + static icon with zero animate-spin
    const liveBalloonHtml = ssr.renderLiveChangesBalloonSsr();
    expect(liveBalloonHtml).toContain("ui-shimmer");
    expect(liveBalloonHtml).toContain("1 file changed");
    expect(liveBalloonHtml).not.toContain("animate-spin");
  });
});
