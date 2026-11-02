import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway, waitUntil } from "./gateway-enterprise-fixture";

let gateway: Awaited<ReturnType<typeof startGateway>>;
let upstream: ReturnType<typeof Bun.serve>;
let sql: Database;
let admin: Awaited<ReturnType<typeof login>>;
let user: Awaited<ReturnType<typeof createUser>>;
let providerA: string, providerB: string, providerStream: string, providerPlanA: string, providerPlanB: string;
let hits: Array<{ path: string; body: any }> = [];
let releaseCount: (() => void) | undefined;
let countEntered = false;
let releaseAttempt: (() => void) | undefined;
let attemptEntered = false;
let releaseTimeout: (() => void) | undefined;

function finishAttempt(): void {
  const release = releaseAttempt;
  releaseAttempt = undefined;
  release?.();
}

beforeAll(async () => {
  upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (req.method === "GET") {
      if (pathname.includes("catalog-error")) return new Response('{"error":{"message":"failed","type":"server_error"},"pricing":{"prompt":"1"}}', { status: 502, headers: { "Content-Type": "application/json" } });
      return Response.json({ data: [] });
    }
    const body = await req.json() as any;
    hits.push({ path: pathname, body });
    if (pathname.endsWith("/count_tokens")) {
      if (body.test_hold) { countEntered = true; await new Promise<void>((resolve) => { releaseCount = resolve; }); }
      return Response.json({ input_tokens: 3 });
    }
    if (body.test_mode === "plan-change") {
      attemptEntered = true;
      await new Promise<void>((resolve) => { releaseAttempt = resolve; });
      return Response.json({ error: { message: "proxy failed", type: "server_error" } }, { status: 502 });
    }
    if (pathname.startsWith("/a/") && body.test_mode === "timeout") await new Promise<void>((resolve) => { releaseTimeout = resolve; });
    if (pathname.startsWith("/a/") && body.test_mode === "charged-error") return Response.json({ error: { message: "failed", type: "server_error" }, usage: { prompt_tokens: 1, completion_tokens: 2 } }, { status: 502 });
    if ((pathname.startsWith("/a/") && body.test_mode === "fallback") || body.test_mode === "all-fail") return Response.json({ error: { message: "proxy failed", type: "server_error" } }, { status: 502 });
    if (pathname.endsWith("/messages") && body.stream) {
      const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`;
      if (body.test_mode === "client-cancel") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(start)); } }), { headers: { "Content-Type": "text/event-stream" } });
      const terminal = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\nevent: message_stop\ndata: {}\n\n`;
      return new Response(start + (body.test_mode === "interrupted" ? "" : terminal), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (pathname.endsWith("/responses") && body.stream && body.test_mode === "terminal-failure") {
      return new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { code: "failed", message: "failed" }, usage: { input_tokens: 1, output_tokens: 2 } } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (pathname.endsWith("/responses")) return Response.json({ id: "r", model: body.model, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2 } });
    if (pathname.endsWith("/embeddings")) return Response.json({ object: "list", data: [], model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } });
    return Response.json({ id: "r", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
  } });
  gateway = await startGateway({ DEFAULT_KEY_CONCURRENCY: "1", LIMIT_ADMISSION_WAIT_MS: "3000", UPSTREAM_TIMEOUT_NONSTREAM_MS: "600" });
  admin = await login(gateway.base, "admin@enterprise.test");
  user = await createUser(gateway.base, admin.accessToken, "bounds-review@enterprise.test");
  const provider = async (name: string, body: Record<string, unknown>) => {
    const result = await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name, apiKey: "test-key", ...body } });
    expect(result.response.status, result.text).toBe(200);
    return result.data.provider.id as string;
  };
  providerA = await provider("bounds-a", { openaiBaseUrl: `http://127.0.0.1:${upstream.port}/a/v1` });
  providerB = await provider("bounds-b", { openaiBaseUrl: `http://127.0.0.1:${upstream.port}/b/v1` });
  providerStream = await provider("bounds-stream", { anthropicBaseUrl: `http://127.0.0.1:${upstream.port}/s/v1`, responsesBaseUrl: `http://127.0.0.1:${upstream.port}/s/v1` });
  providerPlanA = await provider("bounds-plan-a", { anthropicBaseUrl: `http://127.0.0.1:${upstream.port}/s/v1`, responsesBaseUrl: `http://127.0.0.1:${upstream.port}/s/v1` });
  providerPlanB = await provider("bounds-plan-b", { anthropicBaseUrl: `http://127.0.0.1:${upstream.port}/s/v1`, responsesBaseUrl: `http://127.0.0.1:${upstream.port}/s/v1` });
  const model = async (id: string, targets: string[], input: number, output: number) => {
    const result = await request(gateway.base, "/api/admin/models", { token: admin.accessToken, body: { id, contextLength: 100, maxOutputLength: 100, pricing: { prompt: input, completion: output }, targets: targets.map((providerId) => ({ providerId, upstreamModel: id })) } });
    expect(result.response.status, result.text).toBe(200);
  };
  await model("bounds-output", [providerA], 0, 0.0001);
  await model("bounds-input", [providerA], 0.0001, 0);
  await model("bounds-embedding", [providerA], 0.0001, 0);
  await model("bounds-stream", [providerStream], 0.0001, 0.0001);
  await model("bounds-live", [providerStream], 0, 0.0001);
  await model("bounds-plan", [providerPlanA], 0, 0.0001);
  await model("bounds-plan-2", [providerPlanB], 0, 0.0001);
  for (const id of ["bounds-denied", "bounds-fallback", "bounds-charged", "bounds-timeout", "bounds-all-fail"]) await model(id, [providerA, providerB], 0, 0.0001);
  expect((await request(gateway.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "router" } })).response.status).toBe(200);
  sql = new Database(path.join(gateway.dir, "gateway.db"));
}, 60_000);

