/** Sustained mixed soak across scheduled maintenance.
 *
 * Native Bun >=1.4.2, production dist/, a seeded fixture:
 *   bun scripts/soak-gateway.ts --dir=tmp/enterprise-quick-3 --minutes=12 --rate=8
 *   bun scripts/soak-gateway.ts --dir=... --base=http://127.0.0.1:PORT --minutes=12
 *
 * Proxy completions and dashboard reads arrive at a steady open-loop rate while
 * the gateway's own schedule runs: analytics rollup cleanup every minute, WAL
 * checkpoint and detailed-event retention every five, billing recovery every
 * minute. The run samples `/api/admin/metrics` throughout and asserts what a
 * soak can actually prove — no server errors, no maintenance job failure,
 * bounded resident memory, and a bounded write-ahead log — and reports
 * everything it observed as JSON. It makes no claim about ten-year reliability,
 * which a finite soak cannot establish. */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cpus } from "node:os";
import { enterpriseMachine, enterpriseRequest, loadEnterpriseFixture, startEnterpriseStack } from "./enterprise-fixture";

const args = process.argv.slice(2);
const arg = (name: string) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dir = arg("dir");
if (!dir) throw new Error("--dir=<seeded fixture> is required");
const minutes = Math.max(1, Number(arg("minutes") ?? 10));
const rate = Math.max(1, Number(arg("rate") ?? 8));
const sampleMs = Math.max(1_000, Number(arg("sample-ms") ?? 15_000));
const streamShare = Math.max(0, Number(arg("stream-share") ?? 4));
const reportPath = arg("report");
const DAY = 86_400_000;
const MB = 1_048_576;

const fixture = loadEnterpriseFixture(dir);
const externalBase = arg("base");
const stack = externalBase
  ? { base: externalBase, stop: async () => {} }
  : await startEnterpriseStack(fixture);

const fileSize = (name: string) => { try { return statSync(path.join(dir, name)).size; } catch { return 0; } };
const failures: string[] = [];
const observed: Array<Record<string, unknown>> = [];
let issued = 0, ok2xx = 0, client4xx = 0, server5xx = 0, networkErrors = 0;
const statusCounts: Record<string, number> = {};
const statusByRoute: Record<string, Record<string, number>> = {};
const errorBodies = new Map<string, string>();
const slowest: Array<{ route: string; status: number; ms: number }> = [];
const streamTtfb: number[] = [], streamTotal: number[] = [], streamChunks: number[] = [], streamGap: number[] = [];
let streamFailures = 0, streamCoalesced = 0;

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};
const distribution = (values: number[]) => ({
  count: values.length,
  p50: Number(percentile(values, 0.5).toFixed(1)),
  p95: Number(percentile(values, 0.95).toFixed(1)),
  p99: Number(percentile(values, 0.99).toFixed(1)),
  max: Number((values.length ? Math.max(...values) : 0).toFixed(1)),
});

const proxyBodies = ["Overhead sample", "Steady soak request", "Mixed workload", "Background traffic"];
/** Dashboard reads with a fresh window per request, as a browsing user makes.
 * The administrative aggregate is flagged so it is issued with an
 * administrator's session — a personal session correctly gets `403 admin only`
 * from the gateway. The ordinal counts dashboard arrivals only: deriving it from
 * the global index would alias with the 1-in-4 split and reach a subset of the
 * routes. */
const dashboardRoute = (ordinal: number, now: number) => {
  const from = now - 14 * DAY;
  switch (ordinal % 6) {
    case 0: return { route: `/api/usage/overview?from=${from}&to=${now}`, admin: false };
    case 1: return { route: `/api/usage/analytics?from=${from}&to=${now}`, admin: false };
    case 2: return { route: "/api/usage/events?limit=50", admin: false };
    case 3: return { route: "/api/keys", admin: false };
    case 4: return { route: "/api/billing", admin: false };
    default: return { route: `/api/admin/stats?from=${from}&to=${now}`, admin: true };
  }
};

