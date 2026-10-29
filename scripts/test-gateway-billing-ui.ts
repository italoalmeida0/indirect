// PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node --experimental-strip-types scripts/test-gateway-billing-ui.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("..", import.meta.url)), output = path.join(root, "tmp/gateway-billing-ui");
mkdirSync(output, { recursive: true });
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const candidate = path.join(root, "dist", pathname === "/" ? "index.html" : pathname);
  const file = existsSync(candidate) ? candidate : path.join(root, "dist/index.html");
  const types: Record<string,string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream"); res.end(readFileSync(file));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
let page: any;
try {
  const errors: string[] = [], writes: { path: string; body: any }[] = [];
  const now = Date.now(), userId = "a".repeat(24), pro = "b".repeat(24);
  const plans = [{ id: pro, name: "Pro", monthlyUsd: 100, weeklyEnabled: true, sessionEnabled: true, members: 12, createdAt: now, updatedAt: now }, { id: "c".repeat(24), name: "Essential", monthlyUsd: 20, weeklyEnabled: false, sessionEnabled: false, members: 8, createdAt: now, updatedAt: now }, { id: "d".repeat(24), name: "Enterprise", monthlyUsd: null, weeklyEnabled: false, sessionEnabled: false, members: 3, createdAt: now, updatedAt: now }];
  const billing: any = { plan: plans[0], sessionStarted: true, serverTime: now, windows: [
    { kind: "monthly", startsAt: now - 7*86400000, resetsAt: now+20*86400000, limitUsd: 100, spentUsd: 62.4, billedUsd: 62.4, reservedUsd: 2.1, remainingUsd: 35.5 },
    { kind: "weekly", startsAt: now - 2*86400000, resetsAt: now+5*86400000, limitUsd: 22.580645161, spentUsd: 11.8, billedUsd: 11.8, reservedUsd: .5, remainingUsd: 10.280645161 },
    { kind: "session", startsAt: now - 2*3600000, resetsAt: now+3*3600000, limitUsd: .67204301, spentUsd: .5, billedUsd: .5, reservedUsd: .02, remainingUsd: .15204301 },
  ], resets: [{ id: "e".repeat(24), kind: "both", remaining: 1, expiresAt: now+14*86400000, note: "A little extra room for your next project." }] };
  const member: any = { id: userId, name: "Jordan Lee", email: "jordan@example.com", role: "user", status: "active", hasPassword: true, googleLinked: true, totpEnabled: true, keyCount: 3, createdAt: now-30*86400000, lastLoginAt: now, planId: pro, planName: "Pro" };
  const keys = [{ id: "f".repeat(24), userId, name: "Production", prefix: "gw_example", createdAt: now, expiresAt: null, dailyLimitUsd: 10, totalLimitUsd: 100, rpm: 100, status: "active", spendTodayUsd: 2.1, spendTotalUsd: 23.75, revealable: true, lastUsedAt: now }];
  let failBilling = false;
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(12000); page.on("pageerror", (error: Error) => errors.push(String(error)));
  await page.addInitScript(() => { localStorage.setItem("cache_code_session", JSON.stringify({ accessToken: "ui-test", refreshToken: "ui-test", user: { id: "admin", name: "Alex Morgan", email: "alex@example.com", role: "admin", status: "active" } })); localStorage.setItem("llmgw-theme", "dark"); localStorage.setItem("llmgw-grid:keys.user", JSON.stringify({ sortModel: [{ colId: "outputTotal", sort: "desc" }] })); });
  const mockApi = async (route: any) => {
    const url = new URL(route.request().url()), method = route.request().method();
    const body = method === "GET" || method === "DELETE" ? null : route.request().postDataJSON();
    if (method !== "GET") writes.push({ path: url.pathname, body });
    let data: any = {};
    if (url.pathname === "/api/billing" && failBilling) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: "Temporarily unavailable" }) }); return; }
    if (url.pathname === "/api/billing" || url.pathname.endsWith("/billing")) {
      if (method === "PATCH") {
        billing.plan = plans.find((p) => p.id === body.planId) ?? null; member.planId = body.planId; member.planName = billing.plan?.name ?? null;
        const days = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth()+1, 0)).getUTCDate();
        billing.windows = billing.windows.filter((window: any) => window.kind === "monthly" || window.kind === "weekly" && billing.plan?.weeklyEnabled || window.kind === "session" && billing.plan?.sessionEnabled).map((window: any) => { const cap = billing.plan?.monthlyUsd; const limit = cap == null ? null : cap * (window.kind === "weekly" ? 7/days : window.kind === "session" ? 5/(24*days) : 1); return { ...window, limitUsd: limit, remainingUsd: limit === null ? null : Math.max(0, limit - window.spentUsd - window.reservedUsd) }; });
      }
      data = { billing };
    } else if (url.pathname.endsWith("/redeem")) {
      for (const window of billing.windows) if (window.kind !== "monthly") { window.spentUsd = 0; window.remainingUsd = window.limitUsd - window.reservedUsd; }
      billing.resets = []; data = { billing };
    } else if (url.pathname.endsWith("/resets")) { billing.resets.push({ id: "1".repeat(24), kind: body.kind, remaining: body.count, expiresAt: body.expiresAt, note: body.note }); data = { billing }; }
    else if (url.pathname === "/api/admin/plans") { if (method === "POST") plans.push({ ...body, id: "2".repeat(24), members: 0, createdAt: now, updatedAt: now }); data = { plans }; }
    else if (url.pathname.startsWith("/api/admin/plans/")) { Object.assign(plans.find((p) => p.id === url.pathname.split("/").at(-1)) ?? {}, body); data = { plans }; }
    else if (url.pathname === "/api/admin/users") data = { users: [member], total: 1 };
    else if (url.pathname === "/api/keys" || url.pathname === "/api/admin/keys") { if (method === "POST") data = { key: { ...keys[0], ...body }, token: "gw_ui_test_only" }; else data = { keys, total: 1 }; }
    else if (url.pathname.endsWith("/filter-options")) data = { categories: [], selection: {}, selectedOptions: {} };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ...data }) });
  };
  await page.route("**/api/**", mockApi);
  const fits = async (label: string) => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: horizontal page overflow`);
  console.log("[billing-ui] Account limits and reset redemption");
  await page.goto(`${base}#/limits`); await page.getByRole("heading", { name: "Monthly allowance", exact: true }).waitFor();
  assert.equal(await page.locator("select").count(), 0); assert.equal(await page.getByRole("progressbar").count(), 3);
  assert(await page.getByText("$35.50", { exact: true }).isVisible());
  await page.screenshot({ path: path.join(output, "limits-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Use reset", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Restore your allowance?", exact: true });
  await dialog.getByRole("button", { name: "Use reset", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  assert.equal(writes.at(-1)!.path, `/api/billing/resets/${"e".repeat(24)}/redeem`); assert(writes.at(-1)!.body.requestId.length >= 16);
  assert.equal(billing.windows[0].spentUsd, 62.4); await page.getByText("No resets available.", { exact: false }).waitFor();
  console.log("[billing-ui] Plan creation, custom selection and administrator grants");
  await page.goto(`${base}#/admin/plans`); await page.locator(".billing-plan-card").first().waitFor();
  await page.screenshot({ path: path.join(output, "plans-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create plan", exact: true });
  assert.equal(await editor.getByRole("switch", { name: "Weekly allowance", exact: true }).isChecked(), false);
  assert.equal(await editor.getByRole("switch", { name: "5-hour sessions", exact: true }).isChecked(), false);
  await editor.getByRole("textbox", { name: "Plan name", exact: true }).fill("Team");
  await editor.getByRole("spinbutton", { name: "Monthly allowance (USD)", exact: true }).fill("200");
  await editor.getByText("Weekly allowance", { exact: true }).click();
  await editor.getByRole("button", { name: "Save plan", exact: true }).click(); await editor.waitFor({ state: "hidden" });
  const saved = writes.at(-1)!.body; assert.deepEqual(saved, { name: "Team", monthlyUsd: 200, weeklyEnabled: true, sessionEnabled: false });
  await page.goto(`${base}#/admin/users`); await page.getByRole("button", { name: "Manage plan and resets", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Plan & allowance", exact: true });
  const selection = manager.getByRole("combobox", { name: "Account plan", exact: true }); await selection.click();
  await page.getByRole("option", { name: /Team.*200/, exact: false }).click(); await manager.getByRole("button", { name: "Save plan", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"] [role="combobox"]')?.textContent?.includes("Team"));
  await manager.getByRole("spinbutton", { name: "Number of resets", exact: true }).fill("2");
  await manager.getByRole("textbox", { name: "Reset note", exact: true }).fill("Project launch");
  await manager.getByRole("button", { name: "Grant reset", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("2 available"));
  assert(writes.some((entry) => entry.path.endsWith("/resets") && entry.body.kind === "weekly" && entry.body.count === 2));
  await page.screenshot({ path: path.join(output, "user-plan-desktop.png"), fullPage: true });
  await manager.getByRole("button", { name: "Done", exact: true }).click();
  console.log("[billing-ui] USD API key form and small-screen layouts");
  await page.goto(`${base}#/keys`); assert.match(await page.getByRole("combobox", { name: "Sort api keys", exact: true }).innerText(), /Highest spend/); await page.getByRole("button", { name: "New key", exact: true }).click();
  const keyEditor = page.getByRole("dialog", { name: "Create API key", exact: true });
  await keyEditor.locator('input[type="text"]').first().fill("Development");
  await keyEditor.getByLabel(/Daily limit \(USD\)/).fill("5.50"); await keyEditor.getByLabel(/Lifetime limit \(USD\)/).fill("50.25");
  await keyEditor.getByRole("button", { name: "Create key", exact: true }).click(); await keyEditor.waitFor({ state: "hidden" });
  assert(writes.some((entry) => entry.path === "/api/keys" && entry.body.dailyLimitUsd === 5.5 && entry.body.totalLimitUsd === 50.25 && entry.body.dailyLimit === undefined));
  await page.waitForTimeout(4100);
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["limits", "admin/plans", "admin/users", "keys"]) {
      await page.goto(`${base}#/${route}`); await page.waitForTimeout(150); await fits(`${width} ${route}`);
      if (width === 390 && (route === "limits" || route === "admin/plans")) await page.screenshot({ path: path.join(output, `${route.replace("/", "-")}-mobile.png`), fullPage: true });
    }
  }
  await page.goto(`${base}#/admin/users`); await page.getByRole("button", { name: "Manage plan and resets", exact: true }).click();
  await page.getByRole("combobox", { name: "Account plan", exact: true }).click();
  const list = page.getByRole("listbox", { name: "Account plan", exact: true }); await list.waitFor({ state: "visible" });
  assert(await list.evaluate((element: HTMLElement) => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  await page.keyboard.press("Escape"); await page.screenshot({ path: path.join(output, "user-plan-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  for (const theme of ["light", "high-contrast"]) { await page.evaluate((theme: string) => document.documentElement.dataset.theme = theme, theme); await page.goto(`${base}#/limits`); await page.getByRole("heading", { name: "Monthly allowance", exact: true }).waitFor(); await fits(theme); await page.screenshot({ path: path.join(output, `limits-${theme}.png`), fullPage: true }); }
  failBilling = true; await page.getByRole("button", { name: "Refresh", exact: true }).click(); await page.getByRole("alert").waitFor();
  failBilling = false; await page.getByRole("button", { name: "Try again", exact: true }).click(); await page.getByRole("heading", { name: "Monthly allowance", exact: true }).waitFor();
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  touch.on("pageerror", (error: Error) => errors.push(String(error))); touch.setDefaultTimeout(12000);
  await touch.addInitScript(() => { localStorage.setItem("cache_code_session", JSON.stringify({ accessToken: "ui-test", refreshToken: "ui-test", user: { id: "admin", name: "Alex Morgan", email: "alex@example.com", role: "admin", status: "active" } })); localStorage.setItem("llmgw-theme", "dark"); });
  await touch.route("**/api/**", mockApi);
  await touch.goto(`${base}#/limits`); await touch.getByRole("button", { name: "Use reset", exact: true }).tap();
  const touchDialog = touch.getByRole("dialog", { name: "Restore your allowance?", exact: true });
  assert(await touchDialog.getByRole("button", { name: "Cancel", exact: true }).evaluate((element: HTMLElement) => element.getBoundingClientRect().height >= 44));
  await touchDialog.getByRole("button", { name: "Cancel", exact: true }).tap();
  await touch.goto(`${base}#/admin/users`); await touch.getByRole("button", { name: "Manage plan and resets", exact: true }).tap();
  const touchManager = touch.getByRole("dialog", { name: "Plan & allowance", exact: true });
  await touchManager.getByRole("combobox", { name: "Account plan", exact: true }).tap();
  const touchList = touch.getByRole("listbox", { name: "Account plan", exact: true });
  assert(await touchList.getByRole("option").first().evaluate((element: HTMLElement) => element.getBoundingClientRect().height >= 44));
  await touch.keyboard.press("Escape");
  assert(await touchManager.getByRole("button", { name: "Done", exact: true }).evaluate((element: HTMLElement) => element.getBoundingClientRect().height >= 44));
  await touch.screenshot({ path: path.join(output, "user-plan-touch.png"), fullPage: true });
  await touch.close();
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(`Billing UI passed: account windows, resets, plan CRUD, assignment, grants, USD key forms, custom selects, desktop/tablet/mobile, touch targets, themes and retry. Screenshots: ${output}`);
} catch (error) { if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }); throw error; }
finally { await browser.close(); server.closeAllConnections(); server.close(); }
