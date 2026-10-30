import { LIMITS, GOOGLE_CLIENT_ID, SMTP_ENABLED } from "../config";
import type { Server } from "bun";
import { db, stmts, audit, inImmediateTx, type UserRow } from "../db";
import {
  hashPassword,
  verifyPassword,
  totpVerify,
  randomToken,
  sha256Hex,
} from "../crypto";
import {
  prepareSessionTokens,
  insertSessionRow,
  issue2faTempToken,
  verify2faTempToken,
  rotateRefreshToken,
  requireAuth,
  markSessionRevoked,
  markUserSessionsRevoked,
  publicUser,
  consumeAuthChallenge,
} from "../auth";
import { disconnectSessionSockets } from "./relay";
import { verifyGoogleIdToken } from "../google";
import { sendResetEmail, sendSecurityAlert } from "../email";
import { ApiError, clientIp, err, ok, rateLimitError, readJsonBody, v } from "../http";
import {
  bruteforceClear,
  bruteforceFail,
  bruteforceLocked,
  consumeTotpCode,
  limits,
} from "../ratelimit";
import { assertLoginMethodAllowed, assertSessionPolicy, consumeDurableTotp, corporateAuthConfig, recoveryCodeHash, requiresSso, type LoginMethod } from "../auth-policy";

/**
 * POST /api/auth/* — public credential endpoints. Heavily rate limited and
 * deliberately generic in error messages (no account enumeration).
 */

const DUMMY_HASH =
  "pbkdf2:100000:VGVtcG9yYXJ5U2FsdFZhbHVlMTIzNDU2Nzg5MDEy:QWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg=";

function passwordPolicy(pw: string): void {
  if (pw.length < 10) throw new ApiError(400, "password must be at least 10 characters");
  if (pw.length > 256) throw new ApiError(400, "password is too long");
}

export async function finishLogin(
  user: UserRow,
  req: Request,
  server: Pick<Server<unknown>, "requestIP"> | undefined,
  loginAction: string,
  extraBefore?: () => void,
  proof: { authMethod?: LoginMethod; mfaVerified?: boolean; challengeId?: string; policyVersion?: number; recoveryVerified?: boolean } = {},
) {
  const ip = clientIp(req, server);
  const prepared = await prepareSessionTokens(user, { ip, ua: req.headers.get("user-agent"), authMethod: proof.authMethod, mfaVerified: proof.mfaVerified, recoveryVerifiedAt: proof.recoveryVerified ? Date.now() : null });
  inImmediateTx(() => {
    const fresh = stmts.userById.get(user.id);
    if (!fresh || fresh.status !== "active" || fresh.password_hash !== user.password_hash || fresh.totp_secret !== user.totp_secret || fresh.google_id !== user.google_id || fresh.role !== user.role || fresh.enterprise_role !== user.enterprise_role || (proof.policyVersion !== undefined && corporateAuthConfig().version !== proof.policyVersion)) throw new ApiError(401, "account credentials or permissions changed; sign in again");
    assertSessionPolicy(fresh, { auth_method: prepared.authMethod, mfa_verified: prepared.mfaVerified, auth_policy_version: prepared.policyVersion });
    if (proof.challengeId) consumeAuthChallenge(proof.challengeId, user.id);
    extraBefore?.();
    insertSessionRow(user.id, prepared);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(prepared.now, user.id);
    audit(loginAction, { actorId: user.id, ip });
  });
  return ok(
    {
      accessToken: prepared.accessToken,
      refreshToken: prepared.refreshToken,
      refreshExpiresAt: prepared.refreshExpiresAt,
      user: publicUser(stmts.userById.get(user.id)!),
    },
    req,
  );
}