async function operation(index: number) {
  const user = fixture.users[index % fixture.users.length]!;
  // One in four arrivals is a dashboard read; a sixth of those is the
  // administrative aggregate, the heaviest thing a person can ask for.
  const isDashboard = index % 4 === 3;
  const picked = isDashboard
    ? dashboardRoute(Math.floor(index / 4), Date.now() - index)
    : { route: "/v1/chat/completions", admin: false };
  const route = picked.route;
  const token = picked.admin ? fixture.admin.accessToken : isDashboard ? user.accessToken : user.key;
  const body = isDashboard ? undefined : { model: "enterprise-fast", messages: [{ role: "user", content: proxyBodies[index % proxyBodies.length] }], max_tokens: 64 };
  const started = performance.now();
  // A streaming share keeps the relay exercised under load: the assertion is
  // that bytes keep arriving (first frame well before the stream closes), not
  // that the whole body lands at once.
  const streaming = !isDashboard && streamShare > 0 && index % streamShare === 0;
  try {
    if (streaming) {
      const response = await fetch(`${stack.base}${route}`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...(body as Record<string, unknown>), stream: true }), signal: AbortSignal.timeout(40_000) });
      const label = route;
      issued++;
      statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
      const perRoute = statusByRoute[label] ?? (statusByRoute[label] = {});
      perRoute[response.status] = (perRoute[response.status] ?? 0) + 1;
      if (response.status !== 200 || !response.body) {
        if (response.status >= 500) server5xx++; else client4xx++;
        streamFailures++;
        const key = `${label} ${response.status}`;
        if (!errorBodies.has(key)) errorBodies.set(key, (await response.text()).slice(0, 200));
      } else {
        ok2xx++;
        const reader = response.body.getReader();
        let chunks = 0, ttfb = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!ttfb && value && value.byteLength > 0) ttfb = performance.now() - started;
          chunks++;
        }
        const total = performance.now() - started;
        streamTtfb.push(ttfb || total);
        streamTotal.push(total);
        streamChunks.push(chunks);
        // The fixture upstream holds 60 ms between its two frames, so a relay
        // that streamed them leaves a gap between first byte and close. A
        // single chunk is not proof of buffering by itself: if this client's
        // first read happens after both frames are buffered (a loaded event
        // loop), it sees them together. Coalescing is therefore counted and
        // bounded as a share, not treated as a failure per sample.
        if (total - (ttfb || total) < 30) streamCoalesced++;
        streamGap.push(total - (ttfb || total));
      }
      return;
    }
    const response = await enterpriseRequest(stack.base, route, token, body);
    const ms = performance.now() - started;
    const label = route.split("?")[0]!;
    issued++;
    statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
    const perRoute = statusByRoute[label] ?? (statusByRoute[label] = {});
    perRoute[response.status] = (perRoute[response.status] ?? 0) + 1;
    if (response.status === 200) ok2xx++;
    else if (response.status >= 500) { server5xx++; slowest.push({ route: label, status: response.status, ms }); }
    else if (response.status >= 400) {
      client4xx++;
      // One representative body per route and status keeps the report small
      // while still naming what the gateway objected to.
      const key = `${label} ${response.status}`;
      if (!errorBodies.has(key)) errorBodies.set(key, response.text.slice(0, 200));
    }
    if (ms > 2_000) slowest.push({ route: route.split("?")[0]!, status: response.status, ms });
  } catch {
    issued++; networkErrors++;
  }
}

async function sample() {
  const response = await enterpriseRequest(stack.base, "/api/admin/metrics", fixture.admin.accessToken);
  if (response.status !== 200) { observed.push({ at: Date.now(), metricsStatus: response.status }); return; }
  const metrics = (response.json as any).metrics;
  const jobs = Array.isArray(metrics.maintenance) ? metrics.maintenance : [];
  observed.push({
    at: Date.now(),
    rssMb: metrics.process?.rssMb,
    heapUsedMb: metrics.process?.heapUsedMb,
    httpCompleted: metrics.http?.completed,
    status5xx: metrics.http?.statusClasses?.["5xx"],
    admissionQueued: metrics.admission?.queued,
    admissionPeak: metrics.admission?.peakQueued,
    analyticsWorkers: metrics.analytics?.workers,
    analyticsQueued: metrics.analytics?.queued,
    analyticsTimeouts: metrics.analytics?.timedOut,
    maintenanceRuns: Object.fromEntries(jobs.map((job: any) => [job.name, job.runs])),
    maintenanceFailures: Object.fromEntries(jobs.map((job: any) => [job.name, job.failures])),
    retention: metrics.retention,
    checkpoints: metrics.storage?.checkpoints,
    dbBytes: fileSize("gateway.db"),
    walBytes: fileSize("gateway.db-wal"),
  });
}

const startedAt = Date.now();
const deadline = startedAt + minutes * 60_000;
let index = 0;