afterAll(async () => {
  releaseCount?.(); releaseAttempt?.(); releaseTimeout?.(); sql?.close(); upstream?.stop(true);
  if (gateway) await gateway.stop();
});

async function makeKey(body: Record<string, unknown> = {}, actor = user) {
  const made = await request(gateway.base, "/api/keys", { token: actor.accessToken, body: { name: `key-${crypto.randomUUID()}`, ...body } });
  expect(made.response.status, made.text).toBe(200);
  return { token: made.data.token as string, id: made.data.key.id as string };
}
async function post(token: string, route: string, body: unknown) {
  const response = await fetch(gateway.base + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}
function lastHold(keyId: string) {
  return sql.query<any, [string]>("SELECT state,amount_nanos,uncertain_nanos,cost_in_nanos,cost_cache_nanos,cost_out_nanos FROM billing_reservations WHERE key_id=? ORDER BY rowid DESC LIMIT 1").get(keyId);
}
function keyCounter(keyId: string) {
  return sql.query<any, [string]>("SELECT spent_nanos,reserved_nanos FROM billing_periods WHERE scope='key' AND kind='lifetime' AND owner_id=?").get(keyId);
}
const completion = (extra: Record<string, unknown> = {}) => ({ model: "bounds-output", prompt: "hello", max_tokens: 100, ...extra });

test("finite key, account and project budgets cover completion and embedding batches", async () => {
  const key = await makeKey({ totalLimitUsd: 0.02 });
  for (const body of [completion({ best_of: 10 }), completion({ n: 10 }), completion({ prompt: Array(10).fill("hello") }), completion({ prompt: Array.from({ length: 10 }, () => [1, 2]) })]) {
    hits = []; const result = await post(key.token, "/v1/completions", body);
    expect(result.status, result.text).toBe(429); expect(hits).toHaveLength(0);
  }
  hits = [];
  expect((await post(key.token, "/v1/embeddings", { model: "bounds-embedding", input: Array.from({ length: 10 }, () => Array(100).fill(1)) })).status).toBe(429);
  expect(hits).toHaveLength(0);
  // A flat token-id array is one prompt, not a batch of 100 prompts.
  expect((await post(key.token, "/v1/completions", completion({ prompt: Array(100).fill(1) }))).status).toBe(200);
  expect(hits[0]!.body.prompt).toEqual(Array(100).fill(1));
  for (const extra of [{ n: 10 }, { best_of: 10 }]) {
    hits = [];
    expect((await post(key.token, "/v1/completions", { ...completion(extra), model: "bounds-input", prompt: Array(100).fill(1) })).status).toBe(429);
    expect(hits).toHaveLength(0);
  }

  const accountKey = await makeKey();
  const plan = await request(gateway.base, "/api/admin/plans", { token: admin.accessToken, body: { name: "Bounds", monthlyUsd: 0.02 } });
  expect((await request(gateway.base, `/api/admin/users/${user.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId: plan.data.plans[0].id } })).response.status).toBe(200);
  hits = []; expect((await post(accountKey.token, "/v1/completions", completion({ best_of: 10 }))).status).toBe(429); expect(hits).toHaveLength(0);
  expect((await request(gateway.base, `/api/admin/users/${user.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId: null } })).response.status).toBe(200);
  const project = await request(gateway.base, "/api/projects", { token: admin.accessToken, body: { kind: "project", code: "BOUNDS", name: "Bounds", totalLimitUsd: 0.02 } });
  const id = project.data.project.id;
  expect((await request(gateway.base, `/api/projects/${id}/members/${user.user.id}`, { token: admin.accessToken, method: "PUT", body: { role: "member" } })).response.status).toBe(200);
  const projectKey = await makeKey({ projectId: id });
  hits = []; expect((await post(projectKey.token, "/v1/embeddings", { model: "bounds-embedding", input: Array.from({ length: 10 }, () => Array(100).fill(1)) })).status).toBe(429); expect(hits).toHaveLength(0);
  expect(sql.query<any, [string]>("SELECT reserved_nanos FROM billing_periods WHERE scope='project' AND owner_id=? AND kind='lifetime'").get(id)?.reserved_nanos ?? 0).toBe(0);
}, 60_000);

