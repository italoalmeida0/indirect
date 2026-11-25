import { createSignal, getOwner, onCleanup } from "solid-js";
import { routeKind } from "../../route-nav";

/**
 * Default inactivity window (60s) during which a visible, OS-focused tab is
 * treated as actively watched by a user at the keyboard/pointer.
 *
 * Beyond this threshold, we assume the user may have stepped away (e.g., left
 * the browser focused during a multi-minute agent turn) so turn-end, approval,
 * and question alerts + sound chimes still fire.
 */
export const DEFAULT_ACTIVE_IDLE_MS = 60_000;

/**
 * Throttle interval for high-frequency pointer/wheel/scroll activity events so
 * continuous mouse movement never thrashes timestamps.
 */
export const DEFAULT_ACTIVITY_THROTTLE_MS = 1_000;

export interface PresenceDocumentLike {
  readonly visibilityState?: DocumentVisibilityState | string;
  readonly activeElement?: { readonly tagName?: string } | null;
  hasFocus?: () => boolean;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => void;
}

export interface PresenceWindowLike {
  readonly location?: { readonly hash?: string };
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => void;
}

export interface ActivePresenceOptions {
  /** Idle threshold in milliseconds (default: 60_000). */
  idleTimeoutMs?: number;
  /** Throttle window in milliseconds for pointermove/wheel/scroll (default: 1_000). */
  activityThrottleMs?: number;
  /** Injectable clock for deterministic testing (default: Date.now). */
  now?: () => number;
  /** Injectable document (default: globalThis.document). */
  doc?: PresenceDocumentLike | null;
  /** Injectable window (default: globalThis.window). */
  win?: PresenceWindowLike | null;
}

export interface SessionViewContext {
  activeHostId: () => string;
  activeSessionId: () => string;
  /**
   * True when the session transcript itself is not on screen (e.g., draft mode,
   * history view, host update overlay, or mobile/narrow sidebar drawer).
   */
  isViewBlocked?: () => boolean;
  /** Optional override for whether the Indirect Code route is active. */
  isRouteActive?: () => boolean;
}

export interface ActivePresence {
  /** Reactive + live check: tab is visible AND window has OS focus. */
  isViewportActive: () => boolean;
  /** Live check: last user activity is within `idleTimeoutMs`. */
  isRecentlyActive: () => boolean;
  /** Live check: tab is visible, window has OS focus, AND user was recently active. */
  isActive: () => boolean;
  /** Milliseconds elapsed since the last recorded real user activity. */
  idleMs: () => number;
  /** Timestamp (ms) of the last recorded real user activity. */
  lastActivityAt: () => number;
  /** Explicitly record user interaction (e.g. submitting a prompt). */
  noteActivity: () => void;
  /**
   * High-precision active-viewing predicate for a specific host+session:
   * true ONLY when the Indirect Code route is active, the session view is not
   * occluded, the exact target host+session is open, the tab is visible, the
   * window has OS focus, AND real user activity occurred within `idleTimeoutMs`.
   */
  isActivelyViewingSession: (
    targetHostId: string,
    targetSessionId: string,
    view: SessionViewContext,
  ) => boolean;
  /** Remove all registered DOM listeners (idempotent). */
  dispose: () => void;
}

function readVisible(doc: PresenceDocumentLike | null): boolean {
  if (!doc) return false;
  return (doc.visibilityState ?? "visible") === "visible";
}

