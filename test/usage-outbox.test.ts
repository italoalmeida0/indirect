import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
function worker(dir: string, mode: string) {
  return Bun.spawn([process.execPath, "test/fixtures/usage-outbox-worker.ts", mode], { cwd: root, env: { ...process.env, NODE_ENV: "test", DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
}
async function ready(child: ReturnType<typeof worker>) {
  const reader = child.stdout.getReader();
  let output = "";
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) throw new Error(`outbox worker exited before the crash checkpoint: ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(item.value);
      const line = output.split("\n").slice(0, -1).find((value) => value.startsWith('{"ready":true'));
      if (line) return JSON.parse(line) as { ready: boolean; id?: string; remaining?: boolean; deleted?: number; rawFrom?: number };
    }
  } finally { reader.releaseLock(); }
}
async function run(dir: string, mode: string) {
  const child = worker(dir, mode);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as { remaining?: boolean; deleted?: number; rawFrom?: number };
}
function read<T>(dir: string, sql: string): T {
  const connection = new Database(path.join(dir, "gateway.db"), { readonly: true });
  try { return connection.query(sql).get() as T; } finally { connection.close(); }
}
const pending = (dir: string) => read<{ n: number }>(dir, "SELECT pending AS n FROM usage_outbox_pending WHERE id=1").n;

test("a committed charge survives SIGKILL before delivery and a second crash inside delivery without loss or duplicates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "indirect-outbox-crash-"));
  const settled = worker(dir, "settle");
  const receipt = await ready(settled);
  settled.kill("SIGKILL"); await settled.exited;
  expect(pending(dir)).toBe(1);
  expect(read<{ state: string; cost_in_nanos: number; cost_out_nanos: number }>(dir, "SELECT state,cost_in_nanos,cost_out_nanos FROM billing_reservations")).toEqual({ state: "settled", cost_in_nanos: 2000, cost_out_nanos: 2000 });
  expect(receipt.id).toBeTruthy();
  const retentionBlocked = await run(dir, "prune");
  expect(retentionBlocked.remaining).toBe(true);
  expect(retentionBlocked.rawFrom).toBe(0);
  const interrupted = worker(dir, "drain-uncommitted");
  await ready(interrupted);
  interrupted.kill("SIGKILL"); await interrupted.exited;
  expect(pending(dir)).toBe(1);
  expect(read<{ n: number }>(dir, "SELECT COUNT(*) AS n FROM usage_events").n).toBe(0);
  await run(dir, "drain");
  await run(dir, "drain");
  expect(pending(dir)).toBe(0);
  expect(read<{ n: number; inTok: number; outTok: number }>(dir, "SELECT COUNT(*) AS n,SUM(in_tok) AS inTok,SUM(out_tok) AS outTok FROM usage_events")).toEqual({ n: 1, inTok: 2, outTok: 1 });
  for (const table of ["usage_model_provider_daily", "usage_model_provider_monthly", "usage_financial_daily", "usage_financial_monthly", "usage_hour_rollups", "usage_minute_rollups"]) {
    expect(read<{ reqs: number; cost: number }>(dir, `SELECT SUM(reqs) AS reqs,SUM(cost_in_nanos+cost_cache_nanos+cost_out_nanos) AS cost FROM ${table}`)).toEqual({ reqs: 1, cost: 4000 });
  }
  const pruned = await run(dir, "prune");
  expect(pruned.deleted).toBe(1); expect(pruned.remaining).toBe(false);
  expect(read<{ reqs: number }>(dir, "SELECT SUM(reqs) AS reqs FROM usage_model_provider_monthly").reqs).toBe(1);
}, 45_000);

test("invalid provider metrics cannot poison the durable queue or change its frozen conservative charge", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "indirect-outbox-invalid-"));
  const child = worker(dir, "settle-invalid");
  await ready(child);
  child.kill("SIGKILL"); await child.exited;
  const bound = read<{ amount_nanos: number }>(dir, "SELECT amount_nanos FROM billing_reservations").amount_nanos;
  await run(dir, "drain");
  expect(pending(dir)).toBe(0);
  expect(read<{ in_tok: number; out_tok: number; estimated: number; cost: number }>(dir,
    "SELECT in_tok,out_tok,estimated,cost_in_nanos+cost_cache_nanos+cost_out_nanos AS cost FROM usage_events")).toEqual({ in_tok: 2, out_tok: 0, estimated: 1, cost: bound });
}, 30_000);

test("a failed outbox insertion rolls back settlement and a later retry delivers exactly once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "indirect-outbox-rollback-"));
  const child = worker(dir, "settle-blocked");
  await ready(child);
  child.kill("SIGKILL"); await child.exited;
  expect(pending(dir)).toBe(0);
  expect(read<{ state: string }>(dir, "SELECT state FROM billing_reservations").state).toBe("pending");
  const counters = read<{ spent: number; reserved: number }>(dir, "SELECT SUM(spent_nanos) AS spent,SUM(reserved_nanos) AS reserved FROM billing_periods");
  expect(counters.spent).toBe(0); expect(counters.reserved).toBeGreaterThan(0);
  const sql = new Database(path.join(dir, "gateway.db"));
  try { sql.exec("DROP TRIGGER outbox_test_fault"); } finally { sql.close(); }
  await run(dir, "retry");
  await run(dir, "drain");
  expect(pending(dir)).toBe(0);
  expect(read<{ n: number }>(dir, "SELECT COUNT(*) AS n FROM usage_events").n).toBe(1);
  expect(read<{ reserved: number }>(dir, "SELECT SUM(reserved_nanos) AS reserved FROM billing_periods").reserved).toBe(0);
}, 30_000);

test("crashed reservations recover with frozen project attribution, conservative costs and explicit unknown usage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "indirect-outbox-recovery-"));
  const child = worker(dir, "reserve");
  await ready(child);
  child.kill("SIGKILL"); await child.exited;
  const before = read<{ amount_nanos: number }>(dir, "SELECT amount_nanos FROM billing_reservations").amount_nanos;
  const sql = new Database(path.join(dir, "gateway.db"));
  try {
    sql.exec(`UPDATE billing_instances SET heartbeat=0;
      INSERT INTO financial_projects(id,kind,code,name,created_at,updated_at) VALUES('new-project','project','NEW','New project',1,1);
      INSERT INTO project_members(project_id,user_id,role,created_at) VALUES('new-project','outbox-user','member',1);
      UPDATE api_keys SET project_id='new-project' WHERE id='outbox-key';
      UPDATE financial_projects SET status='archived' WHERE id='outbox-project';`);
  } finally { sql.close(); }
  await run(dir, "recover");
  await run(dir, "recover");
  expect(pending(dir)).toBe(0);
  expect(read<{ project_id: string; in_tok: number; out_tok: number; estimated: number; status: number; cost: number }>(dir,
    "SELECT project_id,in_tok,out_tok,estimated,status,cost_in_nanos+cost_cache_nanos+cost_out_nanos AS cost FROM usage_events")).toEqual({ project_id: "outbox-project", in_tok: 0, out_tok: 0, estimated: 1, status: 599, cost: before });
  expect(read<{ n: number }>(dir, "SELECT COUNT(*) AS n FROM usage_events").n).toBe(1);
  expect(read<{ state: string }>(dir, "SELECT state FROM billing_reservations").state).toBe("recovered");
  expect(read<{ reserved: number }>(dir, "SELECT SUM(reserved_nanos) AS reserved FROM billing_periods").reserved).toBe(0);
}, 45_000);
