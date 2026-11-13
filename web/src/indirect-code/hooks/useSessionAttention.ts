import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";
import { normalizeAttentionKind, type SessionAttentionKind } from "../store/sessions";
import type { SessionSummary } from "../types";

export interface LiveSessionAttentionOverlay {
  hostId: string;
  sessionId: string;
  attentionSeq?: number;
  seenSeq?: number;
  attentionKind?: SessionAttentionKind;
}

export interface SessionAttentionOpts {
  send: (payload: DaemonCommand) => void;
  wsOpen: () => boolean;
  isHostOnline: () => boolean;
  activeHostId: () => string;
  activeSessionId: () => string;
  activeSession: () => SessionSummary | null;
  draftMode: () => boolean;
  historyView: () => boolean;
  updating: () => boolean;
  isMobile: () => boolean;
  sidebarOpen: () => boolean;
  hosts: () => Array<{ id: string; status?: string }>;
  sessions: () => SessionSummary[];
  sessionsForHost: (hostId: string) => SessionSummary[];
  liveSessionAttention?: () => LiveSessionAttentionOverlay | null;
}

export function sessionAttentionLabel(kind?: SessionAttentionKind): string {
  switch (kind) {
    case "approval":
      return "Waiting for approval";
    case "question":
      return "Waiting for your answer";
    case "error":
      return "Turn failed";
    case "cancelled":
      return "Turn cancelled";
    default:
      return "Unread update";
  }
}

function computeViewportActive(): boolean {
  if (typeof document === "undefined") return true;
  const visible = (document.visibilityState ?? "visible") === "visible";
  if (!visible) return false;
  if (typeof document.hasFocus === "function") {
    return document.hasFocus();
  }
  return true;
}

function sessionAttentionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

