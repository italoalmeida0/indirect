import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway, waitUntil } from "./gateway-enterprise-fixture";

let gateway: Awaited<ReturnType<typeof startGateway>>;
let upstream: ReturnType<typeof Bun.serve>;
let sql: Database;
let admin: Awaited<ReturnType<typeof login>>, user: Awaited<ReturnType<typeof createUser>>;
let hits: string[] = [];
let entered = false, releaseGate: (() => void) | undefined;
let imageEntered = false, releaseImage: (() => void) | undefined;
const cases = ["revoke", "ban", "assignment", "policy", "limit", "plan", "unbounded", "window", "unchanged", "free", "free-budget", "free-local"] as const;

beforeAll(async () => {
  upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/image") {
      imageEntered = true; await new Promise<void>((resolve) => { releaseImage = resolve; });
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    }
    if (req.method === "GET") return Response.json({ data: [] });
    const body = await req.json() as any;
    hits.push(pathname);
    if (pathname.startsWith("/ambiguous-first/")) return Response.json({ error: { message: "uncertain", type: "server_error" } }, { status: 502 });
    if (body.test_gate && !pathname.startsWith("/fallback-")) {
      entered = true; await new Promise<void>((resolve) => { releaseGate = resolve; });
      return Response.json({ error: { message: "rate limited", type: "rate_limit_error" } }, { status: 429, headers: { "Retry-After": "2" } });
    }
    if (pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 3 });
    if (body.model === "usage-banner") return new Response("upstream temporarily unavailable", { status: 500, headers: { "Content-Type": "text/plain" } });
    if (pathname.endsWith("/responses")) {
      const status = body.model === "usage-output-only" ? "failed" : "completed";
      const usage = body.model === "usage-output-only" ? { input_tokens: 0, output_tokens: 2 }
        : body.model === "usage-input-only" ? { input_tokens: 2, output_tokens: 0 }
          : body.model === "usage-reason-only" ? { input_tokens: 0, output_tokens: 2, output_tokens_details: { reasoning_tokens: 2 } }
            : { input_tokens: 0, output_tokens: 0 };
      const noContent = ["usage-output-only", "usage-reason-only", "usage-empty"].includes(body.model);
      if (!body.stream) return Response.json({ id: "r", model: body.model, status, output: noContent ? [] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "visible text" }] }], usage });
      const delta = noContent ? "" : `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "visible text" })}\n\n`;
      const response = { id: "r", model: body.model, status, output: [], usage, ...(status === "failed" ? { error: { code: "failed", message: "failed" } } : {}) };
      return new Response(delta + `event: response.${status}\ndata: ${JSON.stringify({ type: `response.${status}`, response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return Response.json({ id: "r", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
  } });
  gateway = await startGateway();
  admin = await login(gateway.base, "admin@enterprise.test");
  user = await createUser(gateway.base, admin.accessToken, "dispatch-main@enterprise.test");
  const provider = async (name: string, kind: "openai" | "anthropic" | "responses") => {
    const base = `http://127.0.0.1:${upstream.port}/${name}/v1`;
    const property = kind === "openai" ? "openaiBaseUrl" : kind === "anthropic" ? "anthropicBaseUrl" : "responsesBaseUrl";
    const made = await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name, [property]: base, apiKey: "test-key" } });
    expect(made.response.status, made.text).toBe(200); return made.data.provider.id as string;
  };
  const fallbackOpen = await provider("fallback-open", "openai"), fallbackAnth = await provider("fallback-anth", "anthropic");
  const model = async (id: string, targets: string[], input = 0, output = 0.0001) => {
    const made = await request(gateway.base, "/api/admin/models", { token: admin.accessToken, body: { id, contextLength: 100, maxOutputLength: 100, pricing: { prompt: input, completion: output }, targets: targets.map((providerId) => ({ providerId, upstreamModel: id })) } });
    expect(made.response.status, made.text).toBe(200);
  };
  for (const name of cases) {
    const free = name.startsWith("free");
    const primary = await provider(name, free ? "anthropic" : "openai");
    await model(`dispatch-${name}`, [primary, free && name !== "free-local" ? fallbackAnth : fallbackOpen]);
  }
  const ambiguousFirst = await provider("ambiguous-first", "openai"), ambiguousSecond = await provider("ambiguous-second", "openai");
  await model("dispatch-ambiguous", [ambiguousFirst, ambiguousSecond, fallbackOpen]);
  const responses = await provider("responses-only", "responses");
  for (const id of ["usage-output-only", "usage-input-only", "usage-reason-only", "usage-allzero", "usage-empty", "usage-banner", "dispatch-image"]) await model(id, [responses], 0.0001, 0.0001);
  expect((await request(gateway.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "router" } })).response.status).toBe(200);
  sql = new Database(path.join(gateway.dir, "gateway.db"));
}, 60_000);

