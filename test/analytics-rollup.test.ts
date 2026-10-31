import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { backfillHourRollups, pruneUsageRollups, rebuildUsageRollups, usageRollupCoverage, USAGE_DAY, USAGE_HOUR, USAGE_HOURLY_BACKFILL_HOURS, USAGE_MINUTE } from "../server/usage-rollup";
import { createUser, login, request, startGateway, waitUntil } from "./gateway-enterprise-fixture";

test("rebuilt rollups preserve exact retained ranges and disclose expanded archived boundaries", async () => {
  const gateway = await startGateway();
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const alice = await createUser(gateway.base, admin.accessToken, "rollup-alice@enterprise.test");
    const bob = await createUser(gateway.base, admin.accessToken, "rollup-bob@enterprise.test");
    const aliceKey = (await request(gateway.base, "/api/keys", { token: alice.accessToken, body: { name: "alice" } })).data.key.id as string;
    const bobKey = (await request(gateway.base, "/api/keys", { token: bob.accessToken, body: { name: "bob" } })).data.key.id as string;
    const today = Math.floor(Date.now() / USAGE_DAY) * USAGE_DAY, rawFrom = today - USAGE_DAY, oldDay = rawFrom - USAGE_DAY;
    const events = [
      [aliceKey, alice.user.id, rawFrom + 20 * USAGE_MINUTE + 100, "model-a", 200],
      [aliceKey, alice.user.id, rawFrom + 20 * USAGE_MINUTE + 40_000, "model-a", 429],
      [aliceKey, alice.user.id, rawFrom + USAGE_HOUR + 12 * USAGE_MINUTE + 200, "model-a", 200],
      [aliceKey, alice.user.id, rawFrom + 2 * USAGE_HOUR + 10 * USAGE_MINUTE + 300, "model-b", 503],
      [aliceKey, alice.user.id, rawFrom + 3 * USAGE_HOUR + 300, "model-a", 200],
      [bobKey, bob.user.id, rawFrom + USAGE_HOUR + 15 * USAGE_MINUTE + 500, "model-a", 200],
    ] as const;
    const insert = sql.prepare(`INSERT INTO usage_events(key_id,user_id,ts,proto,model,in_tok,cache_tok,out_tok,status,provider_id,provider_key_id,upstream_model,cost_in_nanos,cost_cache_nanos,cost_out_nanos)
      VALUES(?,?,?,'openai',?,2,3,5,?,'provider','provider-key','upstream',100,200,300)`);
    try { sql.transaction(() => { for (const row of events) insert.run(...row); })(); } finally { insert.finalize(); }
    sql.exec(`INSERT INTO usage_model_provider_daily(key_id,user_id,date,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs,cost_in_nanos,cost_cache_nanos,cost_out_nanos)
      SELECT key_id,user_id,date(ts/1000,'unixepoch'),proto,provider_id,provider_key_id,model,upstream_model,
        SUM(in_tok),SUM(cache_tok),SUM(out_tok),COUNT(*),SUM(status>=200 AND status<300),SUM(status<200 OR status>=300),SUM(cost_in_nanos),SUM(cost_cache_nanos),SUM(cost_out_nanos)
      FROM usage_events GROUP BY key_id,user_id,date(ts/1000,'unixepoch'),proto,provider_id,provider_key_id,model,upstream_model`);
    const oldDate = new Date(oldDay).toISOString().slice(0, 10);
    const archive = sql.prepare(`INSERT INTO usage_model_provider_daily(key_id,user_id,date,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs,cost_in_nanos,cost_cache_nanos,cost_out_nanos)
      VALUES(?,?,?,'openai','provider','provider-key','model-a','upstream',14,21,35,7,6,1,700,1400,2100)`);
    try {
      archive.run(aliceKey, alice.user.id, oldDate);
      archive.run(aliceKey, alice.user.id, new Date(oldDay - USAGE_DAY).toISOString().slice(0, 10));
    } finally { archive.finalize(); }
    sql.exec(`INSERT INTO usage_model_provider_monthly(key_id,user_id,month,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs,cost_in_nanos,cost_cache_nanos,cost_out_nanos)
      SELECT key_id,user_id,substr(date,1,7),proto,provider_id,provider_key_id,model,upstream_model,SUM(in_tok),SUM(cache_tok),SUM(out_tok),SUM(reqs),SUM(success_reqs),SUM(error_reqs),SUM(cost_in_nanos),SUM(cost_cache_nanos),SUM(cost_out_nanos)
      FROM usage_model_provider_daily GROUP BY key_id,user_id,substr(date,1,7),proto,provider_id,provider_key_id,model,upstream_model`);

    const coverage = rebuildUsageRollups(sql, { from: rawFrom, to: today + USAGE_DAY, rawFrom, minuteFrom: rawFrom });
    expect(coverage.raw_from).toBe(rawFrom);
    expect(coverage.hourly_from).toBe(rawFrom);
    expect(coverage.minute_from).toBe(rawFrom);
    const total = (rows: Array<{ reqs: number }>) => rows.reduce((sum, row) => sum + row.reqs, 0);
    const sumRaw = (from: number, to: number, model?: string) => events.filter((e) => e[1] === alice.user.id && e[2] >= from && e[2] < to && (!model || e[3] === model)).length;
    const params = (from: number, to: number, model?: string) => new URLSearchParams({
      from: String(from), to: String(to), ...(model ? { selection: JSON.stringify({ model: { include: [model], exclude: [] } }) } : {}),
    }).toString();

    for (const [from, to, model] of [
      [rawFrom + 20 * USAGE_MINUTE + 101, rawFrom + 21 * USAGE_MINUTE, undefined],
      [rawFrom + 20 * USAGE_MINUTE + 1, rawFrom + 2 * USAGE_HOUR + 11 * USAGE_MINUTE, undefined],
      [rawFrom + 19 * USAGE_MINUTE, rawFrom + 3 * USAGE_HOUR + 301, "model-a"],
    ] as const) {
      const query = params(from, to, model);
      const result = await request(gateway.base, `/api/usage/overview?${query}`, { token: alice.accessToken });
      expect(result.response.status).toBe(200);
      expect(total(result.data.series)).toBe(sumRaw(from, to, model));
      expect(result.data.history).toMatchObject({ requested: { from, to }, effective: { from, to }, rawFrom, resolution: "millisecond", adjusted: false });
      const analytics = await request(gateway.base, `/api/usage/analytics?${query}`, { token: alice.accessToken });
      expect(analytics.response.status).toBe(200);
      expect(total(analytics.data.series)).toBe(sumRaw(from, to, model));
      expect(analytics.data.outcomes.reduce((n: number, p: any) => n + p.success + p.errors + p.unknown, 0)).toBe(sumRaw(from, to, model));
      const breakdown = await request(gateway.base, `/api/usage/breakdown?${query}`, { token: alice.accessToken });
      expect(breakdown.response.status).toBe(200);
      expect(breakdown.data.totals.reqs).toBe(sumRaw(from, to, model));
    }
    const facetFrom = rawFrom + 19 * USAGE_MINUTE, facetTo = rawFrom + 3 * USAGE_HOUR + 301;
    const facets = await request(gateway.base, `/api/usage/filter-options?${params(facetFrom, facetTo)}&field=model`, { token: alice.accessToken });
    expect(facets.response.status).toBe(200);
    expect(facets.data.options.find((o: any) => o.value === "model-a").count).toBe(sumRaw(facetFrom, facetTo, "model-a"));
    expect(facets.data.options.find((o: any) => o.value === "model-b").count).toBe(sumRaw(facetFrom, facetTo, "model-b"));
    const globalFacets = await request(gateway.base, `/api/admin/usage-filter-options?${params(facetFrom, facetTo)}&field=model`, { token: admin.accessToken });
    expect(globalFacets.response.status).toBe(200);
    expect(globalFacets.data.options.find((o: any) => o.value === "model-a").count).toBe(sumRaw(facetFrom, facetTo, "model-a") + 1);

    const from = oldDay + 6 * USAGE_HOUR, to = rawFrom + 90 * USAGE_MINUTE;
    const archived = await request(gateway.base, `/api/usage/overview?${params(from, to)}`, { token: alice.accessToken });
    expect(archived.response.status).toBe(200);
    expect(total(archived.data.series)).toBe(7 + sumRaw(rawFrom, to));
    expect(archived.data.history).toMatchObject({ requested: { from, to }, effective: { from: oldDay, to }, rawFrom, resolution: "day", adjusted: true });
    expect(archived.data.granularity).toBe("day");
    const trend = await request(gateway.base, `/api/usage/analytics?${params(oldDay - USAGE_DAY, to)}`, { token: alice.accessToken });
    expect(trend.response.status).toBe(200);
    expect(trend.data.modelRequests.points.map((p: any) => p.values.reduce((a: number, b: number) => a + b, 0))).toEqual([7, 7, sumRaw(rawFrom, to)]);
    expect(trend.data.outcomes.map((p: any) => p.success + p.errors + p.unknown)).toEqual([7, 7, sumRaw(rawFrom, to)]);
    const eventsResult = await request(gateway.base, `/api/usage/events?${params(from, to)}`, { token: alice.accessToken });
    expect(eventsResult.data.total).toBe(sumRaw(rawFrom, to));
    expect(eventsResult.data.history).toMatchObject({ requested: { from, to }, effective: { from, to }, rawFrom, adjusted: false });

    const contained = await request(gateway.base, `/api/usage/analytics?${params(oldDay + 10 * USAGE_MINUTE, oldDay + 20 * USAGE_MINUTE)}`, { token: alice.accessToken });
    expect(contained.response.status).toBe(200);
    expect(total(contained.data.series)).toBe(7);
    expect(contained.data.history.effective).toEqual({ from: oldDay, to: rawFrom });
    const previous = await request(gateway.base, `/api/usage/analytics?${params(rawFrom + 15 * USAGE_MINUTE, rawFrom + 45 * USAGE_MINUTE)}`, { token: alice.accessToken });
    expect(previous.response.status).toBe(200);
    expect(previous.data.history.adjusted).toBe(false);
    expect(previous.data.previousHistory.adjusted).toBe(true);
    expect(total(previous.data.previous)).toBe(7);

    sql.run("UPDATE usage_model_provider_daily SET reqs = reqs + 1 WHERE user_id = ? AND date = ?", [alice.user.id, new Date(rawFrom).toISOString().slice(0, 10)]);
    expect(() => rebuildUsageRollups(sql, { from: rawFrom, to: today + USAGE_DAY, rawFrom, minuteFrom: rawFrom })).toThrow("does not match");
    sql.run("UPDATE usage_model_provider_daily SET reqs = reqs - 1 WHERE user_id = ? AND date = ?", [alice.user.id, new Date(rawFrom).toISOString().slice(0, 10)]);
    const afterFailure = await request(gateway.base, `/api/usage/overview?${params(rawFrom + 19 * USAGE_MINUTE, rawFrom + 3 * USAGE_HOUR + 301)}`, { token: alice.accessToken });
    expect(total(afterFailure.data.series)).toBe(5);
    pruneUsageRollups(sql, Date.now(), 1, 1, 2);
    expect(usageRollupCoverage(sql).hourly_from).toBe(today);
    expect(usageRollupCoverage(sql).minute_from).toBe(today);
    const afterPrune = await request(gateway.base, `/api/usage/overview?${params(rawFrom + 19 * USAGE_MINUTE, rawFrom + 3 * USAGE_HOUR + 301)}`, { token: alice.accessToken });
    expect(total(afterPrune.data.series)).toBe(5);
    rebuildUsageRollups(sql, { from: rawFrom, to: today + USAGE_DAY, rawFrom, minuteFrom: rawFrom });
    expect(usageRollupCoverage(sql).hourly_from).toBe(today);
  } finally {
    sql.close();
    await gateway.stop();
  }
}, 60000);

