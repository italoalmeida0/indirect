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
//
// Three ceilings apply to one upstream call, checked in this order:
//   global  — the whole gateway (LIMIT_GLOBAL_CONCURRENCY)
//   account — every key of one account together (LIMIT_USER_CONCURRENCY)
//   key     — one API key (DEFAULT_KEY_CONCURRENCY, as before)
// A request that finds a ceiling exhausted waits in a BOUNDED FIFO queue for a
// short deadline instead of failing immediately; a released slot dispatches the
// oldest waiter that fits. Every admitted slot carries an idempotent release:
// success, error, client abort and stream end all release exactly once.

const keyConcurrency = new Map<string, number>();
const userConcurrency = new Map<string, number>();
let totalUpstreamInFlight = 0;

/** Which ceiling denied the request (or "queue" for admission overflow). */
export type AdmissionReason = "global" | "user" | "key" | "queue" | "aborted";

export interface AdmissionLimits {
  /** Concurrent requests allowed for one API key. */
  perKey: number;
  /** Concurrent requests allowed for one account, across all of its keys. */
  perUser: number;
  /** Concurrent requests allowed for the whole gateway. */
  global: number;
}

export interface AdmissionWait {
  /** How long a request may wait for a slot before it is rejected. */
  deadlineMs: number;
  /** Hard cap on the number of waiting requests. */
  maxQueue: number;
  /** Hard cap on the declared bytes those waiting requests carry. */
  maxQueueBytes: number;
  /** Declared request size (Content-Length), consumed by the byte guard. */
  bytes?: number;
  /** Aborting the client request removes it from the queue (no slot leak). */
  signal?: AbortSignal;
}

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; reason: AdmissionReason; retryAfter: number };

interface Waiter {
  keyId: string;
  userId: string;
  limits: AdmissionLimits;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  settle: (result: Admission) => void;
}

/** FIFO of requests waiting for a concurrency slot. */
const waiters: Waiter[] = [];
let queuedBytes = 0;
let peakQueued = 0;

function blockingReason(keyId: string, userId: string, limits: AdmissionLimits): Exclude<AdmissionReason, "queue" | "aborted"> | null {
  if (totalUpstreamInFlight >= limits.global) return "global";
  if ((userConcurrency.get(userId) ?? 0) >= limits.perUser) return "user";
  if ((keyConcurrency.get(keyId) ?? 0) >= limits.perKey) return "key";
  return null;
}

/** Take a slot when every ceiling has room; returns an idempotent release. */
function tryTake(keyId: string, userId: string, limits: AdmissionLimits): (() => void) | null {
  if (blockingReason(keyId, userId, limits) !== null) return null;
  keyConcurrency.set(keyId, (keyConcurrency.get(keyId) ?? 0) + 1);
  userConcurrency.set(userId, (userConcurrency.get(userId) ?? 0) + 1);
  totalUpstreamInFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const keys = (keyConcurrency.get(keyId) ?? 1) - 1;
    if (keys <= 0) keyConcurrency.delete(keyId); else keyConcurrency.set(keyId, keys);
    const users = (userConcurrency.get(userId) ?? 1) - 1;
    if (users <= 0) userConcurrency.delete(userId); else userConcurrency.set(userId, users);
    totalUpstreamInFlight = Math.max(0, totalUpstreamInFlight - 1);
    pump();
  };
}

/** Settle one waiter exactly once (timer, abort and dispatch all race here). */
function finish(waiter: Waiter, result: Admission): void {
  const index = waiters.indexOf(waiter);
  if (index < 0) return; // already settled by another path
  waiters.splice(index, 1);
  queuedBytes = Math.max(0, queuedBytes - waiter.bytes);
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  waiter.settle(result);
}

/**
 * Dispatch freed capacity strictly in arrival order: the oldest waiter that
 * still fits goes first. A waiter blocked by its own key/account ceiling keeps
 * its place in line without stalling unrelated requests behind it.
 */
function pump(): void {
  if (waiters.length === 0) return;
  let index = 0;
  while (index < waiters.length) {
    const waiter = waiters[index]!;
    const release = tryTake(waiter.keyId, waiter.userId, waiter.limits);
    if (!release) {
      index++;
      continue;
    }
    waiters.splice(index, 1);
    queuedBytes = Math.max(0, queuedBytes - waiter.bytes);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.settle({ ok: true, release });
  }
}

function deadlineRetryAfter(deadlineMs: number): number {
  return Math.max(1, Math.ceil(deadlineMs / 1000));
}

/**
 * Admit one upstream call. Returns immediately when a slot is free, otherwise
 * queues the request until a slot frees or the deadline expires. The queue is
 * length- and byte-bounded: overflow is rejected instead of growing without
 * limit, and the same 429 is returned when the deadline passes.
 */
export async function admitUpstream(
  keyId: string,
  userId: string,
  limits: AdmissionLimits,
  wait: AdmissionWait,
): Promise<Admission> {
  if (wait.signal?.aborted) return { ok: false, reason: "aborted", retryAfter: 1 };

  const immediate = tryTake(keyId, userId, limits);
  if (immediate) return { ok: true, release: immediate };

  const blocked = blockingReason(keyId, userId, limits) ?? "global";
  const bytes = Math.max(0, wait.bytes ?? 0);
  if (wait.deadlineMs <= 0) return { ok: false, reason: blocked, retryAfter: 1 };
  if (waiters.length >= Math.max(1, wait.maxQueue) || queuedBytes + bytes > wait.maxQueueBytes) {
    // The queue itself is the denied dimension: retrying with a doomed key
    // would only burn the client's deadline.
    return { ok: false, reason: "queue", retryAfter: deadlineRetryAfter(wait.deadlineMs) };
  }

  return new Promise<Admission>((settle) => {
    const waiter: Waiter = {
      keyId,
      userId,
      limits,
      bytes,
      timer: setTimeout(() => finish(waiter, {
        ok: false,
        // Re-evaluate at expiry: the dimension the client should back off from
        // is the one still blocking it, not necessarily the one that queued it.
        reason: blockingReason(waiter.keyId, waiter.userId, waiter.limits) ?? "queue",
        retryAfter: deadlineRetryAfter(wait.deadlineMs),
      }), wait.deadlineMs),
      settle,
      signal: wait.signal,
    };
    waiter.timer.unref?.();
    if (wait.signal) {
      waiter.onAbort = () => finish(waiter, { ok: false, reason: "aborted", retryAfter: 1 });
      wait.signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    waiters.push(waiter);
    queuedBytes += bytes;
    if (waiters.length > peakQueued) peakQueued = waiters.length;
  });
}

/** Queue depth and slot occupancy for observability (/api/ready). */
export function admissionSnapshot(): { inFlight: number; queued: number; queuedBytes: number; peakQueued: number; maxQueued: number } {
  return {
    inFlight: totalUpstreamInFlight,
    queued: waiters.length,
    queuedBytes,
    peakQueued,
    maxQueued: LIMITS.admissionQueueMax,
  };
}