afterAll(async () => {
  releaseGate?.(); releaseImage?.(); sql?.close(); upstream?.stop(true);
  if (gateway) await gateway.stop();
});

async function keyFor(actor = user, body: Record<string, unknown> = {}) {
  const result = await request(gateway.base, "/api/keys", { token: actor.accessToken, body: { name: `dispatch-${crypto.randomUUID()}`, ...body } });
  expect(result.response.status, result.text).toBe(200);
  return { token: result.data.token as string, id: result.data.key.id as string };
}
const send = (token: string, route: string, body: unknown) => fetch(gateway.base + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const hold = (id: string) => sql.query<any, [string]>("SELECT state,amount_nanos,uncertain_nanos,cost_in_nanos,cost_out_nanos FROM billing_reservations WHERE key_id=? ORDER BY rowid DESC LIMIT 1").get(id);
const counter = (id: string) => sql.query<any, [string]>("SELECT spent_nanos,reserved_nanos FROM billing_periods WHERE scope='key' AND owner_id=? AND kind='lifetime'").get(id);
async function gated(token: string, route: string, body: Record<string, unknown>, mutate: () => Promise<void>) {
  entered = false; hits = [];
  const pending = send(token, route, { ...body, test_gate: true });
  try { await waitUntil(() => entered, "first attempt did not reach upstream", 10000); await mutate(); }
  finally { releaseGate?.(); releaseGate = undefined; }
  const response = await pending;
  return { status: response.status, body: await response.text(), headers: response.headers };
}
const completion = (id: string) => ({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 10 });

test("definite failures recheck revocation, ban, scope, model and reduced caps", async () => {
  const banned = await createUser(gateway.base, admin.accessToken, "dispatch-ban@enterprise.test");
  const project = await request(gateway.base, "/api/projects", { token: admin.accessToken, body: { kind: "project", code: "DISPATCH", name: "Dispatch" } });
  expect(project.response.status, project.text).toBe(200);
  const projectId = project.data.project.id as string;
  expect((await request(gateway.base, `/api/projects/${projectId}/members/${user.user.id}`, { token: admin.accessToken, method: "PUT", body: { role: "member" } })).response.status).toBe(200);
  const policy = await request(gateway.base, "/api/admin/model-policies", { token: admin.accessToken, body: { name: "Dispatch policy", kind: "default", models: ["dispatch-policy", "dispatch-unchanged"] } });
  expect(policy.response.status, policy.text).toBe(200);
  const policyId = policy.data.policy.id as string;
  const plan = await request(gateway.base, "/api/admin/plans", { token: admin.accessToken, body: { name: "Dispatch plan", monthlyUsd: 10 } });
  const planId = plan.data.plans.find((p: any) => p.name === "Dispatch plan").id as string;
  // Keep the policy disabled until its specific test, so other models stay usable.
  expect((await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { enabled: false } })).response.status).toBe(200);
  const trials = [
    { name: "revoke", actor: user, keyBody: {}, expected: 401, mutate: (key: { id: string }) => request(gateway.base, `/api/keys/${key.id}`, { token: user.accessToken, method: "DELETE" }) },
    { name: "ban", actor: banned, keyBody: {}, expected: 401, mutate: () => request(gateway.base, `/api/admin/users/${banned.user.id}`, { token: admin.accessToken, method: "PATCH", body: { status: "banned" } }) },
    { name: "assignment", actor: user, keyBody: { projectId }, expected: 409, mutate: (key: { id: string }) => request(gateway.base, `/api/keys/${key.id}`, { token: user.accessToken, method: "PATCH", body: { projectId: null } }) },
    { name: "policy", actor: user, keyBody: {}, expected: 404, mutate: () => request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { enabled: true, models: ["dispatch-unchanged"] } }) },
    { name: "limit", actor: user, keyBody: {}, expected: 429, mutate: (key: { id: string }) => request(gateway.base, `/api/keys/${key.id}`, { token: user.accessToken, method: "PATCH", body: { totalLimitUsd: 0.0005 } }) },
    { name: "plan", actor: user, keyBody: {}, expected: 409, mutate: () => request(gateway.base, `/api/admin/users/${user.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId } }) },
  ] as const;
  try {
    for (const trial of trials) {
      const key = await keyFor(trial.actor, { totalLimitUsd: 0.02, ...trial.keyBody });
      const result = await gated(key.token, "/v1/chat/completions", completion(`dispatch-${trial.name}`), async () => {
        const changed = await trial.mutate(key); expect(changed.response.status, changed.text).toBe(200);
      });
      expect(result.status, `${trial.name}: ${result.body}`).toBe(trial.expected);
      expect(hits).toEqual([`/${trial.name}/v1/chat/completions`]);
      expect(hold(key.id)).toMatchObject({ state: "settled", amount_nanos: 1_000_000, uncertain_nanos: 0, cost_in_nanos: 0, cost_out_nanos: 0 });
      expect(counter(key.id)).toEqual({ spent_nanos: 0, reserved_nanos: 0 });
      if (trial.name === "policy") expect((await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { enabled: false } })).response.status).toBe(200);
      if (trial.name === "plan") expect((await request(gateway.base, `/api/admin/users/${user.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId: null } })).response.status).toBe(200);
    }
  } finally { await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { enabled: false } }); }
}, 60_000);

