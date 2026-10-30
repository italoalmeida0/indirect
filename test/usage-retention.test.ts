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
  const result = await pruneUsageEvents(db, Date.now(), 4, 2);
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
  const again = await pruneUsageEvents(db, Date.now(), 4, 2);
  expect(again.deleted).toBe(0);
  expect(again.rawFrom).toBe(today - 3 * DAY);
}, 90_000);

test("retention deletes in bounded batches and can be disabled", async () => {
  freshDb();
  const { db } = await import("../server/db");
  const { pruneUsageEvents } = await import("../server/usage-rollup");
  const today = Math.floor(Date.now() / DAY) * DAY;
  db.exec("DELETE FROM usage_events; DELETE FROM usage_model_provider_daily; DELETE FROM usage_model_provider_monthly");
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1").run();
  const insert = db.prepare(`INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream, estimated)
    VALUES ('k','u',?,'openai','m',1,1,10,200,0,0)`);
  db.transaction(() => { for (let n = 0; n < 250; n++) insert.run(today - 30 * DAY + n); })();
  insert.finalize();

  // A batch smaller than the backlog still removes everything, in steps.
  const result = await pruneUsageEvents(db, Date.now(), 1, 7);
  expect(result.deleted).toBe(250);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(0);

  // Disabled (0 days) prunes nothing at all.
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1").run();
  db.prepare("INSERT INTO usage_events (key_id,user_id,ts,proto,model,in_tok,out_tok,latency_ms,status,stream,estimated) VALUES ('k','u',?,'openai','m',1,1,10,200,0,0)").run(today - 40 * DAY);
  expect((await pruneUsageEvents(db, Date.now(), 0, 10)).deleted).toBe(0);
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

  const result = await pruneUsageEvents(db, Date.now(), 30, 100);
  expect(result.deleted).toBe(1);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(0);
  // The ten-year aggregate is untouched: that is the whole point.
  expect(db.query<{ n: number }, []>("SELECT SUM(reqs) AS n FROM usage_model_provider_daily").get()!.n).toBe(7);
}, 90_000);

