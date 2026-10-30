import { GATEWAY_SECRET } from "./config";
import { db, type ApiKeyRow } from "./db";
import { encryptSecret, randomToken, sha256Hex } from "./crypto";
import { keySpend } from "./billing";
import { gridPage, type ColSpec } from "./gridql";

/**
 * API key domain logic shared by user routes, admin routes and the proxy.
 *
 * Tokens look like `gw_lMk...` (48 hex chars of entropy). The SHA-256 hash is
 * the proxy lookup key; an AES-encrypted copy (token_enc) lets the owner (or
 * an admin) reveal/copy the token later — every reveal is audit-logged.
 */

export function generateKey(): { token: string; prefix: string; hash: string } {
  const token = `gw_${randomToken(24)}`;
  return { token, prefix: token.slice(0, 12), hash: sha256Hex(token) };
}

export interface CreateKeyOptions {
  name: string;
  expiresAt?: number | null;
  dailyLimitUsd?: number | null;
  totalLimitUsd?: number | null;
  rpm?: number | null;
}

export interface PreparedKey {
  id: string;
  userId: string;
  token: string;
  prefix: string;
  hash: string;
  tokenEnc: string;
  opts: CreateKeyOptions;
}

export async function prepareKey(userId: string, opts: CreateKeyOptions): Promise<PreparedKey> {
  const { token, prefix, hash } = generateKey();
  const id = randomToken(12);
  const tokenEnc = await encryptSecret(token, GATEWAY_SECRET);
  return { id, userId, token, prefix, hash, tokenEnc, opts };
}

export function insertPreparedKey(prepared: PreparedKey, now = Date.now()): ApiKeyRow {
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, hash, created_at, expires_at, daily_usd_nanos, total_usd_nanos, rpm, status, token_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    prepared.id,
    prepared.userId,
    prepared.opts.name.slice(0, 64),
    prepared.prefix,
    prepared.hash,
    now,
    prepared.opts.expiresAt ?? null,
    prepared.opts.dailyLimitUsd == null ? null : Math.round(prepared.opts.dailyLimitUsd * 1e9),
    prepared.opts.totalLimitUsd == null ? null : Math.round(prepared.opts.totalLimitUsd * 1e9),
    prepared.opts.rpm ?? null,
    prepared.tokenEnc,
  );
  return db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(prepared.id)!;
}

export async function createKey(userId: string, opts: CreateKeyOptions): Promise<{ row: ApiKeyRow; token: string }> {
  const prepared = await prepareKey(userId, opts);
  return { row: insertPreparedKey(prepared), token: prepared.token };
}

export function markKeyRevoked(keyId: string): void {
  db.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?").run(keyId);
}

/**
 * Effective availability of a key, evaluated at request time. A key whose
 * daily budget is spent recovers automatically at 00:00 UTC without any
 * state flip; lifetime caps recover when their allowance is raised.
 */
export type KeyCheck =
  | { ok: true }
  | { ok: false; reason: "revoked" | "exhausted" | "expired" | "daily_limit" | "total_limit" };

export function checkKeyAvailability(
  key: ApiKeyRow,
  now = Date.now(),
  spend?: { today: number; total: number },
): KeyCheck {
  if (key.status === "revoked") return { ok: false, reason: "revoked" };
  if (key.expires_at !== null && key.expires_at <= now) return { ok: false, reason: "expired" };

  const s = spend ?? keySpend(key.id);
  if (key.daily_usd_nanos != null && s.today >= key.daily_usd_nanos / 1e9) {
    return { ok: false, reason: "daily_limit" };
  }
  if (key.total_usd_nanos != null && s.total >= key.total_usd_nanos / 1e9) {
    return { ok: false, reason: "total_limit" };
  }
  return { ok: true };
}

