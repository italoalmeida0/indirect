import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findFreePort } from "./free-port";
import { removeUsdMigration } from "./billing-fixture";

let server: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof Bun.spawn>;
let dir: string, base: string, admin: string, user: string, userId: string;
let sql: Database;
let planId: string, key: string, keyId: string;
let hits = 0;
const password = "billing-test-password-123";
const request = async (route: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any, headers: response.headers };
};
const llm = async (token = key, extra: Record<string, unknown> = {}, route = "/v1/chat/completions") => {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "billing-model", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, ...extra }) });
  return { status: response.status, text: await response.text(), headers: response.headers };
};
const status = async () => (await request("/api/billing", user)).data.billing;
const setPlan = async (id: string | null) => request(`/api/admin/users/${userId}/billing`, admin, { planId: id }, "PATCH");
const clearSpend = () => sql.run("UPDATE billing_periods SET spent_nanos = 0, forgiven_nanos = 0 WHERE owner_id IN (?, ?)", [userId, keyId]);

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "indirect-usd-"));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "billing-model", context_length: 100000, top_provider: { max_completion_tokens: 1000 }, pricing: { prompt: "0.000001", completion: "0.000003", input_cache_reads: "0.0000001", input_cache_writes: "0.000002" } }] });
    const body = await req.json() as any;
    hits++;
    if (body.__delay) await Bun.sleep(body.__delay);
    if (body.__fail) return Response.json({ error: { message: "bad request", type: "invalid_request_error" } }, { status: 400 });
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 100 });
    if (url.pathname.endsWith("/responses")) {
      const response = { id: "resp_test", model: "billing-model", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] }], usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 } } };
      if (body.stream) return new Response(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      return Response.json(response);
    }
    if (url.pathname.endsWith("/messages") && body.stream) return new Response(`event: message_start\ndata: {"message":{"id":"msg_test","model":"billing-model","usage":{"input_tokens":60,"cache_read_input_tokens":30,"cache_creation_input_tokens":10}}}\n\nevent: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30,"output_tokens_details":{"thinking_tokens":10}}}\n\nevent: message_stop\ndata: {}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    if (url.pathname.endsWith("/messages")) return Response.json({ id: "msg_test", model: "billing-model", type: "message", role: "assistant", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { input_tokens: 60, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 30 } });
    const usage = body.__allCached ? { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } : { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: body.__reasonOnly ? 30 : 10 } };
    if (body.stream) return new Response(`data: ${JSON.stringify({ id: "chat_test", model: "billing-model", choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat_test", model: "billing-model", choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ id: "chat_test", model: "billing-model", choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage });
  } });
  const port = await findFreePort(); base = `http://127.0.0.1:${port}`;
  gateway = Bun.spawn([process.execPath, "server/index.ts"], { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, DATA_DIR: dir, PORT: String(port), NODE_ENV: "test", ADMIN_EMAIL: "billing-admin@example.com", ADMIN_PASSWORD: password, GATEWAY_SECRET: "b".repeat(64) }, stdout: "ignore", stderr: "inherit" });
  const deadline = Date.now() + 20000;
  while (true) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error("Billing gateway did not start"); await Bun.sleep(100); }
  admin = (await request("/api/auth/login", "", { email: "billing-admin@example.com", password })).data.accessToken;
  const made = await request("/api/admin/users", admin, { email: "billing-user@example.com", name: "Billing User", sendInvite: true });
  userId = made.data.user.id;
  const invite = decodeURIComponent(made.data.invite.link.split("token=")[1]);
  await request("/api/auth/password-reset/confirm", "", { token: invite, password });
  user = (await request("/api/auth/login", "", { email: "billing-user@example.com", password })).data.accessToken;
  const provider = await request("/api/admin/providers", admin, { name: "Billing provider", openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`, anthropicBaseUrl: `http://127.0.0.1:${server.port}/v1`, responsesBaseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "sk-billing-test" });
  await request(`/api/admin/providers/${provider.data.provider.id}/sync-models`, admin, {});
  const created = await request("/api/keys", user, { name: "Billing key" }); key = created.data.token; keyId = created.data.key.id;
  sql = new Database(path.join(dir, "gateway.db")); sql.exec("PRAGMA busy_timeout = 5000");
}, 90_000);

