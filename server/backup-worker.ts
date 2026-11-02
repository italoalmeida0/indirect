
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
 *  - a worker failure is reported instead of blocking serving traffic with an
 *    unexpected synchronous fallback.
 *
 * Snapshot creation receives the configured encryption material so it can
 * preserve it in the protected snapshot directory. It is never logged.
 */
import { parentPort, workerData } from "node:worker_threads";
import { Database } from "bun:sqlite";
import {
  buildSnapshot,
  verifyAndRecordSnapshot,
  type BackupManifest,
  type BackupVerification,
  type SnapshotBuildOptions,
} from "./backup-files";

export type BackupWorkerData =
  | ({ op?: "create"; source: string } & SnapshotBuildOptions)
  | { op: "verify"; snapshotDir: string };

export type BackupWorkerReply =
  | { ok: true; manifest: BackupManifest }
  | { ok: true; verification: BackupVerification }
  | { ok: false; error: string };

const data = workerData as BackupWorkerData | undefined;
if (data) {
  let connection: Database | null = null;
  const reply: BackupWorkerReply = (() => {
    try {
      if (data.op === "verify") {
        return {
          ok: true,
          verification: verifyAndRecordSnapshot(data.snapshotDir),
        };
      }
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
