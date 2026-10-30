import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUser, login, request, startGateway, waitUntil } from "./gateway-enterprise-fixture";
import { removeEnterpriseMigrations } from "./billing-fixture";

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(async () => {
  for (const server of servers) server.stop(true);
  for (const gateway of gateways) await gateway.stop();
});

async function stack(env: Record<string, string> = {}) {
  const hits: Array<{ path: string; model: string }> = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (req.method === "GET") return Response.json({ data: [{ id: "economy", context_length: 100000, top_provider: { max_completion_tokens: 1000 }, pricing: { prompt: "0.000001", completion: "0.000002" } }] });
    const body = await req.json() as any;
    hits.push({ path: pathname, model: body.model });
    if (body.__delay) await Bun.sleep(body.__delay);
    if (pathname.startsWith("/first") && body.model === "private/primary") return Response.json({ error: { message: "temporarily unavailable", type: "server_error" } }, { status: 503 });
    const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
    if (body.stream) return new Response(`data: ${JSON.stringify({ id: "chat", model: body.model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ id: "chat", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage });
  } });
  servers.push(upstream);
  const gateway = await startGateway(env); gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const first = await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "first", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/first/v1`, apiKey: "first-test-key" } });
  const second = await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "second", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/second/v1`, apiKey: "second-test-key" } });
  expect(first.response.status).toBe(200); expect(second.response.status).toBe(200);
  expect((await request(gateway.base, `/api/admin/providers/${first.data.provider.id}/sync-models`, { token: admin.accessToken, body: {} })).response.status).toBe(200);
  expect((await request(gateway.base, "/api/admin/models", { token: admin.accessToken, body: {
    id: "public/premium", targets: [{ providerId: first.data.provider.id, upstreamModel: "private/primary" }, { providerId: second.data.provider.id, upstreamModel: "private/fallback" }],
    contextLength: 100000, maxOutputLength: 1000, pricing: { prompt: "0.000001", completion: "0.000002" },
  } })).response.status).toBe(200);
  expect((await request(gateway.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "router" } })).response.status).toBe(200);
  return { gateway, admin, hits, firstId: first.data.provider.id as string };
}

async function makeScope(base: string, admin: string, body: Record<string, unknown>) {
  const result = await request(base, "/api/projects", { token: admin, body });
  expect(result.response.status, result.text).toBe(200);
  return result.data.project as { id: string };
}
async function member(base: string, admin: string, projectId: string, userId: string, role = "member") {
  const result = await request(base, `/api/projects/${projectId}/members/${userId}`, { token: admin, method: "PUT", body: { role } });
  expect(result.response.status, result.text).toBe(200);
}
async function llm(base: string, token: string, model = "economy", extra: Record<string, unknown> = {}, route = "/v1/chat/completions") {
  return fetch(`${base}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], max_tokens: 32, ...extra }) });
}

