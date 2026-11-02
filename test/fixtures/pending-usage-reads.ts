import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { db, stmts } from "../../server/db";
import { insertSessionRow, prepareSessionTokens } from "../../server/auth";
import { randomToken } from "../../server/crypto";
import { setFinancialPolicy, type BudgetPresentation } from "../../server/financial-policy";
import { ApiError, err } from "../../server/http";
import { runWithRequest } from "../../server/request-context";
import { handleProjectsRoute } from "../../server/routes/projects";
import { handleUsageRoute } from "../../server/routes/usage";
import { handleAdminRoute } from "../../server/routes/admin";
import { handleKeysRoute } from "../../server/routes/keys";
import { flushUsage, recordUsage } from "../../server/usage";
import { closeUsageReaders, type UsageReadRequest } from "../../server/usage-reader";

interface PausedRead { request: UsageReadRequest; release(): void }
const postMessage = Worker.prototype.postMessage;
let waiting: ((read: PausedRead) => void) | undefined;
const paused: PausedRead[] = [];
// Pause real reader jobs at dispatch, then run the actual read-only worker.
// The gateway's routes and authorization are not mocked or given test hooks.
Worker.prototype.postMessage = function(message: { id?: number; request?: UsageReadRequest }, transferList?: readonly any[]) {
  if (!message.request) return postMessage.call(this, message, transferList);
  const read = { request: message.request, release: () => postMessage.call(this, message, transferList) };
  if (waiting) { const resolve = waiting; waiting = undefined; resolve(read); }
  else paused.push(read);
};
function nextRead(): Promise<PausedRead> {
  const ready = paused.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting = undefined; reject(new Error("route did not dispatch its expected reader job")); }, 3000);
    waiting = (read) => { clearTimeout(timer); resolve(read); };
  });
}

const from = Date.UTC(2026, 0, 5), to = from + 86_400_000;
const range = `from=${from}&to=${to}`;
async function subject(presentation: BudgetPresentation = "usd", admin = false) {
  const userId = randomToken(12), projectId = `fp_${randomToken(16)}`;
  db.prepare("INSERT INTO users(id,email,name,role,enterprise_role,status,created_at) VALUES (?,?,?,?,?,'active',?)").run(userId, `${userId}@pending.test`, "Pending reader", admin ? "admin" : "user", admin ? null : "project_manager", Date.now());
  db.prepare("INSERT INTO financial_projects(id,kind,code,name,created_at,updated_at) VALUES (?,'project',?,'Pending project',?,?)").run(projectId, projectId, Date.now(), Date.now());
  db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES (?,?,'manager',?)").run(projectId, userId, Date.now());
  const prepared = await prepareSessionTokens(stmts.userById.get(userId)!);
  insertSessionRow(userId, prepared);
  setFinancialPolicy(userId, { showModelPrices: presentation === "usd", budgetPresentation: presentation });
  recordUsage({ keyId: `key-${userId}`, userId, projectId, model: "pending-model", proto: "openai", inTok: 7, cacheTok: 2, outTok: 3, latencyMs: 1, status: 200, stream: false, estimated: false, ts: from + 1000, charge: { input: 1_000_000_000n, cache: 0n, output: 0n } });
  flushUsage();
  return { userId, projectId, token: prepared.accessToken, jti: prepared.jti };
}
type Subject = Awaited<ReturnType<typeof subject>>;
function report(s: Subject, route: string) {
  const req = new Request(`http://localhost${route}`, { headers: { Authorization: `Bearer ${s.token}` } });
  const url = new URL(req.url);
  return runWithRequest({ requestId: randomToken(16), startedAt: performance.now() }, async () => {
    try {
      const result = url.pathname.startsWith("/api/projects/") ? await handleProjectsRoute(url.pathname, req)
        : url.pathname.startsWith("/api/admin/") ? await handleAdminRoute(url.pathname, req, url)
          : url.pathname.startsWith("/api/keys/") ? await handleKeysRoute(url.pathname, req)
          : await handleUsageRoute(url.pathname, req, url);
      assert.ok(result);
      return result;
    } catch (error) {
      if (error instanceof ApiError) return err(error.status, error.message, req);
      throw error;
    }
  });
}
const projectRoute = (s: Subject) => `/api/projects/${s.projectId}/usage?from=2026-01-05&to=2026-01-05`;
const ownRoute = (kind: string) => `/api/usage/${kind}?${range}`;
const moneyGrid = `&sort=${encodeURIComponent(JSON.stringify([{ colId: "cost", sort: "desc" }]))}&filters=${encodeURIComponent(JSON.stringify({ cost: { filterType: "number", type: "greaterThan", filter: 10 } }))}`;
const changePolicy = (s: Subject, value: BudgetPresentation) => setFinancialPolicy(s.userId, { showModelPrices: value === "usd", budgetPresentation: value });
function noMoney(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["cost", "costUsd", "cost_in", "cost_out", "cost_cache", "costNanos"].includes(key), `unexpected money field: ${key}`);
    noMoney(child);
  }
}

