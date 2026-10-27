// Run against the production SPA using an existing Playwright installation.
// PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-gateway-filters-ui.ts
// On Windows, use node --experimental-strip-types if Bun's Chromium pipe stalls.
import assert from "node:assert/strict";
import { analyticsFixture } from "./gateway-analytics-fixture.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

console.log("[filters-ui] Loading Playwright");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const output = path.join(root, "tmp/gateway-filters-ui");
mkdirSync(output, { recursive: true });
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const candidate = path.join(dist, pathname === "/" ? "index.html" : pathname);
  const file = existsSync(candidate) ? candidate : path.join(dist, "index.html");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
  res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const models = ["Claude Sonnet 4.5", "GPT-5", "Gemini 2.5 Pro", "Kimi K2", "DeepSeek V3.2", ...Array.from({ length: 135 }, (_, i) => `Model ${String(i + 1).padStart(2, "0")}`)];
const categories = [
  { id: "model", label: "Model", options: models.map((label, i) => ({ value: `model/${i}`, label, count: 5000 - i * 23 })) },
  { id: "provider_id", label: "Provider", options: [{ value: "primary", label: "Primary", count: 724 }, { value: "backup", label: "Backup", count: 382 }] },
  { id: "key_id", label: "API key", options: [{ value: "production", label: "Production", count: 704 }, { value: "development", label: "Development", count: 402 }] },
  { id: "proto", label: "Protocol", options: [{ value: "openai", label: "OpenAI", count: 845 }, { value: "anthropic", label: "Anthropic", count: 261 }] },
  { id: "upstream_model", label: "Upstream model", options: [{ value: "upstream/model", label: "upstream/model", count: 1106 }] },
  { id: "provider_key_id", label: "Upstream key", options: [{ value: "upstream", label: "Default", count: 1106 }] },
];
const series = Array.from({ length: 15 }, (_, i) => ({ date: `2026-10-${String(i + 12).padStart(2, "0")}`, in_tok: 14000 + i * 1780, cache_tok: 57000 + (i % 5) * 12000, out_tok: 4600 + (i % 4) * 1340, reqs: 40 + (i % 6) * 12, cost_in: .3, cost_cache: .1, cost_out: .5, cost: .9 }));
const row = { key_id: "production", key_name: "Production", proto: "openai", model: "Claude Sonnet 4.5", provider_id: "primary", provider_name: "Primary", provider_key_id: "upstream", provider_key_label: "Default", upstream_model: "claude-sonnet-4-5", in_tok: 28000, cache_tok: 84000, out_tok: 6200, reqs: 45, cost_in: .3, cost_cache: .1, cost_out: .5, cost: .9 };
const totals = { ...row, reqs: 73 };
console.log("[filters-ui] Launching Chromium");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, timeout: 20_000 });
let activePage: any;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1 });
  activePage = page;
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const requests: URL[] = [];
  let holdAnalytics = false;
  let holdDateMetadata = false;
  const pendingResponses = new Set<() => void>();
  const pendingMetadata = new Set<() => void>();
  page.on("pageerror", (error: Error) => { errors.push(String(error)); console.error("[browser]", error); });
  await page.addInitScript(() => {
    localStorage.setItem("cache_code_session", JSON.stringify({ accessToken: "ui-test", refreshToken: "ui-test", user: { id: "user", name: "Alex Morgan", email: "alex@example.com", role: "admin", status: "active" } }));
    localStorage.setItem("llmgw-theme", "dark");
    for (const key of ["usage.by-model", "usage.recent", "admin.stats.users", "admin.stats.models"]) {
      const colId = key.endsWith("users") ? "email" : "model";
      localStorage.setItem(`llmgw-grid:${key}`, JSON.stringify({
        columnState: [{ colId, width: 244 }], userResizedColumns: [colId],
        filterModel: { [colId]: { filterType: "text", type: "equals", filter: "stale-column-filter" } },
      }));
    }
  });
  await page.route("**/api/**", async (route: any) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (holdDateMetadata && url.pathname.endsWith("filter-options") && !url.searchParams.has("field")) await new Promise<void>((resolve) => pendingMetadata.add(resolve));
    if (holdAnalytics && !url.pathname.endsWith("filter-options") && (url.pathname.startsWith("/api/usage/") || url.pathname === "/api/admin/stats" || url.pathname.includes("usage-breakdown/"))) {
      await new Promise<void>((resolve) => pendingResponses.add(resolve));
    }
    let data: Record<string, unknown> = {};
    if (url.pathname.endsWith("filter-options")) {
      let domain = url.pathname.startsWith("/api/admin") ? [...categories, { id: "user_id", label: "User", options: [{ value: "user", label: "alex@example.com", count: 1106 }] }] : categories;
      if (new Date(Number(url.searchParams.get("from"))).getFullYear() === 2020) domain = domain.map((category) => ({ ...category, options: category.options.filter((option) => category.id !== "model" || option.value === "model/1") }));
      const field = url.searchParams.get("field");
      if (field) {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const options = (domain.find((category) => category.id === field)?.options ?? []).filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(q));
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 60);
        data = { field, options: options.slice(offset, offset + limit), total: options.length, offset, limit };
      } else {
        const current = JSON.parse(url.searchParams.get("selection") ?? "{}");
        const selection: Record<string, unknown> = {};
        const selectedOptions: Record<string, unknown> = {};
        for (const category of domain) {
          const entry = current[category.id];
          if (!entry) continue;
          const values = new Set(category.options.map((option) => option.value));
          const next = { include: entry.include.filter((v: string) => values.has(v)), exclude: entry.exclude.filter((v: string) => values.has(v)) };
          if (next.include.length || next.exclude.length) { selection[category.id] = next; selectedOptions[category.id] = category.options.filter((option) => next.include.includes(option.value) || next.exclude.includes(option.value)); }
        }
        data = { categories: domain.map(({ options: _, ...category }) => category), selection, selectedOptions };
      }
    }
    else if (url.pathname === "/api/usage/analytics" || url.pathname === "/api/admin/analytics") data = analyticsFixture(series, url, url.pathname.startsWith("/api/admin")) as unknown as Record<string, unknown>;
    else if (url.pathname === "/api/usage/daily" || url.pathname === "/api/usage/overview") data = { series, models: [] };
    else if (url.pathname === "/api/admin/stats") data = { series, counts: { users: 8, keys: 12, activeKeys: 9, providers: 3 } };
    else if (url.pathname === "/api/keys") data = { keys: [] };
    else if (url.pathname === "/api/usage/breakdown") data = { rows: [row], total: 1, totals };
    else if (url.pathname === "/api/usage/events") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      data = { events: Array.from({ length: Math.min(limit, 73 - offset) }, (_, i) => ({ ...row, id: offset + i, ts: Date.now() - (offset + i) * 60_000, latency_ms: 1200, status: 200 })), total: 73, totals };
    } else if (url.pathname.includes("usage-breakdown/")) data = { [url.pathname.endsWith("users") ? "users" : "models"]: [{ ...row, user_id: "user", email: "alex@example.com" }], total: 1, totals };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ...data }) }).catch(() => {});
  });
  const assertFits = async (label: string) => {
    // Floating UI repositions on the next frame when the panel changes size.
    try {
      await page.waitForFunction(() => {
        const rect = document.querySelector(".analytics-popover")?.getBoundingClientRect();
        return rect && rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      }, undefined, { timeout: 2000 });
    } catch {
      await page.screenshot({ path: path.join(output, "overflow.png") });
      console.error(label, await page.getByRole("dialog").boundingBox(), await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: scrollY })));
    }
    const rect = await page.getByRole("dialog").boundingBox();
    const viewport = page.viewportSize()!;
    assert(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height, `${label} extends outside the viewport`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} creates horizontal overflow`);
  };
  const popupPosition = async () => {
    await assertFits("Popup");
    await page.getByRole("dialog").evaluate(async (el: HTMLElement) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})));
    });
    return (await page.getByRole("dialog").boundingBox())!;
  };
  const assertStableLeft = async (left: number, label: string) => {
    const current = await popupPosition();
    assert(Math.abs(current.x - left) < 1, `${label}: popup moved from ${left} to ${current.x}`);
  };
  const settleResults = () => page.waitForFunction(() => document.querySelector(".analytics-toolbar")?.closest("[aria-busy]")?.getAttribute("aria-busy") === "false");
  const assertGridFiltersDisabled = async (keys: string[]) => {
    await page.locator(".ag-row").first().waitFor();
    assert.equal(await page.locator(".ag-floating-filter").count(), 0, "AG Grid floating filters are still visible");
    assert(await page.evaluate((keys: string[]) => keys.every((key) => Object.keys(JSON.parse(localStorage.getItem(`llmgw-grid:${key}`) ?? "{}").filterModel ?? {}).length === 0), keys), "Legacy AG Grid filters were restored");
  };
  console.log("[filters-ui] Opening Usage");
  await page.goto(`${serverUrl}#/usage`);
  await assertGridFiltersDisabled(["usage.recent"]);
  const modelHeader = page.locator(".ag-header-cell[col-id='model']").first();
  assert.equal(Math.round((await modelHeader.boundingBox())!.width), 244, "Saved column widths were lost");
  await modelHeader.click();
  await page.waitForFunction(() => document.querySelector(".ag-header-cell[col-id='model']")?.getAttribute("aria-sort") === "ascending");
  console.log("[filters-ui] Checking include/exclude");
  await page.getByRole("button", { name: "Filter usage", exact: true }).click();
  const openingPosition = await popupPosition();
  await page.getByRole("button", { name: "Filter by Model", exact: true }).click();
  await assertStableLeft(openingPosition.x, "Expanding a category");
  await page.getByRole("button", { name: "Next filter options", exact: true }).click();
  await page.getByRole("button", { name: "Previous filter options", exact: true }).click();
  assert((await page.locator(".analytics-option").count()) <= 60, "A category rendered an unbounded option list");
  await page.getByRole("textbox", { name: "Search model…", exact: true }).fill("Claude");
  await assertStableLeft(openingPosition.x, "Searching options");
  const option = page.getByRole("dialog").getByRole("button", { name: /Claude Sonnet 4.5/ });
  holdAnalytics = true;
  const firstSelection = page.waitForRequest((req: any) => { const url = new URL(req.url()); return url.pathname === "/api/usage/analytics" && url.searchParams.get("selection")?.includes("model/0"); }, { timeout: 5000 }).then(() => true, () => false);
  try {
    await option.click();
    assert(await firstSelection, `Selection did not reach results: ${requests.slice(-8).map((url) => url.pathname + url.search).join("\n")}`);
    await page.waitForFunction(() => document.querySelector(".analytics-toolbar")?.closest("[aria-busy]")?.getAttribute("aria-busy") === "true");
    assert.equal(await page.locator(".ag-root-wrapper").count(), 1, "Usage grids disappeared while filters were loading");
    await assertStableLeft(openingPosition.x, "Applying a filter while data loads");
  } finally {
    holdAnalytics = false;
    for (const resolve of pendingResponses) resolve();
    pendingResponses.clear();
  }
  assert.equal(await option.getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Exclude", exact: true }).click();
  await assertStableLeft(openingPosition.x, "Switching include/exclude");
  await option.click();
  await settleResults();
  const last = requests.filter((url) => url.pathname === "/api/usage/analytics").at(-1)!;
  const selection = JSON.parse(last.searchParams.get("selection")!);
  assert.deepEqual(selection.model, { include: [], exclude: ["model/0"] });
  await assertFits("Desktop filters");
  await page.screenshot({ path: path.join(output, "desktop-filters-dark.png") });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert(await page.getByRole("button", { name: "Filter usage", exact: true }).evaluate((el: HTMLElement) => el === document.activeElement));
  await page.getByRole("button", { name: "Remove Model exclude filter" }).click();
  assert.equal(await page.getByRole("button", { name: "Clear all", exact: true }).count(), 0);

  console.log("[filters-ui] Checking date ranges");
  const time = () => page.getByRole("button", { name: /^Time range:/ });
  await time().click();
  await page.getByRole("button", { name: "1mo Past month", exact: true }).click();
  await time().click();
  await assertFits("Desktop presets");
  await page.screenshot({ path: path.join(output, "desktop-periods-dark.png") });
  await page.getByRole("button", { name: "Custom range…", exact: true }).click();
  await page.getByLabel("Start date and time").fill("2026-09-08T00:00");
  await page.getByLabel("End date and time").fill("2026-09-25T23:59");
  await assertFits("Desktop custom calendar");
  await page.screenshot({ path: path.join(output, "desktop-calendar-dark.png") });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.match(await time().getAttribute("aria-label") ?? "", /Past month/);
  await time().click();
  await page.getByRole("button", { name: "Custom range…", exact: true }).click();
  await page.getByLabel("Start date and time").fill("2026-09-25T00:00");
  await page.getByLabel("End date and time").fill("2026-09-08T23:59");
  assert(await page.getByRole("button", { name: "Apply range" }).isDisabled());
  await page.getByLabel("Start date and time").fill("2026-09-08T00:00");
  await page.getByLabel("End date and time").fill("2026-09-25T23:59");
  await page.getByRole("button", { name: "Apply range" }).click();
  await settleResults();
  assert.match(await time().getAttribute("aria-label") ?? "", /Custom range/);
  const query = requests.filter((url) => url.pathname === "/api/usage/analytics").at(-1)!.searchParams;
  assert.equal(await page.evaluate((raw: string) => new Date(Number(raw)).getDate(), query.get("from")!), 8);
  assert.equal(await page.evaluate((raw: string) => new Date(Number(raw)).getDate(), query.get("to")!), 26);
  for (const endpoint of ["/api/usage/events"]) {
    assert(requests.some((url) => url.pathname === endpoint && url.searchParams.get("from") === query.get("from") && url.searchParams.get("to") === query.get("to")), `${endpoint} lost the shared date range`);
  }
  await time().click();
  await page.getByRole("button", { name: "Custom range…", exact: true }).click();
  // Calendar reverse selection must normalize the endpoints.
  const dayButtons = page.locator(".analytics-day:not(.is-outside)");
  await dayButtons.filter({ hasText: /^25$/ }).click();
  await dayButtons.filter({ hasText: /^8$/ }).click();
  assert.match(await page.getByLabel("Start date and time").inputValue(), /-08T00:00$/);
  assert.match(await page.getByLabel("End date and time").inputValue(), /-25T23:59$/);
  await page.keyboard.press("Escape");

  console.log("[filters-ui] Checking mobile and themes");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  assert(requests.some((url) => url.pathname === "/api/usage/events" && url.searchParams.get("offset") === "25"));
  await page.getByRole("button", { name: "Filter usage", exact: true }).click();
  await page.getByRole("button", { name: "Filter by Model", exact: true }).click();
  await page.getByRole("textbox", { name: "Search model…", exact: true }).fill("GPT");
  await page.getByRole("dialog").getByRole("button", { name: /GPT-5/ }).click();
  await settleResults();
  await assertFits("Mobile filters");
  await page.screenshot({ path: path.join(output, "mobile-filters-dark.png") });
  await page.keyboard.press("Escape");
  assert(requests.filter((url) => url.pathname === "/api/usage/events").at(-1)!.searchParams.get("offset") === "0", "Mobile page was not reset after filtering");
  await time().click();
  await assertFits("Mobile presets");
  await page.getByRole("button", { name: "Custom range…", exact: true }).click();
  await assertFits("Mobile calendar");
  await page.screenshot({ path: path.join(output, "mobile-calendar-dark.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  await page.getByRole("button", { name: "Filter usage", exact: true }).click();
  await page.getByRole("button", { name: "Filter by Provider", exact: true }).click();
  await assertFits("Light theme");
  await page.screenshot({ path: path.join(output, "desktop-filters-light.png") });
  await page.keyboard.press("Escape");

  for (const route of ["/", "/admin/stats"]) {
    await page.goto(`${serverUrl}#${route}`);
    if (route === "/admin/stats") { await page.locator(".analytics-summary").first().waitFor(); assert.equal(await page.locator(".ag-root-wrapper").count(), 0, "Global Stats still renders a grid"); }
    // Exercise a trigger near the right edge, where the expanded panel needs
    // more room than the initial category menu.
    await page.locator(".analytics-controls").evaluate((el: HTMLElement) => { el.style.width = "100%"; el.style.justifyContent = "flex-end"; });
    await page.getByRole("button", { name: "Filter usage", exact: true }).click();
    const beforeExpansion = await popupPosition();
    await page.getByRole("button", { name: "Filter by Model", exact: true }).click();
    await assertStableLeft(beforeExpansion.x, `${route}: expansion near the viewport edge`);
    await page.getByRole("textbox", { name: "Search model…", exact: true }).fill("Gemini");
    await assertStableLeft(beforeExpansion.x, `${route}: searching near the viewport edge`);
    await page.getByRole("dialog").getByRole("button", { name: /Gemini 2.5 Pro/ }).click();
    await page.keyboard.press("Escape");
    await time().click();
    const periodPosition = await popupPosition();
    await page.getByRole("button", { name: "Custom range…", exact: true }).click();
    await assertStableLeft(periodPosition.x, `${route}: switching to custom dates`);
    await page.getByRole("button", { name: "Back to presets", exact: true }).click();
    await page.getByRole("button", { name: "15m Past 15 minutes", exact: true }).click();
    assert.match(await time().getAttribute("aria-label") ?? "", /Past 15 minutes/);
  }
  for (const width of [608, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Filter usage", exact: true }).click();
    const beforeExpansion = await popupPosition();
    await page.getByRole("button", { name: "Filter by Provider", exact: true }).click();
    await assertStableLeft(beforeExpansion.x, `${width}px: expanding beside the responsive breakpoint`);
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => document.documentElement.dataset.theme = "high-contrast");
  await time().click();
  await assertFits("Small screen presets");
  await page.getByRole("button", { name: "Custom range…", exact: true }).click();
  await assertFits("Small screen calendar");
  assert.equal(await page.getByRole("dialog").evaluate((el: HTMLElement) => getComputedStyle(el).animationName), "none");
  await page.getByRole("button", { name: "Cancel", exact: true }).scrollIntoViewIfNeeded();
  await assertFits("Small screen calendar actions");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  console.log("[filters-ui] Checking date → options → results");
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.goto(`${serverUrl}#/usage`);
  await page.getByRole("button", { name: "Filter usage", exact: true }).click();
  await page.getByRole("button", { name: "Filter by Model", exact: true }).click();
  await page.getByRole("textbox", { name: "Search model…", exact: true }).fill("Claude");
  await page.getByRole("dialog").getByRole("button", { name: /Claude Sonnet/ }).click();
  await settleResults();
  await page.keyboard.press("Escape");
  await time().click();
  await page.getByRole("button", { name: "Custom range…", exact: true }).click();
  await page.getByLabel("Start date and time").fill("2020-01-01T00:00");
  await page.getByLabel("End date and time").fill("2020-01-31T23:59");
  holdDateMetadata = true;
  const changedMetadata = page.waitForRequest((req: any) => { const url = new URL(req.url()); return url.pathname.endsWith("filter-options") && !url.searchParams.has("field") && new Date(Number(url.searchParams.get("from"))).getFullYear() === 2020; });
  try {
    await page.getByRole("button", { name: "Apply range" }).click();
    await changedMetadata;
    assert(!requests.some((url) => url.pathname === "/api/usage/analytics" && new Date(Number(url.searchParams.get("from"))).getFullYear() === 2020), "Results ran before old selections were validated");
    await page.getByRole("button", { name: "Filter usage", exact: true }).click();
    assert.equal(await page.locator(".analytics-option").count(), 0, "Options from the previous period stayed visible");
  } finally {
    holdDateMetadata = false;
    for (const resolve of pendingMetadata) resolve();
    pendingMetadata.clear();
  }
  await settleResults();
  assert.equal(await page.getByRole("button", { name: "Remove Model include filter" }).count(), 0);
  await page.getByRole("button", { name: "Filter by Model", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /GPT-5/ }).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: /Claude Sonnet/ }).count(), 0);
  const metadataRequests = requests.filter((url) => url.pathname.endsWith("filter-options") && !url.searchParams.has("field")).length;
  await page.getByRole("dialog").getByRole("button", { name: /GPT-5/ }).click();
  await settleResults();
  assert.equal(requests.filter((url) => url.pathname.endsWith("filter-options") && !url.searchParams.has("field")).length, metadataRequests, "Toggling a result filter reloaded the date domain");
  const beforeSearch = requests.length;
  const searched = page.waitForResponse((response: any) => { const url = new URL(response.url()); return url.pathname.endsWith("filter-options") && url.searchParams.get("q") === "GPT"; });
  await page.getByRole("textbox", { name: "Search model…", exact: true }).evaluate((input: HTMLInputElement) => {
    for (const value of ["G", "GP", "GPT"]) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  await searched;
  assert.deepEqual(requests.slice(beforeSearch).filter((url) => url.pathname.endsWith("filter-options") && url.searchParams.has("field")).map((url) => url.searchParams.get("q")), ["GPT"], "Typeahead did not coalesce rapid input");
  await page.keyboard.press("Escape");
  assert(requests.filter((url) => url.pathname === "/api/usage/events" || url.pathname === "/api/usage/breakdown" || url.pathname.includes("usage-breakdown/")).every((url) => !url.searchParams.has("filters")), "A grid forwarded column filters to the API");
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(`Gateway filters UI passed: stable popup positioning, grids without column filters, preserved layout, include/exclude, shared queries, keyboard, calendar, responsive themes and all three pages. Screenshots: ${output}`);
} catch (error) {
  if (activePage) {
    await activePage.screenshot({ path: path.join(output, "failure.png") });
    console.error(await activePage.locator(".analytics-popover").allTextContents());
  }
  console.error("[filters-ui] Failed", error);
  throw error;
} finally {
  await browser.close(); server.closeAllConnections(); server.close();
}
