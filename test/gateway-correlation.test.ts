import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

/**
 * Audit coverage and request correlation.
 *
 * Two reported gaps:
 *  - changing a name through the profile endpoint worked but added no audit
 *    row (coverage was incomplete);
 *  - usage events carried no identifier equivalent to the x-request-id the
 *    proxy returned, so a customer could not quote a response and have an
 *    operator find the matching rows.
 */

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterAll(async () => {
  // Each test closes its own read-only handle; the gateway fixture then removes
  // the directory, which can still be briefly held by the OS on Windows.
  for (const gateway of gateways) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await gateway.stop(); break; }
      catch (error) { if (attempt === 4) throw error; await Bun.sleep(150); }
    }
  }
});

async function boot(env: Record<string, string> = {}, existingDir?: string) {
  const gateway = await startGateway(env, existingDir);
  gateways.push(gateway);
  return gateway;
}

function auditCount(gateway: Awaited<ReturnType<typeof startGateway>>, action: string): number {
  const sql = new Database(path.join(gateway.dir, "gateway.db"), { readonly: true });
  try {
    return (sql.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;
  } finally { sql.close(); }
}

test("a profile rename writes an audit row with the before and after values", async () => {
  const gateway = await boot();
  const admin = await login(gateway.base, "admin@enterprise.test");
  const user = await createUser(gateway.base, admin.accessToken, "rename@enterprise.test");

  const before = auditCount(gateway, "profile.updated");
  const renamed = await request(gateway.base, "/api/me", { token: user.accessToken, method: "PATCH", body: { name: "Renamed Person" } });
  expect(renamed.response.status).toBe(200);
  expect(renamed.data.user.name).toBe("Renamed Person");
  expect(auditCount(gateway, "profile.updated")).toBe(before + 1);

  const sql = new Database(path.join(gateway.dir, "gateway.db"), { readonly: true });
  try {
    const row = sql.prepare("SELECT actor_id, target, meta, request_id FROM audit_log WHERE action = 'profile.updated' ORDER BY id DESC LIMIT 1")
      .get() as { actor_id: string; target: string; meta: string; request_id: string | null };
    expect(row.actor_id).toBe(user.user.id);
    expect(row.target).toBe(user.user.id);
    expect(JSON.parse(row.meta)).toMatchObject({ field: "name", to: "Renamed Person" });
    // The audit row is correlated with the request that produced it.
    expect(row.request_id).toBeTruthy();
    expect(row.request_id).toBe(renamed.response.headers.get("x-request-id")!);
  } finally { sql.close(); }

  // A no-op rename must not manufacture an audit row.
  const unchanged = auditCount(gateway, "profile.updated");
  expect((await request(gateway.base, "/api/me", { token: user.accessToken, method: "PATCH", body: { name: "Renamed Person" } })).response.status).toBe(200);
  expect(auditCount(gateway, "profile.updated")).toBe(unchanged);
}, 60_000);

test("every response carries X-Request-Id and a client id is honoured only when well formed", async () => {
  const gateway = await boot();
  const admin = await login(gateway.base, "admin@enterprise.test");

  // A minted id appears on dashboard and proxy responses alike.
  const minted = await request(gateway.base, "/api/me", { token: admin.accessToken });
  const mintedId = minted.response.headers.get("x-request-id");
  expect(mintedId).toBeTruthy();
  expect(mintedId!.length).toBeGreaterThanOrEqual(8);

  const other = await request(gateway.base, "/api/me/financial-policy", { token: admin.accessToken });
  expect(other.response.headers.get("x-request-id")).not.toBe(mintedId);

  // A well-formed client id is honoured verbatim (that is what lets an SDK
  // correlate without a mapping table).
  const supplied = "sdk-req_2026.10.30-abc123";
  const echoed = await request(gateway.base, "/api/me", { token: admin.accessToken, headers: { "X-Request-Id": supplied } });
  expect(echoed.response.headers.get("x-request-id")).toBe(supplied);

  // A malformed id is REPLACED, never echoed: echoing it would put an
  // attacker-controlled string into a header and into every log line.
  // (A CR/LF cannot even be sent — fetch rejects it, which is the first line of
  // defence — so the cases here are the ones that DO reach the server.)
  for (const bad of ["short", "bad id with spaces", "x".repeat(200), "id;drop=1", "<script>"]) {
    const response = await request(gateway.base, "/api/me", { token: admin.accessToken, headers: { "X-Request-Id": bad } });
    const id = response.response.headers.get("x-request-id");
    expect(id).toBeTruthy();
    expect(id).not.toBe(bad);
    expect(/^[A-Za-z0-9._-]{8,128}$/.test(id!)).toBe(true);
  }
}, 60_000);

test("a proxy call persists the same id it returns to the client", async () => {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
    await req.json();
    return Response.json({ id: "test", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  const gateway = await boot();
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } })).response.status).toBe(200);
    const user = await createUser(gateway.base, admin.accessToken, "corr@enterprise.test");
    const made = await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "k" } });
    const key = made.data.token as string;

    const call = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
    });
    expect(call.status).toBe(200);
    await call.text();
    const header = call.headers.get("x-request-id");
    expect(header).toBeTruthy();

    // The usage ledger records the SAME id, so a quoted header finds its rows.
    const sql = new Database(path.join(gateway.dir, "gateway.db"), { readonly: true });
    try {
      let rows: Array<{ request_id: string }> = [];
      for (let attempt = 0; attempt < 80 && rows.length === 0; attempt++) {
        rows = sql.prepare("SELECT request_id FROM usage_events WHERE request_id != ''").all() as Array<{ request_id: string }>;
        if (rows.length === 0) await Bun.sleep(50);
      }
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.request_id === header)).toBe(true);
    } finally { sql.close(); }
  } finally {
    upstream.stop(true);
  }
}, 60_000);

