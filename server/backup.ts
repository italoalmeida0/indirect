
import { Worker } from "node:worker_threads";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, GATEWAY_SECRET, LIMITS } from "./config";
import { db } from "./db";
import {
  applyRetentionRules,
  buildSnapshot,
  listSnapshotSummaries,
  manifestTimestamp,
  type BackupKind,
  type BackupManifest,
  type BackupSummary,
  type RetentionResult,
} from "./backup-files";
import type { BackupWorkerData, BackupWorkerReply } from "./backup-worker";
import { withSqliteRetryAsync } from "./sqlite-retry";

/**
 * Supported backup: snapshot, verification, retention and scheduling.
 *
 * A snapshot is produced with `VACUUM INTO`, which writes a consistent copy of
 * the live database through an ordinary read transaction. The gateway keeps
 * serving while the copy runs: WAL frames written during the copy are simply
 * not part of the snapshot, and the result is a self-contained database file
 * (no -wal, no journal) that can be opened read-only anywhere.
 *
 * A snapshot is only "supported" because everything a restore needs travels
 * with it:
 *   gateway.db      the VACUUM INTO copy,
 *   secret/<name>   the credential-encryption secret material. Provider keys
 *                   and API-key tokens are AES-256-GCM blobs keyed from
 *                   INDIRECT_SECRET (or the generated DATA_DIR/.secret); a
 *                   database-only restore cannot decrypt them,
 *   daemon/<host>/  optional Indirect Code daemon data directories,
 *   manifest.json   tree: tracksummary, schema version, sizes, SHA-256 hashes
 *                   and the verification result.
 *
 * Verification NEVER touches the live database: it re-opens the snapshot
 * read-only, re-hashes every recorded file, runs PRAGMA integrity_check, reads
 * the schema version and executes a canary query per critical table.
 */

export type { BackupKind, BackupFileEntry, BackupManifest, BackupSummary, BackupVerification } from "./backup-files";

export interface CreateBackupOptions {
  kind?: BackupKind;
  /** Override the snapshot root (tests, operators). */
  dir?: string;
  /** Override the daemon-directory copy decision. */
  includeDaemon?: boolean;
  /** Extra daemon directories to copy when the copy is enabled. */
  daemonDirs?: string[];
  /** Skip verification (the admin and CLI flows always verify). */
  verify?: boolean;
  /**
   * Build the snapshot on this thread instead of a worker. Used by the
   * restore-verification script and as the fallback when a worker cannot
   * start.
   */
  inProcess?: boolean;
  /** Hard timeout for a worker snapshot, in milliseconds. */
  timeoutMs?: number;
}

function newSnapshotId(kind: BackupKind, createdAt: number): string {
  // Shared with the verifier so a manifest id can be parsed back into a time.
  return manifestTimestamp(createdAt) + "-" + kind + "-" + createdAt.toString(36);
}

/** Snapshot root: BACKUP_DIR when set, else <DATA_DIR>/backups. */
export function backupRoot(explicit?: string): string {
  return path.resolve(explicit || LIMITS.backupDir || path.join(DATA_DIR, "backups"));
}

/**
 * Default Indirect Code daemon data directories for this host. The daemon
 * keeps sessions, WAL transcripts and its config under ~/.indirect-code
 * (indirect-code-daemon/cmd/daemon/datadir.go).
 */
export function defaultDaemonDirs(): string[] {
  const dirs = [...LIMITS.backupDaemonDirs];
  const fromEnv = process.env.INDIRECT_CODE_DATA_DIRS;
  if (fromEnv) dirs.push(...fromEnv.split(",").map((s) => s.trim()).filter(Boolean));
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    dirs.push(path.join(home, ".indirect-code"));
    if (process.platform === "win32" && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "indirect-code"));
    if (process.platform === "darwin") dirs.push(path.join(home, "Library", "Application Support", "indirect-code"));
  }
  return [...new Set(dirs.filter(Boolean))];
}

function snapshotOptions(options: CreateBackupOptions, kind: BackupKind, createdAt: number) {
  return {
    root: backupRoot(options.dir),
    id: newSnapshotId(kind, createdAt),
    kind,
    createdAt,
    dataDir: DATA_DIR,
    gatewaySecret: GATEWAY_SECRET,
    includeDaemon: options.includeDaemon ?? LIMITS.backupIncludeDaemon,
    daemonDirs: options.daemonDirs ?? defaultDaemonDirs(),
    verify: options.verify !== false,
  };
}

