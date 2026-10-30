import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { hashPassword, randomToken } from "../server/crypto";
import { createUser, login, request, startGateway, testPassword, waitUntil } from "./gateway-enterprise-fixture";

test("account ceilings span keys, preserve capacity for other users, and leave stricter key caps effective", async () => {
  const held: Array<() => void> = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
    const body = await req.json() as any;
    if (body.__hold) await new Promise<void>((resolve) => held.push(resolve));
    return Response.json({ id: "test", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  const gateway = await startGateway({ LIMIT_USER_RPM: "12", LIMIT_USER_CONCURRENCY: "4", LIMIT_GLOBAL_CONCURRENCY: "8", DEFAULT_KEY_CONCURRENCY: "2" });
  const createKey = async (token: string, name: string, rpm = 1_000_000) => {
    const r = await request(gateway.base, "/api/keys", { token, body: { name, rpm } });
    expect(r.response.status).toBe(200);
    return r.data as { token: string; key: { id: string } };
  };
  const complete = async (key: string, hold = false, signal?: AbortSignal) => fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "test" }], max_tokens: 5, __hold: hold }),
    signal,
  });
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const provider = await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } });
    expect(provider.response.status).toBe(200);
    const alice = await createUser(gateway.base, admin.accessToken, "limits-alice@enterprise.test");
    const bob = await createUser(gateway.base, admin.accessToken, "limits-bob@enterprise.test");
    const a = await createKey(alice.accessToken, "a");
    const b = await createKey(alice.accessToken, "b");
    const other = await createKey(bob.accessToken, "other");

    const controller = new AbortController();
    const cancelled = complete(a.token, true, controller.signal).catch(() => null);
    const pending = [complete(a.token, true)];
    await waitUntil(() => held.length === 2, "first two requests did not reach the upstream");
    const keyLimited = await complete(a.token);
    expect(keyLimited.status).toBe(429);
    expect(Number(keyLimited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await keyLimited.json() as any).error.message).toContain("key");

    pending.push(complete(b.token, true), complete(b.token, true));
    await waitUntil(() => held.length === 4, "second key did not reach the upstream");
    const accountLimited = await complete(b.token);
    expect(accountLimited.status).toBe(429);
    expect(Number(accountLimited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await accountLimited.json() as any).error.message).toContain("account");
    const bobResult = await complete(other.token);
    expect(bobResult.status).toBe(200);
    await bobResult.text();
    controller.abort();
    expect(await cancelled).toBeNull();
    await Bun.sleep(100);
    const afterCancel = await complete(a.token);
    expect(afterCancel.status).toBe(200);
    await afterCancel.text();
    held.splice(0).forEach((resolve) => resolve());
    for (const result of await Promise.all(pending)) { expect(result.status).toBe(200); await result.text(); }
    const afterRelease = await complete(a.token);
    expect(afterRelease.status).toBe(200);
    await afterRelease.text();

    const rateUser = await createUser(gateway.base, admin.accessToken, "rpm@enterprise.test");
    const rateA = await createKey(rateUser.accessToken, "rate-a");
    const rateB = await createKey(rateUser.accessToken, "rate-b");
    for (let i = 0; i < 12; i++) {
      const result = await complete(i % 2 ? rateA.token : rateB.token);
      expect(result.status).toBe(200);
      await result.text();
    }
    const anthro = await fetch(`${gateway.base}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": rateB.token, "Content-Type": "application/json" }, body: JSON.stringify({ model: "mock", messages: [] }) });
    expect(anthro.status).toBe(429);
    expect(Number(anthro.headers.get("retry-after"))).toBeGreaterThan(0);
    const anthroBody = await anthro.json() as any;
    expect(anthroBody.type).toBe("error");
    expect(anthroBody.error.type).toBe("rate_limit_error");
    expect((await request(gateway.base, `/api/keys/${rateA.key.id}`, { token: rateUser.accessToken, method: "PATCH", body: { rpm: 1_000_000 } })).response.status).toBe(200);
    const stillLimited = await complete(rateA.token);
    expect(stillLimited.status).toBe(429);
    await stillLimited.text();

    const narrowUser = await createUser(gateway.base, admin.accessToken, "narrow@enterprise.test");
    const narrow = await createKey(narrowUser.accessToken, "narrow", 1);
    let result = await complete(narrow.token); expect(result.status).toBe(200); await result.text();
    result = await complete(narrow.token); expect(result.status).toBe(429); expect(Number(result.headers.get("retry-after"))).toBeGreaterThan(0); await result.text();
    expect((await request(gateway.base, `/api/keys/${narrow.key.id}`, { token: narrowUser.accessToken, method: "PATCH", body: { rpm: 2 } })).response.status).toBe(200);
    result = await complete(narrow.token); expect(result.status).toBe(200); await result.text();
    expect((await request(gateway.base, `/api/keys/${narrow.key.id}`, { token: narrowUser.accessToken, method: "PATCH", body: { rpm: 1 } })).response.status).toBe(200);
    result = await complete(narrow.token); expect(result.status).toBe(429); await result.text();
  } finally {
    held.splice(0).forEach((resolve) => resolve());
    await gateway.stop();
    upstream.stop(true);
  }
}, 60000);

test("default credential limits permit 40 distinct employees behind one office IP", async () => {
  const gateway = await startGateway();
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    const hash = await hashPassword(testPassword);
    const insert = sql.prepare("INSERT INTO users(id, email, name, role, password_hash, status, created_at) VALUES(?, ?, ?, 'user', ?, 'active', ?)");
    sql.transaction(() => {
      for (let i = 0; i < 40; i++) insert.run(randomToken(12), `office${i}@enterprise.test`, `Office ${i}`, hash, Date.now());
    })();
    insert.finalize();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => request(gateway.base, "/api/auth/login", { body: { email: `office${i}@enterprise.test`, password: testPassword } })));
    expect(results.map((r) => r.response.status)).toEqual(Array(40).fill(200));
    const errors = await Promise.all(Array.from({ length: 51 }, (_, i) => request(gateway.base, "/api/auth/login", { body: { email: `unknown${i}@enterprise.test`, password: "wrong-password" } })));
    expect(errors.every((r) => r.response.status === 401)).toBe(true);
    expect((await login(gateway.base, "office0@enterprise.test")).user.id).toBeTruthy();
  } finally {
    sql.close();
    await gateway.stop();
  }
}, 60000);

test("forwarded addresses require an explicitly trusted peer and a trusted hop chain", async () => {
  const gateway = await startGateway({ TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128,10.0.0.0/8", LIMIT_IP_PER_MIN: "2" });
  try {
    const get = (forwarded: string, route = "/api/absent") => request(gateway.base, route, { headers: { "X-Forwarded-For": forwarded } });
    expect((await get("1.1.1.1, 192.0.2.9, 10.0.0.1")).response.status).toBe(401);
    expect((await get("1.1.1.2, 192.0.2.9, 10.0.0.1")).response.status).toBe(401);
    const blocked = await get("1.1.1.3, 192.0.2.9, 10.0.0.1");
    expect(blocked.response.status).toBe(429);
    expect(Number(blocked.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get("198.51.100.1, 10.0.0.1")).response.status).toBe(401);
    expect((await get("198.51.100.2, 10.0.0.1")).response.status).toBe(401);
    // Invalid chains cannot fall back to an attacker-controlled leftmost IP.
    expect((await get("fe80::1%eth0")).response.status).toBe(401);
    expect((await get("203.0.113.2, invalid")).response.status).toBe(401);
    expect((await get("203.0.113.3, invalid")).response.status).toBe(429);
    for (let i = 0; i < 4; i++) expect((await get("1.1.1.1, 192.0.2.9, 10.0.0.1", "/api/health")).response.status).toBe(200);
  } finally { await gateway.stop(); }
}, 40000);

test("untrusted peers cannot spoof buckets, and early proxy 429s use protocol envelopes", async () => {
  const direct = await startGateway({ TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "10.0.0.0/8", LIMIT_IP_PER_MIN: "2" });
  try {
    for (const ip of ["198.51.100.1", "198.51.100.2"]) expect((await request(direct.base, "/api/absent", { headers: { "X-Forwarded-For": ip } })).response.status).toBe(401);
    const blocked = await request(direct.base, "/api/absent", { headers: { "X-Forwarded-For": "198.51.100.3" } });
    expect(blocked.response.status).toBe(429);
    expect(Number(blocked.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await request(direct.base, "/api/health")).response.status).toBe(200);
  } finally { await direct.stop(); }

  const proxy = await startGateway({ TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128", LIMIT_IP_PER_MIN: "1" });
  try {
    for (const [route, ip, anthropic] of [["/v1/chat/completions", "192.0.2.1", false], ["/v1/messages", "192.0.2.2", true], ["/anthropic/v1/messages", "192.0.2.3", true], ["/openai/v1/responses", "192.0.2.4", false]] as const) {
      const options = { method: "POST", headers: { "X-Forwarded-For": ip } };
      expect((await request(proxy.base, route, options)).response.status).toBe(401);
      const limited = await request(proxy.base, route, options);
      expect(limited.response.status).toBe(429);
      expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(limited.data.error.type).toBe("rate_limit_error");
      expect(limited.data.type).toBe(anthropic ? "error" : undefined);
    }
  } finally { await proxy.stop(); }
}, 60000);

test("an empty CIDR prefix is rejected at startup", async () => {
  await expect(startGateway({ TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "127.0.0.1/" })).rejects.toThrow("Invalid TRUSTED_PROXY_CIDRS entry");
}, 40000);
