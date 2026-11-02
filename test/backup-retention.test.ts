import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyRetentionRules, buildSnapshot, CANARY_TABLES, verifyAndRecordSnapshot, verifySnapshot } from "../server/backup-files";

test("failed and unverified copies never replace verified daily or weekly restore points", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "indirect-backup-retention-"));
  const connection = new Database(":memory:");
  const secret = "retention-test-secret-0123456789012345";
  writeFileSync(path.join(directory, ".secret"), secret);
  for (const table of CANARY_TABLES) connection.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
  connection.exec("PRAGMA user_version = 1");
  const day = 86_400_000, start = Date.UTC(2026, 0, 5);
  const make = (id: string, at: number, verify = true) => buildSnapshot(connection, { root: directory, id, kind: "scheduled", createdAt: at, dataDir: directory, gatewaySecret: secret, includeDaemon: false, daemonDirs: [], verify });
  const fail = (id: string, at: number) => {
    const manifest = make(id, at);
    appendFileSync(path.join(directory, id, manifest.files.find((file) => file.kind === "secret")!.path), "corrupted");
    expect(verifyAndRecordSnapshot(path.join(directory, id)).ok).toBe(false);
  };
  try {
    const older = make("verified-previous-week", start);
    const newest = make("verified-current-week", start + 7 * day);
    fail("failed-old", start + 8 * day);
    make("unverified-new", start + 9 * day, false);
    const preview = applyRetentionRules(directory, { keepDaily: 1, keepWeekly: 2, now: start + 9 * day, removeFiles: false });
    expect(preview.keptDaily).toEqual([newest.id]);
    expect(preview.keptWeekly).toEqual([newest.id, older.id]);
    expect(preview.removed).toEqual(["failed-old"]);
    fail("failed-newest", start + 10 * day);
    const pruned = applyRetentionRules(directory, { keepDaily: 1, keepWeekly: 1, now: start + 10 * day, removeFiles: true });
    expect(pruned.removed.sort()).toEqual(["failed-old", "unverified-new", older.id].sort());
    expect(existsSync(path.join(directory, "failed-newest"))).toBe(true);
    expect(verifySnapshot(path.join(directory, newest.id), newest).ok).toBe(true);
  } finally {
    connection.close();
    // Only the fresh, explicitly created test directory is removed.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
