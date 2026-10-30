import { describe, expect, test } from "bun:test";
import { removeUsdMigration } from "./billing-fixture";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "../server/db";
import { flushUsage, recordUsage } from "../server/usage";
import { filteredUsageAnalytics } from "../server/usage-analytics";
import type { UsageScope } from "../server/usage-filters";

describe("analytics response outcomes and API keys", () => {
  test("rates retain classified counts across exact ranges, filters and archived months", () => {
    const model = "outcomes-test/model";
    const userId = "outcomes-test/user";
    const from = Date.UTC(2016, 0, 1);
    const scope: UsageScope = { from, to: Date.UTC(2026, 10, 1), selection: { model: { include: [model], exclude: [] } } };
    const totals = (report: ReturnType<typeof filteredUsageAnalytics>) => report.outcomes.reduce((sum, point) => ({ success: sum.success + point.success, errors: sum.errors + point.errors, unknown: sum.unknown + point.unknown }), { success: 0, errors: 0, unknown: 0 });
    // Pin the raw-retention watermark for this case. The test asserts EXACT
    // millisecond bounds, and resolveUsageScope deliberately widens any range
    // that reaches into the archive to whole UTC days. Leaving raw_from at
    // whatever a previously-run test left behind made the answer depend on
    // test order.
    const previousRawFrom = db.query<{ raw_from: number }, []>("SELECT raw_from FROM usage_rollup_coverage WHERE id = 1").get()!.raw_from;
    db.run("UPDATE usage_rollup_coverage SET raw_from = 0 WHERE id = 1");
    try {
      for (const [index, status] of [200, 201, 429, 503].entries()) recordUsage({ charge: { input: 0n, cache: 0n, output: 0n }, keyId: `outcomes-test/key-${index < 2 ? "a" : "b"}`, userId, model, proto: "openai", inTok: 10, cacheTok: 20, outTok: 5, status, ts: from + [0, 60_000, 600_000, 900_000][index]!, latencyMs: 1, stream: false, estimated: false });
      recordUsage({ charge: { input: 0n, cache: 0n, output: 0n }, keyId: "outcomes-test/foreign-key", userId: "outcomes-test/foreign-user", model, proto: "openai", inTok: 1, cacheTok: 0, outTok: 1, status: 500, ts: from, latencyMs: 1, stream: false, estimated: false });
      flushUsage();
      db.run("INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, model, reqs) VALUES (?, ?, '2020-02-01', 'openai', ?, 7)", ["outcomes-test/key-a", userId, model]);
      db.run("INSERT INTO usage_model_provider_monthly (key_id, user_id, month, proto, model, reqs) VALUES (?, ?, '2020-02', 'openai', ?, 7)", ["outcomes-test/key-a", userId, model]);
      const all = filteredUsageAnalytics(scope, userId);
      expect(totals(all)).toEqual({ success: 2, errors: 2, unknown: 7 });
      expect(all.outcomes.length).toBeLessThanOrEqual(48);
      expect(all.outcomes.map((point) => point.success + point.errors + point.unknown).filter(Boolean).sort((a, b) => a - b)).toEqual([4, 7]);
      expect(all.keys.map((key) => key.id).sort()).toEqual(["outcomes-test/key-a", "outcomes-test/key-b"]);
      expect(all.keys.reduce((sum, key) => sum + key.reqs, 0)).toBe(11);
      expect(JSON.stringify(all)).not.toContain("foreign");
      expect(totals(filteredUsageAnalytics({ ...scope, to: from + 900_000 }, userId))).toEqual({ success: 2, errors: 1, unknown: 0 });
      expect(totals(filteredUsageAnalytics({ ...scope, from: from + 1, to: from + 3_600_000 }, userId))).toEqual({ success: 1, errors: 2, unknown: 0 });
      const selected = filteredUsageAnalytics({ ...scope, selection: { ...scope.selection, key_id: { include: ["outcomes-test/key-b"], exclude: [] } } }, userId);
      expect(totals(selected)).toEqual({ success: 0, errors: 2, unknown: 0 });
      expect(selected.keys).toHaveLength(1);
      expect(totals(filteredUsageAnalytics(scope, null))).toEqual({ success: 2, errors: 3, unknown: 7 });
      db.run("DELETE FROM usage_events WHERE model = ?", [model]);
      db.run("DELETE FROM usage_model_provider_daily WHERE model = ?", [model]);
      expect(totals(filteredUsageAnalytics(scope, userId))).toEqual({ success: 2, errors: 2, unknown: 7 });
      expect(totals(filteredUsageAnalytics({ ...scope, selection: { model: { include: [model], exclude: [model] } } }, userId))).toEqual({ success: 0, errors: 0, unknown: 0 });
    } finally {
      for (const table of ["usage_events", "usage_model_provider_daily", "usage_model_provider_monthly", "usage_model_daily", "usage_hour_rollups", "usage_minute_rollups"]) db.run(`DELETE FROM ${table} WHERE model = ?`, [model]);
      db.run("DELETE FROM usage_daily WHERE key_id LIKE 'outcomes-test/%'");
      db.run("UPDATE usage_rollup_coverage SET raw_from = ? WHERE id = 1", [previousRawFrom]);
    }
  });

  test("migration backfills known statuses without inventing outcomes for pruned history", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "usage-outcomes-migration-"));
    const boot = () => Bun.spawnSync([process.execPath, "-e", 'import "./server/db.ts";'], { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, DATA_DIR: dir, NODE_ENV: "development" }, stdout: "pipe", stderr: "pipe" });
    let fixture: Database | undefined;
    try {
      expect(boot().exitCode).toBe(0);
      fixture = new Database(path.join(dir, "gateway.db"));
      for (const table of ["usage_model_provider_daily", "usage_model_provider_monthly"]) {
        fixture.exec(`ALTER TABLE ${table} DROP COLUMN success_reqs; ALTER TABLE ${table} DROP COLUMN error_reqs;`);
      }
      removeUsdMigration(fixture);
      // Migration names skip 015; the 024 schema has user_version 23.
      fixture.exec(`PRAGMA user_version = 23;
        INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, model, reqs) VALUES ('key', 'user', '2024-02-01', 'openai', 'model', 10);
        INSERT INTO usage_model_provider_monthly (key_id, user_id, month, proto, model, reqs) VALUES ('key', 'user', '2024-02', 'openai', 'model', 30);
        INSERT INTO usage_events (key_id, user_id, ts, proto, model, status) VALUES ('key', 'user', 1706745600000, 'openai', 'model', 200), ('key', 'user', 1706745600001, 'openai', 'model', 503);`);
      fixture.close(); fixture = undefined;
      const migrated = boot();
      expect(migrated.exitCode).toBe(0);
      fixture = new Database(path.join(dir, "gateway.db"));
      expect(fixture.query("SELECT reqs, success_reqs, error_reqs FROM usage_model_provider_daily").get()).toEqual({ reqs: 10, success_reqs: 1, error_reqs: 1 });
      expect(fixture.query("SELECT reqs, success_reqs, error_reqs FROM usage_model_provider_monthly").get()).toEqual({ reqs: 30, success_reqs: 1, error_reqs: 1 });
      expect(boot().exitCode).toBe(0);
      expect(fixture.query("SELECT success_reqs, error_reqs FROM usage_model_provider_monthly").get()).toEqual({ success_reqs: 1, error_reqs: 1 });
    } finally {
      fixture?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