test("an unchanged definite retry reuses its one reservation", async () => {
  const key = await keyFor(user, { totalLimitUsd: 0.001 });
  const result = await gated(key.token, "/v1/chat/completions", completion("dispatch-unchanged"), async () => {});
  expect(result.status, result.body).toBe(200);
  expect(hits).toEqual(["/unchanged/v1/chat/completions", "/fallback-open/v1/chat/completions"]);
  expect(hold(key.id)).toMatchObject({ state: "settled", amount_nanos: 1_000_000, uncertain_nanos: 0, cost_in_nanos: 0, cost_out_nanos: 200_000 });
  expect(counter(key.id)).toEqual({ spent_nanos: 200_000, reserved_nanos: 0 });
}, 30_000);

test("a refused retry settles earlier uncertainty once and releases its active unit", async () => {
  const key = await keyFor(user, { totalLimitUsd: 0.02 });
  const result = await gated(key.token, "/v1/chat/completions", completion("dispatch-ambiguous"), async () => {
    expect((await request(gateway.base, `/api/keys/${key.id}`, { token: user.accessToken, method: "DELETE" })).response.status).toBe(200);
  });
  expect(result.status).toBe(401);
  expect(hits).toEqual(["/ambiguous-first/v1/chat/completions", "/ambiguous-second/v1/chat/completions"]);
  expect(hold(key.id)).toMatchObject({ state: "settled", amount_nanos: 2_000_000, uncertain_nanos: 1_000_000, cost_in_nanos: 1_000_000, cost_out_nanos: 0 });
  expect(counter(key.id)).toEqual({ spent_nanos: 1_000_000, reserved_nanos: 0 });
}, 30_000);

