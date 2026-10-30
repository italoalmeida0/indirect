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

async function boot() {
  const gateway = await startGateway();
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