function readHasFocus(doc: PresenceDocumentLike | null): boolean {
  if (!doc) return false;
  if (typeof doc.hasFocus === "function") {
    try {
      return Boolean(doc.hasFocus());
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether the current hash route is Indirect Code (or non-gateway, such
 * as empty hash in standalone fixtures/tests). Returns false if the user has
 * navigated to another gateway route like `#/usage`, `#/keys`, or `#/`.
 */
export function isIndirectCodeHashActive(win: PresenceWindowLike | null | undefined): boolean {
  const rawHash = win?.location?.hash;
  if (!rawHash || !rawHash.startsWith("#/")) return true;
  const path = rawHash.slice(1).split("?")[0] || "/";
  return routeKind(path) !== "gateway";
}

/**
 * High-precision browser presence & active-session viewing detector.
 *
 * Tracks three orthogonal signals:
 * 1. Tab visibility (`document.visibilityState === "visible"` + `visibilitychange`)
 * 2. OS window focus (`window` `focus`/`blur` + live `document.hasFocus()`,
 *    with iframe-focus awareness for sandboxed Generative UI widgets)
 * 3. Recent real human activity via passive listeners (`pointerdown`, `keydown`,
 *    `touchstart`, throttled `pointermove`/`wheel`, bubble-phase `window`
 *    `scroll`, focus/visibility return, and explicit `noteActivity()` calls).
 *
 * Note on `scroll`: attached on `window` WITHOUT `capture: true`. Inner
 * transcript containers programmatically mutate `el.scrollTop` while streaming
 * (`scroll.ts`), which emits non-bubbling `scroll` events on the container.
 * Listening in capture phase would let programmatic auto-scroll reset the idle
 * clock forever while the user is away from their desk. Genuine user scrolling
 * is captured via `wheel`, `touchstart`, `pointerdown`/`pointermove`, `keydown`,
 * and bubble-phase `window` `scroll`.
 */
export function createActivePresence(opts: ActivePresenceOptions = {}): ActivePresence {
  const idleTimeoutMs = Math.max(0, opts.idleTimeoutMs ?? DEFAULT_ACTIVE_IDLE_MS);
  const activityThrottleMs = Math.max(0, opts.activityThrottleMs ?? DEFAULT_ACTIVITY_THROTTLE_MS);
  const now = opts.now ?? (() => Date.now());
  const doc: PresenceDocumentLike | null =
    opts.doc !== undefined ? opts.doc : typeof document !== "undefined" ? document : null;
  const win: PresenceWindowLike | null =
    opts.win !== undefined ? opts.win : typeof window !== "undefined" ? window : null;

  const initialVisible = readVisible(doc);
  const initialFocused = initialVisible && readHasFocus(doc);

  const [visible, setVisible] = createSignal<boolean>(initialVisible);
  const [focused, setFocused] = createSignal<boolean>(initialFocused);
  let lastActivity = now();
  let disposed = false;

  const hasListeners = Boolean(
    doc &&
      win &&
      typeof doc.addEventListener === "function" &&
      typeof win.addEventListener === "function",
  );

  function recordActivity(immediate: boolean): void {
    const ts = now();
    if (
      immediate ||
      ts < lastActivity ||
      ts - lastActivity >= activityThrottleMs ||
      ts - lastActivity > idleTimeoutMs
    ) {
      lastActivity = ts;
    }
  }

  const onVisibilityChange = () => {
    const vis = readVisible(doc);
    setVisible(vis);
    if (!vis) {
      setFocused(false);
      return;
    }
    const foc = readHasFocus(doc);
    setFocused(foc);
    if (foc) {
      recordActivity(true);
    }
  };

  const onWindowFocus = () => {
    if (!readVisible(doc)) return;
    setVisible(true);
    setFocused(true);
    recordActivity(true);
  };

  const onWindowBlur = () => {
    // Clicking into an embedded sandboxed iframe (e.g. a Generative UI widget)
    // fires window blur on the parent while document.hasFocus() remains true.
    // Keep viewport active and count the click as user presence; if the user
    // later Alt-Tabs to another OS app, document.hasFocus() becomes false and
    // live checks in isViewportActive() immediately report inactive.
    if (
      doc &&
      doc.activeElement?.tagName?.toUpperCase() === "IFRAME" &&
      typeof doc.hasFocus === "function" &&
      readHasFocus(doc)
    ) {
      if (readVisible(doc)) {
        setVisible(true);
        setFocused(true);
        recordActivity(true);
      }
      return;
    }
    setFocused(false);
  };

  const onDirectInteract = () => {
    if (!readVisible(doc)) return;
    if (typeof doc?.hasFocus === "function" && !readHasFocus(doc)) return;
    setVisible(true);
    setFocused(true);
    recordActivity(true);
  };

  const onPassiveActivity = () => {
    if (!readVisible(doc)) return;
    // Ignore pointer hover / wheel scrolling over an unfocused second-monitor
    // window: the user is still working in another OS application.
    if (!focused() || !readHasFocus(doc)) return;
    recordActivity(false);
  };

  if (hasListeners && doc && win) {
    doc.addEventListener!("visibilitychange", onVisibilityChange);
    win.addEventListener!("focus", onWindowFocus);
    win.addEventListener!("blur", onWindowBlur);
    win.addEventListener!("pointerdown", onDirectInteract, { capture: true, passive: true });
    win.addEventListener!("keydown", onDirectInteract, { capture: true, passive: true });
    win.addEventListener!("touchstart", onDirectInteract, { capture: true, passive: true });
    win.addEventListener!("pointermove", onPassiveActivity, { capture: true, passive: true });
    win.addEventListener!("wheel", onPassiveActivity, { capture: true, passive: true });
    win.addEventListener!("scroll", onPassiveActivity, { passive: true });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (hasListeners && doc && win) {
      doc.removeEventListener?.("visibilitychange", onVisibilityChange);
      win.removeEventListener?.("focus", onWindowFocus);
      win.removeEventListener?.("blur", onWindowBlur);
      win.removeEventListener?.("pointerdown", onDirectInteract, { capture: true });
      win.removeEventListener?.("keydown", onDirectInteract, { capture: true });
      win.removeEventListener?.("touchstart", onDirectInteract, { capture: true });
      win.removeEventListener?.("pointermove", onPassiveActivity, { capture: true });
      win.removeEventListener?.("wheel", onPassiveActivity, { capture: true });
      win.removeEventListener?.("scroll", onPassiveActivity);
    }
  }

  if (getOwner()) {
    onCleanup(dispose);
  }

  function isViewportActive(): boolean {
    const sigVisible = visible();
    const sigFocused = focused();
    if (!doc) return false;
    if (!readVisible(doc)) return false;
    if (!readHasFocus(doc)) return false;
    return hasListeners ? sigVisible && sigFocused : true;
  }

  function idleMs(): number {
    return Math.max(0, now() - lastActivity);
  }

  function isRecentlyActive(): boolean {
    return idleMs() <= idleTimeoutMs;
  }

  function isActive(): boolean {
    return isViewportActive() && isRecentlyActive();
  }

  function noteActivity(): void {
    recordActivity(true);
  }

  function isActivelyViewingSession(
    targetHostId: string,
    targetSessionId: string,
    view: SessionViewContext,
  ): boolean {
    if (!targetHostId || !targetSessionId) return false;
    if (view.isRouteActive ? !view.isRouteActive() : !isIndirectCodeHashActive(win)) {
      return false;
    }
    if (view.isViewBlocked?.()) return false;
    if (view.activeHostId() !== targetHostId || view.activeSessionId() !== targetSessionId) {
      return false;
    }
    return isActive();
  }

  return {
    isViewportActive,
    isRecentlyActive,
    isActive,
    idleMs,
    lastActivityAt: () => lastActivity,
    noteActivity,
    isActivelyViewingSession,
    dispose,
  };
}
