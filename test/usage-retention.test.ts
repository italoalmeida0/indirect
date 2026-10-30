import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Detailed-event retention.
 *
 * A million events occupy ~547 MiB before compression. The table otherwise
 * grows forever. Detail expires; AGGREGATES DO NOT, so charts and billing stay
 * exact over the long history.
 */

const DAY = 86_400_000;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "retention-"));
  dirs.push(dir);
  process.env.DATA_DIR = dir;
}

test("retention removes only complete days older than the window and advances the watermark", async () => {
  freshDb();
  const { db } = await import("../server/db");
  const { pruneUsageEvents } = await import("../server/usage-rollup");

  const today = Math.floor(Date.now() / DAY) * DAY;
  db.exec("DELETE FROM usage_events");
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1").run();
  const insert = db.prepare(`INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream, estimated)
    VALUES ('k','u',?,'openai','m',1,1,10,200,0,0)`);
  db.transaction(() => {
    // 5 events per day for 10 days, ending today.
    for (let day = 0; day < 10; day++) for (let n = 0; n < 5; n++) insert.run(today - day * DAY + n);
  })();
  insert.finalize();

  // Keep 4 days including today: everything older than (today - 3d) goes.
  const result = pruneUsageEvents(db, Date.now(), 4, 2);
  expect(result.deleted).toBe(30);
  expect(result.rawFrom).toBe(today - 3 * DAY);

  const remaining = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n;
  expect(remaining).toBe(20);
  // Nothing from the retained window was touched, and the current day is intact.
  const oldest = db.query<{ ts: number }, []>("SELECT MIN(ts) AS ts FROM usage_events").get()!.ts;
  expect(oldest).toBeGreaterThanOrEqual(today - 3 * DAY);
  expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM usage_events WHERE ts >= ${today}`).get()!.n).toBe(5);

  // The watermark records where detail starts, so a query knows to fall back to
  // aggregates instead of showing zero.
  const coverage = db.query<{ raw_from: number }, []>("SELECT raw_from FROM usage_rollup_coverage WHERE id = 1").get()!;
  expect(coverage.raw_from).toBe(today - 3 * DAY);

  // A second run is a no-op: the watermark is monotonic.
  const again = pruneUsageEvents(db, Date.now(), 4, 2);
  expect(again.deleted).toBe(0);
  expect(again.rawFrom).toBe(today - 3 * DAY);
}, 90_000);

test("retention deletes in bounded batches and can be disabled", async () => {
  freshDb();
  const { db } = await import("../server/db");
  const { pruneUsageEvents } = await import("../server/usage-rollup");
  const today = Math.floor(Date.now() / DAY) * DAY;
  db.exec("DELETE FROM usage_events");
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1").run();
  const insert = db.prepare(`INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream, estimated)
    VALUES ('k','u',?,'openai','m',1,1,10,200,0,0)`);
  db.transaction(() => { for (let n = 0; n < 250; n++) insert.run(today - 30 * DAY + n); })();
  insert.finalize();

  // A batch smaller than the backlog still removes everything, in steps.
  const result = pruneUsageEvents(db, Date.now(), 1, 7);
  expect(result.deleted).toBe(250);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(0);

  // Disabled (0 days) prunes nothing at all.
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1").run();
  db.prepare("INSERT INTO usage_events (key_id,user_id,ts,proto,model,in_tok,out_tok,latency_ms,status,stream,estimated) VALUES ('k','u',?,'openai','m',1,1,10,200,0,0)").run(today - 40 * DAY);
  expect(pruneUsageEvents(db, Date.now(), 0, 10).deleted).toBe(0);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(1);
}, 90_000);

test("aggregates survive the pruning of their detail", async () => {
  freshDb();
  const { db } = await import("../server/db");
  const { pruneUsageEvents } = await import("../server/usage-rollup");
  const today = Math.floor(Date.now() / DAY) * DAY;
  const oldDate = new Date(today - 200 * DAY).toISOString().slice(0, 10);
  db.exec("DELETE FROM usage_events; DELETE FROM usage_model_provider_daily; DELETE FROM usage_model_provider_monthly");
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1").run();
  db.prepare(`INSERT INTO usage_model_provider_daily (key_id,user_id,date,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs)
    VALUES ('k','u',?,'openai','p','pk','m','um',700,0,70,7,7,0)`).run(oldDate);
  db.prepare(`INSERT INTO usage_events (key_id,user_id,ts,proto,model,in_tok,out_tok,latency_ms,status,stream,estimated)
    VALUES ('k','u',?,'openai','m',1,1,10,200,0,0)`).run(today - 200 * DAY);

  const result = pruneUsageEvents(db, Date.now(), 30, 100);
  expect(result.deleted).toBe(1);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(0);
  // The ten-year aggregate is untouched: that is the whole point.
  expect(db.query<{ n: number }, []>("SELECT SUM(reqs) AS n FROM usage_model_provider_daily").get()!.n).toBe(7);
}, 90_000);
