import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { REASONING_LEVELS } from "../web/src/indirect-code/constants";
import {
  EFFORT_SPECS,
  clientXToEffortIndex,
  resolveEffortIndex,
  resolveEffortSpec,
  stepEffortIndex,
} from "../web/src/indirect-code/utils/effortSpec";

describe("EffortPickerBody level specs and geometry helpers", () => {
  test("EFFORT_SPECS covers all 7 canonical REASONING_LEVELS in exact order", () => {
    expect(EFFORT_SPECS.map((s) => s.level)).toEqual([...REASONING_LEVELS]);
    expect(EFFORT_SPECS).toEqual([
      { level: "none", title: "Off", desc: "Responds immediately without extended thinking" },
      { level: "minimum", title: "Min", desc: "Minimal thinking for quick, routine tasks" },
      { level: "low", title: "Low", desc: "Light reasoning for everyday coding tasks" },
      { level: "medium", title: "Medium", desc: "Balances speed and reasoning depth" },
      { level: "high", title: "High", desc: "Thinks harder problems through" },
      { level: "xhigh", title: "X-High", desc: "Deep multi-step reasoning for complex problems" },
      { level: "max", title: "Max", desc: "The slowest and most thorough" },
    ]);
  });

  test("resolveEffortIndex normalizes aliases and defaults unset/unknown to medium (3)", () => {
    expect(resolveEffortIndex("")).toBe(3);
    expect(resolveEffortIndex("   ")).toBe(3);
    expect(resolveEffortIndex("unknown-level")).toBe(3);
    expect(resolveEffortIndex("off")).toBe(0);
    expect(resolveEffortIndex("NONE")).toBe(0);
    expect(resolveEffortIndex("min")).toBe(1);
    expect(resolveEffortIndex("minimum")).toBe(1);
    expect(resolveEffortIndex("low")).toBe(2);
    expect(resolveEffortIndex("med")).toBe(3);
    expect(resolveEffortIndex("medium")).toBe(3);
    expect(resolveEffortIndex("high")).toBe(4);
    expect(resolveEffortIndex("hi")).toBe(4);
    expect(resolveEffortIndex("xhigh")).toBe(5);
    expect(resolveEffortIndex("maximum")).toBe(5);
    expect(resolveEffortIndex("max")).toBe(6);
    expect(resolveEffortSpec("MAX").title).toBe("Max");
  });

  test("clientXToEffortIndex maps track coordinates with 14px thumb-center insets to stops 0..6", () => {
    // Track from left=100, width=328 -> thumb centers span [114..414] (span = 300px, 50px per step)
    const left = 100;
    const width = 328;
    expect(clientXToEffortIndex(80, left, width)).toBe(0);
    expect(clientXToEffortIndex(114, left, width)).toBe(0);
    expect(clientXToEffortIndex(164, left, width)).toBe(1);
    expect(clientXToEffortIndex(214, left, width)).toBe(2);
    expect(clientXToEffortIndex(264, left, width)).toBe(3);
    expect(clientXToEffortIndex(314, left, width)).toBe(4);
    expect(clientXToEffortIndex(364, left, width)).toBe(5);
    expect(clientXToEffortIndex(414, left, width)).toBe(6);
    expect(clientXToEffortIndex(500, left, width)).toBe(6);
    // Midpoint rounding snaps to nearest discrete stop
    expect(clientXToEffortIndex(338, left, width)).toBe(4);
    expect(clientXToEffortIndex(340, left, width)).toBe(5);
  });

  test("stepEffortIndex handles keyboard navigation and clamps to bounds", () => {
    expect(stepEffortIndex(0, "ArrowLeft")).toBe(0);
    expect(stepEffortIndex(0, "ArrowDown")).toBe(0);
    expect(stepEffortIndex(4, "ArrowLeft")).toBe(3);
    expect(stepEffortIndex(4, "ArrowDown")).toBe(3);
    expect(stepEffortIndex(4, "ArrowRight")).toBe(5);
    expect(stepEffortIndex(4, "ArrowUp")).toBe(5);
    expect(stepEffortIndex(6, "ArrowRight")).toBe(6);
    expect(stepEffortIndex(6, "ArrowUp")).toBe(6);
    expect(stepEffortIndex(4, "Home")).toBe(0);
    expect(stepEffortIndex(2, "End")).toBe(6);
    expect(stepEffortIndex(3, "Escape")).toBeNull();
    expect(stepEffortIndex(3, "Tab")).toBeNull();
  });
});

