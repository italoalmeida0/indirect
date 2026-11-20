import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { totpAt } from "../server/crypto";
import { createUser, login, request, startGateway, testPassword } from "./gateway-enterprise-fixture";
import { beginOidc, finishOidc, startMockOidc } from "./oidc-fixture";
import { attachGuBridge } from "../web/src/indirect-code/components/generative-ui/bridge";

const baseEnv = {
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  GOOGLE_CLIENT_ID: "",
  OIDC_ALLOW_HTTP_LOOPBACK: "true",
};

function decodeJwtJti(token: string): string {
  return (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { jti: string }).jti;
}

test("4.1 2FA initial setup and disable enforce step-up and block passwordless replacement bypass", async () => {
  const gw = await startGateway(baseEnv);
  const sql = new Database(path.join(gw.dir, "gateway.db"));
  try {
    const admin = await login(gw.base, "admin@enterprise.test");
    const u = await createUser(gw.base, admin.accessToken, "mfa-stepup@enterprise.test");

    // Initial 2FA setup requires currentPassword for passworded accounts.
    const noPwSetup = await request(gw.base, "/api/me/2fa/setup", { token: u.accessToken, body: {} });
    expect(noPwSetup.response.status).toBe(403);
    const badPwSetup = await request(gw.base, "/api/me/2fa/setup", {
      token: u.accessToken,
      body: { currentPassword: "wrong-password" },
    });
    expect(badPwSetup.response.status).toBe(401);

    const s1 = await request(gw.base, "/api/me/2fa/setup", {
      token: u.accessToken,
      body: { currentPassword: testPassword },
    });
    expect(s1.response.status).toBe(200);
    const secret1 = s1.data.secret as string;
    const e1 = await request(gw.base, "/api/me/2fa/enable", {
      token: u.accessToken,
      body: { code: await totpAt(secret1, Date.now() - 30_000) },
    });
    expect(e1.response.status).toBe(200);

    // Direct replacement without currentPassword + currentCode is blocked (403).
    const blockedReplace = await request(gw.base, "/api/me/2fa/setup", { token: u.accessToken, body: {} });
    expect(blockedReplace.response.status).toBe(403);

    // Disable with TOTP code only (no currentPassword) is rejected (400).
    const disableNoPw = await request(gw.base, "/api/me/2fa/disable", {
      token: u.accessToken,
      body: { code: await totpAt(secret1, Date.now()) },
    });
    expect(disableNoPw.response.status).toBe(400);

    // Disable with wrong password + valid TOTP is rejected (401).
    const disableBadPw = await request(gw.base, "/api/me/2fa/disable", {
      token: u.accessToken,
      body: { code: await totpAt(secret1, Date.now()), currentPassword: "wrong-password" },
    });
    expect(disableBadPw.response.status).toBe(401);

    // Disable with valid currentPassword + valid TOTP succeeds.
    const disableOk = await request(gw.base, "/api/me/2fa/disable", {
      token: u.accessToken,
      body: { code: await totpAt(secret1, Date.now() + 30_000), currentPassword: testPassword },
    });
    expect(disableOk.response.status).toBe(200);

    // Passwordless account: stale (>5m) session cannot start 2FA setup or disable 2FA.
    const pwless = await createUser(gw.base, admin.accessToken, "mfa-pwless@enterprise.test");
    const jti = decodeJwtJti(pwless.accessToken);
    sql.prepare("UPDATE users SET password_hash = NULL WHERE id = ?").run(pwless.user.id);
    sql.prepare("UPDATE sessions SET created_at = ? WHERE jti = ?").run(Date.now() - 10 * 60_000, jti);

    const staleSetup = await request(gw.base, "/api/me/2fa/setup", { token: pwless.accessToken, body: {} });
    expect(staleSetup.response.status).toBe(401);

    // Fresh (<=5m) passwordless session can set up, enable, and disable 2FA with TOTP.
    sql.prepare("UPDATE sessions SET created_at = ? WHERE jti = ?").run(Date.now(), jti);
    const freshSetup = await request(gw.base, "/api/me/2fa/setup", { token: pwless.accessToken, body: {} });
    expect(freshSetup.response.status).toBe(200);
    const pwlessSecret = freshSetup.data.secret as string;
    const freshEnable = await request(gw.base, "/api/me/2fa/enable", {
      token: pwless.accessToken,
      body: { code: await totpAt(pwlessSecret, Date.now() - 30_000) },
    });
    expect(freshEnable.response.status).toBe(200);

    // Aging the session blocks passwordless 2FA disable even with a valid TOTP code.
    sql.prepare("UPDATE sessions SET created_at = ? WHERE jti = ?").run(Date.now() - 10 * 60_000, jti);
    const staleDisable = await request(gw.base, "/api/me/2fa/disable", {
      token: pwless.accessToken,
      body: { code: await totpAt(pwlessSecret, Date.now()) },
    });
    expect(staleDisable.response.status).toBe(401);

    // Fresh passwordless session with valid TOTP disables 2FA.
    sql.prepare("UPDATE sessions SET created_at = ? WHERE jti = ?").run(Date.now(), jti);
    const freshDisable = await request(gw.base, "/api/me/2fa/disable", {
      token: pwless.accessToken,
      body: { code: await totpAt(pwlessSecret, Date.now() + 30_000) },
    });
    expect(freshDisable.response.status).toBe(200);
  } finally {
    sql.close();
    await gw.stop();
  }
}, 30_000);

