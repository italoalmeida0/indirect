import { isSqliteBusy } from "./db";

/**
 * Shared retry policy for transient SQLite contention.
 *
 * A periodic job that touches the database must never terminate the process
 * because another connection (a backup tool, an operator's sqlite3 session, a
 * second gateway) briefly holds the write lock. Bun turns an escaping timer
 * throw or an unhandled rejection into an exit code 1, so every periodic job
 * funnels through `guardedMaintenance` (see maintenance.ts), which uses the
 * helpers here.
 *
 * The policy is deliberately small and bounded:
 *  - only SQLITE_BUSY / SQLITE_LOCKED are retried; every other error is
 *    rethrown immediately, so a real bug (bad SQL, constraint violation, disk
 *    full) is never swallowed,
 *  - retries stop at a hard attempt cap AND a total deadline, whichever comes
 *    first,
 *  - backoff is exponential with equal jitter, so several jobs unblocking
 *    together do not stampede the writer,
 *  - the caller decides what to do after the deadline (periodic jobs log once
 *    and let the next scheduled run start over).
 *
 * Waiting is a synchronous sleep on purpose: bun:sqlite is synchronous, so a
 * promise-based delay would let the rest of the periodic work interleave and
 * turn a bounded retry into an unbounded pile-up. The waits are short
 * (milliseconds), and the jobs that use this helper are maintenance sweeps,
 * never request paths.
 */

export interface SqliteRetryOptions {
  /** Total attempts, including the first one. Must be >= 1. */
  attempts?: number;
  /** Wall-clock budget for the whole operation, including the first attempt. */
  deadlineMs?: number;
  /** First backoff delay; doubles per attempt up to `maxDelayMs`. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff delay. */
  maxDelayMs?: number;
  /** Label used by the default logger ("billing heartbeat", ...). */
  name?: string;
  /**
   * Called once per operation when the first transient failure is seen and
   * once when a retry finally succeeds — never once per attempt, so a lock
   * held for a minute produces two lines, not thousands.
   */
  log?: (message: string) => void;
  /** Injectable clock/sleep for tests; production uses Date.now/Bun.sleepSync. */
  now?: () => number;
  sleep?: (ms: number) => void;
  /** Deterministic jitter source for tests; defaults to Math.random. */
  random?: () => number;
}

export interface SqliteRetryResult<T> {
  value: T;
  /** Attempts actually used (1 when the first attempt succeeded). */
  attempts: number;
  /** Total wall-clock time spent, including backoff sleeps. */
  elapsedMs: number;
  /** True when at least one transient failure was retried. */
  retried: boolean;
}

export const SQLITE_RETRY_DEFAULTS = {
  attempts: 5,
  deadlineMs: 4_000,
  baseDelayMs: 25,
  maxDelayMs: 800,
} as const;

/** True when the error is transient SQLite contention, never for anything else. */
export function isRetryableSqliteError(error: unknown): boolean {
  return isSqliteBusy(error);
}

/** Exponential backoff with equal jitter: delay/2 + random * delay/2. */
export function sqliteRetryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number = Math.random): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const half = exponential / 2;
  return Math.max(1, Math.round(half + random() * half));
}

const defaultSleep = (ms: number): void => {
  const sleepSync = (Bun as { sleepSync?: (ms: number) => void }).sleepSync;
  if (typeof sleepSync === "function") sleepSync(ms);
  else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Run `operation`, retrying transient SQLite contention with bounded backoff.
 * Any non-contention error propagates immediately and unchanged.
 */
export function withSqliteRetry<T>(operation: () => T, options: SqliteRetryOptions = {}): SqliteRetryResult<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? SQLITE_RETRY_DEFAULTS.attempts));
  const deadlineMs = Math.max(0, options.deadlineMs ?? SQLITE_RETRY_DEFAULTS.deadlineMs);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? SQLITE_RETRY_DEFAULTS.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? SQLITE_RETRY_DEFAULTS.maxDelayMs);
  const log = options.log ?? ((message: string) => console.warn(message));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const label = options.name ? `${options.name}: ` : "";
  const startedAt = now();
  let retried = false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = operation();
      if (retried) log(`[SQLITE] ${label}recovered after ${attempt} attempt(s) in ${Math.round(now() - startedAt)}ms`);
      return { value, attempts: attempt, elapsedMs: now() - startedAt, retried };
    } catch (error) {
      lastError = error;
      if (!isRetryableSqliteError(error)) throw error;
      if (attempt === attempts) break;
      const delay = sqliteRetryDelay(attempt, baseDelayMs, maxDelayMs, random);
      if (now() - startedAt + delay > deadlineMs) break;
      if (!retried) {
        retried = true;
        log(`[SQLITE] ${label}database busy; retrying in bounded batches (up to ${attempts} attempts / ${deadlineMs}ms)`);
      }
      sleep(delay);
    }
  }

  throw lastError;
}

/** Convenience wrapper that returns only the value. */
export function retrySqlite<T>(operation: () => T, options: SqliteRetryOptions = {}): T {
  return withSqliteRetry(operation, options).value;
}

/**
 * Async variant used by periodic jobs.
 *
 * The synchronous `withSqliteRetry` sleeps by blocking the thread, which is
 * acceptable during boot (nothing else is running yet) but NOT inside the
 * gateway: a 4-second retry loop on a maintenance job would freeze every
 * request, including /api/health. This variant awaits between attempts, so the
 * event loop keeps serving while a job backs off.
 *
 * The operation may be synchronous (bun:sqlite commits or throws immediately)
 * or asynchronous (a job that awaits between statements). Its result is
 * awaited, so a REJECTED promise is retried/classified like a thrown error —
 * typing this as `() => T` instead was a real defect: an async job's rejection
 * escaped the retry loop, the wrapper reported success, and the unhandled
 * rejection terminated the process.
 */
export async function withSqliteRetryAsync<T>(operation: () => T | Promise<T>, options: SqliteRetryOptions = {}): Promise<SqliteRetryResult<T>> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? SQLITE_RETRY_DEFAULTS.attempts));
  const deadlineMs = Math.max(0, options.deadlineMs ?? SQLITE_RETRY_DEFAULTS.deadlineMs);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? SQLITE_RETRY_DEFAULTS.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? SQLITE_RETRY_DEFAULTS.maxDelayMs);
  const log = options.log ?? ((message: string) => console.warn(message));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const label = options.name ? options.name + ": " : "";
  const startedAt = now();
  let retried = false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await operation();
      if (retried) log(`[SQLITE] ${label}recovered after ${attempt} attempt(s) in ${Math.round(now() - startedAt)}ms`);
      return { value, attempts: attempt, elapsedMs: now() - startedAt, retried };
    } catch (error) {
      lastError = error;
      if (!isRetryableSqliteError(error)) throw error;
      if (attempt === attempts) break;
      const delay = sqliteRetryDelay(attempt, baseDelayMs, maxDelayMs, random);
      if (now() - startedAt + delay > deadlineMs) break;
      if (!retried) {
        retried = true;
        log(`[SQLITE] ${label}database busy; retrying in bounded batches (up to ${attempts} attempts / ${deadlineMs}ms)`);
      }
      // Yield to the event loop instead of blocking it.
      await Bun.sleep(delay);
    }
  }

  throw lastError;
}

/** Async convenience wrapper that returns only the value. */
export async function retrySqliteAsync<T>(operation: () => T | Promise<T>, options: SqliteRetryOptions = {}): Promise<T> {
  return (await withSqliteRetryAsync(operation, options)).value;
}