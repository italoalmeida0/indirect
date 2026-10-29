import { createSignal } from "solid-js";

/**
 * Typed fetch client for the gateway REST API.
 * - Attaches the bearer token automatically.
 * - On 401 with an expired access token, rotates via the refresh token once
 *   (single-flight) and retries the original request.
 * - On hard auth failure, drops the session and routes to the login page.
 */

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  hasPassword: boolean;
  googleLinked: boolean;
  totpEnabled: boolean;
  status: "active" | "banned";
  createdAt: number;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

const LS = "cache_code_session";

function loadStored(): Session | null {
  try {
    const raw = localStorage.getItem(LS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    localStorage.removeItem(LS);
    return null;
  }
}

const [session, setSessionSignal] = createSignal<Session | null>(loadStored());

let listeners: Array<(s: Session | null) => void> = [];

export function currentSession(): Session | null {
  return session();
}

/** Another tab may have rotated the pair (or logged out) — the freshest
 *  stored copy wins, so this tab never replays an already-rotated token. */
function latestSession(): Session | null {
  const stored = loadStored();
  const current = session();
  if (stored && (!current || stored.refreshToken !== current.refreshToken)) {
    setSessionSignal(stored);
  }
  if (!stored && current) setSessionSignal(null);
  return stored ?? null;
}

export function setSession(s: Session | null): void {
  // Storage BEFORE the signal: signal updates re-render synchronously, and a
  // mounted AppShell fires its first `api()` call inside that render — whose
  // latestSession() reads localStorage. If the signal went first, that read
  // found an empty store, zeroed the signal back to null mid-render (killing
  // the fresh session: no setItem, no reload, a 401 without a bearer), which
  // is exactly what happened when signing in from "/" (no #/login hash).
  if (s) localStorage.setItem(LS, JSON.stringify(s));
  else localStorage.removeItem(LS);
  setSessionSignal(s);
  for (const fn of listeners) fn(session());
}

export function onSessionChange(fn: (s: Session | null) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

let refreshPromise: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const s = latestSession();
  if (!s) return false;
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    const j = await res.json();
    if (!res.ok || !j.success) return false;
    setSession({
      accessToken: j.accessToken,
      refreshToken: j.refreshToken,
      user: j.user,
    });
    return true;
  } catch {
    return false;
  }
}

