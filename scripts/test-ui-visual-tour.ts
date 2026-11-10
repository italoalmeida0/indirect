/**
 * Visual tour: boots an isolated gateway fixture (real server, seeded data),
 * signs in as the fixture admin and captures every screen in every theme at
 * several widths. It also fails on page errors and horizontal overflow, and
 * can run axe-core on each screen.
 *
 *   PLAYWRIGHT_MODULE=<module> CHROMIUM_PATH=<browser> bun scripts/test-ui-visual-tour.ts \
 *     [--out=tmp/ui-tour] [--themes=light,dark,high-contrast] [--widths=1440,1024,768,390] \
 *     [--accents=teal] [--only=keys,usage] [--axe] [--motion]
 *
 * Screens are captured with reduced motion unless --motion is given, so the
 * output is deterministic. Requires `bun run build:web` first (dist/).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createEnterpriseFixture, enterpriseDefaults, enterpriseRequest, startEnterpriseStack } from "./enterprise-fixture";

const args = process.argv.slice(2);
const option = (name: string) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const list = (name: string, fallback: string) => (option(name) ?? fallback).split(",").map((value) => value.trim()).filter(Boolean);
const out = path.resolve(option("out") ?? "tmp/ui-tour");
const themes = list("themes", "light,dark,high-contrast");
const widths = list("widths", "1440,768,390").map(Number);
const accents = list("accents", "teal");
const only = option("only") ? new Set(list("only", "")) : undefined;
const runAxe = args.includes("--axe");
const motion = args.includes("--motion");
mkdirSync(out, { recursive: true });

interface OpenStep {
  role: "button" | "tab" | "link" | "combobox";
  name: RegExp;
}

interface Screen {
  id: string;
  hash: string;
  /** Wait for this selector before capturing. */
  ready?: string;
  /** Optional interaction(s) that open a sub-surface (dialog, popover, menu, calendar). */
  open?: OpenStep | OpenStep[];
  /** Optional interaction(s) used on mobile (<600px) when triggers live in a drawer or compact menu. */
  mobileOpen?: OpenStep | OpenStep[];
}

const screens: Screen[] = [
  { id: "dashboard", hash: "#/", ready: "main" },
  { id: "keys", hash: "#/keys", ready: "main" },
  { id: "keys-sort-open", hash: "#/keys", open: { role: "combobox", name: /^sort api keys/i } },
  { id: "keys-create", hash: "#/keys", open: { role: "button", name: /^(create|new) (api )?key/i } },
  { id: "usage", hash: "#/usage", ready: "main" },
  {
    id: "usage-filter-open",
    hash: "#/usage",
    open: [
      { role: "button", name: /^filter usage$/i },
      { role: "button", name: /^filter by model$/i },
    ],
  },
  {
    id: "usage-period-open",
    hash: "#/usage",
    open: { role: "button", name: /^time range:/i },
  },
  {
    id: "usage-calendar-open",
    hash: "#/usage",
    open: [
      { role: "button", name: /^time range:/i },
      { role: "button", name: /^custom range/i },
    ],
  },
  { id: "limits", hash: "#/limits", ready: "main" },
  { id: "projects", hash: "#/projects", ready: "main" },
  { id: "settings", hash: "#/settings", ready: "main" },
  { id: "admin-stats", hash: "#/admin/stats", ready: "main" },
  { id: "admin-audit", hash: "#/admin/audit", ready: "main" },
  { id: "admin-providers", hash: "#/admin/providers", ready: "main" },
  { id: "admin-providers-new", hash: "#/admin/providers", open: { role: "button", name: /^(add|new) provider/i } },
  { id: "admin-models", hash: "#/admin/models", ready: "main" },
  { id: "admin-users", hash: "#/admin/users", ready: "main" },
  { id: "admin-users-new", hash: "#/admin/users", open: { role: "button", name: /^(create|new|add|invite) user/i } },
  { id: "admin-plans", hash: "#/admin/plans", ready: "main" },
  { id: "admin-keys", hash: "#/admin/keys", ready: "main" },
  { id: "admin-organization", hash: "#/admin/organization", ready: "main" },
  { id: "ds", hash: "#/ds", ready: "main" },
  { id: "code", hash: "#/code", ready: '[data-rc-tip*="Arc UI design system overhaul"]' },
  {
    id: "code-model-open",
    hash: "#/code",
    ready: '[data-rc-tip*="Arc UI design system overhaul"]',
    open: { role: "button", name: /^switch model/i },
    mobileOpen: [
      { role: "button", name: /^add & settings$/i },
      { role: "button", name: /enterprise-/i },
    ],
  },
  {
    id: "code-mode-open",
    hash: "#/code",
    ready: '[data-rc-tip*="Arc UI design system overhaul"]',
    open: { role: "button", name: /^agent mode and skills/i },
    mobileOpen: [
      { role: "button", name: /^add & settings$/i },
      { role: "button", name: /^mode\b/i },
    ],
  },
  {
    id: "code-settings-open",
    hash: "#/code",
    ready: '[data-rc-tip*="Arc UI design system overhaul"]',
    open: { role: "button", name: /^host & agent settings/i },
    mobileOpen: [
      { role: "button", name: /^expand sidebar$/i },
      { role: "button", name: /^host & agent settings/i },
    ],
  },
];