test("pruning 200,000 expired events yields between bounded transactions and does not stall concurrent health or writes", async () => {
  freshDb();
  const { db } = await import("../server/db");
  const { pruneUsageEvents } = await import("../server/usage-rollup");

  const now = Date.now();
  const today = Math.floor(now / DAY) * DAY;
  const baseExpiredDay = today - 40 * DAY;
  db.exec("DELETE FROM usage_events; DELETE FROM usage_model_provider_daily; DELETE FROM usage_model_provider_monthly");
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1").run();

  // Seed 200,000 expired events across 4 expired UTC days (50,000/day) + 1,000 retained today,
  // together with exact matching daily/monthly aggregates.
  db.exec(`
    WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 199999)
    INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream, estimated)
    SELECT 'k-ret', 'u-ret', ${baseExpiredDay} + (n % 4) * ${DAY} + (n % 86400), 'openai', 'ret-model', 10, 5, 12, 200, 0, 0 FROM seq;
    WITH RECURSIVE seq2(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq2 WHERE n < 999)
    INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream, estimated)
    SELECT 'k-ret', 'u-ret', ${today} + n, 'openai', 'ret-model', 10, 5, 12, 200, 0, 0 FROM seq2;
  `);
  for (let d = 0; d < 4; d++) {
    const iso = new Date(baseExpiredDay + d * DAY).toISOString().slice(0, 10);
    db.prepare(`INSERT INTO usage_model_provider_daily (key_id,user_id,date,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs)
      VALUES ('k-ret','u-ret',?,'openai','','','ret-model','',500000,0,250000,50000,50000,0)`).run(iso);
    db.prepare(`INSERT INTO usage_model_provider_monthly (key_id,user_id,month,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs)
      VALUES ('k-ret','u-ret',?,'openai','','','ret-model','',500000,0,250000,50000,50000,0)
      ON CONFLICT(key_id, month, proto, provider_id, provider_key_id, model, upstream_model)
      DO UPDATE SET in_tok = in_tok + excluded.in_tok, out_tok = out_tok + excluded.out_tok, reqs = reqs + excluded.reqs, success_reqs = success_reqs + excluded.success_reqs`).run(iso.slice(0, 7));
  }
  const todayIso = new Date(today).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO usage_model_provider_daily (key_id,user_id,date,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs)
    VALUES ('k-ret','u-ret',?,'openai','','','ret-model','',10000,0,5000,1000,1000,0)`).run(todayIso);
  db.prepare(`INSERT INTO usage_model_provider_monthly (key_id,user_id,month,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs)
    VALUES ('k-ret','u-ret',?,'openai','','','ret-model','',10000,0,5000,1000,1000,0)
    ON CONFLICT(key_id, month, proto, provider_id, provider_key_id, model, upstream_model)
    DO UPDATE SET in_tok = in_tok + excluded.in_tok, out_tok = out_tok + excluded.out_tok, reqs = reqs + excluded.reqs, success_reqs = success_reqs + excluded.success_reqs`).run(todayIso.slice(0, 7));

  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/api/health") return Response.json({ ok: true, ts: Date.now() });
      return new Response("not found", { status: 404 });
    },
  });

  const probeCode = [
    "const url = process.argv[1];",
    "let stop = false;",
    "process.stdin.resume();",
    "process.stdin.on('data', () => { stop = true; });",
    "const samples = [];",
    "(async () => {",
    "  while (!stop) {",
    "    const t0 = performance.now();",
    "    try { const r = await fetch(url); await r.text(); samples.push(performance.now() - t0); } catch {}",
    "    await Bun.sleep(5);",
    "  }",
    "  console.log(JSON.stringify(samples));",
    "  process.exit(0);",
    "})();",
  ].join("\n");
  const prober = Bun.spawn([process.execPath, "-e", probeCode, `http://127.0.0.1:${srv.port}/api/health`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  try {
    await Bun.sleep(80);
    const { recordUsage, flushUsage } = await import("../server/usage");
    const { filteredUsageAnalytics } = await import("../server/usage-analytics");
    let liveWrites = 0;
    let analyticsChecks = 0;
    const t0 = performance.now();
    const result = await pruneUsageEvents(db, now, 30, 5_000, {
      onBatch: ({ batch }) => {
        if (batch % 25 === 0) {
          recordUsage({
            charge: { input: 0n, cache: 0n, output: 0n },
            keyId: "k-ret",
            userId: "u-ret",
            model: "ret-model",
            proto: "openai",
            inTok: 10,
            cacheTok: 0,
            outTok: 5,
            status: 200,
            ts: today + 2_000 + liveWrites,
            latencyMs: 8,
            stream: false,
            estimated: false,
          });
          flushUsage();
          liveWrites++;
        }
        if (batch % 50 === 0) {
          const report = filteredUsageAnalytics(
            { from: baseExpiredDay, to: today + DAY, selection: { model: { include: ["ret-model"], exclude: [] } } },
            "u-ret",
          );
          const totalReqs = report.outcomes.reduce((acc, p) => acc + p.success + p.errors + p.unknown, 0);
          expect(totalReqs).toBe(201_000 + liveWrites);
          analyticsChecks++;
        }
      },
    });
    const pruneMs = performance.now() - t0;
    await Bun.sleep(40);
    prober.stdin.write("stop\n");
    prober.stdin.end();
    const out = await new Response(prober.stdout).text();
    const samples = JSON.parse(out.trim()) as number[];
    const maxHealthMs = Math.max(...samples);
    console.log(
      `[retention-probe] deleted=${result.deleted} pruneMs=${pruneMs.toFixed(1)} probes=${samples.length} maxHealthMs=${maxHealthMs.toFixed(1)} liveWrites=${liveWrites} analyticsChecks=${analyticsChecks}`,
    );
    expect(result.deleted).toBe(200_000);
    expect(result.remaining).toBe(false);
    expect(liveWrites).toBeGreaterThanOrEqual(8);
    expect(analyticsChecks).toBeGreaterThanOrEqual(4);
    expect(samples.length).toBeGreaterThan(10);
    // Must stay far below the 2.3s synchronous lock stall (and well below 250ms).
    expect(maxHealthMs).toBeLessThan(250);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(1_000 + liveWrites);
  } finally {
    try { prober.kill(); } catch {}
    srv.stop(true);
  }
}, 120_000);

