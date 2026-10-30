import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway, testPassword, waitUntil } from "./gateway-enterprise-fixture";

/**
 * Relay authorization across account lifecycle events (workstream A).
 *
 * Every client socket is bound to the `sessions` row that authenticated it
 * (user + jti + rotation family). Every revocation path removes the affected
 * sockets from the in-memory registry BEFORE requesting the close, so no
 * queued daemon frame can cross the relay during the closing handshake.
 * Daemon sockets revalidate their owner's account on every inbound frame.
 */

interface Sock {
  ws: WebSocket;
  messages: any[];
  /** Resolves with the code/reason the server (or peer) closed with. */
  closed: Promise<{ code: number; reason: string }>;
}

async function connect(base: string, route: string): Promise<Sock> {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}${route}`);
  const messages: any[] = [];
  ws.addEventListener("message", (event) => { try { messages.push(JSON.parse(String(event.data))); } catch {} });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      const ev = event as CloseEvent;
      resolve({ code: ev.code, reason: ev.reason });
    }, { once: true });
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${route.split("?")[0]}`)), { once: true });
  });
  return { ws, messages, closed };
}

async function pair(base: string, token: string, name = "test host") {
  const first = await request(base, "/api/indirect-code/pair", { token, method: "POST" });
  expect(first.response.status).toBe(200);
  const second = await request(base, `/api/indirect-code/connect/${first.data.token}`, { body: { name } });
  expect(second.response.status).toBe(200);
  return second.data as { hostId: string; daemonToken: string };
}

const clientPath = (token: string) => `/api/indirect-code/ws?token=${encodeURIComponent(token)}`;
const daemonPath = (token: string) => `/api/indirect-code/daemon/ws?token=${encodeURIComponent(token)}`;
const isClosed = (ws: WebSocket) => ws.readyState === WebSocket.CLOSED;

/** Closes are requested synchronously by the revoking request, so a short
 *  deadline asserts "immediately" instead of "eventually". */
const closedImmediately = (sock: Sock, label: string) =>
  waitUntil(() => isClosed(sock.ws), `${label} socket stayed open past revocation`, 2000);

/** Round-trip a client command through the daemon and wait for its answer. */
async function probePath(client: Sock, daemon: Sock, hostId: string, id: number) {
  client.ws.send(JSON.stringify({ type: "probe", hostId, id }));
  await waitUntil(() => daemon.messages.some((m) => m.type === "probe" && m.id === id), "client command was not forwarded to the daemon");
  daemon.ws.send(JSON.stringify({ type: "probe_result", hostId, id }));
  await waitUntil(() => client.messages.some((m) => m.id === id), "daemon response was not forwarded to the client");
}

/**
 * Send `count` marked daemon frames and wait until a still-authorized
 * witness socket has seen all of them. Only then is "the revoked socket
 * received nothing" meaningful: the broadcast demonstrably ran.
 */
async function daemonFanOut(daemon: Sock, witness: Sock, hostId: string, firstId: number, count = 5) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(firstId + i);
  for (const id of ids) daemon.ws.send(JSON.stringify({ type: "probe_result", hostId, id }));
  try {
    await waitUntil(
      () => ids.every((id) => witness.messages.some((m) => m.id === id)),
      "daemon frames never reached the authorized client",
    );
  } catch (error) {
    // Surface the socket states: a failing fan-out is either a dead daemon or
    // a witness that was itself revoked, and those need different fixes.
    throw new Error(
      `fan-out failed: witness=${witness.ws.readyState} daemon=${daemon.ws.readyState}`,
      { cause: error },
    );
  }
  // Settle: a frame queued behind the close request would land here.
  await Bun.sleep(150);
  return ids;
}

function expectNoFrames(sock: Sock, ids: number[]) {
  const received = sock.messages.filter((m) => ids.includes(m.id));
  expect(received).toEqual([]);
}

