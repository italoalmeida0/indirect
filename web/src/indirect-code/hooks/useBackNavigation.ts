import { batch, createEffect, onCleanup, onMount, untrack } from "solid-js";
import {
  consumeEnteredCodeFromGatewayRoot,
  registerCodeExitHandler,
  routeKind,
} from "../../route-nav";

const TAB_BOOT_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `boot_${Date.now()}_${Math.random().toString(36).slice(2)}`;

const IN_FLIGHT_FALLBACK_MS = 120;

export interface IcHistoryState {
  __ic: 1;
  bootId: string;
  idx: number;
  key: string;
  fromGatewayRoot?: boolean;
}

export interface NavLayer {
  key: string;
  /** Return `false` to refuse dismissal (e.g. `savingSettings()` in flight). */
  pop: () => boolean | void;
  /** Optional idempotent forward-restoration handler. */
  restore?: () => boolean | void;
}

export interface NavProjectionState {
  hostsCount: number;
  hasPairingData: boolean;
  overlaySidebar: boolean;
  updating: boolean;
  sidebarOpen: boolean;
  historyView: boolean;
  selectionMode: boolean;
  renamingId: string | null;
  editingMsgIdx: number | null;
  editingQueueId: string | null;
  fullscreenWidget: boolean;
  showConfigModal: boolean;
  showNewProjectModal: boolean;
  folderNavDepth: number;
  showPairModal: boolean;
  hasPreviewFile: boolean;
  showPreviewSlicer: boolean;
  hasChoiceModal: boolean;
  hasConfirmModal: boolean;
  modeMenuOpen: boolean;
  accessMenuOpen: boolean;
  hostMenuOpen: boolean;
  newProjectMenuOpen: boolean;
  addContextOpen: boolean;
  isMobile: boolean;
  addContextSubView: "main" | "effort" | "model" | "mode" | "access";
  effortMenuOpen: boolean;
  modelMenuOpen: boolean;
  modelFromEffort: boolean;
  projectMenuOpen: boolean;
  usageOpen: boolean;
  hasSessionMenu: boolean;
  hasProjectMenu: boolean;
  mentionsOpen: boolean;
  editMentionsOpen: boolean;
  slashOpen: boolean;
}

export interface NavLayerActions {
  clearPairingData: () => void;
  openSidebar: () => void;
  closeSidebar: () => void;
  closeHistoryView: () => void;
  openHistoryView: () => void;
  exitSelectionMode: () => void;
  cancelRename: () => void;
  cancelEditMsg: () => void;
  cancelEditQueue: () => void;
  closeFullscreenWidget: () => void;
  closeSettingsModal: () => boolean;
  openSettingsModal: () => boolean;
  closeNewProjectModal: () => void;
  stepBackNewProjectFolder: () => void;
  closePairModal: () => void;
  closePreviewModal: () => void;
  closePreviewSlicer: () => void;
  cancelChoiceModal: () => void;
  cancelConfirmModal: () => void;
  closeModeMenu: () => void;
  closeAccessMenu: () => void;
  closeHostMenu: () => void;
  closeNewProjectMenu: () => void;
  closeAddContextMenu: () => void;
  setAddContextSubView: (view: "main" | "effort" | "model" | "mode" | "access") => void;
  closeEffortMenu: () => void;
  closeModelMenu: () => void;
  closeModelAndEffortMenus: () => void;
  stepBackModelToEffort: () => void;
  closeProjectPickerMenu: () => void;
  closeUsageMenu: () => void;
  closeSessionContextMenu: () => void;
  closeProjectActionsMenu: () => void;
  dismissMentions: () => void;
  dismissEditMentions: () => void;
  dismissSlash: () => void;
}

export interface HistoryAdapter {
  getState: () => unknown;
  getHref: () => string;
  getHash: () => string;
  pushState: (data: unknown, unused: string, url?: string) => void;
  replaceState: (data: unknown, unused: string, url?: string) => void;
  go: (delta: number) => void;
  replaceLocation: (url: string) => void;
  addPopStateListener: (fn: (e: PopStateEvent) => void) => () => void;
}

function defaultHistoryAdapter(): HistoryAdapter | null {
  if (typeof window === "undefined" || typeof history === "undefined" || typeof location === "undefined") {
    return null;
  }
  return {
    getState: () => history.state,
    getHref: () => location.href,
    getHash: () => location.hash,
    pushState: (data, unused, url) => history.pushState(data, unused, url),
    replaceState: (data, unused, url) => history.replaceState(data, unused, url),
    go: (delta) => history.go(delta),
    replaceLocation: (url) => location.replace(url),
    addPopStateListener: (fn) => {
      window.addEventListener("popstate", fn);
      return () => window.removeEventListener("popstate", fn);
    },
  };
}