test("conflicting protocol caps and translated fallbacks cannot shrink the bound", async () => {
  const key = await makeKey({ totalLimitUsd: 0.0002 });
  const cases: Array<[string, unknown]> = [
    ["/v1/completions", completion({ max_output_tokens: 1 })],
    ["/v1/chat/completions", { model: "bounds-output", messages: [{ role: "user", content: "hi" }], max_tokens: 100, max_output_tokens: 1 }],
    ["/anthropic/v1/messages", { model: "bounds-output", messages: [{ role: "user", content: "hi" }], max_tokens: 100, max_output_tokens: 1 }],
    ["/v1/responses", { model: "bounds-stream", input: "hi", max_output_tokens: 100, max_tokens: 1 }],
    ["/v1/chat/completions", { model: "bounds-stream", messages: [{ role: "user", content: "hi" }], max_output_tokens: 1 }],
  ];
  for (const [route, body] of cases) { hits = []; const result = await post(key.token, route, body); expect(result.status, `${route} ${result.text}`).toBe(429); expect(hits).toHaveLength(0); }
  expect(sql.query<any, [string]>("SELECT COUNT(*) AS n FROM billing_reservations WHERE key_id=? AND state='pending'").get(key.id)!.n).toBe(0);
  // Unbudgeted requests retain their original native body, including unknown fields.
  const unlimited = await makeKey(); hits = [];
  const body = completion({ max_output_tokens: 1, extra_upstream_field: "preserved" });
  expect((await post(unlimited.token, "/v1/completions", body)).status).toBe(200);
  expect(hits[0]!.body).toEqual(body);
  // Legacy completions have no cross-protocol conversion: never silently
  // translate a batched prompt to a single chat or messages request.
  hits = [];
  expect((await post(unlimited.token, "/v1/completions", { model: "bounds-stream", prompt: ["first", "second"], max_tokens: 10 })).status).toBe(503);
  expect(hits).toHaveLength(0);
}, 60_000);

