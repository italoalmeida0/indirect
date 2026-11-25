import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createTurnNotify } from "../web/src/indirect-code/hooks/useTurnNotify";
import {
  createActivePresence,
  DEFAULT_ACTIVE_IDLE_MS,
  isIndirectCodeHashActive,
  type PresenceDocumentLike,
  type PresenceWindowLike,
} from "../web/src/indirect-code/utils/activePresence";

interface RegisteredListener {
  type: string;
  fn: EventListenerOrEventListenerObject;
  capture: boolean;
  passive: boolean;
}

function normalizeCapture(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
  if (typeof options === "boolean") return options;
  return Boolean(options?.capture);
}

function normalizePassive(options?: boolean | AddEventListenerOptions): boolean {
  if (typeof options === "object" && options !== null) return Boolean(options.passive);
  return false;
}

/** Deterministic DOM + clock harness for active presence and turn notification tests. */
function createFakeBrowserEnv(initial?: {
  visibilityState?: DocumentVisibilityState;
  focused?: boolean;
  hash?: string;
  now?: number;
  activeElementTag?: string | null;
}) {
  let visibilityState: DocumentVisibilityState = initial?.visibilityState ?? "visible";
  let hasFocusValue = initial?.focused ?? true;
  let hash = initial?.hash ?? "#/code";
  let nowMs = initial?.now ?? 100_000;
  let activeElementTag: string | null = initial?.activeElementTag ?? null;

  const docListeners: RegisteredListener[] = [];
  const winListeners: RegisteredListener[] = [];

  const addTo = (
    list: RegisteredListener[],
    type: string,
    fn: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    const capture = normalizeCapture(options);
    const passive = normalizePassive(options);
    if (!list.some((l) => l.type === type && l.fn === fn && l.capture === capture)) {
      list.push({ type, fn, capture, passive });
    }
  };

  const removeFrom = (
    list: RegisteredListener[],
    type: string,
    fn: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    const capture = normalizeCapture(options);
    const idx = list.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (idx >= 0) list.splice(idx, 1);
  };

  const fireOn = (list: RegisteredListener[], type: string) => {
    for (const entry of [...list]) {
      if (entry.type !== type) continue;
      if (typeof entry.fn === "function") entry.fn({ type } as Event);
      else entry.fn.handleEvent({ type } as Event);
    }
  };

  const doc: PresenceDocumentLike = {
    get visibilityState() {
      return visibilityState;
    },
    get activeElement() {
      return activeElementTag ? { tagName: activeElementTag } : null;
    },
    hasFocus: () => hasFocusValue,
    addEventListener: (type, fn, opts) => addTo(docListeners, type, fn, opts),
    removeEventListener: (type, fn, opts) => removeFrom(docListeners, type, fn, opts),
  };

  const win: PresenceWindowLike = {
    location: {
      get hash() {
        return hash;
      },
    },
    addEventListener: (type, fn, opts) => addTo(winListeners, type, fn, opts),
    removeEventListener: (type, fn, opts) => removeFrom(winListeners, type, fn, opts),
  };

  return {
    doc,
    win,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setVisibility: (v: DocumentVisibilityState, emit = true) => {
      visibilityState = v;
      if (emit) fireOn(docListeners, "visibilitychange");
    },
    setHasFocus: (v: boolean) => {
      hasFocusValue = v;
    },
    setHash: (nextHash: string) => {
      hash = nextHash;
    },
    setActiveElementTag: (tag: string | null) => {
      activeElementTag = tag;
    },
    fireDoc: (type: string) => fireOn(docListeners, type),
    fireWin: (type: string) => fireOn(winListeners, type),
    docListeners: () => [...docListeners],
    winListeners: () => [...winListeners],
    totalListeners: () => docListeners.length + winListeners.length,
  };
}

