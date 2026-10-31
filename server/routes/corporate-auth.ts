import { LIMITS, PUBLIC_URL } from "../config";
import { db, stmts, audit, inImmediateTx, type UserRow } from "../db";
import { requireAdmin, requireAuth, markUserSessionsRevoked, issue2faTempToken, verify2faTempToken, type AuthContext } from "../auth";
import { accountAuthPolicy, assertCorporateAuthReady, assertLoginMethodAllowed, assertSessionPolicy, consumeDurableTotp, corporateAuthConfig, corporateAuthDto, corporateAuthReadiness, prepareCorporateAuthConfig, recoveryCodeHash, recoveryCodesRemaining, requiresSso, saveCorporateAuthConfig } from "../auth-policy";
import { b64uEncode, randomToken, sha256Hex, totpVerify, verifyPassword } from "../crypto";
import { ApiError, baseHeaders, clientIp, hasControlCharacters, ok, rateLimitError, readJsonBody, v } from "../http";
import { exchangeOidcCode, oidcCallbackUrl, oidcDiscovery } from "../oidc";
import { bruteforceFail, bruteforceLocked, bruteforceClear, limits } from "../ratelimit";
import { disconnectSessionSockets } from "./relay";
import { finishLogin } from "./auth";

const secureCookies = new URL(PUBLIC_URL).protocol === "https:";
const flowCookieName = secureCookies ? "__Host-indirect-oidc" : "indirect-oidc";
const completeCookieName = secureCookies ? "__Host-indirect-oidc-login" : "indirect-oidc-login";
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
function readCookie(req: Request, name: string): string {
  const matches = (req.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : "";
}
function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
function redirect(location: string): Response {
  const headers = baseHeaders();
  headers.set("Location", location);
  return privateResponse(new Response(null, { status: 303, headers }));
}
function sameOriginCookieRequest(req: Request): void {
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(PUBLIC_URL).origin) || req.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "cross-origin sign-in completion is not allowed");
}

interface OidcFlow {
  state_hash: string; nonce: string; verifier: string; cookie_hash: string; redirect_path: string;
  link_user_id: string | null; link_session_jti: string | null; config_version: number; expires_at: number;
}

function assertCurrentActor(ctx: AuthContext): UserRow {
  const user = stmts.userById.get(ctx.user.id);
  const session = stmts.sessionByJti.get(ctx.session.jti);
  const now = Date.now();
  if (!user || user.status !== "active" || !session || session.revoked || session.expires_at <= now || session.abs_expires_at <= now || user.password_hash !== ctx.user.password_hash || user.totp_secret !== ctx.user.totp_secret) throw new ApiError(401, "account changed; sign in again");
  assertSessionPolicy(user, session);
  return user;
}

async function stepUp(ctx: AuthContext, body: Record<string, unknown>): Promise<() => void> {
  const scope = `identity-proof:${ctx.user.id}`;
  const locked = bruteforceLocked(scope);
  if (locked) throw new ApiError(429, `too many attempts; retry in ${locked}s`);
  let valid = true;
  if (ctx.user.password_hash) valid = await verifyPassword(v.str(body, "password", { min: 1, max: 256 })!, ctx.user.password_hash);
  else if (ctx.session.auth_method !== "oidc" || Date.now() - ctx.session.created_at > 5 * 60_000) throw new ApiError(401, "sign in with corporate identity again before changing the link");
  const code = ctx.user.totp_secret ? v.str(body, "code", { min: 6, max: 6 })! : "";
  if (ctx.user.totp_secret) valid = await totpVerify(ctx.user.totp_secret, code) && valid;
  if (!valid) { bruteforceFail(scope); throw new ApiError(401, "invalid account verification"); }
  bruteforceClear(scope);
  return () => { assertCurrentActor(ctx); if (ctx.user.totp_secret) consumeDurableTotp(ctx.user.totp_secret, code); };
}

