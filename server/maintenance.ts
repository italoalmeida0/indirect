/** Periodic work must not terminate the process when SQLite is temporarily
 *  locked. The next scheduled run retries the whole operation. */
export function guardedMaintenance(name: string, job: () => void): () => void {
  let failed = false;
  return () => {
    try {
      job();
      if (failed) console.info(`[MAINTENANCE] ${name} recovered`);
      failed = false;
    } catch (error) {
      if (!failed) console.error(`[MAINTENANCE] ${name} failed; will retry:`, error instanceof Error ? error.message : "unknown error");
      failed = true;
    }
  };
}