test("ambiguous 502 and timeout attempts reserve separately and settle once", async () => {
  const denied = await makeKey({ totalLimitUsd: 0.0015 });
  hits = [];
  const deniedResult = await post(denied.token, "/v1/chat/completions", { model: "bounds-denied", messages: [{ role: "user", content: "hi" }], max_tokens: 10, test_mode: "fallback" });
  expect(deniedResult.status, deniedResult.text).toBe(429); expect(hits.map((h) => h.path)).toEqual(["/a/v1/chat/completions"]);
  expect(lastHold(denied.id)).toMatchObject({ state: "settled", amount_nanos: 1_000_000, uncertain_nanos: 1_000_000, cost_in_nanos: 1_000_000, cost_out_nanos: 0 });
  expect(keyCounter(denied.id)).toEqual({ spent_nanos: 1_000_000, reserved_nanos: 0 });

  const success = await makeKey({ totalLimitUsd: 0.01 }); hits = [];
  expect((await post(success.token, "/v1/chat/completions", { model: "bounds-fallback", messages: [{ role: "user", content: "hi" }], max_tokens: 10, test_mode: "fallback" })).status).toBe(200);
  expect(hits.map((h) => h.path)).toEqual(["/a/v1/chat/completions", "/b/v1/chat/completions"]);
  expect(lastHold(success.id)).toMatchObject({ state: "settled", amount_nanos: 2_000_000, uncertain_nanos: 1_000_000, cost_in_nanos: 1_000_000, cost_out_nanos: 200_000 });
  expect(keyCounter(success.id)).toEqual({ spent_nanos: 1_200_000, reserved_nanos: 0 });

  const charged = await makeKey({ totalLimitUsd: 0.01 }); hits = [];
  expect((await post(charged.token, "/v1/chat/completions", { model: "bounds-charged", messages: [{ role: "user", content: "hi" }], max_tokens: 10, test_mode: "charged-error" })).status).toBe(502);
  expect(hits).toHaveLength(1);
  expect(lastHold(charged.id)).toMatchObject({ state: "settled", amount_nanos: 1_000_000, uncertain_nanos: 0, cost_in_nanos: 0, cost_out_nanos: 200_000 });

  const timeout = await makeKey({ totalLimitUsd: 0.01 }); hits = [];
  try {
    expect((await post(timeout.token, "/v1/chat/completions", { model: "bounds-timeout", messages: [{ role: "user", content: "hi" }], max_tokens: 10, test_mode: "timeout" })).status).toBe(200);
  } finally { releaseTimeout?.(); releaseTimeout = undefined; }
  expect(hits.map((h) => h.path)).toEqual(["/a/v1/chat/completions", "/b/v1/chat/completions"]);
  expect(lastHold(timeout.id)).toMatchObject({ state: "settled", amount_nanos: 2_000_000, uncertain_nanos: 1_000_000, cost_out_nanos: 200_000 });
  expect(keyCounter(timeout.id).reserved_nanos).toBe(0);

  const all = await makeKey({ totalLimitUsd: 0.01 }); hits = [];
  expect((await post(all.token, "/v1/chat/completions", { model: "bounds-all-fail", messages: [{ role: "user", content: "hi" }], max_tokens: 10, test_mode: "all-fail" })).status).toBe(502);
  expect(hits).toHaveLength(2);
  expect(lastHold(all.id)).toMatchObject({ state: "settled", amount_nanos: 2_000_000, uncertain_nanos: 2_000_000, cost_in_nanos: 2_000_000 });
  expect(keyCounter(all.id)).toEqual({ spent_nanos: 2_000_000, reserved_nanos: 0 });
}, 60_000);

