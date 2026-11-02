import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

/**
 * Supported backup.
 *
 * The reported workflow was a manual copy that happened to work. A supported
 * operation has to produce a CONSISTENT snapshot while the gateway serves,
 * verify that the snapshot is restorable, keep the credential-encryption
 * secret with it, and expire old snapshots.
 */

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterAll(async () => {
  for (const gateway of gateways) for (let i = 0; i < 5; i++) { try { await gateway.stop(); break; } catch { await Bun.sleep(150); } }
});

test("a backup is consistent, verifiable and keeps the credential secret", async () => {
  const gateway = await startGateway({ BACKUP_INTERVAL_MINUTES: "0" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  await createUser(gateway.base, admin.accessToken, "backup-user@enterprise.test");

  const created = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken, method: "POST", body: {} });
  expect(created.response.status).toBe(200);
  const manifest = created.data.backup as { id: string; files: Array<{ path: string; sha256: string }>; verification?: { ok: boolean } };
  expect(manifest.id).toBeTruthy();

  const dir = path.join(gateway.dir, "backups", manifest.id);
  expect(existsSync(dir)).toBe(true);

  // The snapshot is a REAL SQLite database that opens and answers.
  const snapshot = new Database(path.join(dir, "gateway.db"), { readonly: true });
  try {
    expect((snapshot.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    const users = snapshot.query("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(users.n).toBeGreaterThanOrEqual(2);
  } finally { snapshot.close(); }

  // The credential-encryption secret travels with the snapshot: restoring
  // without it leaves every provider key undecryptable. It lives under
  // secret/ and is named for where it came from: the generated DATA_DIR/.secret
  // file, or INDIRECT_SECRET.env when the deployment supplies it through the
  // environment (this test does, so the env-named copy is what appears).
  const secretDir = path.join(dir, "secret");
  expect(existsSync(secretDir)).toBe(true);
  const secretFiles = readdirSync(secretDir);
  expect(secretFiles.length).toBeGreaterThan(0);
  const secretFile = path.join(secretDir, secretFiles[0]!);
  expect(readFileSync(secretFile, "utf8").trim().length).toBeGreaterThanOrEqual(32);

  // The manifest records a hash per file, so a tampered snapshot is detectable.
  expect(manifest.files.length).toBeGreaterThan(0);
  for (const file of manifest.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);

  // It is listed with its verification state.
  const listed = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken });
  expect(listed.response.status).toBe(200);
  const summaries = listed.data.backups as Array<{ id: string; verified?: boolean; bytes?: number }>;
  expect(summaries.some((b) => b.id === manifest.id)).toBe(true);

  // Verification can be re-run on demand and reports success.
  const verified = await request(gateway.base, `/api/admin/backups/${manifest.id}/verify`, { token: admin.accessToken, method: "POST", body: {} });
  expect(verified.response.status).toBe(200);
  expect(verified.data.verification.ok).toBe(true);
}, 90_000);

test("a tampered snapshot fails verification instead of passing silently", async () => {
  const gateway = await startGateway({ BACKUP_INTERVAL_MINUTES: "0" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const created = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken, method: "POST", body: {} });
  expect(created.response.status).toBe(200);
  const id = created.data.backup.id as string;

  // Corrupt a byte of the snapshot: verification must notice.
  const dbFile = path.join(gateway.dir, "backups", id, "gateway.db");
  const original = readFileSync(dbFile);
  const { openSync, writeSync, closeSync } = await import("node:fs");
  const handle = openSync(dbFile, "r+");
  writeSync(handle, Buffer.from("CORRUPTED-NOT-SQLITE"), 0);
  closeSync(handle);

  const verified = await request(gateway.base, `/api/admin/backups/${id}/verify`, { token: admin.accessToken, method: "POST", body: {} });
  expect(verified.response.status).toBe(200);
  expect(verified.data.verification.ok).toBe(false);
  const failed = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken });
  const failedSummary = failed.data.backups.find((backup: { id: string }) => backup.id === id);
  expect(failedSummary.verified).toBe(false);
  expect(failedSummary.error).toContain("hash mismatch");
  expect(JSON.parse(readFileSync(path.join(gateway.dir, "backups", id, "manifest.json"), "utf8")).verification.ok).toBe(false);
  // Repairing the same copy and verifying again must replace the failure too.
  writeFileSync(dbFile, original);
  const repaired = await request(gateway.base, `/api/admin/backups/${id}/verify`, { token: admin.accessToken, method: "POST", body: {} });
  expect(repaired.data.verification.ok).toBe(true);
  const healthy = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken });
  const healthySummary = healthy.data.backups.find((backup: { id: string }) => backup.id === id);
  expect(healthySummary.verified).toBe(true);
  expect(healthySummary.error).toBeUndefined();
}, 90_000);

