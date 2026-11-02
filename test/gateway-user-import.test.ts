import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";
import { beginOidc, finishOidc, startMockOidc } from "./oidc-fixture";

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterAll(async () => { for (const gateway of gateways) await gateway.stop(); });
const preview = (base: string, token: string, rows: unknown[]) => request(base, "/api/admin/users/import/preview", { token, body: { format: "json", content: JSON.stringify(rows) } });
const commit = (base: string, token: string, batchId: string) => request(base, "/api/admin/users/import/commit", { token, body: { batchId } });

test("import preview is inert and concurrent commits create scoped accounts exactly once without invitations", async () => {
  const gateway = await startGateway({ SMTP_HOST: "" }); gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const ordinary = await createUser(gateway.base, admin.accessToken, "import-existing@enterprise.test");
  const project = await request(gateway.base, "/api/projects", { token: admin.accessToken, body: { code: "IMPORT", name: "Import project", kind: "project", monthlyUsd: 100 } });
  expect(project.response.status).toBe(200);
  const projectId = project.data.project.id;
  const plans = await request(gateway.base, "/api/admin/plans", { token: admin.accessToken, body: { name: "Imported plan", monthlyUsd: 50 } });
  const planId = plans.data.plans.find((plan: { name: string }) => plan.name === "Imported plan").id;
  const input = [
    { email: "import-new@enterprise.test", name: "New employee", planId, projectIds: [projectId] },
    { email: "import-manager@enterprise.test", name: "Scoped manager", role: "project_manager", projectIds: [projectId] },
    { email: "import-existing@enterprise.test", name: "Ignored rename", role: "admin" },
  ];
  const prepared = await preview(gateway.base, admin.accessToken, input);
  expect(prepared.response.status).toBe(200);
  expect(prepared.response.headers.get("cache-control")).toBe("no-store");
  expect(prepared.data.summary).toEqual({ create: 2, existing: 1, errors: 0 });
  expect((await preview(gateway.base, admin.accessToken, input)).data.batchId).toBe(prepared.data.batchId);
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    expect(sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE email LIKE 'import-new@%'").get()!.n).toBe(0);
    expect((await commit(gateway.base, ordinary.accessToken, prepared.data.batchId)).response.status).toBe(403);
    const outcomes = await Promise.all([commit(gateway.base, admin.accessToken, prepared.data.batchId), commit(gateway.base, admin.accessToken, prepared.data.batchId)]);
    expect(outcomes.every((result) => result.response.status === 200)).toBe(true);
    expect(outcomes.map((result) => result.data.replayed).sort()).toEqual([false, true]);
    expect(outcomes[0]!.data.created).toBe(2);
    expect(outcomes[0]!.data.userIds).toEqual(outcomes[1]!.data.userIds);
    const created = sql.query<{ id: string; role: string; enterprise_role: string | null; password_hash: string | null }, []>("SELECT id,role,enterprise_role,password_hash FROM users WHERE email='import-manager@enterprise.test'").get()!;
    expect(created.role).toBe("user"); expect(created.enterprise_role).toBe("project_manager"); expect(created.password_hash).toBeNull();
    expect(sql.query<{ role: string }, [string, string]>("SELECT role FROM project_members WHERE project_id=? AND user_id=?").get(projectId, created.id)!.role).toBe("manager");
    expect(sql.query<{ role: string; name: string }, [string]>("SELECT role,name FROM users WHERE id=?").get(ordinary.user.id)).toEqual({ role: "user", name: "import-existing@enterprise.test" });
    expect(sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM password_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN ('import-new@enterprise.test','import-manager@enterprise.test'))").get()!.n).toBe(0);
    expect(sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log WHERE action='users.import.committed'").get()!.n).toBe(1);
    expect(sql.query<{ plan_id: string }, []>("SELECT b.plan_id FROM user_billing b JOIN users u ON u.id=b.user_id WHERE u.email='import-new@enterprise.test'").get()!.plan_id).toBe(planId);
  } finally { sql.close(); }
}, 60_000);

test("import validates CSV, duplicate rows, references, privileges and hard byte/row bounds", async () => {
  const gateway = await startGateway({ SMTP_HOST: "" }); gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const user = await createUser(gateway.base, admin.accessToken, "import-permission@enterprise.test");
  expect((await preview(gateway.base, user.accessToken, [])).response.status).toBe(403);
  expect((await preview(gateway.base, admin.accessToken, Array.from({ length: 501 }, (_, i) => ({ email: `u${i}@example.test`, name: "Employee" })))).response.status).toBe(400);
  const invalid = await preview(gateway.base, admin.accessToken, [
    { email: "duplicate@example.test", name: "Employee" }, { email: "DUPLICATE@example.test", name: "Duplicate" },
    { email: "bad", name: "Bad", role: "owner", planId: "missing", projectIds: ["missing"] },
  ]);
  expect(invalid.response.status).toBe(200); expect(invalid.data.valid).toBe(false);
  expect(invalid.data.rows[1].errors.length).toBeGreaterThan(0);
  expect(invalid.data.rows[2].errors.length).toBeGreaterThanOrEqual(4);
  expect((await commit(gateway.base, admin.accessToken, invalid.data.batchId)).response.status).toBe(409);
  const csv = await request(gateway.base, "/api/admin/users/import/preview", { token: admin.accessToken, body: { format: "csv", content: '\uFEFFemail,name\r\ncsv@example.test,"Developer, ""Jr"""\r\n' } });
  expect(csv.response.status).toBe(200); expect(csv.data.valid).toBe(true); expect(csv.data.rows[0].name).toBe('Developer, "Jr"');
  for (const content of ['email,email\na@b.test,A', 'email,name\na@b.test,"unterminated', 'email,name\na@b.test,A,extra']) {
    expect((await request(gateway.base, "/api/admin/users/import/preview", { token: admin.accessToken, body: { format: "csv", content } })).response.status).toBe(400);
  }
  const oversized = await request(gateway.base, "/api/admin/users/import/preview", { token: admin.accessToken, body: { format: "csv", content: "x".repeat(256 * 1024 + 1) } });
  expect(oversized.response.status).toBe(413);
  const unknown = await request(gateway.base, "/api/admin/users/import/preview", { token: admin.accessToken, body: { format: "json", content: "[]", apply: true } });
  expect(unknown.response.status).toBe(400);
}, 60_000);

test("import commit revalidates references, rolls back audit faults and binds previews to their administrator", async () => {
  const gateway = await startGateway({ SMTP_HOST: "" }); gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const second = await createUser(gateway.base, admin.accessToken, "import-other-admin@enterprise.test");
  await request(gateway.base, `/api/admin/users/${second.user.id}`, { token: admin.accessToken, method: "PATCH", body: { role: "admin" } });
  const other = await login(gateway.base, "import-other-admin@enterprise.test");
  const project = await request(gateway.base, "/api/projects", { token: admin.accessToken, body: { code: "STALE", name: "Changed after preview", kind: "project" } });
  const prepared = await preview(gateway.base, admin.accessToken, [{ email: "atomic-import@example.test", name: "Atomic import", projectIds: [project.data.project.id] }]);
  expect(prepared.data.valid).toBe(true);
  expect((await commit(gateway.base, other.accessToken, prepared.data.batchId)).response.status).toBe(404);
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    sql.prepare("UPDATE financial_projects SET status='archived' WHERE id=?").run(project.data.project.id);
    expect((await commit(gateway.base, admin.accessToken, prepared.data.batchId)).response.status).toBe(409);
    expect(sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE email='atomic-import@example.test'").get()!.n).toBe(0);
    sql.prepare("UPDATE financial_projects SET status='active' WHERE id=?").run(project.data.project.id);
    sql.exec("CREATE TRIGGER import_audit_fault BEFORE INSERT ON audit_log WHEN NEW.action='users.import.committed' BEGIN SELECT RAISE(ABORT,'import audit fault'); END");
    expect((await commit(gateway.base, admin.accessToken, prepared.data.batchId)).response.status).toBe(500);
    expect(sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE email='atomic-import@example.test'").get()!.n).toBe(0);
    expect(sql.query<{ committed_at: number | null }, [string]>("SELECT committed_at FROM user_import_batches WHERE id=?").get(prepared.data.batchId)!.committed_at).toBeNull();
    sql.exec("DROP TRIGGER import_audit_fault");
    expect((await commit(gateway.base, admin.accessToken, prepared.data.batchId)).response.status).toBe(200);
    const expiring = await preview(gateway.base, admin.accessToken, [{ email: "expired-import@example.test", name: "Expired" }]);
    sql.prepare("UPDATE user_import_batches SET expires_at=0 WHERE id=?").run(expiring.data.batchId);
    expect((await commit(gateway.base, admin.accessToken, expiring.data.batchId)).response.status).toBe(409);
  } finally { sql.close(); }
}, 60_000);

test("import previews bind subjects and policy to the reviewed issuer while committed results remain immutable", async () => {
  const first = await startMockOidc("ES256"), second = await startMockOidc("ES256");
  const gateway = await startGateway({ SMTP_HOST: "", OIDC_ALLOW_HTTP_LOOPBACK: "true" }); gateways.push(gateway);
  const sql = new Database(path.join(gateway.dir, "gateway.db"));
  try {
    let admin = await login(gateway.base, "admin@enterprise.test");
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { enabled: true, issuer: first.issuer, clientId: "indirect-test" } })).response.status).toBe(200);
    admin = await login(gateway.base, "admin@enterprise.test");
    const input = [{ email: "reviewed-admin@enterprise.test", name: "Reviewed administrator", role: "admin", managed: true, oidcSubject: "employee-subject" }];
    const prepared = await preview(gateway.base, admin.accessToken, input);
    expect(prepared.data.valid).toBe(true);
    const committed = await preview(gateway.base, admin.accessToken, [{ email: "committed-import@enterprise.test", name: "Committed" }]);
    const original = await commit(gateway.base, admin.accessToken, committed.data.batchId);
    expect(original.response.status).toBe(200);

    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { issuer: second.issuer } })).response.status).toBe(200);
    admin = await login(gateway.base, "admin@enterprise.test");
    expect((await commit(gateway.base, admin.accessToken, prepared.data.batchId)).response.status).toBe(409);
    expect(sql.query("SELECT id FROM users WHERE email='reviewed-admin@enterprise.test'").get()).toBeNull();
    second.identity("employee-subject");
    expect((await finishOidc(gateway.base, await beginOidc(gateway.base))).response.status).toBe(403);
    const replay = await commit(gateway.base, admin.accessToken, committed.data.batchId);
    expect(replay.data).toEqual({ ...original.data, replayed: true });

    const reviewedAgain = await preview(gateway.base, admin.accessToken, input);
    expect(reviewedAgain.data.batchId).not.toBe(prepared.data.batchId);
    expect(reviewedAgain.data.valid).toBe(true);
    expect((await commit(gateway.base, admin.accessToken, reviewedAgain.data.batchId)).response.status).toBe(200);
    const signedIn = await finishOidc(gateway.base, await beginOidc(gateway.base));
    expect(signedIn.response.status).toBe(200);
    expect(signedIn.data.user.role).toBe("admin");

    const policyPreview = await preview(gateway.base, admin.accessToken, [{ email: "policy-context@enterprise.test", name: "Policy context" }]);
    expect((await request(gateway.base, "/api/admin/corporate-auth", { token: admin.accessToken, method: "PUT", body: { clientId: "updated-client" } })).response.status).toBe(200);
    admin = await login(gateway.base, "admin@enterprise.test");
    expect((await commit(gateway.base, admin.accessToken, policyPreview.data.batchId)).response.status).toBe(409);

    const legacy = await preview(gateway.base, admin.accessToken, [{ email: "legacy-context@enterprise.test", name: "Legacy context" }]);
    sql.prepare("UPDATE user_import_batches SET auth_context='' WHERE id=?").run(legacy.data.batchId);
    sql.prepare("UPDATE user_import_batches SET auth_context='' WHERE id=?").run(committed.data.batchId);
    expect((await commit(gateway.base, admin.accessToken, legacy.data.batchId)).response.status).toBe(409);
    expect((await commit(gateway.base, admin.accessToken, committed.data.batchId)).data).toEqual({ ...original.data, replayed: true });
  } finally { sql.close(); await first.stop(); await second.stop(); }
}, 60_000);