async function refreshSingleFlight(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = refresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export class ApiFail extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawCall<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  const s = latestSession();
  if (s) headers.Authorization = `Bearer ${s.accessToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  let j: any = null;
  try {
    j = await res.json();
  } catch {}
  signal?.throwIfAborted();
  if (!res.ok) throw new ApiFail(res.status, j?.error ?? `HTTP ${res.status}`);
  return j as T;
}

export async function api<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    return await rawCall<T>(method, path, body, signal);
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401 && latestSession()) {
      const ok = await refreshSingleFlight();
      if (ok) return rawCall<T>(method, path, body, signal);
      setSession(null);
    }
    throw e;
  }
}

/** Unauthenticated calls (login, reset, 2FA step). */
export async function publicApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  return rawCall<T>(method, path, body);
}

// ===== Shared DTOs =====

export interface ApiKeyDto {
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
  status: "active" | "revoked" | "exhausted" | "expired" | "daily_limit" | "total_limit";
  lastUsedAt: number | null;
  /** Settled billable spend in USD, including all priced token categories. */
  spendTodayUsd: number;
  spendTotalUsd: number;
  revealable: boolean;
}

export interface DailyPoint {
  date: string;
  /** Cache-free input tokens. */
  in_tok: number;
  /** Cached input tokens (billed at cache rate upstream). */
  cache_tok: number;
  out_tok: number;
  reqs: number;
  /** Cost in USD split by bucket + total. */
  cost_in?: number;
  cost_cache?: number;
  cost_out?: number;
  cost?: number;
  /** Hour buckets carry a short tick label ("13:00"); day buckets don't. */
  label?: string;
}

export interface TopModelDto {
  model: string;
  model_name: string;
  reqs: number;
  provider_id: string;
  provider_name: string | null;
  upstream_model: string;
  /** Distinct provider/upstream routes; the displayed route has the most requests. */
  route_count: number;
}

export interface AnalyticsEntity extends Omit<DailyPoint, "date" | "label"> {
  id: string | null;
  label: string;
  detail: string;
  members: number;
}

export interface ModelTimeline {
  groups: { id: string | null; label: string }[];
  points: { date: string; lastDate?: string; label: string; values: number[] }[];
}

export interface AnalyticsReport {
  series: DailyPoint[];
  previous: DailyPoint[];
  granularity: "minute" | "hour" | "day" | "month";
  scope: { from: number | null; to: number };
  modelSpend: ModelTimeline;
  modelRequests: ModelTimeline;
  users: AnalyticsEntity[];
  keys: AnalyticsEntity[];
  outcomes: { date: string; lastDate?: string; label: string; success: number; errors: number; unknown: number }[];
  providers: AnalyticsEntity[];
  protocols: AnalyticsEntity[];
  activeUsers: number;
}

export type AuthStyle = "bearer" | "x-api-key";

/** One upstream key of a provider (failover order). The key material itself
 *  never leaves the server. `failCount` is an admin-visible health signal
 *  only — keys are never removed from rotation automatically (only an
 *  explicit `disabled` keeps one out). `cooldownUntil`/`exhaustedReason` are
 *  legacy fields, always null on new writes. */
export interface ProviderKeyDto {
  id: string;
  label: string;
  priority: number;
  status: "active" | "disabled" | "exhausted";
  failCount: number;
  cooldownUntil: number | null;
  exhaustedReason: string | null;
  createdAt: number;
}

export interface ProviderDto {
  id: string;
  name: string;
  openaiBaseUrl: string | null;
  openaiAuthStyle: AuthStyle;
  anthropicBaseUrl: string | null;
  anthropicAuthStyle: AuthStyle;
  responsesBaseUrl: string | null;
  responsesAuthStyle: AuthStyle;
  stripParams: string[];
  enabled: boolean;
  priority: number;
  createdAt: number;
  hasApiKey: boolean;
  modelCount: number;
  /** Upstream keys in failover order (secret material never included). */
  keys: ProviderKeyDto[];
}

/** One routing target of a registered model (failover order). */
export interface ModelTargetDto {
  providerId: string;
  providerName: string | null;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
}

/** Per-capability result of a model-registry sync (best-effort). */
export interface SyncOutcome {
  added: number;
  skipped: number;
  error?: string;
}

/** Per-capability peek at a provider's GET /models (before importing). */
export interface CapPreview {
  count?: number;
  sample?: string[];
  error?: string;
}

export interface SyncPreview {
  openai?: CapPreview;
  anthropic?: CapPreview;
  /** Ids present on both lists (only when both fetches succeeded). */
  common?: number;
}

export type RoutingMode = "passthrough" | "router";

/** Per-model tool-call strategy (see server/tool-call-mode.ts). */
export type ToolCallMode = "native" | "fallback" | "workaround" | "own";

/** Admin view of a registered model (camelCase mirror of the models table). */
export interface ModelDto {
  id: string;
  providerId: string | null;
  providerName: string | null;
  upstreamModel: string;
  name: string;
  description: string;
  enabled: boolean;
  contextLength: number | null;
  maxOutputLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  samplingParams: string[];
  features: string[];
  reasoningEfforts: string[] | null;
  toolCallMode: ToolCallMode;
  pricing: Record<string, number> | null;
  pricingInput: number | null;
  pricingInputCache: number | null;
  pricingInputCacheWrite: number | null;
  pricingOutput: number | null;
  source: "auto" | "manual";
  createdAt: number;
  updatedAt: number;
  /** Ordered failover chain; the first entry mirrors providerId/upstreamModel. */
  targets: ModelTargetDto[];
}

export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  status: "active" | "banned";
  hasPassword: boolean;
  googleLinked: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  keyCount: number;
  planId?: string | null;
  planName?: string | null;
}

export interface RemoteHostDto {
  id: string;
  userId: string;
  name: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  apiKeyId: string | null;
  status: "online" | "offline" | "updating";
  lastSeenAt: number | null;
  createdAt: number;
}

export interface RemotePairDto {
  token: string;
  expiresAt: number;
  connectUrl: string;
}


export interface BillingPlanDto {
  id: string; name: string; monthlyUsd: number | null;
  weeklyEnabled: boolean; sessionEnabled: boolean; members?: number;
  createdAt: number; updatedAt: number;
}
export interface BudgetWindowDto {
  kind: "monthly" | "weekly" | "session" | "daily" | "lifetime";
  startsAt: number; resetsAt: number | null; limitUsd: number | null;
  spentUsd: number; billedUsd: number; reservedUsd: number; remainingUsd: number | null;
}
export interface BillingDto {
  plan: BillingPlanDto | null;
  windows: BudgetWindowDto[]; sessionStarted: boolean;
  resets: { id: string; kind: "weekly" | "session" | "both"; remaining: number; expiresAt: number | null; note: string }[];
  serverTime: number;
}
