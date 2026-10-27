// PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node --experimental-strip-types scripts/test-gateway-analytics-ui.ts
import assert from "node:assert/strict";
import { analyticsFixture } from "./gateway-analytics-fixture.ts";
import type { AnalyticsReport, DailyPoint } from "../web/src/api.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const output = path.join(root, "tmp/gateway-analytics-ui");
mkdirSync(output, { recursive: true });
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const candidate = path.join(dist, pathname === "/" ? "index.html" : pathname);
  const file = existsSync(candidate) ? candidate : path.join(dist, "index.html");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, timeout: 20_000 });
let page: any;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", timezoneId: "UTC" });
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  const reads: URL[] = [];
  const reports = new Map<string, AnalyticsReport>();
  let empty = false;
  let hold = false;
  let failNext = false;
  let failEvents = false;
  const pending = new Set<() => void>();
  page.on("pageerror", (error: Error) => errors.push(String(error)));
  await page.addInitScript(() => {
    localStorage.setItem("cache_code_session", JSON.stringify({ accessToken: "ui-test", refreshToken: "ui-test", user: { id: "user", name: "Alex Morgan", email: "alex@example.com", role: "admin", status: "active" } }));
    localStorage.setItem("llmgw-theme", "dark");
    localStorage.setItem("llmgw-grid:usage.recent", JSON.stringify({ columnState: [{ colId: "model", width: 244 }], userResizedColumns: ["model"], filterModel: { model: { filterType: "text", type: "equals", filter: "stale-filter" } } }));
  });
  const seriesFor = (url: URL) => {
    const to = Number(url.searchParams.get("to"));
    const from = url.searchParams.get("from") === "all" ? Date.UTC(2016, 0, 1) : Number(url.searchParams.get("from"));
    const duration = to - from;
    const unit: AnalyticsReport["granularity"] = duration > 400 * 86_400_000 ? "month" : duration <= 3_600_000 ? "minute" : duration <= 3 * 86_400_000 ? "hour" : "day";
    const step = unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : 86_400_000;
    const start = unit === "month" ? Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1) : Math.floor(from / step) * step;
    const series: DailyPoint[] = [];
    for (let time = start, index = 0; time < to && index < 1500; index++) {
      const iso = new Date(time).toISOString();
      const reqs = empty || index % 11 === 0 ? 0 : 70 + index % 7 * 30;
      const cost_in = reqs * (.003 + index % 4 * .0003);
      const cost_cache = reqs * (.001 + index % 3 * .0001);
      const cost_out = reqs * (.008 + index % 5 * .0004);
      series.push({ date: unit === "minute" || unit === "hour" ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10), label: unit === "month" ? iso.slice(0, 7) : unit === "hour" || unit === "minute" ? iso.slice(11, 16) : undefined, reqs, in_tok: reqs * 540, cache_tok: reqs * 3200, out_tok: reqs * 180, cost_in, cost_cache, cost_out, cost: cost_in + cost_cache + cost_out });
      time = unit === "month" ? Date.UTC(new Date(time).getUTCFullYear(), new Date(time).getUTCMonth() + 1, 1) : time + step;
    }
    return { series, unit };
  };
  const categories = [
    { id: "model", label: "Model", icon: "lucide:box", options: ["Claude Sonnet 4.5", "GPT-5", "Gemini 2.5 Pro", "Kimi K2", "DeepSeek V3.2"].map((label, index) => ({ value: `model/${index}`, label, count: 500 - index * 50 })) },
    { id: "provider_id", label: "Provider", icon: "lucide:server", options: [{ value: "primary", label: "Primary", count: 500 }, { value: "backup", label: "Backup", count: 200 }] },
    { id: "proto", label: "Protocol", icon: "lucide:network", options: [{ value: "openai", label: "OpenAI", count: 500 }, { value: "anthropic", label: "Anthropic", count: 200 }] },
    { id: "user_id", label: "User", icon: "lucide:users", options: [{ value: "user", label: "Alex Morgan", count: 500 }, { value: "jamie", label: "Jamie Chen", count: 200 }, { value: "sam", label: "Sam Rivera", count: 150 }] },
  ];
  const mockApi = async (route: any) => {
    const url = new URL(route.request().url()); reads.push(url);
    let data: Record<string, unknown> = {};
    if (url.pathname.endsWith("filter-options")) {
      const field = url.searchParams.get("field");
      const domain = url.pathname.startsWith("/api/admin") ? categories : categories.filter((category) => category.id !== "user_id");
      data = field ? { field, options: domain.find((category) => category.id === field)?.options ?? [], total: domain.find((category) => category.id === field)?.options.length ?? 0, offset: 0, limit: 60 }
        : { categories: domain.map(({ options: _, ...category }) => category), selection: JSON.parse(url.searchParams.get("selection") ?? "{}"), selectedOptions: {} };
    } else if (url.pathname.endsWith("/analytics")) {
      if (hold) await new Promise<void>((resolve) => pending.add(resolve));
      if (failNext) { failNext = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: "Analytics is busy" }) }); return; }
      const fixture = seriesFor(url);
      const report = analyticsFixture(fixture.series, url, url.pathname.startsWith("/api/admin"), fixture.unit);
      reports.set(url.pathname + url.search, report);
      data = report as unknown as Record<string, unknown>;
    } else if (url.pathname === "/api/usage/events") {
      if (failEvents) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: "Analytics is busy" }) }); return; }
      const fixture = seriesFor(url);
      const report = analyticsFixture(fixture.series, url, false, fixture.unit);
      const total = report.series.reduce((sum, point) => sum + point.reqs, 0);
      const totals = Object.fromEntries(["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"].map((field) => [field, report.series.reduce((sum, point) => sum + Number(point[field as keyof DailyPoint] ?? 0), 0)]));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      data = { total, totals, events: url.searchParams.has("summary") ? [] : Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({ id: offset + index, ts: Number(url.searchParams.get("to")) - (offset + index + 1) * 1000, key_name: "Production", proto: "openai", provider_name: "Primary", model: "Claude Sonnet 4.5", upstream_model: "upstream/claude-sonnet", in_tok: 540, cache_tok: 3200, out_tok: 180, cost_in: .003, cost_cache: .001, cost_out: .008, cost: .012, latency_ms: 1200, status: 200 })) };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ...data }) }).catch(() => {});
  };
  await page.route("**/api/**", mockApi);
  const settled = () => page.waitForFunction(() => document.querySelector(".analytics-page")?.getAttribute("aria-busy") === "false" && !!document.querySelector(".analytics-summary"));
  const fits = async (label: string) => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} overflows horizontally`);
  const capture = async (name: string) => { await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(output, name), fullPage: true }); };
  const choosePeriod = async (name: string) => { await page.getByRole("button", { name: /^Time range:/ }).click(); await page.getByRole("button", { name: new RegExp(`${name}$`) }).click(); await settled(); };
  console.log("[analytics-ui] Checking the rebuilt Usage page");
  await page.goto(`${serverUrl}#/usage`); await settled();
  await page.locator(".ag-row").first().waitFor();
  assert.equal(await page.locator(".ag-root-wrapper").count(), 1);
  assert.equal(await page.locator(".ag-floating-filter").count(), 0);
  assert.equal(await page.locator(".analytics-summary > .ui-card").count(), 3);
  const boxes = await page.locator(".analytics-summary > .ui-card").evaluateAll((elements: HTMLElement[]) => elements.map((element) => ({ y: element.getBoundingClientRect().y, width: element.getBoundingClientRect().width })));
  assert(boxes.every((box: any) => Math.abs(box.y - boxes[0].y) < 1 && Math.abs(box.width - boxes[0].width) < 1), "Summary cards do not share the full-width row");
  assert.equal(reads.filter((url) => url.pathname === "/api/usage/analytics").length, 1, "Initial charts did not share a consolidated report");
  assert(!reads.some((url) => url.pathname.includes("usage/breakdown")), "Removed model grid still queries the API");
  assert(await page.locator(".analytics-model-chart.is-spend rect.analytics-series-bar").count() > 0);
  assert(await page.locator(".analytics-cache-chart rect.analytics-series-bar").count() > 0);
  const legendColors = async (selector: string) => page.locator(`${selector} .analytics-chart-legend button`).evaluateAll((buttons: HTMLElement[]) => Object.fromEntries(buttons.map((button) => [button.querySelector("span")!.textContent!, (button.querySelector("i") as HTMLElement).style.background])));
  const spendColors = await legendColors(".is-spend");
  const requestColors = await legendColors(".is-volume");
  for (const model of Object.keys(spendColors)) assert.equal(requestColors[model], spendColors[model], `${model} changed color between charts`);
  const initial = [...reports.values()][0]!;
  const totalTokens = initial.series.reduce((sum, point) => sum + point.in_tok + point.cache_tok + point.out_tok, 0);
  assert.equal(Number((await page.locator(".analytics-summary-tokens [title]").first().getAttribute("title")).replaceAll(",", "")), totalTokens);
  await fits("Usage desktop"); await capture("usage-desktop-dark.png");
  const bars = page.locator(".analytics-model-chart.is-spend rect.analytics-series-bar");
  const barIndex = await bars.evaluateAll((rects: SVGRectElement[]) => rects.findIndex((rect) => rect.getBoundingClientRect().height > 3));
  await bars.nth(barIndex).hover(); await page.locator(".analytics-chart-tooltip").first().waitFor();
  assert(!/NaN|undefined/.test(await page.locator(".analytics-chart-tooltip").first().innerText()));
  await page.mouse.move(0, 0);
  hold = true;
  const applied = page.waitForRequest((request: any) => request.url().includes("/api/usage/analytics?") && new URL(request.url()).searchParams.get("selection")?.includes("model/0"));
  await page.locator(".analytics-model-chart.is-spend .analytics-chart-legend button").first().click();
  await applied;
  assert.equal(await page.locator(".analytics-summary > .ui-card").count(), 3, "Charts disappeared during a filter refresh");
  assert.equal(await page.locator(".ag-root-wrapper").count(), 1);
  hold = false; for (const resolve of pending) resolve(); pending.clear(); await settled();
  assert.equal(await page.locator(".analytics-model-chart.is-spend .analytics-chart-legend button").count(), 1);
  const scoped = reads.filter((url) => url.pathname === "/api/usage/analytics").at(-1)!;
  assert(reads.some((url) => url.pathname === "/api/usage/events" && url.searchParams.get("selection") === scoped.searchParams.get("selection")), "Requests did not follow the chart filter");
  await page.getByRole("button", { name: "Clear all", exact: true }).click(); await settled();
  await choosePeriod("Past 24 hours");
  await fits("Hourly usage");
  await choosePeriod("All time"); await fits("All-history usage");
  await choosePeriod("Past 2 weeks");
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => innerWidth >= 768 ? !!document.querySelector(".ag-root-wrapper") : !!document.querySelector(".usage-mobile-requests"));
    await settled(); await fits(`Usage ${width}px`); await capture(`usage-${width}.png`);
    assert.equal(await page.locator(".ag-root-wrapper").count(), width >= 768 ? 1 : 0, "Hidden grid remained mounted on mobile");
  }
  await page.locator(".usage-mobile-requests button").first().click();
  assert(await page.locator(".usage-mobile-requests").getByText("Input", { exact: true }).isVisible());
  await page.getByRole("button", { name: "Next", exact: true }).click();
  assert(reads.some((url) => url.pathname === "/api/usage/events" && url.searchParams.get("offset") === "25"));
  await page.setViewportSize({ width: 1440, height: 1100 });
  console.log("[analytics-ui] Checking Global Stats and dashboard-wide drilldowns");
  await page.goto(`${serverUrl}#/admin/stats`); await settled();
  assert.equal(await page.locator(".ag-root-wrapper").count(), 0);
  assert.equal(await page.locator(".analytics-user-chart").count(), 1);
  assert.equal(await page.locator(".analytics-donut-segment").count(), 2);
  assert.equal(await page.locator(".analytics-scatter circle").count(), 3);
  assert(!reads.some((url) => url.pathname.includes("usage-breakdown")), "Global Stats still queries removed grids");
  await fits("Global desktop"); await capture("global-desktop-dark.png");
  await page.getByRole("button", { name: "Filter by user Alex Morgan", exact: true }).click(); await settled();
  assert.equal(await page.locator(".analytics-user-row").count(), 1);
  assert.equal(await page.locator(".analytics-scatter circle").count(), 1);
  const userQuery = reads.filter((url) => url.pathname === "/api/admin/analytics").at(-1)!;
  assert.deepEqual(JSON.parse(userQuery.searchParams.get("selection")!).user_id.include, ["user"]);
  await page.getByRole("button", { name: "Clear all", exact: true }).click(); await settled();
  await page.locator(".analytics-provider-legend button").first().click(); await settled();
  assert.equal(await page.locator(".analytics-donut-segment").count(), 1);
  await page.getByRole("button", { name: "Clear all", exact: true }).click(); await settled();
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await fits(`Global ${width}px`); await capture(`global-${width}.png`);
    assert.equal(await page.locator(".ag-root-wrapper").count(), 0);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => document.documentElement.dataset.theme = "light"); await capture("global-desktop-light.png");
  await page.evaluate(() => document.documentElement.dataset.theme = "high-contrast"); await fits("Global high contrast");
  failNext = true; await page.getByRole("button", { name: /^Time range:/ }).click(); await page.getByRole("button", { name: /Past month$/ }).click();
  await page.locator(".analytics-error").waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await settled();
  assert.equal(await page.locator(".analytics-error").count(), 0);
  empty = true; await choosePeriod("Past year");
  assert.equal(await page.locator(".analytics-series-bar").count(), 0);
  assert(await page.getByText("No activity in this period", { exact: true }).first().isVisible());
  await capture("global-empty.png");
  empty = false;
  console.log("[analytics-ui] Checking request retries and touch interaction");
  await page.setViewportSize({ width: 390, height: 844 });
  failEvents = true;
  await page.goto(`${serverUrl}#/usage`);
  await page.locator(".analytics-request-error").waitFor();
  assert.equal(await page.locator(".analytics-summary > .ui-card").count(), 3, "Request errors removed the charts");
  failEvents = false;
  await page.getByRole("button", { name: "Retry requests", exact: true }).click();
  await settled();
  assert.equal(await page.locator(".analytics-request-error").count(), 0);
  await page.locator(".usage-mobile-requests button").first().waitFor();
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: "reduce", timezoneId: "UTC" });
  touch.on("pageerror", (error: Error) => errors.push(String(error)));
  await touch.addInitScript(() => {
    localStorage.setItem("cache_code_session", JSON.stringify({ accessToken: "ui-test", refreshToken: "ui-test", user: { id: "user", name: "Alex Morgan", email: "alex@example.com", role: "admin", status: "active" } }));
    localStorage.setItem("llmgw-theme", "dark");
  });
  await touch.route("**/api/**", mockApi);
  await touch.goto(`${serverUrl}#/admin/stats`);
  await touch.locator(".analytics-summary").waitFor();
  await touch.locator(".analytics-scatter circle").first().tap();
  await touch.waitForFunction(() => document.querySelectorAll(".analytics-user-row").length === 1 && document.querySelector(".analytics-page")?.getAttribute("aria-busy") === "false");
  await touch.getByRole("button", { name: "Clear all", exact: true }).tap();
  await touch.waitForFunction(() => document.querySelectorAll(".analytics-user-row").length === 3);
  await touch.locator(".analytics-provider-legend button").first().tap();
  await touch.waitForFunction(() => document.querySelectorAll(".analytics-donut-segment").length === 1);
  await touch.locator("button.activity-cell[data-count]").last().tap();
  await touch.getByRole("tooltip").waitFor();
  assert(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Touch layout overflows");
  await touch.screenshot({ path: path.join(output, "global-touch.png"), fullPage: true });
  await touch.close();
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(`Analytics UI passed: summary cards, model bars, cache data, one request grid, global visualizations, user/provider/model drilldowns, pending states, retry, empty data and responsive themes. Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close(); server.closeAllConnections(); server.close();
}