function accountPolicyDto(userId: string) {
  const identity = db.query<{ issuer: string; subject: string }, [string]>("SELECT issuer,subject FROM corporate_identities WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(userId);
  return { ...accountAuthPolicy(userId), linked: !!identity, issuer: identity?.issuer ?? null, subject: identity?.subject ?? null };
}

async function startFlow(req: Request, ctx?: AuthContext, verify?: () => void): Promise<Response> {
  const config = corporateAuthConfig();
  if (!config.enabled) throw new ApiError(404, "corporate sign-in is not enabled");
  const discovery = await oidcDiscovery(config);
  const state = randomToken(32), nonce = randomToken(32), verifier = randomToken(32), browser = randomToken(32);
  const challenge = b64uEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const authorization = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: oidcCallbackUrl(), response_type: "code", scope: "openid", state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) authorization.searchParams.set(key, value);
  if (ctx) authorization.searchParams.set("prompt", "login");
  inImmediateTx(() => {
    if (corporateAuthConfig().version !== config.version) throw new ApiError(409, "corporate authentication changed; retry sign-in");
    verify?.();
    db.prepare("DELETE FROM oidc_flows WHERE state_hash IN (SELECT state_hash FROM oidc_flows WHERE expires_at < ? LIMIT 100)").run(Date.now());
    if (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oidc_flows").get()!.n >= 1000) throw new ApiError(429, "too many pending corporate sign-ins; retry shortly");
    db.prepare("INSERT INTO oidc_flows(state_hash,nonce,verifier,cookie_hash,redirect_path,link_user_id,link_session_jti,config_version,expires_at) VALUES (?,?,?,?,?,?,?,?,?)").run(sha256Hex(state), nonce, verifier, sha256Hex(browser), ctx ? "/settings" : "/login", ctx?.user.id ?? null, ctx?.session.jti ?? null, config.version, Date.now() + 300_000);
    if (ctx) audit("oidc.link.started", { actorId: ctx.user.id, target: ctx.user.id, ip: clientIp(req) });
  });
  const response = ctx ? ok({ authorizationUrl: authorization.href }, req) : redirect(authorization.href);
  response.headers.append("Set-Cookie", cookie(flowCookieName, browser, 300));
  return privateResponse(response);
}

/** Optional corporate identity and security policies. Local defaults need no configuration. */
export async function handleCorporateAuthRoute(path: string, req: Request): Promise<Response | null> {
  if (path === "/api/admin/corporate-auth") {
    const ctx = await requireAdmin(req);
    if (req.method === "GET") return privateResponse(ok({ config: corporateAuthDto(), readiness: corporateAuthReadiness() }, req));
    if (req.method !== "PUT") return null;
    const config = await prepareCorporateAuthConfig(await readJsonBody(req, LIMITS.authBodyBytes));
    if (config.enabled) await oidcDiscovery(config);
    inImmediateTx(() => {
      assertCurrentActor(ctx);
      assertCorporateAuthReady(config);
      saveCorporateAuthConfig(config);
      // The version check invalidates every old session and challenge atomically,
      // without a table-wide write or a long transaction on a busy installation.
      audit("corporate_auth.updated", { actorId: ctx.user.id, target: "installation", ip: clientIp(req), meta: { enabled: config.enabled, issuer: config.issuer, clientId: config.clientId, requireManagedSso: config.requireManagedSso, requireAdminMfa: config.requireAdminMfa, version: config.version } });
    });
    for (const user of db.query<{ id: string }, []>("SELECT id FROM users WHERE status='active'").all()) disconnectSessionSockets(user.id);
    return privateResponse(ok({ config: corporateAuthDto(config), readiness: corporateAuthReadiness(), signedOut: true }, req));
  }

  const userPolicy = path.match(/^\/api\/admin\/users\/([^/]+)\/corporate-auth$/);
  if (userPolicy) {
    const ctx = await requireAdmin(req);
    const user = stmts.userById.get(userPolicy[1]!);
    if (!user) throw new ApiError(404, "user not found");
    if (req.method === "GET") return privateResponse(ok({ policy: accountPolicyDto(user.id) }, req));
    if (req.method !== "PUT") return null;
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    if (Object.keys(body).some((key) => !["managed", "ssoExempt", "issuer", "subject"].includes(key))) throw new ApiError(400, "unknown corporate account policy field");
    for (const field of ["managed", "ssoExempt"]) if (field in body && typeof body[field] !== "boolean") throw new ApiError(400, `${field} must be a boolean`);
    const config = corporateAuthConfig();
    if ("subject" in body && body.subject !== null && (typeof body.subject !== "string" || !body.subject || body.subject.length > 255 || hasControlCharacters(body.subject))) throw new ApiError(400, "subject must be the provider's exact subject (1-255 characters), or null to unlink");
    if ("issuer" in body && body.issuer !== config.issuer) throw new ApiError(400, "issuer must match the configured corporate issuer");
    inImmediateTx(() => {
      assertCurrentActor(ctx);
      const fresh = stmts.userById.get(user.id);
      if (!fresh) throw new ApiError(404, "user not found");
      const previous = accountAuthPolicy(user.id);
      const managed = typeof body.managed === "boolean" ? body.managed : previous.managed;
      const exempt = typeof body.ssoExempt === "boolean" ? body.ssoExempt : previous.ssoExempt;
      if (exempt && (fresh.role !== "admin" || fresh.status !== "active" || !fresh.password_hash || !fresh.totp_secret || recoveryCodesRemaining(fresh.id) === 0)) throw new ApiError(409, "only an active administrator with a password, authenticator, and recovery codes can be exempt from SSO");
      if (typeof body.subject === "string") {
        if (!config.enabled || body.issuer !== config.issuer) throw new ApiError(400, "set the configured issuer and subject together to link an identity");
        const conflict = db.query<{ user_id: string }, [string, string]>("SELECT user_id FROM corporate_identities WHERE issuer=? AND subject=?").get(config.issuer, body.subject);
        if (conflict && conflict.user_id !== user.id) throw new ApiError(409, "this corporate identity is already linked to another account");
        db.prepare("DELETE FROM corporate_identities WHERE user_id=?").run(user.id);
        db.prepare("INSERT INTO corporate_identities(issuer,subject,user_id,created_at) VALUES (?,?,?,?)").run(config.issuer, body.subject, user.id, Date.now());
      } else if (body.subject === null) db.prepare("DELETE FROM corporate_identities WHERE user_id=?").run(user.id);
      db.prepare("INSERT INTO corporate_account_policy(user_id,managed,sso_exempt) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET managed=excluded.managed,sso_exempt=excluded.sso_exempt").run(user.id, managed ? 1 : 0, exempt ? 1 : 0);
      if (config.requireManagedSso && managed && !exempt && !db.query("SELECT 1 FROM corporate_identities WHERE issuer=? AND user_id=?").get(config.issuer, user.id)) throw new ApiError(409, "link a corporate identity before requiring SSO for this account");
      assertCorporateAuthReady();
      markUserSessionsRevoked(user.id);
      audit("corporate_auth.user_updated", { actorId: ctx.user.id, target: user.id, ip: clientIp(req), meta: { managed, ssoExempt: exempt, identityChanged: "subject" in body } });
    });
    disconnectSessionSockets(user.id);
    return privateResponse(ok({ policy: accountPolicyDto(user.id), signedOut: ctx.user.id === user.id }, req));
  }

  if (path === "/api/me/security" && req.method === "GET") {
    const ctx = await requireAuth(req);
    return privateResponse(ok({ ...accountAuthPolicy(ctx.user.id), oidcLinked: !!db.query("SELECT 1 FROM corporate_identities WHERE user_id=?").get(ctx.user.id), requireAdminMfa: ctx.user.role === "admin" && corporateAuthConfig().requireAdminMfa, recoveryCodesRemaining: recoveryCodesRemaining(ctx.user.id) }, req));
  }
  if (path === "/api/me/security/recovery-codes" && req.method === "POST") {
    const ctx = await requireAuth(req);
    if (!ctx.user.totp_secret) throw new ApiError(409, "enroll an authenticator before generating recovery codes");
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const code = v.str(body, "code", { min: 6, max: 6 })!;
    const scope = `recovery-generate:${ctx.user.id}`;
    const locked = bruteforceLocked(scope);
    if (locked) return rateLimitError(`too many attempts; retry in ${locked}s`, locked, req);
    if (!/^\d{6}$/.test(code) || !await totpVerify(ctx.user.totp_secret, code)) { bruteforceFail(scope); throw new ApiError(401, "invalid authenticator code"); }
    const codes = Array.from({ length: 10 }, () => randomToken(10).match(/.{4}/g)!.join("-"));
    inImmediateTx(() => {
      assertCurrentActor(ctx);
      consumeDurableTotp(ctx.user.totp_secret!, code);
      db.prepare("DELETE FROM auth_recovery_codes WHERE user_id=?").run(ctx.user.id);
      for (const recovery of codes) db.prepare("INSERT INTO auth_recovery_codes(user_id,code_hash,created_at) VALUES (?,?,?)").run(ctx.user.id, recoveryCodeHash(ctx.user.id, recovery), Date.now());
      markUserSessionsRevoked(ctx.user.id, ctx.session.jti);
      db.prepare("UPDATE sessions SET mfa_verified=1 WHERE jti=?").run(ctx.session.jti);
      audit("auth.recovery.generated", { actorId: ctx.user.id, target: ctx.user.id, ip: clientIp(req), meta: { count: codes.length } });
    });
    bruteforceClear(scope);
    disconnectSessionSockets(ctx.user.id, { exceptJti: ctx.session.jti });
    return privateResponse(ok({ codes }, req));
  }
  if (path === "/api/me/oidc/link" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const proof = await stepUp(ctx, await readJsonBody(req, LIMITS.authBodyBytes));
    return startFlow(req, ctx, proof);
  }
  if (path === "/api/me/oidc/link" && req.method === "DELETE") {
    const ctx = await requireAuth(req);
    const proof = await stepUp(ctx, await readJsonBody(req, LIMITS.authBodyBytes));
    if (requiresSso(ctx.user)) throw new ApiError(409, "an administrator must remove the managed SSO requirement before unlinking");
    if (!ctx.user.password_hash && !ctx.user.google_id) throw new ApiError(409, "set another sign-in method before unlinking corporate identity");
    inImmediateTx(() => {
      proof();
      if (requiresSso(stmts.userById.get(ctx.user.id)!)) throw new ApiError(409, "corporate identity is required");
      db.prepare("DELETE FROM corporate_identities WHERE user_id=?").run(ctx.user.id);
      markUserSessionsRevoked(ctx.user.id);
      audit("oidc.unlinked", { actorId: ctx.user.id, target: ctx.user.id, ip: clientIp(req) });
    });
    disconnectSessionSockets(ctx.user.id);
    return privateResponse(ok({ linked: false, signedOut: true }, req));
  }

  if (!path.startsWith("/api/auth/oidc/")) return null;
  const retry = limits.authPerMin(clientIp(req));
  if (retry) return rateLimitError(`too many attempts; retry in ${retry}s`, retry, req);
  if (path === "/api/auth/oidc/start" && req.method === "GET") {
    // Destinations are fixed by the server; never reflect a redirect supplied by a caller.
    if (new URL(req.url).search) throw new ApiError(400, "corporate sign-in does not accept redirect parameters");
    return startFlow(req);
  }
  if (path === "/api/auth/oidc/callback" && req.method === "GET") {
    const params = new URL(req.url).searchParams;
    for (const field of ["state", "code", "iss", "error"]) if (params.getAll(field).length > 1) throw new ApiError(400, "duplicate OIDC callback parameter");
    const state = params.get("state") ?? "", browser = readCookie(req, flowCookieName);
    if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browser)) throw new ApiError(401, "invalid corporate sign-in state");
    const config = corporateAuthConfig();
    const flow = inImmediateTx(() => db.query<OidcFlow, [string, string, number, number]>("DELETE FROM oidc_flows WHERE state_hash=? AND cookie_hash=? AND config_version=? AND expires_at>? RETURNING *").get(sha256Hex(state), sha256Hex(browser), config.version, Date.now()));
    if (!flow || !config.enabled) throw new ApiError(401, "corporate sign-in state expired or was already used");
    if (params.has("error")) throw new ApiError(401, "corporate authorization was declined");
    if (params.has("iss") && params.get("iss") !== config.issuer) throw new ApiError(401, "corporate authorization issuer mismatch");
    const code = params.get("code");
    if (!code || code.length > 4096 || hasControlCharacters(code)) throw new ApiError(400, "invalid authorization code");
    const identity = await exchangeOidcCode(config, code, flow.verifier, flow.nonce);
    if (corporateAuthConfig().version !== config.version) throw new ApiError(401, "corporate authentication changed during sign-in");
    if (flow.link_user_id) {
      inImmediateTx(() => {
        const user = stmts.userById.get(flow.link_user_id!);
        const session = flow.link_session_jti ? stmts.sessionByJti.get(flow.link_session_jti) : undefined;
        if (!user || user.status !== "active" || !session || session.user_id !== user.id || session.revoked || session.expires_at <= Date.now() || session.abs_expires_at <= Date.now()) throw new ApiError(401, "linking session expired; sign in again");
        assertSessionPolicy(user, session);
        const existing = db.query<{ user_id: string }, [string, string]>("SELECT user_id FROM corporate_identities WHERE issuer=? AND subject=?").get(identity.issuer, identity.subject);
        if (existing && existing.user_id !== user.id) throw new ApiError(409, "this corporate identity is already linked to another account");
        db.prepare("DELETE FROM corporate_identities WHERE user_id=?").run(user.id);
        db.prepare("INSERT INTO corporate_identities(issuer,subject,user_id,created_at) VALUES (?,?,?,?)").run(identity.issuer, identity.subject, user.id, Date.now());
        markUserSessionsRevoked(user.id, session.jti);
        audit("oidc.linked", { actorId: user.id, target: user.id, ip: clientIp(req), meta: { issuer: identity.issuer } });
      });
      disconnectSessionSockets(flow.link_user_id, { exceptJti: flow.link_session_jti! });
      const response = redirect(`${PUBLIC_URL}/?oidc=linked#/settings`);
      response.headers.append("Set-Cookie", cookie(flowCookieName, "", 0));
      return response;
    }
    const linked = db.query<{ user_id: string }, [string, string]>("SELECT user_id FROM corporate_identities WHERE issuer=? AND subject=?").get(identity.issuer, identity.subject);
    if (!linked) throw new ApiError(403, "corporate identity is not linked; ask an administrator to link the exact issuer and subject");
    const owner = stmts.userById.get(linked.user_id);
    if (!owner) throw new ApiError(401, "account unavailable");
    const temp = await issue2faTempToken(owner, "oidc", identity, config.version);
    const response = redirect(`${PUBLIC_URL}/?oidc=complete#/login`);
    response.headers.append("Set-Cookie", cookie(flowCookieName, "", 0));
    response.headers.append("Set-Cookie", cookie(completeCookieName, temp, LIMITS.twoFaTempTtlSec));
    return response;
  }
  if (path === "/api/auth/oidc/complete" && req.method === "POST") {
    sameOriginCookieRequest(req);
    await readJsonBody(req, LIMITS.authBodyBytes);
    const token = readCookie(req, completeCookieName);
    if (!token || token.length > 4096) throw new ApiError(401, "corporate sign-in is missing or expired");
    const challenge = await verify2faTempToken(token);
    if (challenge.authMethod !== "oidc") throw new ApiError(401, "invalid corporate sign-in challenge");
    const user = stmts.userById.get(challenge.userId);
    if (!user || user.status !== "active") throw new ApiError(401, "account unavailable");
    assertLoginMethodAllowed(user, "oidc");
    const response = user.totp_secret ? ok({ needs2FA: true, tempToken: token }, req) : await finishLogin(user, req, undefined, "login.success.oidc", undefined, { authMethod: "oidc", challengeId: challenge.id, policyVersion: challenge.policyVersion });
    response.headers.append("Set-Cookie", cookie(completeCookieName, "", 0));
    return privateResponse(response);
  }
  return null;
}
