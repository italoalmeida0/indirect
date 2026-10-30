import type { Server, ServerWebSocket } from "bun";
import { db, stmts, type SessionRow } from "../db";
import { GATEWAY_SECRET } from "../config";
import { jwtVerify, sha256Hex } from "../crypto";
import { sendTurnPush, type TurnPush } from "../push";

export type WsData =
  | {
      type: "daemon";
      hostId: string;
      userId: string;
      tokenHash: string;
      updating?: boolean;
      /** Next full revalidation deadline (host row + token + owner). The
       *  owner's account status is re-read on EVERY inbound frame. */
      revalidateAt: number;
    }
  | {
      type: "client";
      userId: string;
      jti: string;
      family: string;
      accessExpiresAt: number;
      expiresAt: number;
      /** Next session revalidation deadline (see CLIENT_RECHECK_MS). */
      revalidateAt: number;
    };

const daemons = new Map<string, ServerWebSocket<WsData>>();
const clientsByUserId = new Map<string, Set<ServerWebSocket<WsData>>>();
const clientExpiryTimers = new WeakMap<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>();

/**
 * Revocation is normally pushed into the relay by the mutating route
 * (auth.ts / routes/*), which removes the sockets before closing them.
 * This recheck is the safety net for revocation that happens OUTSIDE this
 * process — a second gateway, an operator editing the database, a restored
 * backup — so an already-open socket cannot outlive its session row by a
 * full access-token lifetime. One primary-key read per socket per second.
 */
const CLIENT_RECHECK_MS = 1000;

/** A daemon revalidates its host row + token at most once per second. The
 *  owner's account status is checked on every inbound frame instead. */
const DAEMON_REVALIDATE_MS = 1000;

interface DaemonTokenRow {
  id: string;
  user_id: string;
  status: string;
}

// Prepared once: these gates run on hot paths (every daemon frame, every
// client recheck) and must never pay for statement compilation.
/** Daemon token -> host + owner status (connect / re-pair handshake). */
const stmtDaemonToken = db.prepare<DaemonTokenRow, [string]>(
  `SELECT h.id, h.user_id, u.status FROM remote_hosts h
     JOIN users u ON u.id = h.user_id
    WHERE h.daemon_token_hash = ?`,
);
/** Host still exists for this user, still owns this token, account active. */
const stmtDaemonOwned = db.prepare<{ id: string }, [string, string, string]>(
  `SELECT h.id FROM remote_hosts h
     JOIN users u ON u.id = h.user_id
    WHERE h.id = ? AND h.user_id = ? AND h.daemon_token_hash = ? AND u.status = 'active'`,
);
/** O(1) primary-key lookup: the per-frame gate on every daemon socket. */
const stmtUserStatus = db.prepare<{ status: string }, [string]>(
  "SELECT status FROM users WHERE id = ?",
);

/** A session row that still authorizes a socket: same user, not revoked,
 *  inside both expiry windows, owner account still active. */
function usableSession(userId: string, jti: string, accessExpiresAt: number): SessionRow | null {
  const session = stmts.sessionByJti.get(jti);
  if (!session || session.user_id !== userId) return null;
  const now = Date.now();
  if (session.revoked || session.expires_at <= now || session.abs_expires_at <= now) return null;
  if (accessExpiresAt <= now) return null;
  if (stmts.userById.get(userId)?.status !== "active") return null;
  return session;
}

/** Drop a client socket from the registry (and its expiry timer). */
function unregisterClient(ws: ServerWebSocket<WsData>): void {
  if (ws.data.type !== "client") return;
  const clients = clientsByUserId.get(ws.data.userId);
  clients?.delete(ws);
  if (clients?.size === 0) clientsByUserId.delete(ws.data.userId);
  const timer = clientExpiryTimers.get(ws);
  if (timer) clearTimeout(timer);
  clientExpiryTimers.delete(ws);
}

/** Registry first, close second: no queued frame crosses the relay during
 *  the closing handshake. */
function disconnectClient(ws: ServerWebSocket<WsData>, reason: string): void {
  if (ws.data.type !== "client") return;
  unregisterClient(ws);
  try { ws.close(1008, reason); } catch {}
}

/** Refresh the sliding expiry at its previous deadline. Normal authenticated
 *  HTTP activity may have extended it since this socket was opened. */