test("session revocations close bound sockets before any further daemon frame", async () => {
  const gateway = await startGateway();
  const sockets: WebSocket[] = [];
  const link = async (route: string) => { const sock = await connect(gateway.base, route); sockets.push(sock.ws); return sock; };
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const alice = await createUser(gateway.base, admin.accessToken, "alice@enterprise.test");
    const bob = await createUser(gateway.base, admin.accessToken, "bob@enterprise.test");
    const aliceHost = await pair(gateway.base, alice.accessToken);
    const bobHost = await pair(gateway.base, bob.accessToken);
    const daemon = await link(daemonPath(aliceHost.daemonToken));
    const bobDaemon = await link(daemonPath(bobHost.daemonToken));
    const aliceMain = await link(clientPath(alice.accessToken));
    const bobClient = await link(clientPath(bob.accessToken));
    const aliceSecond = await login(gateway.base, "alice@enterprise.test");
    const aliceOther = await link(clientPath(aliceSecond.accessToken));

    await probePath(aliceMain, daemon, aliceHost.hostId, 1);
    let nextId = 100;

    // Two tabs on the SAME session must both die: the binding is the session
    // row (jti), not the individual socket.
    const aliceMainTab2 = await link(clientPath(alice.accessToken));

    // ---- (1) single session revoke: one session, the rest of the user intact ----
    const sessions = await request(gateway.base, "/api/me/sessions", { token: alice.accessToken });
    const otherJti = sessions.data.sessions.find((s: any) => !s.current).jti;
    expect((await request(gateway.base, `/api/me/sessions/${otherJti}`, { token: alice.accessToken, method: "DELETE" })).response.status).toBe(200);
    await closedImmediately(aliceOther, "revoked session");
    expect(await aliceOther.closed).toEqual({ code: 1008, reason: "session_revoked" });
    // The other session of the same user, across both of its tabs, survives.
    expect(aliceMain.ws.readyState).toBe(WebSocket.OPEN);
    expect(aliceMainTab2.ws.readyState).toBe(WebSocket.OPEN);
    // The revoked socket can neither send nor receive anything afterwards.
    const daemonSeen = daemon.messages.length;
    try { aliceOther.ws.send(JSON.stringify({ type: "probe", hostId: aliceHost.hostId, id: nextId })); } catch {}
    await Bun.sleep(150);
    expect(daemon.messages.slice(daemonSeen)).toEqual([]);
    nextId += 10;
    expectNoFrames(aliceOther, await daemonFanOut(daemon, aliceMain, aliceHost.hostId, nextId));
    nextId += 10;
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);

    // ---- (2) rotation family replay: every socket of the family, a new login survives ----
    const rotated = await request(gateway.base, "/api/auth/refresh", { body: { refreshToken: alice.refreshToken } });
    expect(rotated.response.status).toBe(200);
    // Both tabs of the rotated session go, not just the one that connected first.
    await Promise.all([closedImmediately(aliceMain, "rotated session"), closedImmediately(aliceMainTab2, "rotated session tab 2")]);
    expect((await aliceMainTab2.closed).reason).toBe("session_revoked");
    const aliceRotated = await link(clientPath(rotated.data.accessToken));
    const fresh = await login(gateway.base, "alice@enterprise.test");
    const aliceFresh = await link(clientPath(fresh.accessToken));
    const replay = await request(gateway.base, "/api/auth/refresh", { body: { refreshToken: alice.refreshToken } });
    expect(replay.response.status).toBe(401);
    await closedImmediately(aliceRotated, "replayed rotation family");
    expect((await aliceRotated.closed).reason).toBe("session_revoked");
    expectNoFrames(aliceRotated, await daemonFanOut(daemon, aliceFresh, aliceHost.hostId, nextId));
    nextId += 10;
    // A different rotation family (fresh login) is not collateral damage.
    expect(aliceFresh.ws.readyState).toBe(WebSocket.OPEN);
    expect(daemon.ws.readyState).toBe(WebSocket.OPEN);

    // ---- (3) admin revoke-sessions: every socket of the user ----
    // A fresh login after the call is the witness: the daemon only fans out to
    // its own user's sockets, so only a new Alice tab can prove the broadcast ran.
    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}/revoke-sessions`, { token: admin.accessToken, method: "POST" })).response.status).toBe(200);
    await Promise.all([closedImmediately(aliceFresh, "admin-revoked session"), closedImmediately(aliceRotated, "admin-revoked session")]);
    const aliceAfterRevoke = await login(gateway.base, "alice@enterprise.test");
    const aliceWitness = await link(clientPath(aliceAfterRevoke.accessToken));
    expectNoFrames(aliceFresh, await daemonFanOut(daemon, aliceWitness, aliceHost.hostId, nextId));
    nextId += 10;
    expect(daemon.ws.readyState).toBe(WebSocket.OPEN);
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);
    expect(bobDaemon.ws.readyState).toBe(WebSocket.OPEN);

    // ---- (4) password reset ----
    const aliceFourth = await login(gateway.base, "alice@enterprise.test");
    const aliceReset = await link(clientPath(aliceFourth.accessToken));
    const reset = await request(gateway.base, `/api/admin/users/${aliceFourth.user.id}/send-reset`, { token: admin.accessToken, method: "POST" });
    expect(reset.response.status).toBe(200);
    const resetToken = decodeURIComponent(String(reset.data.link).split("token=")[1]!);
    expect((await request(gateway.base, "/api/auth/password-reset/confirm", { body: { token: resetToken, password: testPassword } })).response.status).toBe(200);
    await Promise.all([closedImmediately(aliceReset, "password-reset session"), closedImmediately(aliceWitness, "password-reset session")]);
    expect((await aliceReset.closed).reason).toBe("session_revoked");
    const aliceAfterReset = await login(gateway.base, "alice@enterprise.test");
    const aliceWitness2 = await link(clientPath(aliceAfterReset.accessToken));
    expectNoFrames(aliceReset, await daemonFanOut(daemon, aliceWitness2, aliceHost.hostId, nextId));
    // A credential change revokes sessions only: the daemon keeps its token.
    expect(daemon.ws.readyState).toBe(WebSocket.OPEN);
    expect(daemon.messages.some((m) => m.type === "shutdown")).toBe(false);
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    for (const ws of sockets) ws.close();
    await gateway.stop();
  }
}, 60000);


test("ban, unban and deletion reauthorize the daemon token without remote-kill frames", async () => {
  const gateway = await startGateway();
  const sockets: WebSocket[] = [];
  const link = async (route: string) => { const sock = await connect(gateway.base, route); sockets.push(sock.ws); return sock; };
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    let alice = await createUser(gateway.base, admin.accessToken, "alice@enterprise.test");
    const bob = await createUser(gateway.base, admin.accessToken, "bob@enterprise.test");
    const aliceHost = await pair(gateway.base, alice.accessToken);
    const bobHost = await pair(gateway.base, bob.accessToken);
    let daemon = await link(daemonPath(aliceHost.daemonToken));
    const bobDaemon = await link(daemonPath(bobHost.daemonToken));
    let aliceClient = await link(clientPath(alice.accessToken));
    const bobClient = await link(clientPath(bob.accessToken));
    await probePath(aliceClient, daemon, aliceHost.hostId, 1);

    // ---- ban ----
    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}`, { token: admin.accessToken, method: "PATCH", body: { status: "banned" } })).response.status).toBe(200);
    await Promise.all([closedImmediately(aliceClient, "banned client"), closedImmediately(daemon, "banned daemon")]);
    expect((await aliceClient.closed).code).toBe(1008);
    expect((await aliceClient.closed).reason).toBe("session_revoked");
    expect((await daemon.closed).code).toBe(1008);
    expect((await daemon.closed).reason).toBe("account_unavailable");
    // A shutdown frame would make a live daemon self-terminate on unban.
    expect(daemon.messages.some((m) => m.type === "shutdown")).toBe(false);
    expect(daemon.messages.some((m) => m.type === "disconnected")).toBe(false);
    // The daemon token cannot (re)connect while the account is banned.
    expect((await fetch(`${gateway.base}${daemonPath(aliceHost.daemonToken)}`)).status).toBe(401);
    expect((await fetch(`${gateway.base}${clientPath(alice.accessToken)}`)).status).toBe(401);
    // The unrelated user is unaffected end to end.
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);
    expect(bobDaemon.ws.readyState).toBe(WebSocket.OPEN);
    expectNoFrames(aliceClient, await daemonFanOut(bobDaemon, bobClient, bobHost.hostId, 500));

    // ---- unban: normal reconnect, no remote kill ----
    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}`, { token: admin.accessToken, method: "PATCH", body: { status: "active" } })).response.status).toBe(200);
    alice = await login(gateway.base, "alice@enterprise.test");
    aliceClient = await link(clientPath(alice.accessToken));
    daemon = await link(daemonPath(aliceHost.daemonToken));
    expect(daemon.messages.some((m) => m.type === "shutdown")).toBe(false);
    await probePath(aliceClient, daemon, aliceHost.hostId, 2);
    const hosts = await request(gateway.base, "/api/indirect-code/hosts", { token: alice.accessToken });
    expect(hosts.data.hosts.find((h: any) => h.id === aliceHost.hostId).status).toBe("online");

    // ---- delete ----
    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}`, { token: admin.accessToken, method: "DELETE" })).response.status).toBe(200);
    await Promise.all([closedImmediately(aliceClient, "deleted client"), closedImmediately(daemon, "deleted daemon")]);
    expect(daemon.messages.some((m) => m.type === "shutdown")).toBe(false);
    expect((await fetch(`${gateway.base}${daemonPath(aliceHost.daemonToken)}`)).status).toBe(401);
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);
    expect(bobDaemon.ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    for (const ws of sockets) ws.close();
    await gateway.stop();
  }
}, 60000);

