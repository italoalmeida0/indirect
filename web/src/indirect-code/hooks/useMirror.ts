import { createMemo, onCleanup } from "solid-js";
import { createDataLayer } from "../store/sessions";
import type { DaemonCommand } from "../daemon-protocol";
import { projectsByActivity, compareSessions } from "../paths";
import type { Project, SessionSummary } from "../types";

function areSessionOptionsEqual(
  a: SessionSummary["options"],
  b: SessionSummary["options"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.effort !== b.effort ||
    a.mode !== b.mode ||
    a.access !== b.access ||
    a.skills.length !== b.skills.length
  ) {
    return false;
  }
  for (let i = 0; i < a.skills.length; i++) {
    const sa = a.skills[i]!;
    const sb = b.skills[i]!;
    if (sa.name !== sb.name || sa.usable !== sb.usable) return false;
  }
  return true;
}

function areSessionSkillsEqual(
  a: SessionSummary["skills"],
  b: SessionSummary["skills"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i]!;
    if (!(k in b)) return false;
    const va = a[k]!;
    const vb = b[k]!;
    if (va === vb) continue;
    if (typeof va !== "object" || !va || typeof vb !== "object" || !vb) {
      return false;
    }
    if (
      va.priority !== vb.priority ||
      va.active !== vb.active ||
      va.usable !== vb.usable ||
      va.once !== vb.once ||
      va.inContext !== vb.inContext ||
      va.byAI !== vb.byAI
    ) {
      return false;
    }
  }
  return true;
}

export function areSessionsEqual(a: SessionSummary, b: SessionSummary): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.hostId === b.hostId &&
    a.cwd === b.cwd &&
    a.title === b.title &&
    a.model === b.model &&
    a.status === b.status &&
    a.pinned === b.pinned &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.lastTurnStartedAt === b.lastTurnStartedAt &&
    a.lastTurnEndedAt === b.lastTurnEndedAt &&
    a.attentionSeq === b.attentionSeq &&
    a.seenSeq === b.seenSeq &&
    a.attentionKind === b.attentionKind &&
    a.todosOpen === b.todosOpen &&
    a.approvalMode === b.approvalMode &&
    areSessionOptionsEqual(a.options, b.options) &&
    areSessionSkillsEqual(a.skills, b.skills)
  );
}

export function areSessionListsEqual(
  a: SessionSummary[],
  b: SessionSummary[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!areSessionsEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

export function areProjectsEqual(a: Project, b: Project): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.hostId === b.hostId &&
    a.name === b.name &&
    a.path === b.path &&
    a.createdAt === b.createdAt &&
    a.protected === b.protected &&
    a.folderStatus === b.folderStatus &&
    a.collapsed === b.collapsed
  );
}

export function areProjectListsEqual(a: Project[], b: Project[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!areProjectsEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

/** SignalDB mirror (sessions/projects/config per host). The page never
 * owns this data — the daemon does (extracted verbatim from RemoteCodePage). */
export function createMirror(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getHostId: () => string;
}) {
  const dataLayer = createDataLayer({
    send: (payload) => opts.send(payload),
    isOpen: opts.isOpen,
  });
  const store = createMemo(() => {
    const hid = opts.getHostId();
    return hid ? dataLayer.storeFor(hid) : null;
  });
  // Compare complete summaries structurally (avoids multi-MB JSON.stringify):
  // timestamps alone do not change for every mutation (project rename, session
  // options, pin/status updates).
  const sessions = createMemo<SessionSummary[]>(() => {
    const st = store();
    return st ? st.sessions.find({ hostId: opts.getHostId() }).fetch().slice()
      .sort(compareSessions) : [];
  }, [], { equals: areSessionListsEqual });
  const projects = createMemo<Project[]>(() => {
    const st = store();
    return st ? projectsByActivity(st.projects.find({ hostId: opts.getHostId() }).fetch(), sessions()) : [];
  }, [], { equals: areProjectListsEqual });
  const configDoc = createMemo(() => {
    const st = store();
    if (!st) return null;
    return st.config.find({ hostId: opts.getHostId() }).fetch()[0] ?? null;
  });

  function sessionsForHost(hostId: string): SessionSummary[] {
    if (!hostId) return [];
    return dataLayer.storeFor(hostId).sessions.find({ hostId }).fetch();
  }

  onCleanup(() => {
    dataLayer.disconnect();
    void dataLayer.disposeAll();
  });

  return { dataLayer, store, sessions, sessionsForHost, projects, configDoc };
}

export type Mirror = ReturnType<typeof createMirror>;