test("new caps and rolled-over windows block reuse of an old active unit", async () => {
  const unbounded = await keyFor();
  const changed = await gated(unbounded.token, "/v1/chat/completions", completion("dispatch-unbounded"), async () => {
    expect((await request(gateway.base, `/api/keys/${unbounded.id}`, { token: user.accessToken, method: "PATCH", body: { totalLimitUsd: 1 } })).response.status).toBe(200);
  });
  expect(changed.status).toBe(409); expect(hits).toHaveLength(1);
  expect(counter(unbounded.id)).toEqual({ spent_nanos: 0, reserved_nanos: 0 });
  const daily = await keyFor(user, { dailyLimitUsd: 0.02 });
  let previousStart: number | undefined;
  const rolled = await gated(daily.token, "/v1/chat/completions", completion("dispatch-window"), async () => {
    const row = sql.query<any, [string]>("SELECT id,created_at,periods FROM billing_reservations WHERE key_id=? AND state='pending'").get(daily.id)!;
    const periods = JSON.parse(row.periods) as Array<{ scope: string; owner: string; kind: string; start: number; end: number }>;
    const day = periods.find((p) => p.scope === "key" && p.owner === daily.id && p.kind === "daily")!;
    const start = day.start; day.start -= 86_400_000; day.end -= 86_400_000; previousStart = day.start;
    sql.transaction(() => {
      sql.prepare("UPDATE billing_periods SET starts_at=?,ends_at=? WHERE scope='key' AND owner_id=? AND kind='daily' AND starts_at=?").run(day.start, day.end, daily.id, start);
      sql.prepare("UPDATE billing_reservations SET created_at=?,periods=? WHERE id=?").run(row.created_at - 86_400_000, JSON.stringify(periods), row.id);
    }).immediate();
  });
  expect(rolled.status).toBe(409); expect(hits).toHaveLength(1);
  expect(sql.query<any, [string, number]>("SELECT spent_nanos,reserved_nanos FROM billing_periods WHERE scope='key' AND owner_id=? AND kind='daily' AND starts_at=?").get(daily.id, previousStart!)).toEqual({ spent_nanos: 0, reserved_nanos: 0 });
  expect(counter(daily.id)).toEqual({ spent_nanos: 0, reserved_nanos: 0 });
}, 30_000);

test("free token counts recheck authorization without enforcing a newly spent budget", async () => {
  const key = await keyFor();
  const result = await gated(key.token, "/anthropic/v1/messages/count_tokens", completion("dispatch-free"), async () => {
    expect((await request(gateway.base, `/api/keys/${key.id}`, { token: user.accessToken, method: "DELETE" })).response.status).toBe(200);
  });
  expect(result.status).toBe(401); expect(hits).toEqual(["/free/v1/messages/count_tokens"]);
  expect(hold(key.id)).toBeNull();
  const free = await keyFor();
  const allowed = await gated(free.token, "/anthropic/v1/messages/count_tokens", completion("dispatch-free-budget"), async () => {
    expect((await request(gateway.base, `/api/keys/${free.id}`, { token: user.accessToken, method: "PATCH", body: { totalLimitUsd: 0 } })).response.status).toBe(200);
  });
  expect(allowed.status, allowed.body).toBe(200);
  expect(hits).toEqual(["/free-budget/v1/messages/count_tokens", "/fallback-anth/v1/messages/count_tokens"]);
  expect(hold(free.id)).toBeNull();
  const alreadyExhausted = await keyFor(user, { totalLimitUsd: 0 });
  expect((await send(alreadyExhausted.token, "/anthropic/v1/messages/count_tokens", completion("dispatch-free-budget"))).status).toBe(200);
  expect(hold(alreadyExhausted.id)).toBeNull();
  const local = await keyFor();
  const deniedLocal = await gated(local.token, "/anthropic/v1/messages/count_tokens", completion("dispatch-free-local"), async () => {
    expect((await request(gateway.base, `/api/keys/${local.id}`, { token: user.accessToken, method: "DELETE" })).response.status).toBe(200);
  });
  expect(deniedLocal.status).toBe(401); expect(hits).toEqual(["/free-local/v1/messages/count_tokens"]);
  expect(hold(local.id)).toBeNull();
}, 30_000);