async function withNotificationAndAudioMocks<T>(
  opts: { notificationPermission?: NotificationPermission | "unsupported" },
  run: (spies: {
    notifications: Array<{ title: string; body: string; tag: string }>;
    audioChimes: number;
    getAudioChimes: () => number;
  }) => T | Promise<T>,
): Promise<T> {
  const prevNotificationDesc = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  const prevAudioCtxDesc = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");

  const notifications: Array<{ title: string; body: string; tag: string }> = [];
  let audioChimes = 0;

  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    constructor() {
      audioChimes++;
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 0 },
        connect: (target: unknown) => target,
        start: () => {},
        stop: () => {},
        onended: null as (() => void) | null,
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: (target: unknown) => target,
      };
    }
  }

  if (opts.notificationPermission === "unsupported") {
    delete (globalThis as Record<string, unknown>).Notification;
  } else {
    const perm = opts.notificationPermission ?? "granted";
    (globalThis as Record<string, unknown>).Notification = class {
      static permission = perm;
      onclick: (() => void) | null = null;
      constructor(title: string, init?: { body?: string; tag?: string }) {
        notifications.push({ title, body: init?.body ?? "", tag: init?.tag ?? "" });
      }
      close() {}
    };
  }

  (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
  (globalThis as Record<string, unknown>).window = {
    AudioContext: FakeAudioContext,
    focus: () => {},
  };

  try {
    return await run({
      notifications,
      get audioChimes() {
        return audioChimes;
      },
      getAudioChimes: () => audioChimes,
    });
  } finally {
    if (prevNotificationDesc) Object.defineProperty(globalThis, "Notification", prevNotificationDesc);
    else delete (globalThis as Record<string, unknown>).Notification;

    if (prevWindowDesc) Object.defineProperty(globalThis, "window", prevWindowDesc);
    else delete (globalThis as Record<string, unknown>).window;

    if (prevAudioCtxDesc) Object.defineProperty(globalThis, "AudioContext", prevAudioCtxDesc);
    else delete (globalThis as Record<string, unknown>).AudioContext;
  }
}

function makeHost(id: string, name: string) {
  return {
    id,
    name,
    hostname: name.toLowerCase(),
    os: "darwin",
    arch: "arm64",
    userId: "u1",
    apiKeyId: null,
    status: "online" as const,
    lastSeenAt: null,
    createdAt: 0,
  };
}

function triggerTurnEnd(
  notify: ReturnType<typeof createTurnNotify>,
  hostId: string,
  sessionId: string,
  kind: "done" | "error" | "cancelled" = "done",
) {
  notify.noteMessage({ type: "session_status", hostId, sessionId, status: "running" } as any);
  if (kind === "error") {
    notify.noteMessage({
      type: "agent_event",
      hostId,
      sessionId,
      event: { type: "turn_end", error: "boom" },
    } as any);
  } else if (kind === "cancelled") {
    notify.noteMessage({
      type: "agent_event",
      hostId,
      sessionId,
      event: { type: "turn_end", cancelled: true },
    } as any);
  }
  notify.noteMessage({ type: "session_status", hostId, sessionId, status: "idle" } as any);
}

