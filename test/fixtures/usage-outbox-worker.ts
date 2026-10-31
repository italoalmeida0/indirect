import { db, type ApiKeyRow, type ModelRow } from "../../server/db";
import { recoverBudgets, reserveBudget, settleBudget } from "../../server/billing";
import { flushUsage, type UsageEvent } from "../../server/usage";
import { pruneUsageEvents } from "../../server/usage-rollup";
import { writeSync } from "node:fs";

const mode = process.argv[2];
const now = Date.now(), timestamp = now - 5 * 86_400_000;
db.exec(`INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES('outbox-user','outbox@example.test','Outbox user',1);
  INSERT OR IGNORE INTO financial_projects(id,kind,code,name,monthly_nanos,total_nanos,created_at,updated_at)
    VALUES('outbox-project','project','OUTBOX','Original project',100000000000,100000000000,1,1);
  INSERT OR IGNORE INTO project_members(project_id,user_id,role,created_at) VALUES('outbox-project','outbox-user','member',1);
  INSERT OR IGNORE INTO api_keys(id,user_id,name,prefix,hash,project_id,created_at) VALUES('outbox-key','outbox-user','Outbox key','gw_test','outbox-test-hash','outbox-project',1);
  INSERT INTO models(id,upstream_model,name,context_length,max_output_length,pricing_input,pricing_output,created_at,updated_at)
    VALUES('outbox-model','outbox-model','Outbox model',32000,1000,0.000001,0.000002,1,1) ON CONFLICT(id) DO NOTHING;`);
const event: Omit<UsageEvent, "charge"> = { keyId: "outbox-key", userId: "outbox-user", projectId: "outbox-project", costCenterId: null,
  proto: "openai", model: "outbox-model", inTok: 2, cacheTok: 0, outTok: 1, latencyMs: 10, status: 200, stream: false, estimated: false, ts: timestamp, requestId: "outbox-repeated-correlation" };
const reserve = () => reserveBudget(db.query<ApiKeyRow, []>("SELECT * FROM api_keys WHERE id='outbox-key'").get()!, db.query<ModelRow, []>("SELECT * FROM models WHERE id='outbox-model'").get()!,
  { model: "outbox-model", max_tokens: 5 }, 10, false, true, timestamp, event.requestId, { projectId: "outbox-project", costCenterId: null, proto: "openai", stream: false });
if (mode === "settle" || mode === "reserve" || mode === "settle-invalid" || mode === "settle-blocked") {
  const id = reserve();
  if (mode === "settle") settleBudget(id, { inTok: 2, cacheTok: 0, outTok: 1 }, event);
  if (mode === "settle-invalid") settleBudget(id, { inTok: 2, cacheTok: 0, outTok: Number.NaN }, { ...event, outTok: Number.NaN });
  if (mode === "settle-blocked") {
    db.exec("CREATE TRIGGER outbox_test_fault BEFORE INSERT ON usage_outbox BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END");
    try {
      settleBudget(id, { inTok: 2, cacheTok: 0, outTok: 1 }, event);
      throw new Error("settlement unexpectedly ignored a failed durable enqueue");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("injected outbox failure")) throw error;
    }
  }
  console.log(JSON.stringify({ ready: true, id }));
  setInterval(() => undefined, 1000);
} else if (mode === "drain-uncommitted") {
  db.transaction(() => {
    flushUsage();
    writeSync(1, JSON.stringify({ ready: true }) + "\n");
    // Deliberate crash injection in a separate test process. The parent kills
    // this process while all raw/rollup/delete writes remain uncommitted.
    Bun.sleepSync(30_000);
  }).immediate();
} else if (mode === "drain") {
  flushUsage();
  console.log(JSON.stringify({ ready: true }));
} else if (mode === "recover") {
  recoverBudgets();
  flushUsage();
  console.log(JSON.stringify({ ready: true }));
} else if (mode === "retry") {
  const receipt = db.query<{ id: string }, []>("SELECT id FROM billing_reservations WHERE state='pending' LIMIT 1").get()!;
  settleBudget(receipt.id, { inTok: 2, cacheTok: 0, outTok: 1 }, event);
  flushUsage();
  console.log(JSON.stringify({ ready: true }));
} else if (mode === "prune") {
  const result = await pruneUsageEvents(db, now, 1, 100, { maxRows: 100 });
  console.log(JSON.stringify({ ready: true, ...result }));
} else throw new Error("unknown outbox test worker mode");