test("first dispatch rechecks authorization after asynchronous media conversion", async () => {
  const key = await keyFor(user, { totalLimitUsd: 0.1 }); imageEntered = false; hits = [];
  const pending = send(key.token, "/v1/chat/completions", { model: "dispatch-image", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `http://127.0.0.1:${upstream.port}/image` } }] }], max_tokens: 10 });
  try {
    await waitUntil(() => imageEntered, "media conversion did not start", 10000);
    expect((await request(gateway.base, `/api/keys/${key.id}`, { token: user.accessToken, method: "DELETE" })).response.status).toBe(200);
  } finally { releaseImage?.(); releaseImage = undefined; }
  expect((await pending).status).toBe(401); expect(hits).toHaveLength(0);
  expect(hold(key.id)).toMatchObject({ state: "settled", cost_in_nanos: 0, cost_out_nanos: 0 });
  expect(counter(key.id).reserved_nanos).toBe(0);
}, 30_000);

test("native and translated responses preserve nonzero usage and estimate only all-zero reports", async () => {
  const routes = ["/v1/responses", "/v1/chat/completions"] as const;
  for (const route of routes) for (const stream of [false, true]) for (const model of ["usage-output-only", "usage-input-only", "usage-reason-only", "usage-allzero", "usage-empty"] as const) {
    const key = await keyFor(user, { totalLimitUsd: 0.1 });
    const body = route === "/v1/responses" ? { model, input: "hi", max_output_tokens: 10, stream } : { model, messages: [{ role: "user", content: "hi" }], max_tokens: 10, stream };
    const response = await send(key.token, route, body);
    expect(response.status).toBe(200);
    const text = await response.text();
    const values = (stream ? text : response.headers.get("x-gateway-usage") ?? "").match(/(?:x-gateway-usage )?in=(\d+),cache=(\d+),out=(\d+)/);
    expect(values, text).not.toBeNull();
    const input = Number(values![1]), output = Number(values![3]);
    if (model === "usage-output-only") { expect(input).toBe(0); expect(output).toBe(2); expect(hold(key.id)).toMatchObject({ cost_in_nanos: 0, cost_out_nanos: 200_000 }); }
    else if (model === "usage-input-only") { expect(input).toBe(2); expect(output).toBe(0); expect(hold(key.id)).toMatchObject({ cost_in_nanos: 200_000, cost_out_nanos: 0 }); }
    else if (model === "usage-reason-only") { expect(input).toBe(0); expect(output).toBe(0); expect(hold(key.id)).toMatchObject({ cost_in_nanos: 0, cost_out_nanos: 200_000 }); }
    else if (model === "usage-empty") { expect(input).toBe(0); expect(output).toBe(0); expect(hold(key.id)).toMatchObject({ cost_in_nanos: 0, cost_out_nanos: 0 }); }
    else { expect(input).toBeGreaterThan(0); expect(output).toBeGreaterThan(0); }
    expect(counter(key.id).reserved_nanos).toBe(0);
  }
}, 60_000);

test("a plain-text upstream error is re-enveloped without invented usage", async () => {
  const key = await keyFor(user, { totalLimitUsd: 0.1 });
  const response = await send(key.token, "/v1/responses", { model: "usage-banner", input: "hi", max_output_tokens: 10 });
  expect(response.status).toBe(500);
  expect((await response.json() as any).error.message).toContain("upstream temporarily unavailable");
  expect(response.headers.get("x-gateway-usage")).toBe("in=0,cache=0,out=0");
  expect(hold(key.id)).toMatchObject({ state: "settled", amount_nanos: 11_000_000, uncertain_nanos: 11_000_000, cost_in_nanos: 11_000_000 });
  expect(counter(key.id).reserved_nanos).toBe(0);
}, 30_000);
