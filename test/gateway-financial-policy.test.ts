import { afterAll, expect, test } from "bun:test";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

/**
 * Financial visibility is a SERVER policy, not a UI preference.
 *
 * The product requirement: an installation may hide USD amounts from regular
 * employees while keeping them for administrators, because hiding a component
 * in the browser leaves the values in the network response.
 *
 * These tests assert the HTTP payload itself, so a component that is merely not
 * rendered cannot make them pass.
 */

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterAll(async () => { for (const gateway of gateways) await gateway.stop(); });

async function boot(env: Record<string, string> = {}) {
  const gateway = await startGateway(env);
  gateways.push(gateway);
  return gateway;
}

/**
 * Every key that names a monetary AMOUNT, at any depth.
 *
 * Deliberately mirrors what the policy strips: an explicit `*Usd`/`*Nanos`
 * suffix, or a cost/price/spend-shaped name. Identifiers that merely contain a
 * money word (`costCenter`, `usedPercent`) are not amounts and must survive.
 */
const NOT_AMOUNT = new Set(["costCenter", "costCenterId", "usedPercent", "limitConfigured", "rpm", "total"]);
function isAmountKey(key: string): boolean {
  if (NOT_AMOUNT.has(key)) return false;
  return /(?:Usd|Nanos)$/.test(key) || /^(?:cost(?:_in|_cache|_out)?|price|pricing|spent|billed|forgiven|reserved|remaining)/.test(key);
}
function moneyKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => moneyKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(isAmountKey(key) ? [`${path}.${key}`] : []),
    ...moneyKeys(child, `${path}.${key}`),
  ]);
}

async function giveUserAPlan(gateway: Awaited<ReturnType<typeof startGateway>>, adminToken: string, userId: string) {
  const created = await request(gateway.base, "/api/admin/plans", { token: adminToken, body: { name: "Enterprise", monthlyUsd: 100, weeklyEnabled: true } });
  expect(created.response.status).toBe(200);
  // The route answers with the full plan list; pick the one just created.
  const plan = (created.data.plans as Array<{ id: string; name: string }>).find((p) => p.name === "Enterprise")!;
  const assigned = await request(gateway.base, `/api/admin/users/${userId}/billing`, { token: adminToken, method: "PATCH", body: { planId: plan.id } });
  expect(assigned.response.status).toBe(200);
  return plan;
}

test("a hidden budget omits USD from billing and keys while the admin still sees amounts", async () => {
  const gateway = await boot({ FINANCIAL_DEFAULT_BUDGET: "hidden" });
  const admin = await login(gateway.base, "admin@enterprise.test");
  const employee = await createUser(gateway.base, admin.accessToken, "visibility@enterprise.test");
  await giveUserAPlan(gateway, admin.accessToken, employee.user.id);
  const key = await request(gateway.base, "/api/keys", { token: employee.accessToken, body: { name: "laptop", dailyLimitUsd: 5 } });
  expect(key.response.status).toBe(200);

  const employeeBilling = await request(gateway.base, "/api/billing", { token: employee.accessToken });
  expect(employeeBilling.response.status).toBe(200);
  expect(moneyKeys(employeeBilling.data)).toEqual([]);
  expect(employeeBilling.data.billing.financialPolicy.budgetPresentation).toBe("hidden");
  // Renewal metadata survives: the UI still needs to say when the window resets.
  expect(employeeBilling.data.billing.windows.every((w: any) => typeof w.kind === "string" && (w.resetsAt === null || typeof w.resetsAt === "number"))).toBe(true);

  const employeeKeys = await request(gateway.base, "/api/keys", { token: employee.accessToken });
  expect(employeeKeys.response.status).toBe(200);
  expect(moneyKeys(employeeKeys.data.keys)).toEqual([]);
  // The key itself is still identifiable and usable.
  expect(employeeKeys.data.keys[0].id).toBeTruthy();
  expect(employeeKeys.data.keys[0].prefix).toMatch(/^gw_/);

  // The administrator reconciles the ledger and must keep real amounts.
  const adminBilling = await request(gateway.base, "/api/billing", { token: admin.accessToken });
  expect(adminBilling.response.status).toBe(200);
  expect(adminBilling.data.billing.financialPolicy.budgetPresentation).toBe("usd");
  const adminKeys = await request(gateway.base, "/api/admin/keys?limit=10", { token: admin.accessToken });
  expect(adminKeys.response.status).toBe(200);
  expect(moneyKeys(adminKeys.data.keys).length).toBeGreaterThan(0);
}, 60_000);

