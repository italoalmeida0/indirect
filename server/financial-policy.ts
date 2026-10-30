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

/**
 * Installation defaults: the environment seeds them and an administrator can
 * change them at runtime (stored in installation_policy so the choice survives
 * a restart). The environment stays the documented bootstrap.
 */
const envDefaults = {
  showModelPrices: process.env.FINANCIAL_DEFAULT_SHOW_PRICES !== "false",
  budgetPresentation: (isBudgetPresentation(process.env.FINANCIAL_DEFAULT_BUDGET)
    ? process.env.FINANCIAL_DEFAULT_BUDGET!
    : "usd") as BudgetPresentation,
};

const installationValue = db.prepare<{ value: string }, [string]>(
  "SELECT value FROM installation_policy WHERE key = ?",
);
const setInstallationValue = db.prepare(
  `INSERT INTO installation_policy (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
);
const clearInstallationValue = db.prepare("DELETE FROM installation_policy WHERE key = ?");

/** Effective installation defaults, environment overlaid with the stored choice. */
export function installationDefaults(): { showModelPrices: boolean; budgetPresentation: BudgetPresentation } {
  let showModelPrices = envDefaults.showModelPrices;
  let budgetPresentation = envDefaults.budgetPresentation;
  try {
    const prices = installationValue.get("show_model_prices");
    if (prices) showModelPrices = prices.value === "1";
    const budget = installationValue.get("budget_presentation");
    if (budget && isBudgetPresentation(budget.value)) budgetPresentation = budget.value;
  } catch {
    // Not configured yet: the environment value applies.
  }
  return { showModelPrices, budgetPresentation };
}

/** Change an installation default; `null` restores the environment value. */
export function setInstallationDefaults(
  next: { showModelPrices?: boolean | null; budgetPresentation?: BudgetPresentation | null },
  now = Date.now(),
): void {
  if (next.showModelPrices === null) clearInstallationValue.run("show_model_prices");
  else if (typeof next.showModelPrices === "boolean") setInstallationValue.run("show_model_prices", next.showModelPrices ? "1" : "0", now);
  if (next.budgetPresentation === null) clearInstallationValue.run("budget_presentation");
  else if (isBudgetPresentation(next.budgetPresentation)) setInstallationValue.run("budget_presentation", next.budgetPresentation, now);
}

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
  const defaults = installationDefaults();
  if (!user) return { ...defaults, inherited: true };
  if (user.role === "admin") {
    return { showModelPrices: true, budgetPresentation: "usd", inherited: false };
  }
  const stored = storedPolicy(user.id);
  return {
    showModelPrices: stored.showModelPrices ?? defaults.showModelPrices,
    budgetPresentation: stored.budgetPresentation ?? defaults.budgetPresentation,
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
  "limitConfigured",
  "usedPercent",
  "holdPercent",
  "dailyLimitConfigured",
  "totalLimitConfigured",
  "dailyUsedPercent",
  "totalUsedPercent",
]);

export function isMoneyKey(key: string): boolean {
  if (NOT_MONEY.has(key)) return false;
  return MONEY_KEY.test(key);
}

/** Compact header value so open browser tabs detect policy flips immediately. */
export function formatFinancialPolicyHeader(policy: FinancialPolicy): string {
  return `${policy.budgetPresentation};prices=${policy.showModelPrices ? "1" : "0"}`;
}

/**
 * Project a response payload for the caller's policy.
 *
 * - "usd": returned untouched.
 * - "hidden": every monetary key is dropped at every depth.
 * - "percent": monetary keys are dropped from the top level too — percentages
 *   are supplied by the caller through explicit DTO projections, because only
 *   the domain projector knows which allowance a value belongs to.
 */
export function projectAmounts<T>(value: T, policy: FinancialPolicy): T {
  if (policy.budgetPresentation === "usd") return value;
  return scrub(value) as T;
}

/** Strip model pricing keys when `showModelPrices` is disabled. */
export function projectModelPrices<T>(value: T, showModelPrices: boolean): T {
  if (showModelPrices) return value;
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
 * consumption/hold percentages plus the renewal instant for "percent", and
 * non-monetary allowance status + renewal metadata for "hidden".
 */
export function projectWindow<
  T extends {
    kind: string;
    startsAt: number;
    resetsAt: number | null;
    limitUsd: number | null;
    spentUsd: number;
    reservedUsd?: number;
    remainingUsd: number | null;
  },
>(window: T, policy: FinancialPolicy) {
  const base = { kind: window.kind, startsAt: window.startsAt, resetsAt: window.resetsAt };
  if (policy.budgetPresentation === "usd") {
    return window;
  }
  if (policy.budgetPresentation === "percent") {
    return {
      presentation: "percent" as const,
      ...base,
      usedPercent: usedPercent(window.spentUsd, window.limitUsd),
      holdPercent: usedPercent(window.reservedUsd ?? 0, window.limitUsd),
      limitConfigured: window.limitUsd !== null,
    };
  }
  return {
    presentation: "hidden" as const,
    ...base,
    limitConfigured: window.limitUsd !== null,
    activeHold: (window.reservedUsd ?? 0) > 0,
    exhausted: window.limitUsd !== null && window.remainingUsd !== null && window.remainingUsd <= 0,
  };
}

/** Project a complete billing status payload (GET /api/billing and reset redemption). */
export function projectBillingPayload<
  T extends {
    plan: {
      id: string;
      name: string;
      monthlyUsd: number | null;
      weeklyEnabled: boolean;
      sessionEnabled: boolean;
    } | null;
    windows: Array<{
      kind: string;
      startsAt: number;
      resetsAt: number | null;
      limitUsd: number | null;
      spentUsd: number;
      reservedUsd?: number;
      remainingUsd: number | null;
    }>;
  },
>(billing: T, policy: FinancialPolicy) {
  const windows = billing.windows.map((window) => projectWindow(window, policy));
  const plan =
    billing.plan &&
    (policy.budgetPresentation === "usd"
      ? billing.plan
      : {
          id: billing.plan.id,
          name: billing.plan.name,
          limitConfigured: billing.plan.monthlyUsd !== null,
          weeklyEnabled: billing.plan.weeklyEnabled,
          sessionEnabled: billing.plan.sessionEnabled,
        });
  return { ...billing, windows, plan, financialPolicy: policy };
}

/** Project an API key DTO across GET, POST and PATCH /api/keys. */
export function projectKeyDto<
  T extends {
    id: string;
    userId: string;
    userEmail?: string;
    name: string;
    prefix: string;
    createdAt: number;
    expiresAt: number | null;
    dailyLimitUsd: number | null;
    totalLimitUsd: number | null;
    rpm: number | null;
    status: string;
    lastUsedAt: number | null;
    spendTodayUsd: number;
    spendTotalUsd: number;
    revealable: boolean;
  },
>(key: T, policy: FinancialPolicy) {
  if (policy.budgetPresentation === "usd") return key;
  const base = {
    id: key.id,
    userId: key.userId,
    ...(key.userEmail !== undefined ? { userEmail: key.userEmail } : {}),
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    rpm: key.rpm,
    status: key.status,
    lastUsedAt: key.lastUsedAt,
    revealable: key.revealable,
    dailyLimitConfigured: key.dailyLimitUsd !== null,
    totalLimitConfigured: key.totalLimitUsd !== null,
  };
  if (policy.budgetPresentation === "percent") {
    return {
      presentation: "percent" as const,
      ...base,
      dailyUsedPercent: usedPercent(key.spendTodayUsd, key.dailyLimitUsd),
      totalUsedPercent: usedPercent(key.spendTotalUsd, key.totalLimitUsd),
    };
  }
  return {
    presentation: "hidden" as const,
    ...base,
  };
}

function stripCostRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "cost" || key === "cost_in" || key === "cost_cache" || key === "cost_out" || isMoneyKey(key)) {
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

/** Project tabular/series usage rows without mutating cached reader snapshots. */
export function projectUsageRows<T extends Record<string, unknown>>(rows: T[], policy: FinancialPolicy): T[] {
  if (policy.budgetPresentation === "usd") return rows;
  return rows.map(stripCostRow);
}

export function projectUsageSummary<
  T extends { today: Record<string, unknown>; month: Record<string, unknown>; total: Record<string, unknown> },
>(summary: T, policy: FinancialPolicy): T {
  if (policy.budgetPresentation === "usd") return summary;
  return {
    ...summary,
    today: stripCostRow(summary.today),
    month: stripCostRow(summary.month),
    total: stripCostRow(summary.total),
  };
}

export function projectUsageBreakdownPayload<
  T extends { rows: Array<Record<string, unknown>>; totals?: Record<string, unknown> },
>(page: T, policy: FinancialPolicy): T {
  if (policy.budgetPresentation === "usd") return page;
  return {
    ...page,
    rows: page.rows.map(stripCostRow),
    ...(page.totals ? { totals: stripCostRow(page.totals) } : {}),
  };
}

function rankByVolume<T extends Record<string, unknown>>(entities: T[]): T[] {
  const named = entities.filter((e) => e.id !== null);
  const rest = entities.filter((e) => e.id === null);
  named.sort((a, b) => {
    const reqDiff = (Number(b.reqs) || 0) - (Number(a.reqs) || 0);
    if (reqDiff !== 0) return reqDiff;
    const tokA = (Number(a.in_tok) || 0) + (Number(a.cache_tok) || 0) + (Number(a.out_tok) || 0);
    const tokB = (Number(b.in_tok) || 0) + (Number(b.cache_tok) || 0) + (Number(b.out_tok) || 0);
    if (tokB !== tokA) return tokB - tokA;
    return String(a.label ?? "").localeCompare(String(b.label ?? ""));
  });
  return [...named, ...rest].map(stripCostRow);
}

/**
 * Project `/api/usage/analytics`: strips per-bucket costs, clears `modelSpend`
 * (whose `points[*].values` carry raw USD numbers), and orders entity breakdowns
 * by request/token volume rather than spend.
 */
export function projectAnalyticsPayload<
  T extends {
    series: Array<Record<string, unknown>>;
    previous: Array<Record<string, unknown>>;
    modelSpend: { groups: unknown[]; points: unknown[] };
    users: Array<Record<string, unknown>>;
    keys: Array<Record<string, unknown>>;
    providers: Array<Record<string, unknown>>;
    protocols: Array<Record<string, unknown>>;
  },
>(report: T, policy: FinancialPolicy): T {
  if (policy.budgetPresentation === "usd") return report;
  return {
    ...report,
    series: report.series.map(stripCostRow),
    previous: report.previous.map(stripCostRow),
    modelSpend: { groups: [], points: [] },
    users: rankByVolume(report.users),
    keys: rankByVolume(report.keys),
    providers: report.providers.map(stripCostRow),
    protocols: report.protocols.map(stripCostRow),
  };
}

/**
 * Drop monetary sort and filter predicates when the caller is not allowed to see
 * USD values, preventing threshold/ranking probes from acting as a spend oracle.
 */
export function sanitizeGridForPolicy<
  T extends {
    sort?: Array<{ colId: string; sort: string }>;
    filters?: Record<string, { filterType?: string; type?: string; filter?: unknown; filterTo?: unknown }>;
  },
>(grid: T, policy: FinancialPolicy): T {
  if (policy.budgetPresentation === "usd") return grid;
  const sort = grid.sort?.filter((entry) => !isMoneyKey(entry.colId));
  let filters: T["filters"] = undefined;
  if (grid.filters) {
    const kept = Object.entries(grid.filters).filter(([colId]) => !isMoneyKey(colId));
    if (kept.length > 0) filters = Object.fromEntries(kept);
  }
  return {
    ...grid,
    sort: sort?.length ? sort : undefined,
    filters,
  };
}