export function isIndirectCodeHash(hash: string): boolean {
  const raw = (hash || "").replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  const path = (qIdx >= 0 ? raw.slice(0, qIdx) : raw) || "/";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return routeKind(normalized) === "code";
}

function isIcState(value: unknown): value is IcHistoryState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.__ic === 1 &&
    typeof candidate.bootId === "string" &&
    typeof candidate.idx === "number" &&
    Number.isFinite(candidate.idx) &&
    typeof candidate.key === "string"
  );
}

/**
 * Projects active Indirect Code state into an ordered stack of back-navigable
 * layers from bottommost (`idx: 1`) to topmost (`idx: N`), with `idx: 0` as
 * the `#/code` root floor.
 */
export function projectNavLayers(
  state: NavProjectionState,
  actions: NavLayerActions,
): NavLayer[] {
  const stack: NavLayer[] = [];

  // 1. Onboarding pairing card OR mobile/narrow workspace layer.
  if (state.hostsCount === 0) {
    if (state.hasPairingData) {
      stack.push({
        key: "onboarding-pair",
        pop: () => actions.clearPairingData(),
      });
    }
  } else if (state.overlaySidebar && !state.updating && !state.sidebarOpen) {
    stack.push({
      key: "mobile-workspace",
      pop: () => actions.openSidebar(),
      restore: () => actions.closeSidebar(),
    });
  }

  // 2. Full-pane Conversation History view.
  if (state.historyView) {
    stack.push({
      key: "history-view",
      pop: () => actions.closeHistoryView(),
      restore: () => actions.openHistoryView(),
    });
  }

  // 3. In-page transient modes.
  if (state.sidebarOpen && state.selectionMode) {
    stack.push({
      key: "mode:selection",
      pop: () => actions.exitSelectionMode(),
    });
  }
  if (state.sidebarOpen && state.renamingId !== null) {
    stack.push({
      key: "mode:rename",
      pop: () => actions.cancelRename(),
    });
  }
  if (state.editingMsgIdx !== null) {
    stack.push({
      key: "mode:edit-msg",
      pop: () => actions.cancelEditMsg(),
    });
  }
  if (state.editingQueueId !== null) {
    stack.push({
      key: "mode:edit-queue",
      pop: () => actions.cancelEditQueue(),
    });
  }

  // 4. Fullscreen Generative UI widget.
  if (state.fullscreenWidget) {
    stack.push({
      key: "widget-fullscreen",
      pop: () => actions.closeFullscreenWidget(),
    });
  }

  // 5. Feature modals (z-50).
  if (state.showConfigModal) {
    stack.push({
      key: "modal:settings",
      pop: () => actions.closeSettingsModal(),
      restore: () => actions.openSettingsModal(),
    });
  }
  if (state.showNewProjectModal) {
    stack.push({
      key: "modal:new-project",
      pop: () => actions.closeNewProjectModal(),
    });
    for (let d = 0; d < state.folderNavDepth; d++) {
      stack.push({
        key: `modal:new-project:dir:${d}`,
        pop: () => actions.stepBackNewProjectFolder(),
      });
    }
  }
  if (state.showPairModal) {
    stack.push({
      key: "modal:pair",
      pop: () => actions.closePairModal(),
    });
  }
  if (state.hasPreviewFile) {
    stack.push({
      key: "modal:preview",
      pop: () => actions.closePreviewModal(),
    });
    if (state.showPreviewSlicer) {
      stack.push({
        key: "modal:preview:slicer",
        pop: () => actions.closePreviewSlicer(),
      });
    }
  }

  // 6. Promise / action modals (z-50, can stack above other modals/views).
  if (state.hasChoiceModal) {
    stack.push({
      key: "modal:choice",
      pop: () => actions.cancelChoiceModal(),
    });
  }
  if (state.hasConfirmModal) {
    stack.push({
      key: "modal:confirm",
      pop: () => actions.cancelConfirmModal(),
    });
  }

  // 7. Floating menus & multi-step popovers (z-70).
  if (state.modeMenuOpen) {
    stack.push({
      key: "menu:mode",
      pop: () => actions.closeModeMenu(),
    });
  }
  if (state.accessMenuOpen) {
    stack.push({
      key: "menu:access",
      pop: () => actions.closeAccessMenu(),
    });
  }
  if (state.hostMenuOpen) {
    stack.push({
      key: "menu:host",
      pop: () => actions.closeHostMenu(),
    });
  }
  if (state.newProjectMenuOpen) {
    stack.push({
      key: "menu:new-project",
      pop: () => actions.closeNewProjectMenu(),
    });
  }
  if (state.addContextOpen) {
    stack.push({
      key: "menu:add-context",
      pop: () => actions.closeAddContextMenu(),
    });
    if (state.isMobile) {
      const sub = state.addContextSubView;
      if (sub === "effort" || sub === "model") {
        stack.push({
          key: "menu:add-context:effort",
          pop: () => actions.setAddContextSubView("main"),
        });
      }
      if (sub === "model") {
        stack.push({
          key: "menu:add-context:model",
          pop: () => actions.setAddContextSubView("effort"),
        });
      } else if (sub === "mode") {
        stack.push({
          key: "menu:add-context:mode",
          pop: () => actions.setAddContextSubView("main"),
        });
      } else if (sub === "access") {
        stack.push({
          key: "menu:add-context:access",
          pop: () => actions.setAddContextSubView("main"),
        });
      }
    }
  }
  if (state.effortMenuOpen) {
    stack.push({
      key: "menu:effort",
      pop: () => actions.closeEffortMenu(),
    });
  } else if (state.modelMenuOpen && state.modelFromEffort) {
    stack.push({
      key: "menu:effort",
      pop: () => actions.closeModelAndEffortMenus(),
    });
    stack.push({
      key: "menu:model",
      pop: () => actions.stepBackModelToEffort(),
    });
  } else if (state.modelMenuOpen) {
    stack.push({
      key: "menu:model",
      pop: () => actions.closeModelMenu(),
    });
  }
  if (state.projectMenuOpen) {
    stack.push({
      key: "menu:project-picker",
      pop: () => actions.closeProjectPickerMenu(),
    });
  }
  if (state.usageOpen) {
    stack.push({
      key: "menu:usage",
      pop: () => actions.closeUsageMenu(),
    });
  }
  if (state.hasSessionMenu) {
    stack.push({
      key: "menu:session",
      pop: () => actions.closeSessionContextMenu(),
    });
  }
  if (state.hasProjectMenu) {
    stack.push({
      key: "menu:project-actions",
      pop: () => actions.closeProjectActionsMenu(),
    });
  }
  if (state.mentionsOpen) {
    stack.push({
      key: "menu:mentions",
      pop: () => actions.dismissMentions(),
    });
  }
  if (state.editMentionsOpen) {
    stack.push({
      key: "menu:edit-mentions",
      pop: () => actions.dismissEditMentions(),
    });
  }
  if (state.slashOpen) {
    stack.push({
      key: "menu:slash",
      pop: () => actions.dismissSlash(),
    });
  }

  return stack;
}

