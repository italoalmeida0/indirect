import { LIMITS } from "./config";

/**
 * In-memory token-bucket rate limiters + brute-force tracker.
 * Single-process by design (the gateway is a single Bun process); counters
 * reset on restart, which is acceptable for availability controls.
 */

interface Bucket {
  used: number;
  resetAt: number;
}

class TokenBucket {
  private buckets = new Map<string, Bucket>();
  constructor(
    private maxTokens: number,
    private windowMs: number,
  ) {
    const sweep = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    sweep.unref();
  }

  /** Returns the retry-after (seconds) when limited, or 0 when allowed. */
  hit(key: string, cost = 1, maxTokens = this.maxTokens): number {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { used: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    if (b.used + cost > maxTokens) {
      return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    }
    b.used += cost;
    return 0;
  }

  delete(key: string): void { this.buckets.delete(key); }

  private sweep(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    // Hard cap: under active flooding, evict oldest entries instead of wiping all state.
    if (this.buckets.size > 50_000) {
      let count = 0;
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        count++;
        if (count >= 10_000) break;
      }
    }
  }
}

// ===== Named limiters =====

let ipLimiter = new TokenBucket(LIMITS.ipPerMin, 60_000);
let authLimiter = new TokenBucket(LIMITS.authPerMinPerIp, 60_000);
let resetLimiter = new TokenBucket(LIMITS.resetPer10MinPerIp, 10 * 60_000);
const resetAccountLimiter = new TokenBucket(5, 10 * 60_000);
const proxyAuthFailures = new TokenBucket(30, 60_000);
const userRpmLimiter = new TokenBucket(LIMITS.userRpm, 60_000);

/** One map/timer for all keys, rather than one timer per key. */
const keyRpmLimiter = new TokenBucket(0, 60_000);

export function keyRpmHit(keyId: string, rpm: number): number {
  return keyRpmLimiter.hit(keyId, 1, rpm);
}

export function userRpmHit(userId: string): number { return userRpmLimiter.hit(userId); }

export function dropKeyLimiter(keyId: string): void {
  keyRpmLimiter.delete(keyId);
}

export function configureLimits(opts: { ipPerMin?: number; authPerMin?: number; resetPer10Min?: number }) {
  if (opts.ipPerMin) ipLimiter = new TokenBucket(opts.ipPerMin, 60_000);
  if (opts.authPerMin) authLimiter = new TokenBucket(opts.authPerMin, 60_000);
  if (opts.resetPer10Min) resetLimiter = new TokenBucket(opts.resetPer10Min, 10 * 60_000);
}

export const limits = {
  ipPerMin: (ip: string) => ipLimiter.hit(ip),
  authPerMin: (ip: string) => authLimiter.hit(ip),
  resetPer10Min: (ip: string) => resetLimiter.hit(ip),
  resetAccountPer10Min: (email: string) => resetAccountLimiter.hit(email),
  proxyAuthFailures: (ip: string) => proxyAuthFailures.hit(ip),
};

// ===== Brute-force tracker (login + TOTP failures) =====

interface FailRecord {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const failures = new Map<string, FailRecord>();
const failSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, r] of failures) {
    if (r.lockedUntil < now && r.windowStart + 15 * 60_000 < now) failures.delete(k);
  }
  if (failures.size > 50_000) {
    let count = 0;
    for (const k of failures.keys()) {
      failures.delete(k);
      count++;
      if (count >= 10_000) break;
    }
  }
}, 60_000);
failSweep.unref();

const FAIL_WINDOW_MS = LIMITS.loginFailWindowMs;
const FAIL_MAX = LIMITS.loginFailMax;
const LOCKOUT_MS = LIMITS.loginLockoutMs;

/** Returns lock seconds remaining (0 = not locked). Does NOT record a failure. */
export function bruteforceLocked(scope: string): number {
  const r = failures.get(scope);
  if (!r) return 0;
  const now = Date.now();
  if (r.lockedUntil > now) return Math.ceil((r.lockedUntil - now) / 1000);
  if (r.windowStart + FAIL_WINDOW_MS < now) failures.delete(scope);
  return 0;
}

/**
 * Record a failure. `max` overrides the lock threshold: per-IP scopes use a
 * much higher bar than per-account ones, because a shared IP (family, NAT,
 * CGNAT, corporate egress) must never be one person's 10 typos away from a
 * collective login outage.
 */
export function bruteforceFail(scope: string, max = FAIL_MAX): void {
  const now = Date.now();
  let r = failures.get(scope);
  if (!r || r.windowStart + FAIL_WINDOW_MS < now) {
    r = { count: 0, windowStart: now, lockedUntil: 0 };
    failures.set(scope, r);
  }
  r.count++;
  if (r.count >= max) {
    r.lockedUntil = now + LOCKOUT_MS;
    r.count = 0;
    r.windowStart = now;
  }
}

export function bruteforceClear(scope: string): void {
  failures.delete(scope);
}

// ===== TOTP anti-replay (a valid code may be used only once) =====

const usedTotpCodes = new Map<string, number>();
const totpSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of usedTotpCodes) if (exp < now) usedTotpCodes.delete(k);
  if (usedTotpCodes.size > 50_000) {
    let count = 0;
    for (const k of usedTotpCodes.keys()) {
      usedTotpCodes.delete(k);
      count++;
      if (count >= 10_000) break;
    }
  }
}, 60_000);
totpSweep.unref();

/** Returns false if this exact code digest was already consumed recently. */
export function consumeTotpCode(digest: string): boolean {
  if (usedTotpCodes.has(digest)) return false;
  usedTotpCodes.set(digest, Date.now() + 90_000);
  return true;
}

// ===== Proxy concurrency control (key, account, and global upstream) =====

const keyConcurrency = new Map<string, number>();
const userConcurrency = new Map<string, number>();
let totalUpstreamInFlight = 0;

export function acquireUpstreamSlot(keyId: string, userId: string, perKeyMax: number, perUserMax = LIMITS.userConcurrency, globalMax = LIMITS.globalConcurrency):
  { ok: false; reason: "global" | "user" | "key" } | { ok: true; release: () => void } {
  if (totalUpstreamInFlight >= globalMax) return { ok: false, reason: "global" };
  if ((userConcurrency.get(userId) ?? 0) >= perUserMax) return { ok: false, reason: "user" };
  if ((keyConcurrency.get(keyId) ?? 0) >= perKeyMax) return { ok: false, reason: "key" };
  keyConcurrency.set(keyId, (keyConcurrency.get(keyId) ?? 0) + 1);
  userConcurrency.set(userId, (userConcurrency.get(userId) ?? 0) + 1);
  totalUpstreamInFlight++;
  let released = false;
  return { ok: true, release: () => {
    if (released) return;
    released = true;
    const keys = keyConcurrency.get(keyId)!;
    if (keys === 1) keyConcurrency.delete(keyId); else keyConcurrency.set(keyId, keys - 1);
    const users = userConcurrency.get(userId)!;
    if (users === 1) userConcurrency.delete(userId); else userConcurrency.set(userId, users - 1);
    totalUpstreamInFlight--;
  } };
}
