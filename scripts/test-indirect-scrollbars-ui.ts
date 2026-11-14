#!/usr/bin/env bun
// Automated visual + behavioral Playwright gate for Indirect Code desktop
// hover-reveal scrollbars, Portal scoping, nested scroller isolation,
// intentional hidden scrollbars, Generative UI widget iframes, Gateway
// non-regression, and Mobile zero-scrollbar preservation.
// Run: PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-scrollbars-ui.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const root = path.resolve(import.meta.dir, "..");
const bundle = await Bun.build({
  entrypoints: [path.join(root, "test/fixtures/indirect-scrollbars-ui.tsx")],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
assert(bundle.success, bundle.logs.join("\n"));

// Always compile fresh CSS from source so edits to shell.css / tokens.css /
// components.css are never masked by a stale dist/ bundle.
const srcCssPath = path.join(root, "web/style.tailwindcss.css");
const compiled = await postcss([tailwindcss]).process(
  fs.readFileSync(srcCssPath, "utf8"),
  { from: srcCssPath, to: path.join(root, "web/style.css") },
);
const css = compiled.css;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/bundle.js") return new Response(bundle.outputs[0]);
    if (url.pathname === "/style.css") {
      return new Response(css, { headers: { "Content-Type": "text/css" } });
    }
    const mobile = url.searchParams.get("mobile") === "1";
    return new Response(
      `<!doctype html><html${mobile ? ' class="mobile"' : ""} data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
// Playwright passes `--hide-scrollbars` by default in headless mode; strip it
// so real Chromium desktop scrollbars paint and mobile CSS hiding is genuinely tested.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
});

type RGB = [number, number, number];

function colorDist(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

async function readClipPixels(
  page: any,
  clip: { x: number; y: number; width: number; height: number },
): Promise<{ width: number; height: number; rgbAt: (dx: number, dy: number) => RGB }> {
  const buf: Buffer = await page.screenshot({ clip });
  const b64 = buf.toString("base64");
  const decoded: { width: number; height: number; data: number[] } = await page.evaluate(
    async (src: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${src}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return {
        width: img.width,
        height: img.height,
        data: Array.from(ctx.getImageData(0, 0, img.width, img.height).data),
      };
    },
    b64,
  );
  return {
    width: decoded.width,
    height: decoded.height,
    rgbAt(dx: number, dy: number): RGB {
      const idx = (dy * decoded.width + dx) * 4;
      return [decoded.data[idx]!, decoded.data[idx + 1]!, decoded.data[idx + 2]!];
    },
  };
}

try {
  // =========================================================================
  // 1. Desktop Indirect Code + Gateway Scoping (1280x800, pointer: fine)
  // =========================================================================
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  desktop.on("pageerror", (err: Error) => errors.push(String(err)));

  await desktop.goto(server.url.toString());
  await desktop.waitForFunction(() => Boolean((window as any).scrollbarsUI));

  const parkMouseIdle = async () => {
    await desktop.mouse.move(1270, 10);
    await desktop.waitForTimeout(50);
  };

  // --- 1a. Refcounted `data-indirect-code` scoping on <html> ---
  assert.equal(
    await desktop.evaluate(() => document.documentElement.getAttribute("data-indirect-code")),
    "",
    "WorkspaceShell sets data-indirect-code='' on <html> when mounted",
  );
  await desktop.evaluate(() => (window as any).scrollbarsUI.setExtraScope(true));
  assert.equal(
    await desktop.evaluate(() => document.documentElement.hasAttribute("data-indirect-code")),
    true,
    "second scope keeps data-indirect-code present",
  );
  await desktop.evaluate(() => (window as any).scrollbarsUI.setExtraScope(false));
  assert.equal(
    await desktop.evaluate(() => document.documentElement.hasAttribute("data-indirect-code")),
    true,
    "unmounting one scope while WorkspaceShell stays mounted preserves data-indirect-code",
  );

  // Helper to inspect vertical scrollbar rail & interior background of a box
  const measureVerticalRail = async (selector: string) => {
    const m = await desktop.evaluate((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const borderRight = parseFloat(cs.borderRightWidth) || 0;
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const cornerRadius = parseFloat(cs.borderTopRightRadius) || 0;
      return {
        offsetWidth: el.offsetWidth,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        scrollTop: el.scrollTop,
        outsideAppShell: !el.closest(".rc-app-shell") && el.parentElement?.parentElement === document.body,
        railLeft: Math.round(r.right - borderRight - 8),
        top: Math.round(r.top + borderTop),
        sampleOffsetY: Math.max(14, Math.ceil(cornerRadius) + 4),
        height: el.clientHeight,
        centerX: Math.round(r.left + r.width * 0.4),
        centerY: Math.round(r.top + r.height * 0.4),
      };
    }, selector);
    // Sample a 12px wide strip ending at the inner right border:
    // dx = 0..3 is container interior right before the 8px rail,
    // dx = 4..5 is 2px left transparent thumb border,
    // dx = 6..9 is 4px pill thumb center,
    // dx = 10..11 is 2px right transparent thumb border.
    const strip = await readClipPixels(desktop, {
      x: m.railLeft - 4,
      y: m.top + m.sampleOffsetY,
      width: 12,
      height: 8,
    });
    const bgSample = strip.rgbAt(1, 4);
    const leftInsetSample = strip.rgbAt(4, 4);
    const thumbSample = strip.rgbAt(7, 4);
    const rightInsetSample = strip.rgbAt(11, 4);
    let maxRailDiffFromBg = 0;
    for (let dy = 0; dy < 8; dy++) {
      for (let dx = 4; dx < 12; dx++) {
        maxRailDiffFromBg = Math.max(maxRailDiffFromBg, colorDist(strip.rgbAt(dx, dy), bgSample));
      }
    }
    return {
      ...m,
      bgSample,
      leftInsetSample,
      thumbSample,
      rightInsetSample,
      maxRailDiffFromBg,
      thumbContrast: colorDist(thumbSample, bgSample),
    };
  };

  // --- 1b. Test BOTH dark and light themes on --background and --surface ---
  for (const theme of ["dark", "light"] as const) {
    await desktop.evaluate((t: string) => {
      document.documentElement.setAttribute("data-theme", t);
    }, theme);
    await parkMouseIdle();

    for (const selector of ["#bg-scroller", "#surface-scroller"]) {
      await parkMouseIdle();
      const idle = await measureVerticalRail(selector);
      assert.equal(
        idle.offsetWidth - idle.clientWidth - 2,
        8,
        `[${theme}] ${selector}: reserves fixed 8px scrollbar gutter when idle`,
      );
      assert.equal(
        idle.maxRailDiffFromBg,
        0,
        `[${theme}] ${selector}: idle scrollbar rail is 100% invisible with zero border halo (bg=${idle.bgSample}, thumb=${idle.thumbSample})`,
      );

      // Hover container -> reveal 4px inset pill thumb, 0px layout shift
      await desktop.hover(selector);
      await desktop.waitForTimeout(50);
      const hovered = await measureVerticalRail(selector);
      assert.equal(
        hovered.clientWidth,
        idle.clientWidth,
        `[${theme}] ${selector}: zero clientWidth shift on hover`,
      );
      assert.equal(
        hovered.scrollWidth,
        idle.scrollWidth,
        `[${theme}] ${selector}: zero scrollWidth shift on hover`,
      );
      assert(
        hovered.thumbContrast >= 20,
        `[${theme}] ${selector}: hovered container reveals visible scrollbar thumb (bg=${hovered.bgSample}, thumb=${hovered.thumbSample})`,
      );
      assert.equal(
        colorDist(hovered.leftInsetSample, hovered.bgSample),
        0,
        `[${theme}] ${selector}: 2px transparent left inset preserved via content-box`,
      );
      assert.equal(
        colorDist(hovered.rightInsetSample, hovered.bgSample),
        0,
        `[${theme}] ${selector}: 2px transparent right inset preserved via content-box`,
      );

      // Unhover -> zero layout shift, returns to 100% invisible
      await parkMouseIdle();
      const unhovered = await measureVerticalRail(selector);
      assert.equal(unhovered.clientWidth, idle.clientWidth, `[${theme}] ${selector}: zero clientWidth shift after unhover`);
      assert.equal(unhovered.maxRailDiffFromBg, 0, `[${theme}] ${selector}: hides back to 100% invisible after unhover`);
    }
  }

  const screenshotDir = process.env.SCROLLBAR_SCREENSHOT_DIR || "";
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

  // Restore dark theme for remaining desktop behavioral checks
  await desktop.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await parkMouseIdle();
  if (screenshotDir) {
    await desktop.screenshot({ path: path.join(screenshotDir, "01-desktop-dark-idle.png") });
    await desktop.hover("#transcript-para");
    await desktop.waitForTimeout(40);
    await desktop.screenshot({ path: path.join(screenshotDir, "02-desktop-dark-outer-hover.png") });
    await desktop.hover("#nested-pre");
    await desktop.waitForTimeout(40);
    await desktop.screenshot({ path: path.join(screenshotDir, "03-desktop-dark-nested-hover.png") });
    await parkMouseIdle();
  }

  // --- 1c. Thumb :hover + Active Thumb Drag outside container ---
  {
    await desktop.hover("#surface-scroller");
    await desktop.waitForTimeout(40);
    const containerHover = await measureVerticalRail("#surface-scroller");

    // Move directly onto the vertical scrollbar thumb
    const thumbX = containerHover.railLeft + 4;
    const thumbY = containerHover.top + 18;
    await desktop.mouse.move(thumbX, thumbY);
    await desktop.waitForTimeout(40);
    const thumbHover = await measureVerticalRail("#surface-scroller");
    assert(
      colorDist(thumbHover.thumbSample, containerHover.thumbSample) >= 15,
      `thumb :hover uses higher-contrast --text-muted (${thumbHover.thumbSample} vs ${containerHover.thumbSample})`,
    );
    assert.equal(
      colorDist(thumbHover.leftInsetSample, thumbHover.bgSample),
      0,
      "thumb :hover keeps 4px content-box inset without puffing to 8px",
    );

    // Drag thumb while moving pointer outside #surface-scroller horizontally (+32px past right edge, within OS snap-back band)
    await desktop.mouse.down();
    await desktop.mouse.move(thumbX + 36, thumbY + 45, { steps: 8 });
    await desktop.waitForTimeout(40);
    const scrolled = await desktop.evaluate(
      () => document.querySelector<HTMLElement>("#surface-scroller")!.scrollTop,
    );
    assert(scrolled > 0, `dragging scrollbar thumb scrolls container (scrollTop=${scrolled})`);

    // Sample where the thumb moved during active drag while pointer is outside
    const activeStrip = await readClipPixels(desktop, {
      x: containerHover.railLeft - 4,
      y: containerHover.top + 65,
      width: 12,
      height: 4,
    });
    const activeBg = activeStrip.rgbAt(1, 2);
    const activeThumb = activeStrip.rgbAt(7, 2);
    assert(
      colorDist(activeThumb, activeBg) >= 35,
      `thumb :active remains visibly highlighted even when pointer drifts outside container mid-drag (bg=${activeBg}, thumb=${activeThumb})`,
    );

    await desktop.mouse.up();
    await desktop.waitForTimeout(40);
    const afterRelease = await readClipPixels(desktop, {
      x: containerHover.railLeft - 4,
      y: containerHover.top + 65,
      width: 12,
      height: 4,
    });
    assert.equal(
      colorDist(afterRelease.rgbAt(7, 2), afterRelease.rgbAt(1, 2)),
      0,
      "releasing mouse outside container immediately hides the thumb",
    );
    await desktop.evaluate(() => {
      document.querySelector<HTMLElement>("#surface-scroller")!.scrollTop = 0;
    });
  }

  // --- 1d. Nested scrollable <pre> inside hovered outer .transcript ---
  {
    await parkMouseIdle();
    const idleOuter = await measureVerticalRail("#transcript-scroller");
    const idleInner = await measureVerticalRail("#nested-pre");
    assert.equal(idleOuter.maxRailDiffFromBg, 0, "outer .transcript scrollbar idle invisible");
    assert.equal(idleInner.maxRailDiffFromBg, 0, "nested <pre> scrollbar idle invisible");

    // Hover <p> inside .transcript (sibling of <pre>)
    await desktop.hover("#transcript-para");
    await desktop.waitForTimeout(50);
    const outerWhenParaHovered = await measureVerticalRail("#transcript-scroller");
    const innerWhenParaHovered = await measureVerticalRail("#nested-pre");
    assert(
      outerWhenParaHovered.thumbContrast >= 20,
      "hovering <p> in .transcript reveals .transcript's own scrollbar",
    );
    assert.equal(
      innerWhenParaHovered.maxRailDiffFromBg,
      0,
      "hovering <p> in .transcript does NOT reveal sibling nested <pre> scrollbar",
    );

    // Hover nested <pre> itself
    await desktop.hover("#nested-pre");
    await desktop.waitForTimeout(50);
    const innerWhenPreHovered = await measureVerticalRail("#nested-pre");
    assert(
      innerWhenPreHovered.thumbContrast >= 20,
      "hovering nested <pre> reveals <pre>'s scrollbar",
    );
    assert.equal(
      innerWhenPreHovered.clientWidth,
      idleInner.clientWidth,
      "nested <pre> has zero clientWidth layout shift on hover",
    );
  }

  // --- 1e. Portaled .ui-dialog-body & .ui-popover under document.body ---
  for (const portalSel of ["#portal-dialog-body", "#portal-popover"]) {
    await parkMouseIdle();
    const idlePortal = await measureVerticalRail(portalSel);
    assert.equal(
      idlePortal.outsideAppShell,
      true,
      `${portalSel} mounts outside .rc-app-shell under document.body via <Portal>`,
    );
    assert.equal(
      idlePortal.maxRailDiffFromBg,
      0,
      `${portalSel}: idle scrollbar over --surface-raised is 100% invisible (zero --background halo)`,
    );

    await desktop.hover(portalSel);
    await desktop.waitForTimeout(50);
    const hoveredPortal = await measureVerticalRail(portalSel);
    assert(
      hoveredPortal.thumbContrast >= 20,
      `${portalSel}: hovering portaled overlay reveals its scrollbar thumb`,
    );
    assert.equal(hoveredPortal.clientWidth, idlePortal.clientWidth, `${portalSel}: zero layout shift on hover`);
  }

  // --- 1f. Intentional hidden scrollbars stay hidden even on :hover ---
  for (const hiddenSel of [
    "#hidden-no-scrollbar",
    "#hidden-segmented",
    "#hidden-tabs",
    "#hidden-tailwind",
  ]) {
    await parkMouseIdle();
    const before = await desktop.evaluate((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const cs = getComputedStyle(el);
      const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollbarHeight: Math.round(el.offsetHeight - el.clientHeight - borderY),
      };
    }, hiddenSel);
    assert(before.scrollWidth > before.clientWidth, `${hiddenSel} overflows horizontally`);
    assert.equal(before.scrollbarHeight, 0, `${hiddenSel} hides scrollbar when idle`);

    await desktop.hover(hiddenSel);
    await desktop.waitForTimeout(50);
    const during = await desktop.evaluate((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const cs = getComputedStyle(el);
      const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      return {
        clientHeight: el.clientHeight,
        scrollbarHeight: Math.round(el.offsetHeight - el.clientHeight - borderY),
      };
    }, hiddenSel);
    assert.equal(during.scrollbarHeight, 0, `${hiddenSel} keeps scrollbar completely hidden on :hover`);
  }

  // --- 1g. Generative UI widget iframe (WIDGET_BASE_CSS) ---
  {
    await parkMouseIdle();
    const frame = desktop.frameLocator("#widget-iframe");
    await frame.locator("#gu-scroller").waitFor({ state: "visible" });
    const iframeBox = await desktop.locator("#widget-iframe").boundingBox();
    assert(iframeBox, "widget iframe visible");

    const guMetrics = await frame.locator("#gu-scroller").evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const borderRight = parseFloat(cs.borderRightWidth) || 0;
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      return {
        offsetWidth: el.offsetWidth,
        clientWidth: el.clientWidth,
        railLeft: Math.round(r.right - borderRight - 8),
        top: Math.round(r.top + borderTop),
      };
    });
    assert.equal(
      guMetrics.offsetWidth - guMetrics.clientWidth - 2,
      8,
      "Generative UI widget iframe scroller uses 8px desktop scrollbar gutter",
    );

    const sampleIframeRail = async () => {
      const strip = await readClipPixels(desktop, {
        x: Math.round(iframeBox.x + 1 + guMetrics.railLeft - 4),
        y: Math.round(iframeBox.y + 1 + guMetrics.top + 16),
        width: 12,
        height: 6,
      });
      const bg = strip.rgbAt(1, 3);
      const thumb = strip.rgbAt(7, 3);
      return { bg, thumb, contrast: colorDist(thumb, bg) };
    };

    const guIdle = await sampleIframeRail();
    assert.equal(guIdle.contrast, 0, "Generative UI widget scrollbar is 100% invisible when idle");

    await frame.locator("#gu-scroller").hover();
    await desktop.waitForTimeout(50);
    const guHover = await sampleIframeRail();
    assert(
      guHover.contrast >= 18,
      `Generative UI widget scrollbar reveals on hover (bg=${guHover.bg}, thumb=${guHover.thumb})`,
    );
    const guHoverClientWidth = await frame
      .locator("#gu-scroller")
      .evaluate((el: HTMLElement) => el.clientWidth);
    assert.equal(guHoverClientWidth, guMetrics.clientWidth, "Generative UI widget scroller has zero layout shift on hover");
  }

  // =========================================================================
  // 2. Gateway Route (<html> without `data-indirect-code`, 1280x800)
  // =========================================================================
  await desktop.evaluate(() => (window as any).scrollbarsUI.setMode("gateway"));
  await parkMouseIdle();
  assert.equal(
    await desktop.evaluate(() => document.documentElement.hasAttribute("data-indirect-code")),
    false,
    "unmounting WorkspaceShell removes data-indirect-code from <html>",
  );
  {
    const gw = await desktop.evaluate(() => {
      const el = document.querySelector<HTMLElement>("#gateway-scroller")!;
      const r = el.getBoundingClientRect();
      return {
        gutter: el.offsetWidth - el.clientWidth - 2,
        railLeft: Math.round(r.right - 1 - 10),
        top: Math.round(r.top + 1),
      };
    });
    assert.equal(gw.gutter, 10, "Gateway scroller keeps standard 10px scrollbar");
    const gwStrip = await readClipPixels(desktop, {
      x: gw.railLeft - 4,
      y: gw.top + 16,
      width: 14,
      height: 8,
    });
    const gwBg = gwStrip.rgbAt(1, 4);
    const gwThumb = gwStrip.rgbAt(9, 4);
    assert(
      colorDist(gwThumb, gwBg) >= 20,
      `Gateway scrollbar thumb remains visible while idle (bg=${gwBg}, thumb=${gwThumb})`,
    );
  }
  assert.deepEqual(errors, [], "zero page errors on desktop");
  await desktop.close();

  // =========================================================================
  // 3. Mobile (`html.mobile[data-indirect-code]`, 390x844, hasTouch: true)
  // =========================================================================
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const mobileErrors: string[] = [];
  mobile.on("pageerror", (err: Error) => mobileErrors.push(String(err)));

  await mobile.goto(`${server.url}?mobile=1`);
  await mobile.waitForFunction(() => Boolean((window as any).scrollbarsUI));

  const mobileFlags = await mobile.evaluate(() => ({
    isMobileClass: document.documentElement.classList.contains("mobile"),
    hasIndirectAttr: document.documentElement.hasAttribute("data-indirect-code"),
    idleGutter:
      document.querySelector<HTMLElement>("#surface-scroller")!.offsetWidth -
      document.querySelector<HTMLElement>("#surface-scroller")!.clientWidth -
      2,
  }));
  assert.equal(mobileFlags.isMobileClass, true, "html.mobile class active");
  assert.equal(mobileFlags.hasIndirectAttr, true, "data-indirect-code active on mobile");
  assert.equal(mobileFlags.idleGutter, 0, "mobile scrollbar stays 0px (display: none) when idle");

  await mobile.tap("#surface-scroller");
  await mobile.hover("#surface-scroller");
  await mobile.waitForTimeout(50);
  const mobileActiveGutter = await mobile.evaluate(
    () =>
      document.querySelector<HTMLElement>("#surface-scroller")!.offsetWidth -
      document.querySelector<HTMLElement>("#surface-scroller")!.clientWidth -
      2,
  );
  assert.equal(mobileActiveGutter, 0, "mobile scrollbar stays 0px after tap/hover");
  assert.deepEqual(mobileErrors, [], "zero page errors on mobile");
  await mobile.close();

  console.log(
    "PASS: Indirect Code desktop hover-reveal scrollbars (dark/light, zero layout shift, nested isolation, portals, hidden strips, widget iframe, Gateway & Mobile untouched)",
  );
} finally {
  await browser.close();
  server.stop(true);
}
