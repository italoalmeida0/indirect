#!/usr/bin/env bun
// Automated visual + behavioral Playwright gate for Indirect Code desktop
// two-stage animated scrollbars (12px fixed rail, 0px idle -> 6px container
// hover -> smooth 10px rail-hover/drag thickening with 0px layout shift),
// Portal scoping, nested scroller isolation, intentional hidden scrollbars,
// Generative UI widget iframes, transcript tool aggregate click padding,
// Gateway non-regression, and Mobile zero-scrollbar preservation.
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

  const SETTLE_MS = 220;
  const parkMouseIdle = async () => {
    await desktop.mouse.move(1270, 10);
    await desktop.waitForTimeout(SETTLE_MS);
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

  // Helper to inspect 12px vertical scrollbar rail, inner child geometry & horizontal pixel profile
  const measureVerticalRail = async (selector: string, sampleYOffset?: number) => {
    const m = await desktop.evaluate((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const borderRight = parseFloat(cs.borderRightWidth) || 0;
      const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const cornerRadius = parseFloat(cs.borderTopRightRadius) || 0;
      const innerChild = el.querySelector<HTMLElement>(":scope > [data-inner-box]");
      const innerRect = innerChild?.getBoundingClientRect();
      return {
        offsetWidth: el.offsetWidth,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        scrollTop: el.scrollTop,
        gutterWidth: Math.round(el.offsetWidth - el.clientWidth - borderLeft - borderRight),
        innerX: innerRect ? innerRect.x : null,
        innerWidth: innerRect ? innerRect.width : null,
        inlineThumb: el.style.getPropertyValue("--rc-scrollbar-thumb"),
        inlinePad: el.style.getPropertyValue("--rc-sb-pad"),
        outsideAppShell: !el.closest(".rc-app-shell") && el.parentElement?.parentElement === document.body,
        railLeft: Math.round(r.right - borderRight - 12),
        top: Math.round(r.top + borderTop),
        sampleOffsetY: Math.max(16, Math.ceil(cornerRadius) + 6),
        height: el.clientHeight,
        interiorX: Math.round(r.left + Math.min(48, r.width * 0.3)),
        interiorY: Math.round(r.top + Math.min(48, r.height * 0.35)),
      };
    }, selector);

    // Sample a 16px wide strip ending at the inner right border:
    // dx = 0..3 is 4px container interior right before the 12px rail,
    // dx = 4..15 is the 12px scrollbar rail (railDx = 0..11):
    //   - 6px pill (pad=3px): railDx 0..2 transparent, railDx 3..8 (dx 7..12) thumb, railDx 9..11 transparent
    //   - 8px pill (pad=2px): railDx 0..1 transparent, railDx 2..9 (dx 6..13) thumb, railDx 10..11 transparent
    //   - 10px pill (pad=1px): railDx 0 transparent, railDx 1..10 (dx 5..14) thumb, railDx 11 transparent
    const yOff = sampleYOffset ?? m.sampleOffsetY;
    const strip = await readClipPixels(desktop, {
      x: m.railLeft - 4,
      y: m.top + yOff,
      width: 16,
      height: 6,
    });
    const bgSample = strip.rgbAt(1, 3);
    const thumbCenterSample = strip.rgbAt(9, 3); // railDx = 5 (center of 12px rail)
    let maxRailDiffFromBg = 0;
    for (let dy = 0; dy < 6; dy++) {
      for (let dx = 4; dx < 16; dx++) {
        maxRailDiffFromBg = Math.max(maxRailDiffFromBg, colorDist(strip.rgbAt(dx, dy), bgSample));
      }
    }
    const railDiffs: number[] = [];
    for (let railDx = 0; railDx < 12; railDx++) {
      railDiffs.push(colorDist(strip.rgbAt(4 + railDx, 3), bgSample));
    }
    const visiblePillWidth = railDiffs.filter((d) => d >= 8).length;
    return {
      ...m,
      bgSample,
      thumbSample: thumbCenterSample,
      railDiffs,
      visiblePillWidth,
      maxRailDiffFromBg,
      thumbContrast: colorDist(thumbCenterSample, bgSample),
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
        idle.gutterWidth,
        12,
        `[${theme}] ${selector}: reserves fixed 12px scrollbar gutter when idle`,
      );
      assert.equal(
        idle.maxRailDiffFromBg,
        0,
        `[${theme}] ${selector}: idle scrollbar rail is 100% invisible with zero border halo (bg=${idle.bgSample}, thumb=${idle.thumbSample})`,
      );
      assert.equal(idle.inlineThumb, "", `[${theme}] ${selector}: no inline --rc-scrollbar-thumb when idle`);
      assert.equal(idle.inlinePad, "", `[${theme}] ${selector}: no inline --rc-sb-pad when idle`);

      // Hover container interior -> reveal 6px pill thumb, 0px layout shift
      await desktop.mouse.move(idle.interiorX, idle.interiorY);
      await desktop.waitForTimeout(SETTLE_MS);
      const hovered = await measureVerticalRail(selector);
      assert.equal(
        hovered.clientWidth,
        idle.clientWidth,
        `[${theme}] ${selector}: zero clientWidth shift on interior hover`,
      );
      assert.equal(
        hovered.scrollWidth,
        idle.scrollWidth,
        `[${theme}] ${selector}: zero scrollWidth shift on interior hover`,
      );
      assert.equal(
        hovered.innerX,
        idle.innerX,
        `[${theme}] ${selector}: zero inner child x shift on interior hover`,
      );
      assert.equal(
        hovered.innerWidth,
        idle.innerWidth,
        `[${theme}] ${selector}: zero inner child width shift on interior hover`,
      );
      assert(
        hovered.thumbContrast >= 20,
        `[${theme}] ${selector}: hovered container reveals visible scrollbar thumb (bg=${hovered.bgSample}, thumb=${hovered.thumbSample})`,
      );
      assert.equal(
        hovered.visiblePillWidth,
        6,
        `[${theme}] ${selector}: interior container hover settles to 6px pill (railDiffs=${hovered.railDiffs.join(",")})`,
      );
      assert.equal(hovered.railDiffs[0], 0, `[${theme}] ${selector}: 3px left transparent inset [0]`);
      assert.equal(hovered.railDiffs[2], 0, `[${theme}] ${selector}: 3px left transparent inset [2]`);
      assert.equal(hovered.railDiffs[9], 0, `[${theme}] ${selector}: 3px right transparent inset [9]`);
      assert.equal(hovered.railDiffs[11], 0, `[${theme}] ${selector}: 3px right transparent inset [11]`);

      // Unhover -> zero layout shift, fades back to 100% invisible & removes inline vars
      await parkMouseIdle();
      const unhovered = await measureVerticalRail(selector);
      assert.equal(unhovered.clientWidth, idle.clientWidth, `[${theme}] ${selector}: zero clientWidth shift after unhover`);
      assert.equal(unhovered.innerX, idle.innerX, `[${theme}] ${selector}: zero inner child x shift after unhover`);
      assert.equal(unhovered.innerWidth, idle.innerWidth, `[${theme}] ${selector}: zero inner child width shift after unhover`);
      assert.equal(unhovered.maxRailDiffFromBg, 0, `[${theme}] ${selector}: hides back to 100% invisible after unhover`);
      assert.equal(unhovered.inlineThumb, "", `[${theme}] ${selector}: cleans up inline --rc-scrollbar-thumb after fade-out`);
      assert.equal(unhovered.inlinePad, "", `[${theme}] ${selector}: cleans up inline --rc-sb-pad after fade-out`);
    }
  }

  // Verify zero idle rAF loop once animations have settled
  {
    await parkMouseIdle();
    const idleRafCount = await desktop.evaluate(async () => {
      let count = 0;
      const orig = window.requestAnimationFrame;
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        count += 1;
        return orig(cb);
      }) as typeof window.requestAnimationFrame;
      try {
        await new Promise((r) => setTimeout(r, 120));
        return count;
      } finally {
        window.requestAnimationFrame = orig;
      }
    });
    assert.equal(idleRafCount, 0, `zero idle requestAnimationFrame ticks when settled (got ${idleRafCount})`);
  }

  const screenshotDir = process.env.SCROLLBAR_SCREENSHOT_DIR || "";
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

  // Restore dark theme for remaining desktop behavioral checks
  await desktop.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await parkMouseIdle();
  if (screenshotDir) {
    await desktop.screenshot({ path: path.join(screenshotDir, "01-desktop-dark-idle.png") });
  }

  // --- 1c. Smooth Animated Thickening (6px -> intermediate 8px -> 10px) + Active Drag ---
  {
    const idle = await measureVerticalRail("#surface-scroller");
    await desktop.mouse.move(idle.interiorX, idle.interiorY);
    await desktop.waitForTimeout(SETTLE_MS);
    const containerHover = await measureVerticalRail("#surface-scroller");
    assert.equal(containerHover.visiblePillWidth, 6, "starts at 6px pill on container interior hover");
    if (screenshotDir) {
      await desktop.screenshot({ path: path.join(screenshotDir, "02-desktop-dark-center-6px.png") });
    }

    // Move into the <=16px scrollbar rail zone and sample immediately during the 150ms tween
    // to prove intermediate painted width (> 6px and < 10px) AND zero inner shift mid-tween!
    const thumbX = containerHover.railLeft + 6;
    const thumbY = containerHover.top + 22;
    await desktop.mouse.move(thumbX, thumbY);

    const midWidths: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const mid = await measureVerticalRail("#surface-scroller");
      assert.equal(mid.clientWidth, idle.clientWidth, "zero clientWidth shift mid-tween");
      assert.equal(mid.innerX, idle.innerX, "zero inner child x shift mid-tween");
      assert.equal(mid.innerWidth, idle.innerWidth, "zero inner child width shift mid-tween");
      midWidths.push(mid.visiblePillWidth);
      if (mid.visiblePillWidth > 6 && mid.visiblePillWidth < 10) {
        break;
      }
      await desktop.waitForTimeout(8);
    }
    assert(
      midWidths.some((w) => w > 6 && w < 10),
      `scrollbar smoothly paints intermediate thickness (>6px and <10px) during 150ms rail-hover tween (sampled widths=${midWidths.join(",")})`,
    );

    // Wait for tween to settle at 10px thick pill
    await desktop.waitForTimeout(SETTLE_MS);
    const railHover = await measureVerticalRail("#surface-scroller");
    if (screenshotDir) {
      await desktop.screenshot({ path: path.join(screenshotDir, "03-desktop-dark-rail-10px.png") });
    }
    assert.equal(railHover.visiblePillWidth, 10, `rail hover settles at 10px thick pill (railDiffs=${railHover.railDiffs.join(",")})`);
    assert.equal(railHover.railDiffs[0], 0, "10px pill keeps 1px transparent left inset");
    assert.equal(railHover.railDiffs[11], 0, "10px pill keeps 1px transparent right inset");
    assert(
      colorDist(railHover.thumbSample, containerHover.thumbSample) >= 15,
      `rail hover uses higher-contrast --text-muted (${railHover.thumbSample} vs ${containerHover.thumbSample})`,
    );
    assert.equal(railHover.clientWidth, idle.clientWidth, "zero clientWidth shift on 10px rail hover");
    assert.equal(railHover.innerX, idle.innerX, "zero inner child x shift on 10px rail hover");
    assert.equal(railHover.innerWidth, idle.innerWidth, "zero inner child width shift on 10px rail hover");

    // Drag thumb while moving pointer outside #surface-scroller horizontally (+36px past right edge)
    await desktop.mouse.down();
    await desktop.mouse.move(thumbX + 36, thumbY + 45, { steps: 8 });
    await desktop.waitForTimeout(40);
    const scrolled = await desktop.evaluate(
      () => document.querySelector<HTMLElement>("#surface-scroller")!.scrollTop,
    );
    assert(scrolled > 0, `dragging scrollbar thumb scrolls container (scrollTop=${scrolled})`);

    // Sample where the thumb moved during active drag while pointer is outside
    const activeDrag = await measureVerticalRail("#surface-scroller", 65);
    assert.equal(
      activeDrag.visiblePillWidth,
      10,
      `active thumb drag stays 10px thick even when pointer drifts outside container (railDiffs=${activeDrag.railDiffs.join(",")})`,
    );
    assert(
      activeDrag.thumbContrast >= 35,
      `thumb :active remains visibly highlighted mid-drag outside container (bg=${activeDrag.bgSample}, thumb=${activeDrag.thumbSample})`,
    );
    assert.equal(activeDrag.clientWidth, idle.clientWidth, "zero clientWidth shift during active drag");
    assert.equal(activeDrag.innerX, idle.innerX, "zero inner child x shift during active drag");
    assert.equal(activeDrag.innerWidth, idle.innerWidth, "zero inner child width shift during active drag");

    await desktop.mouse.up();
    await desktop.waitForTimeout(SETTLE_MS);
    const afterRelease = await measureVerticalRail("#surface-scroller", 65);
    assert.equal(
      afterRelease.maxRailDiffFromBg,
      0,
      "releasing mouse outside container smoothly fades out to 0 visible pixels",
    );
    assert.equal(afterRelease.inlineThumb, "", "inline --rc-scrollbar-thumb cleaned up after drag release outside");
    assert.equal(afterRelease.inlinePad, "", "inline --rc-sb-pad cleaned up after drag release outside");
    assert.equal(afterRelease.innerX, idle.innerX, "zero inner child x shift after release");
    assert.equal(afterRelease.innerWidth, idle.innerWidth, "zero inner child width shift after release");

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

    // Hover outer .transcript's rail -> outer thickens to 10px while nested <pre> stays 100% invisible (0px leak!)
    await desktop.mouse.move(idleOuter.railLeft + 6, idleOuter.top + 22);
    await desktop.waitForTimeout(SETTLE_MS);
    const outerOnRail = await measureVerticalRail("#transcript-scroller");
    const innerWhenOuterRailHovered = await measureVerticalRail("#nested-pre");
    assert.equal(outerOnRail.visiblePillWidth, 10, "outer .transcript rail hover thickens to 10px");
    assert.equal(
      innerWhenOuterRailHovered.maxRailDiffFromBg,
      0,
      "outer .transcript inline --rc-scrollbar-thumb / --rc-sb-pad NEVER leaks into unhovered nested <pre>",
    );

    // Hover <p> inside .transcript (sibling of <pre>)
    await desktop.hover("#transcript-para");
    await desktop.waitForTimeout(SETTLE_MS);
    const outerWhenParaHovered = await measureVerticalRail("#transcript-scroller");
    const innerWhenParaHovered = await measureVerticalRail("#nested-pre");
    assert.equal(
      outerWhenParaHovered.visiblePillWidth,
      6,
      "hovering <p> in .transcript reveals .transcript's own 6px scrollbar",
    );
    assert.equal(
      innerWhenParaHovered.maxRailDiffFromBg,
      0,
      "hovering <p> in .transcript does NOT reveal sibling nested <pre> scrollbar",
    );

    // Hover nested <pre> interior -> <pre> gets 6px pill, outer stays 6px pill
    const preBox = await desktop.locator("#nested-pre").boundingBox();
    assert(preBox, "#nested-pre bounding box");
    await desktop.mouse.move(Math.round(preBox.x + 40), Math.round(preBox.y + 30));
    await desktop.waitForTimeout(SETTLE_MS);
    const innerWhenPreHovered = await measureVerticalRail("#nested-pre");
    assert.equal(
      innerWhenPreHovered.visiblePillWidth,
      6,
      "hovering nested <pre> interior reveals <pre>'s 6px scrollbar",
    );
    assert.equal(
      innerWhenPreHovered.clientWidth,
      idleInner.clientWidth,
      "nested <pre> has zero clientWidth layout shift on hover",
    );
    assert.equal(
      innerWhenPreHovered.innerX,
      idleInner.innerX,
      "nested <pre> inner <code> has zero x shift on hover",
    );
    if (screenshotDir) {
      await desktop.screenshot({ path: path.join(screenshotDir, "04-desktop-dark-nested-hover.png") });
    }
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
      idlePortal.gutterWidth,
      12,
      `${portalSel}: reserves fixed 12px scrollbar gutter`,
    );
    assert.equal(
      idlePortal.maxRailDiffFromBg,
      0,
      `${portalSel}: idle scrollbar over --surface-raised is 100% invisible (zero --background halo)`,
    );

    await desktop.mouse.move(idlePortal.interiorX, idlePortal.interiorY);
    await desktop.waitForTimeout(SETTLE_MS);
    const hoveredPortal = await measureVerticalRail(portalSel);
    assert.equal(
      hoveredPortal.visiblePillWidth,
      6,
      `${portalSel}: hovering portaled overlay interior reveals 6px pill`,
    );
    assert.equal(hoveredPortal.clientWidth, idlePortal.clientWidth, `${portalSel}: zero layout shift on hover`);
    assert.equal(hoveredPortal.innerWidth, idlePortal.innerWidth, `${portalSel}: zero inner child width shift on hover`);

    await desktop.mouse.move(idlePortal.railLeft + 6, idlePortal.top + 22);
    await desktop.waitForTimeout(SETTLE_MS);
    const railPortal = await measureVerticalRail(portalSel);
    assert.equal(railPortal.visiblePillWidth, 10, `${portalSel}: rail hover thickens to 10px pill`);
    assert.equal(railPortal.innerWidth, idlePortal.innerWidth, `${portalSel}: zero inner child width shift on 10px rail hover`);
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
    await desktop.waitForTimeout(SETTLE_MS);
    const during = await desktop.evaluate((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const cs = getComputedStyle(el);
      const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      return {
        scrollbarHeight: Math.round(el.offsetHeight - el.clientHeight - borderY),
        inlineThumb: el.style.getPropertyValue("--rc-scrollbar-thumb"),
        inlinePad: el.style.getPropertyValue("--rc-sb-pad"),
      };
    }, hiddenSel);
    assert.equal(during.scrollbarHeight, 0, `${hiddenSel} keeps scrollbar completely hidden on :hover`);
    assert.equal(during.inlineThumb, "", `${hiddenSel} is untouched by JS scrollbar controller`);
    assert.equal(during.inlinePad, "", `${hiddenSel} has no inline --rc-sb-pad`);
  }

  // --- 1g. Generative UI widget iframe (WIDGET_BASE_CSS: 12px rail, 6px -> 10px) ---
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
      const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const inner = el.querySelector<HTMLElement>("#gu-inner")!.getBoundingClientRect();
      return {
        gutter: Math.round(el.offsetWidth - el.clientWidth - borderLeft - borderRight),
        clientWidth: el.clientWidth,
        width: r.width,
        innerWidth: inner.width,
        railLeft: Math.round(r.right - borderRight - 12),
        top: Math.round(r.top + borderTop),
      };
    });
    assert.equal(
      guMetrics.gutter,
      12,
      "Generative UI widget iframe scroller uses 12px desktop scrollbar gutter",
    );

    const sampleIframeRail = async () => {
      const strip = await readClipPixels(desktop, {
        x: Math.round(iframeBox.x + 1 + guMetrics.railLeft - 4),
        y: Math.round(iframeBox.y + 1 + guMetrics.top + 18),
        width: 16,
        height: 6,
      });
      const bg = strip.rgbAt(1, 3);
      const thumb = strip.rgbAt(9, 3);
      const diffs: number[] = [];
      for (let rx = 0; rx < 12; rx++) {
        diffs.push(colorDist(strip.rgbAt(4 + rx, 3), bg));
      }
      return {
        bg,
        thumb,
        contrast: colorDist(thumb, bg),
        visibleWidth: diffs.filter((d) => d >= 8).length,
      };
    };

    const guIdle = await sampleIframeRail();
    assert.equal(guIdle.contrast, 0, "Generative UI widget scrollbar is 100% invisible when idle");

    await frame.locator("#gu-scroller").hover({ position: { x: 40, y: 30 } });
    await desktop.waitForTimeout(80);
    const guHover = await sampleIframeRail();
    assert.equal(
      guHover.visibleWidth,
      6,
      `Generative UI widget scrollbar reveals 6px pill on container hover (bg=${guHover.bg}, thumb=${guHover.thumb})`,
    );

    await frame.locator("#gu-scroller").hover({ position: { x: Math.round(guMetrics.width - 6), y: 20 } });
    await desktop.waitForTimeout(80);
    const guThumbHover = await sampleIframeRail();
    assert.equal(
      guThumbHover.visibleWidth,
      10,
      "Generative UI widget scrollbar thickens to 10px pill on thumb :hover",
    );
    const guAfterLayout = await frame.locator("#gu-scroller").evaluate((el: HTMLElement) => ({
      clientWidth: el.clientWidth,
      innerWidth: el.querySelector<HTMLElement>("#gu-inner")!.getBoundingClientRect().width,
    }));
    assert.equal(guAfterLayout.clientWidth, guMetrics.clientWidth, "Generative UI widget scroller has zero clientWidth shift");
    assert.equal(guAfterLayout.innerWidth, guMetrics.innerWidth, "Generative UI widget scroller has zero innerWidth shift");
  }

  // --- 1h. Transcript Tool Aggregate (`[data-step-rail-header]`) click padding ---
  {
    await parkMouseIdle();
    const railHeader = desktop.locator("[data-step-rail-header]");
    await railHeader.waitFor({ state: "visible" });
    const headerInfo = await railHeader.evaluate((btn: HTMLElement) => {
      const r = btn.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      const pyClasses = btn.className.split(/\s+/).filter((c) => /^py-/.test(c));
      return {
        height: r.height,
        paddingTop: parseFloat(cs.paddingTop),
        paddingBottom: parseFloat(cs.paddingBottom),
        pyClasses,
        ariaExpanded: btn.getAttribute("aria-expanded"),
      };
    });
    assert(
      headerInfo.height >= 27,
      `[data-step-rail-header] has comfortable >=27px click height (got ${headerInfo.height}px)`,
    );
    assert.equal(headerInfo.paddingTop, 6, "[data-step-rail-header] has 6px top padding (py-1.5)");
    assert.equal(headerInfo.paddingBottom, 6, "[data-step-rail-header] has 6px bottom padding (py-1.5)");
    assert.deepEqual(
      headerInfo.pyClasses,
      ["py-1.5"],
      `[data-step-rail-header] carries exactly one py-* class (got ${headerInfo.pyClasses.join(",")})`,
    );
    assert.equal(headerInfo.ariaExpanded, "false", "finished turn aggregate starts collapsed");

    // Expand aggregate and verify inner sub-group / thinking DisclosureTriggers use clean py-1 (24px)
    await railHeader.click();
    await desktop.waitForTimeout(60);
    const innerTriggers = await desktop.evaluate(() => {
      const host = document.querySelector("#turn-aggregate-host")!;
      const buttons = Array.from(
        host.querySelectorAll<HTMLButtonElement>("button.group\\/disc:not([data-step-rail-header])"),
      );
      return buttons.map((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return {
          text: b.textContent?.trim() || "",
          height: r.height,
          paddingTop: parseFloat(cs.paddingTop),
          paddingBottom: parseFloat(cs.paddingBottom),
          pyClasses: b.className.split(/\s+/).filter((c) => /^py-/.test(c)),
        };
      });
    });
    assert(innerTriggers.length >= 2, `found inner thinking + tool sub-group DisclosureTriggers (got ${innerTriggers.length})`);
    for (const trig of innerTriggers) {
      assert(trig.height >= 23, `inner DisclosureTrigger "${trig.text}" has >=23px height (got ${trig.height}px)`);
      assert.equal(trig.paddingTop, 4, `inner DisclosureTrigger "${trig.text}" has 4px top padding (py-1)`);
      assert.equal(trig.paddingBottom, 4, `inner DisclosureTrigger "${trig.text}" has 4px bottom padding (py-1)`);
      assert.deepEqual(trig.pyClasses, ["py-1"], `inner DisclosureTrigger "${trig.text}" has single py-1 class`);
    }
    if (screenshotDir) {
      await desktop.screenshot({ path: path.join(screenshotDir, "05-desktop-dark-tool-aggregate-expanded.png") });
    }
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
  await mobile.waitForTimeout(60);
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
    "PASS: Indirect Code desktop two-stage animated scrollbars (12px rail, 0px -> 6px -> 8px -> 10px, zero layout shift, nested isolation, portals, hidden strips, widget iframe, tool aggregate padding, Gateway & Mobile untouched)",
  );
} finally {
  await browser.close();
  server.stop(true);
}