test("a daemon revalidates its owner on inbound frames and a client rechecks its session row", async () => {
  const gateway = await startGateway();
  const sockets: WebSocket[] = [];
  const link = async (route: string) => { const sock = await connect(gateway.base, route); sockets.push(sock.ws); return sock; };
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    sql.exec("PRAGMA busy_timeout = 5000");
    const admin = await login(gateway.base, "admin@enterprise.test");
    const alice = await createUser(gateway.base, admin.accessToken, "alice@enterprise.test");
    const bob = await createUser(gateway.base, admin.accessToken, "bob@enterprise.test");
    const aliceHost = await pair(gateway.base, alice.accessToken);
    const bobHost = await pair(gateway.base, bob.accessToken);
    const daemon = await link(daemonPath(aliceHost.daemonToken));
    const bobDaemon = await link(daemonPath(bobHost.daemonToken));
    const aliceClient = await link(clientPath(alice.accessToken));
    const bobClient = await link(clientPath(bob.accessToken));
    await probePath(aliceClient, daemon, aliceHost.hostId, 1);

    // Ban OUTSIDE this gateway (another instance, an operator, a restore):
    // no route runs in this process, so only the per-frame gate can notice.
    sql.run("UPDATE users SET status = 'banned' WHERE id = ?", [alice.user.id]);
    daemon.ws.send(JSON.stringify({ type: "probe_result", hostId: aliceHost.hostId, id: 700 }));
    await closedImmediately(daemon, "out-of-band banned daemon");
    expect((await daemon.closed).reason).toBe("account_unavailable");
    // The frame that triggered the recheck never reached the client.
    expect(aliceClient.messages.filter((m) => m.id === 700)).toEqual([]);
    expect(daemon.messages.some((m) => m.type === "shutdown")).toBe(false);

    // The client's next frame rechecks the session row: the owner is banned.
    await Bun.sleep(1100); // past the throttled recheck window
    try { aliceClient.ws.send(JSON.stringify({ type: "probe", hostId: aliceHost.hostId, id: 701 })); } catch {}
    await closedImmediately(aliceClient, "out-of-band banned client");
    expect((await aliceClient.closed).reason).toBe("session_revoked");

    // The unrelated user kept working throughout.
    await probePath(bobClient, bobDaemon, bobHost.hostId, 702);
  } finally {
    for (const ws of sockets) ws.close();
    sql.close();
    await gateway.stop();
  }
}, 60000);