afterAll(async () => { sql?.close(); gateway?.kill(); if (gateway) await gateway.exited; server?.stop(true); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("USD plans and enforcement over HTTP", () => {
  test("monthly is the default, every administrative route rejects a regular user", async () => {
    const created = await request("/api/admin/plans", admin, { name: "Pro", monthlyUsd: 100 });
    expect(created.status).toBe(200); planId = created.data.plans[0].id;
    expect(created.data.plans[0].weeklyEnabled).toBe(false); expect(created.data.plans[0].sessionEnabled).toBe(false);
    expect((await setPlan(planId)).status).toBe(200);
    expect((await status()).windows.map((w: any) => w.kind)).toEqual(["monthly"]);
    expect((await request("/api/admin/plans", user)).status).toBe(403);
    expect((await request("/api/admin/plans", user, { name: "Free", monthlyUsd: null })).status).toBe(403);
    expect((await request(`/api/admin/users/${userId}/billing`, user, { planId: null }, "PATCH")).status).toBe(403);
    expect((await request(`/api/admin/users/${userId}/resets`, user, { kind: "both", count: 100 })).status).toBe(403);
  });
  test("all billable categories settle immediately and model price changes never rewrite history", async () => {
    clearSpend(); const result = await llm(); expect(result.status).toBe(200);
    const reqHeader = result.headers.get("x-request-id")!;
    const receipt = sql.query<any, [string]>("SELECT id, request_id, state, pricing FROM billing_reservations WHERE request_id = ?").get(reqHeader);
    expect(receipt.id).not.toBe(reqHeader);
    expect(receipt.state).toBe("settled"); expect(JSON.parse(receipt.pricing).model).toBe("billing-model");
    expect((await status()).windows[0].spentUsd).toBeCloseTo(.000154, 9);
    expect((await request("/api/keys", user)).data.keys[0].spendTotalUsd).toBeCloseTo(.000154, 9);
    await request("/api/admin/models/billing-model", admin, { pricing: { prompt: .000002, completion: .000006, input_cache_reads: .0000002, input_cache_writes: .000004 } }, "PATCH");
    expect((await status()).windows[0].spentUsd).toBeCloseTo(.000154, 9);
    let event: any;
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(100);
      event = sql.query<any, [string]>("SELECT cost_in_nanos, cost_cache_nanos, cost_out_nanos FROM usage_events WHERE key_id = ? ORDER BY id DESC LIMIT 1").get(keyId);
      if (event) break;
    }
    expect(event).toEqual({ cost_in_nanos: 60000, cost_cache_nanos: 4000, cost_out_nanos: 90000 });
    await request("/api/admin/models/billing-model", admin, { pricing: { prompt: .000001, completion: .000003, input_cache_reads: .0000001, input_cache_writes: .000002 } }, "PATCH");
  });
  test("streamed all-cached input is not charged a second time as fresh input", async () => {
    clearSpend(); const result = await llm(key, { stream: true, __allCached: true }); expect(result.status).toBe(200);
    expect((await status()).windows[0].spentUsd).toBeCloseTo(.000100, 9);
    expect(result.text).toContain("cache=100");
  });
  test("Anthropic cache creation uses its write price and free token counting does not spend", async () => {
    clearSpend(); expect((await llm(key, {}, "/anthropic/v1/messages")).status).toBe(200);
    expect((await status()).windows[0].spentUsd).toBeCloseTo(.000173, 9);
    expect((await llm(key, {}, "/anthropic/v1/messages/count_tokens")).status).toBe(200);
    expect((await status()).windows[0].spentUsd).toBeCloseTo(.000173, 9);
  });
  test("reasoning costs are consistent on buffered and streamed native protocols", async () => {
    for (const stream of [false, true]) {
      clearSpend(); expect((await llm(key, { stream, __reasonOnly: true })).status).toBe(200);
      expect((await status()).windows[0].spentUsd).toBeCloseTo(.000154, 9);
      clearSpend(); expect((await llm(key, { stream }, "/anthropic/v1/messages")).status).toBe(200);
      expect((await status()).windows[0].spentUsd).toBeCloseTo(.000173, 9);
      clearSpend(); expect((await llm(key, { stream, messages: undefined, input: "Hi", max_tokens: undefined, max_output_tokens: 64 }, "/v1/responses")).status).toBe(200);
      expect((await status()).windows[0].spentUsd).toBeCloseTo(.000154, 9);
    }
  });
  test("a parallel burst across different keys cannot reserve beyond the shared account ceiling", async () => {
    clearSpend(); await request(`/api/admin/plans/${planId}`, admin, { monthlyUsd: .02 }, "PATCH");
    const other = (await request("/api/keys", user, { name: "Second key" })).data.token;
    const before = hits;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => llm(i % 2 ? key : other, { __delay: 500 })));
    const accepted = results.filter((r) => r.status === 200).length;
    expect(accepted).toBeGreaterThan(0); expect(accepted).toBeLessThanOrEqual(2); expect(hits - before).toBe(accepted);
    expect(results.some((r) => r.status === 429 && Number(r.headers.get("retry-after")) > 0)).toBe(true);
    expect((await status()).windows[0].reservedUsd).toBe(0);
    expect((await status()).windows[0].spentUsd).toBeLessThanOrEqual(.02);
    await request(`/api/admin/plans/${planId}`, admin, { monthlyUsd: 100, weeklyEnabled: true, sessionEnabled: true }, "PATCH");
  });
  test("key USD limits are independent, include input/cache, reject legacy names and validate amounts", async () => {
    const tiny = await request("/api/keys", user, { name: "Tiny USD", dailyLimitUsd: .001 });
    expect(tiny.status).toBe(200); expect((await llm(tiny.data.token)).status).toBe(429);
    for (const value of [-1, "10", 1000001, .00000001]) expect((await request("/api/keys", user, { name: "Invalid", totalLimitUsd: value })).status).toBe(400);
    expect((await request("/api/keys", user, { name: "Old", totalLimit: 100 })).status).toBe(400);
    const keys = await request("/api/keys", user); expect(keys.data.keys[0].totalLimit).toBeUndefined(); expect(keys.data.keys[0].outputTotal).toBeUndefined();
    expect((await request(`/api/keys/${tiny.data.key.id}`, admin, { dailyLimitUsd: null }, "PATCH")).status).toBe(404);
    expect((await request(`/api/keys/${tiny.data.key.id}`, user, { dailyLimitUsd: null }, "PATCH")).status).toBe(200);
    expect((await llm(tiny.data.token)).status).toBe(200);
  });
  test("failures release reservations and unpriced models cannot bypass a finite plan", async () => {
    const before = (await status()).windows[0].spentUsd;
    expect((await llm(key, { __fail: true })).status).toBe(400);
    expect((await status()).windows[0].reservedUsd).toBe(0); expect((await status()).windows[0].spentUsd).toBe(before);
    expect((await llm(key, { model: "unpriced" })).status).toBe(503);
  });
  test("client cancellation before usage cannot repeatedly bypass USD limits", async () => {
    clearSpend(); const controller = new AbortController();
    const call = fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ model: "billing-model", messages: [{ role: "user", content: "Start" }], max_tokens: 64, __delay: 500 }) });
    const before = hits;
    for (let index = 0; index < 30 && hits === before; index++) await Bun.sleep(10);
    controller.abort(); await call.catch(() => {});
    for (let index = 0; index < 50 && (await status()).windows[0].reservedUsd > 0; index++) await Bun.sleep(20);
    const current = (await status()).windows[0]; expect(current.reservedUsd).toBe(0); expect(current.spentUsd).toBeGreaterThan(0);
  });
  test("storage errors fail closed in the client protocol and retain unsettled holds", async () => {
    clearSpend();
    sql.exec("CREATE TRIGGER billing_test_admission BEFORE INSERT ON billing_reservations BEGIN SELECT RAISE(ABORT, 'test admission failure'); END");
    try {
      const failed = await llm(); expect(failed.status).toBe(503); expect(JSON.parse(failed.text).error.type).toBe("api_error");
      expect((await status()).windows[0].reservedUsd).toBe(0);
    } finally { sql.exec("DROP TRIGGER billing_test_admission"); }
    sql.exec("CREATE TRIGGER billing_test_settlement BEFORE UPDATE OF state ON billing_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT, 'test settlement failure'); END");
    try {
      const failed = await llm(); expect(failed.status).toBe(503); expect(JSON.parse(failed.text).error.type).toBe("api_error");
      const retained = (await status()).windows[0]; expect(retained.reservedUsd).toBeGreaterThan(0); expect(retained.spentUsd).toBe(0);
    } finally { sql.exec("DROP TRIGGER billing_test_settlement"); }
    // Advance a stopped process's lease to exercise restart recovery.
    const recovered = Bun.spawnSync([process.execPath, "-e", 'import {recoverBudgets} from "./server/billing.ts"; recoverBudgets(Date.now()+360001);'], { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, DATA_DIR: dir, NODE_ENV: "test", GATEWAY_SECRET: "b".repeat(64) }, stdout: "pipe", stderr: "pipe" });
    expect(recovered.exitCode).toBe(0); expect((await status()).windows[0].reservedUsd).toBe(0); expect((await status()).windows[0].spentUsd).toBeGreaterThan(0);
  });
  test("banked reset is atomic, idempotent, preserves monthly/key spend and never shifts renewal times", async () => {
    clearSpend(); await llm();
    const before = await status();
    const issued = await request(`/api/admin/users/${userId}/resets`, admin, { kind: "both", count: 2, note: "Courtesy reset" });
    expect(issued.status).toBe(200); const grant = issued.data.billing.resets[0];
    const nonce = crypto.randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => request(`/api/billing/resets/${grant.id}/redeem`, user, { requestId: nonce })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const after = await status();
    expect(after.resets[0].remaining).toBe(1);
    expect(after.windows.find((w: any) => w.kind === "monthly").spentUsd).toBe(before.windows.find((w: any) => w.kind === "monthly").spentUsd);
    for (const kind of ["weekly", "session"]) { const previous = before.windows.find((w: any) => w.kind === kind), current = after.windows.find((w: any) => w.kind === kind); expect(current.spentUsd).toBe(0); expect(current.resetsAt).toBe(previous.resetsAt); }
    expect((await request(`/api/billing/resets/${grant.id}/redeem`, user, { requestId: crypto.randomUUID() })).status).toBe(409);
    expect((await status()).resets[0].remaining).toBe(1);
    expect((await request("/api/keys", user)).data.keys.find((k: any) => k.id === keyId).spendTotalUsd).toBeGreaterThan(0);
    // No reset can make an exhausted monthly allowance usable again.
    await llm();
    sql.run("UPDATE billing_periods SET spent_nanos = 100000000000 WHERE scope = 'user' AND owner_id = ? AND kind = 'monthly'", [userId]);
    expect((await request(`/api/billing/resets/${grant.id}/redeem`, user, { requestId: crypto.randomUUID() })).status).toBe(200);
    expect((await status()).windows.find((w: any) => w.kind === "monthly").spentUsd).toBe(100);
    expect((await llm()).status).toBe(429);
    await setPlan(null); expect((await status()).resets).toHaveLength(0);
    expect((await request(`/api/billing/resets/${grant.id}/redeem`, user, { requestId: crypto.randomUUID() })).status).toBe(409);
    await setPlan(planId); clearSpend();
  });
  test("plan edits are strict and a plan with members cannot be deleted", async () => {
    for (const body of [{ monthlyUsd: -1 }, { monthlyUsd: "20" }, { weeklyEnabled: "false" }, { monthlyUsd: null, sessionEnabled: true }]) expect((await request(`/api/admin/plans/${planId}`, admin, body, "PATCH")).status).toBe(400);
    expect((await request(`/api/admin/plans/${planId}`, admin, undefined, "DELETE")).status).toBe(409);
    expect((await setPlan("unknown")).status).toBe(400);
    const audit = sql.query<any, []>("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'billing.%'").get()!;
    expect(audit.n).toBeGreaterThanOrEqual(8);
  });
});