const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);

const fixtureDir = path.resolve(option("dir") ?? `tmp/ui-tour-fixture-${crypto.randomUUID()}`);
const fixture = await createEnterpriseFixture({ ...enterpriseDefaults(), users: 6, days: 30, requestsPerUserDay: 5, rawDays: 2, auditDays: 30, reservationDays: 2 }, fixtureDir);
const stack = await startEnterpriseStack(fixture);
const base = stack.base;
const login = await enterpriseRequest(base, "/api/auth/login", "", { email: fixture.admin.email, password: fixture.admin.password });
assert.equal(login.status, 200, "fixture admin must sign in");

// Pair and connect a mock Indirect Code daemon so #/code renders the full
// connected workspace, sidebar, composer, model/mode pickers, and transcript.
const adminAccessToken = String(login.json.accessToken || fixture.admin.accessToken);
const pairRes = await enterpriseRequest(base, "/api/indirect-code/pair", adminAccessToken, {});
assert.equal(pairRes.status, 200, "fixture must issue a pairing token");
const connRes = await enterpriseRequest(base, `/api/indirect-code/connect/${pairRes.json.token}`, "", {
  name: "MacBook Pro M4",
  hostname: "macbook-pro",
  os: "darwin",
  arch: "arm64",
  version: "2.4.0",
});
assert.equal(connRes.status, 200, "mock daemon must pair");
const pairedHostId = String(connRes.json.hostId);
const daemonWs = new WebSocket(`${base.replace(/^http/, "ws")}/api/indirect-code/daemon/ws?token=${encodeURIComponent(String(connRes.json.daemonToken))}`);
await new Promise<void>((resolve, reject) => {
  daemonWs.onopen = () => resolve();
  daemonWs.onerror = (err) => reject(err);
});
daemonWs.onmessage = (ev) => {
  try {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "pull") {
      if (msg.collection === "projects") {
        daemonWs.send(JSON.stringify({
          type: "pull_response",
          id: msg.id,
          hostId: pairedHostId,
          collection: "projects",
          items: [
            { id: "proj-indirect", name: "indirect", path: "/Users/dev/indirect", createdAt: 1730000000000, folderStatus: "available" },
            { id: "proj-home", name: "Home", path: "/Users/dev", createdAt: 1729000000000, protected: true, folderStatus: "available" },
          ],
        }));
      } else if (msg.collection === "sessions") {
        daemonWs.send(JSON.stringify({
          type: "pull_response",
          id: msg.id,
          hostId: pairedHostId,
          collection: "sessions",
          items: [
            {
              id: "sess-arc-ui",
              cwd: "/Users/dev/indirect",
              title: "Arc UI design system overhaul",
              model: "enterprise-reasoning",
              status: "idle",
              pinned: true,
              createdAt: 1730000000000,
              updatedAt: 1730003600000,
              options: { effort: "high", mode: "agentic", skills: [{ name: "frontend-audit", usable: "yolo" }], access: "ask" },
              skills: {
                build: { priority: 1, active: true, usable: "inherit" },
                "frontend-audit": { priority: 2, active: true, usable: "yolo" },
              },
              approvalMode: "ask",
            },
            {
              id: "sess-calendar",
              cwd: "/Users/dev/indirect",
              title: "RangeCalendar spring physics",
              model: "enterprise-standard",
              status: "idle",
              pinned: false,
              createdAt: 1729990000000,
              updatedAt: 1730001800000,
              options: { effort: "medium", mode: "agentic", skills: [], access: "full" },
              skills: { plan: { priority: 1, active: true, usable: "inherit" } },
            },
          ],
        }));
      } else if (msg.collection === "config") {
        daemonWs.send(JSON.stringify({
          type: "pull_response",
          id: msg.id,
          hostId: pairedHostId,
          collection: "config",
          items: [
            {
              id: "daemon",
              revision: "v1",
              lastSelection: { model: "enterprise-reasoning", effort: "high", mode: "build", access: "ask", skills: [{ name: "frontend-audit", usable: "yolo" }] },
              settings: { auto_compact_threshold: 85, no_auto_title: false },
              skills: {
                build: { name: "build", description: "Full-stack implementation & verification", mode: "agentic", usable: "always", enabled: true },
                plan: { name: "plan", description: "Read-only architecture & planning", mode: "agentic", usable: "always", enabled: true },
                learning: { name: "learning", description: "Guided walkthrough & explanation", mode: "agentic", usable: "always", enabled: true },
                talk: { name: "talk", description: "Conversational assistant", mode: "talk", usable: "always", enabled: true },
                "frontend-audit": { name: "frontend-audit", description: "Playwright responsive & token verification", mode: "agentic", usable: "ask", enabled: true },
                "sec-review": { name: "sec-review", description: "Security and auth boundary audit", mode: "agentic", usable: "ask", enabled: true },
              },
            },
          ],
        }));
      }
    } else if (msg.type === "get_session") {
      daemonWs.send(JSON.stringify({
        type: "session_data",
        hostId: pairedHostId,
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        session: {
          id: msg.sessionId,
          cwd: "/Users/dev/indirect",
          title: "Arc UI design system overhaul",
          model: "enterprise-reasoning",
          status: "idle",
          options: { effort: "high", mode: "agentic", skills: [{ name: "frontend-audit", usable: "yolo" }], access: "ask" },
          approvalMode: "ask",
          skills: {
            build: { priority: 1, active: true, usable: "inherit" },
            "frontend-audit": { priority: 2, active: true, usable: "yolo" },
          },
          todos: [
            { text: "Port RangeCalendar spring bars & gliding endpoint thumbs", status: "completed" },
            { text: "Upgrade Indirect Code segmented controls & step physics", status: "completed" },
          ],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Port the Arc UI RangeCalendar and audit Indirect Code across Desktop, Tablet, and Mobile." }],
            },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Inspecting web/src/ds/components/calendar.tsx and Indirect Code segmented controls for spring physics parity." },
                { type: "tool_use", id: "call-read-1", name: "read_file", input: { path: "web/src/ds/components/calendar.tsx", offset: 1, limit: 45 } },
                { type: "tool_result", tool_use_id: "call-read-1", content: "<tool_result name=\"read_file\" status=\"ok\" path=\"web/src/ds/components/calendar.tsx\" lines=\"1-45 of 718\">\n1: import { createEffect, createMemo, createSignal, For, on, Show } from \"solid-js\";\n2: import { animate, spring } from \"../motion\";\n</tool_result>" },
                { type: "tool_use", id: "call-bash-1", name: "bash", input: { command: "bun scripts/check-design-tokens.ts && bun run typecheck" } },
                { type: "tool_result", tool_use_id: "call-bash-1", content: "<tool_result name=\"bash\" status=\"ok\" exit_code=\"0\" duration_ms=\"340\">\nDesign tokens OK (201 files checked, 0 issues)\n</tool_result>" },
                {
                  type: "text",
                  text: "I have ported the **Arc UI `RangeCalendar`** with week-by-week stretching range bars (`STRETCH_SPRING`), gliding circular endpoint thumbs (`GLIDE_SPRING`), and word-by-word `<RollingText>` transitions, and upgraded all Indirect Code segmented controls and step transitions.",
                },
              ],
            },
          ],
        },
      }));
    } else if (msg.type === "check_workspace") {
      daemonWs.send(JSON.stringify({
        type: "workspace_status",
        hostId: pairedHostId,
        requestId: msg.requestId,
        path: msg.path,
        state: "ok",
        exists: true,
        isDir: true,
        writable: true,
      }));
    }
  } catch {}
};

