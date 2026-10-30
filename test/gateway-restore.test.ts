import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { restoreGatewayBackup } from "../server/restore-backup";
import { readManifest, verifySnapshot } from "../server/backup-files";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterAll(async () => { for (const gateway of gateways) await gateway.stop(); });

test("a live backup restores into a fresh installation with exact billing, history and decryptable credentials", async () => {
  // Whitespace is intentional: restoring an environment secret must preserve
  // its exact bytes rather than silently changing the AES key by trimming it.
  const sourceSecret = " restore-regression-secret-01234567890123456789 ";
  const providerSecret = "mock-provider-restore-only";
  let authorizedUpstreamCalls = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.headers.get("authorization") === `Bearer ${providerSecret}`) authorizedUpstreamCalls++;
    if (req.method === "GET") return Response.json({ data: [{ id: "restore-model", context_length: 32000, top_provider: { max_completion_tokens: 1000 }, pricing: { prompt: "0.000001", completion: "0.000002" } }] });
    await req.json();
    return Response.json({ id: "restore-completion", model: "restore-model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  const original = await startGateway({ GATEWAY_SECRET: sourceSecret, INDIRECT_SECRET: "", BACKUP_INTERVAL_MINUTES: "0" });
  gateways.push(original);
  try {
    const admin = await login(original.base, "admin@enterprise.test");
    const user = await createUser(original.base, admin.accessToken, "restore-user@enterprise.test");
    expect((await request(original.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "restore-provider", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: providerSecret } })).response.status).toBe(200);
    const plans = await request(original.base, "/api/admin/plans", { token: admin.accessToken, body: { name: "Restore plan", monthlyUsd: 100 } });
    const plan = plans.data.plans.find((entry: { name: string }) => entry.name === "Restore plan");
    expect((await request(original.base, `/api/admin/users/${user.user.id}/billing`, { token: admin.accessToken, method: "PATCH", body: { planId: plan.id } })).response.status).toBe(200);
    const key = await request(original.base, "/api/keys", { token: user.accessToken, body: { name: "restore-key", dailyLimitUsd: 10 } });
    const call = async (base: string) => {
      const result = await request(base, "/v1/chat/completions", { token: key.data.token, body: { model: "restore-model", messages: [{ role: "user", content: "hello" }], max_tokens: 5 } });
      expect(result.response.status).toBe(200);
    };
    for (let i = 0; i < 3; i++) await call(original.base);
    const deadline = Date.now() + 10_000;
    while ((await request(original.base, "/api/usage/summary", { token: user.accessToken })).data.summary.total.reqs !== 3) {
      if (Date.now() > deadline) throw new Error("usage did not reach the durable rollups");
      await Bun.sleep(50);
    }
    let copying = true, writes = 0;
    const traffic = (async () => {
      while (copying) {
        const updated = await request(original.base, "/api/me", { token: user.accessToken, method: "PATCH", body: { name: `During backup ${writes}` } });
        expect(updated.response.status).toBe(200);
        writes++;
        await Bun.sleep(2);
      }
    })();
    let created: Awaited<ReturnType<typeof request>>;
    try { created = await request(original.base, "/api/admin/backups", { token: admin.accessToken, body: {} }); }
    finally { copying = false; await traffic; }
    expect(created.response.status).toBe(200);
    expect(created.data.backup.verification.ok).toBe(true);
    expect(writes).toBeGreaterThan(0);
    const snapshotDirectory = path.join(original.dir, "backups", created.data.backup.id);
    const snapshotDb = new Database(path.join(snapshotDirectory, "gateway.db"), { readonly: true });
    let expectedSpent: number;
    try {
      expectedSpent = snapshotDb.query<{ spent: number }, [string]>("SELECT SUM(spent_nanos) AS spent FROM billing_periods WHERE scope='user' AND kind='monthly' AND owner_id=?").get(user.user.id)!.spent / 1e9;
      expect(snapshotDb.query<{ n: number }, []>("SELECT SUM(reqs) AS n FROM usage_model_provider_daily").get()!.n).toBe(3);
    } finally { snapshotDb.close(); }
    const parent = mkdtempSync(path.join(tmpdir(), "indirect-restore-run-"));
    const destination = path.join(parent, "restored");
    const cli = Bun.spawn([process.execPath, "scripts/restore-gateway-backup.ts", `--snapshot=${snapshotDirectory}`, `--destination=${destination}`], { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.includes(sourceSecret)).toBe(false);
    expect(stdout.includes(providerSecret)).toBe(false);
    const restoredInfo = JSON.parse(stdout);
    const restored = await startGateway({ GATEWAY_SECRET: "", INDIRECT_SECRET: "", INDIRECT_SECRET_FILE: restoredInfo.secretFile, BACKUP_INTERVAL_MINUTES: "0" }, destination);
    gateways.push(restored);
    const restoredUser = await login(restored.base, "restore-user@enterprise.test");
    const history = await request(restored.base, "/api/usage/summary", { token: restoredUser.accessToken });
    expect(history.data.summary.total.reqs).toBe(3);
    const billing = await request(restored.base, "/api/billing", { token: restoredUser.accessToken });
    expect(billing.data.billing.windows.find((window: { kind: string }) => window.kind === "monthly").spentUsd).toBe(expectedSpent!);
    const revealed = await request(restored.base, `/api/keys/${key.data.key.id}/reveal`, { token: restoredUser.accessToken });
    expect(revealed.response.status).toBe(200);
    expect(revealed.data.token === key.data.token).toBe(true);
    const before = authorizedUpstreamCalls;
    await call(restored.base);
    expect(authorizedUpstreamCalls).toBe(before + 1);
  } finally { upstream.stop(true); }
}, 90_000);

test("restore refuses a populated destination, missing inventory, traversal and truncated snapshots", async () => {
  const gateway = await startGateway({ BACKUP_INTERVAL_MINUTES: "0" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const created = await request(gateway.base, "/api/admin/backups", { token: admin.accessToken, body: {} });
  expect(created.response.status).toBe(200);
  const snapshotDirectory = path.join(gateway.dir, "backups", created.data.backup.id);
  const occupied = mkdtempSync(path.join(tmpdir(), "indirect-restore-occupied-"));
  writeFileSync(path.join(occupied, "keep.txt"), "untouched");
  expect(() => restoreGatewayBackup(snapshotDirectory, occupied)).toThrow("new or empty directory");
  expect(readFileSync(path.join(occupied, "keep.txt"), "utf8")).toBe("untouched");
  expect(() => restoreGatewayBackup(snapshotDirectory, path.join(snapshotDirectory, "nested"))).toThrow("separate");
  const manifestFile = path.join(snapshotDirectory, "manifest.json");
  const original = readFileSync(manifestFile, "utf8");
  const malicious = JSON.parse(original);
  malicious.files[0].path = "../keep.txt";
  writeFileSync(manifestFile, JSON.stringify(malicious));
  expect(readManifest(snapshotDirectory)).toBeNull();
  expect(() => restoreGatewayBackup(snapshotDirectory, path.join(occupied, "restored"))).toThrow("manifest");
  expect(verifySnapshot(snapshotDirectory).ok).toBe(false);
  writeFileSync(manifestFile, original);
  writeFileSync(path.join(snapshotDirectory, "gateway.db"), "truncated");
  expect(verifySnapshot(snapshotDirectory, readManifest(snapshotDirectory)!).ok).toBe(false);
}, 60_000);