test("interrupted streams conservatively settle partial usage; terminal usage stays exact", async () => {
  const key = await makeKey({ totalLimitUsd: 0.1 });
  const body = { model: "bounds-stream", messages: [{ role: "user", content: "hi" }], max_tokens: 10, stream: true };
  const interrupted = await post(key.token, "/anthropic/v1/messages", { ...body, test_mode: "interrupted" });
  expect(interrupted.status).toBe(200); expect(interrupted.text).toContain("Upstream stream ended before its terminal event");
  expect(lastHold(key.id)).toMatchObject({ state: "settled", amount_nanos: 11_000_000, cost_in_nanos: 11_000_000, cost_out_nanos: 0 });
  const cancelResponse = await fetch(gateway.base + "/anthropic/v1/messages", { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, test_mode: "client-cancel" }) });
  const reader = cancelResponse.body!.getReader();
  await reader.read(); await reader.cancel();
  await waitUntil(() => lastHold(key.id)?.state === "settled", "cancelled stream did not settle");
  expect(lastHold(key.id)).toMatchObject({ state: "settled", amount_nanos: 11_000_000, cost_in_nanos: 11_000_000, cost_out_nanos: 0 });
  const complete = await post(key.token, "/anthropic/v1/messages", body);
  expect(complete.status).toBe(200);
  expect(lastHold(key.id)).toMatchObject({ state: "settled", amount_nanos: 11_000_000, cost_in_nanos: 100_000, cost_out_nanos: 200_000 });
  const failed = await post(key.token, "/v1/responses", { model: "bounds-stream", input: "hi", max_output_tokens: 10, stream: true, test_mode: "terminal-failure" });
  expect(failed.status).toBe(200); expect(failed.text).toContain("failed");
  expect(lastHold(key.id)).toMatchObject({ state: "settled", amount_nanos: 11_000_000, cost_in_nanos: 100_000, cost_out_nanos: 200_000 });
  expect(keyCounter(key.id).reserved_nanos).toBe(0);
}, 60_000);

test("a newly enabled budget window blocks an ambiguous retry", async () => {
  const plan = await request(gateway.base, "/api/admin/plans", { token: admin.accessToken, body: { name: "Retry change", monthlyUsd: 10 } });
  const planId = plan.data.plans.find((p: any) => p.name === "Retry change").id;
  expect((await request(gateway.base, `/api/admin/users/${user.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId } })).response.status).toBe(200);
  const key = await makeKey({ totalLimitUsd: 0.01 });
  try {
    hits = []; attemptEntered = false;
    const pending = post(key.token, "/v1/responses", { model: "bounds-plan", input: "hi", max_output_tokens: 10, test_mode: "plan-change" });
    await waitUntil(() => attemptEntered, "first attempt did not reach upstream");
    expect((await request(gateway.base, `/api/admin/plans/${planId}`, { token: admin.accessToken, method: "PATCH", body: { sessionEnabled: true } })).response.status).toBe(200);
    releaseAttempt?.(); releaseAttempt = undefined;
    expect((await pending).status).toBe(409);
    expect(hits).toHaveLength(1);
    expect(lastHold(key.id)).toMatchObject({ state: "settled", amount_nanos: 1_000_000, uncertain_nanos: 1_000_000, cost_in_nanos: 1_000_000 });
    expect(keyCounter(key.id).reserved_nanos).toBe(0);
  } finally {
    releaseAttempt?.(); releaseAttempt = undefined;
    await request(gateway.base, `/api/admin/users/${user.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId: null } });
  }
}, 30_000);

