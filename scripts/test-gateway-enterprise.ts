/** Real HTTP capacity gate. This entry is intentionally outside bun:test.
 *
 * Native Bun >=1.4.2, production dist/:
 *   bun scripts/test-gateway-enterprise.ts --seed-only --dir=tmp/enterprise
 *   bun scripts/test-gateway-enterprise.ts --reuse --dir=tmp/enterprise
 *   bun scripts/test-gateway-enterprise.ts --full --dir=tmp/enterprise-full
 *   bun scripts/test-gateway-enterprise.ts --reuse --dir=tmp/enterprise --serve
 *
 * Default history covers ten calendar years for 500 employees × 500 calls/day.
 * Quick raw retention is 2 days; --full physically retains 90 days (22.5M events)
 * and 30 days of settled billing reservations (7.5M). Both retain the same full
 * daily/monthly history. Reports disclose cardinality and hardware. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cpus } from "node:os";
import { createEnterpriseFixture, enterpriseDefaults, enterpriseMachine, enterpriseRequest, fixturePath,
  loadEnterpriseFixture, startEnterpriseStack, type EnterpriseStack } from "./enterprise-fixture";

const args = process.argv.slice(2);
const arg = (name: string) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const integer = (name: string, fallback: number) => {
  const value = Number(arg(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const full = args.includes("--full"), baseScenario = enterpriseDefaults(full);
const users = integer("users", baseScenario.users), days = integer("days", baseScenario.days);
const scenario = { ...baseScenario, users, days, requestsPerUserDay: integer("requests-per-user-day", baseScenario.requestsPerUserDay),
  rawDays: Math.min(days, integer("raw-days", baseScenario.rawDays)), auditDays: Math.min(days, baseScenario.auditDays),
  reservationDays: Math.min(days, integer("reservation-days", baseScenario.reservationDays)) };
const specifiedDir = arg("dir") ? path.resolve(arg("dir")!) : undefined;
const samples = integer("samples", 1200), rate = integer("rate", 32), dashboardLimitMs = integer("dashboard-p99", 1000), apiLimitMs = integer("api-p99", 100);
const reportFile = arg("report") ? path.resolve(arg("report")!) : undefined;
type Sample = { route: string; status: number; totalMs: number; upstreamMs: number; overheadMs: number; schedulingDelayMs: number; bytes: number; error?: string };
const report: Record<string, unknown> = { machine: enterpriseMachine(), startedAt: new Date().toISOString(), dashboardP99LimitMs: dashboardLimitMs, apiAddedP99LimitMs: apiLimitMs };
const failures: string[] = [];
const emit = (name: string, value: unknown) => { report[name] = value; console.log(JSON.stringify({ name, value })); if (reportFile) { mkdirSync(path.dirname(reportFile), { recursive: true }); writeFileSync(reportFile, JSON.stringify(report, null, 2)); } };

function percentile(sorted: number[], p: number): number { return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0; }
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, .5), p95: percentile(sorted, .95), p99: percentile(sorted, .99), max: sorted.at(-1) ?? 0 };
}
function basicSummary(rows: Sample[]) {
  const statuses: Record<string, number> = {};
  for (const row of rows) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  return { n: rows.length, statuses, totalMs: distribution(rows.map((row) => row.totalMs)), addedMs: distribution(rows.map((row) => row.overheadMs)),
    schedulingDelayMs: distribution(rows.map((row) => row.schedulingDelayMs)), errors: rows.filter((row) => row.status !== 200).length };
}

function summarize(rows: Sample[]) {
  const labels = [...new Set(rows.map((row) => row.route))];
  return { ...basicSummary(rows), byRoute: labels.map((route) => ({ route, ...basicSummary(rows.filter((row) => row.route === route)) })),
    failedSamples: rows.filter((row) => row.status !== 200).slice(0, 20) };
}

async function measure(stack: EnterpriseStack, route: string, token: string, body?: unknown, intendedAt = performance.now()): Promise<Sample> {
  const start = performance.now();
  const routeLabel = route.split("?")[0]!;
  const sampleId = body === undefined ? undefined : crypto.randomUUID();
  try {
    const response = await fetch(`${stack.base}${route}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify({ ...body as Record<string, unknown>, __enterpriseSampleId: sampleId }), signal: AbortSignal.timeout(15_000) });
    const buffer = await response.arrayBuffer(), bytes = buffer.byteLength;
    const totalMs = performance.now() - intendedAt, rawUpstream = response.headers.get("x-enterprise-upstream-ms");
    const upstreamMs = (sampleId ? stack.upstreamDuration(sampleId) : undefined) ?? (rawUpstream === null ? 0 : Number(rawUpstream));
    return { route: routeLabel, status: response.status, bytes, totalMs, upstreamMs, overheadMs: Math.max(0, totalMs - upstreamMs), schedulingDelayMs: Math.max(0, start - intendedAt),
      ...(response.ok ? {} : { error: new TextDecoder().decode(buffer).slice(0, 512) }) };
  } catch (error) {
    const totalMs = performance.now() - intendedAt;
    return { route: routeLabel, status: 0, bytes: 0, totalMs, upstreamMs: 0, overheadMs: totalMs, schedulingDelayMs: Math.max(0, start - intendedAt), error: error instanceof Error ? error.message : String(error) };
  }
}

/** Open-loop arrivals retain scheduler and queue delay instead of concealing
 * overload behind workers that issue the next request only after a response. */
