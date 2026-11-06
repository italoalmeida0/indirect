import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway, waitUntil } from "./gateway-enterprise-fixture";

/**
 * Regression: closeDaemonSocket / disconnectDaemonSocket used to delete the
 * daemon from the registry themselves, so the WebSocket close handler's
 * unregisterDaemon() returned false and the user's tabs NEVER received
 * `host_status: "offline"`. Both paths must unregister (persist offline +
 * broadcast) before requesting the close, like dropDaemon does.
 */

interface Sock {
  ws: WebSocket;
  frames: unknown[];
  closed: Promise<{ code: number; reason: string }>;
}

interface Gateway {
  base: string;
  dir: string;
  stop: () => Promise<void>;
}

async function connect(base: string, route: string): Promise<Sock> {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}${route}`);
  const frames: unknown[] = [];
  ws.addEventListener("message", (event) => {
    try { frames.push(JSON.parse(String(event.data))); } catch {}
  });
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  ws.addEventListener("close", (event) => {
    const ev = event as CloseEvent;
    closed.resolve({ code: ev.code, reason: ev.reason });
  }, { once: true });
  const opened = Promise.withResolvers<void>();
  ws.addEventListener("open", () => opened.resolve(), { once: true });
  ws.addEventListener("error", () => opened.reject(new Error(`WebSocket failed: ${route.split("?")[0]}`)), { once: true });
  await opened.promise;
  return { ws, frames, closed: closed.promise };
}

function hasFrame(frames: unknown[], predicate: (frame: Record<string, unknown>) => boolean): boolean {
  return frames.some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    return predicate(raw as Record<string, unknown>);
  });
}

function sawHostStatus(frames: unknown[], hostId: string, status: string): boolean {
  for (const raw of frames) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const frame = raw as Record<string, unknown>;
    if (frame.type === "host_status" && frame.hostId === hostId && frame.status === status) return true;
  }
  return false;
}

const clientPath = (token: string) => `/api/indirect-code/ws?token=${encodeURIComponent(token)}`;
const daemonPath = (token: string) => `/api/indirect-code/daemon/ws?token=${encodeURIComponent(token)}`;

/** First pairing: two-step handshake returns the host id + daemon token. */
async function pair(base: string, token: string, name = "offline test host") {
  const first = await request(base, "/api/indirect-code/pair", { token, method: "POST" });
  expect(first.response.status).toBe(200);
  const second = await request(base, `/api/indirect-code/connect/${first.data.token}`, { body: { name } });
  expect(second.response.status).toBe(200);
  return second.data as { hostId: string; daemonToken: string };
}

/** Re-pair with the claimed host: server rotates the token, drops the stale
 *  socket through disconnectDaemonSocket() and returns the replacement. */
async function repair(base: string, token: string, hostId: string, daemonToken: string) {
  const first = await request(base, "/api/indirect-code/pair", { token, method: "POST" });
  expect(first.response.status).toBe(200);
  const second = await request(base, `/api/indirect-code/connect/${first.data.token}`, {
    body: { name: "offline test host", hostId, daemonToken },
  });
  expect(second.response.status).toBe(200);
  expect(second.data.reused).toBe(true);
  expect(second.data.hostId).toBe(hostId);
  return second.data as { hostId: string; daemonToken: string };
}

async function hostStatusFromApi(base: string, token: string, hostId: string) {
  const res = await request(base, "/api/indirect-code/hosts", { token });
  expect(res.response.status).toBe(200);
  const hosts = Array.isArray(res.data?.hosts) ? res.data.hosts : [];
  return (hosts as { id: string; status: string }[]).find((h) => h.id === hostId)?.status;
}

/** Durable host row status: the API overlays the in-memory registry, so only
 *  the database proves unregisterDaemon() persisted the offline transition. */
function hostStatusInDb(dir: string, hostId: string): string | undefined {
  const sql = new Database(path.join(dir, "gateway.db"));
  try {
    sql.exec("PRAGMA busy_timeout = 5000");
    return sql.prepare<{ status: string }, [string]>("SELECT status FROM remote_hosts WHERE id = ?").get(hostId)?.status;
  } finally {
    sql.close();
  }
}

let gateway: Gateway;
let sockets: WebSocket[] = [];
const link = async (route: string) => {
  const sock = await connect(gateway.base, route);
  sockets.push(sock.ws);
  return sock;
};

beforeAll(async () => {
  gateway = await startGateway();
}, 30_000);

afterAll(async () => {
  for (const ws of sockets) {
    try { ws.close(); } catch {}
  }
  sockets = [];
  await gateway.stop();
});

test("re-pair unregisters the stale daemon and broadcasts host_status offline", async () => {
  const admin = await login(gateway.base, "admin@enterprise.test");
  const user = await createUser(gateway.base, admin.accessToken, "offline-repair@enterprise.test");
  const host = await pair(gateway.base, user.accessToken);
  const client = await link(clientPath(user.accessToken));
  await waitUntil(() => hasFrame(client.frames, (f) => f.type === "relay_connected"), "client relay never connected");
  const daemon = await link(daemonPath(host.daemonToken));

  await waitUntil(() => sawHostStatus(client.frames, host.hostId, "online"), "client never saw the host go online");
  expect(await hostStatusFromApi(gateway.base, user.accessToken, host.hostId)).toBe("online");

  const repaired = await repair(gateway.base, user.accessToken, host.hostId, host.daemonToken);
  expect(repaired.daemonToken).not.toBe(host.daemonToken);

  await waitUntil(() => sawHostStatus(client.frames, host.hostId, "offline"), "re-pair did not broadcast host_status offline");
  // Re-pair is a seamless repair: no remote-kill frames, just a clean close.
  expect(hasFrame(daemon.frames, (f) => f.type === "shutdown" || f.type === "disconnected")).toBe(false);
  expect(await daemon.closed).toEqual({ code: 1000, reason: "host_repaired" });
  expect(await hostStatusFromApi(gateway.base, user.accessToken, host.hostId)).toBe("offline");
  expect(hostStatusInDb(gateway.dir, host.hostId)).toBe("offline");
});

test("host deletion unregisters the daemon and broadcasts host_status offline", async () => {
  const admin = await login(gateway.base, "admin@enterprise.test");
  const user = await createUser(gateway.base, admin.accessToken, "offline-delete@enterprise.test");
  const host = await pair(gateway.base, user.accessToken);
  const client = await link(clientPath(user.accessToken));
  await waitUntil(() => hasFrame(client.frames, (f) => f.type === "relay_connected"), "client relay never connected");
  const daemon = await link(daemonPath(host.daemonToken));

  await waitUntil(() => sawHostStatus(client.frames, host.hostId, "online"), "client never saw the host go online");
  expect(await hostStatusFromApi(gateway.base, user.accessToken, host.hostId)).toBe("online");

  const deleted = await request(gateway.base, `/api/indirect-code/hosts/${host.hostId}`, {
    token: user.accessToken,
    method: "DELETE",
  });
  expect(deleted.response.status).toBe(200);

  await waitUntil(() => sawHostStatus(client.frames, host.hostId, "offline"), "host deletion did not broadcast host_status offline");
  await waitUntil(() => hasFrame(daemon.frames, (f) => f.type === "shutdown" && f.reason === "host_deleted"), "daemon never received the shutdown frame");
  expect(hasFrame(daemon.frames, (f) => f.type === "disconnected" && f.reason === "host_deleted")).toBe(true);
  expect(await daemon.closed).toEqual({ code: 1000, reason: "host_deleted" });

  const res = await request(gateway.base, "/api/indirect-code/hosts", { token: user.accessToken });
  expect(res.data.hosts).toEqual([]);
  expect(hostStatusInDb(gateway.dir, host.hostId)).toBeUndefined();
});
