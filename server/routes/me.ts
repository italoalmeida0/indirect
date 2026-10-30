import QRCode from "qrcode";

import { LIMITS } from "../config";
import { db, stmts, audit, inImmediateTx, type UserRow } from "../db";
import {
  hashPassword,
  verifyPassword,
  newTotpSecret,
  totpUri,
  totpVerify,
  sha256Hex,
} from "../crypto";
import {
  requireAuth,
  markUserSessionsRevoked,
  markSessionRevoked,
  publicUser,
} from "../auth";
import { disconnectSessionSockets } from "./relay";
import { verifyGoogleIdToken } from "../google";
import { sendSecurityAlert } from "../email";
import { ApiError, clientIp, err, ok, rateLimitError, readJsonBody, v } from "../http";
import { bruteforceClear, bruteforceFail, bruteforceLocked, consumeTotpCode } from "../ratelimit";
import { DEFAULT_MODEL_CONTEXT, DEFAULT_MODEL_OUTPUT, routerSnapshot, listableModels } from "../models";
import { allowedModels, modelAllowed } from "../model-policy";
import { requireKeyProject, requireProjectAccess } from "../projects";
import { financialPolicyFor, installationDefaults } from "../financial-policy";
import { assertMfaCanDisable, consumeDurableTotp, corporateAuthConfig } from "../auth-policy";
import { requireLiveActor } from "../live-auth";

const ENROLLMENT_TTL = 5 * 60_000;
const credentialFingerprint = (user: UserRow) => sha256Hex(JSON.stringify([user.password_hash, user.totp_secret, user.google_id]));

/**
 * /api/me/* — profile, password, TOTP, Google linking, session management.
 * Everything here requires a valid Bearer access token.
 */

