/**
 * SignalDB data layer for Remote Code.
 *
 * The Go daemon is the single source of truth (projects / sessions / config
 * live on its disk). This module mirrors each host's data into per-host
 * SignalDB collections persisted in IndexedDB, so the UI paints instantly
 * from cache — even offline or on another device — and self-corrects on
 * every {type:"change"} ping the daemon broadcasts after a mutation.
 *
 * The web client is a dumb monitor: it never owns state, only renders the
 * collections and sends commands. There is no push: every mutation goes
 * through an explicit daemon command, and the resulting change ping makes
 * sync pull the fresh snapshot (stale local items simply disappear).
 */
import { Collection } from "@signaldb/core";
import solidReactivityAdapter from "@signaldb/solid";
import createIndexedDBAdapter from "@signaldb/indexeddb";
import { SyncManager } from "@signaldb/sync";
import type { DaemonCommand, DaemonMessage, PullCommand, PullWireMessage } from "../daemon-protocol";

/** One mirrored conversation summary (SessionSummary shape from the daemon). */
export interface RcSession {
  id: string;
  hostId: string;
  cwd: string;
  title: string;
  model: string;
  status: "idle" | "running";
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Start time of the most recent turn (sidebar recency); 0/absent on
   * sessions that never ran a turn — callers fall back to updatedAt. */
  lastTurnStartedAt?: number;
  todosOpen?: boolean;
  options?: { effort: string; mode: string; skills: { name: string; usable?: string }[]; access: string };
  /** Session skill selection (daemon SessionRecord.Skills, complete
   * snapshot): name -> {priority, active, usable} plus the daemon-owned
   * turn markers (once/inContext/byAI). */
  skills?: Record<string, { priority: number; active: boolean; usable: string; once?: boolean; inContext?: boolean; byAI?: boolean }>;
  /** Resolved approval mode ("ask" | "yolo"): "yolo" hides the YOLO/ASK
   * selector in the UI. */
  approvalMode?: string;
}

/** One mirrored project (host folder grouping conversations). */
export interface RcProject {
  folderStatus?: "available" | "missing" | "unavailable";
  id: string;
  hostId: string;
  name: string;
  path: string;
  createdAt: number;
  /** The default (home) project — present but never deletable. */
  protected?: boolean;
  collapsed?: boolean;
}

/** Daemon configuration mirror (single doc per host). */
export interface RcConfig {
  revision?: string;
  lastSelection?: { model: string; effort: string; mode?:string; access?:string; skills?:string[] };
  id: string;
  hostId: string;
  settings?: Record<string, any>;
  mcpServers?: Record<string, any>;
  skills?: Record<string, any>;
  name?: string;
}

export interface RcHostStore {
  projects: Collection<RcProject>;
  sessions: Collection<RcSession>;
  config: Collection<RcConfig>;
  /** (Re)pull everything from the daemon, if the socket is up. */
  syncAll: () => Promise<void>;
}

export interface RcDataLayer {
  storeFor: (hostId: string) => RcHostStore;
  disconnect: () => void;
  /**
   * Routes an incoming relay message. Returns true when the message belongs
   * to the sync protocol (pull responses / change pings) and was consumed.
   */
  handleMessage: (msg: DaemonMessage) => boolean;
  /** Releases a host's collections + sync manager (e.g. after host removal). */
  disposeHost: (hostId: string) => Promise<void>;
  /** Releases every host store (e.g. on page unmount). */
  disposeAll: () => Promise<void>;
}

