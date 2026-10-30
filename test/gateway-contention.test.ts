import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway, testPassword, waitUntil } from "./gateway-enterprise-fixture";

test("a long external SQLite writer does not crash or freeze the gateway and queued usage is retained", async () => {
  let upstreamHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
    upstreamHits++;
    return Response.json({ id: "test", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  const gateway = await startGateway();
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  let locked = false;
  const scalar = (statement: string) => {
    const query = sql.prepare<{ value: number }, []>(statement);
    try { return query.get()!.value; } finally { query.finalize(); }
  };
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } })).response.status).toBe(200);
    const user = await createUser(gateway.base, admin.accessToken, "locked@enterprise.test");
    const made = await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "key" } });
    const key = made.data.token as string;
    const send = () => fetch(`${gateway.base}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "test" }], max_tokens: 5 }),
    });
    const first = await send(); expect(first.status).toBe(200); await first.text();
    expect(upstreamHits).toBe(1);
    sql.exec("BEGIN IMMEDIATE"); locked = true;
    const initialHeartbeat = scalar("SELECT MAX(heartbeat) AS value FROM billing_instances");
    const blocked = await send();
    expect(blocked.status).toBe(503);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json() as any).error.type).toBe("api_error");
    expect(upstreamHits).toBe(1);
    const blockedLogin = await request(gateway.base, "/api/auth/login", { body: { email: "locked@enterprise.test", password: testPassword } });
    expect(blockedLogin.response.status).toBe(503);
    expect(Number(blockedLogin.response.headers.get("retry-after"))).toBeGreaterThan(0);

    // Cover at least one 15-second billing heartbeat and several usage
    // flush retries while measuring whether the event loop stays responsive.
    const end = Date.now() + 17_000;
    let longest = 0;
    while (Date.now() < end) {
      const started = performance.now();
      const health = await fetch(`${gateway.base}/api/health`);
      expect(health.status).toBe(200);
      await health.text();
      longest = Math.max(longest, performance.now() - started);
      await Bun.sleep(100);
    }
    expect(longest).toBeLessThan(1000);
    expect(gateway.proc.exitCode).toBeNull();
    expect(scalar("SELECT COUNT(*) AS value FROM usage_events")).toBe(0);
    sql.exec("COMMIT"); locked = false;
    await waitUntil(() => scalar("SELECT COUNT(*) AS value FROM usage_events") === 1, "usage was not retried after releasing the lock", 8000);
    await waitUntil(() => scalar("SELECT MAX(heartbeat) AS value FROM billing_instances") > initialHeartbeat, "billing heartbeat did not recover", 18_000);
    const after = await send(); expect(after.status).toBe(200); await after.text();
    expect(upstreamHits).toBe(2);
  } finally {
    if (locked) sql.exec("ROLLBACK");
    sql.close();
    await gateway.stop();
    upstream.stop(true);
  }
}, 70000);