test("manager scope, financial visibility, membership and audit remain bounded", async () => {
  const { gateway, admin } = await stack({ FINANCIAL_DEFAULT_BUDGET: "hidden", FINANCIAL_DEFAULT_SHOW_PRICES: "false" });
  const base = gateway.base, root = admin.accessToken;
  let manager = await createUser(base, root, "manager@enterprise.test");
  const employee = await createUser(base, root, "member@enterprise.test");
  const stranger = await createUser(base, root, "other@enterprise.test");
  expect((await request(base, `/api/admin/users/${manager.user.id}`, { token: root, method: "PATCH", body: { role: "project_manager" } })).response.status).toBe(200);
  manager = await login(base, "manager@enterprise.test");
  expect((await request(base, "/api/me", { token: manager.accessToken })).data.user.role).toBe("project_manager");
  const center = await makeScope(base, root, { code: "CC-A", name: "Center A", kind: "cost_center", monthlyLimitUsd: 50, totalLimitUsd: 100 });
  const project = await makeScope(base, root, { code: "PR-A", name: "Project A", kind: "project", costCenterId: center.id, monthlyLimitUsd: 20 });
  const other = await makeScope(base, root, { code: "PR-B", name: "Project B", kind: "project" });
  await member(base, root, project.id, manager.user.id, "manager");
  await member(base, root, project.id, employee.user.id);
  expect((await request(base, "/api/admin/users", { token: manager.accessToken })).response.status).toBe(403);
  expect((await request(base, `/api/projects/${other.id}/members`, { token: manager.accessToken })).response.status).toBe(404);
  expect((await request(base, `/api/projects/${project.id}/usage`, { token: employee.accessToken })).response.status).toBe(404);
  expect((await request(base, `/api/projects/${project.id}`, { token: manager.accessToken, method: "PATCH", body: { monthlyLimitUsd: 999 } })).response.status).toBe(403);
  expect((await request(base, `/api/projects/${project.id}/members/${stranger.user.id}`, { token: manager.accessToken, method: "PUT", body: { role: "manager" } })).response.status).toBe(403);
  expect((await request(base, `/api/projects/${project.id}/members/${manager.user.id}`, { token: manager.accessToken, method: "DELETE" })).response.status).toBe(403);
  const candidates = await request(base, `/api/projects/${project.id}/member-candidates?q=other`, { token: manager.accessToken });
  expect(candidates.data.users).toEqual([{ id: stranger.user.id, email: "other@enterprise.test", name: "other@enterprise.test" }]);
  await member(base, manager.accessToken, project.id, stranger.user.id);
  const managerList = await request(base, "/api/projects", { token: manager.accessToken });
  expect(managerList.data.projects.map((p: any) => p.id)).toEqual([project.id]);
  expect(JSON.stringify(managerList.data)).not.toContain("limitUsd");
  const forbiddenKey = await request(base, "/api/keys", { token: employee.accessToken, body: { name: "not member", projectId: other.id } });
  expect(forbiddenKey.response.status).toBe(403);
  const key = await request(base, "/api/keys", { token: employee.accessToken, body: { name: "project key", projectId: project.id } });
  expect(key.data.key.projectId).toBe(project.id);
  expect((await llm(base, key.data.token)).status).toBe(200);
  await Bun.sleep(1200);
  const report = await request(base, `/api/projects/${project.id}/usage`, { token: manager.accessToken });
  expect(report.response.status).toBe(200); expect(report.data.usage.requests).toBe(1); expect(report.data.usage.costUsd).toBeUndefined();
  const adminReport = await request(base, `/api/projects/${project.id}/usage`, { token: root });
  expect(adminReport.data.usage.requests).toBe(1); expect(adminReport.data.usage.costUsd).toBeGreaterThan(0);
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    expect((await request(base, `/api/projects/${project.id}/members/${stranger.user.id}`, { token: manager.accessToken, method: "DELETE" })).response.status).toBe(200);
    sql.exec("CREATE TRIGGER fail_project_audit BEFORE INSERT ON audit_log WHEN NEW.action='project.member_set' BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
    const failed = await request(base, `/api/projects/${project.id}/members/${stranger.user.id}`, { token: manager.accessToken, method: "PUT", body: { role: "member" } });
    expect(failed.response.status).toBe(500);
    expect(sql.query("SELECT 1 FROM project_members WHERE project_id=? AND user_id=?").get(project.id, stranger.user.id)).toBeNull();
    expect(sql.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM audit_log WHERE action='project.member_set' AND target=?").get(project.id)!.n).toBe(3);
    sql.exec("DROP TRIGGER fail_project_audit");
    expect((await request(base, `/api/admin/users/${manager.user.id}`, { token: root, method: "PATCH", body: { role: "user" } })).response.status).toBe(200);
    expect((await request(base, `/api/projects/${project.id}/members`, { token: manager.accessToken })).response.status).toBe(401);
    manager = await login(base, "manager@enterprise.test");
    expect((await request(base, `/api/projects/${project.id}/members`, { token: manager.accessToken })).response.status).toBe(404);
    expect(sql.query<{ role: string }, [string, string]>("SELECT role FROM project_members WHERE project_id=? AND user_id=?").get(project.id, manager.user.id)!.role).toBe("member");
  } finally { sql.close(); }
}, 90_000);

test("project grants combine with personal public model policy without alias, stale-ID or fallback bypass", async () => {
  const { gateway, admin, hits, firstId } = await stack();
  const base = gateway.base, root = admin.accessToken;
  const user = await createUser(base, root, "model-member@enterprise.test");
  const project = await makeScope(base, root, { code: "MODEL", name: "Models", kind: "project" });
  await member(base, root, project.id, user.user.id);
  const projectKey = (await request(base, "/api/keys", { token: user.accessToken, body: { name: "project", projectId: project.id } })).data.token as string;
  const personalKey = (await request(base, "/api/keys", { token: user.accessToken, body: { name: "personal" } })).data.token as string;
  const projectPolicy = await request(base, "/api/admin/model-policies", { token: root, body: { kind: "project", projectId: project.id, name: "premium grant", models: ["public/premium"] } });
  expect(projectPolicy.response.status).toBe(200);
  // An absent default is unrestricted, even when a project policy exists.
  expect((await llm(base, personalKey, "public/premium")).status).toBe(200);
  const defaultPolicy = await request(base, "/api/admin/model-policies", { token: root, body: { kind: "default", name: "standard", models: ["economy"] } });
  expect(defaultPolicy.response.status).toBe(200);
  expect((await llm(base, personalKey, "public/premium")).status).toBe(404);
  expect((await llm(base, projectKey, "economy")).status).toBe(200);
  const streamed = await llm(base, projectKey, "public/premium", { stream: true });
  expect(streamed.status).toBe(200); expect(await streamed.text()).toContain("[DONE]");
  expect(hits.some((h) => h.model === "private/fallback")).toBe(true);
  for (const route of ["/v1/chat/completions", "/openai/v1/chat/completions", "/v1/responses", "/v1/messages", "/anthropic/v1/messages", "/v1/embeddings", "/v1/completions"]) {
    expect((await llm(base, personalKey, "public/premium", {}, route)).status, route).toBe(404);
  }
  expect((await llm(base, projectKey, "private/fallback")).status).toBe(404);
  expect((await fetch(`${base}/v1/models/${encodeURIComponent("public/premium")}`, { headers: { Authorization: `Bearer ${personalKey}` } })).status).toBe(404);
  expect((await fetch(`${base}/v1/models/${encodeURIComponent("public/premium")}`, { headers: { Authorization: `Bearer ${projectKey}` } })).status).toBe(200);
  const personalModels = (await request(base, "/api/me/models", { token: user.accessToken })).data.models.map((m: any) => m.id);
  const projectModels = (await request(base, `/api/me/models?projectId=${project.id}`, { token: user.accessToken })).data.models.map((m: any) => m.id);
  expect(personalModels).not.toContain("public/premium"); expect(projectModels).toContain("public/premium");
  // Rename carries the grant, deletion leaves a tombstone, and recreation does
  // not silently restore access to the deleted selection.
  expect((await request(base, `/api/admin/models/${encodeURIComponent("public/premium")}`, { token: root, method: "PATCH", body: { id: "public/renamed" } })).response.status).toBe(200);
  expect((await llm(base, projectKey, "public/renamed")).status).toBe(200);
  expect((await request(base, `/api/admin/models/${encodeURIComponent("public/renamed")}`, { token: root, method: "DELETE" })).response.status).toBe(200);
  const afterDelete = await request(base, `/api/admin/model-policies/${projectPolicy.data.policy.id}`, { token: root });
  expect(afterDelete.data.policy.missingModels).toEqual(["public/renamed"]);
  expect((await request(base, "/api/admin/models", { token: root, body: { id: "public/renamed", providerId: firstId, upstreamModel: "private/primary" } })).response.status).toBe(200);
  expect((await llm(base, projectKey, "public/renamed")).status).toBe(404);
  expect((await request(base, `/api/admin/model-policies/${projectPolicy.data.policy.id}`, { token: root, method: "PATCH", body: { name: "still tombstoned" } })).response.status).toBe(200);
  expect((await llm(base, projectKey, "public/renamed")).status).toBe(404);
  expect((await request(base, "/api/admin/models/economy", { token: root, method: "DELETE" })).response.status).toBe(200);
  expect((await request(base, "/api/admin/models", { token: root, body: { id: "economy", providerId: firstId } })).response.status).toBe(200);
  expect((await llm(base, personalKey, "economy")).status).toBe(404);
  expect((await request(base, `/api/admin/model-policies/${defaultPolicy.data.policy.id}`, { token: root, method: "PATCH", body: { models: ["economy"] } })).response.status).toBe(200);
  expect((await request(base, `/api/projects/${project.id}/members/${user.user.id}`, { token: root, method: "DELETE" })).response.status).toBe(200);
  expect((await llm(base, projectKey, "economy")).status).toBe(403);
  expect((await llm(base, personalKey, "economy")).status).toBe(200);
}, 90_000);

test("shared budgets reserve atomically and retain in-flight project and cost-center attribution", async () => {
  const { gateway, admin, hits } = await stack();
  const base = gateway.base, root = admin.accessToken;
  const one = await createUser(base, root, "budget-one@enterprise.test");
  const two = await createUser(base, root, "budget-two@enterprise.test");
  const c1 = await makeScope(base, root, { code: "C1", name: "First center", kind: "cost_center", totalLimitUsd: .05 });
  const c2 = await makeScope(base, root, { code: "C2", name: "Second center", kind: "cost_center" });
  const p1 = await makeScope(base, root, { code: "P1", name: "First project", kind: "project", costCenterId: c1.id, monthlyLimitUsd: .005 });
  const p2 = await makeScope(base, root, { code: "P2", name: "Second project", kind: "project", costCenterId: c2.id });
  await member(base, root, p1.id, one.user.id); await member(base, root, p1.id, two.user.id); await member(base, root, p2.id, one.user.id);
  const key1 = (await request(base, "/api/keys", { token: one.accessToken, body: { name: "one", projectId: p1.id } })).data;
  const key2 = (await request(base, "/api/keys", { token: two.accessToken, body: { name: "two", projectId: p1.id } })).data;
  const before = hits.length;
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => llm(base, i % 2 ? key1.token : key2.token, "economy", { __delay: 500 })));
  const accepted = responses.filter((r) => r.status === 200).length;
  expect(accepted).toBe(1); expect(responses.filter((r) => r.status === 429)).toHaveLength(5); expect(hits.length - before).toBe(1);
  for (const response of responses) await response.text();
  // Raise the project cap and tighten only its parent's lifetime cap; another
  // burst must still admit at most one request across both accounts.
  expect((await request(base, `/api/projects/${p1.id}`, { token: root, method: "PATCH", body: { monthlyLimitUsd: .05 } })).response.status).toBe(200);
  expect((await request(base, `/api/projects/${c1.id}`, { token: root, method: "PATCH", body: { totalLimitUsd: .005 } })).response.status).toBe(200);
  const centerBurst = await Promise.all(Array.from({ length: 4 }, (_, i) => llm(base, i % 2 ? key1.token : key2.token, "economy", { __delay: 500 })));
  expect(centerBurst.filter((r) => r.status === 200)).toHaveLength(1);
  expect(centerBurst.filter((r) => r.status === 429)).toHaveLength(3);
  for (const response of centerBurst) await response.text();
  expect((await request(base, `/api/keys/${key2.key.id}`, { token: two.accessToken, method: "PATCH", body: { totalLimitUsd: .001 } })).response.status).toBe(200);
  const beforeKeyDenied = hits.length;
  expect((await llm(base, key2.token)).status).toBe(429); expect(hits.length).toBe(beforeKeyDenied);
  // Move the key and the project's parent after a second request has been
  // admitted but before its upstream response completes.
  const pending = llm(base, key1.token, "economy", { __delay: 600 });
  await waitUntil(() => hits.length === before + 3, "second request was not admitted");
  expect((await request(base, `/api/keys/${key1.key.id}`, { token: one.accessToken, method: "PATCH", body: { projectId: p2.id } })).response.status).toBe(200);
  expect((await request(base, `/api/projects/${p1.id}`, { token: root, method: "PATCH", body: { costCenterId: c2.id, status: "archived" } })).response.status).toBe(200);
  expect((await pending).status).toBe(200);
  await Bun.sleep(1200);
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    const rows = sql.query<{ project_id: string; cost_center_id: string; state: string }, [string]>("SELECT project_id,cost_center_id,state FROM billing_reservations WHERE key_id=? ORDER BY created_at").all(key1.key.id);
    expect(rows.at(-1)).toEqual({ project_id: p1.id, cost_center_id: c1.id, state: "settled" });
    const history = sql.query<{ project_id: string; cost_center_id: string }, [string]>("SELECT project_id,cost_center_id FROM usage_events WHERE key_id=? ORDER BY id DESC LIMIT 1").get(key1.key.id);
    expect(history).toEqual({ project_id: p1.id, cost_center_id: c1.id });
    const counters = sql.query<{ owner_id: string; spent_nanos: number; reserved_nanos: number }, [string, string]>("SELECT owner_id,spent_nanos,reserved_nanos FROM billing_periods WHERE scope='project' AND kind='lifetime' AND owner_id IN (?,?) ORDER BY owner_id").all(c1.id, c2.id);
    expect(counters.find((c) => c.owner_id === c1.id)?.spent_nanos).toBeGreaterThan(0);
    expect(counters.find((c) => c.owner_id === c1.id)?.reserved_nanos).toBe(0);
    expect(counters.find((c) => c.owner_id === c2.id)).toBeUndefined();
  } finally { sql.close(); }
  const oldCenter = await request(base, `/api/projects/${c1.id}/usage`, { token: root });
  const newCenter = await request(base, `/api/projects/${c2.id}/usage`, { token: root });
  expect(oldCenter.data.usage.requests).toBe(3); expect(newCenter.data.usage.requests).toBe(0);
  expect((await llm(base, key2.token)).status).toBe(403);
  expect((await llm(base, key1.token)).status).toBe(200);
}, 90_000);