test("4.2 password change/creation and Google link/unlink enforce TOTP and fresh-session step-up", async () => {
  const gw = await startGateway(baseEnv);
  const sql = new Database(path.join(gw.dir, "gateway.db"));
  try {
    const admin = await login(gw.base, "admin@enterprise.test");

    // 1. Passworded user with 2FA enabled cannot change password without TOTP.
    const uMfa = await createUser(gw.base, admin.accessToken, "pw-mfa-stepup@enterprise.test");
    const setup = await request(gw.base, "/api/me/2fa/setup", {
      token: uMfa.accessToken,
      body: { currentPassword: testPassword },
    });
    expect(setup.response.status).toBe(200);
    const secret = setup.data.secret as string;
    expect(
      (
        await request(gw.base, "/api/me/2fa/enable", {
          token: uMfa.accessToken,
          body: { code: await totpAt(secret, Date.now() - 30_000) },
        })
      ).response.status,
    ).toBe(200);

    const pwNoTotp = await request(gw.base, "/api/me/password", {
      token: uMfa.accessToken,
      body: { currentPassword: testPassword, newPassword: "new-password-without-totp" },
    });
    expect(pwNoTotp.response.status).toBe(400);

    const pwBadTotp = await request(gw.base, "/api/me/password", {
      token: uMfa.accessToken,
      body: { currentPassword: testPassword, newPassword: "new-password-bad-totp", totpCode: "000000" },
    });
    expect(pwBadTotp.response.status).toBe(401);

    const validCode = await totpAt(secret, Date.now());
    const pwWithTotp = await request(gw.base, "/api/me/password", {
      token: uMfa.accessToken,
      body: { currentPassword: testPassword, newPassword: "new-password-with-totp-123", totpCode: validCode },
    });
    expect(pwWithTotp.response.status).toBe(200);

    // Replaying the same TOTP code fails.
    const pwReplay = await request(gw.base, "/api/me/password", {
      token: uMfa.accessToken,
      body: {
        currentPassword: "new-password-with-totp-123",
        newPassword: "another-password-replay-123",
        totpCode: validCode,
      },
    });
    expect(pwReplay.response.status).toBe(401);

    // 2. Passwordless user with aged session cannot set a local password.
    const uNoPw = await createUser(gw.base, admin.accessToken, "pwless-setpw@enterprise.test");
    const noPwJti = decodeJwtJti(uNoPw.accessToken);
    sql.prepare("UPDATE users SET password_hash = NULL WHERE id = ?").run(uNoPw.user.id);
    sql.prepare("UPDATE sessions SET created_at = ? WHERE jti = ?").run(Date.now() - 20 * 60_000, noPwJti);

    const staleSetPw = await request(gw.base, "/api/me/password", {
      token: uNoPw.accessToken,
      body: { newPassword: "backdoor-local-password-123" },
    });
    expect(staleSetPw.response.status).toBe(401);

    // Fresh passwordless session can set a local password.
    sql.prepare("UPDATE sessions SET created_at = ? WHERE jti = ?").run(Date.now(), noPwJti);
    const freshSetPw = await request(gw.base, "/api/me/password", {
      token: uNoPw.accessToken,
      body: { newPassword: "legit-initial-password-123" },
    });
    expect(freshSetPw.response.status).toBe(200);

    // 3. POST /api/me/google/link and DELETE /api/me/google/link enforce step-up.
    const gUser = await createUser(gw.base, admin.accessToken, "google-stepup@enterprise.test");
    const gSetup = await request(gw.base, "/api/me/2fa/setup", {
      token: gUser.accessToken,
      body: { currentPassword: testPassword },
    });
    const gSecret = gSetup.data.secret as string;
    expect(
      (
        await request(gw.base, "/api/me/2fa/enable", {
          token: gUser.accessToken,
          body: { code: await totpAt(gSecret, Date.now() - 30_000) },
        })
      ).response.status,
    ).toBe(200);

    // POST /api/me/google/link rejects missing password (400) and missing TOTP (400) before touching Google verifier.
    const gLinkNoPw = await request(gw.base, "/api/me/google/link", {
      token: gUser.accessToken,
      body: { idToken: "x".repeat(32) },
    });
    expect(gLinkNoPw.response.status).toBe(400);

    const gLinkNoTotp = await request(gw.base, "/api/me/google/link", {
      token: gUser.accessToken,
      body: { idToken: "x".repeat(32), currentPassword: testPassword },
    });
    expect(gLinkNoTotp.response.status).toBe(400);

    const gLinkBadPw = await request(gw.base, "/api/me/google/link", {
      token: gUser.accessToken,
      body: {
        idToken: "x".repeat(32),
        currentPassword: "wrong-password",
        code: await totpAt(gSecret, Date.now()),
      },
    });
    expect(gLinkBadPw.response.status).toBe(401);

    // Simulate linked Google identity to test DELETE /api/me/google/link step-up.
    sql.prepare("UPDATE users SET google_id = ? WHERE id = ?").run("google-sub-stepup-1", gUser.user.id);

    const gUnlinkNoBody = await request(gw.base, "/api/me/google/link", {
      token: gUser.accessToken,
      method: "DELETE",
    });
    expect(gUnlinkNoBody.response.status).toBe(400);

    const gUnlinkNoTotp = await request(gw.base, "/api/me/google/link", {
      token: gUser.accessToken,
      method: "DELETE",
      body: { currentPassword: testPassword },
    });
    expect(gUnlinkNoTotp.response.status).toBe(400);

    const gUnlinkBadPw = await request(gw.base, "/api/me/google/link", {
      token: gUser.accessToken,
      method: "DELETE",
      body: { currentPassword: "wrong-password", code: await totpAt(gSecret, Date.now()) },
    });
    expect(gUnlinkBadPw.response.status).toBe(401);

    const gUnlinkOk = await request(gw.base, "/api/me/google/link", {
      token: gUser.accessToken,
      method: "DELETE",
      body: { currentPassword: testPassword, code: await totpAt(gSecret, Date.now() + 30_000) },
    });
    expect(gUnlinkOk.response.status).toBe(200);
    const afterUnlink = sql
      .query<{ google_id: string | null }, [string]>("SELECT google_id FROM users WHERE id = ?")
      .get(gUser.user.id);
    expect(afterUnlink?.google_id).toBeNull();
  } finally {
    sql.close();
    await gw.stop();
  }
}, 30_000);

