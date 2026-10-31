import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { totpAt } from "../server/crypto";
import { createUser, login, request, startGateway, testPassword, waitUntil } from "./gateway-enterprise-fixture";
import { beginOidc, finishOidc, responseCookies, startMockOidc } from "./oidc-fixture";

const noEmail = { SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", GOOGLE_CLIENT_ID: "", OIDC_ALLOW_HTTP_LOOPBACK: "true" };

test("OIDC verifies ES256 keys and rotation without confusing RSA, EC, HMAC or unsigned tokens", async () => {
  const idp = await startMockOidc("ES256");
  const gateway = await startGateway(noEmail);
  try {
    let admin = await login(gateway.base, "admin@enterprise.test");
    const employee = await createUser(gateway.base, admin.accessToken, "ec-oidc@enterprise.test");
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { enabled: true, issuer: idp.issuer, clientId: "indirect-test" } })).response.status).toBe(200);
    admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, `/api/admin/users/${employee.user.id}/corporate-auth`, { token: admin.accessToken, method: "PUT", body: { issuer: idp.issuer, subject: "employee-subject" } })).response.status).toBe(200);
    expect((await finishOidc(gateway.base, await beginOidc(gateway.base))).response.status).toBe(200);
    for (const algorithm of ["RS256", "HS256", "none"]) {
      idp.identity("employee-subject", {}, { algorithm });
      expect((await finishOidc(gateway.base, await beginOidc(gateway.base))).response.status).toBe(401);
    }
    idp.identity("employee-subject", {}, { badSignature: true });
    expect((await finishOidc(gateway.base, await beginOidc(gateway.base))).response.status).toBe(401);
    await idp.rotate(); idp.identity();
    expect((await finishOidc(gateway.base, await beginOidc(gateway.base))).response.status).toBe(200);
    await idp.rotate("RS256"); idp.identity();
    expect((await finishOidc(gateway.base, await beginOidc(gateway.base))).response.status).toBe(200);
  } finally { await gateway.stop(); await idp.stop(); }
}, 45_000);

