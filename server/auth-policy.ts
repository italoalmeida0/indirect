import { GATEWAY_SECRET, PUBLIC_URL } from "./config";
import { db, type SessionRow, type UserRow } from "./db";
import { encryptSecret, decryptSecret, sha256Hex } from "./crypto";
import { ApiError, hasControlCharacters } from "./http";

export type LoginMethod = "local" | "google" | "oidc";
export interface CorporateAuthConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecretEnc: string;
  requireManagedSso: boolean;
  requireAdminMfa: boolean;
  version: number;
}
const defaults: CorporateAuthConfig = {
  enabled: false, issuer: "", clientId: "", clientSecretEnc: "",
  requireManagedSso: false, requireAdminMfa: false, version: 0,
};
const configKey = "corporate_auth";

export function corporateAuthConfig(): CorporateAuthConfig {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(configKey);
  return row ? { ...defaults, ...JSON.parse(row.value) as CorporateAuthConfig } : { ...defaults };
}

export function corporateAuthDto(config = corporateAuthConfig()) {
  const { clientSecretEnc, ...safe } = config;
  return { ...safe, clientSecretSet: !!clientSecretEnc, callbackUrl: `${PUBLIC_URL}/api/auth/oidc/callback` };
}

export async function prepareCorporateAuthConfig(body: Record<string, unknown>): Promise<CorporateAuthConfig> {
  const previous = corporateAuthConfig();
  const result = { ...previous, version: previous.version + 1 };
  const allowed = new Set(["enabled", "issuer", "clientId", "clientSecret", "requireManagedSso", "requireAdminMfa"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new ApiError(400, `unknown field: ${key}`);
  for (const key of ["enabled", "requireManagedSso", "requireAdminMfa"] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== "boolean") throw new ApiError(400, `${key} must be a boolean`);
    result[key] = body[key];
  }
  for (const key of ["issuer", "clientId"] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== "string" || body[key].length > 2048 || hasControlCharacters(body[key])) throw new ApiError(400, `${key} must be a valid string`);
    result[key] = body[key].trim();
  }
  if ("clientSecret" in body) {
    if (typeof body.clientSecret !== "string" || body.clientSecret.length > 4096) throw new ApiError(400, "clientSecret must be a string of at most 4096 characters");
    result.clientSecretEnc = body.clientSecret ? await encryptSecret(body.clientSecret, GATEWAY_SECRET) : "";
  }
  if (result.enabled && (!result.issuer || !result.clientId)) throw new ApiError(400, "issuer and clientId are required to enable corporate sign-in");
  if (result.requireManagedSso && !result.enabled) throw new ApiError(400, "corporate sign-in must be enabled while managed SSO is required");
  return result;
}

export function saveCorporateAuthConfig(config: CorporateAuthConfig): void {
  if (corporateAuthConfig().version !== config.version - 1) throw new ApiError(409, "corporate authentication changed; reload before saving");
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(configKey, JSON.stringify(config));
}

export async function corporateClientSecret(config: CorporateAuthConfig): Promise<string> {
  return config.clientSecretEnc ? decryptSecret(config.clientSecretEnc, GATEWAY_SECRET) : "";
}

export function accountAuthPolicy(userId: string) {
  const row = db.query<{ managed: number; sso_exempt: number }, [string]>("SELECT managed,sso_exempt FROM corporate_account_policy WHERE user_id=?").get(userId);
  return { managed: !!row?.managed, ssoExempt: !!row?.sso_exempt };
}

export function requiresSso(user: UserRow, config = corporateAuthConfig()): boolean {
  const policy = accountAuthPolicy(user.id);
  return config.requireManagedSso && policy.managed && !(policy.ssoExempt && user.role === "admin");
}

export function assertLoginMethodAllowed(user: UserRow, method: LoginMethod): void {
  const config = corporateAuthConfig();
  if (requiresSso(user, config) && method !== "oidc") throw new ApiError(403, "corporate sign-in is required for this account", "sso_required");
  if (method === "oidc" && !config.enabled) throw new ApiError(401, "corporate sign-in is unavailable");
}