test("4.3 refresh token rotation preserves original session created_at and does not reset OIDC step-up window", async () => {
  const idp = await startMockOidc("ES256");
  const gw = await startGateway(baseEnv);
  const sql = new Database(path.join(gw.dir, "gateway.db"));
  try {
    let admin = await login(gw.base, "admin@enterprise.test");
    const u = await createUser(gw.base, admin.accessToken, "oidc-refresh-fixed@enterprise.test");
    expect(
      (
        await request(gw.base, "/api/admin/corporate-auth", {
          token: admin.accessToken,
          method: "PUT",
          body: { enabled: true, issuer: idp.issuer, clientId: "indirect-test" },
        })
      ).response.status,
    ).toBe(200);
    admin = await login(gw.base, "admin@enterprise.test");
    expect(
      (
        await request(gw.base, `/api/admin/users/${u.user.id}/corporate-auth`, {
          token: admin.accessToken,
          method: "PUT",
          body: { issuer: idp.issuer, subject: "sub-oidc-refresh-fixed" },
        })
      ).response.status,
    ).toBe(200);
    sql.prepare("UPDATE users SET password_hash = NULL WHERE id = ?").run(u.user.id);

    idp.identity("sub-oidc-refresh-fixed");
    const oidcLogin = await finishOidc(gw.base, await beginOidc(gw.base));
    expect(oidcLogin.response.status).toBe(200);

    const oldJti = decodeJwtJti(oidcLogin.data.accessToken as string);
    const originalCreatedAt = Date.now() - 15 * 60_000;
    sql.prepare("UPDATE sessions SET created_at = ? WHERE jti = ?").run(originalCreatedAt, oldJti);

    // Aged session fails step-up before refresh.
    const agedTry = await request(gw.base, "/api/me/oidc/link", {
      token: oidcLogin.data.accessToken,
      body: {},
    });
    expect(agedTry.response.status).toBe(401);

    // Refresh succeeds, rotates token, and preserves original created_at while updating last_used_at.
    const ref = await request(gw.base, "/api/auth/refresh", {
      body: { refreshToken: oidcLogin.data.refreshToken },
    });
    expect(ref.response.status).toBe(200);
    const newJti = decodeJwtJti(ref.data.accessToken as string);
    const newRow = sql
      .query<{ created_at: number; last_used_at: number }, [string]>(
        "SELECT created_at, last_used_at FROM sessions WHERE jti = ?",
      )
      .get(newJti);
    expect(newRow?.created_at).toBe(originalCreatedAt);
    expect(newRow!.last_used_at).toBeGreaterThan(originalCreatedAt);

    // Rotated session STILL fails step-up on both /api/me/oidc/link and /api/me/password.
    const postRefreshOidc = await request(gw.base, "/api/me/oidc/link", {
      token: ref.data.accessToken,
      body: {},
    });
    expect(postRefreshOidc.response.status).toBe(401);

    const postRefreshPw = await request(gw.base, "/api/me/password", {
      token: ref.data.accessToken,
      body: { newPassword: "should-not-succeed-after-refresh" },
    });
    expect(postRefreshPw.response.status).toBe(401);
  } finally {
    sql.close();
    await gw.stop();
    await idp.stop();
  }
}, 30_000);