export interface BackNavigationOptions {
  readState: () => NavProjectionState;
  actions: NavLayerActions;
  history?: HistoryAdapter;
  bootId?: string;
  inFlightFallbackMs?: number;
}

export function createBackNavigation(opts: BackNavigationOptions) {
  const maybeAdapter = opts.history ?? defaultHistoryAdapter();
  if (!maybeAdapter) return;
  const adapter: HistoryAdapter = maybeAdapter;

  const activeBootId = opts.bootId ?? TAB_BOOT_ID;
  const fallbackMs = opts.inFlightFallbackMs ?? IN_FLIGHT_FALLBACK_MS;

  let initialized = false;
  let disposed = false;
  let fromGatewayRoot = false;
  let cursorIdx = 0;
  let stampedKeys: string[] = [];
  let inFlightTarget: number | null = null;
  let bootRewinding = false;
  let pendingExitToGateway = false;
  let handlingPopState = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  const clearFallbackTimer = () => {
    if (fallbackTimer !== undefined) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
  };

  const clearExitTimer = () => {
    if (exitTimer !== undefined) {
      clearTimeout(exitTimer);
      exitTimer = undefined;
    }
  };

  const makeState = (idx: number, key: string): IcHistoryState => ({
    __ic: 1,
    bootId: activeBootId,
    idx,
    key,
    ...(fromGatewayRoot ? { fromGatewayRoot: true } : {}),
  });

  const currentDesired = (): NavLayer[] =>
    untrack(() => projectNavLayers(opts.readState(), opts.actions));

  const armFallback = () => {
    clearFallbackTimer();
    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined;
      if (disposed || inFlightTarget === null) return;
      const target = inFlightTarget;
      inFlightTarget = null;
      if (bootRewinding) {
        bootRewinding = false;
        cursorIdx = 0;
        stampedKeys = [];
        if (isIndirectCodeHash(adapter.getHash())) {
          adapter.replaceState(makeState(0, "root"), "", adapter.getHref());
        }
      } else {
        cursorIdx = target;
        stampedKeys = stampedKeys.slice(0, target);
      }
      sync();
    }, fallbackMs);
  };

  const navigateDelta = (targetIdx: number, delta: number) => {
    if (delta === 0) return;
    inFlightTarget = targetIdx;
    armFallback();
    adapter.go(delta);
  };

  function tryRestoreForward(key: string): boolean {
    if (key === "mobile-workspace") {
      opts.actions.closeSidebar();
      return true;
    }
    if (key === "history-view") {
      opts.actions.openHistoryView();
      return true;
    }
    if (key === "modal:settings") {
      return opts.actions.openSettingsModal();
    }
    return false;
  }

  function sync() {
    if (
      !initialized ||
      disposed ||
      handlingPopState ||
      bootRewinding ||
      pendingExitToGateway ||
      inFlightTarget !== null
    ) {
      return;
    }
    if (!isIndirectCodeHash(adapter.getHash())) return;

    const desired = projectNavLayers(opts.readState(), opts.actions);
    const desiredKeys = desired.map((layer) => layer.key);
    const D = desiredKeys.length;

    let lcp = 0;
    const maxCommon = Math.min(cursorIdx, D);
    while (lcp < maxCommon && stampedKeys[lcp] === desiredKeys[lcp]) {
      lcp++;
    }

    if (D === cursorIdx && lcp === cursorIdx) {
      return;
    }

    // Pure push or synchronous top-of-stack key replacement (+ optional pushes).
    if (D >= cursorIdx && lcp >= cursorIdx - 1) {
      if (cursorIdx >= 1 && lcp === cursorIdx - 1) {
        adapter.replaceState(
          makeState(cursorIdx, desiredKeys[cursorIdx - 1]!),
          "",
          adapter.getHref(),
        );
      }
      for (let i = cursorIdx; i < D; i++) {
        adapter.pushState(makeState(i + 1, desiredKeys[i]!), "", adapter.getHref());
      }
      cursorIdx = D;
      stampedKeys = desiredKeys;
      return;
    }

    // Stack shrank or diverged deeper than cursorIdx - 1: rewind to common prefix.
    navigateDelta(lcp, lcp - cursorIdx);
  }

  function onPopState(e: PopStateEvent) {
    if (disposed) return;

    const hash = adapter.getHash();
    if (pendingExitToGateway) {
      clearFallbackTimer();
      clearExitTimer();
      inFlightTarget = null;
      pendingExitToGateway = false;
      cursorIdx = 0;
      stampedKeys = [];
      if (isIndirectCodeHash(hash)) {
        adapter.replaceLocation("#/");
      }
      return;
    }

    if (!isIndirectCodeHash(hash)) {
      clearFallbackTimer();
      inFlightTarget = null;
      bootRewinding = false;
      cursorIdx = 0;
      stampedKeys = [];
      return;
    }

    const state = e.state ?? adapter.getState();

    // Completing initial cold-load / F5 stale-entry rewind.
    if (bootRewinding) {
      clearFallbackTimer();
      bootRewinding = false;
      inFlightTarget = null;
      cursorIdx = 0;
      stampedKeys = [];
      adapter.replaceState(makeState(0, "root"), "", adapter.getHref());
      sync();
      return;
    }

    // Stale entry from an earlier tab boot (e.g. user pressed Forward after F5 on desktop).
    if (isIcState(state) && state.bootId !== activeBootId) {
      clearFallbackTimer();
      inFlightTarget = null;
      const staleIdx = Math.max(0, Math.trunc(state.idx));
      const delta = cursorIdx - staleIdx;
      if (delta !== 0) {
        navigateDelta(cursorIdx, delta);
      } else {
        adapter.replaceState(
          makeState(cursorIdx, cursorIdx === 0 ? "root" : (stampedKeys[cursorIdx - 1] ?? "root")),
          "",
          adapter.getHref(),
        );
      }
      return;
    }

    const newIdx = isIcState(state) ? Math.max(0, Math.trunc(state.idx)) : 0;

    if (!isIcState(state)) {
      adapter.replaceState(makeState(0, "root"), "", adapter.getHref());
    }

    if (inFlightTarget !== null) {
      const target = inFlightTarget;
      clearFallbackTimer();
      inFlightTarget = null;
      cursorIdx = target;
      stampedKeys = stampedKeys.slice(0, target);
      if (newIdx === target) {
        sync();
        return;
      }
      // If a user Back/Forward coalesced with our programmatic history.go,
      // fall through from `cursorIdx = target` to handle the user delta!
    }

    if (newIdx === cursorIdx) {
      sync();
      return;
    }

    if (newIdx < cursorIdx) {
      const desired = currentDesired();
      let refusedAtDepth: number | null = null;
      handlingPopState = true;
      try {
        batch(() => {
          const topIdx = Math.min(desired.length, cursorIdx) - 1;
          for (let i = topIdx; i >= newIdx; i--) {
            const res = desired[i]?.pop();
            if (res === false) {
              refusedAtDepth = i + 1;
              break;
            }
          }
        });
      } finally {
        handlingPopState = false;
      }

      if (refusedAtDepth !== null) {
        cursorIdx = newIdx;
        navigateDelta(refusedAtDepth, refusedAtDepth - newIdx);
        return;
      }

      const afterKeys = currentDesired().map((l) => l.key);
      cursorIdx = newIdx;
      stampedKeys = afterKeys.slice(0, newIdx);
      sync();
      return;
    }

    // Forward navigation (newIdx > cursorIdx).
    const key = isIcState(state) ? state.key : "";
    let restored = false;
    if (newIdx === cursorIdx + 1 && key) {
      handlingPopState = true;
      try {
        restored = tryRestoreForward(key);
      } finally {
        handlingPopState = false;
      }
    }

    const afterDesired = currentDesired();
    const afterKeys = afterDesired.map((l) => l.key);
    if (restored && afterDesired.length === newIdx && afterKeys[newIdx - 1] === key) {
      cursorIdx = newIdx;
      stampedKeys = afterKeys;
      return;
    }

    const actualDepth = afterDesired.length;
    stampedKeys = afterKeys;
    cursorIdx = newIdx;
    if (actualDepth !== newIdx) {
      navigateDelta(actualDepth, actualDepth - newIdx);
    } else {
      adapter.replaceState(
        makeState(actualDepth, actualDepth === 0 ? "root" : afterKeys[actualDepth - 1]!),
        "",
        adapter.getHref(),
      );
    }
  }

  function exitToGateway() {
    if (disposed) return;
    if (!isIndirectCodeHash(adapter.getHash())) {
      adapter.replaceLocation("#/");
      return;
    }
    const effectiveIdx = inFlightTarget ?? cursorIdx;
    clearFallbackTimer();
    inFlightTarget = null;
    bootRewinding = false;

    if (fromGatewayRoot) {
      // Unwind all #/code entries plus the #/ -> #/code transition entry itself.
      if (effectiveIdx + 1 > 0) {
        adapter.go(-(effectiveIdx + 1));
      } else {
        adapter.replaceLocation("#/");
      }
      return;
    }

    if (effectiveIdx > 0) {
      pendingExitToGateway = true;
      clearExitTimer();
      exitTimer = setTimeout(() => {
        exitTimer = undefined;
        if (disposed || !pendingExitToGateway) return;
        pendingExitToGateway = false;
        cursorIdx = 0;
        stampedKeys = [];
        if (isIndirectCodeHash(adapter.getHash())) {
          adapter.replaceLocation("#/");
        }
      }, fallbackMs + 40);
      adapter.go(-effectiveIdx);
      return;
    }

    adapter.replaceLocation("#/");
  }

  function initialize() {
    if (initialized || disposed) return;
    initialized = true;

    const removePopState = adapter.addPopStateListener(onPopState);
    registerCodeExitHandler(exitToGateway);

    onCleanup(() => {
      disposed = true;
      clearFallbackTimer();
      clearExitTimer();
      removePopState();
      registerCodeExitHandler(null);
    });

    if (!isIndirectCodeHash(adapter.getHash())) return;

    const raw = adapter.getState();
    const enteredFromRoot = consumeEnteredCodeFromGatewayRoot();
    if (isIcState(raw)) {
      fromGatewayRoot = Boolean(raw.fromGatewayRoot) || enteredFromRoot;
      const staleIdx = Math.max(0, Math.trunc(raw.idx));
      if (staleIdx > 0) {
        bootRewinding = true;
        cursorIdx = staleIdx;
        stampedKeys = [];
        navigateDelta(0, -staleIdx);
        return;
      }
    } else {
      fromGatewayRoot = enteredFromRoot;
    }

    cursorIdx = 0;
    stampedKeys = [];
    adapter.replaceState(makeState(0, "root"), "", adapter.getHref());
  }

  // Initialize synchronously before the reactive effect runs when history is ready,
  // and also guard with onMount in case mount lifecycle is deferred.
  initialize();
  onMount(() => {
    initialize();
    sync();
  });

  createEffect(() => {
    // Track reactive state even while an in-flight go() is pending so Solid
    // re-notifies if signals change, and run sync() when ready.
    const projected = opts.readState();
    void projected;
    sync();
  });
}