test("OIDC uses browser-bound single-use state and PKCE, validates claims and rotating keys, and links only explicit subjects", async () => {
  const idp = await startMockOidc();
  const gateway = await startGateway(noEmail);
  try {
    let admin = await login(gateway.base, "admin@enterprise.test");
    const employee = await createUser(gateway.base, admin.accessToken, "oidc@enterprise.test");
    const other = await createUser(gateway.base, admin.accessToken, "oidc-other@enterprise.test");
    expect((await request(gateway.base, "/api/auth/config")).data.oidcEnabled).toBe(false);
    expect((await request(gateway.base, "/api/admin/corporate-auth")).response.status).toBe(401);
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: employee.accessToken })).response.status).toBe(403);
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { enabled: true, issuer: "http://untrusted.example", clientId: "indirect-test" } })).response.status).toBe(400);
    const configured = await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { enabled: true, issuer: idp.issuer, clientId: "indirect-test" } });
    expect(configured.response.status).toBe(200);
    expect(configured.data.signedOut).toBe(true);
    expect((await request(gateway.base, "/api/me", { token: admin.accessToken })).response.status).toBe(401);
    admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, `/api/admin/users/${employee.user.id}/corporate-auth`, { token: admin.accessToken, method: "PUT", body: { issuer: idp.issuer, subject: "employee-subject" } })).response.status).toBe(200);
    expect((await fetch(`${gateway.base}/api/auth/oidc/start?redirect=https://evil.example`, { redirect: "manual" })).status).toBe(400);

    const flow = await beginOidc(gateway.base);
    const authorization = new URL(flow.authorizationUrl);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("nonce")).toMatch(/^[a-f0-9]{64}$/);
    expect(authorization.searchParams.has("code_verifier")).toBe(false);
    expect((await fetch(flow.callback, { headers: { Cookie: "indirect-oidc=" + "0".repeat(64) }, redirect: "manual" })).status).toBe(401);
    const callback = await fetch(flow.callback, { headers: { Cookie: flow.flowCookie }, redirect: "manual" });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toContain("/?oidc=complete#/login");
    expect(callback.headers.get("location")).not.toContain("token");
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(flow.callback, { headers: { Cookie: flow.flowCookie }, redirect: "manual" })).status).toBe(401);
    const completeCookie = responseCookies(callback, "indirect-oidc-login=");
    expect((await request(gateway.base, "/api/auth/oidc/complete", { body: {}, headers: { Cookie: completeCookie, Origin: "https://evil.example" } })).response.status).toBe(403);
    const completed = await request(gateway.base, "/api/auth/oidc/complete", { body: {}, headers: { Cookie: completeCookie } });
    expect(completed.response.status).toBe(200);
    expect(completed.data.user.id).toBe(employee.user.id);
    expect((await request(gateway.base, "/api/auth/oidc/complete", { body: {}, headers: { Cookie: completeCookie } })).response.status).toBe(401);
    expect((await request(gateway.base, "/api/auth/refresh", { body: { refreshToken: completed.data.refreshToken } })).response.status).toBe(200);
    expect(idp.metrics.validPkce).toBe(1);

    const now = Math.floor(Date.now() / 1000);
    const invalid = [
      { claims: { aud: "another-client" } }, { claims: { iss: `${idp.issuer}/different` } },
      { claims: { nonce: "wrong-nonce" } }, { claims: { exp: now - 1 } },
      { claims: { iat: now + 600, exp: now + 900 } },
      { claims: { aud: ["indirect-test", "another-client"] } },
      { claims: { aud: "indirect-test", azp: "another-client" } },
      { claims: { sub: "" } }, { claims: { nbf: now + 600 } },
      { claims: { at_hash: "unmatched" } }, { claims: { c_hash: "unmatched" } },
      { claims: {}, badSignature: true }, { claims: {}, algorithm: "none" },
    ];
    for (const scenario of invalid) {
      idp.identity("employee-subject", scenario.claims, scenario);
      const rejected = await finishOidc(gateway.base, await beginOidc(gateway.base));
      expect(rejected.response.status).toBe(401);
      expect(rejected.data.accessToken).toBeUndefined();
    }
    idp.identity("unlinked-subject", { email: "oidc@enterprise.test", email_verified: true, name: "Admin", role: "admin" });
    expect((await finishOidc(gateway.base, await beginOidc(gateway.base))).response.status).toBe(403);
    const original = await request(gateway.base, `/api/admin/users/${employee.user.id}/corporate-auth`, { token: admin.accessToken });
    expect(original.data.policy.subject).toBe("employee-subject");

    idp.identity();
    await idp.rotate();
    const rotated = await finishOidc(gateway.base, await beginOidc(gateway.base));
    expect(rotated.response.status).toBe(200);
    expect(rotated.data.user.role).toBe("user");
    expect(idp.metrics.jwksRequests).toBeGreaterThanOrEqual(2);
    expect((await request(gateway.base, `/api/admin/users/${other.user.id}/corporate-auth`, { token: admin.accessToken, method: "PUT", body: { issuer: idp.issuer, subject: "employee-subject" } })).response.status).toBe(409);
    expect((await request(gateway.base, `/api/admin/users/${other.user.id}/corporate-auth`, { token: admin.accessToken })).data.policy.linked).toBe(false);

    const local = await login(gateway.base, "oidc@enterprise.test");
    expect((await request(gateway.base, "/api/me/oidc/link", { token: local.accessToken, body: { password: "invalid" } })).response.status).toBe(401);
    idp.identity("self-linked-subject");
    const link = await request(gateway.base, "/api/me/oidc/link", { token: local.accessToken, body: { password: testPassword } });
    expect(link.response.status).toBe(200);
    const authorized = await fetch(link.data.authorizationUrl, { redirect: "manual" });
    const target = new URL(authorized.headers.get("location")!);
    const linked = await fetch(`${gateway.base}${target.pathname}${target.search}`, { headers: { Cookie: responseCookies(link.response) }, redirect: "manual" });
    expect(linked.status).toBe(303);
    expect(linked.headers.get("location")).toContain("/?oidc=linked#/settings");
    expect((await request(gateway.base, "/api/me", { token: rotated.data.accessToken })).response.status).toBe(401);
    expect((await request(gateway.base, "/api/me/oidc/link", { token: local.accessToken, method: "DELETE", body: { password: testPassword } })).response.status).toBe(200);
    expect((await request(gateway.base, "/api/me", { token: local.accessToken })).response.status).toBe(401);
    expect((await request(gateway.base, `/api/admin/users/${employee.user.id}/corporate-auth`, { token: admin.accessToken })).data.policy.linked).toBe(false);
  } finally { await gateway.stop(); await idp.stop(); }
}, 60_000);