export async function handleAuthRoute(path: string, req: Request, server: Pick<Server<unknown>, "requestIP">): Promise<Response | null> {
  const ip = clientIp(req, server);

  // Credential bucket applies ONLY to credential endpoints —
  // refresh/logout/config are called routinely by the dashboard and must not
  // eat the login budget (authed traffic is covered by the global ip bucket).
  const CREDENTIAL_PATHS = ["/api/auth/login", "/api/auth/2fa", "/api/auth/google"];
  if (CREDENTIAL_PATHS.includes(path)) {
    const retry = limits.authPerMin(ip);
    if (retry > 0) return rateLimitError(`too many attempts, retry in ${retry}s`, retry, req);
  }

  if (path === "/api/auth/config" && req.method === "GET") {
    return ok(
      {
        googleClientId: GOOGLE_CLIENT_ID || null,
        smtpConfigured: SMTP_ENABLED,
        oidcEnabled: corporateAuthConfig().enabled,
        oidcStartUrl: "/api/auth/oidc/start",
      },
      req,
    );
  }

  // ---- login: email + password ----
  if (path === "/api/auth/login" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const email = v.email(body, "email");
    const password = v.str(body, "password", { min: 1, max: 256 })!;

    const scope = `login:${email}`;
    const scopeIp = `login-ip:${ip}`;
    const locked = Math.max(bruteforceLocked(scope), bruteforceLocked(scopeIp));
    if (locked > 0) return rateLimitError(`account temporarily locked, retry in ${locked}s`, locked, req);

    const user = stmts.userByEmail.get(email);
    const hash = user?.password_hash ?? DUMMY_HASH;
    const policyVersion = corporateAuthConfig().version;
    const valid = await verifyPassword(password, hash).catch(() => false);

    if (!user || !user.password_hash || !valid) {
      bruteforceFail(scope);
      bruteforceFail(scopeIp, LIMITS.loginIpFailMax);
      audit("login.failed", { target: email, ip });
      return err(401, "invalid email or password", req);
    }
    if (user.status !== "active") return err(403, "account is disabled", req);
    assertLoginMethodAllowed(user, "local");

    // Password correct — if TOTP is enabled, move to the 2FA step.
    if (user.totp_secret) {
      const tempToken = await issue2faTempToken(user, "local", undefined, policyVersion);
      return ok({ needs2FA: true, tempToken }, req);
    }

    bruteforceClear(scope);
    return finishLogin(user, req, server, "login.success", undefined, { policyVersion });
  }

  // ---- 2FA completion ----
  if (path === "/api/auth/2fa" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const tempToken = v.str(body, "tempToken", { min: 10, max: 4096 })!;
    const code = v.str(body, "code", { min: 6, max: 64 })!;

    const challenge = await verify2faTempToken(tempToken).catch(() => null);
    if (!challenge) return err(401, "invalid or expired 2FA token", req);
    const userId = challenge.userId;

    const scope = `2fa:${userId}`;
    const locked = bruteforceLocked(scope);
    if (locked > 0) return rateLimitError(`too many 2FA failures, retry in ${locked}s`, locked, req);

    const user = stmts.userById.get(userId);
    if (!user || !user.totp_secret || user.status !== "active") {
      return err(401, "2FA not available for this account", req);
    }
    assertLoginMethodAllowed(user, challenge.authMethod);

    const isTotp = /^\d{6}$/.test(code);
    const recoveryHash = recoveryCodeHash(userId, code);
    const valid = isTotp ? await totpVerify(user.totp_secret, code) : /^[a-f0-9]{4}(?:-[a-f0-9]{4}){4}$/i.test(code) && !!db.query("SELECT 1 FROM auth_recovery_codes WHERE user_id=? AND code_hash=?").get(userId, recoveryHash);
    if (!valid || (isTotp && !consumeTotpCode(sha256Hex(`${user.totp_secret}:${code}`)))) {
      bruteforceFail(scope);
      audit("2fa.failed", { actorId: userId, ip });
      return err(401, "invalid code", req);
    }

    bruteforceClear(scope);
    bruteforceClear(`login:${user.email}`);
    const response = await finishLogin(user, req, server, isTotp ? "login.success.2fa" : "login.success.recovery", () => {
      if (isTotp) consumeDurableTotp(user.totp_secret!, code);
      else {
        const used = db.prepare("DELETE FROM auth_recovery_codes WHERE user_id=? AND code_hash=?").run(userId, recoveryHash);
        if (used.changes !== 1) throw new ApiError(401, "recovery code was already used");
        markUserSessionsRevoked(userId);
        audit("auth.recovery.used", { actorId: userId, target: userId, ip });
      }
    }, { authMethod: challenge.authMethod, mfaVerified: true, challengeId: challenge.id, policyVersion: challenge.policyVersion, recoveryVerified: !isTotp });
    if (!isTotp) disconnectSessionSockets(userId);
    return response;
  }

  // ---- Google sign-in (explicitly linked identities only) ----
  if (path === "/api/auth/google" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const idToken = v.str(body, "idToken", { min: 20, max: 8192 })!;

    const policyVersion = corporateAuthConfig().version;
    const identity = await verifyGoogleIdToken(idToken);

    const user = stmts.userByGoogleId.get(identity.sub);
    if (!user) return err(403, "Google account not linked", req);
    if (user.status !== "active") return err(403, "account is disabled", req);
    assertLoginMethodAllowed(user, "google");

    if (user.totp_secret) {
      const tempToken = await issue2faTempToken(user, "google", undefined, policyVersion);
      return ok({ needs2FA: true, tempToken }, req);
    }

    return finishLogin(
      user,
      req,
      server,
      "login.success.google",
      undefined,
      { authMethod: "google", policyVersion },
    );
  }

  // ---- refresh rotation ----
  if (path === "/api/auth/refresh" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const refreshToken = v.str(body, "refreshToken", { min: 20, max: 256 })!;
    const rotated = await rotateRefreshToken(refreshToken);
    return ok(
      {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        refreshExpiresAt: rotated.refreshExpiresAt,
        user: publicUser(rotated.user),
      },
      req,
    );
  }

  // ---- logout ----
  if (path === "/api/auth/logout" && req.method === "POST") {
    const ctx = await requireAuth(req);
    inImmediateTx(() => {
      markSessionRevoked(ctx.session.jti);
      audit("logout", { actorId: ctx.user.id, target: ctx.session.jti, ip });
    });
    disconnectSessionSockets(ctx.user.id, { jti: ctx.session.jti });
    return ok({ loggedOut: true }, req);
  }

  // ---- password reset request ----
  if (path === "/api/auth/password-reset/request" && req.method === "POST") {
    const limited = limits.resetPer10Min(ip);
    if (limited > 0) return rateLimitError(`too many requests, retry in ${limited}s`, limited, req);

    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const email = v.email(body, "email");

    // Always answer identically to avoid account enumeration.
    const user = stmts.userByEmail.get(email);
    if (user && user.status === "active" && !requiresSso(user) && limits.resetAccountPer10Min(email) === 0) {
      const token = randomToken(32);
      inImmediateTx(() => {
        db.prepare("DELETE FROM password_tokens WHERE user_id = ? AND kind = 'reset'").run(user.id);
        db.prepare(
          "INSERT INTO password_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, 'reset', ?)",
        ).run(sha256Hex(token), user.id, Date.now() + LIMITS.passwordTokenTtlMs);
        audit("password.reset.requested", { target: user.id, ip });
      });
      void sendResetEmail(email, token);
    }
    return ok({ message: "If the account exists, a reset email is on its way." }, req);
  }

  // ---- password reset / invite confirm ----
  if (path === "/api/auth/password-reset/confirm" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const token = v.str(body, "token", { min: 20, max: 256 })!;
    const password = v.str(body, "password", { min: 1, max: 256 })!;
    passwordPolicy(password);

    const tokenHash = sha256Hex(token);
    const row = db
      .prepare<{ user_id: string; kind: string; expires_at: number; used_at: number | null }, [string]>(
        "SELECT user_id, kind, expires_at, used_at FROM password_tokens WHERE token_hash = ?",
      )
      .get(tokenHash);

    if (!row || row.used_at || row.expires_at < Date.now()) {
      return err(400, "link is invalid or has expired", req);
    }
    const resetOwner = stmts.userById.get(row.user_id);
    if (!resetOwner || resetOwner.status !== "active" || requiresSso(resetOwner)) return err(400, "link is invalid or has expired", req);

    const newHash = await hashPassword(password);
    const claimed = inImmediateTx(() => {
      const fresh = stmts.userById.get(row.user_id);
      if (!fresh || fresh.status !== "active" || requiresSso(fresh)) return false;
      const now = Date.now();
      const result = db.prepare(
        "UPDATE password_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?",
      ).run(now, tokenHash, now);
      if (result.changes !== 1) return false;
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, row.user_id);
      markUserSessionsRevoked(row.user_id);
      audit(`password.${row.kind}.completed`, { target: row.user_id, ip });
      return true;
    });
    if (!claimed) return err(400, "link is invalid or has expired", req);
    disconnectSessionSockets(row.user_id);
    const owner = stmts.userById.get(row.user_id);
    if (owner) {
      void sendSecurityAlert(
        owner.email,
        row.kind === "invite" ? "Your account password was set." : "Your password was changed.",
      );
    }

    return ok({ done: true }, req);
  }

  return null; // not an auth route
}