export function createSessionAttention(opts: SessionAttentionOpts) {
  const [optimisticSeen, setOptimisticSeen] = createSignal<Record<string, number>>({});
  const [isViewportActive, setViewportActive] = createSignal<boolean>(computeViewportActive());

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    const onVisibilityChange = () => {
      setViewportActive(computeViewportActive());
    };
    const onWindowFocus = () => {
      if ((document.visibilityState ?? "visible") === "visible") {
        setViewportActive(true);
      }
    };
    const onWindowBlur = () => {
      setViewportActive(false);
    };
    const onUserInteract = () => {
      if ((document.visibilityState ?? "visible") === "visible") {
        setViewportActive(true);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pointerdown", onUserInteract, { capture: true, passive: true });
    window.addEventListener("keydown", onUserInteract, { capture: true, passive: true });

    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pointerdown", onUserInteract, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", onUserInteract, { capture: true } as EventListenerOptions);
    });
  }

  function overlayFor(hostId: string, sessionId: string): LiveSessionAttentionOverlay | null {
    const live = opts.liveSessionAttention?.();
    if (!live || live.hostId !== hostId || live.sessionId !== sessionId) return null;
    return live;
  }

  function serverAttentionSeq(s: Pick<SessionSummary, "id" | "hostId" | "attentionSeq">): number {
    const live = overlayFor(s.hostId, s.id);
    return Math.max(s.attentionSeq ?? 0, live?.attentionSeq ?? 0);
  }

  function serverSeenSeq(s: Pick<SessionSummary, "id" | "hostId" | "seenSeq">): number {
    const live = overlayFor(s.hostId, s.id);
    return Math.max(s.seenSeq ?? 0, live?.seenSeq ?? 0);
  }

  function effectiveAttentionKind(
    s: Pick<SessionSummary, "id" | "hostId" | "attentionSeq" | "attentionKind">,
  ): SessionAttentionKind | undefined {
    const live = overlayFor(s.hostId, s.id);
    if (live && (live.attentionSeq ?? 0) > (s.attentionSeq ?? 0)) {
      return normalizeAttentionKind(live.attentionKind) ?? normalizeAttentionKind(s.attentionKind);
    }
    return normalizeAttentionKind(s.attentionKind) ?? normalizeAttentionKind(live?.attentionKind);
  }

  function effectiveSeenSeq(s: Pick<SessionSummary, "id" | "hostId" | "seenSeq">): number {
    const key = sessionAttentionKey(s.hostId, s.id);
    return Math.max(serverSeenSeq(s), optimisticSeen()[key] ?? 0);
  }

  function hasUnseenServerState(
    s: Pick<SessionSummary, "id" | "hostId" | "attentionSeq" | "seenSeq">,
  ): boolean {
    return serverAttentionSeq(s) > effectiveSeenSeq(s);
  }

  function isActiveViewedSession(hostId: string, sessionId: string): boolean {
    if (!hostId || !sessionId) return false;
    if (!opts.wsOpen() || !opts.isHostOnline()) return false;
    if (opts.draftMode() || opts.historyView() || opts.updating()) return false;
    if (opts.isMobile() && opts.sidebarOpen()) return false;
    if (!isViewportActive()) return false;
    return hostId === opts.activeHostId() && sessionId === opts.activeSessionId();
  }

  function isSessionUnread(
    s: Pick<SessionSummary, "id" | "hostId" | "attentionSeq" | "seenSeq">,
  ): boolean {
    return hasUnseenServerState(s) && !isActiveViewedSession(s.hostId, s.id);
  }

  function labelForSession(
    s: Pick<SessionSummary, "id" | "hostId" | "attentionSeq" | "attentionKind">,
  ): string {
    return sessionAttentionLabel(effectiveAttentionKind(s));
  }

  // Auto-prune optimisticSeen entries once the mirrored seenSeq catches up.
  createEffect(() => {
    const map = optimisticSeen();
    const keys = Object.keys(map);
    if (keys.length === 0) return;

    let changed = false;
    const next = { ...map };
    for (const key of keys) {
      const sep = key.indexOf(":");
      if (sep <= 0) continue;
      const hid = key.slice(0, sep);
      const sid = key.slice(sep + 1);
      const list = hid === opts.activeHostId() ? opts.sessions() : opts.sessionsForHost(hid);
      const found = list.find((item) => item.id === sid);
      if (found && serverSeenSeq(found) >= map[key]!) {
        delete next[key];
        changed = true;
      }
    }
    if (changed) {
      setOptimisticSeen(next);
    }
  });

  // Auto-acknowledge active viewed session whenever unseen server state arrives or viewport activates.
  createEffect(() => {
    const hid = opts.activeHostId();
    const sid = opts.activeSessionId();
    if (!isActiveViewedSession(hid, sid)) return;

    const mirrored = opts.activeSession();
    const live = overlayFor(hid, sid);
    const candidate = mirrored
      ? mirrored
      : live
        ? {
            id: sid,
            hostId: hid,
            attentionSeq: live.attentionSeq,
            seenSeq: live.seenSeq,
          }
        : null;
    if (!candidate) return;

    if (!hasUnseenServerState(candidate)) return;
    const seq = serverAttentionSeq(candidate);
    if (seq <= 0) return;

    const key = sessionAttentionKey(hid, sid);
    setOptimisticSeen((prev) => ({
      ...prev,
      [key]: Math.max(prev[key] ?? 0, seq),
    }));
    opts.send({
      type: "mark_session_seen",
      hostId: hid,
      sessionId: sid,
      seenSeq: seq,
    });
  });

  function hostHasUnread(hostId: string): boolean {
    if (!hostId) return false;
    const hostList = opts.hosts();
    if (hostList.length > 0) {
      const host = hostList.find((h) => h.id === hostId);
      if (!host || host.status !== "online") return false;
    } else if (!opts.isHostOnline()) {
      return false;
    }
    const list = hostId === opts.activeHostId() ? opts.sessions() : opts.sessionsForHost(hostId);
    return list.some(isSessionUnread);
  }

  const anyOtherHostHasUnread = createMemo(() =>
    opts.hosts().some((h) => h.id !== opts.activeHostId() && h.status === "online" && hostHasUnread(h.id)),
  );

  const anyOnlineHostHasUnread = createMemo(() => {
    const hostList = opts.hosts();
    if (hostList.length === 0) {
      return opts.isHostOnline() && opts.sessions().some(isSessionUnread);
    }
    return hostList.some((h) => h.status === "online" && hostHasUnread(h.id));
  });

  // Reflect global cross-host unread state in the browser tab title.
  createEffect(() => {
    const unread = anyOnlineHostHasUnread();
    if (typeof document !== "undefined") {
      document.title = unread ? "• Indirect Code" : "Indirect Code";
    }
  });

  onCleanup(() => {
    if (typeof document !== "undefined" && document.title === "• Indirect Code") {
      document.title = "Indirect Code";
    }
  });

  return {
    optimisticSeen,
    isViewportActive,
    effectiveSeenSeq,
    hasUnseenServerState,
    isActiveViewedSession,
    isSessionUnread,
    labelForSession,
    hostHasUnread,
    anyOtherHostHasUnread,
    anyOnlineHostHasUnread,
  };
}