test("live ingestion updates sub-day rollups atomically and retries a failed flush", async () => {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "live-model" }] });
    return Response.json({ id: "test", model: "live-model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  const gateway = await startGateway();
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  const scalar = (table: string, keyId: string) => {
    const query = sql.prepare<{ n: number }, [string]>(`SELECT COALESCE(SUM(${table === "usage_events" ? "1" : "reqs"}),0) AS n FROM ${table} WHERE key_id = ?`);
    try { return query.get(keyId)!.n; } finally { query.finalize(); }
  };
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "live", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } })).response.status).toBe(200);
    const user = await createUser(gateway.base, admin.accessToken, "rollup-live@enterprise.test");
    const made = await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "key" } });
    const key = made.data.token as string, keyId = made.data.key.id as string;
    const send = () => fetch(`${gateway.base}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "live-model", messages: [{ role: "user", content: "test" }], max_tokens: 5 }),
    });
    let response = await send(); expect(response.status).toBe(200); await response.text();
    await waitUntil(() => scalar("usage_events", keyId) === 1, "first event was not flushed", 8000);
    const today = Math.floor(Date.now() / USAGE_DAY) * USAGE_DAY;
    rebuildUsageRollups(sql, { from: today, to: today + USAGE_DAY, rawFrom: 0, minuteFrom: today });
    response = await send(); expect(response.status).toBe(200); await response.text();
    await waitUntil(() => scalar("usage_events", keyId) === 2, "second event was not flushed", 8000);
    expect(scalar("usage_hour_rollups", keyId)).toBe(2);
    expect(scalar("usage_minute_rollups", keyId)).toBe(2);

    sql.exec("CREATE TRIGGER test_minute_failure BEFORE INSERT ON usage_minute_rollups BEGIN SELECT RAISE(ABORT, 'test rollup failure'); END");
    response = await send(); expect(response.status).toBe(200); await response.text();
    await Bun.sleep(1300);
    expect(scalar("usage_events", keyId)).toBe(2);
    expect(scalar("usage_hour_rollups", keyId)).toBe(2);
    sql.exec("DROP TRIGGER test_minute_failure");
    await waitUntil(() => scalar("usage_events", keyId) === 3, "failed event batch was not retried", 8000);
    expect(scalar("usage_hour_rollups", keyId)).toBe(3);
    expect(scalar("usage_minute_rollups", keyId)).toBe(3);
    const scope = new URLSearchParams({ from: String(today), to: String(Date.now() + 1000) });
    const result = await request(gateway.base, `/api/usage/overview?${scope}`, { token: user.accessToken });
    expect(result.response.status).toBe(200);
    expect(result.data.series.reduce((n: number, point: any) => n + point.reqs, 0)).toBe(3);
  } finally {
    sql.exec("DROP TRIGGER IF EXISTS test_minute_failure");
    sql.close();
    await gateway.stop();
    upstream.stop(true);
  }
  // This case boots a real gateway and waits on several fixed flush windows.
  // Under the full parallel suite (60+ files, each spawning its own gateway on
  // a small CI box) 40s is not enough headroom and it fails for scheduling
  // reasons rather than a defect.
}, 90_000);

test("hour backfill extends sub-day coverage in bounded steps and stops at the prune floor", async () => {
  const gateway = await startGateway();
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const user = await createUser(gateway.base, admin.accessToken, "rollup-backfill@enterprise.test");
    const keyId = (await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "backfill" } })).data.key.id as string;
    // Twelve complete hours that live ingestion never wrote: the shape a restore
    // or an import leaves behind, with events present and sub-day coverage
    // absent. Migration 027 starts coverage at the next complete hour, so every
    // one of these hours would otherwise fall back to a raw scan.
    const hourNow = Math.floor(Date.now() / USAGE_HOUR) * USAGE_HOUR;
    const insert = sql.prepare(`INSERT INTO usage_events(key_id,user_id,ts,proto,model,in_tok,cache_tok,out_tok,status,provider_id,provider_key_id,upstream_model,cost_in_nanos,cost_cache_nanos,cost_out_nanos)
      VALUES(?,?,?,'openai','model-a',2,3,5,200,'provider','provider-key','upstream',100,200,300)`);
    try {
      sql.transaction(() => {
        for (let offset = 12; offset >= 1; offset--) insert.run(keyId, user.user.id, hourNow - offset * USAGE_HOUR + USAGE_MINUTE);
      })();
    } finally { insert.finalize(); }
    expect(sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_hour_rollups").get()!.n).toBe(0);

    const start = usageRollupCoverage(sql).hourly_from;
    const first = backfillHourRollups(sql, { hours: USAGE_HOURLY_BACKFILL_HOURS });
    expect(first.advanced).toBe(true);
    expect(first.hours).toBe(USAGE_HOURLY_BACKFILL_HOURS);
    expect(start - first.hourlyFrom).toBe(USAGE_HOURLY_BACKFILL_HOURS * USAGE_HOUR);

    const second = backfillHourRollups(sql, { hours: USAGE_HOURLY_BACKFILL_HOURS });
    expect(second.hours).toBe(USAGE_HOURLY_BACKFILL_HOURS);

    // Keep stepping until the backfill has nothing left to prove; the contract
    // is convergence onto exactly the retained events, not a step count, because
    // the watermark starts at the next complete hour and the boundary hour may
    // hold no events.
    let steps = 2;
    let step = second;
    while (step.advanced && steps < 10) { step = backfillHourRollups(sql, { hours: USAGE_HOURLY_BACKFILL_HOURS }); steps++; }
    expect(steps).toBeLessThan(10);
    expect(sql.query<{ n: number; reqs: number }, []>("SELECT COUNT(*) AS n, COALESCE(SUM(reqs), 0) AS reqs FROM usage_hour_rollups").get()!)
      .toMatchObject({ n: 12, reqs: 12 });
    // Settled: a further step declines rather than claiming coverage it cannot
    // materialise from retained events.
    expect(backfillHourRollups(sql, { hours: USAGE_HOURLY_BACKFILL_HOURS }).advanced).toBe(false);

    // The prune floor is a hard boundary: coverage never extends into hours the
    // retention job has already deleted.
    const floor = hourNow - 6 * USAGE_HOUR;
    sql.exec(`UPDATE usage_rollup_coverage SET hour_floor = ${floor}, hourly_from = ${hourNow}`);
    expect(backfillHourRollups(sql, { hours: USAGE_HOURLY_BACKFILL_HOURS }).hourlyFrom).toBeGreaterThanOrEqual(floor);
  } finally {
    sql.close();
    await gateway.stop();
  }
}, 60_000);
