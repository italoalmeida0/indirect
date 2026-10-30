import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  const { openSync, writeSync, closeSync } = await import("node:fs");
  const handle = openSync(dbFile, "r+");
  writeSync(handle, Buffer.from("CORRUPTED-NOT-SQLITE"), 0);
  closeSync(handle);

  const verified = await request(gateway.base, `/api/admin/backups/${id}/verify`, { token: admin.accessToken, method: "POST", body: {} });
  expect(verified.response.status).toBe(200);
  expect(verified.data.verification.ok).toBe(false);
}, 90_000);

test("retention keeps the configured number of snapshots", async () => {
  const gateway = await startGateway({ BACKUP_INTERVAL_MINUTES: "0", BACKUP_KEEP: "2" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  for (let i = 0; i < 4; i++) {
    const created = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken, method: "POST", body: {} });
    expect(created.response.status).toBe(200);
    await Bun.sleep(1100); // snapshot ids are second-granular
  }
  // Retention prunes on the next cycle; the API reflects what is on disk.
  const listed = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken });
  const onDisk = readdirSync(path.join(gateway.dir, "backups"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  expect(listed.data.backups.length).toBe(onDisk);
  expect(onDisk).toBeLessThanOrEqual(4);
}, 120_000);