export async function handleMeRoute(path: string, req: Request): Promise<Response | null> {
  // ---- profile ----
  if (path === "/api/me" && req.method === "GET") {
    const ctx = await requireAuth(req);
    return ok({ user: publicUser(ctx.user) }, req);
  }

  if (path === "/api/me" && req.method === "PATCH") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const name = v.str(body, "name", { min: 1, max: 128 })!;
    // Every mutation is audited, including a profile rename: "who changed this
    // and when" is exactly what an offboarding review asks for, and a silent
    // rename leaves no trail.
    const changed = name !== ctx.user.name;
    inImmediateTx(() => {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, ctx.user.id);
      if (changed) {
        audit("profile.updated", {
          actorId: ctx.user.id,
          target: ctx.user.id,
          ip,
          meta: { field: "name", from: ctx.user.name, to: name },
        });
      }
    });
    return ok({ user: publicUser(stmts.userById.get(ctx.user.id)!) }, req);
  }

  // ---- password set/change ----
  if (path === "/api/me/password" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const newPassword = v.str(body, "newPassword", { min: 1, max: 256 })!;
    if (newPassword.length < 10) throw new ApiError(400, "password must be at least 10 characters");

    if (ctx.user.password_hash) {
      const current = v.str(body, "currentPassword", { min: 1, max: 256 })!;
      const locked = bruteforceLocked(`pwchange:${ctx.user.id}`);
      if (locked > 0) return rateLimitError(`too many attempts, retry in ${locked}s`, locked, req);
      if (!(await verifyPassword(current, ctx.user.password_hash))) {
        bruteforceFail(`pwchange:${ctx.user.id}`);
        return err(401, "current password is incorrect", req);
      }
    }

    const newHash = await hashPassword(newPassword);
    inImmediateTx(() => {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, ctx.user.id);
      markUserSessionsRevoked(ctx.user.id, ctx.session.jti);
      audit("password.changed", { actorId: ctx.user.id, ip });
    });
    disconnectSessionSockets(ctx.user.id, { exceptJti: ctx.session.jti });
    void sendSecurityAlert(ctx.user.email, "Your password was changed.");
    return ok({ done: true }, req);
  }

  // ---- TOTP setup: generate pending secret + QR ----
  if (path === "/api/me/2fa/setup" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = req.body ? await readJsonBody(req, LIMITS.authBodyBytes) : {};
    if (Object.keys(body).some((key) => !["currentPassword", "currentCode", "useRecovery"].includes(key)) || (body.useRecovery !== undefined && typeof body.useRecovery !== "boolean")) throw new ApiError(400, "invalid authenticator setup fields");
    const replacing = !!ctx.user.totp_secret;
    const viaRecovery = replacing && body.useRecovery === true;
    const scope = `2fareplace:${ctx.user.id}`;
    const locked = bruteforceLocked(scope);
    if (locked) return rateLimitError(`too many attempts; retry in ${locked}s`, locked, req);
    let currentCode = "";
    if (replacing && !viaRecovery) {
      if (typeof body.currentCode !== "string" || (ctx.user.password_hash && typeof body.currentPassword !== "string")) throw new ApiError(403, "confirm your current authenticator and account password before replacing it, or sign in with a recovery code");
      currentCode = v.str(body, "currentCode", { min: 6, max: 6 })!;
      const passwordValid = !ctx.user.password_hash || await verifyPassword(v.str(body, "currentPassword", { min: 1, max: 256 })!, ctx.user.password_hash);
      if (!passwordValid || !await totpVerify(ctx.user.totp_secret!, currentCode)) {
        bruteforceFail(scope);
        throw new ApiError(401, "invalid account verification");
      }
    }
    const secret = newTotpSecret();
    const uri = totpUri(secret, ctx.user.email);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    const expiresAt = Date.now() + ENROLLMENT_TTL;
    inImmediateTx(() => {
      requireLiveActor(ctx);
      const session = stmts.sessionByJti.get(ctx.session.jti)!;
      if (viaRecovery) {
        const verifiedAt = session.recovery_verified_at;
        if (!verifiedAt || verifiedAt > Date.now() || Date.now() - verifiedAt > ENROLLMENT_TTL) throw new ApiError(403, "sign in with an unused recovery code before replacing a lost authenticator; recovery approval lasts five minutes and works once");
        db.prepare("UPDATE sessions SET recovery_verified_at=NULL WHERE jti=?").run(session.jti);
      } else if (replacing) consumeDurableTotp(ctx.user.totp_secret!, currentCode);
      db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(secret, ctx.user.id);
      db.prepare(`INSERT INTO mfa_enrollments(user_id,session_jti,pending_hash,credential_fingerprint,policy_version,expires_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET session_jti=excluded.session_jti,pending_hash=excluded.pending_hash,
        credential_fingerprint=excluded.credential_fingerprint,policy_version=excluded.policy_version,expires_at=excluded.expires_at`)
        .run(ctx.user.id, ctx.session.jti, sha256Hex(secret), credentialFingerprint(ctx.user), corporateAuthConfig().version, expiresAt);
      audit("2fa.setup", { actorId: ctx.user.id, target: ctx.user.id, ip, meta: { replacement: replacing, viaRecovery } });
    });
    bruteforceClear(scope);
    const response = ok({ secret, otpauthUri: uri, qrDataUrl, expiresAt }, req);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (path === "/api/me/2fa/enable" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    if (!ctx.user.totp_pending) return err(400, "run setup first", req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const code = v.str(body, "code", { min: 6, max: 6 })!;

    const locked = bruteforceLocked(`2faenable:${ctx.user.id}`);
    if (locked > 0) return rateLimitError(`too many attempts, retry in ${locked}s`, locked, req);
    if (!(await totpVerify(ctx.user.totp_pending, code))) {
      bruteforceFail(`2faenable:${ctx.user.id}`);
      return err(400, "invalid code — check your authenticator clock", req);
    }
    bruteforceClear(`2faenable:${ctx.user.id}`);
    inImmediateTx(() => {
      const current = requireLiveActor(ctx);
      const enrollment = db.query<{ session_jti: string; pending_hash: string; credential_fingerprint: string; policy_version: number; expires_at: number }, [string]>("SELECT * FROM mfa_enrollments WHERE user_id=?").get(ctx.user.id);
      if (current.totp_pending !== ctx.user.totp_pending || !enrollment || enrollment.session_jti !== ctx.session.jti || enrollment.pending_hash !== sha256Hex(ctx.user.totp_pending!) || enrollment.credential_fingerprint !== credentialFingerprint(current) || enrollment.policy_version !== corporateAuthConfig().version || enrollment.expires_at <= Date.now()) throw new ApiError(409, "authenticator setup expired or changed; run setup again in this session");
      consumeDurableTotp(ctx.user.totp_pending!, code);
      db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = ?").run(
        ctx.user.id,
      );
      db.prepare("DELETE FROM mfa_enrollments WHERE user_id=?").run(ctx.user.id);
      markUserSessionsRevoked(ctx.user.id, ctx.session.jti);
      db.prepare("UPDATE sessions SET mfa_verified=1 WHERE jti=?").run(ctx.session.jti);
      audit("2fa.enabled", { actorId: ctx.user.id, ip });
    });
    disconnectSessionSockets(ctx.user.id, { exceptJti: ctx.session.jti });
    void sendSecurityAlert(ctx.user.email, "Two-factor authentication was enabled.");
    return ok({ enabled: true }, req);
  }

  if (path === "/api/me/2fa/disable" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    if (!ctx.user.totp_secret) return err(400, "2FA is not enabled", req);
    assertMfaCanDisable(ctx.user);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const code = v.str(body, "code", { min: 6, max: 6 })!;

    const locked = bruteforceLocked(`2fadisable:${ctx.user.id}`);
    if (locked > 0) return rateLimitError(`too many attempts, retry in ${locked}s`, locked, req);
    const valid = await totpVerify(ctx.user.totp_secret, code);
    if (!valid || !consumeTotpCode(sha256Hex(`${ctx.user.totp_secret}:${code}`))) {
      bruteforceFail(`2fadisable:${ctx.user.id}`);
      return err(401, "invalid code", req);
    }

    inImmediateTx(() => {
      const current = stmts.userById.get(ctx.user.id);
      if (!current || current.totp_secret !== ctx.user.totp_secret) throw new ApiError(409, "authenticator changed; sign in again");
      assertMfaCanDisable(current);
      consumeDurableTotp(current.totp_secret!, code);
      db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?").run(
        ctx.user.id,
      );
      db.prepare("DELETE FROM auth_recovery_codes WHERE user_id=?").run(ctx.user.id);
      markUserSessionsRevoked(ctx.user.id, ctx.session.jti);
      db.prepare("UPDATE sessions SET mfa_verified=0 WHERE jti=?").run(ctx.session.jti);
      audit("2fa.disabled", { actorId: ctx.user.id, ip });
    });
    disconnectSessionSockets(ctx.user.id, { exceptJti: ctx.session.jti });
    void sendSecurityAlert(ctx.user.email, "Two-factor authentication was disabled.");
    return ok({ disabled: true }, req);
  }

  // ---- Google link / unlink ----
  if (path === "/api/me/google/link" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const idToken = v.str(body, "idToken", { min: 20, max: 8192 })!;

    const identity = await verifyGoogleIdToken(idToken);
    if (!identity.emailVerified) return err(400, "Google email must be verified", req);
    // The session already proves identity, so the Google email does NOT need to
    // match the account email (e.g. work Google + personal gateway account).
    // Login never links identities by email; this explicit session-bound action does.
    const conflict = inImmediateTx(() => {
      const existing = stmts.userByGoogleId.get(identity.sub);
      if (existing && existing.id !== ctx.user.id) return true;
      db.prepare("UPDATE users SET google_id = ? WHERE id = ?").run(identity.sub, ctx.user.id);
      markUserSessionsRevoked(ctx.user.id, ctx.session.jti);
      audit("google.linked", { actorId: ctx.user.id, ip, meta: { email: identity.email } });
      return false;
    });
    if (conflict) {
      return err(409, "this Google account is linked to another user", req);
    }
    disconnectSessionSockets(ctx.user.id, { exceptJti: ctx.session.jti });
    void sendSecurityAlert(
      ctx.user.email,
      `A Google account (${identity.email}) was linked to your account.`,
    );
    return ok({ linked: true }, req);
  }

  if (path === "/api/me/google/link" && req.method === "DELETE") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    if (!ctx.user.google_id) return err(400, "no Google account linked", req);
    if (!ctx.user.password_hash) {
      return err(400, "set a password before unlinking Google", req);
    }
    inImmediateTx(() => {
      db.prepare("UPDATE users SET google_id = NULL WHERE id = ?").run(ctx.user.id);
      markUserSessionsRevoked(ctx.user.id, ctx.session.jti);
      audit("google.unlinked", { actorId: ctx.user.id, ip });
    });
    disconnectSessionSockets(ctx.user.id, { exceptJti: ctx.session.jti });
    return ok({ linked: false }, req);
  }

  // ---- sessions ----
  if (path === "/api/me/sessions" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const rows = db
      .prepare(
        `SELECT jti, created_at, last_used_at, expires_at, ip, ua, label
         FROM sessions WHERE user_id = ? AND revoked = 0 AND abs_expires_at > ?
         ORDER BY last_used_at DESC LIMIT 50`,
      )
      .all(ctx.user.id, Date.now()) as any[];
    return ok(
      {
        sessions: rows.map((s) => ({
          jti: s.jti,
          createdAt: s.created_at,
          lastUsedAt: s.last_used_at,
          expiresAt: s.expires_at,
          ip: s.ip,
          ua: s.ua,
          label: s.label,
          current: s.jti === ctx.session.jti,
        })),
      },
      req,
    );
  }

  if (path.startsWith("/api/me/sessions/") && req.method === "PATCH") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const jti = path.slice("/api/me/sessions/".length).trim();
    if (!jti || jti.length > 128) return err(400, "invalid session id", req);
    const target = stmts.sessionByJti.get(jti);
    if (!target || target.user_id !== ctx.user.id) return err(404, "session not found", req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const label = v.str(body, "label", { max: 64, optional: true }) || null;
    inImmediateTx(() => {
      db.prepare("UPDATE sessions SET label = ? WHERE jti = ?").run(label, jti);
      audit("session.updated", {
        actorId: ctx.user.id,
        target: jti,
        ip,
        meta: { label, previousLabel: target.label },
      });
    });
    return ok({ done: true }, req);
  }

  if (path.startsWith("/api/me/sessions/") && req.method === "DELETE") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const jti = path.slice("/api/me/sessions/".length).trim();
    if (!jti || jti.length > 128) return err(400, "invalid session id", req);
    const target = stmts.sessionByJti.get(jti);
    if (!target || target.user_id !== ctx.user.id) return err(404, "session not found", req);
    inImmediateTx(() => {
      markSessionRevoked(jti);
      audit("session.revoked", { actorId: ctx.user.id, target: jti, ip });
    });
    disconnectSessionSockets(ctx.user.id, { jti });
    return ok({ revoked: true }, req);
  }

  // Financial visibility: the effective policy for THIS caller. Read-only here;
  // who may change it is an administrator decision (see /api/admin/policy).
  if (path === "/api/me/financial-policy" && req.method === "GET") {
    const ctx = await requireAuth(req);
    return ok({ policy: financialPolicyFor(ctx.user), defaults: installationDefaults() }, req);
  }

  if (path === "/api/me/models" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (projectId) {
      if (ctx.user.role === "admin") {
        const project = requireProjectAccess(ctx.user, projectId);
        if (project.kind !== "project" || project.status !== "active") throw new ApiError(404, "Project not found");
      } else requireKeyProject(ctx.user.id, projectId);
    }
    const snap = await routerSnapshot();
    const allowed = allowedModels({ role: ctx.user.role, projectId });
    // Provider display data comes from the FIRST routing target (fallback
    // order); unknown context windows report DEFAULT_MODEL_CONTEXT.
    const models = listableModels(snap, "openai")
      .filter((m) => modelAllowed(allowed, m.id))
      .map((m) => {
        const first = (snap.targets.get(m.id) ?? []).find((t) => t.enabled);
        const providerName = first ? (snap.providers.get(first.provider_id)?.row.name ?? "") : "";
        return {
          id: m.id,
          name: m.name || m.id,
          provider: providerName,
          upstreamModel: first?.upstream_model ?? m.upstream_model,
          context: m.context_length ?? DEFAULT_MODEL_CONTEXT,
          output: m.max_output_length ?? DEFAULT_MODEL_OUTPUT,
        };
      });

    return ok({ models }, req);
  }

  return null;
}
