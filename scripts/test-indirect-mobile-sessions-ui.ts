#!/usr/bin/env bun
// Headless Chromium mobile + desktop regression checks for Indirect Code
// session rows: clean mobile rows (no inline .rc-row-actions icon clutter),
// ~420ms touch long-press context menu (Pin/Unpin, Rename, Select, Delete)
// without closing the mobile drawer, and explicit inline rename Save/Cancel.
// Run: PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-mobile-sessions-ui.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const root = path.resolve(import.meta.dir, "..");
const bundle = await Bun.build({
  entrypoints: [path.join(root, "test/fixtures/indirect-mobile-sessions-ui.tsx")],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
assert(bundle.success, bundle.logs.join("\n"));

const dist = path.join(root, "dist");
const srcCssPath = path.join(root, "web/style.tailwindcss.css");
const codeCssPath = path.join(root, "web/src/styles/code.css");
const latestSrcMtime = Math.max(
  fs.statSync(srcCssPath).mtimeMs,
  fs.statSync(codeCssPath).mtimeMs,
);
const distCssRel = fs.existsSync(dist)
  ? Array.from(new Bun.Glob("assets/*.css").scanSync(dist))[0]?.replaceAll("\\", "/")
  : undefined;

let css: string;
if (
  distCssRel &&
  fs.statSync(path.join(dist, distCssRel)).mtimeMs >= latestSrcMtime
) {
  css = await Bun.file(path.join(dist, distCssRel)).text();
} else {
  const rawCss = fs.readFileSync(srcCssPath, "utf8");
  const compiled = await postcss([tailwindcss]).process(rawCss, {
    from: srcCssPath,
    to: path.join(root, "web/style.css"),
  });
  css = compiled.css;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/bundle.js") return new Response(bundle.outputs[0]);
    if (pathname === "/style.css") {
      return new Response(css, { headers: { "Content-Type": "text/css" } });
    }
    if (pathname === "/indirect-icon.svg") {
      const iconFile = Bun.file(path.join(root, "web/public/indirect-icon.svg"));
      if (await iconFile.exists()) return new Response(iconFile);
    }
    return new Response(
      '<!doctype html><html class="mobile" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
const errors: string[] = [];

try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  page.on("pageerror", (err: Error) => errors.push(err.message));

  await page.goto(server.url.toString());
  await page.waitForFunction(() => Boolean((window as any).mobileSessionsUI?.sidebarOpen));

  const cdp = await page.context().newCDPSession(page);

  const touchHold = async (selector: string, holdMs = 460) => {
    const box = await page.locator(selector).boundingBox();
    assert(box, `${selector} must be visible for touchHold`);
    const x = Math.round(box.x + box.width * 0.45);
    const y = Math.round(box.y + box.height * 0.5);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    });
    await page.waitForTimeout(holdMs);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(40);
  };

  // 1. Clean mobile session rows: zero inline .rc-row-actions inside session rows;
  //    title + compact timestamp + running stop button remain visible.
  const row1 = page.locator('[data-session-id="s1"]');
  const row2 = page.locator('[data-session-id="s2"]');
  const row3 = page.locator('[data-session-id="s3"]');
  assert(await row1.isVisible(), "s1 row visible in mobile drawer");
  assert(await row2.isVisible(), "s2 row visible in mobile drawer");
  assert(await row3.isVisible(), "s3 running row visible in mobile drawer");
  assert.equal(
    await page.locator('[data-session-id] .rc-row-actions').count(),
    0,
    "mobile session rows must NOT render inline .rc-row-actions buttons",
  );
  assert(
    await row1.locator(".rc-row-time").isVisible(),
    "mobile session row shows compact relative timestamp",
  );
  assert(
    await row3.getByRole("button", { name: "Stop turn" }).isVisible(),
    "running session row keeps SessionStopButton on mobile",
  );
  console.log("PASS 1: mobile session rows omit inline .rc-row-actions and show clean title + timestamp");

  // 2. Pointer movement > 8px cancels the long-press timer (scroll/drag guard).
  {
    const box = await row2.boundingBox();
    assert(box, "row2 bounding box");
    const x = Math.round(box.x + 40);
    const y = Math.round(box.y + box.height / 2);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(100);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + 22, y, id: 1 }],
    });
    await page.waitForTimeout(400);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    assert.equal(
      await page.getByRole("menu", { name: "Conversation actions" }).count(),
      0,
      "touch drag > 8px must cancel long-press popup",
    );
  }
  console.log("PASS 2: touch movement > 8px cancels long-press timer");

  // 3. Touch long-press (~460ms) opens popup menu with Pin, Rename, Select, Delete
  //    WITHOUT selecting the row or closing the mobile sidebar drawer!
  await touchHold('[data-session-id="s2"]', 460);
  const menu = page.getByRole("menu", { name: "Conversation actions" });
  assert(await menu.isVisible(), "long-press opens Conversation actions FloatMenu");
  assert.equal(
    await page.evaluate(() => (window as any).mobileSessionsUI.sidebarOpen()),
    true,
    "mobile sidebar drawer must stay open after long-press release",
  );
  assert.equal(
    await page.evaluate(() => (window as any).mobileSessionsUI.activeSessionId()),
    "s1",
    "long-press on s2 must NOT trigger selectSession('s2')",
  );
  assert.equal(
    (await menu.locator("[data-session-menu-header]").textContent())?.trim(),
    "Audit daemon builtin tool bodies",
    "context menu header displays session title",
  );
  for (const itemName of ["Pin conversation", "Rename", "Select", "Delete"]) {
    assert(
      await menu.getByRole("menuitem", { name: itemName, exact: true }).isVisible(),
      `context menu displays "${itemName}"`,
    );
  }

  // Test Pin -> Unpin label toggle via long-press popup
  await menu.getByRole("menuitem", { name: "Pin conversation", exact: true }).tap();
  await page.waitForSelector('[role="menu"][aria-label="Conversation actions"]', { state: "detached" });
  assert.equal(
    await page.evaluate(() =>
      (window as any).mobileSessionsUI.commands.some(
        (c: any) => c.type === "toggle_pin" && c.sessionId === "s2",
      ),
    ),
    true,
    "Pin conversation dispatches toggle_pin",
  );

  await touchHold('[data-session-id="s2"]', 460);
  assert(
    await menu.getByRole("menuitem", { name: "Unpin conversation", exact: true }).isVisible(),
    "pinned session shows Unpin conversation in popup",
  );
  console.log("PASS 3: touch long-press opens context popup (Pin/Unpin, Rename, Select, Delete) and keeps drawer open");

  // 4. Tapping Rename opens inline rename with Save rename (✓) and Cancel rename (✕);
  //    mobile blur does NOT auto-submit; Cancel restores original title; Save commits!
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).tap();
  await page.waitForSelector('[role="menu"][aria-label="Conversation actions"]', { state: "detached" });
  assert.equal(
    await page.evaluate(() => (window as any).mobileSessionsUI.sidebarOpen()),
    true,
    "tapping Rename keeps mobile sidebar open",
  );

  const renameInput = row2.getByRole("textbox", { name: "Rename conversation" });
  const saveBtn = row2.getByRole("button", { name: "Save rename" });
  const cancelBtn = row2.getByRole("button", { name: "Cancel rename" });
  assert(await renameInput.isVisible(), "Rename conversation input is visible");
  assert(await saveBtn.isVisible(), "Save rename button is visible");
  assert(await cancelBtn.isVisible(), "Cancel rename button is visible");

  await renameInput.fill("Accidental unconfirmed title");
  // Simulate mobile keyboard dismiss / accidental blur: must NOT auto-submit on mobile!
  await renameInput.evaluate((el: HTMLInputElement) => el.blur());
  await page.waitForTimeout(80);
  assert(await renameInput.isVisible(), "mobile blur must NOT auto-submit or close inline rename");
  assert.equal(
    await page.evaluate(() =>
      (window as any).mobileSessionsUI.commands.some((c: any) => c.type === "rename_session"),
    ),
    false,
    "mobile blur must NOT send rename_session",
  );

  // Tap Cancel rename (✕): must restore original title and send zero rename_session commands
  await cancelBtn.tap();
  await renameInput.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() =>
      (window as any).mobileSessionsUI.commands.some((c: any) => c.type === "rename_session"),
    ),
    false,
    "Cancel rename must never call submitRename",
  );
  assert(
    (await row2.textContent())?.includes("Audit daemon builtin tool bodies"),
    "Cancel rename restores original session title",
  );

  // Re-open Rename via long-press, edit title, and tap Save rename (✓)
  await touchHold('[data-session-id="s2"]', 460);
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).tap();
  await renameInput.waitFor({ state: "visible" });
  await renameInput.fill("Verified mobile session UX");
  await saveBtn.tap();
  await renameInput.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() =>
      (window as any).mobileSessionsUI.commands.some(
        (c: any) =>
          c.type === "rename_session" &&
          c.sessionId === "s2" &&
          c.title === "Verified mobile session UX",
      ),
    ),
    true,
    "Save rename commits rename_session with new title",
  );
  assert(
    (await row2.textContent())?.includes("Verified mobile session UX"),
    "row displays saved title",
  );
  console.log("PASS 4: inline rename Save (✓) and Cancel (✕) + mobile blur guard work cleanly");

  // 5. Select enters multi-select mode on mobile; Delete removes conversation
  await touchHold('[data-session-id="s2"]', 460);
  await menu.getByRole("menuitem", { name: "Select", exact: true }).tap();
  assert.equal(
    await page.evaluate(() => (window as any).mobileSessionsUI.projects.selectionMode()),
    true,
    "Select enters selectionMode on mobile",
  );
  assert.equal(
    await page.evaluate(() => (window as any).mobileSessionsUI.projects.selectedSessions().has("s2")),
    true,
    "Select marks session s2 selected",
  );
  await page.getByRole("button", { name: "Exit selection mode" }).tap();

  await touchHold('[data-session-id="s2"]', 460);
  await menu.getByRole("menuitem", { name: "Delete", exact: true }).tap();
  await row2.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() =>
      (window as any).mobileSessionsUI.commands.some(
        (c: any) => c.type === "delete_session" && c.sessionId === "s2",
      ),
    ),
    true,
    "Delete menu item dispatches delete_session",
  );
  console.log("PASS 5: Select enters multi-select mode and Delete removes session");

  // 6. Desktop parity: hover .rc-row-actions stay intact, right-click opens FloatMenu,
  //    and Cancel rename works cleanly on desktop too!
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    (window as any).mobileSessionsUI.setMobile(false);
    (window as any).mobileSessionsUI.setSidebarOpen(true);
  });
  await page.waitForTimeout(80);
  assert(
    (await page.locator('[data-session-id="s1"] .rc-row-actions .rc-row-action').count()) === 3,
    "desktop session row renders all 3 hover .rc-row-actions buttons (Pin, Rename, Delete)",
  );
  await row1.click({ button: "right" });
  assert(await menu.isVisible(), "desktop right-click opens Conversation actions FloatMenu");
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const desktopInput = row1.getByRole("textbox", { name: "Rename conversation" });
  await desktopInput.fill("Desktop cancelled title");
  await row1.getByRole("button", { name: "Cancel rename" }).click();
  await desktopInput.waitFor({ state: "detached" });
  assert(
    (await row1.textContent())?.includes("Refactor streaming diff highlighter"),
    "desktop Cancel rename restores original title despite onBlur",
  );
  console.log("PASS 6: desktop hover actions, right-click menu, and inline Cancel rename verified");

  assert.deepEqual(errors, [], "zero browser page errors");
  console.log("Mobile session rows & rename UX: all green");
} finally {
  await browser.close();
  server.stop(true);
}
