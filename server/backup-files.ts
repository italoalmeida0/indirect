
import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Filesystem half of the supported backup (server/backup.ts).
 *
 * Kept free of any database import so the snapshot worker
 * (server/backup-worker.ts) can reuse it without opening the live database or
 * re-running migrations in a second process-wide connection.
 */

export type BackupKind = "manual" | "scheduled" | "pre-restore";

export interface BackupFileEntry {
  /** Path inside the snapshot directory, POSIX separators. */
  path: string;
  bytes: number;
  sha256: string;
  kind: "database" | "secret" | "daemon" | "other";
}

export interface BackupVerification {
  ok: boolean;
  checkedAt: number;
  integrity: string[];
  schemaVersion: number;
  /** Critical tables the canary query proved readable, in order. */
  canary: string[];
  /** Present when the check failed. Contains no secret material. */
  error?: string;
  durationMs: number;
}

export interface BackupManifest {
  version: 1;
  id: string;
  kind: BackupKind;
  createdAt: number;
  /** Snapshot directory, absolute. */
  dir: string;
  /** Canonical database file inside the snapshot. */
  database: string;
  schemaVersion: number;
  /** DATA_DIR at creation time, informational. */
  dataDir: string;
  /** True when the secret came from INDIRECT_SECRET/GATEWAY_SECRET. */
  secretFromEnv: boolean;
  includeDaemon: boolean;
  files: BackupFileEntry[];
  totalBytes: number;
  verification: BackupVerification | null;
  error?: string;
}

export const MANIFEST_NAME = "manifest.json";
export const DB_NAME = "gateway.db";
export const SECRET_DIR = "secret";
export const DAEMON_DIR = "daemon";

/** Canary tables: every one must exist and be readable in a restored copy. */
export const CANARY_TABLES = [
  "users",
  "api_keys",
  "providers",
  "models",
  "usage_events",
  "usage_daily",
  "usage_model_provider_daily",
  "audit_log",
  "settings",
];

/** Stream a file through SHA-256 in fixed chunks; snapshots can be large. */
export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const size = statSync(file).size;
  const chunk = 1 << 20;
  const buffer = Buffer.allocUnsafe(chunk);
  const handle = openSync(file, "r");
  try {
    let offset = 0;
    while (offset < size) {
      const read = readSync(handle, buffer, 0, Math.min(chunk, size - offset), offset);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

/** Sortable UTC stamp: 20261030T090909Z. */
export function manifestTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z"
  );
}

/**
 * Credential-encryption secret material that must travel with the snapshot.
 * Provider keys and API-key tokens are AES-256-GCM blobs keyed from this
 * value, so a database-only restore yields undecryptable credentials.
 *
 * When the deployment supplies the secret through the environment, the copy is
 * base64-encoded and named INDIRECT_SECRET.env so an operator can see where it
 * came from. Otherwise the generated <DATA_DIR>/.secret file is copied.
 */
export function secretMaterial(dataDir: string, gatewaySecret: string): { fromEnv: boolean; entries: Array<{ name: string; content: string; mode: number }> } {
  const fromEnv = !!(process.env.INDIRECT_SECRET || process.env.GATEWAY_SECRET);
  const content = fromEnv
    ? Buffer.from(gatewaySecret, "utf8").toString("base64") + "\n"
    : readFileSync(path.join(dataDir, ".secret"), "utf8");
  return {
    fromEnv,
    entries: [{ name: fromEnv ? "INDIRECT_SECRET.env" : ".secret", content, mode: 0o600 }],
  };
}

/**
 * Copy the top-level files of each Indirect Code daemon data directory.
 * Session WALs, transcripts and config live there
 * (indirect-code-daemon/cmd/daemon/datadir.go); runner logs and caches do not
 * need to be in a restore, and are large.
 */
export function copyDaemonDirs(snapshotDir: string, dirs: string[]): void {
  for (const source of dirs) {
    const resolved = path.resolve(source);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) continue;
    const host = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_") || "daemon";
    const destination = path.join(snapshotDir, DAEMON_DIR, host);
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === "daemon.pid" || entry.name.endsWith(".sock")) continue;
      copyFileSync(path.join(resolved, entry.name), path.join(destination, entry.name));
    }
  }
}