test("partial progress, mid-day interruption, restart recovery, and aggregate accounting guard", async () => {
  freshDb();
  const { db } = await import("../server/db");
  const { pruneUsageEvents, retentionStatus, USAGE_HOUR } = await import("../server/usage-rollup");
  const { recordUsage, flushUsage } = await import("../server/usage");
  const { filteredUsageAnalytics } = await import("../server/usage-analytics");

  const now = Date.now();
  const today = Math.floor(now / DAY) * DAY;
  const d1 = today - 10 * DAY;
  const d2 = today - 9 * DAY;
  const d3 = today - 8 * DAY;

  db.exec(
    "DELETE FROM usage_events; DELETE FROM usage_daily; DELETE FROM usage_model_daily; DELETE FROM usage_model_provider_daily; DELETE FROM usage_model_provider_monthly; DELETE FROM usage_hour_rollups; DELETE FROM usage_minute_rollups",
  );
  db.prepare("UPDATE usage_rollup_coverage SET raw_from = 0, hour_floor = 0, minute_floor = 0 WHERE id = 1").run();

  // Seed 30 events/day on d1, d2, d3 + 15 events today via real ingestion (105 total).
  for (const [dayBase, count] of [
    [d1, 30],
    [d2, 30],
    [d3, 30],
    [today, 15],
  ] as const) {
    for (let i = 0; i < count; i++) {
      recordUsage({
        charge: { input: 100n, cache: 0n, output: 200n },
        keyId: "k-partial",
        userId: "u-partial",
        model: "partial-model",
        proto: "openai",
        inTok: 10,
        cacheTok: 0,
        outTok: 20,
        status: 200,
        ts: dayBase + (i % 6) * USAGE_HOUR + i * 1_000,
        latencyMs: 5,
        stream: false,
        estimated: false,
      });
    }
  }
  flushUsage();

  const tenYearTotal = () => {
    const rep = filteredUsageAnalytics(
      { from: today - 3650 * DAY, to: today + DAY, selection: { model: { include: ["partial-model"], exclude: [] } } },
      "u-partial",
    );
    return rep.outcomes.reduce((acc, p) => acc + p.success + p.errors + p.unknown, 0);
  };
  expect(tenYearTotal()).toBe(105);

  // Step 1: Interrupt halfway through d1 (15 of 30 rows deleted).
  const step1 = await pruneUsageEvents(db, now, 5, 5, { maxRows: 15 });
  expect(step1.deleted).toBe(15);
  expect(step1.remaining).toBe(true);
  // Watermark advanced ONLY past d1 (never ahead to d2, d3, or cutoff!).
  expect(step1.rawFrom).toBe(d1 + DAY);
  // 10-year accounting AND sub-day queries on untouched d2 remain 100% exact mid-day!
  expect(tenYearTotal()).toBe(105);
  const subDayD2 = filteredUsageAnalytics(
    { from: d2, to: d2 + 3 * USAGE_HOUR, selection: { model: { include: ["partial-model"], exclude: [] } } },
    "u-partial",
  );
  expect(subDayD2.outcomes.reduce((acc, p) => acc + p.success + p.errors + p.unknown, 0)).toBe(15);

  // Step 2: Resume after simulated restart — finishes remaining 15 rows of d1 + 15 rows of d2.
  const step2 = await pruneUsageEvents(db, now, 5, 5, { maxRows: 30 });
  expect(step2.deleted).toBe(30);
  expect(step2.remaining).toBe(true);
  expect(step2.rawFrom).toBe(d2 + DAY);
  expect(tenYearTotal()).toBe(105);

  // Step 3: Drain remaining backlog to cutoff (today - 4d).
  const step3 = await pruneUsageEvents(db, now, 5, 10);
  expect(step3.deleted).toBe(45);
  expect(step3.remaining).toBe(false);
  expect(step3.rawFrom).toBe(today - 4 * DAY);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events WHERE key_id = 'k-partial'").get()!.n).toBe(15);
  expect(tenYearTotal()).toBe(105);
  expect(retentionStatus().runs).toBeGreaterThanOrEqual(3);

  // Guard check: if daily aggregate has a partial deficit (< raw count), refuse to advance raw_from or delete.
  const unguardedDay = today - 3 * DAY;
  const unguardedIso = new Date(unguardedDay).toISOString().slice(0, 10);
  for (let i = 0; i < 5; i++) {
    db.prepare(
      "INSERT INTO usage_events (key_id,user_id,ts,proto,model,in_tok,out_tok,latency_ms,status,stream,estimated) VALUES ('k-bad','u-bad',?,'openai','bad-m',1,1,5,200,0,0)",
    ).run(unguardedDay + i * 1_000);
  }
  db.prepare(
    "INSERT INTO usage_model_provider_daily (key_id,user_id,date,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs) VALUES ('k-bad','u-bad',?,'openai','','','bad-m','',3,0,3,3,3,0)",
  ).run(unguardedIso);

  await expect(pruneUsageEvents(db, now, 2, 10)).rejects.toThrow("Refusing to advance raw_from");
  expect(db.query<{ raw_from: number }, []>("SELECT raw_from FROM usage_rollup_coverage WHERE id = 1").get()!.raw_from).toBe(
    today - 4 * DAY,
  );
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events WHERE key_id = 'k-bad'").get()!.n).toBe(5);
}, 90_000);

