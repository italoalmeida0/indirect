import { requireAdmin, requireAuth } from "../auth";
import { assignPlan, billingStatus, grantReset, listPlans, readUsd, redeemReset, requirePlan } from "../billing";
import { db, audit } from "../db";
import { randomToken } from "../crypto";
import { ApiError, clientIp, ok, readJsonBody, v } from "../http";
import { LIMITS } from "../config";
import {
  financialPolicyFor,
  installationDefaults,
  isBudgetPresentation,
  projectWindow,
  setFinancialPolicy,
  setInstallationDefaults,
  storedPolicy,
  type FinancialPolicy,
} from "../financial-policy";

/**
 * Apply the financial visibility policy to a billing payload.
 *
 * Amounts are omitted HERE, on the server, not hidden in the UI: a component
 * that is merely not rendered still leaves the values in the network response.
 * The window carries a consumption percentage and its renewal instant instead,
 * which is what a non-admin dashboard needs to render "65% used, renews on …".
 */
/** Optional boolean that also accepts 0/1 and null ("inherit the default"). */
function readFlag(body: Record<string, unknown>, field: string): boolean | null {
  const value = body[field];
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  throw new ApiError(400, `${field} must be a boolean`);
}

function projectBilling(billing: ReturnType<typeof billingStatus>, policy: FinancialPolicy) {
  const windows = billing.windows.map((window) => projectWindow(window, policy));
  // The plan's monthly allowance is an amount too; drop it when amounts are
  // hidden and keep only the plan identity.
  const plan = billing.plan && (policy.budgetPresentation === "usd"
    ? billing.plan
    : { id: billing.plan.id, name: billing.plan.name });
  return { ...billing, windows, plan, financialPolicy: policy };
}

/** All administrative mutations and reset redemptions are audited in the
 * same transaction as the balance change. Browser identity never selects
 * the account for a self-service request. */
