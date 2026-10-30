import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { hashPassword, randomToken } from "../server/crypto";
import { createUser, login, request, startGateway, testPassword, waitUntil } from "./gateway-enterprise-fixture";

/** Wait until /api/ready reports at least `depth` requests parked in the
 *  admission queue (the queue is only observable through that endpoint). */
async function sitUntilQueue(base: string, depth: number, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    const ready = await request(base, "/api/ready");
    if (ready.data?.checks?.admission?.queued >= depth) return;
    if (Date.now() > end) throw new Error(`admission queue never reached ${depth} (saw ${ready.data?.checks?.admission?.queued})`);
    await Bun.sleep(20);
  }
}

test("account ceilings span keys, preserve capacity for other users, and leave stricter key caps effective", async () => {
  const held: Array<() => void> = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
    const body = await req.json() as any;
    if (body.__hold) await new Promise<void>((resolve) => held.push(resolve));
    return Response.json({ id: "test", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  // No admission wait: this test asserts the CEILINGS themselves, so a
  // request that finds one exhausted must be rejected at once, not queued.
  const gateway = await startGateway({ LIMIT_USER_RPM: "12", LIMIT_USER_CONCURRENCY: "4", LIMIT_GLOBAL_CONCURRENCY: "8", DEFAULT_KEY_CONCURRENCY: "2", LIMIT_ADMISSION_WAIT_MS: "1" });
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

test("default credential limits permit 40 simultaneous employees behind one office IP", async () => {
  const gateway = await startGateway();
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    const hash = await hashPassword(testPassword);
    const insert = sql.prepare("INSERT INTO users(id, email, name, role, password_hash, status, created_at) VALUES(?, ?, ?, 'user', ?, 'active', ?)");
    sql.transaction(() => {
      for (let i = 0; i < 40; i++) insert.run(randomToken(12), `office${i}@enterprise.test`, `Office ${i}`, hash, Date.now());
    })();
    insert.finalize();
    // One office egress: the 40 sign-ins arrive together with dashboard
    // polling (an open tab polls billing every 30s and workspace status every
    // 15s) already running through the SAME default buckets.
    const polling = Promise.all(Array.from({ length: 120 }, () => request(gateway.base, "/api/health")));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => request(gateway.base, "/api/auth/login", { body: { email: `office${i}@enterprise.test`, password: testPassword } })));
    expect(results.map((r) => r.response.status)).toEqual(Array(40).fill(200));
    expect((await polling).every((r) => r.response.status === 200)).toBe(true);
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
}, 90_000);

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
}, 90_000);

test("16 keys of one account cannot exceed the account ceiling while another account still gets through", async () => {
  const held: Array<() => void> = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
    const body = await req.json() as any;
    if (body.__hold) await new Promise<void>((resolve) => held.push(resolve));
    return Response.json({ id: "test", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  // Generous per-key, RPM and gateway room with a tight account ceiling: the
  // ONLY dimension that can deny the 13th concurrent call is the account.
  const gateway = await startGateway({
    LIMIT_USER_CONCURRENCY: "12",
    LIMIT_GLOBAL_CONCURRENCY: "64",
    DEFAULT_KEY_CONCURRENCY: "16",
    LIMIT_USER_RPM: "1000000",
    LIMIT_ADMISSION_WAIT_MS: "1",
  });
  const complete = (key: string, hold: boolean) => fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "test" }], max_tokens: 5, __hold: hold }),
  });
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } })).response.status).toBe(200);
    const alice = await createUser(gateway.base, admin.accessToken, "many-keys@enterprise.test");
    const bob = await createUser(gateway.base, admin.accessToken, "bystander@enterprise.test");
    const keys: string[] = [];
    for (let i = 0; i < 16; i++) {
      const made = await request(gateway.base, "/api/keys", { token: alice.accessToken, body: { name: `k${i}`, rpm: 1_000_000 } });
      expect(made.response.status).toBe(200);
      keys.push(made.data.token as string);
    }
    const bobKey = (await request(gateway.base, "/api/keys", { token: bob.accessToken, body: { name: "bob", rpm: 1_000_000 } })).data.token as string;

    // Saturate with exactly the account ceiling, one request per key.
    const pending = keys.slice(0, 12).map((key) => complete(key, true));
    await waitUntil(() => held.length === 12, `account ceiling admitted ${held.length} concurrent calls, expected 12`, 8000);

    // Every one of the account's 4 REMAINING keys — none of them busy, and
    // the gateway still has 52 free slots — is denied by the account
    // dimension alone, named in the error the client receives.
    for (const key of keys.slice(12)) {
      const denied = await complete(key, false);
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
      const deniedBody = await denied.json() as any;
      expect(deniedBody.error.type).toBe("rate_limit_error");
      expect(deniedBody.error.message).toContain("account");
    }
    expect(held.length).toBe(12);

    // A different account is unaffected by alice's saturation.
    const bobResult = await complete(bobKey, false);
    expect(bobResult.status).toBe(200);
    await bobResult.text();

    // Release the holders: every admitted request finishes and every slot
    // comes back, so other keys of the SAME account can burst again.
    held.splice(0).forEach((resolve) => resolve());
    for (const result of await Promise.all(pending)) { expect(result.status).toBe(200); await result.text(); }
    const again = keys.slice(4).map((key) => complete(key, true));
    await waitUntil(() => held.length === 12, "released slots were not reusable", 8000);
    held.splice(0).forEach((resolve) => resolve());
    for (const result of await Promise.all(again)) { expect(result.status).toBe(200); await result.text(); }
  } finally {
    held.splice(0).forEach((resolve) => resolve());
    await gateway.stop();
    upstream.stop(true);
  }
}, 90000);