test("percent presentation reports consumption without the underlying amounts", async () => {
  const gateway = await boot({ FINANCIAL_DEFAULT_BUDGET: "percent" });
  const admin = await login(gateway.base, "admin@enterprise.test");
  const employee = await createUser(gateway.base, admin.accessToken, "percent@enterprise.test");
  await giveUserAPlan(gateway, admin.accessToken, employee.user.id);

  const billing = await request(gateway.base, "/api/billing", { token: employee.accessToken });
  expect(billing.response.status).toBe(200);
  expect(moneyKeys(billing.data)).toEqual([]);
  expect(billing.data.billing.financialPolicy.budgetPresentation).toBe("percent");
  const monthly = billing.data.billing.windows.find((w: any) => w.kind === "monthly");
  // A fresh account has consumed nothing; the percentage is a real number and
  // the configured allowance is disclosed as a boolean, not as USD.
  expect(monthly.usedPercent).toBe(0);
  expect(monthly.limitConfigured).toBe(true);
  expect(monthly.limitUsd).toBeUndefined();
  expect(monthly.resetsAt).toBeGreaterThan(Date.now());
}, 60_000);

test("the USD presentation keeps the real amounts intact", async () => {
  const gateway = await boot({ FINANCIAL_DEFAULT_BUDGET: "usd" });
  const admin = await login(gateway.base, "admin@enterprise.test");
  const employee = await createUser(gateway.base, admin.accessToken, "usd@enterprise.test");
  await giveUserAPlan(gateway, admin.accessToken, employee.user.id);

  const billing = await request(gateway.base, "/api/billing", { token: employee.accessToken });
  expect(billing.response.status).toBe(200);
  const monthly = billing.data.billing.windows.find((w: any) => w.kind === "monthly");
  expect(monthly.limitUsd).toBe(100);
  expect(monthly.spentUsd).toBe(0);
  expect(monthly.usedPercent).toBeUndefined();
}, 60_000);

test("the effective policy is exposed to the caller and defaults are installable", async () => {
  const gateway = await boot({ FINANCIAL_DEFAULT_BUDGET: "hidden", FINANCIAL_DEFAULT_SHOW_PRICES: "false" });
  const admin = await login(gateway.base, "admin@enterprise.test");
  const employee = await createUser(gateway.base, admin.accessToken, "policy@enterprise.test");

  const own = await request(gateway.base, "/api/me/financial-policy", { token: employee.accessToken });
  expect(own.response.status).toBe(200);
  expect(own.data.policy).toMatchObject({ showModelPrices: false, budgetPresentation: "hidden", inherited: true });

  const adminOwn = await request(gateway.base, "/api/me/financial-policy", { token: admin.accessToken });
  expect(adminOwn.data.policy).toMatchObject({ showModelPrices: true, budgetPresentation: "usd" });
}, 60_000);

