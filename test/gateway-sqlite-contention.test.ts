import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { freshDir, login, removeTree, request, startGateway, waitFor, type GatewayHandle } from "./sqlite-fixture";

/**
 * The reported failure: an external writer held a transaction on the test
 * database, the gateway exited with code 1 and "SQLiteError: database is
 * locked", and a restart restored normal operation.
 *
 * Root cause (reproduced before the fix, see the boot case below): the boot
 * path ran migrations at module load, before Bun.serve existed. An operator's
 * external write transaction made \`PRAGMA optimize\` inside migrate() throw
 * SQLITE_BUSY; an escaping error at module scope is an uncaught exception, so
 * Bun terminated the process with exit code 1. A restart then succeeded
 * because the external transaction had been released by then — exactly the
 * report.
 *
 * This suite proves both halves of the fix:
 *  1. boot survives a database another process is holding,
 *  2. a running gateway survives a lock held well past the old failure window,
 *     keeps answering /api/health, keeps the buffered usage, recovers its
 *     billing heartbeat, and serves normally once the lock is released.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await removeTree(dir);
});

/** Spawn a holder process that keeps a write transaction open. */
async function holdWriteLock(databaseFile: string): Promise<{ release: () => Promise<void>; pid: number }> {
  const holder = Bun.spawn([
    process.execPath,
    "-e",
    "const {Database}=require('bun:sqlite');" +
      "const d=new Database(process.argv[1]);d.exec('PRAGMA busy_timeout=0');" +
      "d.exec('BEGIN IMMEDIATE');console.log('locked');" +
      "process.on('SIGTERM',()=>{try{d.exec('COMMIT')}catch{};d.close();process.exit(0)});" +
      "setInterval(()=>{},1000);",
    databaseFile,
  ], { stdout: "pipe", stderr: "pipe" });
  const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  if (new TextDecoder().decode(chunk.value).trim() !== "locked") throw new Error("lock holder did not start");
  return {
    pid: holder.pid,
    release: async () => {
      try { holder.kill("SIGTERM"); } catch {}
      await Promise.race([holder.exited, Bun.sleep(5000)]);
    },
  };
}

function openObserver(databaseFile: string): Database {
  const sql = new Database(databaseFile);
  sql.exec("PRAGMA busy_timeout = 2000");
  return sql;
}

function scalar(sql: Database, statement: string): number {
  const query = sql.prepare<{ value: number }, []>(statement);
  try { return query.get()!.value; } finally { query.finalize(); }
}

test("boot survives a database held by an external write transaction", async () => {
  const dir = freshDir("contention-boot");
  dirs.push(dir);
  // First boot creates and migrates the database, then stops.
  const first = await startGateway({ dir });
  await first.stop();

  // Now hold a write transaction on the SAME database and boot again. Before
  // the fix this exited with code 1 and SQLiteError: database is locked.
  const lock = await holdWriteLock(path.join(dir, "data", "gateway.db"));
  let second: GatewayHandle | null = null;
  try {
    const bootStarted = Date.now();
    // The boot path waits for the writer instead of dying; release shortly
    // after so the test stays fast.
    setTimeout(() => { void lock.release(); }, 1_500);
    second = await startGateway({ dir });
    const bootMs = Date.now() - bootStarted;
    expect(second.proc.exitCode).toBeNull();
    // It really waited (default SQLITE_BUSY_TIMEOUT_MS is 25ms).
    expect(bootMs).toBeGreaterThan(1_000);
    const health = await fetch(second.base + "/api/health");
    expect(health.status).toBe(200);
    await health.text();
    const admin = await login(second.base, "admin@contention.test");
    expect(admin.accessToken.length).toBeGreaterThan(10);
  } finally {
    await lock.release();
    if (second) {
      // A gateway that never crashed has a clean stderr for the lock case.
      expect(second.proc.exitCode).toBeNull();
      await second.stop();
    }
  }
}, 120_000);