function refreshClientExpiry(ws: ServerWebSocket<WsData>): boolean {
  if (ws.data.type !== "client") return false;
  try {
    const session = usableSession(ws.data.userId, ws.data.jti, ws.data.accessExpiresAt);
    if (session) {
      ws.data.expiresAt = Math.min(ws.data.accessExpiresAt, session.expires_at, session.abs_expires_at);
      ws.data.revalidateAt = Date.now() + CLIENT_RECHECK_MS;
      return true;
    }
  } catch (error) {
    console.error("[RELAY] session expiry check failed:", error instanceof Error ? error.name : "unknown");
  }
  disconnectClient(ws, "session_expired");
  return false;
}

function scheduleClientExpiry(ws: ServerWebSocket<WsData>): void {
  if (ws.data.type !== "client") return;
  const previous = clientExpiryTimers.get(ws);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    if (ws.data.type !== "client" || !clientsByUserId.get(ws.data.userId)?.has(ws)) return;
    if (refreshClientExpiry(ws)) scheduleClientExpiry(ws);
  }, Math.max(0, ws.data.expiresAt - Date.now()));
  timer.unref();
  clientExpiryTimers.set(ws, timer);
}

function clientLive(ws: ServerWebSocket<WsData>): boolean {
  if (ws.data.type !== "client" || !clientsByUserId.get(ws.data.userId)?.has(ws)) return false;
  const now = Date.now();
  if (now >= ws.data.expiresAt) {
    if (!refreshClientExpiry(ws)) return false;
    scheduleClientExpiry(ws);
    return true;
  }
  if (now >= ws.data.revalidateAt) {
    ws.data.revalidateAt = now + CLIENT_RECHECK_MS;
    let authorized: boolean;
    try {
      authorized = usableSession(ws.data.userId, ws.data.jti, ws.data.accessExpiresAt) !== null;
    } catch (error) {
      // A transient read failure must not sever every browser tab: the next
      // recheck retries in CLIENT_RECHECK_MS.
      console.error("[RELAY] session recheck failed:", error instanceof Error ? error.name : "unknown");
      return true;
    }
    if (!authorized) {
      disconnectClient(ws, "session_revoked");
      return false;
    }
  }
  return true;
}

/**
 * Revocation fan-out for client sockets.
 *
 * Every client socket is bound to the `sessions` row that authenticated it
 * (user + jti + rotation family), so callers can target one session, one
 * rotation family, or the whole user. ALL matching sockets are removed from
 * the in-memory registry BEFORE any close is requested: a revoked socket can
 * therefore never receive a queued daemon frame during the closing handshake.
 */
export function disconnectSessionSockets(
  userId: string,
  opts: { jti?: string; family?: string; exceptJti?: string } = {},
): void {
  const clients = clientsByUserId.get(userId);
  if (!clients) return;
  const doomed: ServerWebSocket<WsData>[] = [];
  for (const ws of clients) {
    if (ws.data.type !== "client") continue;
    if (opts.jti && ws.data.jti !== opts.jti) continue;
    if (opts.family && ws.data.family !== opts.family) continue;
    if (opts.exceptJti && ws.data.jti === opts.exceptJti) continue;
    doomed.push(ws);
  }
  if (doomed.length === 0) return;
  for (const ws of doomed) unregisterClient(ws);
  for (const ws of doomed) {
    try { ws.close(1008, "session_revoked"); } catch {}
  }
}

/** Registry + bookkeeping for a daemon socket that currently owns its host.
 *  Persists the host offline and tells the user's clients, exactly like the
 *  regular close handler. Returns true when this socket owned the host. */
function unregisterDaemon(ws: ServerWebSocket<WsData>): boolean {
  if (ws.data.type !== "daemon") return false;
  const { hostId, userId } = ws.data;
  if (daemons.get(hostId) !== ws) return false;
  daemons.delete(hostId);
  updatingHosts.delete(hostId);
  try {
    db.prepare("UPDATE remote_hosts SET status = 'offline', last_seen_at = ? WHERE id = ?").run(Date.now(), hostId);
  } catch (error) {
    console.error("[RELAY] could not persist host status:", error instanceof Error ? error.name : "unknown");
  }
  broadcastToUser(userId, { type: "host_status", hostId, status: "offline" });
  return true;
}

/**
 * Disconnect a daemon socket because its owner is no longer authorized.
 * NEVER sends the "shutdown" remote-kill frame: a banned account that is
 * unbanned must redial normally instead of the daemon self-terminating.
 * The socket leaves the registry before the close is requested.
 */