describe("createActivePresence detector", () => {
  test("tracks visibility, OS focus, idle threshold, and listener registration modes", () => {
    const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 10_000 });
    const presence = createActivePresence({
      doc: env.doc,
      win: env.win,
      now: env.now,
    });

    try {
      expect(DEFAULT_ACTIVE_IDLE_MS).toBe(60_000);
      expect(presence.isViewportActive()).toBe(true);
      expect(presence.isRecentlyActive()).toBe(true);
      expect(presence.isActive()).toBe(true);
      expect(presence.idleMs()).toBe(0);

      // Verify listener configuration: passive on all input events; non-capture on
      // window scroll so inner transcript auto-scroll never resets the idle timer.
      const scrollListener = env.winListeners().find((l) => l.type === "scroll");
      expect(scrollListener).toBeDefined();
      expect(scrollListener!.capture).toBe(false);
      expect(scrollListener!.passive).toBe(true);

      for (const evType of ["pointerdown", "keydown", "touchstart", "pointermove", "wheel"]) {
        const l = env.winListeners().find((item) => item.type === evType);
        expect(l).toBeDefined();
        expect(l!.capture).toBe(true);
        expect(l!.passive).toBe(true);
      }

      // Exact threshold boundary: 60_000ms is still active; 60_001ms is idle.
      env.advance(60_000);
      expect(presence.idleMs()).toBe(60_000);
      expect(presence.isRecentlyActive()).toBe(true);
      expect(presence.isActive()).toBe(true);

      env.advance(1);
      expect(presence.idleMs()).toBe(60_001);
      expect(presence.isRecentlyActive()).toBe(false);
      expect(presence.isActive()).toBe(false);
      // Viewport itself is still visible+focused, only recency expired.
      expect(presence.isViewportActive()).toBe(true);
    } finally {
      presence.dispose();
    }
    expect(env.totalListeners()).toBe(0);
  });

  test("refreshes idle clock on pointer, keyboard, wheel, touch, scroll, focus, visibility return, and noteActivity", () => {
    const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 5_000 });
    const presence = createActivePresence({
      doc: env.doc,
      win: env.win,
      now: env.now,
      idleTimeoutMs: 60_000,
      activityThrottleMs: 1_000,
    });

    try {
      // Throttled pointermove within 1_000ms does not churn timestamp.
      env.advance(400);
      env.fireWin("pointermove");
      expect(presence.lastActivityAt()).toBe(5_000);

      // Past throttle window, pointermove refreshes immediately.
      env.advance(700); // now = 6_100
      env.fireWin("pointermove");
      expect(presence.lastActivityAt()).toBe(6_100);
      expect(presence.idleMs()).toBe(0);

      // Walk away past 60s -> idle. First pointermove wakes presence immediately.
      env.advance(70_000); // now = 76_100
      expect(presence.isActive()).toBe(false);
      env.fireWin("pointermove");
      expect(presence.isActive()).toBe(true);
      expect(presence.idleMs()).toBe(0);

      // Test each remaining activity event after idling out.
      for (const evType of ["wheel", "scroll", "pointerdown", "keydown", "touchstart"] as const) {
        env.advance(65_000);
        expect(presence.isActive()).toBe(false);
        env.fireWin(evType);
        expect(presence.isActive()).toBe(true);
        expect(presence.idleMs()).toBe(0);
      }

      // Focus event resets idle clock when visible.
      env.advance(65_000);
      env.setHasFocus(false);
      env.fireWin("blur");
      expect(presence.isActive()).toBe(false);
      env.setHasFocus(true);
      env.fireWin("focus");
      expect(presence.isActive()).toBe(true);
      expect(presence.idleMs()).toBe(0);

      // Switching away to another tab and coming back resets idle clock.
      env.setVisibility("hidden");
      expect(presence.isActive()).toBe(false);
      env.advance(120_000);
      env.setVisibility("visible");
      expect(presence.isActive()).toBe(true);
      expect(presence.idleMs()).toBe(0);

      // Explicit noteActivity() resets idle clock (e.g. prompt submission).
      env.advance(65_000);
      expect(presence.isActive()).toBe(false);
      presence.noteActivity();
      expect(presence.isActive()).toBe(true);
      expect(presence.idleMs()).toBe(0);
    } finally {
      presence.dispose();
    }
  });

  test("ignores hover/wheel over an unfocused second-monitor window", () => {
    const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
    const presence = createActivePresence({
      doc: env.doc,
      win: env.win,
      now: env.now,
    });

    try {
      env.advance(10_000);
      env.setHasFocus(false);
      env.fireWin("blur");
      expect(presence.isViewportActive()).toBe(false);
      expect(presence.isActive()).toBe(false);

      // Moving mouse or scrolling wheel over the unfocused window must NOT reactivate it.
      env.advance(5_000);
      const before = presence.lastActivityAt();
      env.fireWin("pointermove");
      env.fireWin("wheel");
      env.fireWin("scroll");
      expect(presence.isViewportActive()).toBe(false);
      expect(presence.isActive()).toBe(false);
      expect(presence.lastActivityAt()).toBe(before);
    } finally {
      presence.dispose();
    }
  });

  test("handles embedded widget iframe focus without false blur, yet still detects OS alt-tab", () => {
    const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
    const presence = createActivePresence({
      doc: env.doc,
      win: env.win,
      now: env.now,
    });

    try {
      // User clicks inside a sandboxed Generative UI iframe: window blurs,
      // activeElement is IFRAME, document.hasFocus() remains true.
      env.advance(20_000);
      env.setActiveElementTag("IFRAME");
      env.setHasFocus(true);
      env.fireWin("blur");
      expect(presence.isViewportActive()).toBe(true);
      expect(presence.isActive()).toBe(true);
      expect(presence.idleMs()).toBe(0);

      // User then Alt-Tabs to VS Code: document.hasFocus() flips to false.
      env.setHasFocus(false);
      expect(presence.isViewportActive()).toBe(false);
      expect(presence.isActive()).toBe(false);
    } finally {
      presence.dispose();
    }
  });

  test("disposes all listeners automatically inside a Solid root and is idempotent", () => {
    const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
    let handle!: ReturnType<typeof createActivePresence>;

    createRoot((disposeRoot) => {
      handle = createActivePresence({
        doc: env.doc,
        win: env.win,
        now: env.now,
      });
      expect(env.totalListeners()).toBeGreaterThan(0);
      disposeRoot();
    });

    expect(env.totalListeners()).toBe(0);
    // Double dispose is a safe no-op.
    handle.dispose();
    expect(env.totalListeners()).toBe(0);
  });

  test("checks Indirect Code hash routes accurately", () => {
    expect(isIndirectCodeHashActive({ location: { hash: "#/code" } })).toBe(true);
    expect(isIndirectCodeHashActive({ location: { hash: "#/code?s=1" } })).toBe(true);
    expect(isIndirectCodeHashActive({ location: { hash: "#/code-dev" } })).toBe(true);
    expect(isIndirectCodeHashActive({ location: { hash: "" } })).toBe(true);
    expect(isIndirectCodeHashActive(null)).toBe(true);
    expect(isIndirectCodeHashActive({ location: { hash: "#/" } })).toBe(false);
    expect(isIndirectCodeHashActive({ location: { hash: "#/usage" } })).toBe(false);
    expect(isIndirectCodeHashActive({ location: { hash: "#/keys" } })).toBe(false);
    expect(isIndirectCodeHashActive({ location: { hash: "#/admin/stats" } })).toBe(false);
  });
});