test("the admission queue absorbs a burst inside the deadline and rejects beyond it", async () => {
  const held: Array<() => void> = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
    const body = await req.json() as any;
    if (body.__hold) await new Promise<void>((resolve) => held.push(resolve));
    return Response.json({ id: "test", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  // Two slots, a 600ms deadline and a queue of three.
  const gateway = await startGateway({
    LIMIT_USER_CONCURRENCY: "2",
    LIMIT_GLOBAL_CONCURRENCY: "2",
    DEFAULT_KEY_CONCURRENCY: "2",
    LIMIT_USER_RPM: "1000000",
    LIMIT_ADMISSION_WAIT_MS: "600",
    LIMIT_ADMISSION_QUEUE_MAX: "3",
  });
  const complete = (key: string, hold: boolean) => fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "test" }], max_tokens: 5, __hold: hold }),
  });
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } })).response.status).toBe(200);
    const user = await createUser(gateway.base, admin.accessToken, "queue@enterprise.test");
    const key = (await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "q", rpm: 1_000_000 } })).data.token as string;

    // Two holders occupy both slots; three waiters fill the queue.
    const holders = [complete(key, true), complete(key, true)];
    await waitUntil(() => held.length === 2, "both slots did not fill", 5000);
    const queued = [complete(key, false), complete(key, false), complete(key, false)];
    await sitUntilQueue(gateway.base, 3);

    // Observability: the queue depth is exposed while requests wait.
    const ready = await request(gateway.base, "/api/ready");
    expect(ready.response.status).toBe(200);
    expect(ready.data.checks.admission.queued).toBe(3);
    expect(ready.data.checks.admission.inFlight).toBe(2);

    // The 6th concurrent request overflows the hard queue cap and is rejected
    // immediately, without burning the wait deadline.
    const overflowStart = performance.now();
    const overflow = await complete(key, false);
    const overflowElapsed = performance.now() - overflowStart;
    expect(overflow.status).toBe(429);
    expect(Number(overflow.headers.get("retry-after"))).toBeGreaterThan(0);
    const overflowBody = await overflow.json() as any;
    expect(overflowBody.error.type).toBe("rate_limit_error");
    expect(overflowBody.error.message).toContain("queue");
    expect(overflowElapsed).toBeLessThan(500);

    // Freeing the slots releases the oldest waiters FIFO, which answer and
    // cascade the rest well inside the 600ms deadline: a burst that fits is
    // served, not rejected.
    const releasedAt = performance.now();
    held.splice(0).forEach((resolve) => resolve());
    for (const result of await Promise.all([...holders, ...queued])) {
      expect(result.status).toBe(200);
      await result.text();
    }
    expect(performance.now() - releasedAt).toBeLessThan(600);

    // Past the deadline the same request is rejected with Retry-After: hold
    // every slot, enqueue one waiter and let its deadline expire.
    const blocking = [complete(key, true), complete(key, true)];
    await waitUntil(() => held.length === 2, "slots did not refill", 5000);
    const lateStart = performance.now();
    const timedOut = await complete(key, false);
    const elapsed = performance.now() - lateStart;
    expect(timedOut.status).toBe(429);
    expect(Number(timedOut.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await timedOut.json() as any).error.message).toContain("concurrency");
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(5000);
    held.splice(0).forEach((resolve) => resolve());
    for (const result of await Promise.all(blocking)) { expect(result.status).toBe(200); await result.text(); }

    // Every waiter left the queue: nothing leaked after the drain.
    const drained = await request(gateway.base, "/api/ready");
    expect(drained.data.checks.admission.queued).toBe(0);
  } finally {
    held.splice(0).forEach((resolve) => resolve());
    await gateway.stop();
    upstream.stop(true);
  }
}, 90000);