test("reusing X-Request-Id across sequential, concurrent, cross-account, failed, aborted, and recovered proxy calls never collides with reservation PKs", async () => {
  let hits = 0;
  let failNext = false;
  let holdStream: (() => void) | null = null;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "GET") {
        return Response.json({
          data: [
            {
              id: "budgeted-mock",
              context_length: 32_000,
              top_provider: { max_completion_tokens: 1_000 },
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
          ],
        });
      }
      hits++;
      const body = (await req.json()) as { stream?: boolean };
      if (failNext) {
        failNext = false;
        return Response.json({ error: { message: "transient failure", type: "server_error" } }, { status: 500 });
      }
      if (body.stream) {
        const hold = holdStream;
        holdStream = null;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"s1","object":"chat.completion.chunk","model":"budgeted-mock","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
                ),
              );
              if (hold) {
                await new Promise<void>((resolve) => {
                  const prev = hold;
                  prev();
                  setTimeout(resolve, 250);
                });
              }
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"s1","object":"chat.completion.chunk","model":"budgeted-mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: `resp-${hits}`,
        model: "budgeted-mock",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });

  const gateway = await boot();
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const prov = await request(gateway.base, "/api/admin/providers", {
      token: admin.accessToken,
      body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" },
    });
    expect(prov.response.status).toBe(200);
    expect((await request(gateway.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "router" } })).response.status).toBe(200);

    const planRes = await request(gateway.base, "/api/admin/plans", {
      token: admin.accessToken,
      body: { name: "Budgeted", monthlyUsd: 50, weeklyEnabled: true },
    });
    expect(planRes.response.status).toBe(200);
    const planId = (planRes.data.plans as Array<{ id: string; name: string }>).find((p) => p.name === "Budgeted")!.id;

    const userA = await createUser(gateway.base, admin.accessToken, "corr-a@enterprise.test");
    const userB = await createUser(gateway.base, admin.accessToken, "corr-b@enterprise.test");
    for (const u of [userA, userB]) {
      expect((await request(gateway.base, `/api/admin/users/${u.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId } })).response.status).toBe(200);
    }

    const keyA = (await request(gateway.base, "/api/keys", { token: userA.accessToken, body: { name: "kA", dailyLimitUsd: 10 } })).data.token as string;
    const keyB = (await request(gateway.base, "/api/keys", { token: userB.accessToken, body: { name: "kB", dailyLimitUsd: 10 } })).data.token as string;

    const callProxy = (token: string, reqId: string, stream = false, signal?: AbortSignal) =>
      fetch(`${gateway.base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Request-Id": reqId,
        },
        body: JSON.stringify({ model: "budgeted-mock", stream, messages: [{ role: "user", content: "hello" }], max_tokens: 16 }),
        signal,
      });

    // 1. Sequential reuse of the exact same X-Request-Id.
    const seqId = "req-seq-collision-0001";
    const first = await callProxy(keyA, seqId);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-request-id")).toBe(seqId);
    await first.text();

    const second = await callProxy(keyA, seqId);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-request-id")).toBe(seqId);
    await second.text();
    expect(hits).toBe(2);

    // 2. Concurrent reuse (buffered + streaming) sharing one X-Request-Id.
    const concId = "req-concurrent-0002";
    const concResponses = await Promise.all([
      callProxy(keyA, concId, false),
      callProxy(keyA, concId, false),
      callProxy(keyA, concId, false),
      callProxy(keyA, concId, true),
      callProxy(keyA, concId, true),
      callProxy(keyA, concId, true),
    ]);
    for (const res of concResponses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBe(concId);
      await res.text();
    }
    expect(hits).toBe(8);

    // 3. Cross-account reuse of the same X-Request-Id.
    const sharedId = "req-cross-account-0003";
    const [resA, resB] = await Promise.all([callProxy(keyA, sharedId), callProxy(keyB, sharedId)]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.headers.get("x-request-id")).toBe(sharedId);
    expect(resB.headers.get("x-request-id")).toBe(sharedId);
    await resA.text();
    await resB.text();

    // 4. Upstream 500 failure releases reservation, and immediate retry with SAME X-Request-Id succeeds.
    const retryId = "req-retry-after-500";
    failNext = true;
    const failed = await callProxy(keyA, retryId);
    expect(failed.status).toBe(500);
    await failed.text();
    const retried = await callProxy(keyA, retryId);
    expect(retried.status).toBe(200);
    await retried.text();

    // 5. Mid-stream abort settles cleanly, and retry with SAME X-Request-Id succeeds.
    const abortId = "req-abort-then-retry";
    const ac = new AbortController();
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
    holdStream = opened;
    const inFlightAbort = callProxy(keyA, abortId, true, ac.signal).catch(() => null);
    await openedPromise;
    ac.abort();
    const maybeRes = await inFlightAbort;
    if (maybeRes?.body) await maybeRes.body.getReader().read().catch(() => null);
    await Bun.sleep(100);
    const afterAbort = await callProxy(keyA, abortId, false);
    expect(afterAbort.status).toBe(200);
    await afterAbort.text();

    // 6. Crash recovery (`recoverBudgets` on restart) settles stale pending reservation,
    // and a post-recovery retry with the SAME X-Request-Id succeeds with 200.
    const crashId = "req-crash-recover-0004";
    const keyRowId = (await request(gateway.base, "/api/keys", { token: userA.accessToken })).data.keys[0].id as string;
    await gateway.killOnly();
    const crashDb = new Database(path.join(gateway.dir, "gateway.db"));
    try {
      const sample = crashDb
        .prepare("SELECT periods, pricing FROM billing_reservations WHERE user_id = ? LIMIT 1")
        .get(userA.user.id) as { periods: string; pricing: string };
      const parsedPeriods = JSON.parse(sample.periods) as Array<{ scope: string; owner: string; kind: string; start: number }>;
      const holdAmount = 10_000;
      for (const p of parsedPeriods) {
        crashDb
          .prepare("UPDATE billing_periods SET reserved_nanos = reserved_nanos + ? WHERE scope = ? AND owner_id = ? AND kind = ? AND starts_at = ?")
          .run(holdAmount, p.scope, p.owner, p.kind, p.start);
      }
      crashDb
        .prepare(
          "INSERT INTO billing_reservations(id, request_id, instance_id, key_id, user_id, created_at, amount_nanos, periods, pricing, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
        )
        .run("stale_hold_pk_0001", crashId, "dead_instance_01", keyRowId, userA.user.id, Date.now() - 10 * 60_000, holdAmount, sample.periods, sample.pricing);
    } finally {
      crashDb.close();
    }

    const restarted = await boot({}, gateway.dir);
    const afterCrash = await fetch(`${restarted.base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyA}`,
        "Content-Type": "application/json",
        "X-Request-Id": crashId,
      },
      body: JSON.stringify({ model: "budgeted-mock", stream: false, messages: [{ role: "user", content: "recovered" }], max_tokens: 16 }),
    });
    expect(afterCrash.status).toBe(200);
    expect(afterCrash.headers.get("x-request-id")).toBe(crashId);
    await afterCrash.text();

    // Verify zero leaked reserved_nanos and distinct reservation PKs correlated by request_id.
    const sql = new Database(path.join(gateway.dir, "gateway.db"), { readonly: true });
    try {
      const pending = sql.prepare("SELECT COUNT(*) AS n FROM billing_reservations WHERE state = 'pending'").get() as { n: number };
      expect(pending.n).toBe(0);
      const reserved = sql.prepare("SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM billing_periods").get() as { n: number };
      expect(reserved.n).toBe(0);
      const seqReservations = sql
        .prepare("SELECT id, request_id, state FROM billing_reservations WHERE request_id = ?")
        .all(seqId) as Array<{ id: string; request_id: string; state: string }>;
      expect(seqReservations).toHaveLength(2);
      expect(seqReservations[0]!.id).not.toBe(seqReservations[1]!.id);
      expect(seqReservations[0]!.id).not.toBe(seqId);
      expect(seqReservations.every((r) => r.state === "settled")).toBe(true);

      const crashReservations = sql
        .prepare("SELECT id, request_id, state FROM billing_reservations WHERE request_id = ?")
        .all(crashId) as Array<{ id: string; request_id: string; state: string }>;
      expect(crashReservations).toHaveLength(2);
      expect(crashReservations.map((r) => r.state).sort()).toEqual(["recovered", "settled"]);
    } finally {
      sql.close();
    }
  } finally {
    upstream.stop(true);
  }
}, 90_000);