test("relay authentication and existing sockets enforce corporate policy versions", async () => {
  const gateway = await startGateway(noEmail);
  let ws: WebSocket | undefined;
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    ws = new WebSocket(`${gateway.base.replace(/^http/, "ws")}/api/indirect-code/ws?token=${encodeURIComponent(admin.accessToken)}`);
    await waitUntil(() => ws!.readyState === WebSocket.OPEN, "relay did not open");
    const sql = new Database(path.join(gateway.dir, "gateway.db"));
    try {
      // Represents a policy change made by another gateway process: there is
      // no local disconnect notification, so the relay must revalidate it.
      sql.prepare("INSERT INTO settings(key,value) VALUES('corporate_auth',?)").run(JSON.stringify({ enabled: false, issuer: "", clientId: "", clientSecretEnc: "", requireManagedSso: false, requireAdminMfa: false, version: 1 }));
    } finally { sql.close(); }
    ws.send(JSON.stringify({ type: "ping" }));
    await waitUntil(() => ws!.readyState === WebSocket.CLOSED, "stale security-policy socket remained open", 4000);
    const stale = await fetch(`${gateway.base}/api/indirect-code/ws`, { headers: { Authorization: `Bearer ${admin.accessToken}` } });
    expect(stale.status).toBe(401);
    const fresh = await login(gateway.base, "admin@enterprise.test");
    const valid = await fetch(`${gateway.base}/api/indirect-code/ws`, { headers: { Authorization: `Bearer ${fresh.accessToken}` } });
    expect(valid.status).toBe(400); // Reaches upgrade; plain HTTP is not a WebSocket.
  } finally { ws?.close(); await gateway.stop(); }
}, 30_000);

