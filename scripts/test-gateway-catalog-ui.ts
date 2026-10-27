// PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node --experimental-strip-types scripts/test-gateway-catalog-ui.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");
const output = path.join(root, "tmp/gateway-catalog-ui");
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
  const errors: string[] = [];
  const reads: URL[] = [];
  const selectedQueries: string[][] = [];
  const now = Date.now(), createdAt = Date.UTC(2024, 0, 1);
  const providers = Array.from({ length: 4 }, (_, i) => ({ id: `provider-${i}`, name: `Provider ${i}`, enabled: i !== 3, priority: i, createdAt, modelCount: 40, openaiBaseUrl: "https://upstream.example/v1", openaiAuthStyle: "bearer", anthropicBaseUrl: i % 2 ? null : "https://upstream.example/anthropic", responsesBaseUrl: null, keys: [{ id: `pk-${i}`, label: "Primary", status: "active", priority: 0, failCount: 0 }], stripParams: [], hasApiKey: true }));
  const models = Array.from({ length: 125 }, (_, i) => ({ id: `test/model-${String(i).padStart(3, "0")}`, name: `Model ${i}`, providerId: `provider-${i % 4}`, providerName: `Provider ${i % 4}`, upstreamModel: `upstream/model-${i}`, enabled: i % 3 !== 0, source: i % 2 ? "manual" : "auto", toolCallMode: "fallback", contextLength: 128000, createdAt: createdAt + i, updatedAt: createdAt + i, pricingInput: .000001, pricingOutput: .000004, pricingInputCache: .0000002, targets: [], features: ["tools"], inputModalities: ["text"], outputModalities: ["text"], samplingParams: [] }));
  const users = Array.from({ length: 125 }, (_, i) => ({ id: i === 0 ? "user" : `user-${i}`, name: `Person ${i}`, email: `person${i}@example.com`, role: i % 5 ? "user" : "admin", status: i % 4 ? "active" : "banned", keyCount: i + 1, hasPassword: true, googleLinked: !!(i % 2), totpEnabled: !!(i % 2), createdAt: createdAt + i, lastLoginAt: now - i * 1000 }));
  const keys = Array.from({ length: 125 }, (_, i) => ({ id: `key-${i}`, userId: i % 2 ? "other" : "user", userEmail: i % 2 ? "other@example.com" : "alex@example.com", name: `Key ${i}`, prefix: "sk-test", status: i % 3 ? "active" : "revoked", outputToday: 1200 + i, outputTotal: 10000 + i, totalLimit: null, dailyLimit: null, revealable: true, rpm: 100, createdAt: createdAt + i, lastUsedAt: now - i * 1000, expiresAt: null }));
  const entries = Array.from({ length: 125 }, (_, i) => ({ id: i + 1, ts: now - i * 60000, action: i % 2 ? "key.create" : "login.failed", actor_email: `person${i % 10}@example.com`, target: `target-${i}`, meta: JSON.stringify({ note: `Event ${i}` }), ip: `192.0.2.${i % 10}` }));
  const descriptors: Record<string, any[]> = {
    keys: [{ id: "key", label: "API key", values: (r: any) => [r.id], text: (r: any) => r.name }, { id: "status", label: "Status", values: (r: any) => [r.status] }, { id: "owner", label: "Owner", values: (r: any) => [r.userEmail] }],
    models: [{ id: "model", label: "Model", values: (r: any) => [r.id], text: (r: any) => r.name }, { id: "provider", label: "Provider", values: (r: any) => [r.providerId], text: (r: any) => r.providerName }, { id: "status", label: "Status", values: (r: any) => [r.enabled ? "active" : "disabled"] }],
    users: [{ id: "user", label: "User", values: (r: any) => [r.id], text: (r: any) => r.email }, { id: "role", label: "Role", values: (r: any) => [r.role] }, { id: "status", label: "Status", values: (r: any) => [r.status] }],
    providers: [{ id: "provider", label: "Provider", values: (r: any) => [r.id], text: (r: any) => r.name }, { id: "status", label: "Status", values: (r: any) => [r.enabled ? "enabled" : "disabled"] }],
    audit: [{ id: "action", label: "Action", values: (r: any) => [r.action] }, { id: "actor", label: "Actor", values: (r: any) => [r.actor_email] }, { id: "target", label: "Target", values: (r: any) => [r.target] }],
  };
  let failList = false;
  const mockApi = async (route: any) => {
    const url = new URL(route.request().url()); reads.push(url);
    const match = url.pathname.match(/^\/api\/(?:admin\/)?(keys|providers|models|users|audit)(?:\/(filter-options|selection|query))?$/);
    let data: any = {};
    if (match) {
      const kind = match[1]!, operation = match[2];
      const result = kind === "audit" ? "entries" : kind;
      const own = url.pathname.startsWith("/api/keys");
      let domain: any[] = ({ keys, providers, models, users, audit: entries } as any)[kind];
      if (own) domain = domain.filter((row) => row.userId === "user");
      if (url.searchParams.has("from") && url.searchParams.get("from") !== "all") domain = domain.filter((row) => (kind === "audit" ? row.ts : row.createdAt) >= Number(url.searchParams.get("from")));
      if (url.searchParams.has("to")) domain = domain.filter((row) => (kind === "audit" ? row.ts : row.createdAt) < Number(url.searchParams.get("to")));
      const fields = descriptors[kind]!.filter((field) => !own || field.id !== "owner");
      const selection = JSON.parse(url.searchParams.get("selection") ?? "{}");
      if (operation === "filter-options") {
        const id = url.searchParams.get("field");
        const optionsFor = (field: any) => {
          const options = new Map<string, any>();
          for (const row of domain) for (const value of field.values(row)) { const old = options.get(value); options.set(value, { value, label: field.text?.(row) ?? value[0].toUpperCase() + value.slice(1), count: (old?.count ?? 0) + 1 }); }
          return [...options.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        };
        if (id) {
          const q = (url.searchParams.get("q") ?? "").toLowerCase();
          const options = optionsFor(fields.find((field) => field.id === id)).filter((option) => `${option.value} ${option.label}`.toLowerCase().includes(q));
          const offset = Number(url.searchParams.get("offset") ?? 0);
          data = { field: id, total: options.length, options: options.slice(offset, offset + 60), offset, limit: 60 };
        } else {
          const selectedOptions: any = {};
          for (const field of fields) selectedOptions[field.id] = optionsFor(field).filter((option) => [...(selection[field.id]?.include ?? []), ...(selection[field.id]?.exclude ?? [])].includes(option.value));
          data = { categories: fields.map(({ id, label }) => ({ id, label, icon: "lucide:layers" })), selection, selectedOptions };
        }
      } else {
        for (const field of fields) { const filter = selection[field.id]; if (filter) domain = domain.filter((row) => (!filter.include?.length || field.values(row).some((value: string) => filter.include.includes(value))) && !field.values(row).some((value: string) => filter.exclude?.includes(value))); }
        const query = (url.searchParams.get("search") ?? "").toLowerCase();
        if (query) domain = domain.filter((row) => Object.values(row).some((value) => typeof value === "string" && value.toLowerCase().includes(query)));
        const selected = operation === "query" ? JSON.stringify(route.request().postDataJSON().selected_ids) : url.searchParams.get("selected_ids");
        if (selected) { selectedQueries.push(JSON.parse(selected)); domain = domain.filter((row) => JSON.parse(selected).includes(row.id)); }
        if (operation === "selection") data = { ids: domain.map((row) => row.id) };
        else {
          if (failList && url.searchParams.has("limit")) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: "List is busy" }) }); return; }
          const sorts = JSON.parse(url.searchParams.get("sort") ?? "[]");
          if (sorts.length) { const { colId, sort } = sorts[0]; domain = [...domain].sort((a, b) => typeof a[colId] === "number" ? (a[colId] - b[colId]) * (sort === "asc" ? 1 : -1) : String(a[colId] ?? "").localeCompare(String(b[colId] ?? "")) * (sort === "asc" ? 1 : -1)); }
          const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 500);
          data = { [result]: domain.slice(offset, offset + limit), total: domain.length };
        }
      }
    } else if (url.pathname.endsWith("/settings")) data = { settings: { routingMode: "router" } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ...data }) }).catch(() => {});
  };
  const setup = async (target: any) => {
    target.setDefaultTimeout(12_000); target.on("pageerror", (error: Error) => errors.push(String(error)));
    await target.addInitScript(() => {
      localStorage.setItem("cache_code_session", JSON.stringify({ accessToken: "ui-test", refreshToken: "ui-test", user: { id: "user", name: "Alex Morgan", email: "alex@example.com", role: "admin", status: "active" } }));
      localStorage.setItem("llmgw-theme", "dark");
      for (const key of ["keys.user", "admin.models", "admin.users.list", "admin.keys", "admin.audit"]) localStorage.setItem(`llmgw-grid:${key}`, JSON.stringify({ columnState: [{ colId: "name", width: 500, hide: true }], userResizedColumns: ["name"], filterModel: { name: { filterType: "text", filter: "stale" } } }));
    });
    await target.route("**/api/**", mockApi);
  };
  const settled = (target = page) => target.waitForFunction(() => document.querySelector(".catalog-page")?.getAttribute("aria-busy") === "false" && !!document.querySelector(".catalog-results"));
  const fits = async (label: string) => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: page overflow`);
  const openSort = async (target: any, label: string, touch = false) => {
    const trigger = target.getByRole("combobox", { name: `Sort ${label}`, exact: true });
    assert.equal(await trigger.evaluate((element: HTMLElement) => element.tagName), "BUTTON", `${label}: native sort selector`);
    assert.equal(await target.locator(".catalog-toolbar select").count(), 0);
    if (touch) await trigger.tap(); else await trigger.click();
    const menu = target.getByRole("listbox", { name: `Sort ${label}`, exact: true });
    await menu.waitFor({ state: "visible" });
    await menu.evaluate(async (element: HTMLElement) => { await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(await trigger.getAttribute("aria-controls"), await menu.getAttribute("id"));
    assert(await menu.evaluate((element: HTMLElement) => { const rect = element.getBoundingClientRect(); return rect.left >= 11 && rect.right <= innerWidth - 11 && rect.top >= 0 && rect.bottom <= innerHeight; }), `${label}: sort menu left viewport`);
    return { trigger, menu };
  };
  const cases = [{ route: "keys", label: "api keys" }, { route: "admin/providers", label: "providers" }, { route: "admin/models", label: "models" }, { route: "admin/users", label: "users" }, { route: "admin/keys", label: "all api keys" }, { route: "admin/audit", label: "audit events" }];
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }); await setup(page);
  for (const item of cases) {
    console.log(`[catalog-ui] Desktop ${item.label}`);
    await page.goto(`${serverUrl}#/${item.route}`); await settled();
    const { trigger, menu } = await openSort(page, item.label);
    assert.equal(await menu.getByRole("option", { name: "Default order", exact: true }).getAttribute("aria-selected"), "true");
    const optionLabel = await menu.getByRole("option").nth(1).innerText();
    await menu.getByRole("option").nth(1).click(); await settled();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert(await trigger.evaluate((element: HTMLElement) => element === document.activeElement), "Sort did not restore trigger focus");
    const reopened = await openSort(page, item.label);
    assert.equal(await reopened.menu.getByRole("option", { name: optionLabel, exact: true }).getAttribute("aria-selected"), "true");
    if (item.label === "models") await page.screenshot({ path: path.join(output, "models-sort-desktop.png") });
    await page.keyboard.press("Escape");
    await trigger.press("ArrowDown"); await trigger.press("Home"); await trigger.press("Enter"); await settled();
    assert.equal(await trigger.innerText(), "Sort");
    assert.equal(await page.locator(".ag-floating-filter").count(), 0);
    assert.equal(await page.getByRole("button", { name: /Reset layout|^Reset Model/ }).count(), 0);
    if (!item.route.endsWith("providers")) {
      const column = item.route.endsWith("models") ? "id" : item.route.endsWith("users") ? "email" : item.route.endsWith("audit") ? "action" : "name";
      await page.waitForFunction((column: string) => Array.from(document.querySelectorAll(`.ag-cell[col-id='${column}']`)).some((cell) => /Key |model-|person|Create key|Failed sign/.test(cell.textContent ?? "")), column);
      assert.equal(await page.locator(".ag-header-cell-resize:visible").count(), 0);
      assert(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem(document.querySelector(".catalog-page")?.textContent?.includes("All API keys") ? "llmgw-grid:admin.keys" : location.hash === "#/keys" ? "llmgw-grid:keys.user" : location.hash === "#/admin/models" ? "llmgw-grid:admin.models" : location.hash === "#/admin/users" ? "llmgw-grid:admin.users.list" : "llmgw-grid:admin.audit") ?? "{}")).every((key) => key === "sortModel")));
    }
    await fits(item.label); await page.screenshot({ path: path.join(output, `${item.route.replace("/", "-")}-desktop.png`) });
    if (!item.route.endsWith("audit")) {
      await page.getByRole("button", { name: `Filter ${item.label}`, exact: true }).click();
      await page.getByRole("dialog").evaluate(async (element: HTMLElement) => { await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
      const before = await page.getByRole("dialog").boundingBox();
      await page.getByRole("button", { name: "Filter by Status", exact: true }).click();
      const after = await page.getByRole("dialog").boundingBox(); assert(Math.abs(before.x - after.x) < 1, "Filter panel jumped on expansion");
      await page.getByRole("dialog").locator(".analytics-option").first().click(); await settled();
      await page.getByRole("button", { name: "Exclude", exact: true }).click();
      await page.getByRole("dialog").locator(".analytics-option").first().click(); await settled();
      await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Clear all", exact: true }).click(); await settled();
    }
  }
  console.log("[catalog-ui] Mobile pagination and searches beyond the first page");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const item of cases) {
    await page.goto(`${serverUrl}#/${item.route}`); await settled();
    assert.equal(await page.locator(".ag-root-wrapper").count(), 0, `${item.label}: hidden desktop grid remained mounted`);
    await fits(`Mobile ${item.label}`);
    await page.screenshot({ path: path.join(output, `${item.route.replace("/", "-")}-mobile.png`) });
    if (!item.route.endsWith("providers")) {
      await page.getByRole("button", { name: "Next", exact: true }).click(); await settled();
      assert(reads.some((url) => url.pathname === `/api/${item.route}` && url.searchParams.get("offset") === "25"));
      await page.getByRole("searchbox", { name: `Search ${item.label}`, exact: true }).fill("124"); await settled();
      await page.waitForFunction(() => /^1 /.test(document.querySelector(".catalog-result-count")?.textContent ?? ""));
      assert((await page.locator(".catalog-mobile").innerText()).includes("124"), `${item.label}: search did not reach records beyond the first page`);
      await page.getByRole("button", { name: `Clear ${item.label} search`, exact: true }).click();
      assert.equal(await page.getByRole("searchbox", { name: `Search ${item.label}`, exact: true }).inputValue(), "");
      assert(await page.getByRole("searchbox", { name: `Search ${item.label}`, exact: true }).evaluate((element: HTMLElement) => element === document.activeElement));
    }
    await page.setViewportSize({ width: 320, height: 844 }); await fits(`Small ${item.label}`); await page.setViewportSize({ width: 390, height: 844 });
  }
  console.log("[catalog-ui] Cross-device model selection");
  await page.goto(`${serverUrl}#/admin/models`); await settled();
  await page.getByRole("checkbox", { name: "Select model test/model-000", exact: true }).check();
  assert.match(await page.locator(".catalog-selection strong").innerText(), /^1 selected$/);
  await page.getByRole("button", { name: "Select page", exact: true }).click();
  assert.equal(await page.locator(".catalog-selection strong").innerText(), "25 selected");
  await page.getByRole("button", { name: "Select all results", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".catalog-selection strong")?.textContent === "125 selected");
  await page.getByRole("button", { name: "Selected only", exact: true }).click(); await settled();
  assert.equal(selectedQueries.at(-1)!.length, 125);
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  await page.getByRole("heading", { name: "Delete selected models", exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 }); await settled(); await page.locator(".ag-row-selected").first().waitFor();
  assert.equal(await page.locator(".catalog-selection strong").innerText(), "125 selected");
  await page.getByRole("button", { name: "Clear selection", exact: true }).click(); await settled();
  await page.locator(".ag-row .ag-selection-checkbox").first().click();
  await page.waitForFunction(() => document.querySelector(".catalog-selection strong")?.textContent === "1 selected");
  await page.setViewportSize({ width: 390, height: 844 }); await settled();
  assert(await page.getByRole("checkbox", { name: "Select model test/model-000", exact: true }).isChecked());
  await page.screenshot({ path: path.join(output, "models-selection-mobile.png") });
  const mobileSort = await openSort(page, "models");
  const initialScroll = await page.evaluate(() => scrollY);
  await mobileSort.trigger.press("End");
  assert.match(await mobileSort.menu.locator('[data-hl="1"]').innerText(), /Lowest output price/);
  assert.equal(await page.evaluate(() => scrollY), initialScroll, "Sort keyboard navigation moved the page");
  await mobileSort.trigger.press("Home"); await mobileSort.trigger.press("n");
  assert.equal(await mobileSort.menu.locator('[data-hl="1"]').innerText(), "Name A–Z");
  await mobileSort.trigger.press("Enter"); await settled();
  const preservedSort = await openSort(page, "models");
  await preservedSort.trigger.press("Tab");
  assert.equal(await page.getByRole("listbox").count(), 0, "Tab did not dismiss sort menu");
  await openSort(page, "models");
  await page.getByRole("searchbox", { name: "Search models", exact: true }).focus();
  assert.equal(await page.getByRole("listbox").count(), 0, "Moving focus outside did not dismiss sort menu");
  await openSort(page, "models");
  await page.getByRole("button", { name: "Filter models", exact: true }).click();
  assert.equal(await page.getByRole("listbox").count(), 0, "Opening filters left sort menu open");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 768, height: 1000 }); await settled(); await fits("Tablet models");
  await page.waitForFunction(() => document.querySelector(".ag-header-cell[col-id='name']")?.getAttribute("aria-sort") === "ascending");
  await page.locator(".ag-header-cell[col-id='name'] .ag-header-cell-label").click(); await settled();
  await page.waitForFunction(() => document.querySelector(".ag-header-cell[col-id='name']")?.getAttribute("aria-sort") === "descending");
  const customSort = await openSort(page, "models");
  assert.match(await customSort.menu.locator('[aria-selected="true"]').innerText(), /Descending/);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(output, "models-tablet.png") });
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  await openSort(page, "models"); await page.screenshot({ path: path.join(output, "models-sort-light.png") }); await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(output, "models-light.png") });
  await page.evaluate(() => document.documentElement.dataset.theme = "high-contrast"); await fits("High contrast models");
  failList = true; await page.getByRole("searchbox", { name: "Search models", exact: true }).fill("failure");
  await page.getByRole("alert").waitFor();
  failList = false; await page.getByRole("button", { name: "Try again", exact: true }).click(); await settled();
  assert(await page.getByText("No matching models", { exact: true }).isVisible());
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" }); await setup(touch);
  await touch.goto(`${serverUrl}#/admin/models`); await settled(touch);
  const touchSort = await openSort(touch, "models", true);
  assert(await touchSort.menu.getByRole("option").first().evaluate((element: HTMLElement) => element.getBoundingClientRect().height >= 44), "Sort options are too small for touch");
  assert(await touchSort.menu.evaluate((element: HTMLElement) => element.scrollHeight <= element.clientHeight + 1), "Short sort menu unnecessarily scrolls on mobile");
  await touch.screenshot({ path: path.join(output, "models-sort-touch.png") });
  await touchSort.menu.getByRole("option", { name: "Name A–Z", exact: true }).tap(); await settled(touch);
  await touch.getByRole("button", { name: "New model", exact: true }).tap();
  const providerSelect = touch.getByRole("combobox", { name: "Provider for target 1", exact: true });
  await providerSelect.tap();
  await touch.getByRole("listbox", { name: "Provider for target 1", exact: true }).waitFor({ state: "visible" });
  await touch.keyboard.press("Escape");
  assert.equal(await touch.getByRole("dialog", { name: "Register model", exact: true }).count(), 1, "Escape on select dismissed its parent modal");
  await providerSelect.tap();
  await touch.getByRole("option", { name: /Provider 1/, exact: false }).tap();
  assert.match(await providerSelect.innerText(), /Provider 1/);
  await touch.getByRole("button", { name: "Cancel", exact: true }).tap();
  await touch.getByRole("checkbox", { name: "Select model test/model-000", exact: true }).tap();
  assert.equal(await touch.locator(".catalog-selection strong").innerText(), "1 selected");
  await touch.getByRole("button", { name: "Selected only", exact: true }).tap(); await settled(touch);
  await touch.getByRole("checkbox", { name: "Select model test/model-000", exact: true }).tap(); await settled(touch);
  assert(await touch.getByRole("button", { name: "Selected only", exact: true }).isEnabled(), "Empty selected-only view cannot be exited");
  await touch.getByRole("button", { name: "Selected only", exact: true }).tap(); await settled(touch);
  await touch.getByRole("button", { name: "Filter models", exact: true }).tap();
  await touch.getByRole("button", { name: "Filter by Status", exact: true }).tap();
  await touch.getByRole("dialog").locator(".analytics-option").first().tap(); await settled(touch);
  await touch.screenshot({ path: path.join(output, "models-touch-filters.png") });
  await touch.keyboard.press("Escape");
  await touch.setViewportSize({ width: 320, height: 844 });
  for (const item of cases) { await touch.goto(`${serverUrl}#/${item.route}`); await settled(touch); assert(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Small touch layout overflows: ${item.label}`); }
  await touch.close();
  assert.deepEqual(errors, [], "Browser runtime errors");
  assert(!reads.some((url) => url.searchParams.has("filters")), "A page still sends AG Grid column filters");
  console.log(`Catalog UI passed: six pages, custom sorting, keyboard navigation, typeahead, focus return, modal selects, touch targets, external filters, fixed grids, mobile paging, full-inventory search, model bulk selection across devices, retry and themes. Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure.png") });
  throw error;
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
