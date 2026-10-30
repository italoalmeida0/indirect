/** Production-SPA browser regression and explicit frontend capacity gate.
 * PLAYWRIGHT_MODULE=<external module> CHROMIUM_PATH=<browser> bun scripts/test-gateway-enterprise-ui.ts
 * --reuse --dir=<enterprise fixture> [--base=<already serving fixture>] --samples=1000 --enforce-p99
 * A fresh small fixture exercises mutations; reuse measures existing history without changing policies. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEnterpriseFixture, enterpriseDefaults, enterpriseMachine, enterpriseRequest, loadEnterpriseFixture, startEnterpriseStack } from "./enterprise-fixture";

const args = process.argv.slice(2);
const option = (name: string) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const reuse = args.includes("--reuse"), enforce = args.includes("--enforce-p99");
const samples = Number(option("samples") ?? 40);
assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 100_000, "samples must be a bounded positive integer");
assert(!enforce || samples >= 1000, "frontend p99 qualification requires at least 1,000 interactions");
assert(!option("base") || reuse, "--base must refer to an explicitly reused test fixture");
const dir = path.resolve(option("dir") ?? `tmp/enterprise-ui-${crypto.randomUUID()}`);
const fixture = reuse ? loadEnterpriseFixture(dir) : await createEnterpriseFixture({ ...enterpriseDefaults(), users: 6, days: 30, requestsPerUserDay: 5, rawDays: 2, auditDays: 30, reservationDays: 2 }, dir);
const stack = option("base") ? undefined : await startEnterpriseStack(fixture);
const base = option("base") ?? stack!.base;
const baseUrl = new URL(base);
assert(["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname) && !baseUrl.username && !baseUrl.password, "browser gates only operate on an isolated loopback test fixture");
const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const reportFile = path.resolve(option("report") ?? path.join(dir, "frontend-report.json"));
const screenDir = path.join(dir, "ui-screenshots");
mkdirSync(screenDir, { recursive: true });
let browser: any;
const runtimeErrors: string[] = [];
const timings: Array<{ route: string; milliseconds: number; error?: string }> = [];

async function api(route: string, token: string, body?: unknown, method?: string) {
  const result = await enterpriseRequest(base, route, token, body, method);
  assert.equal(result.status, 200, `${method ?? (body ? "POST" : "GET")} ${route} returned ${result.status}`);
  return result.json;
}
async function authenticate(email: string) { return api("/api/auth/login", "", { email, password: fixture.admin.password }); }
async function context(session: unknown) {
  const result = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await result.addInitScript((data: unknown) => { localStorage.setItem("cache_code_session", JSON.stringify(data)); localStorage.setItem("llmgw-theme", "dark"); }, session);
  const page = await result.newPage();
  page.on("pageerror", (error: Error) => runtimeErrors.push(error.message));
  return { context: result, page };
}
async function choose(page: any, label: string, name: string | RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name, exact: typeof name === "string" }).click();
}
async function organization(page: any, section: string) {
  await page.goto(`${base}/#/admin/organization`);
  await page.getByRole("heading", { name: "Organization", exact: true }).waitFor();
  await choose(page, "Organization settings", section);
}
async function noOverflow(page: any, name: string) {
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(overflow <= 1, `${name} overflows by ${overflow}px at ${width}px`);
    await page.screenshot({ path: path.join(screenDir, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const p = (value: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
  return { count: sorted.length, p50: p(.5), p95: p(.95), p99: p(.99), max: sorted.at(-1) ?? 0 };
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  const admin = await authenticate(fixture.admin.email);
  const adminTab = await context(admin), page = adminTab.page;
  if (!reuse) {
    await page.goto(`${base}/#/projects`);
    await page.getByRole("button", { name: "New financial project", exact: true }).click();
    await page.getByLabel("Project code", { exact: true }).fill("UI-DELIVERY");
    await page.getByLabel("Project name", { exact: true }).fill("Browser delivery project");
    await page.getByLabel("Shared monthly budget (USD)", { exact: true }).fill("100");
    await page.getByLabel("Shared lifetime budget (USD)", { exact: true }).fill("1000");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const projectButton = page.getByRole("button", { name: /Browser delivery project/ }).first();
    await projectButton.waitFor(); await projectButton.click();
    await api(`/api/admin/users/${fixture.users[0]!.id}`, admin.accessToken, { role: "project_manager" }, "PATCH");
    await page.getByLabel("Find a member", { exact: true }).fill(fixture.users[0]!.email);
    await page.getByRole("button", { name: "Search users", exact: true }).click();
    await choose(page, "Member account", new RegExp(fixture.users[0]!.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await choose(page, "Project membership", "Manager");
    const memberSaved = page.waitForResponse((result: any) => new URL(result.url()).pathname.includes("/members/") && result.request().method() === "PUT");
    await page.getByRole("button", { name: "Save membership", exact: true }).click();
    assert.equal((await memberSaved).status(), 200);
    const projects = await api("/api/projects", admin.accessToken);
    const project = projects.projects.find((item: { code: string }) => item.code === "UI-DELIVERY");
    assert(project, "UI project was not persisted");
    const memberships = await api(`/api/projects/${project.id}/members`, admin.accessToken);
    assert(memberships.members.some((item: { userId: string; role: string }) => item.userId === fixture.users[0]!.id && item.role === "manager"), "UI membership was not persisted");
    await noOverflow(page, "projects");

    await organization(page, "Financial visibility");
    await choose(page, "Budget presentation", "Budget percentages");
    const prices = page.getByRole("switch", { name: "Show model prices", exact: true });
    if (await prices.isChecked()) await page.getByText("Show model prices", { exact: true }).click();
    await page.getByRole("button", { name: "Save financial defaults", exact: true }).click();
    await page.getByText("Financial defaults saved", { exact: true }).waitFor();
    const financial = await api("/api/admin/financial-policy", admin.accessToken);
    assert.equal(financial.defaults.budgetPresentation, "percent"); assert.equal(financial.defaults.showModelPrices, false);
    await noOverflow(page, "financial-policy");

    await organization(page, "Model access policies");
    await page.getByRole("button", { name: "New model policy", exact: true }).click();
    await page.getByLabel("Policy name", { exact: true }).fill("Browser economical policy");
    await page.getByLabel("Find models", { exact: true }).fill("enterprise-fast");
    await page.getByRole("checkbox", { name: /enterprise-fast/ }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Save model policy", exact: true }).click();
    await page.getByText("Browser economical policy", { exact: false }).first().waitFor();
    assert((await api("/api/admin/model-policies", admin.accessToken)).policies.some((item: { name: string }) => item.name === "Browser economical policy"));
    await noOverflow(page, "model-policies");

    await organization(page, "Bulk user import");
    await page.getByLabel("User import content", { exact: true }).fill("email,name\nui-import@example.test,Browser import");
    await page.getByRole("button", { name: "Preview import", exact: true }).click();
    await page.getByRole("heading", { name: "Import preview", exact: true }).waitFor();
    await page.getByRole("button", { name: "Commit 1 new users", exact: true }).click();
    await page.getByText("Import complete: 1 created, 0 existing accounts skipped.", { exact: true }).waitFor();
    await noOverflow(page, "user-import");

    await organization(page, "Corporate authentication");
    await page.getByLabel("OIDC issuer URL", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "Organization settings", exact: true }).focus();
    await page.keyboard.press("Space"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
    assert(await page.getByRole("combobox", { name: "Organization settings", exact: true }).evaluate((element: HTMLElement) => element === document.activeElement));
    await noOverflow(page, "corporate-auth");

    await organization(page, "Operations and backups");
    await page.getByRole("heading", { name: "Operational metrics", exact: true }).waitFor();
    await page.getByRole("button", { name: "Create verified backup", exact: true }).click();
    await page.getByText("Verified", { exact: true }).first().waitFor();
    assert((await api("/api/admin/backups", admin.accessToken)).backups.some((backup: { verified: boolean }) => backup.verified === true));
    await noOverflow(page, "operations");

    const manager = await context(await authenticate(fixture.users[0]!.email));
    await manager.page.goto(`${base}/#/projects`);
    await manager.page.getByRole("button", { name: /Browser delivery project/ }).first().click();
    await manager.page.getByRole("button", { name: "View report", exact: true }).waitFor();
    assert.equal(await manager.page.getByRole("button", { name: "New financial project", exact: true }).count(), 0);
    assert.equal(await manager.page.getByRole("button", { name: "Edit project", exact: true }).count(), 0);
    await manager.page.goto(`${base}/#/admin/organization`);
    await manager.page.getByRole("heading", { name: "Administration access required", exact: true }).waitFor();
    assert.equal((await enterpriseRequest(base, "/api/admin/metrics", (await authenticate(fixture.users[0]!.email)).accessToken)).status, 403);
    await manager.context.close();
  }

  const personal = await context(await authenticate(fixture.users[0]!.email));
  const cases = [
    { route: "/", page: personal.page, title: "Overview", selector: "main [aria-busy=false]", endpoint: "/api/usage/overview" },
    { route: "/usage", page: personal.page, title: "Usage", selector: ".usage-page[aria-busy=false]", endpoint: "/api/usage/analytics" },
    { route: "/admin/stats", page, title: "Global Stats", selector: ".global-stats-page[aria-busy=false]", endpoint: "/api/admin/analytics" },
  ];
  for (let index = 0; index < samples; index++) {
    const item = cases[index % cases.length]!;
    const began = performance.now();
    try {
      // A slow-but-successful interaction must be recorded with its real
      // duration: a 30s default timeout would turn a 5s render into an
      // "error" and hide it from the distribution that the gate checks.
      const response = item.page.waitForResponse((result: any) => new URL(result.url()).pathname === item.endpoint && result.request().method() === "GET", { timeout: 180_000 });
      await item.page.goto(`${base}/?enterprise-navigation=${index}#${item.route}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
      assert.equal((await response).status(), 200);
      await item.page.getByRole("heading", { name: item.title, exact: true }).waitFor({ timeout: 180_000 });
      await item.page.locator(item.selector).first().waitFor({ timeout: 180_000 });
      await item.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      timings.push({ route: item.route, milliseconds: performance.now() - began });
    } catch (error) { timings.push({ route: item.route, milliseconds: performance.now() - began, error: error instanceof Error ? error.message.slice(0, 300) : "browser interaction failed" }); }
  }
  const result = { machine: enterpriseMachine(), browser: browser.version(), fixture: { scenario: fixture.scenario, representedRequests: fixture.expectedRequests },
    measurement: "Full document navigation, target API response, populated page aria-busy=false and two animation frames; normal browser cache; loopback network; reduced motion.",
    exploratory: !enforce, distribution: distribution(timings.map((item) => item.milliseconds)),
    byRoute: cases.map((item) => ({ route: item.route, ...distribution(timings.filter((entry) => entry.route === item.route).map((entry) => entry.milliseconds)) })),
    errors: timings.filter((item) => item.error), runtimeErrors, samples: timings };
  mkdirSync(path.dirname(reportFile), { recursive: true }); writeFileSync(reportFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ reportFile, exploratory: !enforce, ...result.distribution, errors: result.errors.length, runtimeErrors }));
  assert.equal(result.errors.length, 0, "frontend interactions failed; inspect the report");
  assert.equal(runtimeErrors.length, 0, "browser runtime errors occurred");
  if (enforce) {
    // Per-page thresholds: an overall p99 lets one slow screen hide behind two
    // fast ones, and the agreed target is per measured interaction.
    for (const entry of result.byRoute) {
      assert(entry.count * cases.length >= samples, `${entry.route} did not receive a full share of interactions`);
      assert(entry.p99 <= 1000, `${entry.route} p99=${entry.p99.toFixed(1)}ms exceeds 1000ms`);
    }
    assert(result.distribution.p99 <= 1000, `frontend p99=${result.distribution.p99.toFixed(1)}ms exceeds 1000ms`);
  }
} finally { await browser?.close(); await stack?.stop(); }