function dropDaemon(ws: ServerWebSocket<WsData>, reason: string): void {
  const hostId = ws.data.type === "daemon" ? ws.data.hostId : "";
  const owned = unregisterDaemon(ws);
  if (owned) console.log(`[RELAY] Daemon dropped: ${hostId} (${reason})`);
  try { ws.close(1008, reason); } catch {}
}

/**
 * Hot-path authorization for a daemon socket.
 *
 * The owner's account status is re-read from a prepared statement on EVERY
 * inbound frame (one primary-key lookup), so a ban stops daemon data even
 * when the ban happened outside this process. The host row and token are
 * revalidated once per DAEMON_REVALIDATE_MS.
 */
function daemonLive(ws: ServerWebSocket<WsData>): boolean {
  if (ws.data.type !== "daemon" || daemons.get(ws.data.hostId) !== ws) return false;
  const { hostId, userId, tokenHash } = ws.data;
  const now = Date.now();

  let status: string | undefined;
  try {
    status = stmtUserStatus.get(userId)?.status;
  } catch (error) {
    console.error("[RELAY] daemon account check failed:", error instanceof Error ? error.name : "unknown");
    return true;
  }
  if (status !== "active") {
    dropDaemon(ws, "account_unavailable");
    return false;
  }
  if (now >= ws.data.revalidateAt) {
    let owned: boolean;
    try {
      owned = stmtDaemonOwned.get(hostId, userId, tokenHash) !== null;
    } catch (error) {
      console.error("[RELAY] daemon host check failed:", error instanceof Error ? error.name : "unknown");
      ws.data.revalidateAt = now + DAEMON_REVALIDATE_MS;
      return true;
    }
    if (!owned) {
      dropDaemon(ws, "account_unavailable");
      return false;
    }
    ws.data.revalidateAt = now + DAEMON_REVALIDATE_MS;
  }
  return true;
}

/** Bans/deletions disconnect daemons without a shutdown frame, so an unbanned
 *  daemon can reconnect normally. The owner check blocks reconnects meanwhile.
 *  Every socket leaves the registry before any close is requested. */
export function disconnectUserDaemons(userId: string): void {
  const doomed: ServerWebSocket<WsData>[] = [];
  for (const ws of daemons.values()) {
    if (ws.data.type !== "daemon" || ws.data.userId !== userId) continue;
    doomed.push(ws);
  }
  for (const [hostId, owner] of updatingHosts) if (owner === userId) updatingHosts.delete(hostId);
  for (const ws of doomed) unregisterDaemon(ws);
  for (const ws of doomed) {
    try { ws.close(1008, "account_unavailable"); } catch {}
  }
}

export function closeDaemonSocket(hostId: string): void {
  const ws = daemons.get(hostId);
  if (ws) {
    try {
      // "shutdown" is the remote-kill signal: the daemon self-terminates
      // (quiesce + exit) instead of entering its reconnect backoff.
      // "disconnected" is kept for old daemons that only log it.
      ws.send(JSON.stringify({ type: "shutdown", hostId, reason: "host_deleted" }));
      ws.send(JSON.stringify({ type: "disconnected", reason: "host_deleted" }));
      ws.close(1000, "host_deleted");
    } catch {}
    daemons.delete(hostId);
    updatingHosts.delete(hostId);
  }
}

/**
 * Repair path (re-pair): drop the socket WITHOUT the remote-kill frames.
 * The host row is not deleted — the token was rotated on purpose so the
 * daemon keeps serving and its reconnect loop re-handshakes with the new
 * token. The "shutdown" frame of closeDaemonSocket would make a live
 * daemon self-terminate (it reads the frame as "host deleted") instead of
 * redialing, killing in-flight turns over a repair that must be seamless.
 */
export function disconnectDaemonSocket(hostId: string): void {
  const ws = daemons.get(hostId);
  if (ws) {
    try {
      ws.close(1000, "host_repaired");
    } catch {}
    daemons.delete(hostId);
    updatingHosts.delete(hostId);
  }
}

export function isHostOnline(hostId: string): boolean {
  return daemons.has(hostId);
}

// Hosts owned by a --update-start naive updater (brutal update protocol):
// the daemon socket is registered + online, but the host serves no turns.
// Ephemeral (in-memory only): a relay restart clears it and the next
// daemon_update (frozen) broadcast re-establishes the frontend overlay.
// A frontend connecting mid-update must be told the host is updating —
// see the client open handler below + isHostUpdating (hosts REST overlay).
const updatingHosts = new Map<string, string>(); // hostId -> userId

