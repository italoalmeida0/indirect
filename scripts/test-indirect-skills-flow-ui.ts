// Browser check for the Mode & Skills flow fixes: the popup sends only the
// user's delta against the moment it opened (an AI activation that arrives
// meanwhile survives a close with no edits), the ask badge cycle
// ask→yolo→deny→ask drops the override again, a new draft carries the
// remembered mode skill only, /skills and /mcp never start a model turn,
// and skill load errors render in the popup. Drives the REAL components via
// clicks, like a user. Run:
//   PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-skills-flow-ui.ts
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../test/fixtures/indirect-mode-skills-ui.tsx", import.meta.url))],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
let css = "";
try {
  const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
  // The current build emits the SPA stylesheet under dist/assets (boot-*.css);
  // older builds put it at the dist root.
  const cssDir = existsSync(distDir + "assets/") ? distDir + "assets/" : distDir;
  const cssFile = readdirSync(cssDir).find((f) => f.startsWith("boot-") && f.endsWith(".css")) ?? readdirSync(cssDir).find((f) => f.endsWith(".css"));
  if (cssFile) css = readFileSync(cssDir + cssFile, "utf8");
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
  const json = (v: unknown) => JSON.parse(JSON.stringify(v));
  const commands = async () => json(await ev(`a => a.commands`)) as any[];
  const updateSkills = async () => (await commands()).filter((c) => c.type === "update_skills");
  const openModeMenu = async () => {
    const btn = page.getByRole("button", { name: "Agent mode and skills" });
    if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
    await page.waitForSelector('[role="menuitemradio"], [role="menuitemcheckbox"]');
  };
  const closeModeMenu = async () => {
    const btn = page.getByRole("button", { name: "Agent mode and skills" });
    if ((await btn.getAttribute("aria-expanded")) === "true") await btn.click();
    await page.waitForSelector('[role="menuitemradio"], [role="menuitemcheckbox"]', { state: "detached" });
  };
  const openProjectSession = async (title: string, id: string) => {
    if ((await ev(`a => a.projects.sidebarView()`)) !== "projects") {
      await page.getByRole("button", { name: "Projects", exact: true }).click();
    }
    if (!(await ev(`a => a.projects.isProjectExpanded({ id: "p1" })`))) {
      await page.getByText("Proj", { exact: true }).click();
    }
    await page.getByText(title).click();
    await page.waitForFunction((sid) => (window as any).modeSkillsUI.sid() === sid, id);
    await page.waitForFunction(() => !(window as any).modeSkillsUI.draftMode());
  };

  // Official skill list: build is the agentic mode skill; custom/extra are
  // ask-original additions.
  await ev(`a => { a.setOfficial({
    build: { name: "build", description: "Daemon Build desc", body: "", enabled: true, usable: "deny", mode: "agentic" },
    plan: { name: "plan", description: "p", body: "", enabled: true, usable: "never", mode: "agentic" },
    talk: { name: "talk", description: "t", body: "", enabled: true, usable: "deny", mode: "talk", approvalMode: "yolo" },
    custom: { name: "custom", description: "Custom skill", body: "", enabled: true, usable: "ask", mode: "agentic" },
    extra: { name: "extra", description: "Extra skill", body: "", enabled: true, usable: "ask", mode: "agentic" },
  }); a.setLoaded(true); }`);

  // --- F1: a daemon-side AI activation while the popup is open survives a
  // close WITHOUT edits (no update_skills at all, so the skill is neither
  // deactivated nor claimed as the user's). ---
  await openProjectSession("Build the thing", "agent-1");
  assert.equal(await ev(`a => a.options.selectedSkills().join(",")`), "build");
  await ev(`a => { a.commands.length = 0 }`);
  await openModeMenu();
  await page.screenshot({ path: "/tmp/skills-flow-f1-open.png" });
  await ev(`a => a.options.applySessionSkills({
    build: { priority: 1, active: true, usable: "" },
    aiSkill: { priority: 9, active: true, byAI: true },
  })`);
  assert.equal(await ev(`a => a.options.selectedSkills().join(",")`), "build,aiSkill", "AI activation must reach the live selection while the popup is open");
  assert.equal(await ev(`a => a.commands.length`), 0, "opening the popup and receiving a daemon snapshot must not send a command");
  await closeModeMenu();
  assert.equal((await updateSkills()).length, 0, `closing without edits must send no update_skills, got ${JSON.stringify(await updateSkills())}`);
  assert.equal((await commands()).length, 0, `closing without edits must send no command, got ${JSON.stringify(await commands())}`);

  // Same popup, now with one user edit: only that skill rides; the AI-added
  // skill stays in the order and is never deactivated. The badge cycle ends
  // on the file original (ask) and must omit the usable key.
  await openModeMenu();
  const badge = page.getByRole("button", { name: "Change activation policy for custom" });
  assert.equal((await badge.textContent())?.trim(), "ask", "no override shows the file original (ask)");
  await badge.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Change activation policy for custom"]')?.textContent?.trim() === "yolo");
  await page.screenshot({ path: "/tmp/skills-flow-badge-yolo.png" });
  await badge.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Change activation policy for custom"]')?.textContent?.trim() === "deny");
  await badge.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Change activation policy for custom"]')?.textContent?.trim() === "ask");
  await page.screenshot({ path: "/tmp/skills-flow-badge-ask.png" });
  await page.getByRole("menuitemcheckbox").filter({ hasText: "custom" }).click();
  await closeModeMenu();
  const edits = await updateSkills();
  assert.equal(edits.length, 1, `one close must send exactly one update_skills, got ${JSON.stringify(edits)}`);
  const last = edits[0];
  assert.deepEqual(Object.keys(last.set), ["custom"], `update_skills must carry only the user's skill, got ${JSON.stringify(last.set)}`);
  assert.equal(last.set.custom.active, true);
  assert(!("usable" in last.set.custom), `ask (the file original) must omit usable, got ${JSON.stringify(last.set.custom)}`);
  assert(!("aiSkill" in last.set), "the AI-activated skill must not be deactivated or re-sent");
  assert(last.order.includes("aiSkill"), `order must keep the AI-activated skill, got ${JSON.stringify(last.order)}`);
  assert.equal(await ev(`a => a.options.selectedSkills().join(",")`), "build,aiSkill,custom");

  // --- F2: New Conversation starts clean (no selection, usable override or
  // approval mode from the session on screen); the remembered mode skill
  // seeds the draft. ---
  await ev(`a => a.setLastSelection({ model: "m", effort: "medium", mode: "agentic", access: "ask", skills: [{ name: "build" }] })`);
  await openProjectSession("Rich session", "agent-rich");
  assert.equal(await ev(`a => JSON.stringify(a.options.selectedSkills())`), `["build","custom"]`, "rich session selection must load");
  assert.equal(await ev(`a => JSON.stringify(a.options.skillUsables())`), `{"build":"inherit","custom":"yolo"}`, "rich session usables must load");
  assert.equal(await ev(`a => a.options.approvalMode()`), "yolo", "rich session approval mode must load");
  await page.getByRole("button", { name: "New Conversation", exact: true }).click();
  await page.waitForFunction(() => (window as any).modeSkillsUI.draftMode() === true);
  assert.equal(await ev(`a => JSON.stringify(a.options.selectedSkills())`), `["build"]`, "a fresh draft carries only the remembered mode skill");
  assert.equal(await ev(`a => JSON.stringify(a.options.skillUsables())`), `{}`, "a fresh draft carries no usable override");
  assert.equal(await ev(`a => a.options.approvalMode()`), "ask", "a fresh draft carries no approval mode");
  await page.screenshot({ path: "/tmp/skills-flow-new-draft.png" });

  // --- /skills opens the picker locally; /mcp only toasts. Neither sends a
  // prompt to the daemon. ---
  await ev(`a => { a.commands.length = 0; a.notices.length = 0 }`);
  const composer = page.locator("#rc-composer");
  await composer.fill("/skills");
  await composer.press("Enter");
  await page.waitForFunction(() => (window as any).modeSkillsUI.options.modeMenuOpen() === true);
  assert(await page.locator('[role="menuitemcheckbox"]').first().isVisible(), "/skills must open the Mode & Skills popup");
  assert(!(await commands()).some((c) => c.type === "prompt"), `/skills must not send a prompt, got ${JSON.stringify(await commands())}`);
  await page.screenshot({ path: "/tmp/skills-flow-slash-skills.png" });
  await closeModeMenu();
  await ev(`a => { a.commands.length = 0; a.notices.length = 0 }`);
  await composer.fill("/mcp");
  await composer.press("Enter");
  await page.waitForFunction(() => (window as any).modeSkillsUI.notices.length > 0);
  assert(!(await commands()).some((c) => c.type === "prompt"), `/mcp must not send a prompt, got ${JSON.stringify(await commands())}`);
  assert((await ev(`a => a.notices.join("|")`)).includes("MCP"), "MCP must answer with a toast");
  assert.equal(await ev(`a => a.commands.length`), 0, `/mcp must send no command, got ${JSON.stringify(await commands())}`);

  // --- Skill load errors render in the popup (amber box, relative path). ---
  await ev(`a => a.setSkillErrors(["skill broken.js: boom"])`);
  await openModeMenu();
  const status = page.getByRole("status");
  await status.waitFor();
  assert((await status.textContent())?.includes("1 skill file failed to load"), `skill errors must headline the count, got ${JSON.stringify(await status.textContent())}`);
  assert((await status.textContent())?.includes("broken.js"), `skill errors must name the file, got ${JSON.stringify(await status.textContent())}`);
  await page.screenshot({ path: "/tmp/skills-flow-errors.png" });
  await closeModeMenu();

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log("PASS skills-flow-ui: F1 delta-only close preserves AI activation, badge ask→yolo→deny→ask omits usable, F2 clean draft from remembered mode skill, /skills + /mcp local, skillErrors box");
} finally {
  await browser.close();
  server.stop(true);
}