test("retries honor changed plan assignment and reduced current limits", async () => {
  const reassigned = await createUser(gateway.base, admin.accessToken, "retry-reassigned@enterprise.test");
  const reduced = await createUser(gateway.base, admin.accessToken, "retry-reduced@enterprise.test");
  const createPlan = async (name: string, monthlyUsd: number) => {
    const result = await request(gateway.base, "/api/admin/plans", { token: admin.accessToken, body: { name, monthlyUsd } });
    return result.data.plans.find((p: any) => p.name === name).id as string;
  };
  const oldPlan = await createPlan("Retry old", 10), newPlan = await createPlan("Retry new", 20), lowerPlan = await createPlan("Retry lower", 0.1);
  const assign = (actor: typeof user, planId: string) => request(gateway.base, `/api/admin/users/${actor.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId } });
  expect((await assign(reassigned, oldPlan)).response.status).toBe(200);
  expect((await assign(reduced, lowerPlan)).response.status).toBe(200);
  for (const [actor, cap, change, expected] of [
    [reassigned, 10, () => assign(reassigned, newPlan), 409],
    [reduced, 100, () => request(gateway.base, `/api/admin/plans/${lowerPlan}`, { token: admin.accessToken, method: "PATCH", body: { monthlyUsd: 0.015 } }), 429],
  ] as const) {
    const key = await makeKey({ totalLimitUsd: 1 }, actor);
    hits = []; attemptEntered = false;
    const pending = post(key.token, "/v1/responses", { model: "bounds-plan", input: "hi", max_output_tokens: cap, test_mode: "plan-change" });
    try {
      await waitUntil(() => attemptEntered, "first attempt did not reach upstream");
      expect((await change()).response.status).toBe(200);
    } finally { releaseAttempt?.(); releaseAttempt = undefined; }
    expect((await pending).status).toBe(expected);
    expect(hits).toHaveLength(1);
    expect(lastHold(key.id)).toMatchObject({ state: "settled", amount_nanos: cap * 100_000, uncertain_nanos: cap * 100_000, cost_in_nanos: cap * 100_000 });
    expect(keyCounter(key.id)).toEqual({ spent_nanos: cap * 100_000, reserved_nanos: 0 });
    const account = sql.query<any, [string]>("SELECT spent_nanos,reserved_nanos FROM billing_periods WHERE scope='user' AND owner_id=? AND kind='monthly' ORDER BY starts_at DESC LIMIT 1").get(actor.user.id);
    expect(account).toEqual({ spent_nanos: cap * 100_000, reserved_nanos: 0 });
  }
}, 30_000);

test("an ambiguous retry cannot change its original project or cost center", async () => {
  const actor = await createUser(gateway.base, admin.accessToken, "retry-project@enterprise.test");
  const createScope = async (kind: "project" | "cost_center", code: string, costCenterId?: string) => {
    const result = await request(gateway.base, "/api/projects", { token: admin.accessToken, body: { kind, code, name: code, ...(costCenterId ? { costCenterId } : {}) } });
    expect(result.response.status, result.text).toBe(200);
    return result.data.project.id as string;
  };
  const centerA = await createScope("cost_center", "RETRY-CC-A"), centerB = await createScope("cost_center", "RETRY-CC-B");
  const projectA = await createScope("project", "RETRY-P-A", centerA), projectB = await createScope("project", "RETRY-P-B", centerB);
  for (const id of [projectA, projectB]) expect((await request(gateway.base, `/api/projects/${id}/members/${actor.user.id}`, { token: admin.accessToken, method: "PUT", body: { role: "member" } })).response.status).toBe(200);
  const key = await makeKey({ projectId: projectA, totalLimitUsd: 0.01 }, actor);
  hits = []; attemptEntered = false;
  const pending = post(key.token, "/v1/responses", { model: "bounds-plan-2", input: "hi", max_output_tokens: 10, test_mode: "plan-change" });
  try {
    await waitUntil(() => attemptEntered, "first attempt did not reach upstream");
    expect((await request(gateway.base, `/api/keys/${key.id}`, { token: actor.accessToken, method: "PATCH", body: { projectId: projectB } })).response.status).toBe(200);
  } finally { finishAttempt(); }
  expect((await pending).status).toBe(409); expect(hits).toHaveLength(1);
  expect(lastHold(key.id)).toMatchObject({ state: "settled", amount_nanos: 1_000_000, uncertain_nanos: 1_000_000, cost_in_nanos: 1_000_000 });
  for (const id of [projectA, centerA]) expect(sql.query<any, [string]>("SELECT spent_nanos,reserved_nanos FROM billing_periods WHERE scope='project' AND owner_id=? AND kind='lifetime'").get(id)).toEqual({ spent_nanos: 1_000_000, reserved_nanos: 0 });
  for (const id of [projectB, centerB]) expect(sql.query("SELECT 1 FROM billing_periods WHERE scope='project' AND owner_id=? AND kind='lifetime'").get(id)).toBeNull();
  await waitUntil(() => !!sql.query("SELECT 1 FROM usage_events WHERE key_id=?").get(key.id), "usage was not delivered", 10000);
  expect(sql.query<any, [string]>("SELECT project_id,cost_center_id,estimated FROM usage_events WHERE key_id=?").get(key.id)).toEqual({ project_id: projectA, cost_center_id: centerA, estimated: 1 });
}, 30_000);

test("new limits and rolled-over periods do not authorize an unsafe retry", async () => {
  // The first request was admitted without a cap, so it did not undergo the
  // validation required for a finite budget.
  const unlimited = await makeKey();
  hits = []; attemptEntered = false;
  const pendingUnlimited = post(unlimited.token, "/v1/responses", { model: "bounds-plan-2", input: "hi", max_output_tokens: 10, test_mode: "plan-change" });
  try {
    await waitUntil(() => attemptEntered, "unlimited attempt did not reach upstream");
    expect((await request(gateway.base, `/api/keys/${unlimited.id}`, { token: user.accessToken, method: "PATCH", body: { totalLimitUsd: 0.01 } })).response.status).toBe(200);
  } finally { finishAttempt(); }
  expect((await pendingUnlimited).status).toBe(409); expect(hits).toHaveLength(1);
  expect(keyCounter(unlimited.id)).toEqual({ spent_nanos: 1_000_000, reserved_nanos: 0 });

  const daily = await makeKey({ dailyLimitUsd: 0.01 });
  hits = []; attemptEntered = false;
  const pendingDaily = post(daily.token, "/v1/responses", { model: "bounds-plan-2", input: "hi", max_output_tokens: 10, test_mode: "plan-change" });
  let oldStart: number | undefined;
  try {
    await waitUntil(() => attemptEntered, "daily attempt did not reach upstream");
    // Move the pending hold and its daily counter together to the preceding
    // UTC day, simulating a request that crossed midnight without a long sleep.
    const hold = sql.query<any, [string]>("SELECT id,created_at,periods FROM billing_reservations WHERE key_id=? AND state='pending'").get(daily.id)!;
    const periods = JSON.parse(hold.periods) as Array<{ scope: string; owner: string; kind: string; start: number; end: number }>;
    const day = periods.find((p) => p.scope === "key" && p.owner === daily.id && p.kind === "daily")!;
    const currentStart = day.start;
    day.start -= 86_400_000; day.end -= 86_400_000; oldStart = day.start;
    sql.transaction(() => {
      sql.prepare("UPDATE billing_periods SET starts_at=?,ends_at=? WHERE scope='key' AND owner_id=? AND kind='daily' AND starts_at=?").run(day.start, day.end, daily.id, currentStart);
      sql.prepare("UPDATE billing_reservations SET created_at=?,periods=? WHERE id=?").run(hold.created_at - 86_400_000, JSON.stringify(periods), hold.id);
    }).immediate();
  } finally { finishAttempt(); }
  expect((await pendingDaily).status).toBe(409); expect(hits).toHaveLength(1);
  expect(sql.query<any, [string, number]>("SELECT spent_nanos,reserved_nanos FROM billing_periods WHERE scope='key' AND owner_id=? AND kind='daily' AND starts_at=?").get(daily.id, oldStart!)).toEqual({ spent_nanos: 1_000_000, reserved_nanos: 0 });
  expect(keyCounter(daily.id)).toEqual({ spent_nanos: 1_000_000, reserved_nanos: 0 });
}, 30_000);

test("queued token counts recheck key expiration before dispatch", async () => {
  const key = await makeKey(); countEntered = false; hits = [];
  const body = { model: "bounds-stream", messages: [{ role: "user", content: "hi" }] };
  const first = post(key.token, "/anthropic/v1/messages/count_tokens", { ...body, test_hold: true });
  await waitUntil(() => countEntered, "first token count did not reach upstream");
  const second = post(key.token, "/anthropic/v1/messages/count_tokens", body);
  let queued = false;
  for (let i = 0; i < 100 && !queued; i++) { const ready = await (await fetch(gateway.base + "/api/ready")).json() as any; queued = ready.checks.admission.queued > 0; if (!queued) await Bun.sleep(5); }
  expect(queued).toBe(true);
  sql.prepare("UPDATE api_keys SET expires_at=? WHERE id=?").run(Date.now() - 1, key.id);
  releaseCount?.(); releaseCount = undefined;
  expect((await first).status).toBe(200); expect((await second).status).toBe(401);
  expect(hits.filter((h) => h.path.endsWith("/count_tokens"))).toHaveLength(1);
}, 30_000);

test("failed settlement retries in the live process without duplicate delivery", async () => {
  const key = await makeKey({ totalLimitUsd: 0.01 });
  sql.exec("CREATE TRIGGER fail_live_settlement BEFORE UPDATE OF state ON billing_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END");
  try {
    const served = await post(key.token, "/v1/responses", { model: "bounds-live", input: "hi", max_output_tokens: 10 });
    expect(served.status).toBe(200);
    expect(lastHold(key.id).state).toBe("pending");
    expect(keyCounter(key.id)).toEqual({ spent_nanos: 0, reserved_nanos: 1_000_000 });
  } finally { sql.exec("DROP TRIGGER fail_live_settlement"); }
  await waitUntil(() => lastHold(key.id)?.state === "settled", "live settlement did not retry", 10000);
  expect(lastHold(key.id)).toMatchObject({ cost_in_nanos: 0, cost_out_nanos: 200_000 });
  expect(keyCounter(key.id)).toEqual({ spent_nanos: 200_000, reserved_nanos: 0 });
  await waitUntil(() => sql.query<any, [string]>("SELECT COUNT(*) AS n FROM usage_events WHERE key_id=?").get(key.id)!.n === 1, "usage was not delivered", 10000);
  await Bun.sleep(150);
  expect(sql.query<any, [string]>("SELECT COUNT(*) AS n FROM usage_events WHERE key_id=?").get(key.id)!.n).toBe(1);
}, 30_000);

test("same-protocol JSON catalog errors remain byte-faithful with restricted prices", async () => {
  const key = await makeKey();
  expect((await request(gateway.base, "/api/admin/financial-policy", { token: admin.accessToken, method: "PATCH", body: { showModelPrices: false } })).response.status).toBe(200);
  expect((await request(gateway.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "passthrough" } })).response.status).toBe(200);
  try {
    const response = await fetch(gateway.base + "/v1/models/catalog-error", { headers: { Authorization: `Bearer ${key.token}` } });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":{"message":"failed","type":"server_error"},"pricing":{"prompt":"1"}}');
  } finally {
    await request(gateway.base, "/api/admin/financial-policy", { token: admin.accessToken, method: "PATCH", body: { showModelPrices: null } });
    await request(gateway.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "router" } });
  }
}, 30_000);