test("health and readiness are never rate limited under a saturated IP bucket", async () => {
  // A tiny shared bucket: three requests exhaust it, every later one is 429 —
  // except the two probe endpoints, which must always answer.
  const gateway = await startGateway({ LIMIT_IP_PER_MIN: "3" });
  try {
    for (let i = 0; i < 3; i++) expect((await request(gateway.base, "/api/absent")).response.status).toBe(401);
    const saturated = await request(gateway.base, "/api/absent");
    expect(saturated.response.status).toBe(429);
    expect(Number(saturated.response.headers.get("retry-after"))).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) {
      const health = await request(gateway.base, "/api/health");
      expect(health.response.status).toBe(200);
      expect(health.data.ok).toBe(true);
      expect(typeof health.data.ts).toBe("number");
    }
    for (let i = 0; i < 10; i++) {
      const ready = await request(gateway.base, "/api/ready");
      expect(ready.response.status).toBe(200);
      expect(ready.data.ok).toBe(true);
      expect(ready.data.checks.db).toBe(true);
      expect(typeof ready.data.checks.admission.queued).toBe("number");
      expect(typeof ready.data.checks.admission.inFlight).toBe("number");
    }
    // The probes never refill the shared bucket: normal routes stay limited.
    expect((await request(gateway.base, "/api/absent")).response.status).toBe(429);

    // A proxy 429 keeps the client protocol envelope and Retry-After.
    for (const [route, anthropic] of [["/openai/v1/chat/completions", false], ["/anthropic/v1/messages", true]] as const) {
      const limited = await request(gateway.base, route, { method: "POST", body: {} });
      expect(limited.response.status).toBe(429);
      expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(limited.data.error.type).toBe("rate_limit_error");
      expect(limited.data.type).toBe(anthropic ? "error" : undefined);
    }
  } finally { await gateway.stop(); }
}, 60000);

test("the admission queue never leaks a slot after aborts, errors or stream ends", async () => {
  const gates: Array<() => void> = [];
  const encoder = new TextEncoder();
  let failNext = false;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
    const body = await req.json() as any;
    if (failNext) return Response.json({ error: { message: "upstream exploded", type: "server_error", code: null } }, { status: 500 });
    if (body.stream) {
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "s", model: "mock", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`));
          await new Promise<void>((resolve) => gates.push(resolve));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "s", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (body.__hold) await new Promise<void>((resolve) => gates.push(resolve));
    return Response.json({ id: "test", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  // ONE slot for the whole account: any leak is immediately observable.
  const gateway = await startGateway({
    LIMIT_USER_CONCURRENCY: "1",
    LIMIT_GLOBAL_CONCURRENCY: "8",
    DEFAULT_KEY_CONCURRENCY: "1",
    LIMIT_USER_RPM: "1000000",
    LIMIT_ADMISSION_WAIT_MS: "1",
  });
  const complete = (key: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) => fetch(`${gateway.base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "test" }], max_tokens: 5, ...extra }),
    signal,
  });
  const expectDenied = async (key: string) => {
    const denied = await complete(key);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    await denied.text();
  };
  // The single slot is back when a plain request succeeds.
  const expectFree = async (key: string) => {
    for (let i = 0; i < 80; i++) {
      const probe = await complete(key);
      const status = probe.status;
      await probe.text();
      if (status === 200) return;
      expect(status).toBe(429);
      await Bun.sleep(20);
    }
    throw new Error("the concurrency slot was never released");
  };
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } })).response.status).toBe(200);
    const user = await createUser(gateway.base, admin.accessToken, "leak@enterprise.test");
    const key = (await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "leak", rpm: 1_000_000 } })).data.token as string;

    // 1. Client abort while the request is in flight.
    const controller = new AbortController();
    const aborted = complete(key, { __hold: true }, controller.signal).catch(() => null);
    await waitUntil(() => gates.length === 1, "the aborted request never reached the upstream", 5000);
    await expectDenied(key);
    controller.abort();
    expect(await aborted).toBeNull();
    await expectFree(key);

    // 2. Upstream error: the admitted request fails, the slot still returns.
    failNext = true;
    const failed = await complete(key);
    expect(failed.status).toBe(500);
    await failed.text();
    failNext = false;
    await expectFree(key);

    // 3. A stream holds the slot until it ENDS, then releases it.
    const streamed = await complete(key, { stream: true });
    expect(streamed.status).toBe(200);
    const reader = streamed.body!.getReader();
    const chunks: string[] = [];
    const first = await reader.read();
    if (first.value) chunks.push(new TextDecoder().decode(first.value));
    // The stream is mid-flight: the single account slot is held.
    await expectDenied(key);
    gates.splice(0).forEach((resolve) => resolve());
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join("")).toContain("[DONE]");
    await expectFree(key);

    // 4. Client disconnect mid-stream: the pump releases the slot too. Hold
    // the upstream between bytes so the abort lands while the body is open.
    gates.length = 0;
    const disconnect = new AbortController();
    const streaming = complete(key, { stream: true }, disconnect.signal).catch(() => null);
    await waitUntil(() => gates.length === 1, "the stream never opened", 5000);
    await expectDenied(key);
    disconnect.abort();
    // Either the fetch itself rejects (headers not consumed yet) or the body
    // read fails; both prove the client walked away mid-stream.
    const abandoned = await streaming;
    if (abandoned) expect(() => abandoned.body!.getReader().read()).not.toThrow();
    gates.splice(0).forEach((resolve) => resolve());
    await expectFree(key);

    // Nothing is left in flight or queued at the end.
    const finalReady = await request(gateway.base, "/api/ready");
    expect(finalReady.data.checks.admission.inFlight).toBe(0);
    expect(finalReady.data.checks.admission.queued).toBe(0);
  } finally {
    gates.splice(0).forEach((resolve) => resolve());
    await gateway.stop();
    upstream.stop(true);
  }
}, 90000);

