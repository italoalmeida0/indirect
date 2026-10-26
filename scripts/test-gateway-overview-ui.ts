// PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node --experimental-strip-types scripts/test-gateway-overview-ui.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const output = path.join(root, "tmp/gateway-overview-ui");
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
  // Reduced motion makes the visual captures deterministic, including counters.
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, timezoneId: "UTC", reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const reads: URL[] = [];
  let empty = false;
  let hold = false;
  const pending = new Set<() => void>();
  const datasets = new Map<string, { date: string; reqs: number; in_tok: number; cache_tok: number; out_tok: number }[]>();
  page.on("pageerror", (error: Error) => errors.push(String(error)));
  const authenticate = () => {
    localStorage.setItem("cache_code_session", JSON.stringify({ accessToken: "ui-test", refreshToken: "ui-test", user: { id: "user", name: "Alex Morgan", email: "alex@example.com", role: "admin", status: "active" } }));
    localStorage.setItem("llmgw-theme", "dark");
  };
  await page.addInitScript(authenticate);
  const mockApi = async (route: any) => {
    const url = new URL(route.request().url());
    reads.push(url);
    let data: Record<string, unknown> = {};
    if (url.pathname.endsWith("filter-options")) {
      data = url.searchParams.has("field")
        ? { field: "model", options: [{ value: "model/test", label: "Production model", count: 440 }], total: 1, offset: 0, limit: 60 }
        : { categories: [{ id: "model", label: "Model", icon: "lucide:box" }], selection: JSON.parse(url.searchParams.get("selection") ?? "{}"), selectedOptions: {} };
    } else if ((url.pathname === "/api/usage/daily" || url.pathname === "/api/usage/overview")) {
      if (hold) await new Promise<void>((resolve) => pending.add(resolve));
      const to = Number(url.searchParams.get("to"));
      const from = url.searchParams.get("from") === "all" ? Date.UTC(2016, 0, 1) : Number(url.searchParams.get("from"));
      const duration = to - from;
      const granularity = duration > 400 * 86_400_000 ? "month" : duration <= 3_600_000 ? "minute" : duration <= 3 * 86_400_000 ? "hour" : "day";
      const step = granularity === "minute" ? 60_000 : granularity === "hour" ? 3_600_000 : 86_400_000;
      const start = granularity === "month" ? new Date(from).setUTCDate(1) : Math.floor(from / step) * step;
      const series = [];
      for (let time = start, i = 0; time < to && i < 4000; i++) {
        const date = new Date(time).toISOString();
        const reqs = empty || i % 9 === 0 ? 0 : 8 + (i * 37) % 120;
        const cost_in = reqs * (.003 + (i % 4) * .0003);
        const cost_cache = reqs * (.001 + (i % 6) * .0001);
        const cost_out = reqs * (.005 + (i % 3) * .0006);
        series.push({ date: granularity === "hour" || granularity === "minute" ? `${date.slice(0, 10)} ${date.slice(11, 16)} UTC` : date.slice(0, 10), label: granularity === "month" ? date.slice(0, 7) : undefined, reqs, in_tok: reqs * 620, cache_tok: reqs * 4600, out_tok: reqs * 130, cost_in, cost_cache, cost_out, cost: cost_in + cost_cache + cost_out });
        time = granularity === "month" ? Date.UTC(new Date(time).getUTCFullYear(), new Date(time).getUTCMonth() + 1, 1) : time + step;
      }
      datasets.set(url.search, series);
      const totalRequests = series.reduce((sum, point) => sum + point.reqs, 0);
      const names = ["Claude Sonnet 4.5", "GPT-5", "Gemini 2.5 Pro"];
      let models = totalRequests ? names.map((name, index) => ({ model: index === 0 ? "model/test" : `model/${index}`, model_name: name, reqs: Math.floor(totalRequests * [.38, .25, .16, .1, .06][index]!), provider_id: "primary", provider_name: "Primary", upstream_model: `upstream/${name.toLowerCase().replaceAll(" ", "-")}`, route_count: index === 0 ? 2 : 1 })) : [];
      if (duration <= 3 * 86_400_000) models = models.slice(0, 2);
      if (Object.keys(JSON.parse(url.searchParams.get("selection") ?? "{}")).length) models = models.slice(0, 1);
      data = { series, granularity, models };
    } else if (url.pathname === "/api/keys") data = { keys: [{ id: "production", status: "active" }] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ...data }) }).catch(() => {});
  };
  await page.route("**/api/**", mockApi);
  const settled = () => page.waitForFunction(() => document.querySelector(".overview-charts")?.closest("[aria-busy]")?.getAttribute("aria-busy") === "false");
  const period = async (name: string) => {
    await page.getByRole("button", { name: /^Time range:/ }).click();
    await page.getByRole("button", { name: new RegExp(`${name}$`) }).click();
    await settled();
  };
  const fits = async (label: string) => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} causes page overflow`);
  const cells = () => page.locator("button.activity-cell");
  const counts = () => cells().evaluateAll((buttons: HTMLButtonElement[]) => buttons.reduce((sum, button) => sum + Number(button.dataset.count), 0));
  const capture = async (name: string) => {
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => [...document.querySelectorAll(".overview-charts > .ui-card")].every((element) => Number(getComputedStyle(element).opacity) > .99));
    await page.screenshot({ path: path.join(output, name), fullPage: true });
  };

  console.log("[overview-ui] Checking chart structure, scope and interactions");
  await page.goto(serverUrl);
  await settled();
  assert.equal(await page.locator(".overview-spend path.spend-line").count(), 3);
  assert.equal(await page.locator(".overview-spend .chart-bar").count(), 0);
  assert(await page.locator(".overview-tokens .chart-bar").count() > 0);
  const spend = await page.locator(".overview-spend").boundingBox();
  const tokens = await page.locator(".overview-tokens").boundingBox();
  const requests = await page.locator(".overview-requests").boundingBox();
  assert(Math.abs(spend.y - tokens.y) < 1 && requests.y > spend.y + spend.height, "Requests is not below both charts");
  const topModels = await page.locator(".overview-top-models").boundingBox();
  assert(topModels.x >= requests.x + requests.width && Math.abs(topModels.y - requests.y) < 1, "Top models is not to the right of Requests");
  assert(Math.abs(requests.width + topModels.width + 20 - (spend.width + tokens.width + 20)) < 2, "Activity row does not span both charts");
  assert.equal(await page.getByText("Active keys", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Avg/req", { exact: true }).count(), 0);
  assert.equal(await page.locator(".top-model-row").count(), 3);
  assert(await page.getByRole("heading", { name: "Top 3 models", exact: true }).isVisible());
  assert(!/GMT|UTC/.test(await page.locator(".analytics-controls").innerText()), "Timezone still appears outside the filters");
  assert.match(await page.locator(".top-model-route").first().innerText(), /by Primary.*upstream\//);
  assert(await page.locator(".overview-requests .activity-cache-rate").innerText(), "Cache rate is outside Requests");
  const align = await page.locator(".analytics-toolbar").evaluate((toolbar: HTMLElement) => ({ right: toolbar.getBoundingClientRect().right, controlsRight: toolbar.querySelector(".analytics-controls")!.getBoundingClientRect().right }));
  assert(Math.abs(align.right - align.controlsRight) < 1, "Filters are not aligned right");
  const primary = reads.find((url) => url.pathname === "/api/usage/overview")!;
  assert.equal(await counts(), datasets.get(primary.search)!.reduce((sum, row) => sum + row.reqs, 0));
  const points = datasets.get(primary.search)!;
  const total = points.reduce((sum, row) => sum + row.in_tok + row.cache_tok + row.out_tok, 0);
  assert.equal(Number((await page.locator(".overview-tokens [title]").first().getAttribute("title")).replaceAll(",", "")), total, "Token headline does not include all three buckets");
  assert.match(await page.locator(".activity-cache-rate").innerText(), /88.1%/);
  const last = cells().last();
  await last.focus();
  await page.getByRole("tooltip").waitFor();
  const latestKey = await last.getAttribute("data-date");
  const scrollBeforeKeys = await page.evaluate(() => scrollY);
  await page.keyboard.press("ArrowLeft");
  const focusedKey = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.date);
  assert.equal(Date.parse(latestKey) - Date.parse(focusedKey), 7 * 86_400_000, "Calendar keyboard navigation is not weekly");
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.date), await cells().first().getAttribute("data-date"));
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => scrollY), scrollBeforeKeys, "Calendar navigation moved the page");
  await page.keyboard.press("Enter");
  assert.equal(await last.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("tooltip").count(), 0);

  await period("Past year");
  assert(await cells().count() >= 365 && await cells().count() <= 367);
  await capture("desktop-dark.png");
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await fits(`${width}px`);
    await capture(`responsive-${width}.png`);
    const frame = await page.locator(".activity-scroll").evaluate((element: HTMLElement) => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }));
    assert(Math.abs(frame.left - frame.max) < 2, "The latest activity is hidden after resizing");
    await cells().last().click();
    assert.equal(await cells().last().getAttribute("aria-pressed"), "true");
    await page.mouse.move(0, 0);
    await page.evaluate(() => scrollTo(0, 0));
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  await capture("desktop-light.png");
  await page.evaluate(() => document.documentElement.dataset.theme = "high-contrast");
  await fits("High contrast");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".spend-line").first().evaluate((element: Element) => getComputedStyle(element).animationName), "none");

  console.log("[overview-ui] Checking hourly, empty, monthly and pending scopes");
  await period("Past 24 hours");
  assert(await cells().count() <= 2);
  assert.equal(await page.locator(".top-model-row").count(), 2, "Top models ignored the selected range");
  await page.getByRole("button", { name: /^Time range:/ }).click();
  await page.getByRole("button", { name: "Custom range…", exact: true }).click();
  await page.getByLabel("Start date and time").fill("2026-10-26T10:00");
  await page.getByLabel("End date and time").fill("2026-10-26T10:00");
  await page.getByRole("button", { name: "Apply range", exact: true }).click();
  await settled();
  assert.equal(await page.locator(".overview-spend circle.spend-point").count(), 3, "A single bucket has no visible spend values");
  await period("All time");
  assert.equal(await page.locator(".request-activity.is-monthly").count(), 1);
  assert(await cells().count() >= 120 && await cells().count() < 140);
  assert((await cells().first().getAttribute("data-date"))!.length === 7, "Monthly counts were fabricated into daily cells");
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await capture("monthly.png");
  const oldKeys = await cells().evaluateAll((buttons: HTMLButtonElement[]) => buttons.map((button) => button.dataset.date));
  hold = true;
  await page.getByRole("button", { name: /^Time range:/ }).click();
  await page.getByRole("button", { name: /Past month$/ }).click();
  await page.waitForFunction(() => document.querySelector(".overview-charts")?.closest("[aria-busy]")?.getAttribute("aria-busy") === "true");
  assert.deepEqual(await cells().evaluateAll((buttons: HTMLButtonElement[]) => buttons.map((button) => button.dataset.date)), oldKeys, "Pending range remapped old counts into new dates");
  hold = false;
  for (const resolve of pending) resolve();
  await settled();
  assert.equal(await page.locator(".request-activity.is-monthly").count(), 0);

  empty = true;
  await period("Past 2 weeks");
  assert.equal(await counts(), 0);
  assert.equal(await page.locator("button.activity-cell:not(.activity-level-0)").count(), 0);
  assert(await page.getByText("No requests in this period", { exact: true }).isVisible());
  assert.equal(await page.locator(".top-model-row").count(), 0);
  assert.match(await page.locator(".activity-cache-rate").innerText(), /No input tokens/);
  await fits("Empty state");
  await capture("empty.png");
  empty = false;
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", timezoneId: "UTC" });
  mobile.on("pageerror", (error: Error) => errors.push(String(error)));
  await mobile.addInitScript(authenticate);
  await mobile.route("**/api/**", mockApi);
  await mobile.goto(serverUrl);
  await mobile.locator("button.activity-cell").last().tap();
  assert.equal(await mobile.locator("button.activity-cell").last().getAttribute("aria-pressed"), "true");
  assert(await mobile.locator(".activity-readout").innerText(), "Touch did not show activity details");
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Touch layout causes page overflow");
  await mobile.screenshot({ path: path.join(output, "phone-touch.png") });
  await mobile.close();
  assert(reads.every((url) => url.pathname.endsWith("filter-options") || url.pathname === "/api/usage/daily" || url.pathname === "/api/usage/overview" || url.pathname === "/api/keys"), "Overview introduced an extra analytics endpoint");
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(`Overview UI passed: three spend lines, token bars, request heatmap, date scopes, keyboard, responsive layouts, themes, reduced motion, monthly and empty data. Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