test("projection never leaves a monetary key behind, at any depth", async () => {
  const { projectAmounts } = await import("../server/financial-policy");
  const payload = {
    total: 12,
    cost: 1.5,
    nested: { spendTodayUsd: 2, cost_in: 1, list: [{ priceUsd: 3, model: "m" }] },
    plan: { monthlyUsd: 100, name: "Enterprise" },
    remaining_usd: 4,
    costCenter: "cc-1",
    rpm: 10,
  };
  expect(moneyKeys(projectAmounts(payload, { showModelPrices: true, budgetPresentation: "hidden", inherited: false }))).toEqual([]);
  // Non-monetary fields that merely contain a money-ish word survive.
  const kept = projectAmounts(payload, { showModelPrices: true, budgetPresentation: "hidden", inherited: false }) as any;
  expect(kept.costCenter).toBe("cc-1");
  expect(kept.rpm).toBe(10);
  expect(kept.total).toBe(12);
  // "usd" is a pass-through, not a copy.
  expect(projectAmounts(payload, { showModelPrices: true, budgetPresentation: "usd", inherited: false })).toBe(payload);
});
test("an administrator can change the installation default and override one user", async () => {
  const gateway = await boot({ FINANCIAL_DEFAULT_BUDGET: "usd" });
  const admin = await login(gateway.base, "admin@enterprise.test");
  const employee = await createUser(gateway.base, admin.accessToken, "override@enterprise.test");

  // Installation default starts as the environment value.
  const before = await request(gateway.base, "/api/admin/financial-policy", { token: admin.accessToken });
  expect(before.response.status).toBe(200);
  expect(before.data.defaults.budgetPresentation).toBe("usd");

  // Flip the installation default for everyone.
  const changed = await request(gateway.base, "/api/admin/financial-policy", {
    token: admin.accessToken, method: "PATCH", body: { budgetPresentation: "hidden", showModelPrices: false },
  });
  expect(changed.response.status).toBe(200);
  expect(changed.data.defaults).toEqual({ showModelPrices: false, budgetPresentation: "hidden" });

  const employeePolicy = await request(gateway.base, "/api/me/financial-policy", { token: employee.accessToken });
  expect(employeePolicy.data.policy).toMatchObject({ showModelPrices: false, budgetPresentation: "hidden", inherited: true });

  // A per-user override wins over the installation default.
  const override = await request(gateway.base, `/api/admin/users/${employee.user.id}/financial-policy`, {
    token: admin.accessToken, method: "PATCH", body: { budgetPresentation: "percent" },
  });
  expect(override.response.status).toBe(200);
  expect(override.data.policy).toMatchObject({ budgetPresentation: "percent", inherited: false });

  const afterOverride = await request(gateway.base, "/api/me/financial-policy", { token: employee.accessToken });
  expect(afterOverride.data.policy).toMatchObject({ budgetPresentation: "percent", showModelPrices: false });

  // Clearing the override returns the user to the installation default.
  const cleared = await request(gateway.base, `/api/admin/users/${employee.user.id}/financial-policy`, {
    token: admin.accessToken, method: "PATCH", body: { budgetPresentation: null },
  });
  expect(cleared.response.status).toBe(200);
  expect(cleared.data.stored).toEqual({ showModelPrices: null, budgetPresentation: null });
  expect((await request(gateway.base, "/api/me/financial-policy", { token: employee.accessToken })).data.policy.budgetPresentation).toBe("hidden");

  // An invalid value is refused, never silently coerced.
  expect((await request(gateway.base, "/api/admin/financial-policy", {
    token: admin.accessToken, method: "PATCH", body: { budgetPresentation: "euros" },
  })).response.status).toBe(400);

  // Only administrators may change it.
  expect((await request(gateway.base, "/api/admin/financial-policy", {
    token: employee.accessToken, method: "PATCH", body: { budgetPresentation: "usd" },
  })).response.status).toBe(403);

  // The change is audited.
  const audit = await request(gateway.base, "/api/admin/audit?limit=50", { token: admin.accessToken });
  expect(audit.response.status).toBe(200);
  // The audit route pages under "entries" (newest first).
  const actions = (audit.data.entries as Array<{ action: string }>).map((row) => row.action);
  expect(actions).toContain("financial_policy.installation_updated");
  expect(actions).toContain("financial_policy.user_updated");
}, 60_000);