test("deleting a host still sends the remote-kill frames", async () => {
  const gateway = await startGateway();
  const sockets: WebSocket[] = [];
  const link = async (route: string) => { const sock = await connect(gateway.base, route); sockets.push(sock.ws); return sock; };
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const alice = await createUser(gateway.base, admin.accessToken, "alice@enterprise.test");
    const aliceHost = await pair(gateway.base, alice.accessToken);
    const daemon = await link(daemonPath(aliceHost.daemonToken));
    const aliceClient = await link(clientPath(alice.accessToken));
    await probePath(aliceClient, daemon, aliceHost.hostId, 1);

    expect((await request(gateway.base, `/api/indirect-code/hosts/${aliceHost.hostId}`, { token: alice.accessToken, method: "DELETE" })).response.status).toBe(200);
    await closedImmediately(daemon, "deleted host daemon");
    // Host deletion is the ONE path that asks the daemon to self-terminate.
    await waitUntil(() => daemon.messages.some((m) => m.type === "shutdown"), "host deletion lost its shutdown frame");
    expect(daemon.messages.some((m) => m.type === "disconnected")).toBe(true);
    expect(await daemon.closed).toEqual({ code: 1000, reason: "host_deleted" });
    // The user account is fine, so the browser socket stays.
    expect(aliceClient.ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    for (const ws of sockets) ws.close();
    await gateway.stop();
  }
}, 40000);