export function isHostUpdating(hostId: string): boolean {
  return updatingHosts.has(hostId);
}

export async function handleIndirectCodeUpgrade(
  path: string,
  req: Request,
  url: URL,
  server: Server<WsData>,
): Promise<Response | undefined> {
  // Daemon WebSocket: /api/indirect-code/daemon/ws?token=<daemonToken>
  // Brutal updater: ?updating=1 registers like a normal daemon (it OWNS the
  // host: pidfile + frozen daemon_update broadcasts) but the relay reports
  // host_status "updating" instead of "online" so frontends show the
  // update overlay instead of a live host.
  const isUpdating = url.searchParams.get("updating") === "1";
  if (path === "/api/indirect-code/daemon/ws") {
    let token = url.searchParams.get("token") || "";
    if (!token) {
      const authHeader = req.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7).trim();
    }
    if (!token) {
      return new Response("missing daemon token", { status: 401 });
    }

    const tokenHash = sha256Hex(token);
    const host = stmtDaemonToken.get(tokenHash);
    // A banned (or deleted) owner cannot (re)connect with a stored token.
    if (!host || host.status !== "active") {
      return new Response("unauthorized daemon token", { status: 401 });
    }

    const upgraded = server.upgrade(req, {
      data: {
        type: "daemon",
        hostId: host.id,
        userId: host.user_id,
        tokenHash,
        updating: isUpdating,
        revalidateAt: Date.now() + DAEMON_REVALIDATE_MS,
      },
    });
    if (upgraded) return undefined;
    return new Response("upgrade failed", { status: 400 });
  }

  // Client Web WebSocket: /api/indirect-code/client/ws?token=<jwtToken> or /api/indirect-code/ws?token=<jwtToken>
  if (path === "/api/indirect-code/client/ws" || path === "/api/indirect-code/ws") {
    let token = url.searchParams.get("token") || "";
    if (!token) {
      const authHeader = req.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7).trim();
    }
    if (!token) {
      return new Response("missing access token", { status: 401 });
    }

    const res = await jwtVerify(token, GATEWAY_SECRET);
    if (!res.ok || res.payload.type !== "access") {
      return new Response("unauthorized access token", { status: 401 });
    }

    const session = stmts.sessionByJti.get(res.payload.jti);
    const user = session && stmts.userById.get(session.user_id);
    if (!session || session.user_id !== res.payload.sub || session.revoked || session.expires_at <= Date.now() || session.abs_expires_at <= Date.now() || !user || user.status !== "active") {
      return new Response("session expired or revoked", { status: 401 });
    }

    // Bind the socket to the session row: user + jti + rotation family are
    // what every revocation path matches on.
    const accessExpiresAt = res.payload.exp * 1000;
    const upgraded = server.upgrade(req, {
      data: {
        type: "client",
        userId: session.user_id,
        jti: session.jti,
        family: session.family ?? session.jti,
        accessExpiresAt,
        expiresAt: Math.min(accessExpiresAt, session.expires_at, session.abs_expires_at),
        revalidateAt: Date.now() + CLIENT_RECHECK_MS,
      },
    });
    if (upgraded) return undefined;
    return new Response("upgrade failed", { status: 400 });
  }

  return new Response("not found", { status: 404 });
}

