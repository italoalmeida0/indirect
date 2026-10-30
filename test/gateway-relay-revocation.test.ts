import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway, testPassword, waitUntil } from "./gateway-enterprise-fixture";

async function socket(base: string, path: string) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}${path}`);
  const messages: any[] = [];
  ws.addEventListener("message", (event) => { try { messages.push(JSON.parse(String(event.data))); } catch {} });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${path.split("?")[0]}`)), { once: true });
  });
  return { ws, messages };
}

async function pair(base: string, token: string) {
  const first = await request(base, "/api/indirect-code/pair", { token, method: "POST" });
  expect(first.response.status).toBe(200);
  const second = await request(base, `/api/indirect-code/connect/${first.data.token}`, { body: { name: "test host" } });
  expect(second.response.status).toBe(200);
  return second.data as { hostId: string; daemonToken: string };
}

const clientPath = (token: string) => `/api/indirect-code/ws?token=${encodeURIComponent(token)}`;
const daemonPath = (token: string) => `/api/indirect-code/daemon/ws?token=${encodeURIComponent(token)}`;
const closed = (ws: WebSocket) => waitUntil(() => ws.readyState === WebSocket.CLOSED, "socket was not closed");

test("relay sockets follow session revocation, account status, and host ownership", async () => {
  const gateway = await startGateway();
  const sockets: WebSocket[] = [];
  const connect = async (path: string) => { const result = await socket(gateway.base, path); sockets.push(result.ws); return result; };
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    let alice = await createUser(gateway.base, admin.accessToken, "alice@enterprise.test");
    const bob = await createUser(gateway.base, admin.accessToken, "bob@enterprise.test");
    const aliceHost = await pair(gateway.base, alice.accessToken);
    const bobHost = await pair(gateway.base, bob.accessToken);
    let daemon = await connect(daemonPath(aliceHost.daemonToken));
    const bobDaemon = await connect(daemonPath(bobHost.daemonToken));
    let aliceClient = await connect(clientPath(alice.accessToken));
    const bobClient = await connect(clientPath(bob.accessToken));
    const aliceOther = await login(gateway.base, "alice@enterprise.test");
    const otherClient = await connect(clientPath(aliceOther.accessToken));

    aliceClient.ws.send(JSON.stringify({ type: "probe", hostId: aliceHost.hostId, id: 1 }));
    await waitUntil(() => daemon.messages.some((m) => m.type === "probe" && m.id === 1), "owner command was not forwarded");
    bobClient.ws.send(JSON.stringify({ type: "probe", hostId: aliceHost.hostId, id: 2 }));
    await waitUntil(() => bobClient.messages.some((m) => m.type === "error" && m.id === 2), "cross-user command was not rejected");
    expect(daemon.messages.some((m) => m.type === "probe" && m.id === 2)).toBe(false);
    daemon.ws.send(JSON.stringify({ type: "probe_result", id: 3 }));
    await waitUntil(() => aliceClient.messages.some((m) => m.id === 3), "daemon response was not forwarded");
    expect(bobClient.messages.some((m) => m.id === 3)).toBe(false);

    const sessions = await request(gateway.base, "/api/me/sessions", { token: alice.accessToken });
    const otherJti = sessions.data.sessions.find((s: any) => !s.current).jti;
    expect((await request(gateway.base, `/api/me/sessions/${otherJti}`, { token: alice.accessToken, method: "DELETE" })).response.status).toBe(200);
    await closed(otherClient.ws);
    expect(aliceClient.ws.readyState).toBe(WebSocket.OPEN);

    const rotated = await request(gateway.base, "/api/auth/refresh", { body: { refreshToken: alice.refreshToken } });
    expect(rotated.response.status).toBe(200);
    await closed(aliceClient.ws);
    aliceClient = await connect(clientPath(rotated.data.accessToken));
    const replay = await request(gateway.base, "/api/auth/refresh", { body: { refreshToken: alice.refreshToken } });
    expect(replay.response.status).toBe(401);
    await closed(aliceClient.ws);
    expect(daemon.ws.readyState).toBe(WebSocket.OPEN);

    alice = await login(gateway.base, "alice@enterprise.test");
    aliceClient = await connect(clientPath(alice.accessToken));
    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}/revoke-sessions`, { token: admin.accessToken, method: "POST" })).response.status).toBe(200);
    await closed(aliceClient.ws);
    expect(daemon.ws.readyState).toBe(WebSocket.OPEN);
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);

    alice = await login(gateway.base, "alice@enterprise.test");
    aliceClient = await connect(clientPath(alice.accessToken));
    const reset = await request(gateway.base, `/api/admin/users/${alice.user.id}/send-reset`, { token: admin.accessToken, method: "POST" });
    expect(reset.response.status).toBe(200);
    const resetToken = decodeURIComponent(String(reset.data.link).split("token=")[1]!);
    const failRevocation = new Database(path.join(gateway.dir, "gateway.db"));
    try {
      // A failed session write must roll back the password and reset token as
      // well; the original session should remain usable and connected.
      failRevocation.exec("CREATE TRIGGER test_revoke_failure BEFORE UPDATE OF revoked ON sessions BEGIN SELECT RAISE(ABORT, 'test revocation failure'); END");
      const failedReset = await request(gateway.base, "/api/auth/password-reset/confirm", { body: { token: resetToken, password: "another-password-456" } });
      expect(failedReset.response.status).toBe(500);
      expect((await login(gateway.base, "alice@enterprise.test")).user.id).toBe(alice.user.id);
      expect(aliceClient.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      failRevocation.exec("DROP TRIGGER IF EXISTS test_revoke_failure");
      failRevocation.close();
    }
    expect((await request(gateway.base, "/api/auth/password-reset/confirm", { body: { token: resetToken, password: testPassword } })).response.status).toBe(200);
    await closed(aliceClient.ws);
    expect(daemon.ws.readyState).toBe(WebSocket.OPEN);

    alice = await login(gateway.base, "alice@enterprise.test");
    aliceClient = await connect(clientPath(alice.accessToken));
    const pendingPair = await request(gateway.base, "/api/indirect-code/pair", { token: alice.accessToken, method: "POST" });
    const failBan = new Database(path.join(gateway.dir, "gateway.db"));
    try {
      failBan.exec("CREATE TRIGGER test_ban_failure BEFORE UPDATE OF revoked ON sessions BEGIN SELECT RAISE(ABORT, 'test revocation failure'); END");
      const rejected = await request(gateway.base, `/api/admin/users/${alice.user.id}`, { token: admin.accessToken, method: "PATCH", body: { status: "banned" } });
      expect(rejected.response.status).toBe(500);
      const userStatus = failBan.prepare<{ status: string }, [string]>("SELECT status FROM users WHERE id = ?");
      try { expect(userStatus.get(alice.user.id)?.status).toBe("active"); } finally { userStatus.finalize(); }
      expect(aliceClient.ws.readyState).toBe(WebSocket.OPEN);
      expect(daemon.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      failBan.exec("DROP TRIGGER IF EXISTS test_ban_failure");
      failBan.close();
    }
    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}`, { token: admin.accessToken, method: "PATCH", body: { status: "banned" } })).response.status).toBe(200);
    await Promise.all([closed(aliceClient.ws), closed(daemon.ws)]);
    expect(daemon.messages.some((m) => m.type === "shutdown")).toBe(false);
    expect((await fetch(`${gateway.base}${daemonPath(aliceHost.daemonToken)}`)).status).toBe(401);
    expect((await fetch(`${gateway.base}${clientPath(alice.accessToken)}`)).status).toBe(401);
    expect((await request(gateway.base, `/api/indirect-code/connect/${pendingPair.data.token}`, { body: { name: "late" } })).response.status).toBe(401);
    expect(bobDaemon.ws.readyState).toBe(WebSocket.OPEN);
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);

    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}`, { token: admin.accessToken, method: "PATCH", body: { status: "active" } })).response.status).toBe(200);
    alice = await login(gateway.base, "alice@enterprise.test");
    const hosts = await request(gateway.base, "/api/indirect-code/hosts", { token: alice.accessToken });
    expect(hosts.data.hosts.find((h: any) => h.id === aliceHost.hostId).status).toBe("offline");
    daemon = await connect(daemonPath(aliceHost.daemonToken));
    aliceClient = await connect(clientPath(alice.accessToken));
    expect((await request(gateway.base, `/api/admin/users/${alice.user.id}`, { token: admin.accessToken, method: "DELETE" })).response.status).toBe(200);
    await Promise.all([closed(aliceClient.ws), closed(daemon.ws)]);
    expect((await fetch(`${gateway.base}${daemonPath(aliceHost.daemonToken)}`)).status).toBe(401);
    expect(bobClient.ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    for (const ws of sockets) ws.close();
    await gateway.stop();
  }
}, 60000);

test("relay enforces sliding session expiry and keeps sessions extended by authenticated activity", async () => {
  const gateway = await startGateway();
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  const sockets: WebSocket[] = [];
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const user = await createUser(gateway.base, admin.accessToken, "expiry@enterprise.test");
    const jti = JSON.parse(Buffer.from(user.accessToken.split(".")[1]!, "base64url").toString()).jti;
    sql.run("UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE jti = ?", [Date.now() + 1500, Date.now() - 120_000, jti]);
    const kept = await socket(gateway.base, clientPath(user.accessToken)); sockets.push(kept.ws);
    expect((await request(gateway.base, "/api/me", { token: user.accessToken })).response.status).toBe(200);
    await Bun.sleep(1800);
    expect(kept.ws.readyState).toBe(WebSocket.OPEN);

    const expiring = await login(gateway.base, "expiry@enterprise.test");
    const expiringJti = JSON.parse(Buffer.from(expiring.accessToken.split(".")[1]!, "base64url").toString()).jti;
    sql.run("UPDATE sessions SET expires_at = ? WHERE jti = ?", [Date.now() + 800, expiringJti]);
    const short = await socket(gateway.base, clientPath(expiring.accessToken)); sockets.push(short.ws);
    await closed(short.ws);
    expect(kept.ws.readyState).toBe(WebSocket.OPEN);
    expect((await request(gateway.base, "/api/auth/logout", { token: user.accessToken, method: "POST" })).response.status).toBe(200);
    await closed(kept.ws);
  } finally {
    for (const ws of sockets) ws.close();
    sql.close();
    await gateway.stop();
  }
}, 40000);
