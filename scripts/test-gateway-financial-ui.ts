// PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node --experimental-strip-types scripts/test-gateway-financial-ui.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const screenshotDir = path.join(root, "tmp/gateway-financial-ui");
mkdirSync(screenshotDir, { recursive: true });

const dataDir = mkdtempSync(path.join(tmpdir(), "indirect-fin-ui-"));
const adminPassword = "admin-fin-ui-password-123";
const userPassword = "user-fin-ui-password-123";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let holdRelease: (() => void) | null = null;
const upstream = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: "fin-ui-model",
            context_length: 128_000,
            top_provider: { max_completion_tokens: 4096 },
            pricing: {
              prompt: "0",
              completion: "0.01",
              input_cache_reads: "0",
              input_cache_writes: "0",
            },
          },
        ],
      }),
    );
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
    const promptText = String(body.messages?.[0]?.content ?? "");
    if (promptText.startsWith("hold:")) {
      await new Promise<void>((resolve) => {
        holdRelease = resolve;
      });
    }
    const tokMatch = /(?:tokens|hold):(\d+)/.exec(promptText);
    const outTok = tokMatch ? Number(tokMatch[1]) : 4_000;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "chatcmpl_fin_ui",
        model: "fin-ui-model",
        choices: [{ index: 0, message: { role: "assistant", content: outTok === 0 ? "" : "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: outTok,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
    );
  });
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as { port: number }).port;

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const bunBin = process.env.BUN_BIN || "bun";
const gateway = spawn(bunBin, ["server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    NODE_ENV: "test",
    ADMIN_EMAIL: "admin@finui.test",
    ADMIN_PASSWORD: adminPassword,
    GATEWAY_SECRET: "f".repeat(64),
    FINANCIAL_DEFAULT_BUDGET: "percent",
    FINANCIAL_DEFAULT_SHOW_PRICES: "false",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function apiCall(
  route: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
) {
  const res = await fetch(`${base}${route}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: (await res.json()) as any };
}

function hasMonetaryKeys(value: unknown): boolean {
  const allowed = new Set([
    "costCenter",
    "costCenterId",
    "usedPercent",
    "holdPercent",
    "dailyUsedPercent",
    "totalUsedPercent",
    "limitConfigured",
    "dailyLimitConfigured",
    "totalLimitConfigured",
    "rpm",
    "total",
  ]);
  if (Array.isArray(value)) return value.some(hasMonetaryKeys);
  if (!value || typeof value !== "object") return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(k)) {
      if (/(?:Usd|Nanos)$/.test(k) || /^(?:cost(?:_in|_cache|_out)?|price|pricing|spent|billed|forgiven|reserved|remaining)/.test(k)) {
        return true;
      }
    }
    if (hasMonetaryKeys(v)) return true;
  }
  return false;
}

let browser: any;

try {
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("Gateway failed to boot");
    await sleep(100);
  }

  const adminLogin = await apiCall("/api/auth/login", {
    body: { email: "admin@finui.test", password: adminPassword },
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.accessToken as string;

  // Create regular employee user.
  const createdUser = await apiCall("/api/admin/users", {
    token: adminToken,
    body: { email: "employee@finui.test", name: "Pat Employee", sendInvite: true },
  });
  assert.equal(createdUser.status, 200);
  const userId = createdUser.data.user.id as string;
  const resetToken = decodeURIComponent(createdUser.data.invite.link.split("token=")[1]);
  assert.equal(
    (await apiCall("/api/auth/password-reset/confirm", { body: { token: resetToken, password: userPassword } })).status,
    200,
  );
  const empLogin = await apiCall("/api/auth/login", {
    body: { email: "employee@finui.test", password: userPassword },
  });
  assert.equal(empLogin.status, 200);
  const empSession = {
    accessToken: empLogin.data.accessToken as string,
    refreshToken: empLogin.data.refreshToken as string,
    user: empLogin.data.user,
  };

  // Register provider + priced model (0 USD/input, 0.01 USD/output => 4,000 tokens = $40.00 exact).
  const prov = await apiCall("/api/admin/providers", {
    token: adminToken,
    body: {
      name: "FinUiUpstream",
      openaiBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: "sk-finui",
    },
  });
  assert.equal(prov.status, 200);
  assert.equal(
    (await apiCall(`/api/admin/providers/${prov.data.provider.id}/sync-models`, { token: adminToken, body: {} })).status,
    200,
  );
  assert.equal(
    (await apiCall("/api/admin/settings", { token: adminToken, method: "PATCH", body: { routingMode: "router" } })).status,
    200,
  );

  // Create $100/month plan and assign to employee.
  const planRes = await apiCall("/api/admin/plans", {
    token: adminToken,
    body: { name: "Corporate 100", monthlyUsd: 100, weeklyEnabled: false, sessionEnabled: false },
  });
  assert.equal(planRes.status, 200);
  const planId = planRes.data.plans[0].id as string;
  assert.equal(
    (await apiCall(`/api/admin/users/${userId}/billing`, { token: adminToken, method: "PATCH", body: { planId } })).status,
    200,
  );

  // Create API key for employee with $120 daily / $200 total cap.
  const keyRes = await apiCall("/api/keys", {
    token: empSession.accessToken,
    body: { name: "Workstation", dailyLimitUsd: 120, totalLimitUsd: 200 },
  });
  assert.equal(keyRes.status, 200);
  const keyToken = keyRes.data.token as string;
  const keyId = keyRes.data.key.id as string;

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  const leakedPayloads: string[] = [];
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (err: Error) => errors.push(String(err)));
  page.on("response", async (res: any) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith("/api/") && res.status() === 200) {
      try {
        const policyHeader = res.headers()["x-financial-policy"] ?? "";
        if (policyHeader.startsWith("percent") || policyHeader.startsWith("hidden")) {
          const json = await res.json();
          if (hasMonetaryKeys(json)) {
            leakedPayloads.push(`${url.pathname}: ${JSON.stringify(json).slice(0, 200)}`);
          }
        }
      } catch {}
    }
  });

  await page.addInitScript((sessionObj: unknown) => {
    localStorage.setItem("cache_code_session", JSON.stringify(sessionObj));
    localStorage.setItem("llmgw-theme", "dark");
  }, empSession);

  // Case 1: Zero consumption (0% used, finite $100 plan).
  console.log("[fin-ui] Case 1: 0% consumption on finite plan in percent mode");
  await page.goto(`${base}/#/limits`);
  await page.getByRole("heading", { name: "Monthly allowance", exact: true }).waitFor();
  let bodyText = await page.locator("main").innerText();
  assert(!bodyText.includes("Your account has no spending ceiling."), `Finite plan falsely described as unlimited at 0%:\n${bodyText}`);
  assert(!bodyText.includes("— spent of —"), `Broken USD template rendered in percent mode:\n${bodyText}`);
  assert(!bodyText.includes("NaN"), `NaN rendered in percent mode:\n${bodyText}`);
  assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "0");

  // Case 2: 40% consumption (Finding 3 exact reproduction: usedPercent: 40, limitConfigured: true).
  console.log("[fin-ui] Case 2: 40% consumption (usedPercent: 40, limitConfigured: true)");
  const call40 = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keyToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "fin-ui-model",
      messages: [{ role: "user", content: "tokens:4000" }],
      max_tokens: 4_000,
    }),
  });
  assert.equal(call40.status, 200);

  const billing40 = await apiCall("/api/billing", { token: empSession.accessToken });
  assert.equal(billing40.data.billing.windows[0].usedPercent, 40);
  assert.equal(billing40.data.billing.windows[0].limitConfigured, true);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator('[role="progressbar"][aria-valuenow="40"]').waitFor({ timeout: 5_000 });
  bodyText = await page.locator("main").innerText();
  assert(bodyText.includes("40%"), `Expected 40% visible on #/limits, got:\n${bodyText}`);
  assert(!bodyText.includes("Your account has no spending ceiling."), `Finite 40% plan described as unlimited:\n${bodyText}`);
  assert(!bodyText.includes("$40") && !bodyText.includes("$100"), `USD leaked into DOM in percent mode:\n${bodyText}`);
  await page.screenshot({ path: path.join(screenshotDir, "limits-percent-40.png"), fullPage: true });

  // Case 3: In-flight reservation hold alongside 40% settled spend (max_tokens: 1,500 => 15% hold).
  console.log("[fin-ui] Case 3: In-flight reserved hold in percent mode");
  const heldReq = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keyToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "fin-ui-model",
      messages: [{ role: "user", content: "hold:0" }],
      max_tokens: 1_500,
    }),
  });
  heldReq.catch(() => {});
  for (let i = 0; i < 60 && !holdRelease; i++) await sleep(50);
  assert(holdRelease, "Upstream did not receive held request");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(".billing-detail", { hasText: "held in flight" }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "55");
  (holdRelease as () => void)();
  holdRelease = null;
  const heldResp = await heldReq;
  assert.equal(heldResp.status, 200);

  // Case 4: Unlimited plan (planId = null) in percent mode MUST say no spending ceiling / Unlimited.
  console.log("[fin-ui] Case 4: Unlimited plan in percent mode");
  await apiCall(`/api/admin/users/${userId}/billing`, { token: adminToken, method: "PATCH", body: { planId: null } });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Your account has no spending ceiling.").waitFor({ timeout: 5_000 });
  assert.equal(await page.getByRole("progressbar").count(), 0);
  await apiCall(`/api/admin/users/${userId}/billing`, { token: adminToken, method: "PATCH", body: { planId } });

  // Case 5: Keys screen in percent mode (percentages shown, USD inputs omitted, rename preserves admin USD caps).
  console.log("[fin-ui] Case 5: Keys screen and Usage/Overview screens in percent mode");
  await page.goto(`${base}/#/keys`);
  await page.getByText("Workstation", { exact: true }).waitFor();
  const keysText = await page.locator("main").innerText();
  assert(!keysText.includes("$120") && !keysText.includes("$200") && !keysText.includes("$40"), `USD leaked on #/keys:\n${keysText}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editDialog = page.getByRole("dialog");
  await editDialog.waitFor({ state: "visible" });
  assert.equal(await editDialog.getByLabel(/Daily limit \(USD\)/).count(), 0, "USD limit inputs must not render in percent mode");
  await editDialog.locator('input[type="text"]').first().fill("Workstation Pro");
  await editDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await editDialog.waitFor({ state: "hidden" });

  // Confirm caps were NOT wiped to null when renaming in percent mode!
  const adminKeysCheck = await apiCall("/api/admin/keys?limit=10", { token: adminToken });
  const updatedKey = (adminKeysCheck.data.keys as any[]).find((k) => k.id === keyId);
  assert.equal(updatedKey.name, "Workstation Pro");
  assert.equal(updatedKey.dailyLimitUsd, 120);
  assert.equal(updatedKey.totalLimitUsd, 200);

  // Wait for usage flush and check Overview + Usage screens in percent mode.
  for (let i = 0; i < 40; i++) {
    const ev = await apiCall("/api/usage/events?limit=5", { token: empSession.accessToken });
    if ((ev.data.events?.length ?? 0) >= 1) break;
    await sleep(100);
  }
  await page.goto(`${base}/#/`);
  await page.getByText(/Tokens ·/, { exact: false }).waitFor();
  assert.equal(await page.locator(".overview-spend").count(), 0, "Overview Spend card must not render when budgetPresentation !== usd");

  await page.goto(`${base}/#/usage`);
  await page.getByRole("heading", { name: "Recent requests", exact: true }).waitFor();
  assert.equal(await page.locator(".analytics-summary-spend").count(), 0, "Usage Spend summary must not render when budgetPresentation !== usd");
  const usageText = await page.locator("main").innerText();
  assert(!usageText.includes("Total Cost") && !usageText.includes("$40"), `Cost column or USD leaked on #/usage:\n${usageText}`);

  // Case 6: Live policy flip in an already open session (percent -> usd -> hidden).
  console.log("[fin-ui] Case 6: Live policy flip in open session (percent -> usd -> hidden)");
  await page.goto(`${base}/#/limits`);
  await page.getByRole("heading", { name: "Monthly allowance", exact: true }).waitFor();

  const flipUsdRes = await apiCall(`/api/admin/users/${userId}/financial-policy`, {
    token: adminToken,
    method: "PATCH",
    body: { budgetPresentation: "usd", showModelPrices: true },
  });
  assert.equal(flipUsdRes.status, 200);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("$60.00").waitFor({ timeout: 5_000 });
  assert((await page.locator("main").innerText()).includes("$100.00"));

  await apiCall(`/api/admin/users/${userId}/financial-policy`, {
    token: adminToken,
    method: "PATCH",
    body: { budgetPresentation: "hidden", showModelPrices: false },
  });
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByText("Managed allowance", { exact: true }).waitFor({ timeout: 5_000 });
  const hiddenLimitsText = await page.locator("main").innerText();
  assert(!hiddenLimitsText.includes("$60.00") && !hiddenLimitsText.includes("$100.00") && !hiddenLimitsText.includes("40%"), `Restricted values remained after flip to hidden:\n${hiddenLimitsText}`);
  assert(!hiddenLimitsText.includes("Your account has no spending ceiling."), `Hidden finite plan falsely described as unlimited:\n${hiddenLimitsText}`);
  assert(!hiddenLimitsText.includes("$"), `Dollar sign remained after flip to hidden:\n${hiddenLimitsText}`);
  assert.equal(await page.getByRole("progressbar").count(), 0, "Hidden presentation must not render percentage progressbar");

  // Case 7: Near-limit (96%) and Exhausted (100%) in percent mode via real proxy spend!
  console.log("[fin-ui] Case 7: Near-limit (96%) and Exhausted (100%) in percent mode");
  await apiCall(`/api/admin/users/${userId}/financial-policy`, {
    token: adminToken,
    method: "PATCH",
    body: { budgetPresentation: "percent", showModelPrices: false },
  });
  // Spend $56 more ($40 + $56 = $96 -> 96%).
  const call96 = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keyToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "fin-ui-model",
      messages: [{ role: "user", content: "tokens:5600" }],
      max_tokens: 5_600,
    }),
  });
  assert.equal(call96.status, 200);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator('[role="progressbar"][aria-valuenow="96"]').waitFor({ timeout: 5_000 });
  assert(await page.locator(".billing-meter.is-low").isVisible(), "Near-limit meter should carry .is-low warning style");

  // Spend remaining $4 ($96 + $4 = $100 -> 100% exhausted).
  const call100 = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keyToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "fin-ui-model",
      messages: [{ role: "user", content: "tokens:400" }],
      max_tokens: 400,
    }),
  });
  assert.equal(call100.status, 200);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator('[role="progressbar"][aria-valuenow="100"]').waitFor({ timeout: 5_000 });
  await page.screenshot({ path: path.join(screenshotDir, "limits-percent-100.png"), fullPage: true });

  // Viewport checks across 768px, 390px, 320px.
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["limits", "keys", "usage"]) {
      await page.goto(`${base}/#/${route}`);
      await sleep(200);
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      assert(fits, `Horizontal overflow at ${width}px on #/${route}`);
    }
  }

  assert.deepEqual(leakedPayloads, [], `Monetary fields leaked over HTTP: ${leakedPayloads.join("; ")}`);
  assert.deepEqual(errors, [], `Browser page errors: ${errors.join("; ")}`);
  console.log(`[fin-ui] All financial presentation browser checks passed. Screenshots: ${screenshotDir}`);
} finally {
  holdRelease?.();
  await browser?.close();
  gateway.kill();
  await new Promise<void>((resolve) => {
    if (gateway.exitCode !== null) resolve();
    else gateway.once("exit", () => resolve());
  });
  upstream.closeAllConnections();
  upstream.close();
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(100);
    }
  }
}
