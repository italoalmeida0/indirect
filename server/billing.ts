import { audit, db, inImmediateTx, type ApiKeyRow, type ModelRow } from "./db";
import { yieldToEventLoop } from "./batch-delete";
import { randomToken } from "./crypto";
import { ApiError } from "./http";
import { scheduleMaintenance } from "./maintenance";
import { currentRequestId } from "./request-context";
import { isRetryableSqliteError, retrySqlite } from "./sqlite-retry";
import { requireKeyProject } from "./projects";
import { allowedModels, modelAllowed } from "./model-policy";
import { enqueueUsage } from "./usage-outbox";
import type { UsageEvent } from "./usage";
import { LIMITS } from "./config";

const NANO = 1_000_000_000;
const DAY = 86_400_000;
const SESSION = 5 * 3_600_000;
const MAX_DATE = 8_640_000_000_000_000;
const MEDIA_TYPES = new Set(["image", "input_image", "audio", "input_audio", "file", "input_file", "document", "video"]);
type Kind = "monthly" | "weekly" | "session" | "daily" | "lifetime";
interface Period { scope: "key" | "user" | "project"; owner: string; kind: Kind; start: number; end: number; limit: string | null }
interface Counter { spent: string; reserved: string; forgiven: string }
interface PlanRow { id: string; name: string; monthly_nanos: number | null; weekly_enabled: number; session_enabled: number; created_at: number; updated_at: number }
interface Account { plan_id: string | null; assignment_version: number; session_start: number | null }
interface Pricing { model: string; input: string; cache: string; write: string; output: string; request: string; known: boolean }
export interface Charge { input: bigint; cache: bigint; output: bigint }
interface Hold { id: string; request_id: string | null; key_id: string; user_id: string; created_at: number; project_id: string | null; cost_center_id: string | null; request_proto: UsageEvent["proto"] | null; request_model: string | null; request_stream: number; amount_nanos: number; unit_nanos: number; uncertain_nanos: number; periods: string; pricing: string; state: string; cost_in_nanos: number | null; cost_cache_nanos: number | null; cost_out_nanos: number | null }
const getAccount = db.prepare<Account, [string]>("SELECT * FROM user_billing WHERE user_id = ?");
const getPlan = db.prepare<PlanRow, [string]>("SELECT * FROM billing_plans WHERE id = ?");
const getCounter = db.prepare<Counter, [string, string, string, number]>(`SELECT CAST(spent_nanos AS TEXT) AS spent, CAST(reserved_nanos AS TEXT) AS reserved, CAST(forgiven_nanos AS TEXT) AS forgiven FROM billing_periods WHERE scope = ? AND owner_id = ? AND kind = ? AND starts_at = ?`);
const ensureCounter = db.prepare(`INSERT OR IGNORE INTO billing_periods(scope, owner_id, kind, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)`);
const reserveCounter = db.prepare("UPDATE billing_periods SET reserved_nanos = reserved_nanos + ? WHERE scope = ? AND owner_id = ? AND kind = ? AND starts_at = ?");
const settleCounter = db.prepare("UPDATE billing_periods SET spent_nanos = spent_nanos + ?, reserved_nanos = reserved_nanos - ? WHERE scope = ? AND owner_id = ? AND kind = ? AND starts_at = ?");
const getHold = db.prepare<Hold, [string]>("SELECT * FROM billing_reservations WHERE id = ?");
const freshKey = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?");
const ownerStatus = db.prepare<{ status: string; role: string }, [string]>("SELECT status, role FROM users WHERE id = ?");
const insertHold = db.prepare("INSERT INTO billing_reservations(id, request_id, instance_id, key_id, user_id, created_at, amount_nanos, periods, pricing, project_id, cost_center_id, request_proto, request_model, request_stream, unit_nanos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const settleHold = db.prepare("UPDATE billing_reservations SET state = ?, settled_at = ?, cost_in_nanos = ?, cost_cache_nanos = ?, cost_out_nanos = ? WHERE id = ? AND state = 'pending'");
const usd = (amount: bigint | number | string) => Number(amount) / NANO;
// Parse the canonical decimal representation before scaling. Multiplying a
// binary float then applying ceil can turn exactly one nanodollar into two.
function decimalUnits(value: number, scale: number): bigint {
  const [coefficient, exponent = "0"] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const shift = scale + Number(exponent) - fraction.length;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (digits + divisor - 1n) / divisor;
}
const nanos = (amount: number) => decimalUnits(amount, 9);
const empty: Counter = { spent: "0", reserved: "0", forgiven: "0" };

/** Dashboard amounts are USD; persistence and enforcement use integer nanodollars.
 * SQLite retains int64 totals; reads use TEXT so JS never rounds a large ledger. */
export function readUsd(body: Record<string, unknown>, field: string, optional = true): number | null {
  const value = body[field];
  if (value === null || value === undefined) {
    if (optional) return null;
    throw new ApiError(400, `${field} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000 || Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) > 0.0001) throw new ApiError(400, `${field} must be USD between 0 and 1,000,000 with at most six decimal places`);
  return Number(nanos(value));
}

export function planDto(plan: PlanRow) {
  return { id: plan.id, name: plan.name, monthlyUsd: plan.monthly_nanos === null ? null : usd(plan.monthly_nanos), weeklyEnabled: !!plan.weekly_enabled, sessionEnabled: !!plan.session_enabled, createdAt: plan.created_at, updatedAt: plan.updated_at };
}
export function listPlans() {
  return db.query<PlanRow & { members: number }, []>("SELECT p.*, (SELECT COUNT(*) FROM user_billing b WHERE b.plan_id = p.id) AS members FROM billing_plans p ORDER BY p.created_at, p.id LIMIT 500").all().map((p) => ({ ...planDto(p), members: p.members }));
}
export function requirePlan(id: unknown): string | null {
  if (id === null || id === undefined || id === "") return null;
  if (typeof id !== "string" || !getPlan.get(id)) throw new ApiError(400, "Unknown plan");
  return id;
}
export function assignPlan(userId: string, planId: string | null) {
  db.prepare(`INSERT INTO user_billing(user_id, plan_id, assignment_version) VALUES (?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, assignment_version = assignment_version + CASE WHEN plan_id IS NOT excluded.plan_id THEN 1 ELSE 0 END`).run(userId, planId);
}

function periods(key: ApiKeyRow | null, userId: string, now: number, startSession: boolean): { periods: Period[]; plan: PlanRow | null; account: Account } {
  const account = getAccount.get(userId) ?? { plan_id: null, assignment_version: 0, session_start: null };
  const plan = account.plan_id ? getPlan.get(account.plan_id) : null;
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const dayStart = Math.floor(now / DAY) * DAY;
  const weekStart = dayStart - (date.getUTCDay() + 6) % 7 * DAY;
  const monthly = plan?.monthly_nanos === null || !plan ? null : BigInt(plan.monthly_nanos);
  const share = (duration: number) => monthly === null ? null : (monthly * BigInt(duration) / BigInt(monthEnd - monthStart)).toString();
  const result: Period[] = [
    { scope: "user", owner: userId, kind: "monthly", start: monthStart, end: monthEnd, limit: monthly?.toString() ?? null },
    { scope: "user", owner: userId, kind: "weekly", start: weekStart, end: weekStart + 7 * DAY, limit: plan?.weekly_enabled ? share(7 * DAY) : null },
  ];
  if (plan?.session_enabled) {
    if (account.session_start === null || now >= account.session_start + SESSION) {
      account.session_start = startSession ? now : null;
      if (startSession) db.prepare("UPDATE user_billing SET session_start = ? WHERE user_id = ?").run(now, userId);
    }
    result.push({ scope: "user", owner: userId, kind: "session", start: account.session_start ?? now, end: (account.session_start ?? now) + SESSION, limit: share(SESSION) });
  }
  if (key) result.push(
    { scope: "key", owner: key.id, kind: "daily", start: dayStart, end: dayStart + DAY, limit: key.daily_usd_nanos == null ? null : String(key.daily_usd_nanos) },
    { scope: "key", owner: key.id, kind: "lifetime", start: 0, end: MAX_DATE, limit: key.total_usd_nanos == null ? null : String(key.total_usd_nanos) },
  );
  return { periods: result, plan: plan ?? null, account };
}

const snapshot = (period: Period) => {
  const c = getCounter.get(period.scope, period.owner, period.kind, period.start) ?? empty;
  const spent = BigInt(c.spent), forgiven = BigInt(c.forgiven), reserved = BigInt(c.reserved);
  const limit = period.limit === null ? null : BigInt(period.limit);
  return { kind: period.kind, startsAt: period.start, resetsAt: period.kind === "lifetime" ? null : period.end, limitUsd: limit === null ? null : usd(limit), spentUsd: usd(spent - forgiven), billedUsd: usd(spent), reservedUsd: usd(reserved), remainingUsd: limit === null ? null : usd(limit > spent - forgiven + reserved ? limit - spent + forgiven - reserved : 0n) };
};
export function billingStatus(userId: string, now = Date.now()) {
  const state = periods(null, userId, now, false);
  const grants = db.query<{ id: string; kind: string; remaining: number; expires_at: number | null; note: string }, [string, number, number]>(`SELECT id, kind, remaining, expires_at, note FROM billing_reset_grants WHERE user_id = ? AND assignment_version = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at LIMIT 100`).all(userId, state.account.assignment_version, now);
  return { plan: state.plan ? planDto(state.plan) : null, windows: state.periods.filter((p) => p.kind === "monthly" || p.limit !== null).map(snapshot), sessionStarted: state.account.session_start !== null, resets: grants.map((g) => ({ id: g.id, kind: g.kind, remaining: g.remaining, expiresAt: g.expires_at, note: g.note })), serverTime: now };
}
export function keySpend(keyId: string, now = Date.now()) {
  const daily = getCounter.get("key", keyId, "daily", Math.floor(now / DAY) * DAY) ?? empty;
  const total = getCounter.get("key", keyId, "lifetime", 0) ?? empty;
  return { today: usd(daily.spent), total: usd(total.spent), reservedToday: usd(daily.reserved), reservedTotal: usd(total.reserved) };
}

function pricing(model: ModelRow | undefined, inputOnly: boolean): Pricing {
  const rate = (value: number | null | undefined) => {
    if (value == null) return "0";
    if (!Number.isFinite(value) || value < 0 || value > 1000) throw new ApiError(503, "Model pricing is outside the supported billing range");
    return String(decimalUnits(value, 12));
  };
  let request = 0;
  try { request = Number(JSON.parse(model?.pricing ?? "{}").request ?? 0); } catch {}
  return { model: model?.id ?? "", input: rate(model?.pricing_input), cache: rate(model?.pricing_input_cache ?? model?.pricing_input), write: rate(model?.pricing_input_cache_write ?? model?.pricing_input), output: rate(model?.pricing_output), request: rate(request), known: model?.pricing_input != null && (inputOnly || model?.pricing_output != null) };
}
const priceTokens = (tokens: number, rate: string) => (BigInt(Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0))) * BigInt(rate) + 999n) / 1000n;

function containsMedia(body: Record<string, unknown>): boolean {
  const stack: unknown[] = [body.messages, body.input, body.prompt, body.attachments];
  let visited = 0;
  while (stack.length) {
    if (++visited > 100_000) return true;
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { if (value.length + stack.length > 100_000) return true; for (const child of value) stack.push(child); continue; }
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && MEDIA_TYPES.has(record.type)) return true;
    if (record.image_url || record.audio_url || record.file_id || record.file_url || record.file_data || record.video_url) return true;
    for (const child of Object.values(record)) if (child && typeof child === "object") stack.push(child);
  }
  return false;
}

export class BudgetError extends ApiError {
  retryAfter: number;
  constructor(period: Period) {
    super(429, `Insufficient available USD in ${period.scope === "user" ? "account" : period.scope === "project" ? "project or cost center" : "API key"} ${period.kind === "session" ? "5-hour" : period.kind} budget. In-flight requests reserve balance; a lower output maximum may fit.`, `budget_${period.kind}`);
    this.retryAfter = period.kind === "lifetime" ? 0 : Math.max(1, Math.ceil((period.end - Date.now()) / 1000));
  }
}

/** One short IMMEDIATE transaction checks every cap and reserves all windows.
 * No token balance, stale usage cache, or raw-event scan participates. */
export function reserveBudget(key: ApiKeyRow, model: ModelRow | undefined, body: Record<string, unknown>, bodyBytes: number, inputOnly = false, trustOutputCap = true, now = Date.now(), requestId?: string, expected?: { projectId: string | null; costCenterId: string | null; proto?: UsageEvent["proto"]; stream?: boolean }): string {
  return db.transaction(() => {
    const fresh = freshKey.get(key.id);
    const owner = ownerStatus.get(key.user_id);
    if (!fresh || fresh.user_id !== key.user_id || fresh.status === "revoked" || (fresh.expires_at !== null && fresh.expires_at <= now) || owner?.status !== "active") throw new ApiError(401, "API key or account unavailable");
    const assignment = requireKeyProject(key.user_id, fresh.project_id ?? null);
    const projectId = assignment?.project.id ?? null, costCenterId = assignment?.costCenter?.id ?? null;
    if (expected && (expected.projectId !== projectId || expected.costCenterId !== costCenterId)) throw new ApiError(409, "API key project changed; retry the request");
    if (typeof body.model === "string" && !modelAllowed(allowedModels({ role: owner.role, projectId }), body.model)) throw new ApiError(404, `unknown model '${body.model}'`, "model_not_found");
    const state = periods(fresh, key.user_id, now, true);
    const date = new Date(now), monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    for (const project of [assignment?.project, assignment?.costCenter]) if (project) {
      state.periods.push(
        { scope: "project", owner: project.id, kind: "monthly", start: monthStart, end: monthEnd, limit: project.monthly_nanos === null ? null : String(project.monthly_nanos) },
        { scope: "project", owner: project.id, kind: "lifetime", start: 0, end: MAX_DATE, limit: project.total_nanos === null ? null : String(project.total_nanos) },
      );
    }
    const limited = state.periods.some((p) => p.limit !== null);
    const price = pricing(model, inputOnly);
    if (!price.model && typeof body.model === "string") price.model = body.model.slice(0, 128);
    if (limited && !price.known) throw new ApiError(503, "USD budgets require configured input and output pricing for this model", "model_pricing_unavailable");
    const rawMax = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
    if (limited && rawMax !== undefined && (typeof rawMax !== "number" || !Number.isSafeInteger(rawMax) || rawMax < 1 || rawMax > 1_000_000_000)) throw new ApiError(400, "Output maximum must be a positive integer", "invalid_output_limit");
    const copies = body.n ?? 1;
    if (limited && (typeof copies !== "number" || !Number.isSafeInteger(copies) || copies < 1 || copies > 128)) throw new ApiError(400, "n must be between 1 and 128", "invalid_output_limit");
    const output = inputOnly ? 0 : trustOutputCap && typeof rawMax === "number" && rawMax > 0 ? rawMax : model?.max_output_length ?? model?.context_length ?? 0;
    if (limited && !inputOnly && !output) throw new ApiError(400, "Set an output maximum or configure the model output limit before using a USD budget", "output_limit_required");
    // Text bytes plus generous protocol/tool framing form a conservative bound.
    // Stateful/media inputs use the full registered context instead.
    const media = !!body.previous_response_id || containsMedia(body);
    if (limited && media && !model?.context_length) throw new ApiError(400, "Stateful and media requests need a registered context length with USD budgets", "context_limit_required");
    const framing = 256 * (16 + (Array.isArray(body.messages) ? body.messages.length : 0) + (Array.isArray(body.tools) ? body.tools.length : 0));
    const input = media ? model?.context_length ?? bodyBytes + framing : Math.min(model?.context_length ?? Infinity, bodyBytes + framing);
    const maxInputRate = [price.input, price.cache, price.write].map(BigInt).reduce((a, b) => a > b ? a : b).toString();
    const amount = priceTokens(input, maxInputRate) + priceTokens(output * (typeof copies === "number" ? copies : 1), price.output) + priceTokens(1, price.request);
    if (amount > 9_000_000_000_000_000n) throw new ApiError(400, "Request cost bound is too large", "request_cost_too_large");
    for (const p of state.periods) {
      ensureCounter.run(p.scope, p.owner, p.kind, p.start, p.end);
      const c = getCounter.get(p.scope, p.owner, p.kind, p.start)!;
      if (p.limit !== null && BigInt(c.spent) - BigInt(c.forgiven) + BigInt(c.reserved) + amount > BigInt(p.limit)) throw new BudgetError(p);
    }
    const id = randomToken(16);
    const correlationId = (requestId ?? currentRequestId()) || null;
    insertHold.run(id, correlationId, instanceId, key.id, key.user_id, now, amount, JSON.stringify(state.periods), JSON.stringify(price), projectId, costCenterId, expected?.proto ?? null, typeof body.model === "string" ? body.model.slice(0, 128) : null, expected?.stream ? 1 : 0, amount);
    for (const p of state.periods) reserveCounter.run(amount, p.scope, p.owner, p.kind, p.start);
    return id;
  }).immediate();
}

/** A dispatched attempt with no trustworthy result consumes its conservative
 * bound. Persist that fact before considering any fallback. */
export function markUncertainAttempt(id: string): void {
  db.transaction(() => {
    const row = getHold.get(id);
    if (!row || row.state !== "pending") throw new ApiError(503, "reservation is no longer pending");
    if (BigInt(row.uncertain_nanos) + BigInt(row.unit_nanos) > BigInt(row.amount_nanos)) throw new ApiError(503, "reservation has no active attempt");
    db.prepare("UPDATE billing_reservations SET uncertain_nanos = uncertain_nanos + unit_nanos WHERE id = ? AND state = 'pending'").run(id);
  }).immediate();
}

/** Reserve a fresh unit before retrying an ambiguous attempt. The original
 * period keys and scope IDs stay frozen; current caps and authorization are
 * rechecked so a later reduction/revocation cannot be bypassed. */
export function reserveNextAttempt(id: string): void {
  db.transaction(() => {
    const row = getHold.get(id);
    if (!row || row.state !== "pending") throw new ApiError(503, "reservation is no longer pending");
    const uncertain = BigInt(row.uncertain_nanos), amount = BigInt(row.amount_nanos), unit = BigInt(row.unit_nanos);
    if (uncertain !== amount) throw new ApiError(503, "reservation already has an active attempt");
    if (amount + unit > 9_000_000_000_000_000n) throw new ApiError(429, "The request's conservative failover budget is exhausted", "budget_failover");
    const key = freshKey.get(row.key_id), owner = ownerStatus.get(row.user_id);
    if (!key || key.user_id !== row.user_id || key.status === "revoked" || (key.expires_at !== null && key.expires_at <= Date.now()) || owner?.status !== "active") throw new ApiError(401, "API key or account unavailable");
    const assignment = requireKeyProject(row.user_id, key.project_id ?? null);
    if ((assignment?.project.id ?? null) !== row.project_id || (assignment?.costCenter?.id ?? null) !== row.cost_center_id) throw new ApiError(409, "API key project changed; retry the request");
    if (row.request_model && !modelAllowed(allowedModels({ role: owner.role, projectId: row.project_id }), row.request_model)) throw new ApiError(404, `unknown model '${row.request_model}'`, "model_not_found");
    const current = periods(key, row.user_id, row.created_at, false).periods;
    const limits = new Map(current.map((p) => [`${p.scope}:${p.owner}:${p.kind}`, p.limit]));
    for (const project of [assignment?.project, assignment?.costCenter]) if (project) {
      limits.set(`project:${project.id}:monthly`, project.monthly_nanos === null ? null : String(project.monthly_nanos));
      limits.set(`project:${project.id}:lifetime`, project.total_nanos === null ? null : String(project.total_nanos));
    }
    const frozen = JSON.parse(row.periods) as Period[];
    for (const p of frozen) {
      const limit = limits.get(`${p.scope}:${p.owner}:${p.kind}`) ?? null;
      const counter = getCounter.get(p.scope, p.owner, p.kind, p.start) ?? empty;
      if (limit !== null && BigInt(counter.spent) - BigInt(counter.forgiven) + BigInt(counter.reserved) + unit > BigInt(limit)) throw new BudgetError({ ...p, limit });
    }
    db.prepare("UPDATE billing_reservations SET amount_nanos = amount_nanos + unit_nanos WHERE id = ? AND state = 'pending'").run(id);
    for (const p of frozen) reserveCounter.run(unit, p.scope, p.owner, p.kind, p.start);
  }).immediate();
}

function uncertainEvent(row: Hold, charge: Charge, status: number): UsageEvent | undefined {
  // Reservations created before this migration have no trustworthy protocol;
  // do not invent one. New reservations retain the request's original values.
  if (!row.request_proto) return undefined;
  return { keyId: row.key_id, userId: row.user_id, projectId: row.project_id, costCenterId: row.cost_center_id,
    proto: row.request_proto, model: row.request_model ?? "", ts: row.created_at,
    inTok: 0, cacheTok: 0, outTok: 0, latencyMs: Math.max(0, Math.min(2_147_483_647, Date.now() - row.created_at)),
    status, stream: !!row.request_stream, estimated: true, requestId: row.request_id ?? undefined, charge };
}

function finish(id: string, charge: Charge, recovered = false, event?: Omit<UsageEvent, "charge">): Charge {
  const row = getHold.get(id);
  if (!row || row.state !== "pending") return { input: 0n, cache: 0n, output: 0n };
  const prior = BigInt(row.uncertain_nanos);
  charge = { ...charge, input: charge.input + prior };
  if (charge.input + charge.cache + charge.output > 9_000_000_000_000_000n) {
    charge = { input: BigInt(row.amount_nanos), cache: 0n, output: 0n };
    if (event) event = { ...event, estimated: true };
  }
  const total = charge.input + charge.cache + charge.output;
  for (const p of JSON.parse(row.periods) as Period[]) settleCounter.run(total, BigInt(row.amount_nanos), p.scope, p.owner, p.kind, p.start);
  const delivery = event ? { ...event, estimated: event.estimated || prior > 0n, charge } : recovered || prior > 0n ? uncertainEvent(row, charge, 599) : undefined;
  if (delivery) enqueueUsage(delivery, `reservation_${id}`);
  settleHold.run(recovered ? "recovered" : "settled", Date.now(), charge.input, charge.cache, charge.output, id);
  if (total > BigInt(row.amount_nanos)) audit("billing.reservation.exceeded", { target: id, meta: { reservedUsd: usd(row.amount_nanos), actualUsd: usd(total) } });
  return charge;
}
export function settleBudget(id: string, usage: { inTok: number; cacheTok: number; outTok: number; cacheCreation?: number }, event?: Omit<UsageEvent, "charge">): Charge {
  return db.transaction(() => {
    const row = getHold.get(id);
    if (!row || row.state !== "pending") return { input: 0n, cache: 0n, output: 0n };
    if ([usage.inTok, usage.cacheTok, usage.outTok, usage.cacheCreation ?? 0].some((count) => !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000)) {
      audit("billing.usage.invalid", { target: id });
      return finish(id, { input: BigInt(row.amount_nanos) - BigInt(row.uncertain_nanos), cache: 0n, output: 0n }, false, event ? { ...event, estimated: true } : undefined);
    }
    const p = JSON.parse(row.pricing) as Pricing;
    const writes = Math.max(0, Math.min(usage.cacheTok, usage.cacheCreation ?? 0));
    const charge = { input: priceTokens(usage.inTok, p.input) + priceTokens(1, p.request), cache: priceTokens(usage.cacheTok - writes, p.cache) + priceTokens(writes, p.write), output: priceTokens(usage.outTok, p.output) };
    if (charge.input + charge.cache + charge.output > 9_000_000_000_000_000n) {
      audit("billing.usage.cost_out_of_range", { target: id });
      return finish(id, { input: BigInt(row.amount_nanos) - BigInt(row.uncertain_nanos), cache: 0n, output: 0n }, false, event ? { ...event, estimated: true } : undefined);
    }
    return finish(id, charge, false, event);
  }).immediate();
}
export function cancelBudget(id: string, event?: Omit<UsageEvent, "charge">): void {
  db.transaction(() => finish(id, { input: 0n, cache: 0n, output: 0n }, false, event)).immediate();
}
export function settleUncertainBudget(id: string, event?: Omit<UsageEvent, "charge">): Charge {
  return db.transaction(() => {
    const row = getHold.get(id);
    if (!row || row.state !== "pending") return { input: 0n, cache: 0n, output: 0n };
    const bounded = { input: BigInt(row.amount_nanos) - BigInt(row.uncertain_nanos), cache: 0n, output: 0n };
    const synthetic = event ? { ...event, estimated: true } : uncertainEvent(row, bounded, 499);
    const charge = finish(id, bounded, false, synthetic);
    audit("billing.reservation.cancelled_without_usage", { target: id, meta: { chargedUsd: usd(row.amount_nanos) } });
    return charge;
  }).immediate();
}

type Finalization =
  | { kind: "exact"; event: Omit<UsageEvent, "charge">; usage: { inTok: number; cacheTok: number; outTok: number; cacheCreation?: number } }
  | { kind: "cancel"; event?: Omit<UsageEvent, "charge"> }
  | { kind: "uncertain"; event?: Omit<UsageEvent, "charge"> };
interface FinalizationRetry { job: Finalization; failures: number; timer?: ReturnType<typeof setTimeout> }
const finalizationRetries = new Map<string, FinalizationRetry>();
// Requests already admitted or queued after this threshold retain a reserved
// slot in the bound. Further admissions stop until storage recovers.
const retryAdmissionLimit = 4096;
const retryHardLimit = retryAdmissionLimit + LIMITS.globalConcurrency + LIMITS.admissionQueueMax + 16;
export function canAcceptSettlement(): boolean { return finalizationRetries.size < retryAdmissionLimit; }

function applyFinalization(id: string, job: Finalization): void {
  if (job.kind === "exact") settleBudget(id, job.usage, job.event);
  else if (job.kind === "cancel") cancelBudget(id, job.event);
  else settleUncertainBudget(id, job.event);
}

function scheduleFinalizationRetry(id: string, entry: FinalizationRetry): void {
  const delays = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 10000, 15000];
  entry.timer = setTimeout(() => {
    try {
      applyFinalization(id, entry.job);
      finalizationRetries.delete(id);
    } catch {
      entry.failures++;
      // If exact settlement repeatedly fails, conservatively charge the held
      // bound. Keep retrying in bounded memory if storage is still unavailable.
      if (entry.failures >= delays.length && entry.job.kind !== "uncertain") entry.job = { kind: "uncertain", event: entry.job.event };
      scheduleFinalizationRetry(id, entry);
    }
  }, delays[Math.min(entry.failures, delays.length - 1)]);
  entry.timer.unref();
}

/** Complete now, or transfer ownership to the bounded retry queue. If this
 * process crashes, the still-pending durable hold recovers conservatively. */
export function finalizeBudget(id: string, job: Finalization): void {
  try { applyFinalization(id, job); }
  catch (error) {
    if (!finalizationRetries.has(id)) {
      if (finalizationRetries.size >= retryHardLimit) throw error;
      const entry = { job, failures: 0 };
      finalizationRetries.set(id, entry);
      scheduleFinalizationRetry(id, entry);
      console.error("[BILLING] settlement queued for retry:", id);
    }
  }
}

export function grantReset(userId: string, kind: string, count: number, expiresAt: number | null, note: string, actorId: string, ip: string) {
  return inImmediateTx(() => {
    const state = periods(null, userId, Date.now(), false);
    if (!state.plan || (kind !== "weekly" && kind !== "session" && kind !== "both")) throw new ApiError(400, "Choose a plan and reset window");
    if ((kind === "weekly" || kind === "both") && !state.plan.weekly_enabled || (kind === "session" || kind === "both") && !state.plan.session_enabled) throw new ApiError(400, "The selected window is not enabled on this plan");
    const id = randomToken(12);
    db.prepare("INSERT INTO billing_reset_grants(id, user_id, assignment_version, kind, remaining, expires_at, created_at, actor_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, state.account.assignment_version, kind, count, expiresAt, Date.now(), actorId, note);
    audit("billing.reset.granted", { actorId, target: userId, ip, meta: { grantId: id, kind, count, expiresAt, note } });
    return id;
  });
}
export function redeemReset(userId: string, grantId: string, requestId: string, ip: string) {
  inImmediateTx(() => {
    const used = db.query<{ user_id: string; grant_id: string }, [string]>("SELECT user_id, grant_id FROM billing_reset_uses WHERE id = ?").get(requestId);
    if (used) { if (used.user_id === userId && used.grant_id === grantId) return; throw new ApiError(409, "Reset request ID already used"); }
    const now = Date.now(), state = periods(null, userId, now, false);
    const grant = db.query<{ kind: string; assignment_version: number; expires_at: number | null; remaining: number }, [string, string]>("SELECT * FROM billing_reset_grants WHERE id = ? AND user_id = ?").get(grantId, userId);
    if (!grant || grant.remaining < 1 || grant.assignment_version !== state.account.assignment_version || grant.expires_at !== null && grant.expires_at <= now) throw new ApiError(409, "This reset is no longer available");
    let restored = false;
    for (const p of state.periods) {
      if (p.limit === null || p.kind !== "weekly" && p.kind !== "session" || grant.kind !== "both" && grant.kind !== p.kind) continue;
      const changed = db.prepare("UPDATE billing_periods SET forgiven_nanos = spent_nanos WHERE scope = 'user' AND owner_id = ? AND kind = ? AND starts_at = ? AND forgiven_nanos < spent_nanos").run(userId, p.kind, p.start);
      restored ||= changed.changes > 0;
    }
    if (!restored) throw new ApiError(409, "Your eligible windows are already full. The reset has been kept.");
    db.prepare("UPDATE billing_reset_grants SET remaining = remaining - 1 WHERE id = ?").run(grantId);
    db.prepare("INSERT INTO billing_reset_uses(id, user_id, grant_id, created_at) VALUES (?, ?, ?, ?)").run(requestId, userId, grantId, now);
    audit("billing.reset.redeemed", { actorId: userId, target: grantId, ip, meta: { kind: grant.kind } });
  });
  return billingStatus(userId);
}

const instanceId = randomToken(12);
const heartbeat = () => db.prepare("INSERT INTO billing_instances(id, heartbeat) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET heartbeat = excluded.heartbeat").run(instanceId, Date.now());

function recoverStaleReservationStep(now: number, limit: number): number {
  return db.transaction(() => {
    heartbeat();
    const stale = db
      .query<{ id: string; amount_nanos: number; uncertain_nanos: number }, [number, number]>(
        `SELECT r.id, r.amount_nanos, r.uncertain_nanos
         FROM billing_reservations r
         LEFT JOIN billing_instances i ON i.id = r.instance_id
         WHERE r.state = 'pending' AND COALESCE(i.heartbeat, r.created_at) < ?
         LIMIT ?`,
      )
      .all(now - 5 * 60_000, limit);
    for (const row of stale) {
      finish(row.id, { input: BigInt(row.amount_nanos) - BigInt(row.uncertain_nanos), cache: 0n, output: 0n }, true);
      audit("billing.reservation.recovered", { target: row.id, meta: { chargedUsd: usd(row.amount_nanos) } });
    }
    return stale.length;
  }).immediate();
}

function pruneExpiredBillingStep(now: number, batchSize: number): { periods: number; reservations: number; instances: number } {
  const periods = db.transaction(() =>
    db
      .prepare(
        `DELETE FROM billing_periods
         WHERE (scope, owner_id, kind, starts_at) IN (
           SELECT scope, owner_id, kind, starts_at
           FROM billing_periods
           WHERE ends_at < ? AND reserved_nanos = 0 AND kind <> 'lifetime'
           ORDER BY ends_at
           LIMIT ?
         )`,
      )
      .run(now - 400 * DAY, batchSize).changes,
  ).immediate();
  const reservations = db.transaction(() =>
    db
      .prepare(
        `DELETE FROM billing_reservations
         WHERE id IN (
           SELECT id FROM billing_reservations
           WHERE settled_at < ?
           ORDER BY settled_at
           LIMIT ?
         )`,
      )
      .run(now - 30 * DAY, batchSize).changes,
  ).immediate();
  const instances = db.transaction(() =>
    db
      .prepare(
        `DELETE FROM billing_instances
         WHERE id IN (
           SELECT id FROM billing_instances
           WHERE heartbeat < ?
             AND id NOT IN (SELECT instance_id FROM billing_reservations WHERE state = 'pending')
           LIMIT ?
         )`,
      )
      .run(now - DAY, batchSize).changes,
  ).immediate();
  return { periods, reservations, instances };
}

/** Uncertain requests from a crashed process retain their reservation, then
 * settle conservatively at its bound. A restart never grants free balance.
 * Bounded per call so synchronous startup never holds a multi-second write lock. */
export function recoverBudgets(now = Date.now(), batchSize = 500): void {
  const capped = Math.min(1_000, Math.max(1, Math.floor(batchSize)));
  for (let i = 0; i < 10; i++) {
    const recovered = recoverStaleReservationStep(now, 50);
    if (recovered < 50) break;
  }
  pruneExpiredBillingStep(now, capped);
}

/** Asynchronous bounded recovery + expired ledger cleanup yielding between micro-batches. */
export async function recoverBudgetsAsync(
  now = Date.now(),
  opts: { batchSize?: number; maxRows?: number } = {},
): Promise<{ recovered: number; deletedReservations: number; deletedPeriods: number }> {
  const batchSize = Math.min(1_000, Math.max(1, Math.floor(opts.batchSize ?? 500)));
  const maxRows = Math.max(batchSize, Math.floor(opts.maxRows ?? 50_000));
  let recovered = 0;
  for (let step = 0; step < 20; step++) {
    const count = recoverStaleReservationStep(now, 50);
    recovered += count;
    if (count < 50) break;
    await yieldToEventLoop();
  }
  let deletedReservations = 0;
  let deletedPeriods = 0;
  while (deletedReservations + deletedPeriods < maxRows) {
    const limit = Math.min(batchSize, maxRows - (deletedReservations + deletedPeriods));
    const step = pruneExpiredBillingStep(now, limit);
    deletedPeriods += step.periods;
    deletedReservations += step.reservations;
    if (step.periods < limit && step.reservations < limit && step.instances < limit) break;
    await yieldToEventLoop();
  }
  return { recovered, deletedReservations, deletedPeriods };
}

export function startBilling(): void {
  // Boot must survive a database that another process is currently writing.
  // A synchronous throw here happens BEFORE Bun.serve(), so it terminates the
  // process with "SQLiteError: database is locked" instead of degrading. The
  // startup pass retries transient contention with a bounded policy and, if it
  // still cannot run, defers to the scheduled jobs (the first successful
  // heartbeat establishes the lease anyway).
  try {
    retrySqlite(() => { heartbeat(); recoverBudgets(); }, { name: "billing startup" });
  } catch (error) {
    if (!isRetryableSqliteError(error)) throw error;
    console.error("[BILLING] startup maintenance deferred:", error instanceof Error ? error.message : "unknown error");
  }
  // maintenanceBatchSize keeps each job's lock hold short, and recovery yields
  // between bounded micro-transactions so large reservation backlogs never stall traffic.
  scheduleMaintenance("billing heartbeat", () => { heartbeat(); }, 15_000);
  scheduleMaintenance("billing recovery", async () => { await recoverBudgetsAsync(); }, 60_000);
}