test("session mutations, 2fa setup, and logout emit correlated audit rows without leaking secrets", async () => {
  const gateway = await boot();
  const admin = await login(gateway.base, "admin@enterprise.test");
  const user = await createUser(gateway.base, admin.accessToken, "audit-me@enterprise.test");
  const secondLogin = await login(gateway.base, "audit-me@enterprise.test");

  const sessionsRes = await request(gateway.base, "/api/me/sessions", { token: user.accessToken });
  expect(sessionsRes.response.status).toBe(200);
  const currentSession = (sessionsRes.data.sessions as Array<{ jti: string; current: boolean }>).find((s) => s.current)!;
  const otherSession = (sessionsRes.data.sessions as Array<{ jti: string; current: boolean }>).find((s) => !s.current)!;

  // 1. Session label update -> session.updated
  const patchSession = await request(gateway.base, `/api/me/sessions/${currentSession.jti}`, {
    token: user.accessToken,
    method: "PATCH",
    headers: { "X-Request-Id": "req-session-patch-01" },
    body: { label: "Workstation" },
  });
  expect(patchSession.response.status).toBe(200);

  // 2. 2FA setup -> 2fa.setup (never leaks TOTP secret in audit_log)
  const setup2fa = await request(gateway.base, "/api/me/2fa/setup", {
    token: user.accessToken,
    method: "POST",
    headers: { "X-Request-Id": "req-2fa-setup-0001" },
    body: {},
  });
  expect(setup2fa.response.status).toBe(200);
  const secretValue = String(setup2fa.data.secret);
  expect(secretValue.length).toBeGreaterThan(10);

  // 3. Session revoke -> session.revoked
  const revokeOther = await request(gateway.base, `/api/me/sessions/${otherSession.jti}`, {
    token: user.accessToken,
    method: "DELETE",
    headers: { "X-Request-Id": "req-session-revoke-01" },
  });
  expect(revokeOther.response.status).toBe(200);

  // Revoked session token can no longer be used.
  expect((await request(gateway.base, "/api/me", { token: secondLogin.accessToken })).response.status).toBe(401);

  // 4. Logout -> logout
  const loggedOut = await request(gateway.base, "/api/auth/logout", {
    token: user.accessToken,
    method: "POST",
    headers: { "X-Request-Id": "req-user-logout-001" },
    body: {},
  });
  expect(loggedOut.response.status).toBe(200);

  const sql = new Database(path.join(gateway.dir, "gateway.db"), { readonly: true });
  try {
    const byReq = (reqId: string) =>
      sql.prepare("SELECT action, actor_id, target, meta, request_id FROM audit_log WHERE request_id = ?").get(reqId) as
        | { action: string; actor_id: string; target: string | null; meta: string | null; request_id: string }
        | null;

    expect(byReq("req-session-patch-01")).toMatchObject({
      action: "session.updated",
      actor_id: user.user.id,
      target: currentSession.jti,
    });
    const setupAudit = byReq("req-2fa-setup-0001");
    expect(setupAudit).toMatchObject({
      action: "2fa.setup",
      actor_id: user.user.id,
    });
    expect(JSON.stringify(setupAudit)).not.toContain(secretValue);
    expect(JSON.stringify(setupAudit)).not.toContain("otpauth://");

    expect(byReq("req-session-revoke-01")).toMatchObject({
      action: "session.revoked",
      actor_id: user.user.id,
      target: otherSession.jti,
    });
    expect(byReq("req-user-logout-001")).toMatchObject({
      action: "logout",
      actor_id: user.user.id,
      target: currentSession.jti,
    });
  } finally {
    sql.close();
  }
}, 60_000);

