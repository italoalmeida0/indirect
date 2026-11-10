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