export const remoteRelayWsHandlers = {
  // Transcript JSON (session_data/session_content) compresses 5-10x.
  // The daemon negotiates permessage-deflate (gorilla EnableCompression)
  // and this flag accepts it; large fan-out sends below opt in per
  // message via send(payload, true). Small signals stay uncompressed.
  perMessageDeflate: true,
  open(ws: ServerWebSocket<WsData>) {
    if (ws.data.type === "daemon") {
      const { hostId, userId, tokenHash } = ws.data;
      const host = stmtDaemonOwned.get(hostId, userId, tokenHash);
      if (!host) { try { ws.close(1008, "account_unavailable"); } catch {} return; }
      const previous = daemons.get(hostId);
      if (previous && previous !== ws) { try { previous.close(1000, "superseded"); } catch {} }
      daemons.set(hostId, ws);
      ws.data.revalidateAt = Date.now() + DAEMON_REVALIDATE_MS;

      const now = Date.now();
      try {
        db.prepare("UPDATE remote_hosts SET status = 'online', last_seen_at = ? WHERE id = ?").run(now, hostId);
      } catch (error) {
        console.error("[RELAY] could not persist host status:", error instanceof Error ? error.name : "unknown");
      }

      // Brutal updater owns the host: report "updating" (overlay), not
      // "online" — UNLESS a fresh non-updating daemon already reclaimed
      // it (update_done path reconnects without the flag). The flag rides
      // on the socket (upgrade path is async, query is gone by open).
      const updating = ws.data.updating === true;
      if (updating) updatingHosts.set(hostId, userId);
      else updatingHosts.delete(hostId);
      const hostState = updating ? "updating" : "online";

      // Notify connected clients of this user
      broadcastToUser(userId, {
        type: "host_status",
        hostId,
        status: hostState,
      });
      console.log(`[RELAY] Daemon ${hostState}: ${hostId} (user: ${userId})`);
    } else if (ws.data.type === "client") {
      const { userId, jti, expiresAt, accessExpiresAt } = ws.data;
      // Re-check at open: a revocation may have landed between the upgrade
      // and this handler, before the socket was registered.
      if (!usableSession(userId, jti, accessExpiresAt) || expiresAt <= Date.now()) {
        disconnectClient(ws, "session_revoked");
        return;
      }
      let set = clientsByUserId.get(userId);
      if (!set) {
        set = new Set();
        clientsByUserId.set(userId, set);
      }
      set.add(ws);
      ws.data.revalidateAt = Date.now() + CLIENT_RECHECK_MS;
      scheduleClientExpiry(ws);

      try {
        ws.send(JSON.stringify({ type: "relay_connected", userId }));
      } catch {}
      // A frontend connecting mid-update missed the updating broadcast:
      // replay per-host updating state so the overlay shows immediately.
      for (const [hostId, owner] of updatingHosts) {
        if (owner !== userId) continue;
        try {
          ws.send(JSON.stringify({ type: "host_status", hostId, status: "updating" }));
        } catch {}
      }
    }
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    // Daemons revalidate their owner on every inbound frame; clients
    // revalidate their session row (throttled) before anything is accepted.
    if (ws.data.type === "daemon" && !daemonLive(ws)) return;
    if (ws.data.type === "client") {
      if (!clientLive(ws)) return;
    }
    const rawStr = typeof message === "string" ? message : message.toString("utf8");
    let parsed: any;
    try {
      parsed = JSON.parse(rawStr);
    } catch {
      return;
    }

    if (ws.data.type === "daemon") {
      // Message originating from Daemon -> forward to user's web client(s)
      const { userId } = ws.data;
      broadcastToUserCompressed(userId, rawStr, shouldCompressRelayEvent(parsed));
      // Turn finished while the user has no tab open: wake the browser
      // via Web Push. Tabs open (Camada A) already notified — skip.
      maybePushTurnEnd(userId, ws.data.hostId, parsed);
    } else if (ws.data.type === "client") {
      // Message originating from Web Client -> route to target daemon
      const hostId = parsed.hostId;
      if (!hostId || typeof hostId !== "string") return;

      // The naive updater owns the host (brutal update): it holds no
      // sessions and answers nothing useful. Block here — the relay is
      // the doorman — instead of letting commands die inside a hollow
      // process. Same error shape as offline so the frontend recovers
      // the same way; only the message differs.
      if (updatingHosts.has(hostId)) {
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              hostId,
              message: "Remote host is updating",
              replyTo: parsed.type,
              id: typeof parsed.id === "number" ? parsed.id : undefined,
              requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
              sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
            }),
          );
        } catch {}
        return;
      }
      const daemonWs = daemons.get(hostId);
      if (daemonWs && daemonWs.data.type === "daemon" && daemonWs.data.userId === ws.data.userId) {
        try {
          daemonWs.send(rawStr);
        } catch (e) {
          console.error(`[RELAY] Error sending to daemon ${hostId}:`, e);
        }
      } else {
        // Daemon offline or not owned by user
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              hostId,
              message: "Remote host is offline",
              replyTo: parsed.type,
              id: typeof parsed.id === "number" ? parsed.id : undefined,
              requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
              sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
            }),
          );
        } catch {}
      }
    }
  },

  close(ws: ServerWebSocket<WsData>, code: number, _reason: string) {
    if (ws.data.type === "daemon") {
      if (unregisterDaemon(ws)) {
        console.log(`[RELAY] Daemon offline: ${ws.data.hostId} (code: ${code})`);
      }
    } else if (ws.data.type === "client") {
      unregisterClient(ws);
    }
  },
};