test("USD migration removes token caps without reviving revoked keys and freezes historical costs", () => {
  const migrationDir = mkdtempSync(path.join(tmpdir(), "indirect-usd-migrate-"));
  const boot = () => Bun.spawnSync([process.execPath, "-e", 'import "./server/db.ts";'], { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, DATA_DIR: migrationDir, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
  let fixture: Database | undefined;
  try {
    expect(boot().exitCode).toBe(0); fixture = new Database(path.join(migrationDir, "gateway.db")); removeUsdMigration(fixture);
    fixture.exec(`PRAGMA user_version = 24; INSERT INTO users(id,email,created_at) VALUES ('legacy','legacy@example.com',1);
      INSERT INTO api_keys(id,user_id,prefix,hash,created_at,daily_limit,total_limit,status) VALUES ('legacy-key','legacy','gw_a','hash-a',1,100,200,'exhausted'), ('revoked-key','legacy','gw_b','hash-b',1,100,200,'revoked');
      INSERT INTO models(id,upstream_model,created_at,updated_at,pricing_input,pricing_output) VALUES ('legacy-model','legacy-upstream',1,1,.001,.002);
      INSERT INTO usage_model_provider_daily(key_id,user_id,date,proto,model,in_tok,out_tok,reqs) VALUES ('legacy-key','legacy',date('now'),'openai','legacy-model',100,10,1);`);
    fixture.close(); fixture = undefined; const migrated = boot(); expect(migrated.exitCode).toBe(0);
    fixture = new Database(path.join(migrationDir, "gateway.db"));
    expect(fixture.query("SELECT status,daily_limit,total_limit,daily_usd_nanos,total_usd_nanos FROM api_keys WHERE id='legacy-key'").get()).toEqual({ status: "active", daily_limit: null, total_limit: null, daily_usd_nanos: null, total_usd_nanos: null });
    expect((fixture.query<any, []>("SELECT status FROM api_keys WHERE id='revoked-key'").get()!).status).toBe("revoked");
    expect((fixture.query<any, []>("SELECT spent_nanos FROM billing_periods WHERE scope='key' AND kind='lifetime' AND owner_id='legacy-key'").get()!).spent_nanos).toBe(120000000);
    expect(boot().exitCode).toBe(0);
  } finally { fixture?.close(); rmSync(migrationDir, { recursive: true, force: true }); }
});


test("calendar boundaries, concurrent resets, crash recovery and large integer precision", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "indirect-billing-core-"));
  try {
    const result = Bun.spawnSync([process.execPath, "test/billing-core-fixture.ts"], { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, DATA_DIR: fixtureDir, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(`${result.stdout.toString()}\n${result.stderr.toString()}`);
    console.log(result.stdout.toString().split("\n").find((line) => line.startsWith("Core billing")));
    expect(result.exitCode).toBe(0);
  } finally { rmSync(fixtureDir, { recursive: true, force: true }); }
});