export function assertSessionPolicy(user: UserRow, session: Pick<SessionRow, "auth_method" | "mfa_verified" | "auth_policy_version">): void {
  if (session.auth_policy_version !== corporateAuthConfig().version) throw new ApiError(401, "security settings changed; sign in again");
  const method = session.auth_method as LoginMethod;
  assertLoginMethodAllowed(user, method);
  if (user.role === "admin" && corporateAuthConfig().requireAdminMfa && (!user.totp_secret || !session.mfa_verified)) {
    throw new ApiError(401, "administrator MFA is required; sign in again", "mfa_required");
  }
}

export function recoveryCodesRemaining(userId: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id=?").get(userId)!.n;
}

export function corporateAuthReadiness() {
  return db.query<{ localRecoveryAdmins: number; adminsWithoutMfa: number }, []>(`
    SELECT COALESCE(SUM(CASE WHEN u.password_hash IS NOT NULL AND u.totp_secret IS NOT NULL AND p.sso_exempt=1
      AND EXISTS(SELECT 1 FROM auth_recovery_codes r WHERE r.user_id=u.id) THEN 1 ELSE 0 END),0) AS localRecoveryAdmins,
      COALESCE(SUM(CASE WHEN u.totp_secret IS NULL THEN 1 ELSE 0 END),0) AS adminsWithoutMfa
    FROM users u LEFT JOIN corporate_account_policy p ON p.user_id=u.id WHERE u.role='admin' AND u.status='active'`).get()!;
}

/** Invoke inside the same transaction as a policy or account mutation. */
export function assertCorporateAuthReady(config = corporateAuthConfig()): void {
  const readiness = corporateAuthReadiness();
  if (config.requireAdminMfa && readiness.adminsWithoutMfa > 0) throw new ApiError(409, "all active administrators must enroll an authenticator before MFA can be required");
  if (config.requireManagedSso && readiness.localRecoveryAdmins === 0) throw new ApiError(409, "keep an active local recovery administrator with a password, authenticator, recovery codes, and explicit SSO exemption");
  if (config.requireManagedSso && db.query(`SELECT 1 FROM users u JOIN corporate_account_policy p ON p.user_id=u.id
    WHERE u.status='active' AND p.managed=1 AND p.sso_exempt=0 AND NOT EXISTS(SELECT 1 FROM corporate_identities i WHERE i.user_id=u.id AND i.issuer=?) LIMIT 1`).get(config.issuer)) throw new ApiError(409, "link every active managed account to the configured corporate issuer before requiring SSO");
}

/** Guard existing admin routes before demotion, disablement or deletion. */
export function assertAdminAccountMutationAllowed(userId: string, patch: { role?: string; status?: string; deleted?: boolean }): void {
  const user = db.query<UserRow, [string]>("SELECT * FROM users WHERE id=?").get(userId);
  const config = corporateAuthConfig();
  const staysActiveAdmin = !patch.deleted && (patch.role ?? user?.role) === "admin" && (patch.status ?? user?.status) === "active";
  if (staysActiveAdmin && config.requireAdminMfa && !user?.totp_secret) throw new ApiError(409, "enroll an authenticator before promoting or activating an administrator");
  if (!staysActiveAdmin && config.requireManagedSso && user?.role === "admin" && user.status === "active" && accountAuthPolicy(userId).ssoExempt && corporateAuthReadiness().localRecoveryAdmins <= 1) {
    throw new ApiError(409, "the last local recovery administrator cannot be removed");
  }
}

export function assertMfaCanDisable(user: UserRow): void {
  const config = corporateAuthConfig();
  if (user.role === "admin" && config.requireAdminMfa) throw new ApiError(409, "administrator MFA is required by policy");
  if (config.requireManagedSso && accountAuthPolicy(user.id).ssoExempt && corporateAuthReadiness().localRecoveryAdmins <= 1) throw new ApiError(409, "the last local recovery administrator must keep an authenticator");
}

export function recoveryCodeHash(userId: string, code: string): string {
  return sha256Hex(`auth-recovery:${userId}:${code.replace(/\s/g, "").toLowerCase()}`);
}

/** Record proof consumption in the caller's transaction; a restart cannot replay it. */
export function consumeDurableTotp(secret: string, code: string): void {
  const digest = sha256Hex(`totp:${secret}:${code}`);
  const used = db.prepare("INSERT OR IGNORE INTO auth_mfa_uses(digest,expires_at) VALUES (?,?)").run(digest, Date.now() + 120_000);
  if (used.changes !== 1) throw new ApiError(401, "this authenticator code was already used; wait for the next code");
}
