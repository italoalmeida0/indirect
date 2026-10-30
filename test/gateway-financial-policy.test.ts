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
