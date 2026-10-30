import { PORT, IS_PROD, ADMIN_EMAIL, ADMIN_PASSWORD, LIMITS, DATA_DIR } from "./config";
import { admissionSnapshot, configureLimits, limits } from "./ratelimit";
import { db, audit, isSqliteBusy } from "./db";
import { hashPassword, randomToken } from "./crypto";
import { ApiError, baseHeaders, clientIp, err, json, rateLimitError } from "./http";
import { handleAuthRoute } from "./routes/auth";
import { handleMeRoute } from "./routes/me";
import { handleBillingRoute } from "./routes/billing";
import { startBilling } from "./billing";
import { handleKeysRoute } from "./routes/keys";
import { handleUsageRoute } from "./routes/usage";
import { handleAdminRoute } from "./routes/admin";
import { handleIndirectCodeRestRoute } from "./routes/indirect-code";
import { handleGenUiRoute } from "./routes/gen-ui";
import { ensureObscuraBrowser } from "./routes/obscura";
import { handlePushRoute } from "./routes/push";
import { handleManifestRoute } from "./routes/manifest";
import { handleIndirectCodeUpgrade, remoteRelayWsHandlers, type WsData } from "./routes/relay";
import { handleProxy, proxyRateLimit, proxyStorageUnavailable, proxyRequestError } from "./proxy/index";
import { serveStatic } from "./static";
import { flushUsage } from "./usage";
import { initTokenEstimator } from "./tokens";
import { resolveRequestId, runWithRequest } from "./request-context";
import { scheduleMaintenance } from "./maintenance";
import { pruneUsageEvents, pruneUsageRollups } from "./usage-rollup";
import { batchDelete } from "./batch-delete";
import { backupIntervalMs, backupRoot, runBackupCycle } from "./backup";

// btdby4-wasm (token estimator) must be warm before serving: every counter
// below is synchronous after init. Top-level await is fine — Bun.serve
// starts after this resolves.
await initTokenEstimator();
console.log("[BOOT] token estimator ready (btdby4-wasm)");

/**
 * Entry point. One Bun process serves:
 *   /v1/*   -> LLM proxy (OpenAI + Anthropic compatible)
 *   /openai/v1/*, /anthropic/v1/* -> same proxy, protocol forced by the prefix
 *   /api/*  -> dashboard REST API
 *   /*      -> built SPA + legal pages (path-traversal safe)
 */

configureLimits({
  ipPerMin: LIMITS.ipPerMin,
  authPerMin: LIMITS.authPerMinPerIp,
  resetPer10Min: LIMITS.resetPer10MinPerIp,
});

// ===== First-admin bootstrap =====

async function bootstrapAdmin(): Promise<void> {
  const admins = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get()!.n;
  if (admins > 0) return;

  const password = ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    console.error("[BOOT] FATAL: ADMIN_PASSWORD must be at least 10 characters");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  db.prepare(
    "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?)",
  ).run(randomToken(12), ADMIN_EMAIL.toLowerCase(), "Administrator", hash, Date.now());
  audit("admin.bootstrapped", { target: ADMIN_EMAIL });
}

await bootstrapAdmin();
startBilling();

// ===== Housekeeping sweeps =====

/**
 * Session and password-token cleanup. Rows are removed in bounded key-order
 * batches: a large backlog (a tenant that has been running for a year) must
 * not turn one sweep into a whole-table DELETE that holds the writer while the
 * proxy needs it. Leftovers are picked up by the next sweep.
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  const budget = { batchSize: LIMITS.maintenanceBatchSize, maxRows: LIMITS.maintenanceMaxBatchRows };
  batchDelete(db, { table: "sessions", key: "jti", where: "abs_expires_at < ?", params: [now], ...budget });
  db.prepare("UPDATE sessions SET revoked = 1 WHERE expires_at < ? AND revoked = 0").run(now);
  batchDelete(db, {
    table: "password_tokens",
    key: "token_hash",
    where: "expires_at < ? OR used_at IS NOT NULL AND used_at < ?",
    params: [now, now - 3600_000],
    ...budget,
  });
}

scheduleMaintenance("session cleanup", cleanupExpiredSessions, 15 * 60_000);
/** Rollup pruning already deletes in batches inside pruneUsageRollups; the
 *  retry wrapper turns a transient lock into a retry instead of an exit. */
