import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import { createRoot, createSignal } from "solid-js";
import type { DaemonCommand } from "../web/src/indirect-code/daemon-protocol";
import { createQueue } from "../web/src/indirect-code/hooks/useQueue";
import { createSettings } from "../web/src/indirect-code/hooks/useSettings";
import { createComposer } from "../web/src/indirect-code/hooks/useComposer";
import type { RcConfig } from "../web/src/indirect-code/store/sessions";
import {
  normalizeMidTurnSend,
  type MidTurnDelivery,
} from "../web/src/indirect-code/utils/settingsValidation";
import type { QueuedMessage } from "../web/src/indirect-code/viewTypes";

describe("createQueue mid-turn staging, × cancel, force interrupt, reorder & clear", () => {
  function setupQueue(initialRunning = true) {
    const sent: DaemonCommand[] = [];
    const toasts: Array<{ msg: string; kind?: "ok" | "err" }> = [];
    const [running, setRunning] = createSignal(initialRunning);
    const q = createRoot(() =>
      createQueue({
        send: (payload) => sent.push(payload),
        getSessionId: () => "sess-1",
        isOpen: () => true,
        isHostOnline: () => true,
        isSessionRunning: () => running(),
        toast: (msg, kind) => toasts.push({ msg, kind }),
      }),
    );
    return { q, sent, toasts, setRunning };
  }

  test("normalizes missing/invalid delivery to queue and partitions stagedItems vs passiveItems", () => {
    expect(normalizeMidTurnSend(undefined)).toBe("queue");
    expect(normalizeMidTurnSend("unknown")).toBe("queue");
    expect(normalizeMidTurnSend("steer")).toBe("steer");
    expect(normalizeMidTurnSend("interrupt")).toBe("interrupt");

    const { q } = setupQueue();
    q.noteQueue("sess-1", [
      {
        id: "q-steer",
        text: "stage me next",
        attachmentIds: ["att-1"],
        model: "claude-sonnet",
        yolo: true,
        options: {
          effort: "high",
          mode: "agentic",
          skills: [{ name: "build" }],
          access: "full",
        },
        createdAt: 10,
        delivery: "steer",
      },
      {
        id: "q-int",
        text: "stop right now",
        attachmentIds: [],
        model: "claude-sonnet",
        yolo: false,
        createdAt: 11,
        delivery: "interrupt",
      },
      {
        id: "q-legacy",
        text: "legacy queued item",
        attachmentIds: [],
        model: "claude-sonnet",
        yolo: false,
        createdAt: 12,
      },
      {
        id: "q-passive",
        text: "second passive item",
        attachmentIds: [],
        model: "claude-opus",
        yolo: false,
        createdAt: 13,
        delivery: "queue",
      },
    ]);

    expect(q.stagedItems("sess-1").map((i) => i.id)).toEqual(["q-steer", "q-int"]);
    expect(q.passiveItems("sess-1").map((i) => i.id)).toEqual(["q-legacy", "q-passive"]);
    expect(q.queueOf("sess-1")[2]?.delivery).toBe("queue");
    expect(q.queueOf("sess-1")[0]?.options).toEqual({
      effort: "high",
      mode: "agentic",
      skills: [{ name: "build" }],
      access: "full",
    });
  });

  test("sendNow, cancelSend (×), and interruptNow emit exact commands and context-aware toasts", () => {
    const { q, sent, toasts, setRunning } = setupQueue(true);
    q.noteQueue("sess-1", [
      {
        id: "q-1",
        text: "first item",
        attachmentIds: [],
        model: "m",
        yolo: false,
        createdAt: 1,
        delivery: "queue",
      },
    ]);

    q.sendNow("q-1");
    expect(sent.at(-1)).toEqual({
      type: "queue_send_now",
      sessionId: "sess-1",
      queueId: "q-1",
    });
    expect(toasts.at(-1)?.msg).toBe("Staged — sending on next step");

    q.cancelSend("q-1");
    expect(sent.at(-1)).toEqual({
      type: "queue_cancel_send",
      sessionId: "sess-1",
      queueId: "q-1",
    });
    expect(toasts.at(-1)?.msg).toBe("Returned to queue");

    q.interruptNow("q-1");
    expect(sent.at(-1)).toEqual({
      type: "queue_interrupt_now",
      sessionId: "sess-1",
      queueId: "q-1",
    });
    expect(toasts.at(-1)?.msg).toBe("Interrupting turn — sending immediately");

    // When idle (e.g. after clicking Stop), sendNow and interruptNow toast immediate launch.
    setRunning(false);
    q.sendNow("q-1");
    expect(toasts.at(-1)?.msg).toBe("Sending message now");
    q.interruptNow("q-1");
    expect(toasts.at(-1)?.msg).toBe("Sending message now");
  });

  test("moveQueued preserves staged items ahead of reordered passive items, and clearQueued clears", () => {
    const { q, sent } = setupQueue(true);
    q.noteQueue("sess-1", [
      { id: "s-1", text: "staged", attachmentIds: [], model: "m", yolo: false, createdAt: 1, delivery: "steer" },
      { id: "p-1", text: "passive 1", attachmentIds: [], model: "m", yolo: false, createdAt: 2, delivery: "queue" },
      { id: "p-2", text: "passive 2", attachmentIds: [], model: "m", yolo: false, createdAt: 3, delivery: "queue" },
      { id: "p-3", text: "passive 3", attachmentIds: [], model: "m", yolo: false, createdAt: 4, delivery: "queue" },
    ]);

    // Out-of-bounds move at top/bottom is a no-op.
    q.moveQueued("p-1", -1);
    q.moveQueued("p-3", 1);
    expect(sent.length).toBe(0);

    // Move p-2 earlier -> [s-1, p-2, p-1, p-3].
    q.moveQueued("p-2", -1);
    expect(sent.at(-1)).toEqual({
      type: "queue_reorder",
      sessionId: "sess-1",
      queueIds: ["s-1", "p-2", "p-1", "p-3"],
    });

    // Begin editing p-1, then promote p-1 to steer via daemon snapshot -> edit state auto-clears.
    const p1 = q.passiveItems("sess-1")[0]!;
    q.beginEdit(p1, []);
    expect(q.editingQueueId()).toBe("p-1");
    q.noteQueue("sess-1", [
      { id: "p-1", text: "passive 1", attachmentIds: [], model: "m", yolo: false, createdAt: 2, delivery: "steer" },
      { id: "p-2", text: "passive 2", attachmentIds: [], model: "m", yolo: false, createdAt: 3, delivery: "queue" },
    ]);
    expect(q.editingQueueId()).toBeNull();

    // clearQueued emits queue_clear and clears any open inline editor.
    q.beginEdit(q.passiveItems("sess-1")[0]!, []);
    expect(q.editingQueueId()).toBe("p-2");
    q.clearQueued();
    expect(sent.at(-1)).toEqual({ type: "queue_clear", sessionId: "sess-1" });
    expect(q.editingQueueId()).toBeNull();
  });

  test("addToQueue forwards optional delivery and session options", () => {
    const { q, sent } = setupQueue(true);
    q.addToQueue("follow up", ["a1"], "gpt-5", true, "steer", {
      effort: "high",
      mode: "agentic",
      skills: [{ name: "build" }],
      access: "full",
    });
    expect(sent.at(-1)).toEqual({
      type: "queue_add",
      sessionId: "sess-1",
      text: "follow up",
      model: "gpt-5",
      yolo: true,
      attachmentIds: ["a1"],
      delivery: "steer",
      options: {
        effort: "high",
        mode: "agentic",
        skills: [{ name: "build" }],
        access: "full",
      },
    });
  });
});