/** Last-seen session titles from `session_data` (push needs a human name;
 *  `session_status` carries only ids). Bounded best-effort cache. */
const lastSessionTitle = new Map<string, string>();
/** Last `turn_end` disposition per turn (error/cancelled vary the push text). */
const lastDisposition = new Map<string, TurnPush["disposition"]>();

function turnKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

function isRelayRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Session id of a daemon frame. Realtime `session_data` frames carry only
 * `hostId` + `session` (session_actor.go / turn_worker.go) — their id lives
 * in `session.id`, so fall back to it. Everything else (`session_status`,
 * `agent_event`, ...) carries a top-level `sessionId`.
 */
export function relayFrameSessionId(parsed: unknown): string {
  if (!isRelayRecord(parsed)) return "";
  if (typeof parsed.sessionId === "string") return parsed.sessionId;
  const session = parsed.session;
  if (isRelayRecord(session) && typeof session.id === "string") return session.id;
  return "";
}

/**
 * Turn-end fan-out for closed tabs. Fires only when the user has zero
 * connected browser tabs (open tabs notify locally via Camada A) and the
 * daemon reports the real turn end: `session_status: idle` from finishTurn().
 * `turn_end` agent events are per-model-step, never a turn boundary.
 * Fire-and-forget: never blocks the relay hot path.
 */
function maybePushTurnEnd(userId: string, hostId: string, parsed: unknown): void {
  const sessionId = relayFrameSessionId(parsed);
  if (!sessionId) return;
  const key = turnKey(hostId, sessionId);
  if (!isRelayRecord(parsed)) return;
  if (parsed.type === "session_data" && isRelayRecord(parsed.session)) {
    const title = parsed.session.title;
    if (typeof title === "string" && title) {
      lastSessionTitle.set(key, title);
      if (lastSessionTitle.size > 2000) {
        const first = lastSessionTitle.keys().next();
        if (!first.done) lastSessionTitle.delete(first.value);
      }
    }
    return;
  }
  if (parsed.type === "agent_event") {
    const ev = parsed.event;
    if (isRelayRecord(ev) && ev.type === "turn_end") {
      lastDisposition.set(
        key,
        ev.cancelled === true ? "cancelled" : typeof ev.error === "string" && ev.error ? "error" : "done",
      );
    }
    return;
  }
  if (parsed.type !== "session_status" || parsed.status !== "idle") return;
  const disposition = lastDisposition.get(key) ?? "done";
  lastDisposition.delete(key);
  const clients = clientsByUserId.get(userId);
  if (clients && clients.size > 0) return;
  const host = db
    .prepare<{ name: string; hostname: string }, [string]>("SELECT name, hostname FROM remote_hosts WHERE id = ?")
    .get(hostId);
  const title = lastSessionTitle.get(key) ?? sessionId.slice(0, 12);
  const push: TurnPush = {
    title,
    host: host?.name || host?.hostname || "host",
    disposition,
    url: "/#/code",
  };
  void sendTurnPush(userId, push).catch((e) => console.warn("[PUSH] fan-out failed:", e));
}

function broadcastToUser(userId: string, data: string | object): void {
  broadcastToUserCompressed(userId, data, false);
}

/** Large transcript-carrying events compress 5-10x; small status
 *  signals skip it (deflate overhead exceeds the savings). Exported for
 *  the whitelist contract test (test/relay-regression.test.ts). */
export function shouldCompressRelayEvent(parsed: unknown): boolean {
  const t = isRelayRecord(parsed) ? parsed.type : undefined;
  return (
    t === "session_data" ||
    t === "session_content" ||
    t === "agent_event" ||
    t === "turn_file_changes"
  );
}

function broadcastToUserCompressed(userId: string, data: string | object, compress: boolean): void {
  const set = clientsByUserId.get(userId);
  if (!set || set.size === 0) return;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const client of set) {
    if (!clientLive(client)) continue;
    try {
      if (compress) client.send(payload, true);
      else client.send(payload);
    } catch {
      // Dead peer: drop it from the registry (and its expiry timer) so a
      // stale entry can never be counted as a live tab again.
      unregisterClient(client);
    }
  }
}
