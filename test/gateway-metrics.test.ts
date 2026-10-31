import { afterAll, expect, test } from "bun:test";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterAll(async () => { for (const gateway of gateways) await gateway.stop(); });

test("operational metrics require administration or a dedicated read-only scraper credential", async () => {
  const scraper = "metrics-only-credential-01234567890123456789";
  const gateway = await startGateway({ GATEWAY_METRICS_TOKEN: scraper, BACKUP_INTERVAL_MINUTES: "0" });
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  const user = await createUser(gateway.base, admin.accessToken, "metrics-user@enterprise.test");
  expect((await request(gateway.base, "/api/admin/metrics")).response.status).toBe(401);
  expect((await request(gateway.base, "/api/admin/metrics", { token: user.accessToken })).response.status).toBe(403);
  expect((await request(gateway.base, "/api/admin/users", { token: scraper })).response.status).toBe(401);
  expect((await request(gateway.base, "/api/admin/metrics", { token: scraper, method: "POST", body: {} })).response.status).toBe(405);

  const before = await request(gateway.base, "/api/admin/metrics", { token: admin.accessToken });
  expect(before.response.status).toBe(200);
  expect(before.response.headers.get("cache-control")).toBe("no-store");
  for (let index = 0; index < 20; index++) {
    await request(gateway.base, `/api/private-${index}/not-a-metric-label`);
  }
  await fetch(`${gateway.base}/api/health`, { method: "HEAD" });
  const after = await request(gateway.base, "/api/admin/metrics", { token: scraper });
  const metrics = after.data.metrics;
  expect(metrics.http.requests - before.data.metrics.http.requests).toBeGreaterThanOrEqual(22);
  expect(metrics.http.routes.filter((entry: { route: string }) => entry.route === "api.other")).toHaveLength(1);
  expect(metrics.http.routes.length).toBeLessThanOrEqual(20);
  expect(metrics.http.routes.every((entry: { route: string }) => !entry.route.includes("private-"))).toBe(true);
  expect(metrics.http.active).toBe(1); // This metrics response is the only open handler.
  expect(metrics.admission.inFlight).toBe(0);
  expect(metrics.admission.rejected).toEqual({ global: 0, user: 0, key: 0, queue: 0, aborted: 0 });
  expect(metrics.analytics.queued).toBe(0);
  expect(metrics.storage.busyRetries).toBeGreaterThanOrEqual(0);
  expect(metrics.process.rssMb).toBeGreaterThan(0);
  expect(metrics.process.heapUsedMb).toBeGreaterThan(0);
  // Bun reports a heap total that does not bound heapUsed the way Node's does,
  // so only presence and plausibility are asserted here.
  expect(metrics.process.rssMb).toBeGreaterThanOrEqual(metrics.process.heapUsedMb);
  expect(metrics.backup.count).toBe(0);
  expect(after.text).not.toContain(scraper);
  expect(after.text).not.toContain(user.accessToken);
  expect(after.text).not.toContain("metrics-user@enterprise.test");
}, 60_000);

test("metrics instrumentation preserves incremental delivery and cancellation exactly once", async () => {
  const { beginHttpMetric, httpMetricsSnapshot, instrumentResponse } = await import("../server/metrics");
  const initial = httpMetricsSnapshot().http;
  let enqueue: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const original = new ReadableStream<Uint8Array>({ start(controller) { enqueue = controller; }, cancel() { cancelled++; } });
  const signal = new AbortController();
  const response = instrumentResponse(new Response(original, { headers: { "Content-Type": "text/event-stream" } }), beginHttpMetric("/v1/chat/completions"), signal.signal);
  const reader = response.body!.getReader();
  enqueue!.enqueue(new TextEncoder().encode("data: first\n\n"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
  expect(httpMetricsSnapshot().http.active).toBe(initial.active + 1);
  await reader.cancel("client left");
  signal.abort();
  expect(cancelled).toBe(1);
  expect(httpMetricsSnapshot().http.active).toBe(initial.active);
  expect(httpMetricsSnapshot().http.cancelled).toBe(initial.cancelled + 1);
  expect(httpMetricsSnapshot().http.completed).toBe(initial.completed + 1);
});