/**
 * Build the snapshot in a worker thread. Rejects when the worker cannot be
 * created or times out; the caller then falls back to the main thread.
 */
async function snapshotInWorker(options: ReturnType<typeof snapshotOptions>, timeoutMs: number): Promise<BackupManifest> {
  const source = path.join(DATA_DIR, "gateway.db");
  const worker = new Worker(new URL("./backup-worker.ts", import.meta.url), {
    workerData: { ...options, source } satisfies BackupWorkerData,
  });
  worker.unref();
  try {
    return await new Promise<BackupManifest>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("snapshot worker timed out")), timeoutMs);
      timer.unref();
      worker.once("message", (reply: BackupWorkerReply) => {
        clearTimeout(timer);
        if (reply.ok && "manifest" in reply) resolve(reply.manifest);
        else reject(new Error(reply.ok ? "unexpected worker reply" : reply.error));
      });
      worker.once("error", (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("snapshot worker failed"));
      });
      worker.once("exit", (code: number) => {
        if (code === 0) return;
        clearTimeout(timer);
        reject(new Error("snapshot worker exited with code " + code));
      });
    });
  } finally {
    void worker.terminate().catch(() => undefined);
  }
}

/**
 * Create one verified snapshot. Safe while the gateway serves traffic.
 * Falls back to running the copy on the main thread when worker threads are
 * unavailable, so a restricted runtime degrades in speed, not in function.
 */
export async function createBackup(options: CreateBackupOptions = {}): Promise<BackupManifest> {
  const kind = options.kind || "manual";
  const createdAt = Date.now();
  const build = snapshotOptions(options, kind, createdAt);
  if (!options.inProcess) {
    try {
      return await snapshotInWorker(build, options.timeoutMs ?? 30 * 60_000);
    } catch (error) {
      // Only fall back for infrastructure problems (no worker support); a
      // snapshot that failed on its own merits must surface its error.
      if (!/worker/i.test(error instanceof Error ? error.message : String(error))) throw error;
      console.warn("[BACKUP] snapshot worker unavailable, copying in process:", error instanceof Error ? error.message : error);
    }
  }
  // AWAIT the retry: this runs inside the live gateway (scheduled or admin
  // triggered), so the backoff must yield the event loop. The synchronous
  // variant sleeps by blocking the thread, which stalls every request for up
  // to the whole retry window while another writer holds the database.
  return (await withSqliteRetryAsync(() => buildSnapshot(db, build), { name: "backup snapshot" })).value;
}

async function verifyInWorker(
  snapshotDir: string,
  timeoutMs: number,
): Promise<import("./backup-files").BackupVerification> {
  const worker = new Worker(new URL("./backup-worker.ts", import.meta.url), {
    workerData: { op: "verify", snapshotDir } satisfies BackupWorkerData,
  });
  worker.unref();
  try {
    return await new Promise<import("./backup-files").BackupVerification>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("verification worker timed out")), timeoutMs);
      timer.unref();
      worker.once("message", (reply: BackupWorkerReply) => {
        clearTimeout(timer);
        if (reply.ok && "verification" in reply) resolve(reply.verification);
        else reject(new Error(reply.ok ? "unexpected worker reply" : reply.error));
      });
      worker.once("error", (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("verification worker failed"));
      });
      worker.once("exit", (code: number) => {
        if (code === 0) return;
        clearTimeout(timer);
        reject(new Error("verification worker exited with code " + code));
      });
    });
  } finally {
    void worker.terminate().catch(() => undefined);
  }
}

/** Re-open a snapshot read-only in a worker thread and prove it is restorable. */
export async function verifyBackup(
  snapshotDir: string,
  options: { inProcess?: boolean; timeoutMs?: number } = {},
): Promise<import("./backup-files").BackupVerification> {
  if (!options.inProcess) {
    try {
      return await verifyInWorker(snapshotDir, options.timeoutMs ?? 15 * 60_000);
    } catch (error) {
      if (!/worker/i.test(error instanceof Error ? error.message : String(error))) throw error;
      console.warn("[BACKUP] verification worker unavailable, running in process:", error instanceof Error ? error.message : error);
    }
  }
  const { verifySnapshot, readManifest } = await import("./backup-files");
  return verifySnapshot(snapshotDir, readManifest(snapshotDir) ?? undefined);
}