test("4.4 reset-2fa and 2fa/disable clear sso_exempt and requiresSso enforces MFA+recovery codes defense-in-depth", async () => {
  const idp = await startMockOidc("ES256");
  const gw = await startGateway(baseEnv);
  const sql = new Database(path.join(gw.dir, "gateway.db"));
  try {
    let admin1 = await login(gw.base, "admin@enterprise.test");
    const admin2 = await createUser(gw.base, admin1.accessToken, "admin2-sso@enterprise.test");
    const admin3 = await createUser(gw.base, admin1.accessToken, "admin3-sso@enterprise.test");
    expect(
      (
        await request(gw.base, `/api/admin/users/${admin2.user.id}`, {
          token: admin1.accessToken,
          method: "PATCH",
          body: { role: "admin" },
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(gw.base, `/api/admin/users/${admin3.user.id}`, {
          token: admin1.accessToken,
          method: "PATCH",
          body: { role: "admin" },
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(gw.base, "/api/admin/corporate-auth", {
          token: admin1.accessToken,
          method: "PUT",
          body: { enabled: true, issuer: idp.issuer, clientId: "indirect-test" },
        })
      ).response.status,
    ).toBe(200);

    admin1 = await login(gw.base, "admin@enterprise.test");
    const admin2Fresh = await login(gw.base, "admin2-sso@enterprise.test");
    const admin3Fresh = await login(gw.base, "admin3-sso@enterprise.test");

    // Enroll TOTP + recovery codes + ssoExempt on admin2 & admin3.
    const s2 = await request(gw.base, "/api/me/2fa/setup", {
      token: admin2Fresh.accessToken,
      body: { currentPassword: testPassword },
    });
    expect(
      (
        await request(gw.base, "/api/me/2fa/enable", {
          token: admin2Fresh.accessToken,
          body: { code: await totpAt(s2.data.secret, Date.now() - 30_000) },
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(gw.base, "/api/me/security/recovery-codes", {
          token: admin2Fresh.accessToken,
          body: { code: await totpAt(s2.data.secret, Date.now()) },
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(gw.base, `/api/admin/users/${admin2.user.id}/corporate-auth`, {
          token: admin1.accessToken,
          method: "PUT",
          body: { issuer: idp.issuer, subject: "admin2-sub", managed: true, ssoExempt: true },
        })
      ).response.status,
    ).toBe(200);

    const s3 = await request(gw.base, "/api/me/2fa/setup", {
      token: admin3Fresh.accessToken,
      body: { currentPassword: testPassword },
    });
    const secret3 = s3.data.secret as string;
    expect(
      (
        await request(gw.base, "/api/me/2fa/enable", {
          token: admin3Fresh.accessToken,
          body: { code: await totpAt(secret3, Date.now() - 30_000) },
        })
      ).response.status,
    ).toBe(200);
    const rec3 = await request(gw.base, "/api/me/security/recovery-codes", {
      token: admin3Fresh.accessToken,
      body: { code: await totpAt(secret3, Date.now()) },
    });
    expect(rec3.response.status).toBe(200);
    expect(
      (
        await request(gw.base, `/api/admin/users/${admin3.user.id}/corporate-auth`, {
          token: admin1.accessToken,
          method: "PUT",
          body: { issuer: idp.issuer, subject: "admin3-sub", managed: true, ssoExempt: true },
        })
      ).response.status,
    ).toBe(200);

    // Enroll TOTP + recovery codes + ssoExempt on admin1 and enforce requireManagedSso (requireAdminMfa=false).
    const s1 = await request(gw.base, "/api/me/2fa/setup", {
      token: admin1.accessToken,
      body: { currentPassword: testPassword },
    });
    expect(
      (
        await request(gw.base, "/api/me/2fa/enable", {
          token: admin1.accessToken,
          body: { code: await totpAt(s1.data.secret, Date.now() - 30_000) },
        })
      ).response.status,
    ).toBe(200);
    const rec1 = await request(gw.base, "/api/me/security/recovery-codes", {
      token: admin1.accessToken,
      body: { code: await totpAt(s1.data.secret, Date.now()) },
    });
    const admin1Codes = rec1.data.codes as string[];
    expect(
      (
        await request(gw.base, `/api/admin/users/${admin1.user.id}/corporate-auth`, {
          token: admin1.accessToken,
          method: "PUT",
          body: { ssoExempt: true },
        })
      ).response.status,
    ).toBe(200);

    const p1 = await request(gw.base, "/api/auth/login", {
      body: { email: "admin@enterprise.test", password: testPassword },
    });
    const m1 = await request(gw.base, "/api/auth/2fa", {
      body: { tempToken: p1.data.tempToken, code: admin1Codes[0] },
    });
    expect(m1.response.status).toBe(200);
    admin1 = m1.data;

    expect(
      (
        await request(gw.base, "/api/admin/corporate-auth", {
          token: admin1.accessToken,
          method: "PUT",
          body: { requireManagedSso: true, requireAdminMfa: false },
        })
      ).response.status,
    ).toBe(200);
    const p1b = await request(gw.base, "/api/auth/login", {
      body: { email: "admin@enterprise.test", password: testPassword },
    });
    const m1b = await request(gw.base, "/api/auth/2fa", {
      body: { tempToken: p1b.data.tempToken, code: admin1Codes[1] },
    });
    expect(m1b.response.status).toBe(200);
    admin1 = m1b.data;

    // 1. Admin reset-2fa on admin2 clears sso_exempt and blocks password-only login.
    const resetRes = await request(gw.base, `/api/admin/users/${admin2.user.id}/reset-2fa`, {
      token: admin1.accessToken,
      body: {},
    });
    expect(resetRes.response.status).toBe(200);
    const exemptRow2 = sql
      .query<{ sso_exempt: number }, [string]>("SELECT sso_exempt FROM corporate_account_policy WHERE user_id = ?")
      .get(admin2.user.id);
    expect(exemptRow2?.sso_exempt).toBe(0);
    const pwLogin2 = await request(gw.base, "/api/auth/login", {
      body: { email: "admin2-sso@enterprise.test", password: testPassword },
    });
    expect(pwLogin2.response.status).toBe(403);
    expect(pwLogin2.data.code).toBe("sso_required");

    // 2. Self-service 2fa/disable on admin3 clears sso_exempt and blocks password-only login.
    const p3 = await request(gw.base, "/api/auth/login", {
      body: { email: "admin3-sso@enterprise.test", password: testPassword },
    });
    const m3 = await request(gw.base, "/api/auth/2fa", {
      body: { tempToken: p3.data.tempToken, code: (rec3.data.codes as string[])[0] },
    });
    expect(m3.response.status).toBe(200);
    const disable3 = await request(gw.base, "/api/me/2fa/disable", {
      token: m3.data.accessToken,
      body: { currentPassword: testPassword, code: await totpAt(secret3, Date.now() + 30_000) },
    });
    expect(disable3.response.status).toBe(200);
    const exemptRow3 = sql
      .query<{ sso_exempt: number }, [string]>("SELECT sso_exempt FROM corporate_account_policy WHERE user_id = ?")
      .get(admin3.user.id);
    expect(exemptRow3?.sso_exempt).toBe(0);
    const pwLogin3 = await request(gw.base, "/api/auth/login", {
      body: { email: "admin3-sso@enterprise.test", password: testPassword },
    });
    expect(pwLogin3.response.status).toBe(403);
    expect(pwLogin3.data.code).toBe("sso_required");

    // 3. Defense-in-depth: even if DB manually sets sso_exempt = 1 without TOTP/recovery codes, SSO is still required.
    sql.prepare("UPDATE corporate_account_policy SET sso_exempt = 1 WHERE user_id = ?").run(admin2.user.id);
    const defenseInDepthLogin = await request(gw.base, "/api/auth/login", {
      body: { email: "admin2-sso@enterprise.test", password: testPassword },
    });
    expect(defenseInDepthLogin.response.status).toBe(403);
    expect(defenseInDepthLogin.data.code).toBe("sso_required");
  } finally {
    sql.close();
    await gw.stop();
    await idp.stop();
  }
}, 45_000);

test("4.5 pending password_tokens are invalidated on password change, admin send-reset, and reset confirm", async () => {
  const gw = await startGateway(baseEnv);
  try {
    const admin = await login(gw.base, "admin@enterprise.test");
  const u = await createUser(gw.base, admin.accessToken, "stale-tokens@enterprise.test");

  // 1. /api/me/password invalidates prior unused reset token.
  const reset1 = await request(gw.base, `/api/admin/users/${u.user.id}/send-reset`, {
    token: admin.accessToken,
    body: {},
  });
  expect(reset1.response.status).toBe(200);
  const token1 = decodeURIComponent(String(reset1.data.link).split("token=")[1]!);

  const chg = await request(gw.base, "/api/me/password", {
    token: u.accessToken,
    body: { currentPassword: testPassword, newPassword: "rotated-password-999" },
  });
  expect(chg.response.status).toBe(200);

  const replay1 = await request(gw.base, "/api/auth/password-reset/confirm", {
    body: { token: token1, password: "reverted-password-888" },
  });
  expect(replay1.response.status).toBe(400);

  // 2. Second /send-reset invalidates the earlier unused reset token.
  const reset2 = await request(gw.base, `/api/admin/users/${u.user.id}/send-reset`, {
    token: admin.accessToken,
    body: {},
  });
  const token2 = decodeURIComponent(String(reset2.data.link).split("token=")[1]!);

  const reset3 = await request(gw.base, `/api/admin/users/${u.user.id}/send-reset`, {
    token: admin.accessToken,
    body: {},
  });
  const token3 = decodeURIComponent(String(reset3.data.link).split("token=")[1]!);

  const replay2 = await request(gw.base, "/api/auth/password-reset/confirm", {
    body: { token: token2, password: "stale-send-reset-123" },
  });
  expect(replay2.response.status).toBe(400);

  // 3. Confirming one pending token invalidates any other pending token (e.g. an unconsumed invite).
  const invited = await request(gw.base, "/api/admin/users", {
    token: admin.accessToken,
    body: { email: "invite-and-reset@enterprise.test", name: "Invite User", role: "user", sendInvite: true },
  });
  expect(invited.response.status).toBe(200);
  const inviteToken = decodeURIComponent(String(invited.data.invite.link).split("token=")[1]!);
  // Requesting a self-service reset creates a reset token alongside the invite token.
  const sql = new Database(path.join(gw.dir, "gateway.db"));
  try {
    expect(
      (
        await request(gw.base, "/api/auth/password-reset/request", {
          body: { email: "invite-and-reset@enterprise.test" },
        })
      ).response.status,
    ).toBe(200);
    const pendingBefore = sql
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM password_tokens WHERE user_id = ? AND used_at IS NULL")
      .get(invited.data.user.id)!.n;
    expect(pendingBefore).toBe(2);

    // Confirming the invite token wipes the other pending reset token too.
    expect(
      (
        await request(gw.base, "/api/auth/password-reset/confirm", {
          body: { token: inviteToken, password: "accepted-invite-pass-123" },
        })
      ).response.status,
    ).toBe(200);
    const pendingAfter = sql
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM password_tokens WHERE user_id = ? AND used_at IS NULL")
      .get(invited.data.user.id)!.n;
    expect(pendingAfter).toBe(0);
  } finally {
    sql.close();
  }

    // The latest valid token (token3) still works for u.
    const confirm3 = await request(gw.base, "/api/auth/password-reset/confirm", {
      body: { token: token3, password: "final-valid-reset-123" },
    });
    expect(confirm3.response.status).toBe(200);
  } finally {
    await gw.stop();
  }
}, 30_000);

test("5.1 attachGuBridge blocks slash commands and unconfirmed auto-send, falling back to prefillPrompt", () => {
  const listeners: Array<(e: MessageEvent) => void> = [];
  const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  (globalThis as any).window = {
    addEventListener: (type: string, fn: (e: MessageEvent) => void) => {
      if (type === "message") listeners.push(fn);
    },
    removeEventListener: (type: string, fn: (e: MessageEvent) => void) => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };
  try {
    const fakeFrame = {} as Window;
    const sent: string[] = [];
    const prefilled: string[] = [];
    let allowAutoSend = false;

    const detach = attachGuBridge(() => fakeFrame, {
      onSendPrompt: (text) => sent.push(text),
      onPrefillPrompt: (text) => prefilled.push(text),
      onOpenLink: () => {},
      onResize: () => {},
      canAutoSend: () => allowAutoSend,
    });

    const emit = (data: unknown) => {
      for (const fn of [...listeners]) fn({ source: fakeFrame, data } as MessageEvent);
    };

    // Mount-time auto-fire (canAutoSend=false) downgrades to prefill.
    emit({ __gu: "sendPrompt", text: "Summarize this repo" });
    expect(sent).toEqual([]);
    expect(prefilled).toEqual(["Summarize this repo"]);

    // Even when user has interacted (canAutoSend=true), slash commands NEVER auto-send.
    allowAutoSend = true;
    emit({ __gu: "sendPrompt", text: "/full" });
    emit({ __gu: "sendPrompt", text: "   /yolo now" });
    expect(sent).toEqual([]);
    expect(prefilled).toEqual(["Summarize this repo", "/full", "/yolo now"]);

    // Normal prompt after user interaction sends normally.
    emit({ __gu: "sendPrompt", text: "Explain step 2" });
    expect(sent).toEqual(["Explain step 2"]);

    detach();
    expect(listeners).toHaveLength(0);
  } finally {
    if (prevWindowDesc) Object.defineProperty(globalThis, "window", prevWindowDesc);
    else delete (globalThis as Record<string, unknown>).window;
  }
});

test("5.2 clearClientStorage purges llmgw-* and gu:state:* localStorage keys and signaldb-rc:* IndexedDB databases", async () => {
  const store = new Map<string, string>([
    ["llmgw-draft:host1:sess1", "secret draft"],
    ["llmgw-rc-session:host1", "sess1"],
    ["gu:state:host1:sess1:w1", "{\"token\":\"abc\"}"],
    ["unrelated-key", "keep-me"],
  ]);
  const deletedDbs: string[] = [];

  const prevLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const prevIndexedDBDesc = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  (globalThis as any).localStorage = {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  (globalThis as any).indexedDB = {
    databases: async () => [
      { name: "signaldb-rc:host1:sessions" },
      { name: "signaldb-rc:host1:projects" },
      { name: "other-app-db" },
    ],
    deleteDatabase: (name: string) => {
      deletedDbs.push(name);
      const req: any = {};
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };

  try {
    const { clearClientStorage } = await import("../web/src/api");
    await clearClientStorage();
    expect(Array.from(store.keys())).toEqual(["unrelated-key"]);
    expect(deletedDbs).toEqual(["signaldb-rc:host1:sessions", "signaldb-rc:host1:projects"]);
  } finally {
    if (prevLocalStorageDesc) Object.defineProperty(globalThis, "localStorage", prevLocalStorageDesc);
    else delete (globalThis as Record<string, unknown>).localStorage;
    if (prevIndexedDBDesc) Object.defineProperty(globalThis, "indexedDB", prevIndexedDBDesc);
    else delete (globalThis as Record<string, unknown>).indexedDB;
  }
});