interface PendingReq {
  hostId: string;
  /** Pull collection: the daemon echoes it in the response — the guard
   * rejects a wrong-collection reply (stale id / cross-tab id collision)
   * instead of resolving the wrong pull (audit bug 34). */
  collection: string;
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Pull-reply correlation: matches on id + hostId + collection. A reply for
 * another host, another tab's namespace or ANOTHER COLLECTION must not
 * resolve this request (audit bug 34). Pure and exported as the test seam
 * for the guard. */
export function pullReplyMatches(req: Pick<PendingReq, "hostId" | "collection">, reply: { hostId?: string; collection?: string }): boolean {
  return reply.hostId === req.hostId &&
    (typeof reply.collection !== "string" || reply.collection === req.collection);
}

/** Zero/negative timestamps are corruption, not 1970. The fallback must NOT
 * read the clock: useMirror suppresses mirror updates by comparing
 * JSON.stringify-equal summaries, and a fresh `Date.now()` per pull made
 * every corrupted session churn the sidebar on every pull forever. A single
 * frozen sentinel keeps the value stable per payload — and timeAgo renders a
 * non-positive stamp as "—", never "20706d". */
const CORRUPT_TIMESTAMP = 0;

/** One pulled session row from the daemon (unvalidated wire shape: only the
 * fields normalizeSession reads). */
interface RawSessionRow {
  id: string;
  cwd?: string;
  title?: string;
  model?: string;
  status?: string;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastTurnStartedAt?: number;
  todosOpen?: boolean;
  options?: { effort?: string; mode?: string; skills?: { name: string; usable?: string }[]; access?: string };
  skills?: Record<string, { priority?: number; active?: boolean; usable?: string }>;
  approvalMode?: string;
}

/** One pulled session row mapped to the mirror schema. Exported as a test
 * seam (the data layer itself needs IndexedDB to stand up). */
export function normalizeSession(r: RawSessionRow, hostId: string): RcSession {
  return {
    id: r.id,
    hostId,
    cwd: r.cwd || "",
    title: r.title || r.cwd || "New conversation",
    model: r.model || "",
    status: r.status === "running" ? "running" : "idle",
    pinned: !!r.pinned,
    createdAt: typeof r.createdAt === "number" && r.createdAt > 0 ? r.createdAt : CORRUPT_TIMESTAMP,
    updatedAt: typeof r.updatedAt === "number" && r.updatedAt > 0 ? r.updatedAt : CORRUPT_TIMESTAMP,
    lastTurnStartedAt: typeof r.lastTurnStartedAt === "number" && r.lastTurnStartedAt > 0 ? r.lastTurnStartedAt : undefined,
    todosOpen: typeof r.todosOpen === "boolean" ? r.todosOpen : undefined,
    options: r.options ? {
      effort: r.options.effort || "medium",
      mode: r.options.mode || "build",
      skills: Array.isArray(r.options.skills) ? r.options.skills : [],
      access: r.options.access || "full",
    } : undefined,
    skills: normalizeSessionSkills(r.skills),
    approvalMode: r.approvalMode === "yolo" ? "yolo" : r.approvalMode === "ask" ? "ask" : undefined,
  };
}

/** Normalizes the session skill map (raw wire entries may omit fields). */
function normalizeSessionSkills(raw: any): Record<string, { priority: number; active: boolean; usable: string }> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, { priority: number; active: boolean; usable: string }> = {};
  for (const [name, entry] of Object.entries<any>(raw)) {
    if (!entry || typeof entry !== "object") continue;
    out[name] = {
      priority: typeof entry.priority === "number" ? entry.priority : 0,
      active: !!entry.active,
      usable: typeof entry.usable === "string" ? entry.usable : "inherit",
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Creates the data layer. `send` transmits over the page's daemon socket and
 * must stamp the hostId itself; `isOpen` reports socket readiness.
 */
export function createDataLayer(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
}): RcDataLayer {
  const pending = new Map<number, PendingReq>();
  // Replies are broadcast to every browser. Per-page namespaces prevent one
  // tab's pull from resolving another tab's request with the same counter.
  let nextReqId = crypto.getRandomValues(new Uint32Array(1))[0] * 1_000_000;
  const changeListeners = new Map<string, Set<() => void>>();
  const stores = new Map<string, {
    api: RcHostStore;
    mgr: SyncManager<{ name: string }>;
    cols: Array<{ dispose(): Promise<void> }>;
  }>();

  function request(hostId: string, pull: PullCommand): Promise<any> {
    if (!opts.isOpen()) return Promise.reject(new Error("daemon socket is closed"));
    const id = nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`pull '${pull.collection}' timed out`));
      }, 12000);
      pending.set(id, { hostId, collection: pull.collection, resolve, reject, timer });
      opts.send({ ...pull, hostId, id });
    });
  }

  function normalizeProject(p: any, hostId: string): RcProject {
    const rawPath = String(p.path || "");
    // Windows hosts echo `C:\work\TAP`: strip both separators so the
    // fallback name is `TAP`, not the whole path.
    const fallback = rawPath.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || rawPath || "/";
    return {
      id: p.id,
      hostId,
      name: p.name || fallback,
      path: rawPath,
      createdAt: p.createdAt ?? Date.now(),
      protected: !!p.protected,
      folderStatus: p.folderStatus,
      collapsed: !!p.collapsed,
    };
  }

  function normalizeConfig(c: any, hostId: string): RcConfig {
    return {
      id: c.id || "daemon",
      revision: c.revision,
      hostId,
      lastSelection: c.lastSelection ?? c.last_selection,
      settings: c.settings && typeof c.settings === "object" ? c.settings : {},
      mcpServers: c.mcpServers ?? c.mcp_servers ?? {},
      skills: c.skills ?? {},
      name: c.name,
    };
  }

  function buildStore(hostId: string): RcHostStore {
    const mk = <T extends { id: string }>(name: string) => {
      const col = new Collection<T>({
        reactivity: solidReactivityAdapter,
        persistence: createIndexedDBAdapter(`rc:${hostId}:${name}`),
      });
      col.on("persistence.error", (error: Error) =>
        console.warn(`[rc-sync] persistence ${name}:`, error),
      );
      return col;
    };
    const projects = mk<RcProject>("projects");
    const sessions = mk<RcSession>("sessions");
    const config = mk<RcConfig>("config");

    const mgr = new SyncManager<{ name: string }>({
      id: `rc-${hostId}`,
      reactivity: solidReactivityAdapter,
      persistenceAdapter: (syncId) =>
        createIndexedDBAdapter(`rc:${hostId}:sync:${syncId}`),
      onError: (o, e) => console.warn(`[rc-sync] ${o?.name}:`, e),
      pull: async ({ name }) => {
        const resp = await request(hostId, { type: "pull", collection: name });
        if (!Array.isArray(resp?.items)) {
          throw new Error(`pull '${name}' returned no items`);
        }
        const raw = resp.items;
        if (name === "projects") {
          return { items: raw.map((p: any) => normalizeProject(p, hostId)) };
        }
        if (name === "sessions") {
          return { items: raw.map((s: any) => normalizeSession(s, hostId)) };
        }
        return { items: raw.map((c: any) => normalizeConfig(c, hostId)) };
      },
      // No client-side pushes: mutations are daemon commands; the daemon's
      // change ping pulls the corrected snapshot back down.
      push: async () => {},
      registerRemoteChange: ({ name }, onChange) => {
        const key = `${hostId}:${name}`;
        let set = changeListeners.get(key);
        if (!set) {
          set = new Set();
          changeListeners.set(key, set);
        }
        const fire = () => {
          void onChange();
        };
        set.add(fire);
        return () => {
          set.delete(fire);
        };
      },
    });
    mgr.addCollection(projects, { name: "projects" });
    mgr.addCollection(sessions, { name: "sessions" });
    mgr.addCollection(config, { name: "config" });

    const api: RcHostStore = {
      projects,
      sessions,
      config,
      syncAll: () => {
        if (!opts.isOpen()) return Promise.resolve();
        return mgr.syncAll();
      },
    };
    stores.set(hostId, { api, mgr, cols: [projects, sessions, config] });
    return api;
  }

  async function disposeHost(hostId: string) {
    const entry = stores.get(hostId);
    if (!entry) return;
    stores.delete(hostId);
    for (const key of [...changeListeners.keys()]) {
      if (key === hostId || key.startsWith(`${hostId}:`)) changeListeners.delete(key);
    }
    for (const [id, request] of [...pending.entries()]) {
      if (request.hostId === hostId) {
        pending.delete(id);
        clearTimeout(request.timer);
        request.reject(new Error(`host '${hostId}' disposed`));
      }
    }
    await entry.mgr.dispose();
    await Promise.all(entry.cols.map((c) => c.dispose()));
  }

  return {
    disconnect() {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("daemon socket disconnected"));
      }
      pending.clear();
    },
    storeFor(hostId: string) {
      return stores.get(hostId)?.api ?? buildStore(hostId);
    },
    disposeHost(hostId: string) {
      return disposeHost(hostId);
    },
    disposeAll() {
      return (async () => {
        for (const hostId of [...stores.keys()]) await disposeHost(hostId);
      })();
    },
    handleMessage(msg: DaemonMessage): boolean {
      // pull responses resolve their pending request by numeric id.
      const replyId = (msg as { id?: unknown }).id;
      if (typeof replyId === "number" && pending.has(replyId)) {
        const pull = msg as PullWireMessage;
        const p = pending.get(replyId)!;
        // A reply for another host (or another tab's namespace) must NOT be
        // swallowed here: returning false lets it fall through instead of
        // resolving the wrong request. Same for a wrong COLLECTION (audit bug
        // 34): a stale id or a cross-tab id collision must never resolve a
        // projects pull with sessions items (or vice versa).
        if (!pullReplyMatches(p, pull)) return false;
        pending.delete(replyId);
        clearTimeout(p.timer);
        const relayError = typeof pull.error === "string" && pull.error
          ? pull.error
          : msg.type === "error"
            ? String(pull.message || "daemon pull failed")
            : "";
        if (relayError) p.reject(new Error(relayError));
        else if (!Array.isArray(pull.items)) p.reject(new Error("pull response was missing items"));
        else p.resolve(pull);
        return true;
      }
      // change pings wake the matching collection's sync.
      if (msg?.type === "change" && typeof msg.collection === "string" && msg.hostId) {
        const set = changeListeners.get(`${msg.hostId}:${msg.collection}`);
        if (set) for (const cb of set) cb();
        return true;
      }
      return false;
    },
  };
}