test("managed SSO and administrator MFA policies prevent bypass and lockout, revoke sessions, recover lost authenticators, and roll back audit faults", async () => {
  const idp = await startMockOidc();
  const gateway = await startGateway(noEmail);
  try {
    let admin = await login(gateway.base, "admin@enterprise.test");
    const employee = await createUser(gateway.base, admin.accessToken, "managed@enterprise.test");
    const reset = await request(gateway.base, `/api/admin/users/${employee.user.id}/send-reset`, { token: admin.accessToken, body: {} });
    const resetToken = decodeURIComponent(reset.data.link.split("token=")[1]);
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { requireAdminMfa: true } })).response.status).toBe(409);
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { enabled: true, issuer: idp.issuer, clientId: "indirect-test", requireManagedSso: true } })).response.status).toBe(409);
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { enabled: true, issuer: idp.issuer, clientId: "indirect-test" } })).response.status).toBe(200);
    admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, `/api/admin/users/${employee.user.id}/corporate-auth`, { token: admin.accessToken, method: "PUT", body: { issuer: idp.issuer, subject: "employee-subject", managed: true } })).response.status).toBe(200);
    const setup = await request(gateway.base, "/api/me/2fa/setup", { token: admin.accessToken, body: {} });
    const secret = setup.data.secret as string;
    const enableCode = await totpAt(secret, Date.now() - 30_000);
    expect((await request(gateway.base, "/api/me/2fa/enable", { token: admin.accessToken, body: { code: enableCode } })).response.status).toBe(200);
    const recovery = await request(gateway.base, "/api/me/security/recovery-codes", { token: admin.accessToken, body: { code: await totpAt(secret, Date.now()) } });
    expect(recovery.response.status).toBe(200);
    const codes = recovery.data.codes as string[];
    expect(new Set(codes).size).toBe(10);
    expect((await request(gateway.base, `/api/admin/users/${admin.user.id}/corporate-auth`, { token: admin.accessToken, method: "PUT", body: { ssoExempt: true } })).response.status).toBe(200);
    const pending = await request(gateway.base, "/api/auth/login", { body: { email: "admin@enterprise.test", password: testPassword } });
    const mfa = await request(gateway.base, "/api/auth/2fa", { body: { tempToken: pending.data.tempToken, code: await totpAt(secret, Date.now() + 30_000) } });
    expect(mfa.response.status).toBe(200);
    admin = mfa.data;

    const database = new Database(path.join(gateway.dir, "gateway.db"));
    try {
      database.exec("CREATE TRIGGER test_auth_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='corporate_auth.updated' BEGIN SELECT RAISE(ABORT,'test_auth_audit_failure'); END");
      expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { requireAdminMfa: true, requireManagedSso: true } })).response.status).toBe(500);
      expect((await request(gateway.base, "/api/me", { token: admin.accessToken })).response.status).toBe(200);
      expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken })).data.config.requireAdminMfa).toBe(false);
      database.exec("DROP TRIGGER test_auth_audit_failure");
      expect(database.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log WHERE meta LIKE '%xxxx-%'").get()!.n).toBe(0);
    } finally { database.close(); }
    const enforced = await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { requireAdminMfa: true, requireManagedSso: true } });
    expect(enforced.response.status).toBe(200);
    expect((await request(gateway.base, "/api/me", { token: admin.accessToken })).response.status).toBe(401);
    expect((await request(gateway.base, "/api/auth/refresh", { body: { refreshToken: admin.refreshToken } })).response.status).toBe(401);
    const recoveryLogin = await request(gateway.base, "/api/auth/login", { body: { email: "admin@enterprise.test", password: testPassword } });
    const recovered = await request(gateway.base, "/api/auth/2fa", { body: { tempToken: recoveryLogin.data.tempToken, code: codes[0] } });
    expect(recovered.response.status).toBe(200);
    admin = recovered.data;
    expect((await request(gateway.base, "/api/auth/2fa", { body: { tempToken: recoveryLogin.data.tempToken, code: codes[1] } })).response.status).toBe(401);
    const nextLogin = await request(gateway.base, "/api/auth/login", { body: { email: "admin@enterprise.test", password: testPassword } });
    expect((await request(gateway.base, "/api/auth/2fa", { body: { tempToken: nextLogin.data.tempToken, code: codes[0] } })).response.status).toBe(401);
    expect((await request(gateway.base, "/api/me/security", { token: admin.accessToken })).data.recoveryCodesRemaining).toBe(9);
    expect((await request(gateway.base, "/api/auth/login", { body: { email: "managed@enterprise.test", password: testPassword } })).response.status).toBe(403);
    expect((await request(gateway.base, "/api/me", { token: employee.accessToken })).response.status).toBe(401);
    expect((await request(gateway.base, "/api/auth/password-reset/confirm", { body: { token: resetToken, password: "new-managed-password-123" } })).response.status).toBe(400);
    expect((await request(gateway.base, `/api/admin/users/${employee.user.id}/send-reset`, { token: admin.accessToken, body: {} })).response.status).toBe(403);
    expect((await request(gateway.base, "/api/auth/password-reset/request", { body: { email: "managed@enterprise.test" } })).response.status).toBe(200);
    expect((await request(gateway.base, "/api/me/2fa/disable", { token: admin.accessToken, body: { code: "000000" } })).response.status).toBe(409);
    expect((await request(gateway.base, `/api/admin/users/${admin.user.id}/reset-2fa`, { token: admin.accessToken, body: {} })).response.status).toBe(409);
    expect((await request(gateway.base, `/api/admin/users/${employee.user.id}`, { token: admin.accessToken, method: "PATCH", body: { role: "admin" } })).response.status).toBe(409);
    expect((await request(gateway.base, `/api/admin/users/${admin.user.id}/corporate-auth`, { token: admin.accessToken, method: "PUT", body: { ssoExempt: false } })).response.status).toBe(409);
    expect((await request(gateway.base, `/api/admin/users/${employee.user.id}/corporate-auth`, { token: admin.accessToken, method: "PUT", body: { subject: null } })).response.status).toBe(409);
    idp.identity();
    const corporate = await finishOidc(gateway.base, await beginOidc(gateway.base));
    expect(corporate.response.status).toBe(200);
    expect((await request(gateway.base, "/api/me", { token: corporate.data.accessToken })).response.status).toBe(200);
    expect((await request(gateway.base, "/api/auth/refresh", { body: { refreshToken: corporate.data.refreshToken } })).response.status).toBe(200);
    // Re-enrolling after a lost authenticator requires the recovery-code proof
    // that established this session; a bare setup call must not replace it.
    const unrecovered = await request(gateway.base, "/api/me/2fa/setup", { token: admin.accessToken, body: {} });
    expect(unrecovered.response.status).toBe(403);
    expect(unrecovered.data.secret).toBeUndefined();
    const newSetup = await request(gateway.base, "/api/me/2fa/setup", { token: admin.accessToken, body: { useRecovery: true } });
    expect(newSetup.response.status).toBe(200);
    expect(newSetup.data.secret).toBeTruthy();
    expect((await request(gateway.base, "/api/me/2fa/enable", { token: admin.accessToken, body: { code: await totpAt(newSetup.data.secret, Date.now() - 30_000) } })).response.status).toBe(200);
    const newPending = await request(gateway.base, "/api/auth/login", { body: { email: "admin@enterprise.test", password: testPassword } });
    const restored = await request(gateway.base, "/api/auth/2fa", { body: { tempToken: newPending.data.tempToken, code: await totpAt(newSetup.data.secret, Date.now()) } });
    expect(restored.response.status).toBe(200);
    const read = new Database(path.join(gateway.dir, "gateway.db"), { readonly: true });
    try {
      const events = read.query<{ action: string; meta: string | null }, []>("SELECT action,meta FROM audit_log WHERE action LIKE 'corporate_auth.%' OR action LIKE 'auth.recovery.%'").all();
      expect(events.some((event) => event.action === "auth.recovery.used")).toBe(true);
      expect(events.filter((event) => event.action === "corporate_auth.updated")).toHaveLength(2);
      const serialized = JSON.stringify(events);
      for (const code of codes) expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(secret);
    } finally { read.close(); }
  } finally { await gateway.stop(); await idp.stop(); }
}, 60_000);