async function arrivals(count: number, perSecond: number, operation: (index: number, intendedAt: number) => Promise<Sample>): Promise<Sample[]> {
  const start = performance.now() + 25, pending: Promise<Sample>[] = [];
  for (let i = 0; i < count; i++) {
    const intendedAt = start + i * 1000 / perSecond;
    const remaining = intendedAt - performance.now();
    if (remaining > 0) await Bun.sleep(remaining);
    pending.push(operation(i, intendedAt));
  }
  return Promise.all(pending);
}

async function bounded<T>(count: number, concurrency: number, operation: (index: number) => Promise<T>): Promise<T[]> {
  let next = 0; const results: T[] = [];
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => { while (next < count) { const index = next++; results[index] = await operation(index); } }));
  return results;
}

async function checkAccuracy(stack: EnterpriseStack) {
  const fixture = stack.fixture, to = fixture.seededAt + 1;
  const history = await enterpriseRequest(stack.base, `/api/admin/stats?from=all&to=${to}`, fixture.admin.accessToken);
  assert.equal(history.status, 200, "Ten-year stats must complete successfully before latency measurements");
  const represented = (history.json.series ?? []).reduce((sum: number, row: { reqs: number }) => sum + row.reqs, 0);
  assert.equal(represented, fixture.expectedRequests, "Long history must retain every accounted request");
  const db = new Database(path.join(fixture.dir, "gateway.db"), { readonly: true });
  try {
    const oldestRaw = Math.floor(fixture.seededAt / 86_400_000) * 86_400_000 - (fixture.scenario.rawDays - 1) * 86_400_000;
    const from = Math.max(fixture.seededAt - 14 * 86_400_000 + 123, oldestRaw + 123), user = fixture.users[0]!;
    const expected = db.query<{ n: number }, [string, number, number]>("SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND ts>=? AND ts<?").get(user.id, from, to)!.n;
    const actual = await enterpriseRequest(stack.base, `/api/usage/overview?from=${from}&to=${to}`, user.accessToken);
    assert.equal(actual.status, 200, "Partial-day overview must complete successfully");
    const observed = (actual.json.series ?? []).reduce((sum: number, row: { reqs: number }) => sum + row.reqs, 0);
    assert.equal(observed, expected, "Partial ranges must match independently counted retained raw events");
    emit("accuracy", { historicalRequests: represented, partialUserRequests: observed });
  } finally { db.close(); }
}