test("populated pre-enterprise database migrates without rebuilding users or changing old ledger attribution", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "indirect-project-migration-"));
  const boot = () => Bun.spawnSync([process.execPath, "-e", 'import "./server/db.ts";'], { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, NODE_ENV: "test", DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  let sql: Database | undefined;
  try {
    expect(boot().exitCode).toBe(0);
    sql = new Database(path.join(dir, "gateway.db"));
    removeEnterpriseMigrations(sql);
    sql.exec(`PRAGMA user_version=32;
      INSERT INTO users(id,email,name,created_at) VALUES('legacy-user','legacy@example.test','Legacy',1);
      INSERT INTO sessions(jti,user_id,refresh_hash,created_at,last_used_at,expires_at,abs_expires_at) VALUES('legacy-session','legacy-user','legacy-refresh',1,1,9999999999999,9999999999999);
      INSERT INTO api_keys(id,user_id,name,prefix,hash,created_at) VALUES('legacy-key','legacy-user','legacy','prefix','legacy-hash',1);
      INSERT INTO usage_events(key_id,user_id,ts,proto,model,in_tok,out_tok) VALUES('legacy-key','legacy-user',1,'openai','old-model',3,2);`);
    sql.close(); sql = undefined;
    const result = boot(); expect(result.exitCode, result.stderr.toString()).toBe(0);
    sql = new Database(path.join(dir, "gateway.db"));
    expect(sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sql.query("SELECT id,role,enterprise_role FROM users WHERE id='legacy-user'").get()).toEqual({ id: "legacy-user", role: "user", enterprise_role: null });
    expect(sql.query("SELECT project_id,cost_center_id,in_tok FROM usage_events WHERE key_id='legacy-key'").get()).toEqual({ project_id: null, cost_center_id: null, in_tok: 3 });
    expect(sql.query("SELECT user_id FROM sessions WHERE jti='legacy-session'").get()).toEqual({ user_id: "legacy-user" });
  } finally { sql?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