export function publicKey(row: ApiKeyRow, userEmail?: string, spend?: { today: number; total: number }) {
  const s = spend ?? keySpend(row.id);
  const availability = checkKeyAvailability(row, Date.now(), s);
  return {
    id: row.id,
    userId: row.user_id,
    userEmail,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    dailyLimitUsd: row.daily_usd_nanos == null ? null : row.daily_usd_nanos / 1e9,
    totalLimitUsd: row.total_usd_nanos == null ? null : row.total_usd_nanos / 1e9,
    rpm: row.rpm,
    status: availability.ok ? "active" : availability.reason,
    lastUsedAt: row.last_used_at,
    spendTodayUsd: s.today,
    spendTotalUsd: s.total,
    revealable: !!row.token_enc,
  };
}

export function keyQuerySource(userId: string | null) {
  const sourceSql = `SELECT k.*, u.email AS userEmail,
    COALESCE((SELECT spent_nanos / 1000000000.0 FROM billing_periods WHERE scope = 'key' AND owner_id = k.id AND kind = 'daily' AND starts_at = CAST(strftime('%s', 'now', 'start of day') AS INTEGER)*1000), 0) AS _spend_today,
    COALESCE((SELECT spent_nanos / 1000000000.0 FROM billing_periods WHERE scope = 'key' AND owner_id = k.id AND kind = 'lifetime' AND starts_at = 0), 0) AS _spend_total
    FROM api_keys k LEFT JOIN users u ON u.id = k.user_id ${userId ? "WHERE k.user_id = ?" : ""}`;
  const sql = `
    SELECT q.*,
           CASE
             WHEN q.status = 'revoked' THEN 'revoked'
             WHEN q.expires_at IS NOT NULL AND q.expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 THEN 'expired'
             WHEN q.daily_usd_nanos IS NOT NULL AND q._spend_today >= q.daily_usd_nanos / 1000000000.0 THEN 'daily_limit'
             WHEN q.total_usd_nanos IS NOT NULL AND q._spend_total >= q.total_usd_nanos / 1000000000.0 THEN 'total_limit'
             ELSE 'active'
           END AS effective_status
    FROM (${sourceSql}) q`;
  return { sql, params: userId ? [userId] : [] };
}

/**
 * Server-driven key listing (AG Grid blocks). userId narrows to one owner
 * (null = admin/global). The USD counters become SQL columns via
 * correlated subqueries so they're sortable/filterable alongside the rest.
 */
export function queryKeys(
  userId: string | null,
  grid: { limit: number; offset: number; sort?: Array<{ colId: string; sort: string }>; filters?: Record<string, { filterType?: string; type?: string; filter?: unknown; filterTo?: unknown }> },
  extra?: { clauses: string[]; params: Array<string | number> },
): { keys: ReturnType<typeof publicKey>[]; total: number } {
  const source = keyQuerySource(userId);
  const baseSql = extra ? `SELECT r.* FROM (${source.sql}) r WHERE ${extra.clauses.join(" AND ") || "1"}` : source.sql;
  const cols: Record<string, ColSpec> = {
    name: { col: "name" },
    userEmail: { col: "userEmail" },
    status: { col: "effective_status" },
    prefix: { col: "prefix" },
    spendTodayUsd: { col: "_spend_today", kind: "number" },
    spendTotalUsd: { col: "_spend_total", kind: "number" },
    expiresAt: { col: "expires_at", kind: "date" },
    lastUsedAt: { col: "last_used_at", kind: "date" },
    rpm: { col: "rpm", kind: "number" },
    createdAt: { col: "created_at", kind: "number" },
  };
  const { rows, total } = gridPage({
    baseSql,
    baseParams: [...source.params, ...(extra?.params ?? [])],
    cols,
    grid,
    defaultOrder: "created_at DESC",
    tieBreak: "id DESC",
  });
  const keys = (rows as Array<ApiKeyRow & { userEmail?: string; _spend_today: number; _spend_total: number; effective_status: ReturnType<typeof publicKey>["status"] }>).map(
    (r) => ({ ...publicKey(r, r.userEmail ?? undefined, { today: r._spend_today, total: r._spend_total }), status: r.effective_status }),
  );
  return { keys, total };
}
