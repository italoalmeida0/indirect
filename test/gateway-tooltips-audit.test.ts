import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "..");
const WEB_SRC = path.join(ROOT, "web", "src");

function readWebFile(relPath: string): string {
  return readFileSync(path.join(WEB_SRC, relPath), "utf8");
}

function walkNonIndirectCode(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    if (ent === "indirect-code") continue;
    const full = path.join(dir, ent);
    if (statSync(full).isDirectory()) {
      out.push(...walkNonIndirectCode(full));
    } else if (full.endsWith(".tsx") || full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface JsxAttrHit {
  file: string;
  line: number;
  tag: string;
  attrText: string;
  allAttrs: Record<string, string>;
}

function collectIntrinsicJsxAttrHits(files: string[], attrName: string): JsxAttrHit[] {
  const hits: JsxAttrHit[] = [];
  for (const fullPath of files) {
    const src = readFileSync(fullPath, "utf8");
    const sf = ts.createSourceFile(
      fullPath,
      src,
      ts.ScriptTarget.Latest,
      true,
      fullPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const rel = path.relative(WEB_SRC, fullPath).replaceAll("\\", "/");
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        if (/^[a-z]/.test(tag)) {
          const allAttrs: Record<string, string> = {};
          let matchedProp: ts.JsxAttribute | undefined;
          for (const prop of node.attributes.properties) {
            if (ts.isJsxAttribute(prop)) {
              const name = prop.name.getText(sf);
              allAttrs[name] = prop.getText(sf);
              if (name === attrName) matchedProp = prop;
            }
          }
          if (matchedProp) {
            const { line } = sf.getLineAndCharacterOfPosition(matchedProp.getStart(sf));
            hits.push({
              file: rel,
              line: line + 1,
              tag,
              attrText: matchedProp.getText(sf),
              allAttrs,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("Gateway & Design System custom tooltip audit", () => {
  const allGatewayAndDsFiles = walkNonIndirectCode(WEB_SRC);

  test("zero intrinsic <button> elements carry native HTML title= outside indirect-code", () => {
    const titleHits = collectIntrinsicJsxAttrHits(allGatewayAndDsFiles, "title");
    const buttonHits = titleHits.filter((hit) => hit.tag === "button");
    expect(buttonHits).toEqual([]);
  });

  test("only AnalyticsSummary.tsx preserves native HTML title= for .overview-tokens and .analytics-summary-tokens contracts", () => {
    const titleHits = collectIntrinsicJsxAttrHits(allGatewayAndDsFiles, "title");
    expect(titleHits.map((hit) => `${hit.file}:<${hit.tag}>`)).toEqual([
      "AnalyticsSummary.tsx:<div>",
      "AnalyticsSummary.tsx:<div>",
    ]);

    const dashboardSrc = readWebFile("pages/Dashboard.tsx");
    const summarySrc = readWebFile("AnalyticsSummary.tsx");
    expect(dashboardSrc).toContain('class="overview-tokens ');
    expect(dashboardSrc).toContain("<AnalyticsHero");
    expect(dashboardSrc).toContain("<AnalyticsBucket");
    expect(summarySrc).toContain('class="analytics-summary-tokens ');
  });

  test("studio-controls.tsx uses data-tip + aria-label on all icon-only controls with zero native title=", () => {
    const file = path.join(WEB_SRC, "ds/components/studio-controls.tsx");
    expect(collectIntrinsicJsxAttrHits([file], "title")).toEqual([]);

    const tipHits = collectIntrinsicJsxAttrHits([file], "data-tip");
    const tipTexts = tipHits.map((hit) => hit.attrText);
    expect(tipTexts).toContain('data-tip="Decrease by $5"');
    expect(tipTexts).toContain('data-tip="Increase by $5"');
    expect(tipTexts).toContain('data-tip="Reset to unlimited"');
    expect(tipTexts).toContain('data-tip="Decrease"');
    expect(tipTexts).toContain('data-tip="Increase"');
    expect(tipTexts).toContain('data-tip="Clear all"');
    expect(tipTexts).toContain('data-tip={revealed() ? "Hide secret" : "Reveal secret"}');

    for (const hit of tipHits) {
      expect(hit.tag).toBe("button");
      expect(hit.allAttrs["aria-label"]).toBeDefined();
    }
  });

  test("Dialog/Modal close button and icon-only DS primitives carry data-tip", () => {
    const dialogFile = path.join(WEB_SRC, "ds/components/dialog.tsx");
    const tabsFile = path.join(WEB_SRC, "ds/components/tabs.tsx");
    const toastFile = path.join(WEB_SRC, "ds/components/toast.tsx");
    const calendarFile = path.join(WEB_SRC, "ds/components/calendar.tsx");
    const uiFile = path.join(WEB_SRC, "ui.tsx");

    expect(collectIntrinsicJsxAttrHits([dialogFile, tabsFile, toastFile, calendarFile, uiFile], "title")).toEqual([]);

    const dialogTips = collectIntrinsicJsxAttrHits([dialogFile], "data-tip");
    expect(dialogTips).toHaveLength(1);
    expect(dialogTips[0]?.attrText).toBe('data-tip="Close"');
    expect(dialogTips[0]?.allAttrs["aria-label"]).toBe('aria-label="Close"');

    const copyTips = collectIntrinsicJsxAttrHits([tabsFile], "data-tip");
    expect(copyTips).toHaveLength(1);
    expect(copyTips[0]?.attrText).toContain("props.label ?? \"Copy\"");

    const toastTips = collectIntrinsicJsxAttrHits([toastFile], "data-tip");
    expect(toastTips.map((h) => h.attrText)).toEqual(['data-tip="Dismiss"']);

    const calendarTips = collectIntrinsicJsxAttrHits([calendarFile], "data-tip").map((h) => h.attrText);
    expect(calendarTips).toEqual([
      'data-tip="Previous month"',
      'data-tip="Next month"',
      'data-tip="Previous month"',
      'data-tip="Next month"',
    ]);

    const uiTips = collectIntrinsicJsxAttrHits([uiFile], "data-tip").map((h) => h.attrText);
    expect(uiTips).toContain('data-tip={revealed() ? "Hide password" : "Show password"}');
    expect(uiTips).toContain("data-tip={current().label}");
    expect(uiTips).toContain('data-tip="Remove filter"');
  });

  test("Users.tsx security badges carry both data-tip and aria-label with zero native title=", () => {
    const file = path.join(WEB_SRC, "pages/admin/Users.tsx");
    expect(collectIntrinsicJsxAttrHits([file], "title")).toEqual([]);

    const tipHits = collectIntrinsicJsxAttrHits([file], "data-tip");
    expect(tipHits.map((h) => ({ tag: h.tag, tip: h.attrText, aria: h.allAttrs["aria-label"] }))).toEqual([
      { tag: "span", tip: 'data-tip="Password configured"', aria: 'aria-label="Password configured"' },
      { tag: "span", tip: 'data-tip="Two-factor authentication active"', aria: 'aria-label="Two-factor authentication active"' },
      { tag: "span", tip: 'data-tip="Google account linked"', aria: 'aria-label="Google account linked"' },
    ]);
  });

  test("analytics-filters, AnalyticsCharts, RequestHeatmap, OverviewInsights, Models, Settings, and catalog use data-tip", () => {
    const targetRelPaths = [
      "analytics-filters.tsx",
      "AnalyticsCharts.tsx",
      "RequestHeatmap.tsx",
      "OverviewInsights.tsx",
      "pages/admin/Models.tsx",
      "pages/Settings.tsx",
      "catalog.tsx",
    ];
    for (const rel of targetRelPaths) {
      const full = path.join(WEB_SRC, rel);
      expect(collectIntrinsicJsxAttrHits([full], "title")).toEqual([]);
      expect(collectIntrinsicJsxAttrHits([full], "data-tip").length).toBeGreaterThan(0);
    }

    const modelsTips = collectIntrinsicJsxAttrHits([path.join(WEB_SRC, "pages/admin/Models.tsx")], "data-tip");
    for (const hit of modelsTips) {
      expect(hit.allAttrs["aria-label"]).toBeDefined();
    }
  });
});
