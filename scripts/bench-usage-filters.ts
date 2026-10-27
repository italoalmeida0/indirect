// Isolated synthetic benchmark; never touches the configured gateway database.
// bun scripts/bench-usage-filters.ts --events=1000000 --days=3653 --cardinality=50000
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const argument = (name: string, fallback: number, max: number) => {
  const value = Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${name}`);
  return value;
};
const events = argument("events", 1_000_000, 10_000_000);
const days = argument("days", 3653, 7305);
const cardinality = argument("cardinality", 50_000, 250_000);
const reuse = process.argv.find((arg) => arg.startsWith("--reuse="))?.slice(8);
const directory = reuse ? path.resolve(reuse) : mkdtempSync(path.join(tmpdir(), "indirect-analytics-bench-"));
assert(path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("indirect-analytics-bench-"), "Only isolated benchmark directories may be reused");
process.env.DATA_DIR = directory;
process.env.NODE_ENV = "development";
const { db } = await import("../server/db");
const { filteredUsageBreakdown, filteredUsageSeries, usageFilterOptions } = await import("../server/usage-filters");
const { invalidateUsageQueries } = await import("../server/usage-cache");
const { userEvents } = await import("../server/usage");
const { readUsage, closeUsageReaders } = await import("../server/usage-reader");
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
const start = today - (days - 1) * DAY;
const end = today + 12 * 3_600_000;

try {
  const seedStarted = performance.now();
  if (!reuse) db.transaction(() => {
    db.prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x+1 < ?)
      INSERT INTO usage_events (key_id, user_id, ts, proto, model, provider_id, provider_key_id, upstream_model, in_tok, cache_tok, out_tok)
      SELECT printf('bench-key-%d', CAST(x / ? AS INTEGER) % 8), printf('bench-user-%d', CAST(x / ? AS INTEGER) % 4),
        ? + (x % ?) * ? + (CAST(x / ? AS INTEGER) % 48) * 60000, 'openai',
        printf('model-%02d', CAST(CAST(x / ? AS INTEGER) / 4 AS INTEGER) % 16),
        printf('provider-%d', CAST(x / ? AS INTEGER) % 3), 'upstream-key', 'upstream-model', 100, 200, 50 FROM n`).run(events, days, days, start, days, DAY, days, days, days);
    db.exec(`INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, model, provider_id, provider_key_id, upstream_model, in_tok, cache_tok, out_tok, reqs)
      SELECT key_id, user_id, date(ts / 1000, 'unixepoch'), proto, model, provider_id, provider_key_id, upstream_model, SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*)
      FROM usage_events GROUP BY key_id, user_id, date(ts / 1000, 'unixepoch'), proto, model, provider_id, provider_key_id, upstream_model`);
    // Archived aggregate-only rows exercise high-cardinality option domains.
    db.prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x+1 < ?)
      INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs)
      SELECT 'archive-key', 'bench-user-0', date((? + (x % ?) * ?) / 1000, 'unixepoch'), 'openai', printf('archive-model-%06d', x), 100, 200, 50, 1 FROM n`).run(cardinality, start, days - 1 || 1, DAY);
    db.exec(`INSERT INTO usage_model_provider_monthly (key_id, user_id, month, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs)
      SELECT key_id, user_id, substr(date,1,7), proto, provider_id, provider_key_id, model, upstream_model, SUM(in_tok), SUM(cache_tok), SUM(out_tok), SUM(reqs)
      FROM usage_model_provider_daily GROUP BY key_id, substr(date,1,7), proto, provider_id, provider_key_id, model, upstream_model`);
  })();
  const seedSeconds = (performance.now() - seedStarted) / 1000;
  console.log(`[bench] Dataset ready in ${seedSeconds.toFixed(2)}s`);
  db.exec("ANALYZE");
  const rollups = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_model_provider_daily").get()!.n;
  const globalPlan = db.prepare<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN SELECT model, SUM(reqs) FROM usage_model_provider_daily WHERE date >= ? AND date < ? GROUP BY model").all(new Date(today - 30 * DAY).toISOString().slice(0, 10), new Date(today).toISOString().slice(0, 10));
  assert(globalPlan.some((row) => /COVERING INDEX idx_usage_mpd_date/.test(row.detail)), "Global facet query did not use the covering date index");
  const modelPlan = db.prepare<{ detail: string }, [string, string, number]>("EXPLAIN QUERY PLAN SELECT id FROM usage_events WHERE user_id = ? AND model IN (?) AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 100").all("bench-user-0", "model-00", start);
  assert(modelPlan.some((row) => /idx_usage_user_model_ts_id/.test(row.detail)), "Filtered event query did not use its model/time index");
  const scope = { from: start + 12 * 3_600_000, to: end, selection: {} };
  const grid = { limit: 100, offset: 0 };
  const facet = (from: number | null, field = "model", q = "") => usageFilterOptions(null, { ...scope, from }, new URLSearchParams({ field, q, limit: "60" }));
  const cases: Array<[string, () => unknown]> = [
    ["global facets / 1 day", () => facet(today - DAY)],
    ["global facets / 30 days", () => facet(today - 30 * DAY)],
    ["global facets / 10 years", () => facet(scope.from)],
    ["global facet search / 10 years", () => facet(scope.from, "model", "archive-model-049999")],
    ["global chart / 10 years", () => filteredUsageSeries(scope, null)],
    ["global model grid / 10 years", () => filteredUsageBreakdown(scope, null, grid)],
    ["own requests / 10 years", () => userEvents("bench-user-0", { ...grid, scope })],
  ];
  const sample = (run: () => unknown, cold: boolean) => {
    if (cold) invalidateUsageQueries([{ userId: "bench-user-0", ts: end - 1 }]);
    const began = performance.now();
    const result = JSON.stringify(run());
    return { ms: performance.now() - began, bytes: Buffer.byteLength(result) };
  };
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
  const results = cases.map(([name, run]) => {
    console.log(`[bench] ${name}`);
    const cold = Array.from({ length: 7 }, () => sample(run, true));
    const warm = Array.from({ length: 30 }, () => sample(run, false));
    return { query: name, uncached_p50_ms: +percentile(cold.map((v) => v.ms), .5).toFixed(2), uncached_p95_ms: +percentile(cold.map((v) => v.ms), .95).toFixed(2), cached_p95_ms: +percentile(warm.map((v) => v.ms), .95).toFixed(2), response_kb: +(warm[0]!.bytes / 1024).toFixed(1) };
  });
  const delays: number[] = [];
  let previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); delays.push(Math.max(0, now - previous - 10)); previous = now; }, 10);
  try { await readUsage({ kind: "breakdown", scope, userId: null, grid, users: false, summaryOnly: false }); }
  finally { clearInterval(timer); }
  const mainLoopMaxDelayMs = Math.max(0, ...delays);
  assert(mainLoopMaxDelayMs < 250, "Analytical SQL blocked the main event loop");
  console.log(JSON.stringify({ events, days, distinctArchivedModels: cardinality, rollupRows: rollups, seedSeconds: +seedSeconds.toFixed(2), mainLoopMaxDelayMs: +mainLoopMaxDelayMs.toFixed(2), databaseMB: +(statSync(path.join(directory, "gateway.db")).size / 1024 / 1024).toFixed(1), cache: "uncached = cold application cache, warm OS/SQLite pages; warm = query result cache", results, queryPlans: { globalPlan, modelPlan } }, null, 2));
} finally {
  await closeUsageReaders();
  try { db.close(); } catch {}
  if (!reuse) {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch { console.warn(`[bench] Temporary database retained at ${directory}`); }
  }
}