// Sampling and traffic run together; sampling alone would miss the peaks the
// traffic provokes, and traffic alone would leave memory unobserved.
const sampling = (async () => { while (Date.now() < deadline) { await sample(); await Bun.sleep(sampleMs); } })();
while (Date.now() < deadline) {
  const batchStart = Date.now();
  await Promise.all(Array.from({ length: rate }, (_, offset) => operation(index + offset)));
  index += rate;
  const elapsed = Date.now() - batchStart;
  if (elapsed < 1_000) await Bun.sleep(1_000 - elapsed);
}
await sampling;
await sample();
const elapsedMs = Date.now() - startedAt;

const withMemory = observed.filter((row) => typeof row.rssMb === "number") as Array<Record<string, number>>;
const baseline = withMemory.length > 1 ? withMemory[1]!.rssMb! : (withMemory[0]?.rssMb ?? 0);
const finalRss = withMemory.at(-1)?.rssMb ?? baseline;
const peakRss = withMemory.reduce((max, row) => Math.max(max, row.rssMb!), 0);
const peakWal = observed.reduce((max, row) => Math.max(max, Number(row.walBytes ?? 0)), 0);
const maintenanceFailures = observed.at(-1)?.maintenanceFailures as Record<string, number> | undefined;
const maintenanceRuns = observed.at(-1)?.maintenanceRuns as Record<string, number> | undefined;

if (server5xx > 0) failures.push(`${server5xx} server error response(s)`);
if (client4xx > 0) failures.push(`${client4xx} client error response(s): ${JSON.stringify(Object.fromEntries(errorBodies))}`);
if (networkErrors > 0) failures.push(`${networkErrors} network error(s)`);
if (streamFailures > 0) failures.push(`${streamFailures} stream(s) returned an error status`);
// The claim a soak can defend is about the population: the median stream must
// show the head start the upstream's 60 ms hold creates. Individual samples can
// coalesce when this client's first read lands after both frames were buffered,
// which is why the count is reported rather than asserted per sample.
if (streamGap.length > 0 && percentile(streamGap, 0.5) < 30) {
  failures.push(`median stream gap ${percentile(streamGap, 0.5).toFixed(1)}ms — bodies are being buffered, not streamed`);
}
for (const [job, count] of Object.entries(maintenanceFailures ?? {})) if (count > 0) failures.push(`maintenance "${job}" failed ${count} time(s)`);
if (finalRss - baseline > 200) failures.push(`resident memory grew ${finalRss - baseline} MiB (${baseline} -> ${finalRss})`);
if (peakWal > 1_073_741_824) failures.push(`write-ahead log peaked at ${(peakWal / MB).toFixed(0)} MiB`);
const scheduled = Object.values(maintenanceRuns ?? {}).filter((runs) => runs > 0).length;
if (scheduled < 2) failures.push(`only ${scheduled} maintenance job(s) ran during the soak`);

const report = {
  dir, durationSeconds: Math.round(elapsedMs / 1000), arrivalRate: rate, mixedShare: "3 proxy : 1 dashboard",
  machine: enterpriseMachine(),
  traffic: { issued, ok2xx, client4xx, server5xx, networkErrors, statusCounts, statusByRoute, errorBodies: Object.fromEntries(errorBodies) },
  streaming: { share: streamShare, failures: streamFailures, coalesced: streamCoalesced, ttfbMs: distribution(streamTtfb), totalMs: distribution(streamTotal),
    gapMs: distribution(streamGap),
    chunks: { min: streamChunks.length ? Math.min(...streamChunks) : 0, max: streamChunks.length ? Math.max(...streamChunks) : 0 } },
  memory: { baselineMb: baseline, finalMb: finalRss, peakMb: peakRss, growthMb: finalRss - baseline },
  wal: { peakBytes: peakWal, finalBytes: Number(observed.at(-1)?.walBytes ?? 0) },
  maintenance: { runs: maintenanceRuns, failures: maintenanceFailures },
  slowSamples: slowest.sort((a, b) => b.ms - a.ms).slice(0, 15),
  samples: observed,
  passed: failures.length === 0, failures,
};

const text = JSON.stringify(report, null, 2);
if (reportPath) {
  const target = path.resolve(reportPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}
console.log(JSON.stringify({ name: "soak", value: {
  durationSeconds: report.durationSeconds, traffic: report.traffic, memory: report.memory, wal: report.wal,
  maintenanceRuns, maintenanceFailures, passed: report.passed, failures: report.failures, report: reportPath ?? null,
  logicalCpus: cpus().length,
} }));
await stack.stop();
if (failures.length) process.exitCode = 1;