describe("Separated Effort & Model picker contracts", () => {
  const root = path.join(import.meta.dir, "..");
  const effortSrc = readFileSync(
    path.join(root, "web/src/indirect-code/components/EffortPickerBody.tsx"),
    "utf8",
  );
  const modelBodySrc = readFileSync(
    path.join(root, "web/src/indirect-code/components/ModelPickerBody.tsx"),
    "utf8",
  );
  const toolbarModelSrc = readFileSync(
    path.join(root, "web/src/indirect-code/components/composer/ToolbarModel.tsx"),
    "utf8",
  );
  const toolbarCtxSrc = readFileSync(
    path.join(root, "web/src/indirect-code/components/composer/ToolbarContext.tsx"),
    "utf8",
  );
  const pageSrc = readFileSync(
    path.join(root, "web/src/indirect-code/IndirectCodePage.tsx"),
    "utf8",
  );

  test("EffortPickerBody omits 'Let Muse decide', wires top-right model trigger, stops arrow bubbling, and uses user accent tokens", () => {
    expect(effortSrc).not.toContain("Muse");
    expect(effortSrc).not.toContain("tone-sky");
    expect(effortSrc).toContain("aria-label={`Select model: ${props.activeModelName()}`}");
    expect(effortSrc).toContain('role="slider"');
    expect(effortSrc).toContain("e.stopPropagation()");
    expect(effortSrc).toContain("setPointerCapture");
    expect(effortSrc).toContain("text-accent");
    expect(effortSrc).toContain("var(--accent)");
    expect(effortSrc).toContain('attributeFilter: ["data-theme", "data-accent"]');
    expect(effortSrc).toContain("reducedMotion");
  });

  test("EffortPickerBody uses corner-safe rounded-[inherit] layering, single topmost ring, and canvas corner guard", () => {
    expect(effortSrc).toContain("rounded-[10px] overflow-hidden isolate");
    expect(effortSrc).toContain("isCellInsideRoundedTrack");
    expect(effortSrc).toContain("const cornerRadius = 10;");
    expect(effortSrc).toContain("const margin = 2.5;");
    expect(effortSrc).toContain("data-effort-track-ring");

    const inheritedMatches = effortSrc.match(/rounded-\[inherit\]/g) ?? [];
    expect(inheritedMatches.length).toBeGreaterThanOrEqual(4);

    // Topmost hairline ring must sit after the canvas and before the thumb
    const canvasPos = effortSrc.indexOf("<canvas");
    const ringPos = effortSrc.indexOf("data-effort-track-ring");
    const thumbPos = effortSrc.indexOf("data-effort-thumb");
    expect(canvasPos).toBeGreaterThan(0);
    expect(ringPos).toBeGreaterThan(canvasPos);
    expect(thumbPos).toBeGreaterThan(ringPos);
  });

  test("ToolbarModel and mobile + menu highlight Max effort with selected accent instead of fixed sky", () => {
    expect(toolbarModelSrc).not.toContain("tone-sky");
    expect(toolbarModelSrc).toContain("border-accent/35 bg-accent-subtle text-accent");
    expect(toolbarCtxSrc).not.toContain("text-tone-sky font-medium");
    expect(toolbarCtxSrc).toContain('normalizeEffort(c.effort()) === "max"\n                    ? "text-accent font-medium"');
  });

  test("ModelPickerBody has no bottom Reasoning effort footer", () => {
    expect(modelBodySrc).not.toContain("Reasoning effort");
    expect(modelBodySrc).not.toContain("REASONING_LEVELS");
    expect(modelBodySrc).not.toContain("data-effort-meter");
  });

  test("ToolbarModel opens Effort popover first and mounts separated Effort and Model FloatMenus", () => {
    expect(toolbarModelSrc).toContain("ui.setEffortMenuOpen(true)");
    expect(toolbarModelSrc).toContain('aria-label="Reasoning effort"');
    expect(toolbarModelSrc).toContain('aria-label="Select model"');
    expect(toolbarModelSrc).toContain("{c.effortPickerBody()}");
    expect(toolbarModelSrc).toContain("{c.modelPickerBody(true)}");
  });

  test("Mobile + menu opens Effort subview first, transitions to Select model, and returns to Effort on Back", () => {
    expect(toolbarCtxSrc).toContain('switchSubView("effort")');
    expect(toolbarCtxSrc).toContain('c.effortPickerBody(() => switchSubView("model"))');
    expect(toolbarCtxSrc).toContain('<Show when={subView() === "effort"}>');
  });

  test("IndirectCodePage closeMenus closes both effortMenuOpen and modelMenuOpen", () => {
    expect(pageSrc).toContain("setEffortMenuOpen(false)");
    expect(pageSrc).toContain("setModelMenuOpen(false)");
  });

  test("ComposerInput starts compact on 1 line (min-h-9) and grows dynamically up to 160px", () => {
    const inputSrc = readFileSync(
      path.join(import.meta.dir, "../web/src/indirect-code/components/composer/ComposerInput.tsx"),
      "utf8",
    );
    expect(inputSrc).toContain("rows={1}");
    expect(inputSrc).toContain("min-h-9");
    expect(inputSrc).not.toContain("min-h-[56px]");
    expect(inputSrc).toContain("Math.min(sh, 160)");
  });

  test("Composer and .rc-composer-toolbar form a unified borderless surface", () => {
    const dsCss = readFileSync(
      path.join(import.meta.dir, "../web/src/ds/components.css"),
      "utf8",
    );
    const codeCss = readFileSync(
      path.join(import.meta.dir, "../web/src/styles/code.css"),
      "utf8",
    );
    const composerSrc = readFileSync(
      path.join(import.meta.dir, "../web/src/indirect-code/components/Composer.tsx"),
      "utf8",
    );
    const toolbarMatch = dsCss.match(/\.rc-composer-toolbar\s*\{([^}]*)\}/);
    expect(toolbarMatch).not.toBeNull();
    expect(toolbarMatch![1]).not.toContain("border-top");
    expect(toolbarMatch![1]).toContain("background: transparent");
    expect(codeCss).not.toMatch(/\.rc-composer-toolbar\s*\{[^}]*border-top/);
    expect(composerSrc).toContain('class="rc-composer-toolbar flex items-center justify-between gap-2 px-2.5 pt-1 pb-2.5"');
  });
});