describe("Smart active-viewing suppression in createTurnNotify", () => {
  test("focused + visible + same session + recent activity suppresses BOTH OS notification AND sound chime across turn end, approval, and question", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });
      const toasts: string[] = [];

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac")],
        sessions: () => [{ id: "s1", hostId: "h1", title: "Refactor auth" }],
        toast: (msg) => toasts.push(msg),
        onOpenSession: () => {},
        activeHostId: () => "h1",
        activeSessionId: () => "s1",
        activePresence: presence,
      });

      try {
        // User interacted 20s ago on focused session s1 -> everything is suppressed.
        env.advance(20_000);
        triggerTurnEnd(notify, "h1", "s1", "done");
        triggerTurnEnd(notify, "h1", "s1", "error");
        triggerTurnEnd(notify, "h1", "s1", "cancelled");
        notify.noteMessage({
          type: "tool_approval_request",
          hostId: "h1",
          sessionId: "s1",
          callId: "c1",
          tool: "bash",
          args: {},
        } as any);
        notify.noteMessage({
          type: "question_request",
          hostId: "h1",
          sessionId: "s1",
          question: { id: "q1" },
        } as any);

        expect(spies.notifications).toHaveLength(0);
        expect(spies.getAudioChimes()).toBe(0);
        expect(toasts).toHaveLength(0);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("also suppresses fallback toast AND sound chime when Notification API is unavailable", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "unsupported" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });
      const toasts: string[] = [];

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac")],
        sessions: () => [{ id: "s1", hostId: "h1", title: "Refactor auth" }],
        toast: (msg) => toasts.push(msg),
        onOpenSession: () => {},
        activeHostId: () => "h1",
        activeSessionId: () => "s1",
        activePresence: presence,
      });

      try {
        env.advance(15_000);
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(toasts).toHaveLength(0);
        expect(spies.getAudioChimes()).toBe(0);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("focused + visible + same session + idle past threshold (>60s, walked away) STILL notifies AND plays sound", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
      const presence = createActivePresence({
        doc: env.doc,
        win: env.win,
        now: env.now,
        idleTimeoutMs: 60_000,
      });

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac")],
        sessions: () => [{ id: "s1", hostId: "h1", title: "Long build" }],
        toast: () => {},
        onOpenSession: () => {},
        activeHostId: () => "h1",
        activeSessionId: () => "s1",
        activePresence: presence,
      });

      try {
        // User started a 3-minute turn and walked away from their desk.
        env.advance(180_000);
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.notifications[0]!.title).toBe("Turn finished — Long build");
        expect(spies.getAudioChimes()).toBe(1);

        // Approval while still idle also notifies + chimes.
        notify.noteMessage({
          type: "tool_approval_request",
          hostId: "h1",
          sessionId: "s1",
          callId: "c-idle",
          tool: "bash",
          args: {},
        } as any);
        expect(spies.notifications).toHaveLength(2);
        expect(spies.notifications[1]!.title).toBe("Approval needed — Long build");
        expect(spies.getAudioChimes()).toBe(2);

        // User walks back and moves mouse -> next turn finish is suppressed again!
        env.fireWin("pointermove");
        env.advance(10_000);
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(2);
        expect(spies.getAudioChimes()).toBe(2);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("visible on 2nd monitor + NOT focused (blur / hasFocus === false) STILL notifies AND plays sound", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac")],
        sessions: () => [{ id: "s1", hostId: "h1", title: "Second monitor" }],
        toast: () => {},
        onOpenSession: () => {},
        activeHostId: () => "h1",
        activeSessionId: () => "s1",
        activePresence: presence,
      });

      try {
        // Case A: window blurred (user clicked VS Code on monitor 1)
        env.setHasFocus(false);
        env.fireWin("blur");
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.getAudioChimes()).toBe(1);

        // Case B: window regains focus -> suppressed
        env.setHasFocus(true);
        env.fireWin("focus");
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.getAudioChimes()).toBe(1);

        // Case C: document.hasFocus() returns false even without a blur event -> still notifies
        env.setHasFocus(false);
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(2);
        expect(spies.getAudioChimes()).toBe(2);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("background tab (visibilityState === hidden) STILL notifies AND plays sound", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "hidden", focused: true, now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac")],
        sessions: () => [{ id: "s1", hostId: "h1", title: "Hidden tab" }],
        toast: () => {},
        onOpenSession: () => {},
        activeHostId: () => "h1",
        activeSessionId: () => "s1",
        activePresence: presence,
      });

      try {
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.getAudioChimes()).toBe(1);

        // Switch back to the tab -> immediately suppresses.
        env.setVisibility("visible");
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.getAudioChimes()).toBe(1);

        // Switch back to another tab -> notifies again.
        env.setVisibility("hidden");
        notify.noteMessage({
          type: "question_request",
          hostId: "h1",
          sessionId: "s1",
          question: { id: "q-bg" },
        } as any);
        expect(spies.notifications).toHaveLength(2);
        expect(spies.notifications[1]!.title).toBe("Your answer needed — Hidden tab");
        expect(spies.getAudioChimes()).toBe(2);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("focused + visible + active on Session A STILL notifies AND plays sound when Session B finishes", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac")],
        sessions: () => [
          { id: "sA", hostId: "h1", title: "Session A" },
          { id: "sB", hostId: "h1", title: "Session B" },
        ],
        toast: () => {},
        onOpenSession: () => {},
        activeHostId: () => "h1",
        activeSessionId: () => "sA",
        activePresence: presence,
      });

      try {
        // Session A is actively viewed -> silent.
        triggerTurnEnd(notify, "h1", "sA", "done");
        expect(spies.notifications).toHaveLength(0);
        expect(spies.getAudioChimes()).toBe(0);

        // Session B finishes while user is looking at Session A -> notifies + chimes!
        triggerTurnEnd(notify, "h1", "sB", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.notifications[0]!.title).toBe("Turn finished — Session B");
        expect(spies.getAudioChimes()).toBe(1);

        // Session B requests approval while viewing Session A -> notifies + chimes!
        notify.noteMessage({
          type: "tool_approval_request",
          hostId: "h1",
          sessionId: "sB",
          callId: "c-b",
          tool: "bash",
          args: {},
        } as any);
        expect(spies.notifications).toHaveLength(2);
        expect(spies.notifications[1]!.title).toBe("Approval needed — Session B");
        expect(spies.getAudioChimes()).toBe(2);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("focused + visible + active on Host 1 STILL notifies AND plays sound for a different hostId", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac"), makeHost("h2", "Linux Box")],
        sessions: () => [{ id: "s1", hostId: "h1", title: "Local chat" }],
        sessionsForHost: (hid) =>
          hid === "h2" ? [{ id: "s1", hostId: "h2", title: "Remote chat" }] : [],
        toast: () => {},
        onOpenSession: () => {},
        activeHostId: () => "h1",
        activeSessionId: () => "s1",
        activePresence: presence,
      });

      try {
        // Same sessionId "s1" but on h2 while actively viewing h1:s1 -> MUST notify!
        triggerTurnEnd(notify, "h2", "s1", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.notifications[0]!.title).toBe("Turn finished — Remote chat");
        expect(spies.notifications[0]!.body).toContain("Linux Box");
        expect(spies.getAudioChimes()).toBe(1);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("occluded session views (history/draft/updating/drawer) and non-code gateway routes STILL notify AND play sound", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, hash: "#/code", now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });
      let blocked = false;

      const notify = createTurnNotify({
        hosts: () => [makeHost("h1", "Mac")],
        sessions: () => [{ id: "s1", hostId: "h1", title: "Chat" }],
        toast: () => {},
        onOpenSession: () => {},
        isActivelyViewingSession: (hostId, sessionId) =>
          presence.isActivelyViewingSession(hostId, sessionId, {
            activeHostId: () => "h1",
            activeSessionId: () => "s1",
            isViewBlocked: () => blocked,
          }),
      });

      try {
        // Unblocked on #/code -> suppressed.
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(0);
        expect(spies.getAudioChimes()).toBe(0);

        // History view / mobile sidebar drawer / update overlay active -> notifies + chimes.
        blocked = true;
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(1);
        expect(spies.getAudioChimes()).toBe(1);

        // Back to unblocked, but navigated to another gateway route (#/usage) -> notifies + chimes.
        blocked = false;
        env.setHash("#/usage");
        triggerTurnEnd(notify, "h1", "s1", "done");
        expect(spies.notifications).toHaveLength(2);
        expect(spies.getAudioChimes()).toBe(2);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });

  test("manual testNotify() always fires notification and chime even when actively viewing", async () => {
    await withNotificationAndAudioMocks({ notificationPermission: "granted" }, async (spies) => {
      const env = createFakeBrowserEnv({ visibilityState: "visible", focused: true, now: 1_000 });
      const presence = createActivePresence({ doc: env.doc, win: env.win, now: env.now });

      const notify = createTurnNotify({
        hosts: () => [makeHost("test", "Test host")],
        sessions: () => [{ id: "test", hostId: "test", title: "Test conversation" }],
        toast: () => {},
        onOpenSession: () => {},
        activeHostId: () => "test",
        activeSessionId: () => "test",
        activePresence: presence,
      });

      try {
        notify.testNotify();
        await Promise.resolve();
        await Promise.resolve();
        expect(spies.notifications).toHaveLength(1);
        expect(spies.notifications[0]!.title).toBe("Turn finished — Test conversation");
        expect(spies.getAudioChimes()).toBe(1);
      } finally {
        notify.dispose();
        presence.dispose();
      }
    });
  });
});
