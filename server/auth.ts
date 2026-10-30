import { GATEWAY_SECRET, LIMITS } from "./config";
import { db, stmts, audit, inImmediateTx, type UserRow, type SessionRow } from "./db";
import { jwtSign, jwtVerify, randomToken, sha256Hex } from "./crypto";
import { financialPolicyFor, formatFinancialPolicyHeader } from "./financial-policy";
import { ApiError } from "./http";
import { setCurrentFinancialPolicyHeader, setMutationRevalidator } from "./request-context";
import { requireLiveActor } from "./live-auth";
import { disconnectSessionSockets } from "./routes/relay";
import { accountAuthPolicy, assertLoginMethodAllowed, assertSessionPolicy, corporateAuthConfig, type LoginMethod } from "./auth-policy";
import { effectiveRole } from "./roles";
export { effectiveRole, EFFECTIVE_ROLE_SQL } from "./roles";

/**
 * Session model:
 *  - Access token: HS256 JWT (12h), carries { sub, jti, role, type:'access' }.
 *  - Refresh token: opaque 256-bit, stored as SHA-256 in the sessions row,
 *    30d sliding expiry + 180d absolute cap, rotated on every use.
 *  - Revocation: the session row (keyed by jti) gates BOTH tokens, so banning
 *    a user or revoking a session kills access immediately (checked per request).
 */

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: effectiveRole(u),
    hasPassword: !!u.password_hash,
    googleLinked: !!u.google_id,
    oidcLinked: !!db.query("SELECT 1 FROM corporate_identities WHERE user_id=?").get(u.id),
    managed: accountAuthPolicy(u.id).managed,
    totpEnabled: !!u.totp_secret,
    status: u.status,
    createdAt: u.created_at,
  };
}

export async function prepareSessionTokens(
  user: UserRow,
  meta: { ip?: string | null; ua?: string | null; label?: string | null; family?: string | null; authMethod?: LoginMethod; mfaVerified?: boolean; recoveryVerifiedAt?: number | null } = {},
) {
  const jti = randomToken(16);
  const refreshToken = randomToken(32);
  const now = Date.now();
  const policyVersion = corporateAuthConfig().version;
  const refreshExpiresAt = now + LIMITS.refreshTokenTtlMs;
  const accessToken = await jwtSign(
    { sub: user.id, jti, role: effectiveRole(user), type: "access" },
    GATEWAY_SECRET,
    LIMITS.accessTokenTtlSec,
  );
  return {
    jti,
    accessToken,
    refreshToken,
    refreshHash: sha256Hex(refreshToken),
    now,
    refreshExpiresAt,
    absExpiresAt: now + LIMITS.refreshAbsoluteTtlMs,
    ip: meta.ip ?? null,
    ua: meta.ua?.slice(0, 200) ?? null,
    label: meta.label ?? null,
    family: meta.family ?? jti,
    authMethod: meta.authMethod ?? "local",
    mfaVerified: meta.mfaVerified ? 1 : 0,
    policyVersion,
    recoveryVerifiedAt: meta.recoveryVerifiedAt ?? null,
  };
}

