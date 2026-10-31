import { LIMITS, GATEWAY_SECRET } from "../config";
import { db, audit, inImmediateTx, type ApiKeyRow } from "../db";
import { requireAuth } from "../auth";
import { readUsd } from "../billing";
import { insertPreparedKey, markKeyRevoked, prepareKey, publicKey, queryKeys } from "../keys";
import { decryptSecret } from "../crypto";
import { dropKeyLimiter } from "../ratelimit";
import { parseGridQuery } from "../gridql";
import { catalogWhere } from "../catalog";
import { readUsage } from "../usage-reader";
import { ApiError, clientIp, err, ok, readJsonBody, v } from "../http";
import { financialPolicyFor, projectKeyDto, sanitizeGridForPolicy } from "../financial-policy";
import { validateProjectAssignment } from "../projects";
import { requireLiveActor } from "../live-auth";

const MAX_KEYS_PER_USER = 50;
const MAX_TTL_MS = 10 * 365 * 24 * 3600 * 1000;

function ownKey(userId: string, keyId: string): ApiKeyRow | null {
  const row = db
    .prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?")
    .get(keyId);
  if (!row || row.user_id !== userId) return null;
  return row;
}

/** /api/keys — a user managing their own API keys. */
export async function handleKeysRoute(path: string, req: Request): Promise<Response | null> {
  if (path === "/api/keys/filter-options" && req.method === "GET") {
    const ctx = await requireAuth(req);
    return ok(await readUsage({ kind: "catalog-facets", catalog: "keys", userId: ctx.user.id, search: new URL(req.url).searchParams.toString(), scope: { from: null, to: Infinity, selection: {} } }, req.signal), req);
  }
  if (path === "/api/keys" && req.method === "GET") {
    const ctx = await requireAuth(req);
    // Key spend is money: project it through the caller's financial policy so a
    // "hidden" or "percent" installation never leaks USD amounts or sort/filter oracles.
    const policy = financialPolicyFor(ctx.user);
    if (new URL(req.url).searchParams.has("limit") || new URL(req.url).searchParams.has("selection")) {
      const grid = sanitizeGridForPolicy(parseGridQuery(new URL(req.url)), policy);
      const params = new URL(req.url).searchParams;
      const { keys, total } = queryKeys(ctx.user.id, grid, params.has("selection") ? catalogWhere("keys", params, ctx.user.id) : undefined);
      return ok({ keys: keys.map((k) => projectKeyDto(k, policy)), total, limit: grid.limit, offset: grid.offset, financialPolicy: policy }, req);
    }
    const rows = db
      .prepare<ApiKeyRow, [string]>(
        "SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(ctx.user.id);
    return ok({ keys: rows.map((r) => projectKeyDto(publicKey(r), policy)), financialPolicy: policy }, req);
  }

  if (path === "/api/keys" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);

    const count = db
      .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?")
      .get(ctx.user.id)!.n;
    if (count >= MAX_KEYS_PER_USER) return err(400, `limit of ${MAX_KEYS_PER_USER} keys reached`, req);

    const name = v.str(body, "name", { min: 1, max: 64 })!;
    if ("dailyLimit" in body || "totalLimit" in body) throw new ApiError(400, "Token limits are retired; use dailyLimitUsd and totalLimitUsd");
    const dailyLimit = readUsd(body, "dailyLimitUsd");
    const totalLimit = readUsd(body, "totalLimitUsd");
    const rpm = v.int(body, "rpm", { min: 1, max: 1_000_000, optional: true });
    const projectId = validateProjectAssignment(ctx.user.id, body.projectId);
    const expiresAt = v.int(body, "expiresAt", {
      min: Date.now() + 60_000,
      max: Date.now() + MAX_TTL_MS,
      optional: true,
    });

    const prepared = await prepareKey(ctx.user.id, {
      name,
      expiresAt,
      dailyLimitUsd: dailyLimit === null ? null : dailyLimit / 1e9,
      totalLimitUsd: totalLimit === null ? null : totalLimit / 1e9,
      rpm,
      projectId,
    });
    const row = inImmediateTx(() => {
      requireLiveActor(ctx);
      const currentCount = db
        .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?")
        .get(ctx.user.id)!.n;
      if (currentCount >= MAX_KEYS_PER_USER) {
        throw new ApiError(400, `limit of ${MAX_KEYS_PER_USER} keys reached`);
      }
      validateProjectAssignment(ctx.user.id, projectId);
      const inserted = insertPreparedKey(prepared);
      audit("key.created", {
        actorId: ctx.user.id,
        target: inserted.id,
        ip,
        meta: {
          name,
          dailyLimitUsd: dailyLimit === null ? null : dailyLimit / 1e9,
          totalLimitUsd: totalLimit === null ? null : totalLimit / 1e9,
          rpm,
          projectId,
        },
      });
      return inserted;
    });

    // Plaintext token: returned here AND recoverable later via GET /reveal
    // from the AES copy (token_enc) — every reveal is audit-logged.
    const policy = financialPolicyFor(ctx.user);
    return ok({ key: projectKeyDto(publicKey(row), policy), token: prepared.token, financialPolicy: policy }, req);
  }

  const m = path.match(/^\/api\/keys\/([a-f0-9]{24})(\/reveal)?$/);
  if (!m) return null;
  const keyId = m[1]!;

  if (req.method === "PATCH" && !m[2]) {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const key = ownKey(ctx.user.id, keyId);
    if (!key) return err(404, "key not found", req);

    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const requestedName = v.str(body, "name", { min: 1, max: 64, optional: true });
    if ("dailyLimit" in body || "totalLimit" in body) throw new ApiError(400, "Token limits are retired; use dailyLimitUsd and totalLimitUsd");
    const requestedDaily = "dailyLimitUsd" in body ? readUsd(body, "dailyLimitUsd") : undefined;
    const requestedTotal = "totalLimitUsd" in body ? readUsd(body, "totalLimitUsd") : undefined;
    const requestedRpm = "rpm" in body ? v.int(body, "rpm", { min: 1, max: 1_000_000, optional: true }) : undefined;

    const updated = inImmediateTx(() => {
      requireLiveActor(ctx);
      const fresh = ownKey(ctx.user.id, keyId);
      if (!fresh) throw new ApiError(404, "key not found");
      const name = requestedName ?? fresh.name;
      const dailyLimit = requestedDaily === undefined ? fresh.daily_usd_nanos ?? null : requestedDaily;
      const totalLimit = requestedTotal === undefined ? fresh.total_usd_nanos ?? null : requestedTotal;
      const rpm = "rpm" in body ? requestedRpm ?? null : fresh.rpm;
      // An existing revoked key stays revoked even if another mutation won
      // while this request was waiting for its body.
      const newStatus = fresh.status === "exhausted" ? "active" : fresh.status;
      const projectId = "projectId" in body ? validateProjectAssignment(ctx.user.id, body.projectId) : fresh.project_id ?? null;
      db.prepare(
        "UPDATE api_keys SET name = ?, daily_usd_nanos = ?, total_usd_nanos = ?, rpm = ?, status = ?, project_id = ? WHERE id = ?",
      ).run(name, dailyLimit, totalLimit, rpm, newStatus, projectId, keyId);
      audit("key.updated", {
        actorId: ctx.user.id,
        target: keyId,
        ip,
        meta: {
          name,
          dailyLimitUsd: dailyLimit === null ? null : dailyLimit / 1e9,
          totalLimitUsd: totalLimit === null ? null : totalLimit / 1e9,
          rpm,
          projectId,
        },
      });
      return db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId)!;
    });
    const policy = financialPolicyFor(ctx.user);
    return ok({ key: projectKeyDto(publicKey(updated), policy), financialPolicy: policy }, req);
  }

  if (req.method === "GET" && path.endsWith("/reveal")) {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const key = ownKey(ctx.user.id, keyId);
    if (!key) return err(404, "key not found", req);
    if (!key.token_enc) {
      return err(404, "this key predates reveal support — create a new one to get a copyable token", req);
    }
    const token = await decryptSecret(key.token_enc, GATEWAY_SECRET);
    inImmediateTx(() => {
      requireLiveActor(ctx);
      const current = ownKey(ctx.user.id, keyId);
      if (!current || current.token_enc !== key.token_enc) throw new ApiError(404, "key not found");
      audit("key.revealed", { actorId: ctx.user.id, target: keyId, ip });
    });
    return ok({ token }, req);
  }

  if (req.method === "DELETE" && !m[2]) {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const key = ownKey(ctx.user.id, keyId);
    if (!key) return err(404, "key not found", req);

    const hard = new URL(req.url).searchParams.get("hard") === "true";
    if (hard) {
      // Permanent removal. Usage history is kept (ledger rows stay auditable).
      inImmediateTx(() => {
        requireLiveActor(ctx);
        db.prepare("DELETE FROM api_keys WHERE id = ?").run(keyId);
        audit("key.deleted", { actorId: ctx.user.id, target: keyId, ip, meta: { name: key.name } });
      });
      dropKeyLimiter(keyId);
      return ok({ deleted: true }, req);
    }

    inImmediateTx(() => {
      requireLiveActor(ctx);
      markKeyRevoked(keyId);
      audit("key.revoked", { actorId: ctx.user.id, target: keyId, ip });
    });
    dropKeyLimiter(keyId);
    return ok({ revoked: true }, req);
  }

  return null;
}