function dashboardRoute(index: number, admin: boolean, now: number): string {
  const day = 86_400_000;
  const periods = [60 * 60_000, day, 14 * day, 90 * day, 365 * day, null];
  const span = periods[index % periods.length]!;
  // Millisecond offsets exercise independent uncached ranges, like new page
  // loads; complete-day ranges are measured separately as an explicit control.
  const to = now - index % 1000;
  const scope = new URLSearchParams({ from: span === null ? "all" : String(to - span), to: String(to) }).toString();
  if (admin) {
    const routes = [`/api/admin/stats?${scope}`, `/api/admin/analytics?${scope}`, "/api/admin/users?limit=50", "/api/admin/keys?limit=50", "/api/admin/audit?limit=50", `/api/admin/usage-filter-options?${scope}`];
    return routes[Math.floor(index / periods.length) % routes.length]!;
  }
  const routes = [`/api/usage/overview?${scope}`, `/api/usage/analytics?${scope}`, `/api/usage/events?${scope}&limit=50`, `/api/usage/filter-options?${scope}`, "/api/keys", "/api/billing"];
  return routes[Math.floor(index / periods.length) % routes.length]!;
}

let stack: EnterpriseStack | undefined;
try {
  const fixture = args.includes("--reuse")
    ? loadEnterpriseFixture(specifiedDir ?? (() => { throw new Error("--reuse requires --dir"); })())
    : await createEnterpriseFixture(scenario, specifiedDir);
  emit("fixture", { dir: fixture.dir, scenario: fixture.scenario, representedRequests: fixture.expectedRequests, schemaVersion: fixture.schemaVersion });
  if (!args.includes("--seed-only")) {
    stack = await startEnterpriseStack(fixture);
    if (args.includes("--serve")) {
      emit("server", { base: stack.base, fixture: fixturePath(fixture.dir) });
      await new Promise<void>((resolve) => { process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); });
    } else {
      await checkAccuracy(stack);
      const active = stack;
      await bounded(50, 10, (index) => measure(active, "/v1/chat/completions", fixture.users[index % fixture.users.length]!.key,
        { model: "enterprise-fast", messages: [{ role: "user", content: "Warmup" }], max_tokens: 64 }));
      const apiRows = await arrivals(samples, rate, (index, intendedAt) => measure(active, "/v1/chat/completions", fixture.users[index % fixture.users.length]!.key,
        { model: "enterprise-fast", messages: [{ role: "user", content: `Capacity sample ${index}` }], max_tokens: 64 }, intendedAt));
      const api = summarize(apiRows); emit("api", { arrivalRate: rate, ...api });
      if (api.errors || api.addedMs.p99 > apiLimitMs) failures.push(`API p99=${api.addedMs.p99.toFixed(1)}ms; errors=${api.errors}`);
      if (apiRows.some((row) => row.status === 200 && row.upstreamMs <= 0)) failures.push("Missing per-request upstream timing; overhead measurement is invalid");
      const dashboardNow = Date.now(), dashboardRows = await arrivals(samples, Math.min(rate, 12), (index, intendedAt) => {
        const admin = index % 5 === 0;
        return measure(active, dashboardRoute(index, admin, dashboardNow), admin ? fixture.admin.accessToken : fixture.users[index % fixture.users.length]!.accessToken, undefined, intendedAt);
      });
      const dashboard = summarize(dashboardRows); emit("dashboard", dashboard);
      if (dashboard.errors || dashboard.totalMs.p99 > dashboardLimitMs) failures.push(`Dashboard API p99=${dashboard.totalMs.p99.toFixed(1)}ms; errors=${dashboard.errors}`);
      const burst = await bounded(Math.min(50, fixture.users.length), 50, (index) => measure(active, `/api/usage/analytics?from=${Date.now() - 14 * 86_400_000}&to=${Date.now() - index}`, fixture.users[index]!.accessToken));
      const burstSummary = summarize(burst); emit("dashboardBurst", burstSummary);
      if (burstSummary.errors || burstSummary.totalMs.p99 > dashboardLimitMs) failures.push(`Dashboard burst p99=${burstSummary.totalMs.p99.toFixed(1)}ms; errors=${burstSummary.errors}`);
      emit("result", { passed: failures.length === 0, failures, samples, arrivalRate: rate, logicalCpus: cpus().length });
      if (failures.length) process.exitCode = 1;
    }
  }
} catch (error) {
  emit("failure", { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exitCode = 1;
} finally {
  await stack?.stop();
  if (!reportFile && specifiedDir && existsSync(specifiedDir)) writeFileSync(path.join(specifiedDir, "capacity-report.json"), JSON.stringify(report, null, 2));
}