test("hidden and percent policies enforce visibility across mutations, reset redemption, all usage surfaces, model catalogs, filter oracles, and cache flips", async () => {
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models") && req.method === "GET") {
        return Response.json({
          object: "list",
          data: [
            {
              id: "vis-model",
              type: "model",
              display_name: "Visibility Model",
              context_length: 128_000,
              top_provider: { max_completion_tokens: 4096 },
              pricing: {
                prompt: "0.00001",
                completion: "0.00003",
                input_cache_reads: "0.000001",
                input_cache_writes: "0.00002",
              },
            },
          ],
          has_more: false,
        });
      }
      if (url.pathname.includes("/models/") && req.method === "GET") {
        return Response.json({
          id: "vis-model",
          type: "model",
          display_name: "Visibility Model",
          pricing: { prompt: "0.00001", completion: "0.00003" },
        });
      }
      await req.text();
      return Response.json({
        id: "chatcmpl_vis",
        model: "vis-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      });
    },
  });

  try {
    const gateway = await boot({
      FINANCIAL_DEFAULT_BUDGET: "hidden",
      FINANCIAL_DEFAULT_SHOW_PRICES: "false",
    });
    const admin = await login(gateway.base, "admin@enterprise.test");
    const employee = await createUser(gateway.base, admin.accessToken, "strict-emp@enterprise.test");
    const usdPeer = await createUser(gateway.base, admin.accessToken, "usd-peer@enterprise.test");

    // Configure provider + sync priced model + enable router mode.
    const prov = await request(gateway.base, "/api/admin/providers", {
      token: admin.accessToken,
      body: {
        name: "VisUpstream",
        openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        anthropicBaseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        responsesBaseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-vis-upstream",
      },
    });
    expect(prov.response.status).toBe(200);
    const synced = await request(
      gateway.base,
      `/api/admin/providers/${prov.data.provider.id}/sync-models`,
      { token: admin.accessToken, body: {} },
    );
    expect(synced.response.status).toBe(200);
    expect(
      (
        await request(gateway.base, "/api/admin/settings", {
          token: admin.accessToken,
          method: "PATCH",
          body: { routingMode: "router" },
        })
      ).response.status,
    ).toBe(200);

    // Override usdPeer to full USD + model prices for cross-user isolation checks.
    expect(
      (
        await request(gateway.base, `/api/admin/users/${usdPeer.user.id}/financial-policy`, {
          token: admin.accessToken,
          method: "PATCH",
          body: { budgetPresentation: "usd", showModelPrices: true },
        })
      ).response.status,
    ).toBe(200);

    // Assign finite $100 plan + weekly reset to employee.
    await giveUserAPlan(gateway, admin.accessToken, employee.user.id);
    const grantRes = await request(gateway.base, `/api/admin/users/${employee.user.id}/resets`, {
      token: admin.accessToken,
      body: { kind: "weekly", count: 1, note: "sprint reset" },
    });
    expect(grantRes.response.status).toBe(200);
    const resetId = grantRes.data.billing.resets[0].id as string;

    // 1. POST /api/keys must not leak USD fields when budgetPresentation is hidden.
    const empKeyCreated = await request(gateway.base, "/api/keys", {
      token: employee.accessToken,
      body: { name: "cli-key", dailyLimitUsd: 10, totalLimitUsd: 50 },
    });
    expect(empKeyCreated.response.status).toBe(200);
    expect(moneyKeys(empKeyCreated.data)).toEqual([]);
    expect(empKeyCreated.response.headers.get("x-financial-policy")).toBe("hidden;prices=0");
    const empKeyToken = empKeyCreated.data.token as string;
    const empKeyId = empKeyCreated.data.key.id as string;

    const peerKeyCreated = await request(gateway.base, "/api/keys", {
      token: usdPeer.accessToken,
      body: { name: "peer-key", dailyLimitUsd: 25 },
    });
    expect(peerKeyCreated.response.status).toBe(200);
    const peerKeyToken = peerKeyCreated.data.token as string;

    const adminKeyCreated = await request(gateway.base, "/api/keys", {
      token: admin.accessToken,
      body: { name: "admin-key" },
    });
    expect(adminKeyCreated.response.status).toBe(200);
    const adminKeyToken = adminKeyCreated.data.token as string;

    // Generate real billable spend for employee and usdPeer.
    for (const tok of [empKeyToken, peerKeyToken]) {
      const proxyRes = await fetch(`${gateway.base}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "vis-model",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
        }),
      });
      expect(proxyRes.status).toBe(200);
    }

    // Wait for buffered usage flush so usage_events and rollups are populated.
    let flushed = false;
    for (let i = 0; i < 40; i++) {
      const check = await request(gateway.base, "/api/usage/events?limit=5", {
        token: usdPeer.accessToken,
      });
      if ((check.data.events?.length ?? 0) >= 1) {
        flushed = true;
        break;
      }
      await Bun.sleep(100);
    }
    expect(flushed).toBe(true);

    // 2. PATCH /api/keys/:id (renaming a key) must not leak spend or limits, and omitting limits preserves them.
    const renamed = await request(gateway.base, `/api/keys/${empKeyId}`, {
      token: employee.accessToken,
      method: "PATCH",
      body: { name: "cli-key-renamed" },
    });
    expect(renamed.response.status).toBe(200);
    expect(moneyKeys(renamed.data)).toEqual([]);
    expect(renamed.data.key.name).toBe("cli-key-renamed");

    // Admin still sees the preserved $10 / $50 caps and real nonzero spend.
    const adminKeys = await request(gateway.base, "/api/admin/keys?limit=20", {
      token: admin.accessToken,
    });
    const rawEmpKey = (adminKeys.data.keys as any[]).find((k) => k.id === empKeyId);
    expect(rawEmpKey.dailyLimitUsd).toBe(10);
    expect(rawEmpKey.totalLimitUsd).toBe(50);
    expect(rawEmpKey.spendTotalUsd).toBeGreaterThan(0);

    // 3. POST /api/billing/resets/:id/redeem must project billing according to user's policy.
    const redeemed = await request(gateway.base, `/api/billing/resets/${resetId}/redeem`, {
      token: employee.accessToken,
      body: { requestId: "redeem-req-hidden-policy-0001" },
    });
    expect(redeemed.response.status).toBe(200);
    expect(moneyKeys(redeemed.data)).toEqual([]);
    expect(redeemed.data.billing.plan).toMatchObject({ name: "Enterprise", limitConfigured: true });

    // 4. Every /api/usage/* endpoint must omit monetary fields and modelSpend values for hidden user.
    const now = Date.now();
    const from = now - 7 * 86_400_000;
    const usagePaths = [
      "/api/usage/summary",
      "/api/usage/daily",
      "/api/usage/daily?hours=24",
      `/api/usage/daily?from=${from}&to=${now}`,
      `/api/usage/daily?key_id=${empKeyId}`,
      "/api/usage/events?limit=10",
      `/api/usage/events?from=${from}&to=${now}&limit=10`,
      `/api/usage/overview?from=${from}&to=${now}`,
      `/api/usage/analytics?from=${from}&to=${now}`,
      "/api/usage/breakdown",
      "/api/usage/breakdown?limit=10",
      `/api/usage/breakdown?from=${from}&to=${now}&limit=10`,
      "/api/usage/by-model",
      `/api/usage/filter-options?from=${from}&to=${now}`,
    ];
    for (const usagePath of usagePaths) {
      const res = await request(gateway.base, usagePath, { token: employee.accessToken });
      expect(res.response.status).toBe(200);
      expect(moneyKeys(res.data)).toEqual([]);
    }

    const empAnalytics = await request(gateway.base, `/api/usage/analytics?from=${from}&to=${now}`, {
      token: employee.accessToken,
    });
    expect(empAnalytics.data.modelSpend).toEqual({ groups: [], points: [] });
    expect(empAnalytics.data.modelRequests.groups.length).toBeGreaterThan(0);

    // Cross-user isolation: usdPeer still receives real USD costs and modelSpend.
    const peerAnalytics = await request(gateway.base, `/api/usage/analytics?from=${from}&to=${now}`, {
      token: usdPeer.accessToken,
    });
    expect(moneyKeys(peerAnalytics.data).length).toBeGreaterThan(0);
    expect(peerAnalytics.data.modelSpend.groups.length).toBeGreaterThan(0);

    // 5. Filter/sort oracles on cost and spendTotalUsd must be neutralized when budgetPresentation !== "usd".
    const highCostFilter = encodeURIComponent(
      JSON.stringify({ cost: { filterType: "number", type: "greaterThan", filter: 999_999 } }),
    );
    const oracleEvents = await request(
      gateway.base,
      `/api/usage/events?limit=10&filters=${highCostFilter}`,
      { token: employee.accessToken },
    );
    expect(oracleEvents.response.status).toBe(200);
    expect(oracleEvents.data.total).toBe(1);

    const highSpendKeyFilter = encodeURIComponent(
      JSON.stringify({ spendTotalUsd: { filterType: "number", type: "greaterThan", filter: 999_999 } }),
    );
    const oracleKeys = await request(
      gateway.base,
      `/api/keys?limit=10&filters=${highSpendKeyFilter}`,
      { token: employee.accessToken },
    );
    expect(oracleKeys.response.status).toBe(200);
    expect(oracleKeys.data.total).toBe(1);

    // 6. /v1/models and /v1/models/:id must obey showModelPrices across router and passthrough modes.
    for (const modelPath of ["/v1/models", "/v1/models/vis-model", "/anthropic/v1/models"]) {
      const empModels = await fetch(`${gateway.base}${modelPath}`, {
        headers: { Authorization: `Bearer ${empKeyToken}` },
      });
      expect(empModels.status).toBe(200);
      expect(moneyKeys(await empModels.json())).toEqual([]);
    }
    const adminModels = await fetch(`${gateway.base}/v1/models`, {
      headers: { Authorization: `Bearer ${adminKeyToken}` },
    });
    expect(adminModels.status).toBe(200);
    expect(moneyKeys(await adminModels.json()).length).toBeGreaterThan(0);

    // Passthrough mode check for /anthropic/v1/models and /v1/models.
    await request(gateway.base, "/api/admin/settings", {
      token: admin.accessToken,
      method: "PATCH",
      body: { routingMode: "passthrough" },
    });
    for (const modelPath of ["/v1/models", "/anthropic/v1/models", "/v1/models/vis-model"]) {
      const empPt = await fetch(`${gateway.base}${modelPath}`, {
        headers: { Authorization: `Bearer ${empKeyToken}` },
      });
      expect(empPt.status).toBe(200);
      expect(moneyKeys(await empPt.json())).toEqual([]);
    }
    await request(gateway.base, "/api/admin/settings", {
      token: admin.accessToken,
      method: "PATCH",
      body: { routingMode: "router" },
    });

    // 7. Live policy flip: percent + showModelPrices=true, then usd, then hidden (verifying cache invalidation).
    await request(gateway.base, `/api/admin/users/${employee.user.id}/financial-policy`, {
      token: admin.accessToken,
      method: "PATCH",
      body: { budgetPresentation: "percent", showModelPrices: true },
    });
    const empPercentBilling = await request(gateway.base, "/api/billing", { token: employee.accessToken });
    expect(empPercentBilling.response.headers.get("x-financial-policy")).toBe("percent;prices=1");
    expect(moneyKeys(empPercentBilling.data)).toEqual([]);
    expect(empPercentBilling.data.billing.plan).toMatchObject({ name: "Enterprise", limitConfigured: true });
    const empPercentMonthly = empPercentBilling.data.billing.windows.find((w: any) => w.kind === "monthly");
    expect(typeof empPercentMonthly.usedPercent).toBe("number");
    expect(typeof empPercentMonthly.holdPercent).toBe("number");
    expect(empPercentMonthly.limitConfigured).toBe(true);

    const empPercentKeys = await request(gateway.base, "/api/keys", { token: employee.accessToken });
    expect(moneyKeys(empPercentKeys.data)).toEqual([]);
    expect(empPercentKeys.data.keys[0].dailyLimitConfigured).toBe(true);
    expect(empPercentKeys.data.keys[0].totalLimitConfigured).toBe(true);
    expect(typeof empPercentKeys.data.keys[0].dailyUsedPercent).toBe("number");
    expect(typeof empPercentKeys.data.keys[0].totalUsedPercent).toBe("number");

    // showModelPrices=true works independently even while budgetPresentation="percent".
    const empModelsAllowed = await fetch(`${gateway.base}/v1/models`, {
      headers: { Authorization: `Bearer ${empKeyToken}` },
    });
    expect(moneyKeys(await empModelsAllowed.json()).length).toBeGreaterThan(0);

    // Flip to USD: cached analytics for employee must immediately expose cost & modelSpend.
    await request(gateway.base, `/api/admin/users/${employee.user.id}/financial-policy`, {
      token: admin.accessToken,
      method: "PATCH",
      body: { budgetPresentation: "usd", showModelPrices: true },
    });
    const empUsdAnalytics = await request(gateway.base, `/api/usage/analytics?from=${from}&to=${now}`, {
      token: employee.accessToken,
    });
    expect(empUsdAnalytics.response.headers.get("x-financial-policy")).toBe("usd;prices=1");
    expect(moneyKeys(empUsdAnalytics.data).length).toBeGreaterThan(0);
    expect(empUsdAnalytics.data.modelSpend.groups.length).toBeGreaterThan(0);

    // Flip back to hidden: cached USD analytics must never be served!
    await request(gateway.base, `/api/admin/users/${employee.user.id}/financial-policy`, {
      token: admin.accessToken,
      method: "PATCH",
      body: { budgetPresentation: "hidden", showModelPrices: false },
    });
    const empHiddenAgain = await request(gateway.base, `/api/usage/analytics?from=${from}&to=${now}`, {
      token: employee.accessToken,
    });
    expect(empHiddenAgain.response.headers.get("x-financial-policy")).toBe("hidden;prices=0");
    expect(moneyKeys(empHiddenAgain.data)).toEqual([]);
    expect(empHiddenAgain.data.modelSpend).toEqual({ groups: [], points: [] });
  } finally {
    upstream.stop(true);
  }
}, 60_000);
