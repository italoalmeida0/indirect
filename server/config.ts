import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "fs";
import path from "path";
import { availableParallelism } from "node:os";

/**
 * Central configuration. Everything comes from env, all optional knobs have
 * safe defaults. GATEWAY_SECRET is the only hard requirement in production;
 * in dev it is generated once and persisted under DATA_DIR/.secret.
 */

export const NODE_ENV = process.env.NODE_ENV || "production";
export const IS_PROD = NODE_ENV === "production";
export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR =
  process.env.DATA_DIR || path.join(import.meta.dir, "..", "data");
export const PUBLIC_URL = (
  process.env.PUBLIC_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");
export const TRUST_PROXY = process.env.TRUST_PROXY === "true";
export const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (TRUST_PROXY && TRUSTED_PROXY_CIDRS.length === 0) {
  console.warn("[BOOT] TRUST_PROXY is enabled but TRUSTED_PROXY_CIDRS is empty; forwarding headers will be ignored");
}
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

export const SMTP = {
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  from: process.env.SMTP_FROM || '"Indirect" <no-reply@localhost>',
  secure: process.env.SMTP_SECURE === "true",
};
export const SMTP_ENABLED = !!SMTP.host;

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// ===== Secret bootstrap =====

function loadSecret(): string {
  const envSecret = process.env.INDIRECT_SECRET || process.env.GATEWAY_SECRET || "";
  if (envSecret && envSecret.length >= 32) return envSecret;

  if (IS_PROD) {
    console.error(
      "[BOOT] FATAL: INDIRECT_SECRET (or GATEWAY_SECRET) is missing or shorter than 32 chars in production.\n" +
        "       Generate one with: openssl rand -hex 32",
    );
    process.exit(1);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const secretFile = path.join(DATA_DIR, ".secret");
  if (existsSync(secretFile)) return readFileSync(secretFile, "utf8").trim();

  const generated = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex");
  writeFileSync(secretFile, generated);
  try {
    chmodSync(secretFile, 0o600);
  } catch {}
  console.warn(
    `[BOOT] dev mode: generated INDIRECT_SECRET and stored it in ${secretFile}`,
  );
  return generated;
}

export const INDIRECT_SECRET = loadSecret();
export const GATEWAY_SECRET = INDIRECT_SECRET;

// ===== Limits (tunable via env for stress tests) =====

function positiveLimit(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedLimit(name: string, fallback: number, maximum: number): number {
  const value = positiveLimit(name, fallback);
  if (value > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return value;
}

export const LIMITS = {
  /** Bound synchronous SQLite lock waits so the event loop remains responsive. */
  sqliteBusyTimeoutMs: positiveLimit("SQLITE_BUSY_TIMEOUT_MS", 25),
  analyticsReaders: boundedLimit("ANALYTICS_READERS", Math.min(8, Math.max(2, Math.ceil(availableParallelism() * 2 / 3))), 16),
  analyticsPending: boundedLimit("ANALYTICS_PENDING", 256, 4096),
  analyticsDeadlineMs: positiveLimit("ANALYTICS_DEADLINE_MS", 5000),
  analyticsHourlyDays: boundedLimit("ANALYTICS_HOURLY_DAYS", 90, 3650),
  analyticsMinuteDays: boundedLimit("ANALYTICS_MINUTE_DAYS", 3, 365),

  /** Periodic cleanup runs bounded batches so a single DELETE never holds the
   *  writer long enough to starve the proxy (see server/batch-delete.ts). */
  maintenanceBatchSize: boundedLimit("MAINTENANCE_BATCH_SIZE", 500, 100_000),
  /** Safety valve: rows removed by one scheduled cleanup run. */
  maintenanceMaxBatchRows: boundedLimit("MAINTENANCE_MAX_BATCH_ROWS", 50_000, 1_000_000),

  /**
   * Supported backup (server/backup.ts). An empty directory means
   * `<DATA_DIR>/backups`. Scheduling is disabled with
   * BACKUP_INTERVAL_MINUTES=0; manual runs stay available.
   */
  backupDir: process.env.BACKUP_DIR || "",
  backupIntervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES ?? 24 * 60),
  /**
   * Days of DETAILED usage events to keep. Aggregates (the daily and monthly
   * rollups) are kept regardless, so the long history survives while the raw
   * ledger stays bounded: a million events occupy ~547 MiB, and the table
   * otherwise grows forever. 0 disables pruning.
   */
  usageEventRetentionDays: Number(process.env.USAGE_EVENT_RETENTION_DAYS ?? 400),
  /** Rows removed per statement by the retention sweep. */
  usageEventPruneBatch: positiveLimit("USAGE_EVENT_PRUNE_BATCH", 5_000),
  /** Retention: completed snapshots kept per bucket, newest first. */
  backupKeepDaily: boundedLimit("BACKUP_KEEP_DAILY", 14, 3650),
  backupKeepWeekly: boundedLimit("BACKUP_KEEP_WEEKLY", 8, 520),
  /** Copy Indirect Code daemon data directories into the snapshot. */
  backupIncludeDaemon: process.env.BACKUP_INCLUDE_DAEMON === "true",
  /** Extra daemon data directories to copy when the copy is enabled. */
  backupDaemonDirs: (process.env.BACKUP_DAEMON_DIRS || "").split(",").map((s) => s.trim()).filter(Boolean),
  /** body caps */
  authBodyBytes: Number(process.env.LIMIT_AUTH_BODY_BYTES || 16 * 1024),
  apiBodyBytes: Number(process.env.LIMIT_API_BODY_BYTES || 256 * 1024),
  proxyBodyBytes: Number(process.env.LIMIT_PROXY_BODY_BYTES || 4 * 1024 * 1024),

  /**
   * Global per-IP token bucket shared by every dashboard and proxy route.
   * Office, VPN and CGNAT egress put hundreds of employees behind one
   * address, and each open dashboard tab polls (billing every 30s, workspace
   * status every 15s) on top of mutations and proxy calls. The default keeps
   * a burst of 600 employees x a few concurrent tabs far below the ceiling:
   * 60_000/min is ~1_000 req/s from one address, which no legitimate polling
   * pattern reaches, while still bounding a flood from a single source.
   * Liveness (/api/health) and readiness (/api/ready) never consume it.
   */
  ipPerMin: positiveLimit("LIMIT_IP_PER_MIN", 60_000),
  /**
   * Credential endpoints (login, 2FA, Google sign-in) get their own bucket.
   * Must stay far above a real office morning: 500 employees signing in
   * within one minute is 500 requests, and a retry storm doubles or triples
   * that. The brute-force guards (per-account lockout, per-IP spray bucket)
   * are what stop a real attack, not this availability bucket.
   */
  authPerMinPerIp: positiveLimit("LIMIT_AUTH_PER_MIN", 6_000),
  resetPer10MinPerIp: positiveLimit("LIMIT_RESET_PER_10MIN", 1_000),

  /** brute force: N failures in window -> lockout (per account) */
  loginFailWindowMs: 15 * 60 * 1000,
  loginFailMax: 10,
  loginLockoutMs: 15 * 60 * 1000,
  /**
   * Password-spray guard per source IP. Deliberately much higher than the
   * per-account threshold: IPs are shared (family, NAT, CGNAT, company
   * egress), so this bucket must stop sprays without letting a handful of
   * typos block everyone behind the same address.
   */
  loginIpFailMax: Number(process.env.LIMIT_LOGIN_IP_FAIL_MAX || 250),

  /** defaults applied when a key leaves them empty */
  defaultKeyRpm: Number(process.env.DEFAULT_KEY_RPM || 120),
  defaultKeyConcurrency: Number(process.env.DEFAULT_KEY_CONCURRENCY || 16),
  /**
   * Account ceilings apply across ALL keys of one account, so creating more
   * keys never buys more of the shared gateway. Both are per running process
   * and cannot be raised by the key owner; per-key limits still apply on top.
   */
  userRpm: positiveLimit("LIMIT_USER_RPM", 600),
  userConcurrency: positiveLimit("LIMIT_USER_CONCURRENCY", 32),
  /**
   * Whole-gateway ceiling on concurrent upstream calls. Sized for the
   * 500-employee envelope: one person rarely runs more than one turn at a
   * time, so 512 leaves headroom for a company-wide burst while still
   * bounding upstream connection use.
   */
  globalConcurrency: positiveLimit("LIMIT_GLOBAL_CONCURRENCY", 512),
  /**
   * Bounded admission queue in front of the concurrency ceilings: a request
   * that would exceed a ceiling waits up to the deadline instead of failing
   * immediately, and is released FIFO when a slot frees. The deadline is
   * short enough to feel instant to a client that would otherwise get a 429.
   * maxBytes caps the declared request bytes waiting at once, so a burst of
   * large uploads cannot pin the queue in memory.
   */
  admissionWaitMs: positiveLimit("LIMIT_ADMISSION_WAIT_MS", 400),
  admissionQueueMax: positiveLimit("LIMIT_ADMISSION_QUEUE_MAX", 1_024),
  admissionQueueBytes: positiveLimit("LIMIT_ADMISSION_QUEUE_BYTES", 64 * 1024 * 1024),

  /** upstream behavior */
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000),
  upstreamNonStreamTimeoutMs: Number(
    process.env.UPSTREAM_TIMEOUT_NONSTREAM_MS || 60_000,
  ),
  /**
   * Abort an SSE stream after this many ms without a single byte from the
   * upstream. Long thinking pauses are legitimate (models emit nothing while
   * reasoning; Anthropic pads them with ping events), so this must be
   * generous — an abort mid-turn makes clients retry and re-run tool actions.
   * Must stay BELOW the HTTP server's idleTimeout (see server/index.ts).
   */
  proxyStreamIdleMs: Number(process.env.PROXY_STREAM_IDLE_MS || 180_000),
  breakerFailThreshold: 5,
  breakerOpenMs: 30_000,

  /** upstream failover (multi-key / multi-target) */
  /** Sticky-winner TTL: how long the last-good candidate stays first in
   *  line for its routing lane (sliding on every success, in-memory).
   *  No key is ever skipped automatically — the winner is only ordering.
   *  (Legacy knobs LIMIT_PROVIDER_FAIL_THRESHOLD / LIMIT_PROVIDER_COOLDOWN_*
   *  were removed with the auto-skip policy; if set in .env they are ignored.) */
  keyStickyTtlMs: Number(process.env.KEY_STICKY_TTL_MS || 10 * 60_000),
  /** Bytes of an upstream error body read to classify it (billing/quota hints). */
  upstreamErrorPeekBytes: Number(process.env.UPSTREAM_ERROR_PEEK_BYTES || 16 * 1024),
  /** Hard cap on failover attempts (keys × targets) per client request. */
  maxFailoverAttempts: Number(process.env.LIMIT_MAX_FAILOVER_ATTEMPTS || 8),

  /** JWT / sessions */
  accessTokenTtlSec: 12 * 3600,
  refreshTokenTtlMs: 30 * 24 * 3600 * 1000, // sliding
  refreshAbsoluteTtlMs: 180 * 24 * 3600 * 1000,
  twoFaTempTtlSec: 5 * 60,
  passwordTokenTtlMs: 24 * 3600 * 1000, // invite + reset links
};

mkdirSync(DATA_DIR, { recursive: true });
