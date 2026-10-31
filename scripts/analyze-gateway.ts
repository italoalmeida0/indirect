/** Build SQLite planner statistics for an existing gateway database, offline.
 *
 * The gateway deliberately refuses to run an unbounded ANALYZE inside boot: on
 * a large database whose statistics were never built (a restored copy, a
 * seeded capacity fixture, a database grown by another tool) ANALYZE scans
 * every index before the HTTP server exists. Boot then logs
 * "[DB] planner statistics missing on a N-page database" and continues with
 * slightly worse plans.
 *
 * Run this once, with the gateway stopped, to restore full plan quality:
 *
 *   DATA_DIR=./data bun scripts/analyze-gateway.ts
 *   DATA_DIR=./data bun scripts/analyze-gateway.ts --limit=400   # cheaper
 *
 * `PRAGMA analysis_limit` keeps the per-index sample bounded, which is what
 * SQLite recommends for large schemas. The result is written to sqlite_stat1,
 * so every later boot finds statistics and only runs the incremental
 * `PRAGMA optimize`.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const limit = Number(option("limit") ?? 400);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new Error("--limit must be a bounded positive integer");

const dir = path.resolve(process.env.DATA_DIR ?? "./data");
const file = path.join(dir, "gateway.db");
if (!existsSync(file)) throw new Error(`no gateway database at ${file} (set DATA_DIR)`);

const db = new Database(file);
db.exec("PRAGMA busy_timeout=10000");
try {
  // A write transaction held by a running gateway would make ANALYZE wait and
  // then silently degrade; fail loudly instead of pretending it worked.
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch {
    throw new Error("the database is locked; stop the gateway before analyzing it");
  }
  const before = statSync(file).size;
  const started = performance.now();
  db.exec(`PRAGMA analysis_limit = ${limit}`);
  db.exec("PRAGMA optimize");
  const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_stat1").get()?.n ?? 0;
  console.log(JSON.stringify({
    database: file,
    bytesBefore: before,
    statisticsRows: rows,
    analysisLimit: limit,
    elapsedMs: Math.round(performance.now() - started),
  }));
} finally { db.close(); }