/** Hash every file in the snapshot (the manifest itself excluded). */
export function collectFiles(root: string): BackupFileEntry[] {
  const files: BackupFileEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, relative); continue; }
      if (!entry.isFile() || relative === MANIFEST_NAME) continue;
      const kind: BackupFileEntry["kind"] = relative === DB_NAME ? "database"
        : relative.startsWith(SECRET_DIR + "/") ? "secret"
        : relative.startsWith(DAEMON_DIR + "/") ? "daemon" : "other";
      files.push({ path: relative, bytes: statSync(full).size, sha256: sha256File(full), kind });
    }
  };
  walk(root, "");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Schema version recorded by the snapshot's own PRAGMA user_version. */
export function readSchemaVersion(file: string): number {
  const snapshot = new Database(file, { readonly: true });
  try {
    return Number(snapshot.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
  } finally {
    snapshot.close();
  }
}

/**
 * Open the snapshot READ-ONLY and prove it can serve a restore: recorded
 * hashes, PRAGMA integrity_check, the schema version and a canary query per
 * critical table. The live database is never opened here.
 */
export function verifySnapshot(snapshotDir: string, manifest?: BackupManifest): BackupVerification {
  const startedAt = Date.now();
  const databasePath = path.join(snapshotDir, DB_NAME);
  const integrity: string[] = [];
  const canary: string[] = [];
  let schemaVersion = 0;
  try {
    if (!existsSync(databasePath)) throw new Error("snapshot database is missing");
    if (manifest) {
      for (const file of manifest.files) {
        const full = path.join(snapshotDir, file.path);
        if (!existsSync(full)) throw new Error("snapshot file is missing: " + file.path);
        if (statSync(full).size !== file.bytes) throw new Error("snapshot file size mismatch: " + file.path);
        if (sha256File(full) !== file.sha256) throw new Error("snapshot file hash mismatch: " + file.path);
      }
    }
    const snapshot = new Database(databasePath, { readonly: true });
    try {
      for (const row of snapshot.query<Record<string, unknown>, []>("PRAGMA integrity_check").all()) {
        integrity.push(String(Object.values(row)[0] ?? ""));
      }
      if (integrity.length !== 1 || integrity[0] !== "ok") {
        throw new Error("integrity_check failed: " + (integrity.join("; ") || "no result"));
      }
      schemaVersion = Number(snapshot.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
      if (schemaVersion <= 0) throw new Error("snapshot reports schema version 0");
      for (const table of CANARY_TABLES) {
        // A bare row count proves the table exists, is readable and its b-tree
        // is intact — exactly what the first dashboard query after a restore
        // needs.
        snapshot.query('SELECT COUNT(*) AS n FROM "' + table + '"').get();
        canary.push(table);
      }
    } finally {
      snapshot.close();
    }
    return { ok: true, checkedAt: Date.now(), integrity, schemaVersion, canary, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      checkedAt: Date.now(),
      integrity,
      schemaVersion,
      canary,
      error: error instanceof Error ? error.message : "verification failed",
      durationMs: Date.now() - startedAt,
    };
  }
}

export interface SnapshotBuildOptions {
  root: string;
  id: string;
  kind: BackupKind;
  createdAt: number;
  dataDir: string;
  gatewaySecret: string;
  includeDaemon: boolean;
  daemonDirs: string[];
  verify: boolean;
}

/**
 * Build one snapshot directory: VACUUM INTO, secret copy, optional daemon
 * copy, hashes, verification and manifest. Pure filesystem + SQLite; the
 * caller supplies the connection so this runs either in-process or inside the
 * snapshot worker.
 */
export function buildSnapshot(connection: Database, options: SnapshotBuildOptions): BackupManifest {
  const snapshotDir = path.join(options.root, options.id);
  mkdirSync(snapshotDir, { recursive: true });
  try {
    const databasePath = path.join(snapshotDir, DB_NAME);
    // VACUUM INTO refuses to overwrite an existing file; a fresh directory
    // guarantees that. It takes only a shared read lock, so the gateway keeps
    // serving while the copy is written.
    connection.prepare("VACUUM INTO ?").run(databasePath);

    const secret = secretMaterial(options.dataDir, options.gatewaySecret);
    const secretDir = path.join(snapshotDir, SECRET_DIR);
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    for (const entry of secret.entries) {
      writeFileSync(path.join(secretDir, entry.name), entry.content, { mode: entry.mode });
    }

    if (options.includeDaemon) copyDaemonDirs(snapshotDir, options.daemonDirs);

    const files = collectFiles(snapshotDir);
    const manifest: BackupManifest = {
      version: 1,
      id: options.id,
      kind: options.kind,
      createdAt: options.createdAt,
      dir: snapshotDir,
      database: DB_NAME,
      schemaVersion: readSchemaVersion(databasePath),
      dataDir: options.dataDir,
      secretFromEnv: secret.fromEnv,
      includeDaemon: options.includeDaemon,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      verification: null,
    };
    if (options.verify) {
      manifest.verification = verifySnapshot(snapshotDir, manifest);
      if (!manifest.verification.ok) manifest.error = manifest.verification.error;
    }
    writeFileSync(path.join(snapshotDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    return manifest;
  } catch (error) {
    // A half-written snapshot must never look restorable.
    rmSync(snapshotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
}

/** Parse one snapshot manifest; null when the directory is not a snapshot. */
export function readManifest(dir: string): BackupManifest | null {
  const file = path.join(dir, MANIFEST_NAME);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as BackupManifest;
    if (!parsed || parsed.version !== 1 || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface BackupSummary {
  id: string;
  kind: BackupKind;
  createdAt: number;
  ageMs: number;
  bytes: number;
  verified: boolean | null;
  verifiedAt: number | null;
  schemaVersion: number;
  dir: string;
  error?: string;
}

/** Every snapshot under `root`, newest first. Directories without a manifest
 *  (still being written, or crashed mid-copy) are not snapshots. */
export function listSnapshotSummaries(root: string, now = Date.now()): BackupSummary[] {
  if (!existsSync(root)) return [];
  const summaries: BackupSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    summaries.push({
      id: manifest.id,
      kind: manifest.kind,
      createdAt: manifest.createdAt,
      ageMs: Math.max(0, now - manifest.createdAt),
      bytes: manifest.totalBytes,
      verified: manifest.verification ? manifest.verification.ok : null,
      verifiedAt: manifest.verification ? manifest.verification.checkedAt : null,
      schemaVersion: manifest.schemaVersion,
      dir: manifest.dir || dir,
      ...(manifest.error ? { error: manifest.error } : {}),
    });
  }
  return summaries.sort((a, b) => b.createdAt - a.createdAt);
}

export interface RetentionResult {
  removed: string[];
  keptDaily: string[];
  keptWeekly: string[];
}

/**
 * Retention: keep the newest `keepDaily` snapshots plus the newest snapshot
 * of each of the last `keepWeekly` ISO weeks. Anything else is removed
 * (directory included) once nothing else references it.
 */
export function applyRetentionRules(root: string, options: { keepDaily: number; keepWeekly: number; now: number; removeFiles: boolean }): RetentionResult {
  const backups = listSnapshotSummaries(root, options.now);
  if (backups.length === 0) return { removed: [], keptDaily: [], keptWeekly: [] };
  const keep = new Set<string>();
  const daily = backups.slice(0, options.keepDaily);
  for (const backup of daily) keep.add(backup.id);

  // ISO weeks, Monday-based, in UTC: the newest snapshot of each week is the
  // weekly restore point, which keeps a month of history at daily granularity
  // and older history at one snapshot per week.
  const weekKey = (ts: number) => {
    const monday = new Date(ts);
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    return monday.toISOString().slice(0, 10);
  };
  const weeks = new Map<string, string>();
  for (const backup of backups) {
    const key = weekKey(backup.createdAt);
    if (!weeks.has(key)) weeks.set(key, backup.id);
  }
  const keptWeekly = [...weeks.values()].slice(0, options.keepWeekly);
  for (const id of keptWeekly) keep.add(id);

  const removed: string[] = [];
  for (const backup of backups) {
    if (keep.has(backup.id)) continue;
    if (options.removeFiles) rmSync(path.join(root, backup.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    removed.push(backup.id);
  }
  return { removed, keptDaily: daily.map((backup) => backup.id), keptWeekly };
}
