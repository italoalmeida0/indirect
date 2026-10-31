import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { sqliteRetryDelay, withSqliteRetry, retrySqlite, isRetryableSqliteError } from "../server/sqlite-retry";
import { batchDelete, batchDeleteComposite } from "../server/batch-delete";
import { guardedMaintenance, scheduleMaintenance } from "../server/maintenance";
import { freshDir, removeTree } from "./sqlite-fixture";

const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
const plain = () => new Error("no such table: nope");

function fixtureDatabase(name: string): { db: Database; dir: string } {
  const dir = freshDir(name);
  const db = new Database(path.join(dir, "test.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, ts INTEGER)");
  return { db, dir };
}

describe("withSqliteRetry", () => {
  test("returns immediately when the operation succeeds", () => {
    const result = withSqliteRetry(() => 42);
    expect(result.value).toBe(42);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
  });

  test("retries SQLITE_BUSY and reports the successful attempt count", () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = withSqliteRetry(
      () => {
        attempts++;
        if (attempts < 4) throw busy();
        return "ok";
      },
      { attempts: 5, deadlineMs: 60_000, sleep: (ms) => sleeps.push(ms), random: () => 0.5, log: () => {} },
    );
    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(4);
    expect(result.retried).toBe(true);
    expect(attempts).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  test("gives up at the attempt cap and rethrows the last SQLITE_BUSY", () => {
    let attempts = 0;
    expect(() =>
      withSqliteRetry(
        () => {
          attempts++;
          throw busy();
        },
        { attempts: 3, deadlineMs: 60_000, sleep: () => {}, random: () => 0, log: () => {} },
      ),
    ).toThrow("database is locked");
    expect(attempts).toBe(3);
  });

  test("respects the total deadline instead of the attempt cap", () => {
    let now = 0;
    let attempts = 0;
    expect(() =>
      withSqliteRetry(
        () => {
          attempts++;
          throw busy();
        },
        {
          attempts: 100,
          deadlineMs: 40,
          baseDelayMs: 10,
          maxDelayMs: 10,
          random: () => 0,
          // Advancing the clock without sleeping keeps the test fast while
          // proving the deadline — not the attempt cap — ends the loop.
          sleep: (ms) => { now += ms; },
          now: () => now,
          log: () => {},
        },
      ),
    ).toThrow("database is locked");
    expect(attempts).toBeLessThan(100);
    expect(now).toBeGreaterThanOrEqual(40);
  });

  test("never retries a non-contention error", () => {
    let attempts = 0;
    expect(() =>
      withSqliteRetry(
        () => {
          attempts++;
          throw plain();
        },
        { attempts: 10, deadlineMs: 60_000, sleep: () => {}, log: () => {} },
      ),
    ).toThrow("no such table: nope");
    expect(attempts).toBe(1);
  });

  test("classifies SQLITE_LOCKED and errno 5 as retryable but not arbitrary errors", () => {
    expect(isRetryableSqliteError(Object.assign(new Error("x"), { code: "SQLITE_LOCKED" }))).toBe(true);
    expect(isRetryableSqliteError(Object.assign(new Error("x"), { errno: 5 }))).toBe(true);
    expect(isRetryableSqliteError(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBe(false);
    expect(isRetryableSqliteError(null)).toBe(false);
    expect(isRetryableSqliteError("busy")).toBe(false);
  });

  test("logs once per streak, not once per attempt", () => {
    const lines: string[] = [];
    let attempts = 0;
    withSqliteRetry(
      () => {
        attempts++;
        if (attempts < 6) throw busy();
        return 1;
      },
      { attempts: 8, deadlineMs: 60_000, sleep: () => {}, random: () => 0, name: "unit", log: (m) => lines.push(m) },
    );
    // One "retrying" line and one "recovered" line, never five.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("unit");
    expect(lines[1]).toContain("recovered");
  });

  test("backoff grows exponentially and stays under the ceiling", () => {
    expect(sqliteRetryDelay(1, 25, 400, () => 0)).toBe(13);
    expect(sqliteRetryDelay(2, 25, 400, () => 0)).toBe(25);
    expect(sqliteRetryDelay(3, 25, 400, () => 0)).toBe(50);
    expect(sqliteRetryDelay(20, 25, 400, () => 1)).toBe(400);
  });

  test("retrySqlite returns the value without the bookkeeping", () => {
    expect(retrySqlite(() => "v")).toBe("v");
  });

  test("absorbs a real SQLITE_BUSY held by another process", async () => {
    const { db, dir } = fixtureDatabase("retry-live");
    const databaseFile = path.join(dir, "test.db");
    db.exec("PRAGMA busy_timeout = 0");
    // The lock holder is a SEPARATE process: the retry loop sleeps
    // synchronously on purpose (bun:sqlite is synchronous), so an in-process
    // timer could never release the lock while the loop is backing off.
    const holder = Bun.spawn([
      process.execPath,
      "-e",
      "const {Database}=require('bun:sqlite');" +
        "const d=new Database(process.argv[1]);d.exec('PRAGMA busy_timeout=0');d.exec('BEGIN IMMEDIATE');" +
        "console.log('locked');" +
        "setTimeout(()=>{d.exec('COMMIT');d.close();process.exit(0)},400);",
      databaseFile,
    ], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
      const firstChunk = await reader.read();
      expect(new TextDecoder().decode(firstChunk.value).trim()).toBe("locked");
      reader.releaseLock();
      const started = Date.now();
      const result = withSqliteRetry(
        () => {
          const stmt = db.prepare("INSERT INTO rows(ts) VALUES (?)");
          try {
            return stmt.run(Date.now()).changes;
          } finally {
            stmt.finalize();
          }
        },
        { attempts: 20, deadlineMs: 10_000, baseDelayMs: 20, maxDelayMs: 120, name: "live" },
      );
      await holder.exited;
      expect(result.value).toBe(1);
      expect(result.attempts).toBeGreaterThan(1);
      expect(result.retried).toBe(true);
      expect(Date.now() - started).toBeGreaterThan(200);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rows").get()!.n).toBe(1);
    } finally {
      try { holder.kill(); } catch {}
      db.close();
      await removeTree(dir);
    }
  });
});

describe("guardedMaintenance", () => {
  test("swallows a synchronous throw so a timer never kills the process", async () => {
    const seen: Array<{ ok: boolean }> = [];
    const job = guardedMaintenance("boom", () => { throw new Error("kaboom"); }, { retry: { attempts: 1, sleep: () => {}, log: () => {} }, onResult: (r) => seen.push({ ok: r.ok }) });
    expect(() => job()).not.toThrow();
    await job.settled();
    expect(seen).toEqual([{ ok: false }]);
  });

  test("swallows a rejected promise from an async job", async () => {
    const seen: Array<{ ok: boolean }> = [];
    const job = guardedMaintenance("async-boom", async () => { throw new Error("kaboom"); }, { retry: { attempts: 1, sleep: () => {}, log: () => {} }, onResult: (r) => seen.push({ ok: r.ok }) });
    expect(() => job()).not.toThrow();
    await job.settled();
    expect(seen).toEqual([{ ok: false }]);
  });

  test("retries transient contention in-process before reporting failure", async () => {
    let attempts = 0;
    const seen: boolean[] = [];
    const job = guardedMaintenance("busy", () => {
      attempts++;
      if (attempts < 3) throw busy();
    }, { retry: { attempts: 5, deadlineMs: 5_000, sleep: () => {}, random: () => 0, log: () => {} }, onResult: (r) => seen.push(r.ok) });
    expect(() => job()).not.toThrow();
    // Runs are asynchronous (a blocking retry loop would freeze the gateway),
    // so settle before asserting.
    await job.settled();
    expect(attempts).toBe(3);
    expect(seen).toEqual([true]);
  });

  test("scheduleMaintenance returns an unref'd interval and stops on clear", async () => {
    let runs = 0;
    const timer = scheduleMaintenance("tick", () => { runs++; }, 5);
    await Bun.sleep(40);
    clearInterval(timer);
    expect(runs).toBeGreaterThan(0);
  });
});

describe("batchDelete", () => {
  function seed(name: string, rows: number): { db: Database; dir: string } {
    const fixture = fixtureDatabase(name);
    const insert = fixture.db.prepare("INSERT INTO rows(ts) VALUES (?)");
    try {
      fixture.db.transaction(() => { for (let i = 0; i < rows; i++) insert.run(i); })();
    } finally {
      insert.finalize();
    }
    return fixture;
  }

  test("deletes everything matching the predicate across several batches", async () => {
    const { db, dir } = seed("batch-all", 1_200);
    try {
      // 1,200 rows with ts = 0..1199; the predicate keeps 900 of them.
      const result = batchDelete(db, { table: "rows", where: "ts < ?", params: [900], batchSize: 250, maxRows: 100_000 });
      expect(result.deleted).toBe(900);
      expect(result.batches).toBe(4);
      expect(result.truncated).toBe(false);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rows WHERE ts < 900").get()!.n).toBe(0);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rows").get()!.n).toBe(300);
    } finally {
      db.close();
      await removeTree(dir);
    }
  });

  test("honors maxRows so one scheduled run cannot delete an unbounded amount", async () => {
    const { db, dir } = seed("batch-cap", 1_000);
    try {
      const result = batchDelete(db, { table: "rows", where: "ts >= 0", batchSize: 100, maxRows: 250 });
      expect(result.deleted).toBe(250);
      expect(result.truncated).toBe(true);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rows").get()!.n).toBe(750);
    } finally {
      db.close();
      await removeTree(dir);
    }
  });

  test("works on a WITHOUT ROWID table through explicit key columns", async () => {
    const { db, dir } = fixtureDatabase("batch-composite");
    db.exec("CREATE TABLE composite (bucket INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY(bucket, key)) WITHOUT ROWID");
    const insert = db.prepare("INSERT INTO composite(bucket, key) VALUES (?, ?)");
    try {
      db.transaction(() => {
        for (let bucket = 0; bucket < 10; bucket++) for (let key = 0; key < 50; key++) insert.run(bucket, "k" + key);
      })();
    } finally {
      insert.finalize();
    }
    try {
      const result = batchDeleteComposite({ db, table: "composite", keys: ["bucket", "key"], where: "bucket < ?", params: [7], batchSize: 100 });
      expect(result.deleted).toBe(350);
      expect(result.batches).toBeGreaterThan(1);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM composite").get()!.n).toBe(150);
    } finally {
      db.close();
      await removeTree(dir);
    }
  });

  test("each batch releases the write lock between statements", async () => {
    const { db, dir } = seed("batch-lock", 500);
    const observer = new Database(path.join(dir, "test.db"));
    observer.exec("PRAGMA busy_timeout = 2000");
    let observedIncrements = 0;
    try {
      // Every batch must leave the table visible in a committed state, which
      // only holds if the deletes are separate transactions.
      const result = batchDelete(db, {
        table: "rows",
        where: "ts >= 0",
        batchSize: 100,
        maxRows: 1_000,
        onBatch: () => {
          const seen = observer.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rows").get()!.n;
          if (seen < 500) observedIncrements++;
        },
      });
      expect(result.deleted).toBe(500);
      expect(observedIncrements).toBeGreaterThan(1);
    } finally {
      observer.close();
      db.close();
      await removeTree(dir);
    }
  });
});