test("audit write failure rolls back local state mutations atomically and succeeds cleanly on retry", async () => {
  const gateway = await boot({ FINANCIAL_DEFAULT_BUDGET: "usd" });
  const admin = await login(gateway.base, "admin@enterprise.test");
  const employee = await createUser(gateway.base, admin.accessToken, "atomic-audit@enterprise.test");
  const createdKey = await request(gateway.base, "/api/keys", {
    token: employee.accessToken,
    body: { name: "original-key-name", dailyLimitUsd: 5 },
  });
  expect(createdKey.response.status).toBe(200);
  const keyId = createdKey.data.key.id as string;

  const sessionsRes = await request(gateway.base, "/api/me/sessions", { token: employee.accessToken });
  const currentJti = (sessionsRes.data.sessions as Array<{ jti: string; current: boolean }>).find((s) => s.current)!.jti;

  // Inject a real SQLite fault on audit_log inserts so any non-transactional
  // mutation would leave committed state behind when audit() aborts.
  const rw = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    rw.exec(`
      CREATE TRIGGER test_fail_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action IN (
        'financial_policy.user_updated',
        'financial_policy.installation_updated',
        'key.updated',
        'user.updated',
        'session.updated'
      )
      BEGIN
        SELECT RAISE(ABORT, 'simulated_audit_failure');
      END;
    `);
  } finally {
    rw.close();
  }

  // Every mutation below must fail AND roll back its primary state write.
  expect(
    (
      await request(gateway.base, `/api/admin/users/${employee.user.id}/financial-policy`, {
        token: admin.accessToken,
        method: "PATCH",
        body: { budgetPresentation: "hidden", showModelPrices: false },
      })
    ).response.status,
  ).toBe(500);
  expect((await request(gateway.base, "/api/me/financial-policy", { token: employee.accessToken })).data.policy).toMatchObject({
    budgetPresentation: "usd",
    showModelPrices: true,
    inherited: true,
  });

  expect(
    (
      await request(gateway.base, "/api/admin/financial-policy", {
        token: admin.accessToken,
        method: "PATCH",
        body: { budgetPresentation: "percent", showModelPrices: false },
      })
    ).response.status,
  ).toBe(500);
  expect((await request(gateway.base, "/api/admin/financial-policy", { token: admin.accessToken })).data.defaults).toEqual({
    budgetPresentation: "usd",
    showModelPrices: true,
  });

  expect(
    (
      await request(gateway.base, `/api/keys/${keyId}`, {
        token: employee.accessToken,
        method: "PATCH",
        body: { name: "mutated-without-audit" },
      })
    ).response.status,
  ).toBe(500);
  expect((await request(gateway.base, "/api/keys", { token: employee.accessToken })).data.keys[0].name).toBe("original-key-name");

  expect(
    (
      await request(gateway.base, `/api/admin/users/${employee.user.id}`, {
        token: admin.accessToken,
        method: "PATCH",
        body: { name: "Mutated Without Audit" },
      })
    ).response.status,
  ).toBe(500);
  expect((await request(gateway.base, "/api/me", { token: employee.accessToken })).data.user.name).toBe("atomic-audit@enterprise.test");

  expect(
    (
      await request(gateway.base, `/api/me/sessions/${currentJti}`, {
        token: employee.accessToken,
        method: "PATCH",
        body: { label: "Mutated Session" },
      })
    ).response.status,
  ).toBe(500);
  expect((await request(gateway.base, "/api/me/sessions", { token: employee.accessToken })).data.sessions[0].label).toBeNull();

  // Remove the injected fault: retrying the exact mutations now commits state + audit atomically.
  const rw2 = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    rw2.exec("DROP TRIGGER test_fail_audit;");
  } finally {
    rw2.close();
  }

  expect(
    (
      await request(gateway.base, `/api/admin/users/${employee.user.id}/financial-policy`, {
        token: admin.accessToken,
        method: "PATCH",
        body: { budgetPresentation: "hidden", showModelPrices: false },
      })
    ).response.status,
  ).toBe(200);
  expect((await request(gateway.base, "/api/me/financial-policy", { token: employee.accessToken })).data.policy).toMatchObject({
    budgetPresentation: "hidden",
    showModelPrices: false,
    inherited: false,
  });
}, 90_000);
