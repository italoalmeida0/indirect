import { db, type UserRow } from "./db";

/**
 * Financial visibility policy.
 *
 * The dashboard can show real USD amounts, a percentage of the allowance, or
 * nothing at all. That decision belongs to the SERVER: hiding a component in
 * the UI would still ship the amounts in the API response, where anyone with
 * devtools (or a saved HAR) can read them.
 *
 * Two independent settings, each with an installation default and an optional
 * per-user override:
 *
 *   showModelPrices     - whether model pricing appears in the catalog
 *   budgetPresentation  - "usd" | "percent" | "hidden"
 *
 * Administrators always see real values; the policy only narrows what a
 * non-admin receives. Internal accounting never consults this module — it is a
 * presentation projection over data that is already computed.
 */

export type BudgetPresentation = "usd" | "percent" | "hidden";

export interface FinancialPolicy {
  showModelPrices: boolean;
  budgetPresentation: BudgetPresentation;
  /** True when the effective values are the installation defaults. */
  inherited: boolean;
}

export interface StoredFinancialPolicy {
  showModelPrices: boolean | null;
  budgetPresentation: BudgetPresentation | null;
}

const PRESENTATIONS: readonly BudgetPresentation[] = ["usd", "percent", "hidden"];

export function isBudgetPresentation(value: unknown): value is BudgetPresentation {
  return typeof value === "string" && (PRESENTATIONS as readonly string[]).includes(value);
}

/** Installation defaults, overridable through the environment. */
export const DEFAULT_FINANCIAL_POLICY: FinancialPolicy = {
  showModelPrices: process.env.FINANCIAL_DEFAULT_SHOW_PRICES !== "false",
  budgetPresentation: isBudgetPresentation(process.env.FINANCIAL_DEFAULT_BUDGET)
    ? process.env.FINANCIAL_DEFAULT_BUDGET!
    : "usd",
  inherited: true,
};

interface PolicyRow {
  user_id: string;
  show_model_prices: number | null;
  budget_presentation: string | null;
}

const policyByUser = db.prepare<PolicyRow, [string]>(
  "SELECT user_id, show_model_prices, budget_presentation FROM user_financial_policy WHERE user_id = ?",
);
const upsertPolicy = db.prepare(
  `INSERT INTO user_financial_policy (user_id, show_model_prices, budget_presentation, updated_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     show_model_prices = excluded.show_model_prices,
     budget_presentation = excluded.budget_presentation,
     updated_at = excluded.updated_at`,
);
const deletePolicy = db.prepare("DELETE FROM user_financial_policy WHERE user_id = ?");

/** Raw per-user override, or nulls when the user inherits the defaults. */
export function storedPolicy(userId: string): StoredFinancialPolicy {
  const row = policyByUser.get(userId);
  return {
    showModelPrices: row?.show_model_prices == null ? null : !!row.show_model_prices,
    budgetPresentation: isBudgetPresentation(row?.budget_presentation) ? row.budget_presentation : null,
  };
}

/**
 * The policy that applies to a request made by `user`.
 *
 * Administrators are exempt: they reconcile the ledger and must see real
 * amounts, so narrowing their own view would make the product unusable for the
 * person who owns the installation.
 */
export function financialPolicyFor(user: Pick<UserRow, "id" | "role"> | null): FinancialPolicy {
  if (!user) return { ...DEFAULT_FINANCIAL_POLICY };
  if (user.role === "admin") {
    return { showModelPrices: true, budgetPresentation: "usd", inherited: false };
  }
  const stored = storedPolicy(user.id);
  return {
    showModelPrices: stored.showModelPrices ?? DEFAULT_FINANCIAL_POLICY.showModelPrices,
    budgetPresentation: stored.budgetPresentation ?? DEFAULT_FINANCIAL_POLICY.budgetPresentation,
    inherited: stored.showModelPrices === null && stored.budgetPresentation === null,
  };
}

/** Persist an override; `null` fields clear the override back to the default. */
export function setFinancialPolicy(
  userId: string,
  next: StoredFinancialPolicy,
  now = Date.now(),
): void {
  if (next.showModelPrices === null && next.budgetPresentation === null) {
    deletePolicy.run(userId);
    return;
  }
  upsertPolicy.run(
    userId,
    next.showModelPrices === null ? null : next.showModelPrices ? 1 : 0,
    next.budgetPresentation,
    now,
  );
}

/** True when amounts must be omitted from a response for this policy. */
export function hidesAmounts(policy: FinancialPolicy): boolean {
  return policy.budgetPresentation === "hidden";
}

/**
 * Replace every USD-bearing field with its permitted projection.
 *
 * This is the single choke point for "can this caller see money". It walks the
 * value once and removes any key that names a monetary amount, so a route that
 * adds a new `*Usd` field cannot accidentally leak it by forgetting to call a
 * per-field helper.
 */
const MONEY_KEY = /(?:^|_)(?:usd|cost|price|pricing|spend|spent|billed|forgiven|reserved|remaining|limit)(?:Usd|_usd|Nanos|_nanos)?$|Usd$|Nanos$|^(?:cost|price|pricing)/;

/** Keys that LOOK monetary but are not (kept visible so the UI still works). */
const NOT_MONEY = new Set([
  "limit",
  "limits",
  "rpmLimit",
  "costCenter",
  "costCenterId",
  "priceVisible",
  "remainingPercent",
  "spendPercent",
  "budgetPresentation",
]);

export function isMoneyKey(key: string): boolean {
  if (NOT_MONEY.has(key)) return false;
  return MONEY_KEY.test(key);
}

/**
 * Project a response payload for the caller's policy.
 *
 * - "usd": returned untouched.
 * - "hidden": every monetary key is dropped at every depth.
 * - "percent": monetary keys are dropped from the top level too — percentages
 *   are supplied by the caller through `percentages`, because only the route
 *   knows which allowance a value belongs to.
 */
export function projectAmounts<T>(value: T, policy: FinancialPolicy): T {
  if (policy.budgetPresentation === "usd") return value;
  return scrub(value) as T;
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isMoneyKey(key)) continue;
    out[key] = scrub(child);
  }
  return out;
}

/** Percentage of an allowance that has been consumed, clamped to 0..100. */
export function usedPercent(spent: number, limit: number | null | undefined): number | null {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return null;
  const ratio = (spent / limit) * 100;
  if (!Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(100, Math.round(ratio * 10) / 10));
}

/**
 * Budget window as it may be shown to this caller: real amounts for "usd",
 * consumption percentage plus the renewal instant for "percent", and only the
 * renewal metadata for "hidden".
 */
export function projectWindow(
  window: { kind: string; startsAt: number; resetsAt: number | null; limitUsd: number | null; spentUsd: number; remainingUsd: number | null },
  policy: FinancialPolicy,
) {
  const base = { kind: window.kind, startsAt: window.startsAt, resetsAt: window.resetsAt };
  if (policy.budgetPresentation === "usd") {
    return { ...base, limitUsd: window.limitUsd, spentUsd: window.spentUsd, remainingUsd: window.remainingUsd };
  }
  if (policy.budgetPresentation === "percent") {
    return { ...base, usedPercent: usedPercent(window.spentUsd, window.limitUsd), limitConfigured: window.limitUsd !== null };
  }
  return { ...base, limitConfigured: window.limitUsd !== null };
}

/** Model pricing as it may be shown to this caller. */
export function projectPricing<T extends Record<string, unknown>>(pricing: T | null, policy: FinancialPolicy): T | null {
  if (!policy.showModelPrices) return null;
  return pricing;
}
