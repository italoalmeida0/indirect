import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { springCurve } from "../web/src/ds/motion/animate";
import { motionTokens } from "../web/src/ds/motion/tokens";
import { rovingIndex } from "../web/src/ds/primitives/a11y";

describe("design-system springs", () => {
  test("critically damped tokens never overshoot and settle exactly at 1", () => {
    for (const spring of [motionTokens.spring.snappy, motionTokens.spring.smooth, motionTokens.spring.morph]) {
      const curve = springCurve(spring);
      expect(curve.points[0]).toBe(0);
      expect(curve.points.at(-1)).toBe(1);
      for (let i = 1; i < curve.points.length; i++) {
        expect(curve.points[i]!).toBeGreaterThanOrEqual(curve.points[i - 1]!);
        expect(curve.points[i]!).toBeLessThanOrEqual(1);
      }
    }
  });

  test("perceived duration orders snappy < smooth <= morph and stays under a second", () => {
    const snappy = springCurve(motionTokens.spring.snappy).duration;
    const smooth = springCurve(motionTokens.spring.smooth).duration;
    const morph = springCurve(motionTokens.spring.morph).duration;
    expect(snappy).toBeLessThan(smooth);
    expect(smooth).toBeLessThanOrEqual(morph);
    expect(morph).toBeLessThan(1);
  });

  test("a playful spring overshoots, a state spring does not", () => {
    const playful = springCurve(motionTokens.spring.playful);
    expect(Math.max(...playful.points)).toBeGreaterThan(1);
    expect(Math.max(...springCurve(motionTokens.spring.smooth).points)).toBe(1);
  });

  test("curves are cached per spring shape", () => {
    expect(springCurve(motionTokens.spring.smooth)).toBe(springCurve({ visualDuration: motionTokens.spring.smooth.visualDuration, bounce: 0 }));
  });
});

describe("roving focus", () => {
  test("arrow keys move and wrap", () => {
    expect(rovingIndex("ArrowRight", 0, 3)).toBe(1);
    expect(rovingIndex("ArrowRight", 2, 3)).toBe(0);
    expect(rovingIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  test("Home and End jump to the edges and skip disabled items", () => {
    const disabled = (index: number) => index === 0 || index === 3;
    expect(rovingIndex("Home", 2, 4, disabled)).toBe(1);
    expect(rovingIndex("End", 1, 4, disabled)).toBe(2);
  });

  test("orientation filters keys and non-navigation keys return undefined", () => {
    expect(rovingIndex("ArrowDown", 0, 3, undefined, { orientation: "horizontal" })).toBeUndefined();
    expect(rovingIndex("ArrowDown", 0, 3, undefined, { orientation: "vertical" })).toBe(1);
    expect(rovingIndex("Enter", 0, 3)).toBeUndefined();
  });

  test("without loop the edges hold", () => {
    expect(rovingIndex("ArrowRight", 2, 3, undefined, { loop: false })).toBe(2);
  });
});

describe("design-system warning/amber tokens", () => {
  const tokensCss = readFileSync(path.join(import.meta.dir, "..", "web/src/ds/tokens.css"), "utf8");

  function extractBlock(selector: string): string {
    const start = tokensCss.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = tokensCss.indexOf("{", start);
    const close = tokensCss.indexOf("}", open);
    return tokensCss.slice(open + 1, close);
  }

  function parseOklch(block: string, varName: string): [number, number, number] {
    const m = block.match(new RegExp(`${varName}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\);`));
    if (!m) throw new Error(`Missing oklch declaration for ${varName}`);
    return [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
  }

  function oklchToRgb255([L, C, hDeg]: [number, number, number]): [number, number, number] {
    const h = (hDeg * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return lin.map((c) => {
      const cl = Math.max(0, Math.min(1, c));
      const srgb = cl <= 0.0031308 ? 12.92 * cl : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
      return Math.round(srgb * 255);
    }) as [number, number, number];
  }

  function relLum([r, g, b]: [number, number, number]): number {
    const ch = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  }

  function contrast(a: [number, number, number], b: [number, number, number]): number {
    const l1 = relLum(a);
    const l2 = relLum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  test("preserves light and high-contrast --tone-amber while keeping dark-mode --warning calm and WCAG AA legible", () => {
    const light = extractBlock(":root");
    const dark = extractBlock(':root[data-theme="dark"]');
    const hc = extractBlock(':root[data-theme="high-contrast"]');

    expect(light).toContain("--tone-amber: oklch(55% 0.12 68);");
    expect(hc).toContain("--tone-amber: #ffd166;");

    const darkAmber = parseOklch(dark, "--tone-amber");
    const darkTextSecondary = parseOklch(dark, "--text-secondary");
    expect(darkAmber[0]).toBeLessThan(darkTextSecondary[0]);
    expect(dark).toContain("--warning-subtle: color-mix(in oklab, var(--warning) 13%, transparent);");

    const warnRgb = oklchToRgb255(darkAmber);
    const bgRgb = oklchToRgb255(parseOklch(dark, "--background"));
    const surfRgb = oklchToRgb255(parseOklch(dark, "--surface"));
    const surfRaisedRgb = oklchToRgb255(parseOklch(dark, "--surface-raised"));
    const surfMutedRgb = oklchToRgb255(parseOklch(dark, "--surface-muted"));
    const subtleOnSurf: [number, number, number] = [
      Math.round(warnRgb[0] * 0.13 + surfRgb[0] * 0.87),
      Math.round(warnRgb[1] * 0.13 + surfRgb[1] * 0.87),
      Math.round(warnRgb[2] * 0.13 + surfRgb[2] * 0.87),
    ];

    for (const surface of [bgRgb, surfRgb, surfRaisedRgb, surfMutedRgb, subtleOnSurf]) {
      expect(contrast(warnRgb, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