test("retention keeps the configured number of snapshots", async () => {
  const gateway = await startGateway({ BACKUP_INTERVAL_MINUTES: "0", BACKUP_KEEP_DAILY: "2", BACKUP_KEEP_WEEKLY: "1" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  for (let i = 0; i < 4; i++) {
    const created = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken, method: "POST", body: {} });
    expect(created.response.status).toBe(200);
  }
  // Daily and weekly buckets share the same newest verified snapshot this week.
  const listed = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken });
  const onDisk = readdirSync(path.join(gateway.dir, "backups"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  expect(listed.data.backups.length).toBe(onDisk);
  expect(onDisk).toBe(2);
  expect(listed.data.status.lastAttemptOk).toBe(true);
}, 120_000);

test("concurrent backup requests have bounded workers and release capacity after completion", async () => {
  const gateway = await startGateway({ BACKUP_INTERVAL_MINUTES: "0" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const options = { token: admin.accessToken, method: "POST", body: {} };
  const results = await Promise.all(Array.from({ length: 8 }, () => request(gateway.base, "/api/admin/backups", options)));
  expect(results.some((result) => result.response.status === 200)).toBe(true);
  expect(results.some((result) => result.response.status === 409)).toBe(true);
  expect(results.every((result) => [200, 409].includes(result.response.status))).toBe(true);
  const next = await request(gateway.base, "/api/admin/backups", options);
  expect(next.response.status).toBe(200);
  const status = await request(gateway.base, "/api/admin/backups/status", { token: admin.accessToken });
  expect(status.data.status.busy).toBe(false);
  expect(status.data.status.lastAttemptOk).toBe(true);
}, 90_000);

test("backup filesystem changes require a durable audit intent before they begin", async () => {
  const gateway = await startGateway({ BACKUP_INTERVAL_MINUTES: "0" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  sql.exec("PRAGMA busy_timeout = 5000");
  const failIntent = (action: string) => sql.exec(`CREATE TRIGGER backup_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'backup audit failure'); END`);
  try {
    failIntent("backup.create_requested");
    const rejected = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken, method: "POST", body: {} });
    expect(rejected.response.status).toBe(500);
    const before = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken });
    expect(before.data.backups).toHaveLength(0);
    sql.exec("DROP TRIGGER backup_audit_failure");
    const created = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken, method: "POST", body: {} });
    expect(created.response.status).toBe(200);
    const id = created.data.backup.id;
    failIntent("backup.delete_requested");
    const refused = await request(gateway.base, `/api/admin/backups/${id}`, { token: admin.accessToken, method: "DELETE" });
    expect(refused.response.status).toBe(500);
    expect(existsSync(path.join(gateway.dir, "backups", id))).toBe(true);
    sql.exec("DROP TRIGGER backup_audit_failure");
    expect((await request(gateway.base, `/api/admin/backups/${id}`, { token: admin.accessToken, method: "DELETE" })).response.status).toBe(200);
    const intents = sql.query<{ action: string; request_id: string }, []>("SELECT action, request_id FROM audit_log WHERE action IN ('backup.create_requested','backup.created','backup.delete_requested','backup.deleted') ORDER BY id").all();
    expect(intents.map((row) => row.action)).toEqual(["backup.create_requested", "backup.created", "backup.delete_requested", "backup.deleted"]);
    expect(intents[0]!.request_id).toBe(intents[1]!.request_id);
    expect(intents[2]!.request_id).toBe(intents[3]!.request_id);
  } finally { sql.exec("DROP TRIGGER IF EXISTS backup_audit_failure"); sql.close(); }
}, 90_000);