try {
  db.prepare("UPDATE usage_rollup_coverage SET raw_from=0 WHERE id=1").run();
  for (const [index, kind] of ["analytics", "overview", "filter-options", "daily", "events", "breakdown"].entries()) {
    const s = await subject(), response = report(s, ownRoute(kind)), read = await nextRead();
    if (index % 2 === 0) db.prepare("UPDATE sessions SET revoked=1 WHERE jti=?").run(s.jti);
    else db.prepare("UPDATE users SET status='banned' WHERE id=?").run(s.userId);
    read.release();
    const result = await response;
    assert.equal(result.status, index % 2 === 0 ? 401 : 403, kind);
    assert.equal((await result.json() as any).success, false);
  }
  for (const change of ["membership", "manager", "role", "session", "ban"]) {
    const s = await subject(), response = report(s, projectRoute(s)), read = await nextRead();
    if (change === "membership") db.prepare("DELETE FROM project_members WHERE project_id=? AND user_id=?").run(s.projectId, s.userId);
    if (change === "manager") db.prepare("UPDATE project_members SET role='member' WHERE project_id=? AND user_id=?").run(s.projectId, s.userId);
    if (change === "role") db.prepare("UPDATE users SET enterprise_role=NULL WHERE id=?").run(s.userId);
    if (change === "session") db.prepare("UPDATE sessions SET revoked=1 WHERE jti=?").run(s.jti);
    if (change === "ban") db.prepare("UPDATE users SET status='banned' WHERE id=?").run(s.userId);
    read.release();
    assert.equal((await response).status, change === "ban" ? 403 : ["role", "session"].includes(change) ? 401 : 404, change);
  }
  {
    const s = await subject(), response = report(s, "/api/keys/filter-options?field=status"), read = await nextRead();
    db.prepare("UPDATE sessions SET revoked=1 WHERE jti=?").run(s.jti);
    read.release();
    assert.equal((await response).status, 401, "pending key facets must reject revoked sessions");
  }
  for (const kind of ["analytics", "overview", "daily", "events", "breakdown", "project"]) {
    const s = await subject();
    const route = kind === "project" ? projectRoute(s) : ownRoute(kind) + (["events", "breakdown"].includes(kind) ? moneyGrid : "");
    const response = report(s, route), read = await nextRead();
    changePolicy(s, "hidden");
    read.release();
    if (!["overview", "daily"].includes(kind)) {
      const retry = await nextRead();
      if (retry.request.kind === "events") assert.equal(retry.request.opts.filters, undefined);
      if (retry.request.kind === "breakdown") assert.equal(retry.request.grid.filters, undefined);
      retry.release();
    }
    const result = await response, body = await result.json() as any;
    assert.equal(result.status, 200, kind);
    assert.equal(result.headers.get("X-Financial-Policy"), "hidden;prices=0", kind);
    noMoney(body);
    if (kind === "project") { assert.equal(body.usage.requests, 1); assert.equal(body.financialPolicy.budgetPresentation, "hidden"); }
    if (kind === "events") { assert.equal(body.events.length, 1); assert.equal(body.total, 1); }
    if (kind === "breakdown") { assert.equal(body.rows.length, 1); assert.equal(body.total, 1); }
    if (kind === "analytics") assert.deepEqual(body.modelSpend, { groups: [], points: [] });
  }
  for (const kind of ["analytics", "project"]) {
    const s = await subject("hidden"), response = report(s, kind === "project" ? projectRoute(s) : ownRoute(kind)), read = await nextRead();
    assert.equal(read.request.kind === "analytics" || read.request.kind === "financial-project" ? read.request.includeCost : undefined, false);
    changePolicy(s, "usd");
    read.release();
    const retry = await nextRead();
    assert.equal(retry.request.kind === "analytics" || retry.request.kind === "financial-project" ? retry.request.includeCost : undefined, true);
    retry.release();
    const result = await response, body = await result.json() as any;
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("X-Financial-Policy"), "usd;prices=1");
    if (kind === "project") assert.equal(body.usage.costUsd, 1);
    else assert.equal(body.series.reduce((sum: number, row: any) => sum + row.cost, 0), 1);
  }
  const s = await subject("hidden"), response = report(s, projectRoute(s)), read = await nextRead();
  changePolicy(s, "usd"); read.release();
  const retry = await nextRead();
  changePolicy(s, "hidden"); retry.release();
  assert.equal((await response).status, 409, "a second policy flip must fail closed without another retry");
  for (const [index, route] of [
    `/api/admin/analytics?${range}`,
    `/api/admin/stats?${range}`,
    `/api/admin/usage-filter-options?${range}`,
    "/api/admin/users/filter-options",
    `/api/admin/usage-breakdown/users?${range}`,
    "/api/admin/audit?selection=%7B%7D&limit=5",
  ].entries()) {
    const admin = await subject("usd", true), pending = report(admin, route), job = await nextRead();
    if (index % 2 === 0) db.prepare("UPDATE users SET role='user' WHERE id=?").run(admin.userId);
    else db.prepare("UPDATE sessions SET revoked=1 WHERE jti=?").run(admin.jti);
    job.release();
    assert.equal((await pending).status, 401, `pending administrator report: ${route}`);
  }
  assert.equal(paused.length, 0);
  console.log("pending usage reads passed");
} finally {
  Worker.prototype.postMessage = postMessage;
  await closeUsageReaders();
  db.close();
}
