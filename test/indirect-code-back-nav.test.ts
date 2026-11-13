import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import type {
  BackNavigationOptions,
  HistoryAdapter,
  NavLayerActions,
  NavProjectionState,
  createBackNavigation as CreateBackNavigationFn,
  isIndirectCodeHash as IsIndirectCodeHashFn,
  projectNavLayers as ProjectNavLayersFn,
} from "../web/src/indirect-code/hooks/useBackNavigation";
import type {
  exitCodeToGateway as ExitCodeToGatewayFn,
  noteRouteTransition as NoteRouteTransitionFn,
  routeKind as RouteKindFn,
} from "../web/src/route-nav";

let clientMod: {
  batch: typeof import("solid-js").batch;
  createRoot: typeof import("solid-js").createRoot;
  createSignal: typeof import("solid-js").createSignal;
  createBackNavigation: typeof CreateBackNavigationFn;
  isIndirectCodeHash: typeof IsIndirectCodeHashFn;
  projectNavLayers: typeof ProjectNavLayersFn;
  exitCodeToGateway: typeof ExitCodeToGatewayFn;
  noteRouteTransition: typeof NoteRouteTransitionFn;
  routeKind: typeof RouteKindFn;
};

beforeAll(async () => {
  const solidClientPath = join(process.cwd(), "node_modules", "solid-js", "dist", "solid.js");
  const entryPath = join(
    process.cwd(),
    "web",
    "src",
    "indirect-code",
    "__client_back_nav_entry__.ts",
  );
  const res = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "solid-client-back-nav-harness",
        setup(build) {
          build.onResolve({ filter: /__client_back_nav_entry__\.ts$/ }, () => ({
            path: entryPath,
          }));
          build.onLoad({ filter: /__client_back_nav_entry__\.ts$/ }, () => ({
            contents: `
              export { batch, createRoot, createSignal } from "solid-js";
              export {
                createBackNavigation,
                isIndirectCodeHash,
                projectNavLayers,
              } from "./hooks/useBackNavigation";
              export {
                exitCodeToGateway,
                noteRouteTransition,
                routeKind,
              } from "../route-nav";
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
    throw new Error(`Failed to bundle client Solid back-nav harness: ${JSON.stringify(res.logs)}`);
  }
  const js = await res.outputs[0]!.text();
  clientMod = await import(
    `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`
  );
});

interface HistoryEntry {
  url: string;
  hash: string;
  state: unknown;
}

function hashOfUrl(url: string): string {
  const idx = url.indexOf("#");
  return idx >= 0 ? url.slice(idx) : "";
}

class MockBrowserHistory implements HistoryAdapter {
  entries: HistoryEntry[];
  index: number;
  pushCount = 0;
  replaceCount = 0;
  goCalls: number[] = [];
  replaceLocationCalls: string[] = [];
  manualGo = false;
  swallowGo = false;
  private pendingDeltas: number[] = [];
  private listeners = new Set<(e: PopStateEvent) => void>();

  constructor(initialHash = "#/code", initialState: unknown = null) {
    const url = `http://localhost:3000/${initialHash}`;
    this.entries = [{ url, hash: initialHash, state: initialState }];
    this.index = 0;
  }

  navigateHash(nextHash: string) {
    const prevHash = this.getHash();
    const prevPath = prevHash.replace(/^#/, "") || "/";
    const nextPath = nextHash.replace(/^#/, "") || "/";
    clientMod.noteRouteTransition(prevPath, nextPath);
    const url = `http://localhost:3000/${nextHash}`;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ url, hash: nextHash, state: null });
    this.index = this.entries.length - 1;
  }

  getState(): unknown {
    return this.entries[this.index]?.state ?? null;
  }

  getHref(): string {
    return this.entries[this.index]?.url ?? "http://localhost:3000/";
  }

  getHash(): string {
    return this.entries[this.index]?.hash ?? "";
  }

  pushState(data: unknown, _unused: string, url?: string): void {
    this.pushCount++;
    const resolvedUrl = url ?? this.getHref();
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({
      url: resolvedUrl,
      hash: hashOfUrl(resolvedUrl),
      state: structuredClone(data),
    });
    this.index = this.entries.length - 1;
  }

  replaceState(data: unknown, _unused: string, url?: string): void {
    this.replaceCount++;
    const resolvedUrl = url ?? this.getHref();
    this.entries[this.index] = {
      url: resolvedUrl,
      hash: hashOfUrl(resolvedUrl),
      state: structuredClone(data),
    };
  }

  go(delta: number): void {
    this.goCalls.push(delta);
    if (this.swallowGo || delta === 0) return;
    if (this.manualGo) {
      this.pendingDeltas.push(delta);
      return;
    }
    queueMicrotask(() => {
      this.applyDelta(delta);
    });
  }

  userBack(): void {
    this.applyDelta(-1);
  }

  userForward(): void {
    this.applyDelta(1);
  }

  flushNextGo(): void {
    const delta = this.pendingDeltas.shift();
    if (delta !== undefined) this.applyDelta(delta);
  }

  flushCoalescedGo(): void {
    if (this.pendingDeltas.length === 0) return;
    const total = this.pendingDeltas.reduce((a, b) => a + b, 0);
    this.pendingDeltas = [];
    this.applyDelta(total);
  }

  applyDelta(delta: number): void {
    const target = Math.max(0, Math.min(this.entries.length - 1, this.index + delta));
    if (target === this.index) return;
    const prevHash = this.getHash();
    this.index = target;
    const nextHash = this.getHash();
    if (prevHash !== nextHash) {
      clientMod.noteRouteTransition(
        prevHash.replace(/^#/, "") || "/",
        nextHash.replace(/^#/, "") || "/",
      );
    }
    const ev = { state: structuredClone(this.getState()) } as PopStateEvent;
    for (const fn of [...this.listeners]) {
      fn(ev);
    }
  }

  replaceLocation(url: string): void {
    this.replaceLocationCalls.push(url);
    const prevHash = this.getHash();
    const full = url.startsWith("http") ? url : `http://localhost:3000/${url}`;
    const nextHash = hashOfUrl(full);
    this.entries[this.index] = {
      url: full,
      hash: nextHash,
      state: null,
    };
    if (prevHash !== nextHash) {
      clientMod.noteRouteTransition(
        prevHash.replace(/^#/, "") || "/",
        nextHash.replace(/^#/, "") || "/",
      );
    }
  }

  addPopStateListener(fn: (e: PopStateEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

function flushAsync(ms = 5) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function defaultNavState(overrides: Partial<NavProjectionState> = {}): NavProjectionState {
  return {
    hostsCount: 1,
    hasPairingData: false,
    overlaySidebar: false,
    updating: false,
    sidebarOpen: true,
    historyView: false,
    selectionMode: false,
    renamingId: null,
    editingMsgIdx: null,
    editingQueueId: null,
    fullscreenWidget: false,
    showConfigModal: false,
    showNewProjectModal: false,
    folderNavDepth: 0,
    showPairModal: false,
    hasPreviewFile: false,
    showPreviewSlicer: false,
    hasChoiceModal: false,
    hasConfirmModal: false,
    modeMenuOpen: false,
    accessMenuOpen: false,
    hostMenuOpen: false,
    newProjectMenuOpen: false,
    addContextOpen: false,
    isMobile: false,
    addContextSubView: "main",
    effortMenuOpen: false,
    modelMenuOpen: false,
    modelFromEffort: false,
    projectMenuOpen: false,
    usageOpen: false,
    hasSessionMenu: false,
    hasProjectMenu: false,
    mentionsOpen: false,
    editMentionsOpen: false,
    slashOpen: false,
    ...overrides,
  };
}

function createHarness(
  initialOverrides: Partial<NavProjectionState> = {},
  opts: {
    history?: MockBrowserHistory;
    bootId?: string;
    savingSettings?: () => boolean;
    canOpenSettings?: () => boolean;
    inFlightFallbackMs?: number;
  } = {},
) {
  const hist = opts.history ?? new MockBrowserHistory("#/code");
  let disposeRoot = () => {};
  let stateAccessor!: () => NavProjectionState;
  let patchState!: (patch: Partial<NavProjectionState>) => void;

  clientMod.createRoot((dispose) => {
    disposeRoot = dispose;
    const [state, setState] = clientMod.createSignal<NavProjectionState>(
      defaultNavState(initialOverrides),
    );
    stateAccessor = state;
    patchState = (patch) => setState((prev) => ({ ...prev, ...patch }));

    const actions: NavLayerActions = {
      clearPairingData: () => patchState({ hasPairingData: false }),
      openSidebar: () => patchState({ sidebarOpen: true }),
      closeSidebar: () => patchState({ sidebarOpen: false }),
      closeHistoryView: () => patchState({ historyView: false }),
      openHistoryView: () =>
        patchState({
          historyView: true,
          ...(state().overlaySidebar ? { sidebarOpen: false } : {}),
        }),
      exitSelectionMode: () => patchState({ selectionMode: false }),
      cancelRename: () => patchState({ renamingId: null }),
      cancelEditMsg: () => patchState({ editingMsgIdx: null }),
      cancelEditQueue: () => patchState({ editingQueueId: null }),
      closeFullscreenWidget: () => patchState({ fullscreenWidget: false }),
      closeSettingsModal: () => {
        if (opts.savingSettings?.()) return false;
        patchState({ showConfigModal: false });
        return true;
      },
      openSettingsModal: () => {
        if (opts.canOpenSettings && !opts.canOpenSettings()) return false;
        patchState({
          showConfigModal: true,
          ...(state().overlaySidebar ? { sidebarOpen: false } : {}),
        });
        return true;
      },
      closeNewProjectModal: () => patchState({ showNewProjectModal: false, folderNavDepth: 0 }),
      stepBackNewProjectFolder: () =>
        setState((prev) => ({
          ...prev,
          folderNavDepth: Math.max(0, prev.folderNavDepth - 1),
        })),
      closePairModal: () => patchState({ showPairModal: false }),
      closePreviewModal: () => patchState({ hasPreviewFile: false, showPreviewSlicer: false }),
      closePreviewSlicer: () => patchState({ showPreviewSlicer: false }),
      cancelChoiceModal: () => patchState({ hasChoiceModal: false }),
      cancelConfirmModal: () => patchState({ hasConfirmModal: false }),
      closeModeMenu: () => patchState({ modeMenuOpen: false }),
      closeAccessMenu: () => patchState({ accessMenuOpen: false }),
      closeHostMenu: () => patchState({ hostMenuOpen: false }),
      closeNewProjectMenu: () => patchState({ newProjectMenuOpen: false }),
      closeAddContextMenu: () => patchState({ addContextOpen: false, addContextSubView: "main" }),
      setAddContextSubView: (view) => patchState({ addContextSubView: view }),
      closeEffortMenu: () => patchState({ effortMenuOpen: false }),
      closeModelMenu: () => patchState({ modelMenuOpen: false, modelFromEffort: false }),
      closeModelAndEffortMenus: () =>
        patchState({ modelMenuOpen: false, effortMenuOpen: false, modelFromEffort: false }),
      stepBackModelToEffort: () => patchState({ modelMenuOpen: false, effortMenuOpen: true }),
      closeProjectPickerMenu: () => patchState({ projectMenuOpen: false }),
      closeUsageMenu: () => patchState({ usageOpen: false }),
      closeSessionContextMenu: () => patchState({ hasSessionMenu: false }),
      closeProjectActionsMenu: () => patchState({ hasProjectMenu: false }),
      dismissMentions: () => patchState({ mentionsOpen: false }),
      dismissEditMentions: () => patchState({ editMentionsOpen: false }),
      dismissSlash: () => patchState({ slashOpen: false }),
    };

    const navOpts: BackNavigationOptions = {
      readState: state,
      actions,
      history: hist,
      bootId: opts.bootId ?? "test-boot-1",
      inFlightFallbackMs: opts.inFlightFallbackMs ?? 40,
    };
    clientMod.createBackNavigation(navOpts);
  });

  return {
    hist,
    state: () => stateAccessor(),
    patch: (p: Partial<NavProjectionState>) => patchState(p),
    dispose: () => disposeRoot(),
  };
}

describe("Indirect Code Back-Navigation & History Stack Reconciler", () => {
  test("routeKind & isIndirectCodeHash isolate /code from /code-dev and gateway routes", () => {
    expect(clientMod.routeKind("/code")).toBe("code");
    expect(clientMod.routeKind("/code/session")).toBe("code");
    expect(clientMod.routeKind("/code-dev")).toBe("code-dev");
    expect(clientMod.routeKind("/codedev")).toBe("code-dev");
    expect(clientMod.routeKind("/")).toBe("gateway");
    expect(clientMod.routeKind("/keys")).toBe("gateway");

    expect(clientMod.isIndirectCodeHash("#/code")).toBe(true);
    expect(clientMod.isIndirectCodeHash("#/code?foo=1")).toBe(true);
    expect(clientMod.isIndirectCodeHash("#/code-dev")).toBe(false);
    expect(clientMod.isIndirectCodeHash("#/")).toBe(false);
    expect(clientMod.isIndirectCodeHash("")).toBe(false);
  });

  test("mobile workspace <-> sessions menu steps cleanly and 20 session switches cause zero history bloat", async () => {
    const hist = new MockBrowserHistory("#/");
    hist.navigateHash("#/code");

    const h = createHarness(
      { overlaySidebar: true, isMobile: true, sidebarOpen: false, hostsCount: 1 },
      { history: hist },
    );

    // Entries: [0: "#/", 1: "#/code (idx:0 root)", 2: "#/code (idx:1 mobile-workspace)"]
    expect(hist.entries.length).toBe(3);
    expect(hist.index).toBe(2);
    expect((hist.getState() as any).key).toBe("mobile-workspace");

    // Switch sessions 20 times via Back -> selectSession -> Back
    for (let i = 0; i < 20; i++) {
      hist.userBack();
      expect(h.state().sidebarOpen).toBe(true);
      expect(hist.index).toBe(1);
      expect((hist.getState() as any).idx).toBe(0);

      // Selecting another session closes the mobile drawer -> pushes idx:1 overwriting forward [2]
      h.patch({ sidebarOpen: false });
      expect(hist.index).toBe(2);
      expect(hist.entries.length).toBe(3);
      expect((hist.getState() as any).idx).toBe(1);
      expect((hist.getState() as any).key).toBe("mobile-workspace");
    }

    // Back #1 opens mobile sessions menu (idx: 0)
    hist.userBack();
    expect(h.state().sidebarOpen).toBe(true);
    expect(hist.index).toBe(1);

    // Back #2 from open mobile sessions menu exits #/code cleanly back to #/!
    hist.userBack();
    expect(hist.index).toBe(0);
    expect(hist.getHash()).toBe("#/");

    h.dispose();
  });

  test("Onboarding (hostsCount === 0) never pushes mobile-workspace and steps pairing card -> hero -> exit", () => {
    const hist = new MockBrowserHistory("#/");
    hist.navigateHash("#/code");

    const h = createHarness(
      { overlaySidebar: true, isMobile: true, sidebarOpen: false, hostsCount: 0, hasPairingData: false },
      { history: hist },
    );

    // No host -> no mobile-workspace pushed
    expect(hist.entries.length).toBe(2);
    expect(hist.index).toBe(1);
    expect((hist.getState() as any).idx).toBe(0);

    // Silent pairing token arrives -> pushes onboarding-pair at idx: 1
    h.patch({ hasPairingData: true });
    expect(hist.entries.length).toBe(3);
    expect(hist.index).toBe(2);
    expect((hist.getState() as any).key).toBe("onboarding-pair");

    // Back #1 clears pairing card back to Onboarding hero CTA
    hist.userBack();
    expect(h.state().hasPairingData).toBe(false);
    expect(hist.index).toBe(1);

    // Back #2 exits #/code to #/
    hist.userBack();
    expect(hist.index).toBe(0);
    expect(hist.getHash()).toBe("#/");

    h.dispose();
  });

  test("projects and unwinds all stacked layers in strict priority order", () => {
    const h = createHarness({
      overlaySidebar: true,
      isMobile: true,
      sidebarOpen: false,
      historyView: true,
      editingMsgIdx: 2,
      editingQueueId: "q-1",
      fullscreenWidget: true,
      hasPreviewFile: true,
      showPreviewSlicer: true,
      hasChoiceModal: true,
      hasConfirmModal: true,
      addContextOpen: true,
      addContextSubView: "model",
    });

    // Stack:
    // 1: mobile-workspace
    // 2: history-view
    // 3: mode:edit-msg
    // 4: mode:edit-queue
    // 5: widget-fullscreen
    // 6: modal:preview
    // 7: modal:preview:slicer
    // 8: modal:choice
    // 9: modal:confirm
    // 10: menu:add-context
    // 11: menu:add-context:effort
    // 12: menu:add-context:model
    expect(h.hist.index).toBe(12);

    // Step back through mobile + menu: model -> effort -> main -> closed
    h.hist.userBack();
    expect(h.state().addContextSubView).toBe("effort");
    expect(h.state().addContextOpen).toBe(true);

    h.hist.userBack();
    expect(h.state().addContextSubView).toBe("main");
    expect(h.state().addContextOpen).toBe(true);

    h.hist.userBack();
    expect(h.state().addContextOpen).toBe(false);

    // ConfirmModal -> ChoiceModal -> Preview slicer -> PreviewModal -> Fullscreen widget -> Queue edit -> Msg edit -> HistoryView -> Mobile workspace
    h.hist.userBack();
    expect(h.state().hasConfirmModal).toBe(false);
    expect(h.state().hasChoiceModal).toBe(true);

    h.hist.userBack();
    expect(h.state().hasChoiceModal).toBe(false);
    expect(h.state().showPreviewSlicer).toBe(true);

    h.hist.userBack();
    expect(h.state().showPreviewSlicer).toBe(false);
    expect(h.state().hasPreviewFile).toBe(true);

    h.hist.userBack();
    expect(h.state().hasPreviewFile).toBe(false);
    expect(h.state().fullscreenWidget).toBe(true);

    h.hist.userBack();
    expect(h.state().fullscreenWidget).toBe(false);
    expect(h.state().editingQueueId).toBe("q-1");

    h.hist.userBack();
    expect(h.state().editingQueueId).toBeNull();
    expect(h.state().editingMsgIdx).toBe(2);

    h.hist.userBack();
    expect(h.state().editingMsgIdx).toBeNull();
    expect(h.state().historyView).toBe(true);

    h.hist.userBack();
    expect(h.state().historyView).toBe(false);
    expect(h.state().sidebarOpen).toBe(false);

    h.hist.userBack();
    expect(h.state().sidebarOpen).toBe(true);
    expect(h.hist.index).toBe(0);

    h.dispose();
  });

  test("NewProjectModal steps back through drilled folders on Back, and rewinds all steps in one go(-delta) on X close", async () => {
    const h = createHarness({ overlaySidebar: false, sidebarOpen: true });

    h.patch({ showNewProjectModal: true, folderNavDepth: 0 });
    expect(h.hist.index).toBe(1);

    h.patch({ folderNavDepth: 1 });
    h.patch({ folderNavDepth: 2 });
    expect(h.hist.index).toBe(3);

    // Step back folder 2 -> 1 -> 0 -> close modal
    h.hist.userBack();
    expect(h.state().folderNavDepth).toBe(1);
    expect(h.state().showNewProjectModal).toBe(true);

    h.hist.userBack();
    expect(h.state().folderNavDepth).toBe(0);
    expect(h.state().showNewProjectModal).toBe(true);

    h.hist.userBack();
    expect(h.state().showNewProjectModal).toBe(false);
    expect(h.hist.index).toBe(0);

    // Re-open, drill 3 folders deep, then click X (closes immediately in one go(-4))
    h.hist.goCalls = [];
    h.patch({ showNewProjectModal: true, folderNavDepth: 0 });
    h.patch({ folderNavDepth: 1 });
    h.patch({ folderNavDepth: 2 });
    h.patch({ folderNavDepth: 3 });
    expect(h.hist.index).toBe(4);

    h.patch({ showNewProjectModal: false, folderNavDepth: 0 });
    await flushAsync();
    expect(h.hist.goCalls).toEqual([-4]);
    expect(h.hist.index).toBe(0);

    h.dispose();
  });

  test("same-tick menu -> ConfirmModal and desktop Effort -> Model use synchronous replaceState/pushState without history.go", () => {
    const h = createHarness({ overlaySidebar: true, isMobile: true, sidebarOpen: true });

    // Open session context menu inside mobile sidebar (idx: 1)
    h.patch({ hasSessionMenu: true });
    expect(h.hist.index).toBe(1);
    expect((h.hist.getState() as any).key).toBe("menu:session");

    const replacesBefore = h.hist.replaceCount;
    h.hist.goCalls = [];

    // Clicking "Delete" closes sessionMenu and opens ConfirmModal in the same batch!
    clientMod.batch(() => {
      h.patch({ hasSessionMenu: false, hasConfirmModal: true });
    });

    expect(h.hist.goCalls).toEqual([]);
    expect(h.hist.replaceCount).toBe(replacesBefore + 1);
    expect(h.hist.index).toBe(1);
    expect((h.hist.getState() as any).key).toBe("modal:confirm");

    // Back cancels ConfirmModal cleanly back to open mobile sidebar (idx: 0)
    h.hist.userBack();
    expect(h.state().hasConfirmModal).toBe(false);
    expect(h.hist.index).toBe(0);

    // Desktop Effort -> Switch model -> Back returns to Effort -> Back closes Effort
    h.patch({ overlaySidebar: false, isMobile: false, sidebarOpen: true, effortMenuOpen: true });
    expect(h.hist.index).toBe(1);
    expect((h.hist.getState() as any).key).toBe("menu:effort");

    clientMod.batch(() => {
      h.patch({ effortMenuOpen: false, modelMenuOpen: true, modelFromEffort: true });
    });
    expect(h.hist.index).toBe(2);
    expect((h.hist.getState() as any).key).toBe("menu:model");

    h.hist.userBack();
    expect(h.state().modelMenuOpen).toBe(false);
    expect(h.state().effortMenuOpen).toBe(true);
    expect(h.hist.index).toBe(1);

    h.hist.userBack();
    expect(h.state().effortMenuOpen).toBe(false);
    expect(h.hist.index).toBe(0);

    h.dispose();
  });

  test("SettingsModal refuses dismissal while savingSettings() is true and bounces cursor forward", async () => {
    let saving = true;
    const h = createHarness(
      { showConfigModal: true },
      { savingSettings: () => saving },
    );
    expect(h.hist.index).toBe(1);

    // Back while savingSettings === true: modal stays open and cursor bounces +1 back to idx: 1
    h.hist.userBack();
    expect(h.state().showConfigModal).toBe(true);
    await flushAsync();
    expect(h.hist.index).toBe(1);
    expect((h.hist.getState() as any).key).toBe("modal:settings");

    // Once save finishes, Back closes SettingsModal cleanly
    saving = false;
    h.hist.userBack();
    expect(h.state().showConfigModal).toBe(false);
    expect(h.hist.index).toBe(0);

    h.dispose();
  });

  test("50 consecutive F5 reloads rewind stale bootId entries and never accumulate orphan history", async () => {
    const hist = new MockBrowserHistory("#/");
    hist.navigateHash("#/code");

    for (let reload = 1; reload <= 50; reload++) {
      const h = createHarness(
        { overlaySidebar: true, isMobile: true, sidebarOpen: false },
        { history: hist, bootId: `boot-${reload}` },
      );
      await flushAsync();
      // Open a modal + menu so reload happens at idx: 3
      h.patch({ showConfigModal: true, hostMenuOpen: true });
      expect(hist.index).toBe(4); // [0: #/, 1: root, 2: mobile-workspace, 3: modal:settings, 4: menu:host]
      h.dispose();
    }

    // Final boot after 50 reloads: lands on desktop root
    const finalHarness = createHarness(
      { overlaySidebar: false, isMobile: false, sidebarOpen: true },
      { history: hist, bootId: "boot-final" },
    );
    await flushAsync();

    // Index must be right at #/code floor (index 1, right above #/ at index 0)
    expect(hist.index).toBe(1);
    expect((hist.getState() as any).bootId).toBe("boot-final");
    expect((hist.getState() as any).idx).toBe(0);

    // Pressing Forward into a stale boot-50 entry bounces immediately back to index 1!
    hist.userForward();
    await flushAsync();
    expect(hist.index).toBe(1);

    // Pressing Back ONCE from root exits #/code to #/!
    hist.userBack();
    expect(hist.index).toBe(0);
    expect(hist.getHash()).toBe("#/");

    finalHarness.dispose();
  });

  test("Browser Forward restores idempotent views and bounces ephemeral entries", async () => {
    const h = createHarness({ overlaySidebar: true, isMobile: true, sidebarOpen: false });
    expect(h.hist.index).toBe(1); // mobile-workspace

    // Open HistoryView (idx: 2), then Back twice to sidebar (idx: 0)
    h.patch({ historyView: true });
    expect(h.hist.index).toBe(2);
    h.hist.userBack();
    expect(h.state().historyView).toBe(false);
    h.hist.userBack();
    expect(h.state().sidebarOpen).toBe(true);
    expect(h.hist.index).toBe(0);

    // Forward #1 restores mobile-workspace (sidebarOpen = false)
    h.hist.userForward();
    expect(h.state().sidebarOpen).toBe(false);
    expect(h.hist.index).toBe(1);

    // Forward #2 restores history-view (historyView = true)
    h.hist.userForward();
    expect(h.state().historyView).toBe(true);
    expect(h.hist.index).toBe(2);

    // Open ephemeral ConfirmModal (idx: 3), close via Cancel (rewinds to idx: 2), then press Forward
    h.patch({ hasConfirmModal: true });
    expect(h.hist.index).toBe(3);
    h.patch({ hasConfirmModal: false });
    await flushAsync();
    expect(h.hist.index).toBe(2);

    // Forward into ephemeral modal:confirm bounces back to idx: 2!
    h.hist.userForward();
    await flushAsync();
    expect(h.state().hasConfirmModal).toBe(false);
    expect(h.hist.index).toBe(2);

    h.dispose();
  });

  test("viewport resize (desktop <-> mobile) and simultaneous UI close + hardware Back race stay 1:1", async () => {
    const h = createHarness({ overlaySidebar: false, isMobile: false, sidebarOpen: true, showConfigModal: true });
    expect(h.hist.index).toBe(1);
    expect((h.hist.getState() as any).key).toBe("modal:settings");

    // Resize desktop -> mobile while SettingsModal is open: inserts mobile-workspace beneath modal:settings synchronously
    h.hist.goCalls = [];
    h.patch({ overlaySidebar: true, isMobile: true, sidebarOpen: false });
    expect(h.hist.goCalls).toEqual([]);
    expect(h.hist.index).toBe(2);
    expect((h.hist.entries[1]?.state as any).key).toBe("mobile-workspace");
    expect((h.hist.entries[2]?.state as any).key).toBe("modal:settings");

    // Resize mobile -> desktop while SettingsModal is open: unwinds mobile-workspace and preserves modal:settings
    h.patch({ overlaySidebar: false, isMobile: false, sidebarOpen: true });
    await flushAsync();
    expect(h.hist.index).toBe(1);
    expect((h.hist.getState() as any).key).toBe("modal:settings");

    // Simultaneous UI close + hardware Back on mobile (coalesced popstate race!)
    h.patch({ overlaySidebar: true, isMobile: true, sidebarOpen: false });
    expect(h.hist.index).toBe(2); // [1: mobile-workspace, 2: modal:settings]

    h.hist.manualGo = true;
    // User clicks X on SettingsModal -> queues go(-1)
    h.patch({ showConfigModal: false });
    // Before popstate fires, user ALSO presses hardware Back -> coalesces another -1!
    h.hist.go(-1);
    h.hist.flushCoalescedGo(); // Browser jumps directly 2 -> 0!
    h.hist.manualGo = false;

    expect(h.hist.index).toBe(0);
    expect(h.state().showConfigModal).toBe(false);
    expect(h.state().sidebarOpen).toBe(true); // mobile-workspace ALSO popped!

    // Fallback timer recovers if browser swallows a go() call
    h.patch({ sidebarOpen: false, showPairModal: true });
    expect(h.hist.index).toBe(2);
    h.hist.swallowGo = true;
    h.patch({ showPairModal: false });
    await flushAsync(65);
    h.hist.swallowGo = false;
    // Fallback settled internal cursor so opening another modal still works cleanly
    h.patch({ showPairModal: true });
    expect((h.hist.getState() as any).key).toBe("modal:pair");

    h.dispose();
  });

  test("exitCodeToGateway unwinds all #/code entries cleanly both from #/ and on direct cold load", async () => {
    // 1) Entered from Gateway #/ -> #/code
    const histFromGateway = new MockBrowserHistory("#/");
    histFromGateway.navigateHash("#/code");
    const h1 = createHarness(
      { overlaySidebar: true, isMobile: true, sidebarOpen: false, historyView: true, showPairModal: true },
      { history: histFromGateway },
    );
    expect(histFromGateway.index).toBe(4); // [0: #/, 1: root, 2: mobile-workspace, 3: history-view, 4: modal:pair]

    clientMod.exitCodeToGateway();
    await flushAsync();
    expect(histFromGateway.index).toBe(0);
    expect(histFromGateway.getHash()).toBe("#/");
    h1.dispose();

    // 2) Cold-loaded directly on #/code (no prior #/ entry)
    const histDirect = new MockBrowserHistory("#/code");
    const h2 = createHarness(
      { overlaySidebar: true, isMobile: true, sidebarOpen: false, showPairModal: true },
      { history: histDirect },
    );
    expect(histDirect.index).toBe(2); // [0: root, 1: mobile-workspace, 2: modal:pair]

    clientMod.exitCodeToGateway();
    await flushAsync();
    expect(histDirect.index).toBe(0);
    expect(histDirect.getHash()).toBe("#/");
    expect(histDirect.replaceLocationCalls).toEqual(["#/"]);
    h2.dispose();
  });
});