/** Every snapshot under the backup root, newest first. */
export function listBackups(options: { dir?: string; now?: number } = {}): BackupSummary[] {
  return listSnapshotSummaries(backupRoot(options.dir), options.now ?? Date.now());
}

export interface RetentionOptions {
  keepDaily?: number;
  keepWeekly?: number;
  now?: number;
  dir?: string;
  /** Remove the snapshot directories too (default true). */
  removeFiles?: boolean;
}

/**
 * Retention: keep the newest keepDaily snapshots plus the newest snapshot of
 * each of the last keepWeekly ISO weeks. Directories without a manifest (still
 * being written, or crashed mid-copy) are left alone.
 */
export function applyRetention(options: RetentionOptions = {}): RetentionResult {
  const keepDaily = Math.max(1, Math.floor(options.keepDaily ?? LIMITS.backupKeepDaily));
  const keepWeekly = Math.max(0, Math.floor(options.keepWeekly ?? LIMITS.backupKeepWeekly));
  const root = backupRoot(options.dir);
  return applyRetentionRules(root, {
    keepDaily,
    keepWeekly,
    now: options.now ?? Date.now(),
    removeFiles: options.removeFiles !== false,
  });
}

export interface BackupStatus {
  dir: string;
  intervalMinutes: number;
  enabled: boolean;
  keepDaily: number;
  keepWeekly: number;
  includeDaemon: boolean;
  daemonDirs: string[];
  count: number;
  totalBytes: number;
  latest: BackupSummary | null;
  lastAttemptAt: number | null;
  lastAttemptOk: boolean | null;
}

let lastAttemptAt: number | null = null;
let lastAttemptOk: boolean | null = null;

/** Record the outcome of an attempt so the API can flag a failing schedule. */
export function recordBackupAttempt(ok: boolean): void {
  lastAttemptAt = Date.now();
  lastAttemptOk = ok;
}

export function backupStatus(options: { dir?: string; now?: number } = {}): BackupStatus {
  const summaries = listBackups(options);
  const intervalMinutes = LIMITS.backupIntervalMinutes;
  return {
    dir: backupRoot(options.dir),
    intervalMinutes,
    enabled: Number.isFinite(intervalMinutes) && intervalMinutes > 0,
    keepDaily: LIMITS.backupKeepDaily,
    keepWeekly: LIMITS.backupKeepWeekly,
    includeDaemon: LIMITS.backupIncludeDaemon,
    daemonDirs: defaultDaemonDirs(),
    count: summaries.length,
    totalBytes: summaries.reduce((sum, backup) => sum + backup.bytes, 0),
    latest: summaries[0] ?? null,
    lastAttemptAt,
    lastAttemptOk,
  };
}

/**
 * One scheduled cycle: snapshot, verify, prune. A verification failure is
 * recorded but never deletes the snapshot — a bad snapshot is evidence.
 */
export async function runBackupCycle(options: CreateBackupOptions = {}): Promise<{ manifest: BackupManifest; retention: RetentionResult }> {
  const manifest = await createBackup({ ...options, kind: options.kind ?? "scheduled" });
  recordBackupAttempt(manifest.verification ? manifest.verification.ok : true);
  const retention = applyRetention({ dir: options.dir, now: manifest.createdAt });
  if (retention.removed.length) console.info("[BACKUP] retention removed " + retention.removed.length + " snapshot(s)");
  return { manifest, retention };
}

/** Interval in ms for the backup timer; 0 disables scheduling. */
export function backupIntervalMs(): number {
  const minutes = LIMITS.backupIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.max(60_000, Math.round(minutes * 60_000));
}

/** Remove a snapshot directory (operator cleanup / failed runs). */
export function deleteBackup(id: string, options: { dir?: string } = {}): boolean {
  if (!/^[A-Za-z0-9T._-]+$/.test(id)) return false;
  const target = path.join(backupRoot(options.dir), id);
  if (!existsSync(target) || !statSync(target).isDirectory()) return false;
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return true;
}

/** Total size of a directory tree, for status reporting. */
export function directoryBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : statSync(full).size;
  }
  return total;
}