let axeSource = "";
if (runAxe) {
  const require = createRequire(import.meta.url);
  axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, timeout: 30_000 });
const failures: string[] = [];
const report: Array<Record<string, unknown>> = [];
try {
  for (const theme of themes) {
    for (const accent of accents) {
      const context = await browser.newContext({
        viewport: { width: widths[0] ?? 1440, height: 1000 },
        deviceScaleFactor: 1,
        reducedMotion: motion ? "no-preference" : "reduce",
        timezoneId: "UTC",
      });
      await context.addInitScript((data: { session: unknown; theme: string; accent: string; hostId: string }) => {
        localStorage.setItem("cache_code_session", JSON.stringify(data.session));
        localStorage.setItem("llmgw-theme", data.theme);
        localStorage.setItem("llmgw-accent", data.accent);
        localStorage.setItem("llmgw-rc-active-host", data.hostId);
        localStorage.setItem(`llmgw-rc-session:${data.hostId}`, "sess-arc-ui");
      }, { session: login.json, theme, accent, hostId: pairedHostId });
      const page = await context.newPage();
      if (runAxe) {
        await page.route("**/__axe.js", (route: { fulfill: (opts: { contentType: string; body: string }) => unknown }) =>
          route.fulfill({ contentType: "application/javascript", body: axeSource }),
        );
      }
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      for (const screen of screens) {
        if (only && !only.has(screen.id)) continue;
        for (const width of widths) {
          const name = `${screen.id}--${theme}--${accent}--${width}`;
          errors.length = 0;
          await page.setViewportSize({ width, height: width < 600 ? 860 : 1000 });
          await page.goto(`${base}/${screen.hash}`);
          await page.evaluate((mobile) => {
            document.documentElement.classList.toggle("mobile", mobile);
          }, width < 600);
          await page.waitForLoadState("networkidle").catch(() => {});
          // Lazy route chunks show a loading placeholder first. (A locator, not
          // waitForFunction: string evaluation would trip the strict CSP.)
          await page.locator(".route-loading").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
          if (screen.ready) await page.locator(screen.ready).first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
          if (screen.hash === "#/code") {
            await page.evaluate(() => {
              document.querySelector<HTMLElement>('[data-rc-tip*="Arc UI design system overhaul"]')?.click();
            });
            await page.waitForTimeout(150);
          }
          const openSpec = width < 600 && screen.mobileOpen ? screen.mobileOpen : screen.open;
          if (openSpec) {
            const steps = Array.isArray(openSpec) ? openSpec : [openSpec];
            for (const step of steps) {
              const trigger = page.getByRole(step.role, { name: step.name }).first();
              await trigger.waitFor({ timeout: 8_000 }).catch(() => {});
              if (await trigger.count()) {
                await trigger.click();
                await page.waitForTimeout(motion ? 500 : 150);
              } else {
                failures.push(`${name}: trigger ${step.name} not found`);
              }
            }
          }
          await page.evaluate(() => document.fonts?.ready);
          await page.waitForTimeout(motion ? 600 : 120);
          const metrics = await page.evaluate(() => {
            const floatingEls = Array.from(
              document.querySelectorAll<HTMLElement>('.analytics-popover, .ui-popover, .ui-dialog, [role="dialog"], [role="listbox"], [role="menu"]'),
            ).filter((el) => el.getClientRects().length > 0);
            const surfaceIssues: string[] = [];
            for (const el of floatingEls) {
              const cs = getComputedStyle(el);
              if (cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent") {
                surfaceIssues.push(`transparent background on ${el.tagName.toLowerCase()}.${el.className}`);
              }
              const r = el.getBoundingClientRect();
              if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
                surfaceIssues.push(`out-of-viewport bounds (${Math.round(r.left)},${Math.round(r.top)} -> ${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight}) on ${el.tagName.toLowerCase()}.${el.className}`);
              }
            }
            return {
              overflow: document.documentElement.scrollWidth - innerWidth,
              theme: document.documentElement.dataset.theme,
              surfaceIssues,
            };
          });
          await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: !screen.open });
          const entry: Record<string, unknown> = { name, overflow: metrics.overflow, theme: metrics.theme, surfaceIssues: metrics.surfaceIssues, errors: [...errors] };
          if (metrics.overflow > 1) failures.push(`${name}: horizontal overflow ${metrics.overflow}px`);
          if (metrics.theme !== theme) failures.push(`${name}: data-theme is ${metrics.theme}, expected ${theme}`);
          for (const issue of metrics.surfaceIssues) failures.push(`${name}: ${issue}`);
          if (errors.length) failures.push(`${name}: page errors: ${errors.join(" | ")}`);
          if (runAxe && width === widths[0]) {
            if (!(await page.evaluate(() => Boolean((window as unknown as { axe?: unknown }).axe)))) {
              await page.addScriptTag({ url: "/__axe.js" });
            }
            const result = await page.evaluate(async () => {
              const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ html: string; target: string[] }> }> }> } }).axe;
              const run = await axe.run(
                { include: [[document.documentElement]], exclude: [[".ag-root-wrapper"]] },
                { resultTypes: ["violations"] },
              );
              return run.violations.map((violation) => ({
                id: violation.id,
                impact: violation.impact,
                count: violation.nodes.length,
                targets: violation.nodes.slice(0, 3).map((n) => n.target.join(" ")),
              }));
            });
            entry.axe = result;
            for (const violation of result) {
              if (violation.impact === "critical" || violation.impact === "serious") failures.push(`${name}: axe ${violation.impact} ${violation.id} ×${violation.count} (${violation.targets.join(", ")})`);
            }
          }
          report.push(entry);
          if (openSpec) await page.keyboard.press("Escape").catch(() => {});
        }
      }
      await context.close();
    }
  }
} finally {
  try { daemonWs.close(); } catch {}
  await browser.close();
  await stack.stop();
  writeFileSync(path.join(out, "report.json"), JSON.stringify({ failures, report }, null, 2));
}
console.log(`[ui-tour] ${report.length} captures in ${out}`);
if (failures.length) {
  console.error(`[ui-tour] ${failures.length} failure(s):\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("[ui-tour] OK");