test("settled reservation recovery, rollup pruning, passive WAL checkpoint, and off-thread backup verification stay non-blocking", async () => {
  freshDb();
  const { db, runPassiveWalCheckpoint, walCheckpointStatus } = await import("../server/db");
  const { recoverBudgetsAsync } = await import("../server/billing");
  const { pruneUsageRollupsAsync } = await import("../server/usage-rollup");
  const { createBackup, verifyBackup } = await import("../server/backup");

  const now = Date.now();
  const expiredSettledAt = now - 45 * DAY;

  db.exec("DELETE FROM billing_reservations");
  db.exec(`
    WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 199999)
    INSERT INTO billing_reservations (id, instance_id, key_id, user_id, created_at, settled_at, amount_nanos, periods, pricing, state)
    SELECT 'res-' || n, 'inst-old', 'k-res', 'u-res', ${expiredSettledAt - 1000}, ${expiredSettledAt} + (n % 1000), 1000, '[]', '{}', 'settled'
    FROM seq;
  `);

  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/api/health") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    },
  });

  const probeCode = [
    "const url = process.argv[1];",
    "let stop = false;",
    "process.stdin.resume();",
    "process.stdin.on('data', () => { stop = true; });",
    "const samples = [];",
    "(async () => {",
    "  while (!stop) {",
    "    const t0 = performance.now();",
    "    try { const r = await fetch(url); await r.text(); samples.push(performance.now() - t0); } catch {}",
    "    await Bun.sleep(5);",
    "  }",
    "  console.log(JSON.stringify(samples));",
    "  process.exit(0);",
    "})();",
  ].join("\n");
  const prober = Bun.spawn([process.execPath, "-e", probeCode, `http://127.0.0.1:${srv.port}/api/health`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  try {
    await Bun.sleep(60);
    // Drain all 200,000 expired settled reservations across 4 bounded scheduled ticks (50k/tick).
    let totalDeletedRes = 0;
    for (let tick = 0; tick < 4; tick++) {
      const res = await recoverBudgetsAsync(now, { batchSize: 500, maxRows: 50_000 });
      totalDeletedRes += res.deletedReservations;
    }
    expect(totalDeletedRes).toBe(200_000);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM billing_reservations").get()!.n).toBe(0);

    await pruneUsageRollupsAsync(db, now, 90, 3, 500);
    const ckpt = runPassiveWalCheckpoint(db);
    expect(ckpt.runs).toBeGreaterThanOrEqual(1);
    expect(walCheckpointStatus().lastRunAt).not.toBeNull();

    const backupDir = mkdtempSync(path.join(tmpdir(), "retention-bkp-"));
    dirs.push(backupDir);
    const manifest = await createBackup({ dir: backupDir, includeDaemon: false });
    const verified = await verifyBackup(path.join(backupDir, manifest.id));
    expect(verified.ok).toBe(true);

    await Bun.sleep(40);
    prober.stdin.write("stop\n");
    prober.stdin.end();
    const out = await new Response(prober.stdout).text();
    const samples = JSON.parse(out.trim()) as number[];
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    const maxHealthMs = Math.max(...samples);
    console.log(`[maintenance-probe] probes=${samples.length} p95=${p95.toFixed(1)} maxHealthMs=${maxHealthMs.toFixed(1)}`);
    expect(samples.length).toBeGreaterThan(20);
    // The defect this guards against blocked health for ~2,300 ms with one
    // unbounded DELETE transaction. Assert the shape of the distribution, not a
    // single sample: with twelve test files running concurrently the host's
    // scheduler alone produced a 262.9 ms outlier while isolated runs measure
    // 92.1 ms maximum. p95 keeps the tight bound where the maintenance path is
    // actually exercised, and the maximum still fails anything resembling the
    // original multi-hundred-millisecond stall.
    expect(p95).toBeLessThan(250);
    expect(maxHealthMs).toBeLessThan(1_000);
  } finally {
    try { prober.kill(); } catch {}
    srv.stop(true);
  }
}, 120_000);