describe("createSettings & createComposer mid_turn_send / midTurnDelivery wire contract", () => {
  test("createSettings reads mid_turn_send, tracks settingsDirty, and saves mid_turn_send across all 3 modes", async () => {
    const sent: DaemonCommand[] = [];
    let doc: RcConfig | null = {
      id: "daemon",
      hostId: "host-1",
      revision: "r1",
      settings: {
        auto_compact_threshold: 80,
        mid_turn_send: "steer",
      },
    };

    const s = createRoot(() =>
      createSettings({
        send: (payload) => sent.push(payload),
        isOpen: () => true,
        isHostOnline: () => true,
        getHostId: () => "host-1",
        toast: () => {},
        getConfigDoc: () => doc,
        refreshConfig: async () => {},
      }),
    );

    s.openSettings();
    expect(s.daemonSettings().midTurnSend).toBe("steer");
    expect(s.settingsDirty()).toBe(false);

    let prevMode: MidTurnDelivery = "steer";
    for (const mode of ["interrupt", "queue", "steer"] as const) {
      s.setDaemonSettings({ ...s.daemonSettings(), midTurnSend: mode });
      expect(s.daemonSettings().midTurnSend).toBe(mode);
      expect(s.settingsDirty()).toBe(mode !== prevMode);
      expect(s.saveDaemonConfig()).toBe(true);
      const last = sent.at(-1) as Extract<DaemonCommand, { type: "update_config" }>;
      expect(last.type).toBe("update_config");
      expect(last.settings.mid_turn_send).toBe(mode);
      // Acknowledge save and let refreshConfig's microtask complete cleanly.
      doc = {
        ...doc!,
        revision: `r-${mode}`,
        settings: { ...doc!.settings, mid_turn_send: mode },
      };
      s.handleSettingsMessage({
        type: "config_updated",
        hostId: "host-1",
        requestId: last.requestId,
        success: true,
        revision: `r-${mode}`,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(s.savingSettings()).toBe(false);
      prevMode = mode;
      s.openSettings();
      expect(s.daemonSettings().midTurnSend).toBe(mode);
      expect(s.settingsDirty()).toBe(false);
    }
  });

  test("createComposer sends midTurnDelivery, supports per-turn override, and toasts delivery accurately", async () => {
    const sent: DaemonCommand[] = [];
    const toasts: string[] = [];
    const [running, setRunning] = createSignal(true);
    const [hostDefault, setHostDefault] = createSignal<MidTurnDelivery>("steer");

    const composer = createRoot(() =>
      createComposer({
        send: (payload) => sent.push(payload),
        isOpen: () => true,
        isDisposed: () => false,
        getSessionId: () => "sess-1",
        getHostId: () => "host-1",
        getProjectId: () => "proj-1",
        getModel: () => "claude-sonnet",
        getDefaultMidTurnSend: () => hostDefault(),
        getOptions: () => ({
          effort: "medium",
          mode: "agentic",
          skills: [{ name: "build" }],
          access: "full",
        }),
        isSessionRunning: () => running(),
        isWorkspaceBlocked: () => false,
        checkWorkspace: () => {},
        isHostOnline: () => true,
        toast: (msg) => toasts.push(msg),
        t: {
          transcriptScroll: { pin: () => {} },
          fetchSession: () => {},
        } as any,
        o: {
          configureSession: () => {},
          setActiveModel: () => {},
          setEffort: () => {},
          setModeMenuOpen: () => {},
        },
        onClearConversation: () => {},
        onBeginConversation: () => {},
        isCreatingSession: () => false,
      }),
    );

    // 1. Defaults to host setting ("steer") and toasts "Staged — sending on next step".
    expect(composer.midTurnDelivery()).toBe("steer");
    composer.setInputPrompt("check edge cases");
    const p1 = composer.sendPrompt();
    const cmd1 = sent.at(-1) as Extract<DaemonCommand, { type: "prompt" }>;
    expect(cmd1.midTurnDelivery).toBe("steer");
    composer.notePromptReply(cmd1.requestId, undefined, {
      queued: true,
      delivery: "steer",
    });
    await p1;
    expect(toasts.at(-1)).toBe("Staged — sending on next step");

    // 2. Per-turn override to "interrupt" sends midTurnDelivery: "interrupt" and toasts interrupting.
    composer.setMidTurnDelivery("interrupt");
    expect(composer.midTurnDelivery()).toBe("interrupt");
    composer.setInputPrompt("stop and pivot");
    const p2 = composer.sendPrompt();
    const cmd2 = sent.at(-1) as Extract<DaemonCommand, { type: "prompt" }>;
    expect(cmd2.midTurnDelivery).toBe("interrupt");
    composer.notePromptReply(cmd2.requestId, undefined, {
      queued: false,
      delivery: "interrupt",
      interrupting: true,
    });
    await p2;
    expect(toasts.at(-1)).toBe("Interrupting turn — sending immediately");

    // 3. Ending the turn resets the per-turn override back to host default (and follows host updates).
    setRunning(false);
    setHostDefault("queue");
    expect(composer.midTurnDelivery()).toBe("queue");

    // 4. Queued passive reply toasts "Queued — sends after agent finishes".
    setRunning(true);
    composer.setInputPrompt("after turn finishes");
    const p3 = composer.sendPrompt();
    const cmd3 = sent.at(-1) as Extract<DaemonCommand, { type: "prompt" }>;
    expect(cmd3.midTurnDelivery).toBe("queue");
    composer.notePromptReply(cmd3.requestId, undefined, {
      queued: true,
      delivery: "queue",
    });
    await p3;
    expect(toasts.at(-1)).toBe("Queued — sends after agent finishes");

    // 5. DEFECT #4 regression: saving a new host default in Settings WHILE a turn is running
    // and a per-turn override was selected immediately syncs composer.midTurnDelivery().
    composer.setMidTurnDelivery("interrupt");
    expect(composer.midTurnDelivery()).toBe("interrupt");
    setHostDefault("steer");
    expect(composer.midTurnDelivery()).toBe("steer");
  });
});

describe("SSR QueueCard, ToolbarSend, MidTurnModeMenuBody & SettingsGeneralSection", () => {
  let renderQueueCardSsr!: (opts: {
    items: QueuedMessage[];
    collapsed?: boolean;
    sessionStatus?: "running" | "idle";
    activeModel?: string;
  }) => string;
  let renderToolbarSendSsr!: (opts: {
    sessionStatus: "running" | "idle";
    midTurnDelivery?: MidTurnDelivery;
    inputPrompt?: string;
  }) => string;
  let renderMidTurnMenuSsr!: (mode: MidTurnDelivery) => string;
  let renderSettingsGeneralSsr!: (midTurnSend: MidTurnDelivery) => string;

  beforeAll(async () => {
    if (typeof globalThis.localStorage === "undefined") {
      const mem = new Map<string, string>();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        writable: true,
        value: {
          getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
          setItem: (k: string, v: string) => {
            mem.set(k, String(v));
          },
          removeItem: (k: string) => {
            mem.delete(k);
          },
          clear: () => {
            mem.clear();
          },
          key: (idx: number) => Array.from(mem.keys())[idx] ?? null,
          get length() {
            return mem.size;
          },
        },
      });
    }

    const icDir = join(process.cwd(), "web", "src", "indirect-code");
    const virtualEntryPath = join(icDir, "__ssr_queue_ui_entry__.tsx");

    const buildRes = await Bun.build({
      entrypoints: [virtualEntryPath],
      target: "bun",
      format: "esm",
      external: ["solid-js", "solid-js/web", "@floating-ui/dom"],
      plugins: [
        {
          name: "queue-ui-ssr-test-plugin",
          setup(build) {
            build.onResolve({ filter: /__ssr_queue_ui_entry__\.tsx$/ }, () => ({
              path: virtualEntryPath,
            }));
            build.onLoad({ filter: /__ssr_queue_ui_entry__\.tsx$/ }, async () => {
              const entryCode = `
                import { renderToString } from "solid-js/web";
                import { RemoteCodeProvider } from "./ctx";
                import { QueueCard } from "./components/QueueCard";
                import { ToolbarSend, MidTurnModeMenuBody } from "./components/composer/ToolbarSend";
                import { SettingsGeneralSection } from "./modals/SettingsGeneral";

                function makeProviderProps(overrides = {}) {
                  const items = overrides.items || [];
                  const collapsed = Boolean(overrides.collapsed);
                  const sessionStatus = overrides.sessionStatus || "running";
                  const activeModel = overrides.activeModel || "claude-sonnet";
                  const midTurnDelivery = overrides.midTurnDelivery || "queue";
                  const midTurnSend = overrides.midTurnSend || "queue";
                  const inputPrompt = overrides.inputPrompt ?? "hello";

                  return {
                    host: {
                      activeHost: () => ({ id: "h1", name: "Dev Host", status: "online" }),
                      activeHostId: () => "h1",
                      hosts: () => [],
                      connectionState: () => "connected",
                      wsOpen: () => true,
                      send: () => {},
                    },
                    session: {
                      activeSessionId: () => "s1",
                      activeSession: () => ({ id: "s1", model: activeModel, status: sessionStatus }),
                      activeProject: () => ({ id: "p1", name: "proj", path: "/work" }),
                      creatingSession: () => false,
                      draftMode: () => false,
                      workspaceBlocked: () => false,
                    },
                    transcript: {
                      sessionStatus: () => sessionStatus,
                      turnActivity: () => (sessionStatus === "running" ? { startedAt: 1, status: "running" } : null),
                      cancelCurrentTurn: () => {},
                    },
                    turnChanges: {},
                    composer: {
                      activeModel: () => activeModel,
                      sending: () => false,
                      preparingAttachments: () => 0,
                      inputPrompt: () => inputPrompt,
                      pendingAttachments: () => [],
                      sendPrompt: () => {},
                      midTurnDelivery: () => midTurnDelivery,
                      setMidTurnDelivery: () => {},
                      midTurnMenuOpen: () => false,
                      setMidTurnMenuOpen: () => {},
                    },
                    queue: {
                      queueOf: () => items,
                      stagedItems: () => items.filter((i) => i.delivery === "steer" || i.delivery === "interrupt"),
                      passiveItems: () => items.filter((i) => i.delivery === "queue"),
                      queueCollapsed: () => ({ s1: collapsed }),
                      toggleCollapsed: () => {},
                      editingQueueId: () => null,
                      editingQueueText: () => "",
                      setEditingQueueId: () => {},
                      setEditingQueueText: () => {},
                      editDraft: { pendingAttachments: () => [], handleFiles: () => {}, removePendingAttachment: () => {}, clearAttachments: () => {} },
                      beginEdit: () => {},
                      saveEdit: async () => true,
                      removeQueued: () => {},
                      sendNow: () => {},
                      cancelSend: () => {},
                      interruptNow: () => {},
                      moveQueued: () => {},
                      clearQueued: () => {},
                    },
                    background: {},
                    modal: {
                      sessionFiles: () => ({ s1: [] }),
                      daemonSettings: () => ({
                        autoCompactPercent: 80,
                        noAutoTitle: false,
                        jailByDefault: false,
                        insecureTls: false,
                        httpProxy: "",
                        midTurnSend,
                      }),
                      setDaemonSettings: () => {},
                      openSettings: () => {},
                      cancelSettings: () => {},
                    },
                    ui: {
                      convWidth: () => "default",
                      setConvWidth: () => {},
                      convWidthClass: () => "max-w-3xl",
                      verboseChat: () => true,
                      setVerboseChat: () => {},
                      hideToolMessages: () => false,
                      setHideToolMessages: () => {},
                      closeMenus: () => {},
                      turnNotify: {
                        notifyOn: () => false,
                        soundOn: () => false,
                        permission: () => "default",
                        setEnabled: () => {},
                        setSound: () => {},
                        testNotify: () => {},
                      },
                      pushSub: {
                        supported: () => false,
                        state: () => "off",
                        sync: async () => {},
                      },
                      daemonUpdate: {
                        info: () => ({ current: "v1.0.0", autoUpdate: true }),
                        applying: () => false,
                        toggle: () => {},
                        checkNow: () => {},
                        apply: () => {},
                      },
                    },
                  };
                }

                export function renderQueueCardSsr(opts) {
                  const p = makeProviderProps(opts);
                  return renderToString(() => (
                    <RemoteCodeProvider {...p}>
                      <QueueCard />
                    </RemoteCodeProvider>
                  ));
                }

                export function renderToolbarSendSsr(opts) {
                  const p = makeProviderProps(opts);
                  return renderToString(() => (
                    <RemoteCodeProvider {...p}>
                      <ToolbarSend />
                    </RemoteCodeProvider>
                  ));
                }

                export function renderMidTurnMenuSsr(mode) {
                  return renderToString(() => (
                    <MidTurnModeMenuBody
                      selected={() => mode}
                      onSelect={() => {}}
                      onOpenSettings={() => {}}
                    />
                  ));
                }

                export function renderSettingsGeneralSsr(midTurnSend) {
                  const p = makeProviderProps({ midTurnSend });
                  return renderToString(() => (
                    <RemoteCodeProvider {...p}>
                      <SettingsGeneralSection />
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

            build.onLoad({ filter: /web[\\/]src[\\/]ui\.tsx$/ }, async (args) => {
              const uiStub = `
                export const ACCENTS = [{ id: "teal", label: "Teal", swatch: "oklch(0.6 0.1 190)" }];
                export const accent = () => "teal";
                export const setAccent = () => {};
                export const themeMode = () => "dark";
                export const setThemeMode = () => {};
                export const theme = () => "dark";
                export function Badge(props: any) { return <span>{props.children}</span>; }
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
                args.path.endsWith("__ssr_queue_ui_entry__.tsx") ||
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
        `Failed to bundle SSR queue UI harness: ${JSON.stringify(buildRes.logs)}`,
      );
    }
    const jsText = await buildRes.outputs[0]!.text();
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(jsText, "utf8").toString("base64")}`
    );
    renderQueueCardSsr = mod.renderQueueCardSsr;
    renderToolbarSendSsr = mod.renderToolbarSendSsr;
    renderMidTurnMenuSsr = mod.renderMidTurnMenuSsr;
    renderSettingsGeneralSsr = mod.renderSettingsGeneralSsr;
  });

  test("QueueCard renders passive queue rows with #index, Clear, next-step promote, force-interrupt & reorder", () => {
    const html = renderQueueCardSsr({
      sessionStatus: "running",
      activeModel: "claude-sonnet",
      items: [
        {
          id: "q1",
          text: "First queued follow-up",
          attachmentIds: [],
          model: "claude-sonnet",
          yolo: false,
          createdAt: 1,
          delivery: "queue",
        },
        {
          id: "q2",
          text: "Second with override",
          attachmentIds: ["a1", "a2"],
          model: "provider/claude-opus",
          yolo: false,
          createdAt: 2,
          delivery: "queue",
        },
      ],
    });

    expect(html).toContain("data-queue-card");
    expect(html).toContain("data-queue-passive");
    expect(html).not.toContain("data-queue-staged");
    expect(html).toContain("Queued (2)");
    expect(html).toContain("Waits until turn finishes");
    expect(html).toContain('data-action="queue-clear"');
    expect(html).toContain(">#1<");
    expect(html).toContain(">#2<");
    expect(html).toContain("claude-opus");
    expect(html).toContain('data-action="queue-send-next"');
    expect(html).toContain('data-action="queue-interrupt-now"');
    expect(html).toContain('data-action="queue-move-up"');
    expect(html).toContain('data-action="queue-move-down"');
  });

  test("QueueCard renders steer staging banner with × cancel button and Send immediately button", () => {
    const html = renderQueueCardSsr({
      sessionStatus: "running",
      items: [
        {
          id: "s1",
          text: "Focus on mobile viewport overflow",
          attachmentIds: ["f1", "f2"],
          model: "claude-sonnet",
          yolo: false,
          createdAt: 1,
          delivery: "steer",
        },
      ],
    });

    expect(html).toContain("data-queue-staged");
    expect(html).toContain('data-queue-item-state="steer"');
    expect(html).toContain("Sending on next step");
    expect(html).toContain("Leaves queue as soon as current step finishes");
    expect(html).toContain("Focus on mobile viewport overflow");
    expect(html).toContain("2 files");
    expect(html).toContain('data-action="queue-interrupt-now"');
    expect(html).toContain("Send immediately");
    expect(html).toContain('data-action="queue-cancel-send"');
    expect(html).toContain('aria-label="Cancel next-step send and return to queue"');
    expect(html).not.toContain("data-queue-passive");
  });

  test("QueueCard renders interrupt stopping banner and keeps staged Zone 1 visible when passive Zone 2 is collapsed", () => {
    const interruptHtml = renderQueueCardSsr({
      sessionStatus: "running",
      items: [
        {
          id: "i1",
          text: "Abort tool run and apply hotfix",
          attachmentIds: [],
          model: "claude-sonnet",
          yolo: false,
          createdAt: 1,
          delivery: "interrupt",
        },
      ],
    });
    expect(interruptHtml).toContain('data-queue-item-state="interrupt"');
    expect(interruptHtml).toContain("Interrupting — sending immediately…");
    expect(interruptHtml).toContain("Abort tool run and apply hotfix");
    expect(interruptHtml).toContain('data-action="queue-cancel-send"');
    expect(interruptHtml).toContain('aria-label="Cancel interrupt send and return to queue"');

    const mixedCollapsedHtml = renderQueueCardSsr({
      sessionStatus: "running",
      collapsed: true,
      items: [
        {
          id: "s1",
          text: "Staged item stays visible",
          attachmentIds: [],
          model: "claude-sonnet",
          yolo: false,
          createdAt: 1,
          delivery: "steer",
        },
        {
          id: "p1",
          text: "Hidden collapsed passive text",
          attachmentIds: [],
          model: "claude-sonnet",
          yolo: false,
          createdAt: 2,
          delivery: "queue",
        },
      ],
    });
    // Zone 1 remains fully visible even when Zone 2 is collapsed!
    expect(mixedCollapsedHtml).toContain('data-queue-item-state="steer"');
    expect(mixedCollapsedHtml).toContain("Staged item stays visible");
    expect(mixedCollapsedHtml).toContain('data-action="queue-cancel-send"');
    expect(mixedCollapsedHtml).toContain("Queued (1)");
    expect(mixedCollapsedHtml).toContain('aria-label="Expand queue"');
    expect(mixedCollapsedHtml).not.toContain("Hidden collapsed passive text");
  });

  test("QueueCard in idle session shows Paused subtitle and Send message now action", () => {
    const idleHtml = renderQueueCardSsr({
      sessionStatus: "idle",
      items: [
        {
          id: "p1",
          text: "Ready to resume",
          attachmentIds: [],
          model: "claude-sonnet",
          yolo: false,
          createdAt: 1,
          delivery: "queue",
        },
      ],
    });
    expect(idleHtml).toContain("Paused — ready to send");
    expect(idleHtml).toContain('data-action="queue-send-idle"');
    expect(idleHtml).toContain('aria-label="Send message now"');
    expect(idleHtml).not.toContain('data-action="queue-send-next"');
  });

  test("ToolbarSend & MidTurnModeMenuBody reflect mid-turn modes while running and standard Send when idle", () => {
    const idleHtml = renderToolbarSendSsr({ sessionStatus: "idle" });
    expect(idleHtml).not.toContain("data-composer-midturn-mode");
    expect(idleHtml).toContain('aria-label="Send"');

    const queueRunning = renderToolbarSendSsr({
      sessionStatus: "running",
      midTurnDelivery: "queue",
    });
    expect(queueRunning).toContain('data-composer-midturn-mode="queue"');
    expect(queueRunning).toContain(">Queue<");
    expect(queueRunning).toContain('aria-label="Queue message"');

    const steerRunning = renderToolbarSendSsr({
      sessionStatus: "running",
      midTurnDelivery: "steer",
    });
    expect(steerRunning).toContain('data-composer-midturn-mode="steer"');
    expect(steerRunning).toContain(">Next step<");
    expect(steerRunning).toContain('aria-label="Send on next step"');

    const interruptRunning = renderToolbarSendSsr({
      sessionStatus: "running",
      midTurnDelivery: "interrupt",
    });
    expect(interruptRunning).toContain('data-composer-midturn-mode="interrupt"');
    expect(interruptRunning).toContain(">Interrupt<");
    expect(interruptRunning).toContain('aria-label="Interrupt &amp; send immediately"');

    const menuHtml = renderMidTurnMenuSsr("steer");
    expect(menuHtml).toContain("data-midturn-menu-body");
    expect(menuHtml).toContain("Send after turn finishes");
    expect(menuHtml).toContain("Inject on next AI step");
    expect(menuHtml).toContain("Stop current step &amp; send immediately");
    expect(menuHtml).toContain("Change default in Settings…");
  });

  test("SettingsGeneralSection renders While agent is working 3-card radio selector", () => {
    const html = renderSettingsGeneralSsr("steer");
    expect(html).toContain('id="rc-set-mid-turn-send"');
    expect(html).toContain('data-setting="mid-turn-send"');
    expect(html).toContain("While agent is working");
    expect(html).toContain("Add to queue");
    expect(html).toContain("Send on next step");
    expect(html).toContain("Stage automatically for the next AI step, with × to return to queue.");
    expect(html).toContain("Interrupt &amp; send");
    expect(html).toContain('data-midturn-radio="steer" aria-checked="true"');
  });
});
