/** Small, process-local operational counters. Labels and sample storage are bounded. */
const startedAt = Date.now();
const SAMPLE_LIMIT = 512;
const routes = new Map<string, RouteMetric>();
const jobs = new Map<string, MaintenanceMetric>();

interface RouteMetric {
  requests: number;
  active: number;
  completed: number;
  errors: number;
  cancelled: number;
  sum: number;
  max: number;
  samples: number[];
  cursor: number;
}

interface MaintenanceMetric {
  name: string;
  running: boolean;
  runs: number;
  failures: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastSuccessAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

const statusClasses: Record<string, number> = { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
let busyRetries = 0;
let busyFailures = 0;

function routeLabel(pathname: string): string {
  const proxy = pathname.replace(/^\/(?:openai|anthropic)\//, "/");
  if (proxy === "/v1" || proxy.startsWith("/v1/")) {
    if (/^\/v1\/models(?:\/|$)/.test(proxy)) return "proxy.models";
    if (proxy === "/v1/messages") return "proxy.messages";
    if (proxy.startsWith("/v1/responses")) return "proxy.responses";
    if (proxy === "/v1/embeddings") return "proxy.embeddings";
    return "proxy.completions";
  }
  if (pathname === "/api/health") return "health";
  if (pathname === "/api/ready") return "ready";
  if (pathname.startsWith("/api/indirect-code/gen-ui/")) return "widgets";
  if (pathname.startsWith("/api/indirect-code/")) return "relay";
  for (const family of ["auth", "me", "billing", "keys", "usage", "projects", "admin", "push"]) {
    if (pathname === `/api/${family}` || pathname.startsWith(`/api/${family}/`)) return family;
  }
  return pathname.startsWith("/api/") ? "api.other" : "static";
}

function duration(metric: RouteMetric) {
  const sorted = metric.samples.toSorted((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return {
    count: metric.completed,
    sum: metric.sum,
    p50: percentile(.5),
    p95: percentile(.95),
    p99: percentile(.99),
    max: metric.max,
    sampleCount: sorted.length,
    sampleLimit: SAMPLE_LIMIT,
  };
}

/** Includes streamed response consumption. Completion/cancellation is counted once. */
export function beginHttpMetric(pathname: string): (status: number) => void {
  const label = routeLabel(pathname);
  let metric = routes.get(label);
  if (!metric) {
    metric = { requests: 0, active: 0, completed: 0, errors: 0, cancelled: 0, sum: 0, max: 0, samples: [], cursor: 0 };
    routes.set(label, metric);
  }
  const current = metric;
  current.requests++;
  current.active++;
  const began = performance.now();
  let finished = false;
  return (status) => {
    if (finished) return;
    finished = true;
    const elapsed = Math.max(0, performance.now() - began);
    current.active--;
    current.completed++;
    current.sum += elapsed;
    current.max = Math.max(current.max, elapsed);
    if (status >= 500) current.errors++;
    if (status === 499) current.cancelled++;
    const group = `${Math.min(5, Math.max(1, Math.floor(status / 100)))}xx`;
    statusClasses[group] = (statusClasses[group] ?? 0) + 1;
    if (current.samples.length < SAMPLE_LIMIT) current.samples.push(elapsed);
    else current.samples[current.cursor] = elapsed;
    current.cursor = (current.cursor + 1) % SAMPLE_LIMIT;
  };
}

/** A pull-based wrapper: never buffer an SSE response to collect a metric. */
export function instrumentResponse(response: Response, finish: (status: number) => void, signal: AbortSignal, head = false): Response {
  if (!response.body || head) { finish(response.status); return response; }
  const reader = response.body.getReader();
  let closed = false;
  const complete = (status: number) => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", aborted);
    finish(status);
  };
  const aborted = () => complete(499);
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          complete(response.status);
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        complete(signal.aborted ? 499 : 599);
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      complete(499);
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function httpMetricsSnapshot() {
  const all = [...routes.entries()];
  const sum = (key: "requests" | "active" | "completed" | "errors" | "cancelled") => all.reduce((n, [, metric]) => n + metric[key], 0);
  return {
    startedAt,
    uptimeSeconds: (Date.now() - startedAt) / 1000,
    http: {
      requests: sum("requests"), active: sum("active"), completed: sum("completed"), errors: sum("errors"), cancelled: sum("cancelled"),
      statusClasses: { ...statusClasses },
      routes: all.map(([route, metric]) => ({ route, requests: metric.requests, active: metric.active, completed: metric.completed, errors: metric.errors, cancelled: metric.cancelled, durationMs: duration(metric) })),
    },
  };
}

export function recordBusyRetry(): void { busyRetries++; }
export function recordBusyFailure(): void { busyFailures++; }
export function sqliteMetricsSnapshot() { return { busyRetries, busyFailures }; }

/** Resident and heap usage for operators and soak runs. Reading it is cheap and
 * allocation-free apart from the snapshot object itself. */
export function processMetricsSnapshot() {
  const usage = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1_048_576);
  return {
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

export function beginMaintenanceMetric(name: string): (ok: boolean, error?: unknown) => void {
  let metric = jobs.get(name);
  if (!metric && jobs.size < 32) {
    metric = { name: name.slice(0, 80), running: false, runs: 0, failures: 0, lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null, lastDurationMs: null, lastError: null };
    jobs.set(name, metric);
  }
  if (!metric) return () => undefined;
  const current = metric;
  current.running = true;
  current.runs++;
  current.lastStartedAt = Date.now();
  const began = performance.now();
  return (ok, error) => {
    current.running = false;
    current.lastFinishedAt = Date.now();
    current.lastDurationMs = performance.now() - began;
    if (ok) { current.lastSuccessAt = current.lastFinishedAt; current.lastError = null; }
    else {
      current.failures++;
      // Do not expose arbitrary exception messages, SQL parameters or secrets.
      current.lastError = error instanceof Error ? error.name.slice(0, 80) : "Error";
    }
  };
}

export function maintenanceMetricsSnapshot() { return [...jobs.values()].map((metric) => ({ ...metric })); }