export async function handleBillingRoute(path: string, req: Request): Promise<Response | null> {
  if (path === "/api/billing" && req.method === "GET") {
    const { user } = await requireAuth(req);
    return ok({ billing: projectBilling(billingStatus(user.id), financialPolicyFor(user)) }, req);
  }
  const redeem = path.match(/^\/api\/billing\/resets\/([a-f0-9]{24})\/redeem$/);
  if (redeem && req.method === "POST") {
    const { user } = await requireAuth(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const requestId = v.str(body, "requestId", { min: 16, max: 128 })!;
    return ok({ billing: redeemReset(user.id, redeem[1]!, requestId, clientIp(req)) }, req);
  }
  // Installation financial policy: the default every user inherits unless an
  // administrator overrides it for that user.
  if (path === "/api/admin/financial-policy" && (req.method === "GET" || req.method === "PATCH")) {
    const { user } = await requireAdmin(req);
    if (req.method === "GET") {
      return ok({ defaults: installationDefaults(), policy: financialPolicyFor(user) }, req);
    }
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const showModelPrices = "showModelPrices" in body ? readFlag(body, "showModelPrices") : undefined;
    const rawPresentation = "budgetPresentation" in body ? body.budgetPresentation : undefined;
    if (rawPresentation !== undefined && rawPresentation !== null && !isBudgetPresentation(rawPresentation)) {
      throw new ApiError(400, "budgetPresentation must be usd, percent or hidden");
    }
    setInstallationDefaults(
      {
        ...(showModelPrices === undefined ? {} : { showModelPrices }),
        ...(rawPresentation === undefined ? {} : { budgetPresentation: rawPresentation as "usd" | "percent" | "hidden" | null }),
      },
      Date.now(),
    );
    audit("financial_policy.installation_updated", {
      actorId: user.id,
      ip: clientIp(req),
      meta: { showModelPrices: showModelPrices ?? "unchanged", budgetPresentation: rawPresentation ?? "unchanged" },
    });
    return ok({ defaults: installationDefaults() }, req);
  }
  // Per-user override of the installation defaults: the second half of the
  // visibility policy (an installation default plus an optional user override).
  const policyMatch = path.match(/^\/api\/admin\/users\/([a-f0-9]{24})\/financial-policy$/);
  if (policyMatch) {
    const { user } = await requireAdmin(req);
    const targetId = policyMatch[1]!;
    if (!db.query("SELECT id FROM users WHERE id = ?").get(targetId)) throw new ApiError(404, "User not found", );
    if (req.method === "GET") {
      return ok({ policy: financialPolicyFor({ id: targetId, role: "user" }), stored: storedPolicy(targetId), defaults: installationDefaults() }, req);
    }
    if (req.method !== "PATCH") return null;
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const current = storedPolicy(targetId);
    const showModelPrices = "showModelPrices" in body ? readFlag(body, "showModelPrices") : current.showModelPrices;
    const rawPresentation = "budgetPresentation" in body ? body.budgetPresentation : current.budgetPresentation;
    if (rawPresentation !== null && !isBudgetPresentation(rawPresentation)) {
      throw new ApiError(400, "budgetPresentation must be usd, percent or hidden");
    }
    setFinancialPolicy(targetId, { showModelPrices, budgetPresentation: rawPresentation as "usd" | "percent" | "hidden" | null });
    audit("financial_policy.user_updated", {
      actorId: user.id,
      target: targetId,
      ip: clientIp(req),
      meta: { showModelPrices, budgetPresentation: rawPresentation },
    });
    return ok({ policy: financialPolicyFor({ id: targetId, role: "user" }), stored: storedPolicy(targetId) }, req);
  }
  const planMatch = path.match(/^\/api\/admin\/plans(?:\/([a-f0-9]{24}))?$/);
  const userMatch = path.match(/^\/api\/admin\/users\/([a-f0-9]{24})\/(billing|resets)$/);
  if (!planMatch && !userMatch) return null;
  const { user } = await requireAdmin(req);
  const ip = clientIp(req);
  if (planMatch) {
    const id = planMatch[1];
    if (!id && req.method === "GET") return ok({ plans: listPlans() }, req);
    if ((!id && req.method === "POST") || (id && req.method === "PATCH")) {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const existing = id ? db.query<any, [string]>("SELECT * FROM billing_plans WHERE id = ?").get(id) : null;
      if (id && !existing) throw new ApiError(404, "Plan not found");
      if (!id && listPlans().length >= 500) throw new ApiError(400, "The plan catalog is full");
      const name = v.str(body, "name", { min: 1, max: 64, optional: !!existing }) ?? existing.name;
      const monthly = "monthlyUsd" in body ? readUsd(body, "monthlyUsd") : existing?.monthly_nanos ?? null;
      if (monthly !== null && monthly < 10_000_000) throw new ApiError(400, "Monthly allowance must be at least $0.01");
      for (const flag of ["weeklyEnabled", "sessionEnabled"]) if (flag in body && typeof body[flag] !== "boolean") throw new ApiError(400, `${flag} must be a boolean`);
      const weekly = "weeklyEnabled" in body ? !!body.weeklyEnabled : !!existing?.weekly_enabled;
      const session = "sessionEnabled" in body ? !!body.sessionEnabled : !!existing?.session_enabled;
      if (monthly === null && (weekly || session)) throw new ApiError(400, "Shorter windows require a monthly allowance");
      const planId = id ?? randomToken(12), now = Date.now();
      db.transaction(() => {
        if (id) db.prepare("UPDATE billing_plans SET name = ?, monthly_nanos = ?, weekly_enabled = ?, session_enabled = ?, updated_at = ? WHERE id = ?").run(name, monthly, +weekly, +session, now, id);
        else db.prepare("INSERT INTO billing_plans(id, name, monthly_nanos, weekly_enabled, session_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(planId, name, monthly, +weekly, +session, now, now);
        audit(id ? "billing.plan.updated" : "billing.plan.created", { actorId: user.id, target: planId, ip, meta: { name, monthlyUsd: monthly === null ? null : monthly / 1e9, weekly, session } });
      }).immediate();
      return ok({ plans: listPlans() }, req);
    }
    if (id && req.method === "DELETE") {
      db.transaction(() => {
        if (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_billing WHERE plan_id = ?").get(id)!.n) throw new ApiError(409, "Move all members to another plan before deleting it");
        if (!db.query("SELECT id FROM billing_plans WHERE id = ?").get(id)) throw new ApiError(404, "Plan not found");
        db.prepare("DELETE FROM billing_plans WHERE id = ?").run(id);
        audit("billing.plan.deleted", { actorId: user.id, target: id, ip });
      }).immediate();
      return ok({ deleted: true }, req);
    }
  }
  if (userMatch) {
    const id = userMatch[1]!;
    if (!db.query("SELECT id FROM users WHERE id = ?").get(id)) throw new ApiError(404, "User not found");
    if (userMatch[2] === "billing") {
      if (req.method === "GET") return ok({ billing: billingStatus(id) }, req);
      if (req.method === "PATCH") {
        const body = await readJsonBody(req, LIMITS.apiBodyBytes);
        if (!("planId" in body)) throw new ApiError(400, "planId is required");
        const plan = requirePlan(body.planId);
        db.transaction(() => { assignPlan(id, plan); audit("billing.plan.assigned", { actorId: user.id, target: id, ip, meta: { planId: plan } }); }).immediate();
        return ok({ billing: billingStatus(id) }, req);
      }
    } else if (req.method === "POST") {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const kind = v.str(body, "kind", { max: 16 })!;
      const count = v.int(body, "count", { min: 1, max: 100 })!;
      const expires = v.int(body, "expiresAt", { min: Date.now() + 60_000, max: Date.now() + 365 * 86_400_000, optional: true });
      const note = v.str(body, "note", { max: 256, optional: true }) ?? "";
      grantReset(id, kind, count, expires, note, user.id, ip);
      return ok({ billing: billingStatus(id) }, req);
    }
  }
  throw new ApiError(405, "Method not allowed");
}
