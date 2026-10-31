// Browser check for the frontend-owned mode/skill selection and the
// Projects|Talk sidebar: the 4 mode skills render from the temporary cache
// until the daemon's official list arrives, exactly one is the mandatory
// primary, the wire carries the derived (draft) or locked (existing
// session) mode + active-only skills with usable only when it differs
// from the original, approvalMode:"yolo" on the primary hides the ASK/YOLO
// selector, talk drafts hide the project picker, an existing session's
// mode can never be switched from the picker, and talk conversations live
// in their own persisted sidebar view. Drives the REAL components via
// clicks, like a user. Run:
//   PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-mode-skills-ui.ts
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../test/fixtures/indirect-mode-skills-ui.tsx", import.meta.url))],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
// Inline the built app CSS when present so screenshots render like the app.
let css = "";
try {
  const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
  const cssFile = readdirSync(distDir).find((f) => f.endsWith(".css"));
  if (cssFile) css = readFileSync(distDir + cssFile, "utf8");
} catch {}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === "/bundle.js"
      ? new Response(bundle.outputs[0])
      : new Response(
          `<html><head><style>${css}</style><style>body{background:#0b0e14}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).modeSkillsUI?.options);
  const ev = (fn: string) => page.evaluate(new Function(`return (${fn})((window).modeSkillsUI)`) as any);
  const radios = () => page.locator('[role="menuitemradio"]').evaluateAll((els: any[]) => els.map((e) => e.textContent));
  const openModeMenu = async () => {
    const btn = page.getByRole("button", { name: "Agent mode and skills" });
    if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
    await page.waitForSelector('[role="menuitemradio"], [role="menuitemcheckbox"]');
  };

  // --- Draft bootstrap (page calls ensureSelection for a new draft) ---
  assert.equal(await ev(`a => { a.options.ensureSelection(); return a.options.selectedSkills().join(",") }`), "build", "draft must default to the first cached mode skill");
  assert.equal(await ev(`a => a.options.pendingMode()`), "agentic");

  // --- Phase A: cache renders all 4; project picker visible for agentic draft ---
  await openModeMenu();
  assert.equal((await radios()).length, 4, "cache must show 4 mode skills");
  assert.equal(await page.locator("[data-draft-project]").count(), 1, "project picker must show for an agentic draft");
  assert.equal(await page.getByRole("button", { name: "Agent permissions" }).count(), 1, "ask/yolo selector must be visible for a non-yolo primary");
  await page.screenshot({ path: "/tmp/mode-skills-cache.png" });

  const fps = await page.evaluate(() => new Promise<number>((resolve) => {
    let n = 0; const start = performance.now();
    const tick = () => { n++; if (performance.now() - start < 1000) requestAnimationFrame(tick); else resolve(n); };
    requestAnimationFrame(tick);
  }));
  console.log(`fps(menu open)=${fps}`);
  assert(fps >= 20, `frame rate too low: ${fps}`);

  // --- Draft Talk: project picker hides, wire would be talk + active-only ---
  await page.getByRole("menuitemradio").filter({ hasText: "Talk" }).click();
  await page.waitForFunction(() => (window as any).modeSkillsUI.options.pendingMode() === "talk");
  assert.equal(await page.locator("[data-draft-project]").count(), 0, "project picker must hide for a talk draft (born in Home)");
  assert.equal(await ev(`a => JSON.stringify(a.options.sessionOptions().skills)`), `[{"name":"talk"}]`);
  await page.getByRole("menuitemradio").filter({ hasText: "Build" }).click();
  await page.waitForFunction(() => (window as any).modeSkillsUI.options.pendingMode() === "agentic");
  assert.equal(await page.locator("[data-draft-project]").count(), 1, "project picker returns for an agentic draft");
  await page.keyboard.press("Escape");

  // --- Sidebar: Projects view excludes talk; Talk view lists only talk ---
  assert.equal(await ev(`a => a.projects.sidebarView()`), "projects");
  assert(await page.getByText("Talk about cats").count() === 0, "talk sessions must not appear in the Projects view");
  await page.getByRole("button", { name: "Talk", exact: true }).click();
  await page.getByText("Talk about cats").waitFor();
  assert(await page.getByText("Talk about rust").count() === 1, "Talk view must list every talk session");
  assert(await page.getByText("Build the thing").count() === 0, "agentic sessions must not appear in the Talk view");
  await page.screenshot({ path: "/tmp/mode-skills-sidebar-talk.png" });
  // Persistence: reload lands back on Talk.
  await page.reload();
  await page.waitForFunction(() => (window as any).modeSkillsUI?.options);
  assert.equal(await ev(`a => a.projects.sidebarView()`), "talk", "sidebar view must persist across reload (localStorage)");
  await page.getByText("Talk about cats").waitFor();

  // --- Open the talk session: mode is locked to talk in picker and wire ---
  await ev(`a => { a.setOfficial({
    build: { name: "build", description: "Daemon Build desc", body: "", enabled: true, usable: "deny", mode: "agentic" },
    plan: { name: "plan", description: "p", body: "", enabled: true, usable: "never", mode: "agentic" },
    talk: { name: "talk", description: "Daemon Talk desc", body: "", enabled: true, usable: "deny", mode: "talk", approvalMode: "yolo" },
    custom: { name: "custom", description: "Custom skill", body: "", enabled: true, usable: "ask", mode: "agentic" },
    plain: { name: "plain", description: "No usable key", body: "", enabled: true, mode: "agentic" },
  }); a.setLoaded(true); }`);
  await page.getByText("Talk about cats").click();
  await page.waitForFunction(() => !(window as any).modeSkillsUI.draftMode());
  await openModeMenu();
  const talkRadios = await radios();
  assert.equal(talkRadios.length, 1, `talk session picker must only offer talk, got ${JSON.stringify(talkRadios)}`);
  assert(talkRadios[0].includes("Daemon Talk desc"), "official description must replace the cache one");
  assert.equal(await page.getByRole("button", { name: "Agent permissions" }).count(), 0, "selector must hide: talk approvalMode is yolo");
  // A Lua skill WITHOUT the usable key has deny as its original: locked
  // hidden badge, no usable cycle button (session inherit != file value).
  assert.equal(await page.getByRole("button", { name: "Change activation policy for plain" }).count(), 0, "no-usable-key skill must not offer a usable cycle (original = deny)");
  // Additional skill of the OTHER mode stays available, but the wire mode
  // never leaves talk; usable omitted vs differing rules still apply.
  await page.getByRole("menuitemcheckbox").filter({ hasText: "custom" }).click();
  await page.waitForFunction(() => (window as any).modeSkillsUI.options.selectedSkills().includes("custom"));
  assert.equal(await ev(`a => a.options.sessionOptions().mode`), "talk", "locked session mode must not follow an additional skill");
  const badge = page.getByRole("button", { name: "Change activation policy for custom" });
  await badge.click(); // inherit -> ask (== original: omitted)
  await badge.click(); // ask -> yolo (differs: sent)
  const upds = (await ev(`a => JSON.parse(JSON.stringify(a.commands))`)).filter((c: any) => c.type === "update_skills" && c.set.custom);
  assert(upds.length >= 3, `expected toggle+2 cycle updates, got ${JSON.stringify(upds)}`);
  assert(!("usable" in upds[upds.length - 2].set.custom), `usable equal to original must be omitted: ${JSON.stringify(upds[upds.length - 2])}`);
  assert.equal(upds[upds.length - 1].set.custom.usable, "yolo");
  assert.equal(await ev(`a => { a.options.syncSkills(["custom"]); return a.options.selectedSkills().join(",") }`), "talk,custom", "mandatory primary in a talk session is talk");
  await page.screenshot({ path: "/tmp/mode-skills-talk-locked.png" });
  await page.keyboard.press("Escape");

  // --- Agentic session: talk is hidden, mode locked to agentic ---
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  if (!(await ev(`a => a.projects.isProjectExpanded({ id: "p1" })`))) {
    await page.getByText("Proj", { exact: true }).click();
  }
  await page.getByText("Build the thing").waitFor();
  await page.getByText("Build the thing").click();
  await page.waitForFunction(() => (window as any).modeSkillsUI.sid() === "agent-1");
  await openModeMenu();
  const agentRadios = await radios();
  assert(agentRadios.length === 1 && agentRadios[0].includes("Build"), `agentic session must hide talk (and never/absent), got ${JSON.stringify(agentRadios)}`);
  assert.equal(await page.getByRole("button", { name: "Agent permissions" }).count(), 1, "selector returns when the primary is not yolo");
  assert.equal(await ev(`a => a.options.sessionOptions().mode`), "agentic");
  await page.keyboard.press("Escape");

  // --- Draft again, none of the 4 exist: additionals alone decide the mode ---
  await page.getByRole("button", { name: "New Conversation", exact: true }).click();
  await ev(`a => a.setOfficial({ custom: { name: "custom", description: "c", body: "", enabled: true, usable: "ask", mode: "agentic" } })`);
  await openModeMenu();
  assert.equal((await radios()).length, 0, "Mode section must disappear when no mode skill exists");
  await page.getByRole("menuitemcheckbox").filter({ hasText: "custom" }).click();
  await page.waitForFunction(() => (window as any).modeSkillsUI.options.selectedSkills().join(",") === "custom");
  assert.equal(await ev(`a => a.options.sessionOptions().mode`), "agentic", "mode must come from the first selected (additional) skill");
  await page.screenshot({ path: "/tmp/mode-skills-none.png" });

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log("PASS mode-skills-ui: cache, reconciliation, mandatory primary, talk draft w/o project picker, Projects|Talk sidebar + persistence, per-session mode lock, usable omission, yolo selector hide, no-mode-skills fallback");
} finally {
  await browser.close();
  server.stop(true);
}
