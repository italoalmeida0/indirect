import { withSqliteRetryAsync, type SqliteRetryOptions } from "./sqlite-retry";

/**
 * Wrapper for periodic work.
 *
 * Two failure modes are covered:
 *  1. Transient SQLite contention — retried with the shared bounded policy
 *     (server/sqlite-retry.ts) before the job is declared failed.
 *  2. Anything else — logged once per failure streak; the next scheduled run
 *     retries from the beginning. The wrapper NEVER rethrows and NEVER leaves
 *     a rejected promise: an exception escaping a timer callback, or an
 *     unhandled rejection, makes Bun exit the process with code 1 — which is
 *     the "gateway died with SQLITE_BUSY" report.
 *
 * Retries are asynchronous even for synchronous jobs. A maintenance sweep that
 * backed off by blocking the thread would freeze every request for the length
 * of the backoff window, including /api/health; awaiting between attempts
 * keeps the gateway responsive while a job waits for the writer.
 */

export interface MaintenanceOptions {
  /** Retry policy override; defaults to the shared bounded policy. */
  retry?: SqliteRetryOptions;
  /** Runs once per invocation after the job settles (success or failure). */
  onResult?: (result: { ok: boolean; error?: unknown }) => void;
}

export interface MaintenanceJob {
  /**
   * Start one run. Returns immediately; the run (including retries) finishes
   * asynchronously and never throws. A run that is still in flight suppresses
   * the next invocation so slow jobs cannot pile up.
   */
  (): void;
  /** Resolves when the current run (if any) has settled. */
  settled: () => Promise<void>;
  /** True while a run is in flight. */
  readonly running: boolean;
}

/** Default policy for periodic work.
 *
 * Deliberately SHORT. While another connection holds the write lock, every
 * attempt blocks the thread for the full sqlite busy_timeout before it can even
 * report SQLITE_BUSY, so a long retry budget is not "patience" — it is a
 * repeated stall of the event loop, which is what made /api/health spike past
 * a second. A periodic job should give up quickly and let the NEXT scheduled
 * run try again; the schedule is the retry.
 */
const MAINTENANCE_RETRY: SqliteRetryOptions = {
  attempts: 2,
  deadlineMs: 250,
  baseDelayMs: 25,
  maxDelayMs: 100,
};

export function guardedMaintenance(name: string, job: () => void | Promise<void>, options: MaintenanceOptions = {}): MaintenanceJob {
  const retry: SqliteRetryOptions = { ...MAINTENANCE_RETRY, ...options.retry, name };
  let inFlight: Promise<void> | null = null;
  let failed = false;

  const settle = (ok: boolean, error?: unknown): void => {
    if (ok) {
      if (failed) console.info(`[MAINTENANCE] ${name} recovered`);
      failed = false;
    } else if (!failed) {
      failed = true;
      console.error(`[MAINTENANCE] ${name} failed; will retry:`, error instanceof Error ? error.message : "unknown error");
    }
    options.onResult?.({ ok, ...(ok ? {} : { error }) });
  };

  const run = async (): Promise<void> => {
    try {
      await withSqliteRetryAsync(async () => { await job(); }, retry);
      settle(true);
    } catch (error) {
      settle(false, error);
    }
  };

  const invoke = (() => {
    if (inFlight) return;
    inFlight = run().finally(() => { inFlight = null; });
  }) as MaintenanceJob;

  Object.defineProperty(invoke, "running", { get: () => inFlight !== null });
  invoke.settled = async () => { await inFlight; };
  return invoke;
}

/**
 * Start a periodic maintenance timer and keep it out of the process' exit gate
 * (`unref`). Returns the timer so a caller can clear it.
 */
export function scheduleMaintenance(name: string, job: () => void | Promise<void>, everyMs: number, options: MaintenanceOptions = {}): ReturnType<typeof setInterval> {
  const timer = setInterval(guardedMaintenance(name, job, options), everyMs);
  timer.unref();
  return timer;
}
