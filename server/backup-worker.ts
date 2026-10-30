
/**
 * Snapshot worker: a second SQLite connection, opened read-only, that writes
 * the snapshot with VACUUM INTO.
 *
 * Why a worker instead of the gateway's own connection:
 *  - the copy reads the whole database (seconds to minutes on a large
 *    install). Doing it on the main thread would block the request path,
 *  - a dedicated read-only connection never touches the writer's lock beyond
 *    the shared read lock SQLite already grants WAL readers, so serving
 *    traffic continues unchanged,
 *  - the handler still falls back to the in-process connection when a worker
 *    cannot be created (single-file installs, restricted runtimes).
 *
 * The worker receives only file paths — never a secret value, never a query.
 */
import { parentPort, workerData } from "node:worker_threads";
import { Database } from "bun:sqlite";
import { buildSnapshot, type BackupManifest, type SnapshotBuildOptions } from "./backup-files";

export interface BackupWorkerData extends SnapshotBuildOptions {
  /** Live database file to copy. */
  source: string;
}

export type BackupWorkerReply =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; error: string };

const data = workerData as BackupWorkerData | undefined;
if (data) {
  let connection: Database | null = null;
  const reply: BackupWorkerReply = (() => {
    try {
      connection = new Database(data.source, { readonly: true });
      connection.exec("PRAGMA busy_timeout = 5000");
      return { ok: true, manifest: buildSnapshot(connection, data) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "snapshot failed" };
    } finally {
      connection?.close();
    }
  })();
  parentPort?.postMessage(reply);
}