test("identical import content can be reviewed again after its invalid references are repaired", async () => {
  const gateway = await startGateway({ SMTP_HOST: "" }); gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const project = await request(gateway.base, "/api/projects", { token: admin.accessToken, body: { code: "REPAIRED", name: "Repaired reference", kind: "project" } });
  const projectId = project.data.project.id;
  expect((await request(gateway.base, `/api/projects/${projectId}`, { token: admin.accessToken, method: "PATCH", body: { status: "archived" } })).response.status).toBe(200);
  const input = [{ email: "repaired-import@enterprise.test", name: "Repaired import", projectIds: [projectId] }];
  const invalid = await preview(gateway.base, admin.accessToken, input);
  expect(invalid.data.valid).toBe(false);
  expect((await preview(gateway.base, admin.accessToken, input)).data.batchId).toBe(invalid.data.batchId);
  expect((await request(gateway.base, `/api/projects/${projectId}`, { token: admin.accessToken, method: "PATCH", body: { status: "active" } })).response.status).toBe(200);
  const repaired = await preview(gateway.base, admin.accessToken, input);
  expect(repaired.data.valid).toBe(true);
  expect(repaired.data.batchId).not.toBe(invalid.data.batchId);
  expect((await commit(gateway.base, admin.accessToken, invalid.data.batchId)).response.status).toBe(409);
  expect((await commit(gateway.base, admin.accessToken, repaired.data.batchId)).data.created).toBe(1);
}, 60_000);
