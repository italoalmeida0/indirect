import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { connect } from "node:net";
import path from "node:path";
import { createUser, login, request, startGateway, waitUntil } from "./gateway-enterprise-fixture";

/** The session bookkeeping update proves authentication ran before the body
 * finishes. No sleep or PBKDF2 timing assumption establishes the interleaving. */
async function delayedJson(base: string, sql: Database, token: string, route: string, body: unknown) {
  const jti = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).jti as string;
  sql.prepare("UPDATE sessions SET last_used_at=0 WHERE jti=?").run(jti);
  const text = JSON.stringify(body), url = new URL(base);
  const socket = connect(Number(url.port), url.hostname);
  let raw = "";
  const received = new Promise<string>((resolve, reject) => {
    socket.on("data", (chunk) => raw += chunk);
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });
  socket.setTimeout(10_000, () => socket.destroy(new Error("delayed request timed out")));
  socket.on("connect", () => socket.write(`PATCH ${route} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text.slice(0, 1)}`));
  try {
    await waitUntil(() => (sql.query<{ last_used_at: number }, [string]>("SELECT last_used_at FROM sessions WHERE jti=?").get(jti)?.last_used_at ?? 0) > 0, "delayed request did not authenticate");
  } catch (error) { socket.destroy(); throw error; }
  return {
    close: () => socket.destroy(),
    async finish() {
      socket.write(text.slice(1));
      const response = await received;
      return { status: Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1]), data: JSON.parse(response.split("\r\n\r\n")[1]!) as any };
    },
  };
}

test("a delayed administrator rename preserves later target bans and role changes and audits current values", async () => {
  const gateway = await startGateway({ SMTP_HOST: "" });
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  let pending: Awaited<ReturnType<typeof delayedJson>> | undefined;
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const employee = await createUser(gateway.base, admin.accessToken, "fresh-target@enterprise.test");
    const route = `/api/admin/users/${employee.user.id}`;
    pending = await delayedJson(gateway.base, sql, admin.accessToken, route, { name: "Renamed after ban" });
    expect((await request(gateway.base, route, { token: admin.accessToken, method: "PATCH", body: { status: "banned" } })).response.status).toBe(200);
    expect((await pending.finish()).status).toBe(200); pending.close(); pending = undefined;
    expect(sql.query("SELECT name,status,role FROM users WHERE id=?").get(employee.user.id)).toEqual({ name: "Renamed after ban", status: "banned", role: "user" });
    const banAudit = sql.query<{ meta: string }, [string]>("SELECT meta FROM audit_log WHERE action='user.updated' AND target=? ORDER BY id DESC LIMIT 1").get(employee.user.id)!;
    expect(JSON.parse(banAudit.meta)).toMatchObject({ before: { status: "banned", name: "fresh-target@enterprise.test" }, after: { status: "banned", name: "Renamed after ban" } });

    expect((await request(gateway.base, route, { token: admin.accessToken, method: "PATCH", body: { status: "active" } })).response.status).toBe(200);
    pending = await delayedJson(gateway.base, sql, admin.accessToken, route, { name: "Renamed after promotion" });
    expect((await request(gateway.base, route, { token: admin.accessToken, method: "PATCH", body: { role: "project_manager" } })).response.status).toBe(200);
    const manager = await login(gateway.base, "fresh-target@enterprise.test");
    expect((await pending.finish()).status).toBe(200); pending.close(); pending = undefined;
    expect(sql.query("SELECT enterprise_role FROM users WHERE id=?").get(employee.user.id)).toEqual({ enterprise_role: "project_manager" });
    expect((await request(gateway.base, "/api/me", { token: manager.accessToken })).response.status).toBe(200);
    const roleAudit = sql.query<{ meta: string }, [string]>("SELECT meta FROM audit_log WHERE action='user.updated' AND target=? ORDER BY id DESC LIMIT 1").get(employee.user.id)!;
    expect(JSON.parse(roleAudit.meta)).toMatchObject({ before: { role: "project_manager" }, after: { role: "project_manager" } });

    pending = await delayedJson(gateway.base, sql, admin.accessToken, route, { role: "user" });
    expect((await request(gateway.base, route, { token: admin.accessToken, method: "PATCH", body: { role: "admin" } })).response.status).toBe(200);
    const promoted = await login(gateway.base, "fresh-target@enterprise.test");
    expect((await pending.finish()).status).toBe(200); pending.close(); pending = undefined;
    expect((await request(gateway.base, "/api/me", { token: promoted.accessToken })).response.status).toBe(401);
    expect(sql.query("SELECT role,enterprise_role FROM users WHERE id=?").get(employee.user.id)).toEqual({ role: "user", enterprise_role: null });
  } finally { pending?.close(); sql.close(); await gateway.stop(); }
}, 60_000);

test("delayed authenticated mutations reject session revocation, bans and administrator demotion", async () => {
  const gateway = await startGateway({ SMTP_HOST: "" });
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  let pending: Awaited<ReturnType<typeof delayedJson>> | undefined;
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    for (const change of ["revoke", "ban", "demote"] as const) {
      let actor = await createUser(gateway.base, admin.accessToken, `pending-${change}@enterprise.test`);
      const target = await createUser(gateway.base, admin.accessToken, `target-${change}@enterprise.test`);
      if (change === "demote") {
        expect((await request(gateway.base, `/api/admin/users/${actor.user.id}`, { token: admin.accessToken, method: "PATCH", body: { role: "admin" } })).response.status).toBe(200);
        actor = await login(gateway.base, `pending-${change}@enterprise.test`);
      }
      const route = change === "demote" ? `/api/admin/users/${target.user.id}` : "/api/me";
      pending = await delayedJson(gateway.base, sql, actor.accessToken, route, { name: "Must not be written" });
      const edit = change === "revoke"
        ? await request(gateway.base, `/api/admin/users/${actor.user.id}/revoke-sessions`, { token: admin.accessToken, body: {} })
        : await request(gateway.base, `/api/admin/users/${actor.user.id}`, { token: admin.accessToken, method: "PATCH", body: change === "ban" ? { status: "banned" } : { role: "user" } });
      expect(edit.response.status).toBe(200);
      expect((await pending.finish()).status).toBe(401); pending.close(); pending = undefined;
      const changedId = change === "demote" ? target.user.id : actor.user.id;
      expect(sql.query<{ name: string }, [string]>("SELECT name FROM users WHERE id=?").get(changedId)!.name).not.toBe("Must not be written");
    }
  } finally { pending?.close(); sql.close(); await gateway.stop(); }
}, 60_000);