scheduleMaintenance("analytics rollup cleanup", () => {
  pruneUsageRollups(db, Date.now(), LIMITS.analyticsHourlyDays, LIMITS.analyticsMinuteDays, LIMITS.maintenanceBatchSize);
}, 60_000);

/**
 * Detailed-event retention. Runs hourly, not every minute: it deletes whole
 * days older than the window, so a more frequent schedule would only re-scan
 * the same rows. Aggregates are untouched, which is why the long history keeps
 * working after the detail is gone.
 */
if (LIMITS.usageEventRetentionDays > 0) {
  scheduleMaintenance("usage event retention", () => {
    const result = pruneUsageEvents(db, Date.now(), LIMITS.usageEventRetentionDays, LIMITS.usageEventPruneBatch);
    if (result.deleted) console.info(`[RETENTION] pruned ${result.deleted} detailed usage event(s) older than ${LIMITS.usageEventRetentionDays} days`);
  }, 60 * 60_000);
  console.log(`[RETENTION] detailed usage events kept for ${LIMITS.usageEventRetentionDays} days; aggregates are retained`);
} else {
  console.log("[RETENTION] detailed usage event pruning disabled (USAGE_EVENT_RETENTION_DAYS=0)");
}

// ===== Supported backup schedule =====

const backupEveryMs = backupIntervalMs();
if (backupEveryMs > 0) {
  scheduleMaintenance("backup", async () => {
    await runBackupCycle();
  }, backupEveryMs);
  console.log(`[BACKUP] automatic snapshots every ${Math.round(backupEveryMs / 60_000)} min into ${backupRoot()}`);
} else {
  console.log("[BACKUP] automatic snapshots disabled (BACKUP_INTERVAL_MINUTES=0); manual admin backup stays available");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[BOOT] ${sig} received, flushing usage buffers...`);
    try {
      flushUsage();
    } catch {}
    process.exit(0);
  });
}

// ===== Request routing =====

async function route(req: Request, server: any): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Cheap rejects before anything else.
  if (path.includes("..")) return err(400, "bad path", req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders(req) });
  }

  // Liveness: process-only, exempt from every shared bucket. A health check
  // that can be throttled by the traffic it is meant to observe is useless.
  // The JSON shape is a public contract (scripts and tests poll it).
  if (path === "/api/health") {
    return json({ ok: true, ts: Date.now() }, { req });
  }

  // Readiness: can this process actually serve? Storage must be reachable and
  // writable (a read-only or locked database means calls cannot be admitted),
  // and admission metrics are reported for operators. Exempt from the shared
  // IP bucket, for the same reason as liveness.
  if (path === "/api/ready") {
    const started = performance.now();
    let dbOk: boolean;
    try {
      db.prepare("SELECT 1 AS ok").get();
      // The writer must be usable, not just readable: upsert a probe row so a
      // read-only handle or an unusable writer fails here, not on a real call.
      db.prepare("INSERT INTO settings (key, value) VALUES ('__ready_probe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const admission = admissionSnapshot();
    const ok = dbOk;
    return json({
      ok,
      ts: Date.now(),
      checks: {
        db: dbOk,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        admission,
      },
    }, { status: ok ? 200 : 503, req });
  }

  const proxyPath = (
    path.startsWith("/v1/") ||
    path === "/v1" ||
    path.startsWith("/openai/v1/") ||
    path === "/openai/v1" ||
    path.startsWith("/anthropic/v1/") ||
    path === "/anthropic/v1"
  );
  const ip = clientIp(req, server);
  const retry = limits.ipPerMin(ip);
  if (retry > 0) {
    const message = `rate limit exceeded, retry in ${retry}s`;
    return proxyPath ? proxyRateLimit(req, url, retry, message) : rateLimitError(message, retry, req);
  }

  if (proxyPath) {
    return handleProxy(req, url, server);
  }

  if (path.startsWith("/api/")) {
    // Indirect Code WebSocket upgrades (/api/indirect-code/daemon/ws and /api/indirect-code/client/ws)
    if (path.startsWith("/api/indirect-code/") && path.endsWith("/ws")) {
      return await handleIndirectCodeUpgrade(path, req, url, server);
    }
    const viaGenUi = await handleGenUiRoute(path, req, url, server);
    if (viaGenUi) return viaGenUi;
    const viaIndirectCode = await handleIndirectCodeRestRoute(path, req, url);
    if (viaIndirectCode) return viaIndirectCode;
    const viaPush = await handlePushRoute(path, req, url);
    if (viaPush) return viaPush;
    const viaAuth = await handleAuthRoute(path, req, server);
    if (viaAuth) return viaAuth;
    const viaMe = await handleMeRoute(path, req);
    if (viaMe) return viaMe;
    const viaBilling = await handleBillingRoute(path, req);
    if (viaBilling) return viaBilling;
    const viaKeys = await handleKeysRoute(path, req);
    if (viaKeys) return viaKeys;
    const viaUsage = await handleUsageRoute(path, req, url);
    if (viaUsage) return viaUsage;
    const viaAdmin = await handleAdminRoute(path, req, url);
    if (viaAdmin) return viaAdmin;
    return err(404, "not found", req);
  }

  if (path === "/manifest.webmanifest" || path === "/manifest.json") {
    return handleManifestRoute(req, url);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const staticResp = serveStatic(req, path);
    if (staticResp) return staticResp;
  }

  return err(404, "not found", req);
}

import type { Server } from "bun";

const server: Server<WsData> = Bun.serve<WsData>({
  port: PORT,
  hostname: process.env.HOST || "0.0.0.0",
  maxRequestBodySize: LIMITS.proxyBodyBytes + 64 * 1024,
  /**
   * Bun applies idleTimeout to IN-FLIGHT responses too — a paused SSE stream
   * (model thinking, no bytes flowing) counts as idle. With a short timeout
   * the socket dies mid-turn and clients retry, re-running tool actions.
   * Kept well above LIMITS.proxyStreamIdleMs (240 > 180s), under Bun's 255s
   * ceiling.
   */
  idleTimeout: 240,
  websocket: remoteRelayWsHandlers,

  async fetch(req): Promise<Response | undefined> {
    // One correlation id per request, established BEFORE any handler runs so
    // audit rows and usage events inherit it. A well-formed client id is
    // honoured; anything else is replaced, never echoed.
    const url = new URL(req.url);
    const requestId = resolveRequestId(req.headers.get("x-request-id"), () => randomToken(16));
    const response = await runWithRequest(
      { requestId, startedAt: performance.now(), method: req.method, path: url.pathname },
      () => handleRequest(req, server, url),
    );
    // Echo the id on EVERY response so a client can quote it in a report.
    response.headers.set("X-Request-Id", requestId);
    return response;
  },
});

/** Everything after correlation is established; errors become responses. */
async function handleRequest(req: Request, server: Server<WsData>, url: URL): Promise<Response> {
    try {
      return (await route(req, server)) ?? new Response(null, { status: 204 });
    } catch (e) {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      const url = new URL(req.url);
      const isProxy = /^\/(?:v1|openai\/v1|anthropic\/v1)(?:\/|$)/.test(url.pathname);
      if (e instanceof ApiError) {
        const response = isProxy ? proxyRequestError(req, url, e.status, e.message, e.code) : err(e.status, e.message, req, e.code);
        if (e.status === 503) response.headers.set("Retry-After", "1");
        return response;
      }
      if (isSqliteBusy(e)) {
        if (isProxy) return proxyStorageUnavailable(req, url);
        const response = err(503, "storage is temporarily unavailable", req);
        response.headers.set("Retry-After", "1");
        return response;
      }
      console.error(`[HTTP] unhandled error on ${req.method} ${url.pathname}:`, e);
      return isProxy ? proxyRequestError(req, url, 500, "internal error") : err(500, "internal error", req);
    }
}

console.log(`[BOOT] indirect listening on http://${server.hostname}:${server.port} (${IS_PROD ? "prod" : "dev"})`);
console.log(`[BOOT] data dir: ${DATA_DIR}`);
// Generative-ui lint browser (obscura): fetched into DATA_DIR on first use,
// eagerly here so the first widget lint never waits on the download.
void ensureObscuraBrowser()
  .then((p) => console.log(`[BOOT] obscura lint browser: ${p}`))
  .catch((e) => console.warn(`[BOOT] obscura lint browser unavailable: ${e instanceof Error ? e.message : e}`));

export { server };
