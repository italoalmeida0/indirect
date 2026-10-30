import type { Database } from "bun:sqlite";

/**
 * Bounded-batch deletes for periodic cleanup.
 *
 * An unbounded `DELETE FROM big_table WHERE ts < ?` runs as ONE write
 * transaction: it holds the write lock for the whole scan, blocks every other
 * writer, and can blow up the WAL. Splitting the same statement into bounded
 * primary-key batches keeps each lock hold short, lets concurrent writers
 * interleave, and makes an interrupted cleanup resumable (the next scheduled
 * run simply continues from the remaining rows).
 *
 * Batches are keyed by rowid/primary key — never by an offset — so progress is
 * monotonic even while other connections insert or delete rows.
 */

export interface BatchDeleteOptions {
  /** Rows per statement. Clamped to [1, 100_000]. */
  batchSize?: number;
  /** Stop after this many batches (a safety valve for one scheduled run). */
  maxBatches?: number;
  /** Predicate for an optional per-batch hook, e.g. yield to the event loop. */
  onBatch?: (info: { deleted: number; total: number; batch: number }) => void;
  /** Retry wrapper applied to each batch (defaults to the shared policy). */
  retry?: <T>(operation: () => T) => T;
}

export interface BatchDeleteResult {
  deleted: number;
  batches: number;
  /** True when the loop stopped on maxBatches instead of running dry. */
  truncated: boolean;
}

const DEFAULT_BATCH = 500;
const HARD_BATCH_CAP = 100_000;

interface BatchPlan {
  /** Table to delete from (already validated by the caller). */
  table: string;
  /** Column used for keyset paging. */
  key: string;
  /** Extra predicate (without the leading AND) or empty string. */
  where: string;
  params: Array<string | number | null>;
}

function runBatch(db: Database, plan: BatchPlan, batchSize: number, retry: <T>(operation: () => T) => T): number {
  const predicate = plan.where ? ` AND (${plan.where})` : "";
  const statement = db.prepare(
    `DELETE FROM ${plan.table}
      WHERE ${plan.key} IN (
        SELECT ${plan.key} FROM ${plan.table} WHERE 1 = 1${predicate}
        ORDER BY ${plan.key} LIMIT ?
      )`,
  );
  try {
    return retry(() => statement.run(...plan.params, batchSize).changes);
  } finally {
    statement.finalize();
  }
}

/**
 * Delete at most `maxRows` rows matching `where`, in bounded batches.
 * Returns the number of rows actually removed.
 */
export function batchDelete(db: Database, options: BatchDeleteOptions & { table: string; key?: string; where?: string; params?: Array<string | number | null>; maxRows?: number }): BatchDeleteResult {
  const batchSize = Math.min(HARD_BATCH_CAP, Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH)));
  const maxBatches = options.maxBatches ?? Infinity;
  const maxRows = options.maxRows ?? Infinity;
  const key = options.key ?? "rowid";
  const retry = options.retry ?? (<T>(operation: () => T): T => operation());
  const plan: BatchPlan = { table: options.table, key, where: options.where ?? "", params: options.params ?? [] };
  let deleted = 0;
  let batches = 0;
  let truncated = false;
  for (;;) {
    if (batches >= maxBatches || deleted >= maxRows) { truncated = true; break; }
    // Never request more rows than the remaining budget, so the cap is exact.
    const limit = Math.min(batchSize, maxRows - deleted);
    const changed = runBatch(db, plan, limit, retry);
    batches++;
    deleted += changed;
    options.onBatch?.({ deleted: changed, total: deleted, batch: batches });
    if (changed < limit) break;
  }
  return { deleted, batches, truncated };
}

/**
 * Same shape for tables without a usable integer key (WITHOUT ROWID tables):
 * the caller supplies an explicit list of key columns and a predicate.
 */
export function batchDeleteComposite(options: BatchDeleteOptions & {
  db: Database;
  table: string;
  /** Columns selected by the inner query, in the same order as the DELETE. */
  keys: string[];
  /** Predicate on the table itself (no leading WHERE). */
  where: string;
  params?: Array<string | number | null>;
  maxRows?: number;
}): BatchDeleteResult {
  const batchSize = Math.min(HARD_BATCH_CAP, Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH)));
  const maxBatches = options.maxBatches ?? Infinity;
  const maxRows = options.maxRows ?? Infinity;
  const keyList = options.keys.join(",");
  const retry = options.retry ?? (<T>(operation: () => T): T => operation());
  let deleted = 0;
  let batches = 0;
  let truncated = false;
  for (;;) {
    if (batches >= maxBatches || deleted >= maxRows) { truncated = true; break; }
    const limit = Math.min(batchSize, maxRows - deleted);
    const statement = options.db.prepare(
      `DELETE FROM ${options.table}
        WHERE (${keyList}) IN (
          SELECT ${keyList} FROM ${options.table} WHERE ${options.where}
          ORDER BY ${keyList} LIMIT ?
        )`,
    );
    let changed: number;
    try {
      changed = retry(() => statement.run(...(options.params ?? []), limit).changes);
    } finally {
      statement.finalize();
    }
    batches++;
    deleted += changed;
    options.onBatch?.({ deleted: changed, total: deleted, batch: batches });
    if (changed < limit) break;
  }
  return { deleted, batches, truncated };
}