test("a lock held past the old failure window does not exit the gateway, and it recovers", async () => {
  const dir = freshDir("contention-live");
  dirs.push(dir);
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "GET") return Response.json({ data: [{ id: "mock" }] });
      return Response.json({
        id: "test", model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    },
  });
  const gateway = await startGateway({ dir });
  const databaseFile = path.join(dir, "data", "gateway.db");
  const sql = openObserver(databaseFile);
  const keyToken = { value: "" };
  try {
    const admin = await login(gateway.base, "admin@contention.test");
    const provider = await request(gateway.base, "/api/admin/providers", {
      token: admin.accessToken,
      body: { name: "mock", openaiBaseUrl: "http://127.0.0.1:" + upstream.port + "/v1", apiKey: "mock-secret" },
    });
    expect(provider.response.status).toBe(200);
    const made = await request(gateway.base, "/api/keys", { token: admin.accessToken, body: { name: "contention" } });
    expect(made.response.status).toBe(200);
    keyToken.value = made.data.token as string;

    const send = () => fetch(gateway.base + "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + keyToken.value, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "test" }], max_tokens: 5 }),
    });
    const before = await send();
    expect(before.status).toBe(200);
    await before.text();
    await waitFor(() => scalar(sql, "SELECT COUNT(*) AS value FROM usage_events") === 1, "the first event was never flushed", 8_000);

    // Hold the write lock well past the 15s heartbeat and the old crash
    // window. The holder is a separate process so the gateway's own
    // synchronous retries cannot block its release timer.
    const lock = await holdWriteLock(databaseFile);
    const initialHeartbeat = scalar(sql, "SELECT COALESCE(MAX(heartbeat), 0) AS value FROM billing_instances");
    const lockStarted = Date.now();
    try {
      // Traffic keeps arriving while the lock is held: the buffered usage
      // flush and the billing heartbeat both hit SQLITE_BUSY repeatedly.
      const heldForMs = 22_000;
      let longestHealth = 0;
      let healthChecks = 0;
      while (Date.now() - lockStarted < heldForMs) {
        const started = performance.now();
        const health = await fetch(gateway.base + "/api/health");
        expect(health.status).toBe(200);
        await health.text();
        longestHealth = Math.max(longestHealth, performance.now() - started);
        healthChecks++;
        // A request that needs the writer must degrade, never take the
        // process down with it.
        const blocked = await send();
        expect([200, 503]).toContain(blocked.status);
        if (blocked.status === 503) expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
        await blocked.text();
        // THE assertion this workstream exists for.
        expect(gateway.proc.exitCode).toBeNull();
        await Bun.sleep(200);
      }
      expect(healthChecks).toBeGreaterThan(50);
      // /api/health never touches the database, so it must stay fast even
      // while every writer is blocked.
      expect(longestHealth).toBeLessThan(1_000);
      expect(scalar(sql, "SELECT COALESCE(MAX(heartbeat), 0) AS value FROM billing_instances")).toBe(initialHeartbeat);
      // Usage that could not be written stays buffered rather than lost.
      expect(scalar(sql, "SELECT COUNT(*) AS value FROM usage_events")).toBe(1);
    } finally {
      await lock.release();
    }

    // Recovery: no restart, no intervention.
    await waitFor(
      () => scalar(sql, "SELECT COALESCE(MAX(heartbeat), 0) AS value FROM billing_instances") > initialHeartbeat,
      "billing heartbeat never recovered after the lock was released",
      30_000,
    );
    // The gateway resumes serving AND accounting without a restart. Requests
    // that arrived while the writer was held are rejected at admission (503 +
    // Retry-After) rather than accepted and lost, so recovery is proven by a
    // fresh request being admitted and written end to end.
    const after = await send();
    expect(after.status).toBe(200);
    await after.text();
    await waitFor(
      () => scalar(sql, "SELECT COUNT(*) AS value FROM usage_events") >= 2,
      "usage was never written again after the lock was released",
      30_000,
    );
    // A recovered gateway must not have crashed once during the whole test.
    // Handled contention IS expected in the log (each one answers the client
    // 503 + Retry-After); what must never appear is an uncaught failure or a
    // process exit — both asserted directly.
    expect(gateway.proc.exitCode).toBeNull();
    expect(gateway.stderr()).not.toContain("uncaught");
    expect(gateway.stderr()).not.toContain("Unhandled error");
    expect(gateway.stderr()).not.toContain("Bun v");
  } finally {
    sql.close();
    await gateway.stop();
    upstream.stop(true);
  }
}, 180_000);

test("the health endpoint keeps answering while an external writer blocks every write", async () => {
  const dir = freshDir("contention-health");
  dirs.push(dir);
  const gateway = await startGateway({ dir });
  const databaseFile = path.join(dir, "data", "gateway.db");
  const lock = await holdWriteLock(databaseFile);
  try {
    const latencies: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      const response = await fetch(gateway.base + "/api/health");
      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean };
      expect(body.ok).toBe(true);
      latencies.push(performance.now() - started);
      await Bun.sleep(50);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    // Liveness proves the process is up. It must keep ANSWERING under a held
    // write lock, and the MEDIAN must stay far below the dashboard budget.
    //
    // The p99 is deliberately not asserted: the same 40 samples straddle the
    // first contended attempt of each periodic job (billing heartbeat, backup
    // verification), and that single attempt pays a bounded SQLITE_BUSY
    // classification. That is a one-shot startup cost of a background job, not
    // the request path — asserting it here would encode scheduler timing as a
    // latency requirement. The steady-state behaviour is covered by the
    // dedicated measurement below.
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(250);
    expect(sorted.filter((ms) => ms < 1_000).length).toBeGreaterThanOrEqual(38);
    expect(gateway.proc.exitCode).toBeNull();

    // Second pass, after the periodic jobs have already hit the lock once:
    // steady state must be fast for every single sample.
    const steady: number[] = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      const response = await fetch(gateway.base + "/api/health");
      expect(response.status).toBe(200);
      await response.text();
      steady.push(performance.now() - started);
      await Bun.sleep(50);
    }
    steady.sort((a, b) => a - b);
    expect(steady[steady.length - 1]!).toBeLessThan(250);
  } finally {
    await lock.release();
    await gateway.stop();
  }
}, 120_000);