export function insertSessionRow(
  userId: string,
  prepared: Awaited<ReturnType<typeof prepareSessionTokens>>,
): void {
  db.prepare(
    `INSERT INTO sessions (jti, user_id, refresh_hash, created_at, last_used_at, expires_at, abs_expires_at, revoked, ip, ua, label, family, auth_method, mfa_verified, auth_policy_version, recovery_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    prepared.jti,
    userId,
    prepared.refreshHash,
    prepared.now,
    prepared.now,
    prepared.refreshExpiresAt,
    prepared.absExpiresAt,
    prepared.ip,
    prepared.ua,
    prepared.label,
    prepared.family,
    prepared.authMethod,
    prepared.mfaVerified,
    prepared.policyVersion,
    prepared.recoveryVerifiedAt,
  );
}

/** Sign a short-lived token that only proves "password step passed, awaiting 2FA". */
export async function issue2faTempToken(userSnapshot: UserRow, authMethod: LoginMethod = "local", identity?: { issuer: string; subject: string }, policyVersion = corporateAuthConfig().version): Promise<string> {
  const userId = userSnapshot.id;
  const jti = randomToken(24);
  const token = await jwtSign(
    { sub: userId, jti, type: "2fa", policyVersion, identityIssuer: identity?.issuer, identitySubject: identity?.subject ?? (authMethod === "google" ? userSnapshot.google_id : undefined) },
    GATEWAY_SECRET,
    LIMITS.twoFaTempTtlSec,
  );
  inImmediateTx(() => {
    const user = stmts.userById.get(userId);
    if (!user || user.status !== "active" || user.password_hash !== userSnapshot.password_hash || user.totp_secret !== userSnapshot.totp_secret || user.google_id !== userSnapshot.google_id) throw new ApiError(401, "account credentials changed; sign in again");
    if (authMethod === "oidc" && (!identity || !db.query("SELECT 1 FROM corporate_identities WHERE issuer=? AND subject=? AND user_id=?").get(identity.issuer, identity.subject, userId))) throw new ApiError(401, "corporate identity link changed; sign in again");
    assertLoginMethodAllowed(user, authMethod);
    if (corporateAuthConfig().version !== policyVersion) throw new ApiError(401, "security settings changed; sign in again");
    db.prepare("DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at < ? LIMIT 100)").run(Date.now());
    const active = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM auth_challenges WHERE user_id=?").get(userId)!.n;
    if (active >= 20) throw new ApiError(429, "too many pending sign-ins; wait five minutes");
    db.prepare("INSERT INTO auth_challenges(id,user_id,auth_method,expires_at) VALUES (?,?,?,?)").run(jti, userId, authMethod, Date.now() + LIMITS.twoFaTempTtlSec * 1000);
  });
  return token;
}

export async function verify2faTempToken(token: string): Promise<{ userId: string; id: string; authMethod: LoginMethod; policyVersion: number }> {
  const res = await jwtVerify(token, GATEWAY_SECRET);
  if (!res.ok || res.payload.type !== "2fa" || res.payload.policyVersion !== corporateAuthConfig().version) throw new ApiError(401, "invalid or expired 2FA token");
  const challenge = db.query<{ user_id: string; auth_method: LoginMethod; expires_at: number }, [string]>("SELECT user_id,auth_method,expires_at FROM auth_challenges WHERE id=?").get(res.payload.jti);
  if (!challenge || challenge.user_id !== res.payload.sub || challenge.expires_at <= Date.now()) throw new ApiError(401, "invalid or expired 2FA token");
  if (challenge.auth_method === "oidc" && (typeof res.payload.identityIssuer !== "string" || typeof res.payload.identitySubject !== "string" || res.payload.identityIssuer !== corporateAuthConfig().issuer || !db.query("SELECT 1 FROM corporate_identities WHERE issuer=? AND subject=? AND user_id=?").get(res.payload.identityIssuer, res.payload.identitySubject, challenge.user_id))) throw new ApiError(401, "corporate identity link changed; sign in again");
  if (challenge.auth_method === "google" && stmts.userById.get(challenge.user_id)?.google_id !== res.payload.identitySubject) throw new ApiError(401, "Google identity link changed; sign in again");
  return { userId: challenge.user_id, id: res.payload.jti, authMethod: challenge.auth_method, policyVersion: res.payload.policyVersion as number };
}

/** Must be called in the same transaction that creates the authenticated session. */
export function consumeAuthChallenge(id: string, userId: string): void {
  const claimed = db.prepare("DELETE FROM auth_challenges WHERE id=? AND user_id=? AND expires_at>?").run(id, userId, Date.now());
  if (claimed.changes !== 1) throw new ApiError(401, "sign-in was already completed or expired");
}

export function markSessionRevoked(jti: string): SessionRow | undefined {
  const session = stmts.sessionByJti.get(jti);
  db.prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(jti);
  return session ?? undefined;
}

export function revokeSession(jti: string): void {
  const session = markSessionRevoked(jti);
  if (session) disconnectSessionSockets(session.user_id, { jti });
}

/** Use inside an enclosing transaction when revocation accompanies a change
 *  to credentials or account status; disconnect sockets after commit. */
export function markUserSessionsRevoked(userId: string, exceptJti?: string): void {
  db.prepare("DELETE FROM auth_challenges WHERE user_id=?").run(userId);
  if (exceptJti) {
    db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ? AND jti != ?").run(
      userId,
      exceptJti,
    );
  } else {
    db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId);
  }
}

/** Rotate a refresh token -> new session row (old jti revoked).
 *
 *  Reuse detection: a refresh token whose session row is ALREADY revoked has
 *  been presented before (rotation happened, or the user logged out). Since
 *  tokens are one-time, a replay means someone is holding a stolen copy — so
 *  the WHOLE rotation family is revoked: the attacker's rotated-forward
 *  session dies with it (OWASP refresh-token reuse handling).
 */
export async function rotateRefreshToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: number;
  user: UserRow;
}> {
  const session = stmts.sessionByRefreshHash.get(sha256Hex(refreshToken));
  if (!session) throw new ApiError(401, "invalid refresh token");

  const now = Date.now();
  if (session.revoked) {
    // A session that lapsed by expiry and was swept is just old — but one
    // revoked MID-LIFE (rotated away or logged out) being replayed is theft
    // evidence: kill the whole rotation family so the stolen copy's
    // rotated-forward session dies too.
    const lapsedNaturally = session.expires_at < now || session.abs_expires_at < now;
    if (!lapsedNaturally && session.family) {
      inImmediateTx(() => {
        db.prepare("UPDATE sessions SET revoked = 1 WHERE family = ?").run(session.family!);
        audit("session.refresh_reuse", {
          target: session.jti,
          meta: { user: session.user_id, family: session.family },
        });
      });
      disconnectSessionSockets(session.user_id, { family: session.family });
    }
    throw new ApiError(401, "session expired, please log in again");
  }
  if (session.abs_expires_at < now) {
    throw new ApiError(401, "session expired, please log in again");
  }
  if (session.expires_at < now) throw new ApiError(401, "session expired, please log in again");

  const user = stmts.userById.get(session.user_id);
  if (!user || user.status !== "active") throw new ApiError(401, "account unavailable");
  assertSessionPolicy(user, session);

  // Rotate: kill old session, create a fresh one (device label and family
  // are carried over — the chain stays auditable as one login).
  const prepared = await prepareSessionTokens(user, {
    ip: session.ip,
    ua: session.ua,
    label: session.label,
    family: session.family ?? session.jti,
    authMethod: session.auth_method as LoginMethod,
    mfaVerified: !!session.mfa_verified,
  });
  prepared.absExpiresAt = session.abs_expires_at;
  prepared.refreshExpiresAt = Math.min(prepared.refreshExpiresAt, session.abs_expires_at);
  inImmediateTx(() => {
    const current = stmts.sessionByJti.get(session.jti);
    const currentUser = stmts.userById.get(user.id);
    if (!current || current.revoked || !currentUser || currentUser.status !== "active") throw new ApiError(401, "session revoked");
    assertSessionPolicy(currentUser, current);
    // A recovery grant is one-use even if refresh raced its consumption.
    prepared.recoveryVerifiedAt = current.recovery_verified_at;
    markSessionRevoked(session.jti);
    insertSessionRow(user.id, prepared);
  });
  disconnectSessionSockets(session.user_id, { jti: session.jti });
  return {
    accessToken: prepared.accessToken,
    refreshToken: prepared.refreshToken,
    refreshExpiresAt: prepared.refreshExpiresAt,
    user,
  };
}

/**
 * Verify the Authorization Bearer token on dashboard requests.
 * Throws ApiError(401/403) on any problem.
 */
export async function requireAuth(req: Request): Promise<AuthContext> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "missing bearer token");

  const res = await jwtVerify(token, GATEWAY_SECRET);
  if (!res.ok || res.payload.type !== "access") throw new ApiError(401, "invalid or expired token");

  const session = stmts.sessionByJti.get(res.payload.jti);
  const now = Date.now();
  if (!session || session.user_id !== res.payload.sub || session.revoked || session.expires_at <= now || session.abs_expires_at <= now) {
    throw new ApiError(401, "session revoked");
  }

  const user = stmts.userById.get(session.user_id);
  if (!user) throw new ApiError(401, "unknown user");
  if (user.status !== "active") throw new ApiError(403, "account is disabled");
  assertSessionPolicy(user, session);

  // Sliding refresh of the session bookkeeping (cheap update, throttled).
  if (now - session.last_used_at > 60_000) {
    db.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE jti = ?").run(
      now,
      Math.min(now + LIMITS.refreshTokenTtlMs, session.abs_expires_at),
      session.jti,
    );
  }

  setCurrentFinancialPolicyHeader(formatFinancialPolicyHeader(financialPolicyFor(user)));
  const ctx = { user, session };
  setMutationRevalidator(() => { requireLiveActor(ctx); });
  return ctx;
}

export async function requireAdmin(req: Request): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (ctx.user.role !== "admin") throw new ApiError(403, "admin only");
  return ctx;
}

/** Express an admin action in the audit log. */
export function auditAdmin(actor: UserRow, action: string, target?: string, meta?: unknown, ip?: string) {
  audit(action, { actorId: actor.id, target, meta, ip });
}
