import { describe, expect, test } from "bun:test";

import { parseGenerativeUiDsl, hasWidgetBody } from "../web/src/indirect-code/components/generative-ui/dsl";
import { compileJsxModule } from "../web/src/indirect-code/components/generative-ui/jsx-compile";
import {
  buildJsxModelScript,
  buildWidgetDocument,
} from "../web/src/indirect-code/components/generative-ui/widget-doc";
import { REACT_RUNTIME_JS } from "../web/src/indirect-code/components/generative-ui/react-runtime";
import { handleGenUiRoute } from "../server/routes/gen-ui";

/**
 * Generative UI React format (`@jsx`) — the new widget path. The HTML/CSS/JS
 * DSL stays exactly as it was (covered by test/indirect-gen-ui-dsl.test.ts);
 * these tests pin the JSX path: body parsing, sucrase compilation at doc
 * build time, the embedded React runtime and the module wrapper.
 */

const BASE = "http://gw.test";

function post(path: string, body: unknown): Promise<Response> {
  return handleGenUiRoute(
    path,
    new Request(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    new URL(BASE + path),
  ) as Promise<Response>;
}

const SAMPLE = `@jsx
import { useState } from "react";

export default function App({ n }) {
  const [x, setX] = useState(0);
  return <div className="gu-root"><button onClick={() => setX(x + n)}>{x}</button></div>;
}
`;

describe("generative ui @jsx parsing", () => {
  test("a body starting with @jsx is one verbatim source file", () => {
    const data = parseGenerativeUiDsl(SAMPLE);
    expect(data.jsx).toContain('import { useState } from "react";');
    expect(data.jsx).toContain("export default function App");
    expect(data.jsx).toContain("<button");
    // No html/css/js sections in this format.
    expect(data.html).toBeUndefined();
    expect(data.css).toBeUndefined();
    expect(data.js).toBeUndefined();
  });

  test("header keys still parse before @jsx; later lines are never re-parsed", () => {
    const data = parseGenerativeUiDsl(
      'placeholder: Compiling\nheight: 320\nstate: {"a": 1}\n\n' + SAMPLE,
    );
    expect(data.placeholder).toBe("Compiling");
    expect(data.height).toBe(320);
    expect(data.state).toEqual({ a: 1 });
    // Even an @html-looking line inside the source stays source.
    const withSectionLike = parseGenerativeUiDsl("@jsx\nconst s = 1;\n@html\nconst t = 2;");
    expect(withSectionLike.jsx).toBe("const s = 1;\n@html\nconst t = 2;");
  });

  test("@tsx alias works and hasWidgetBody accepts jsx", () => {
    const data = parseGenerativeUiDsl("@tsx\nexport default function App() { return <div />; }");
    expect(data.jsx).toContain("export default function App");
    expect(hasWidgetBody(data)).toBe(true);
    expect(hasWidgetBody({})).toBe(false);
  });
});

describe("generative ui @jsx compilation", () => {
  test("sucrase compiles JSX to React.createElement at doc build time", () => {
    const out = compileJsxModule(SAMPLE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain("React.createElement");
    expect(out.code).not.toContain("<button");
    // The imports transform keeps require()/module.exports — the doc wrapper
    // provides the shims (no eval anywhere in the sandbox).
    expect(out.code).toContain("require('react')");
  });

  test("a broken source reports the error instead of throwing", () => {
    const out = compileJsxModule("@@@" as string);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.length).toBeGreaterThan(0);
  });

  test("buildJsxModelScript wraps the compiled module with react shims + auto-mount", () => {
    const out = compileJsxModule(SAMPLE);
    if (!out.ok) throw new Error(out.error);
    const script = buildJsxModelScript(out.code);
    expect(script).toContain('if (name === "react") return window.React;');
    expect(script).toContain("window.ReactDOMClient.createRoot");
    expect(script).toContain("module.exports.default || module.exports.App");
    // Model code can never close the script element.
    const evil = buildJsxModelScript('var s = "</script><script>window.evil=1</script>";');
    expect(evil).not.toContain("</script>");
    expect(evil).toContain("<\\/script");
  });
});

describe("generative ui @jsx documents", () => {
  const doc = buildWidgetDocument({
    theme: "dark",
    html: "",
    css: "",
    js: "",
    jsx: "var x = 1;",
    stateJSON: '{"n":2}',
    initialHeight: 320,
    scriptNonce: "N0NCE",
  });

  test("the document embeds the React runtime and the module wrapper", () => {
    expect(doc).toContain("window.React = React");
    expect(doc).toContain("React.createElement(App, state)");
    expect(doc).toContain("module.exports.default");
    // React widgets mount into document.body (their own gu-root is the root).
    expect(doc).toContain("var host = document.body;");
    // Nonce covers every inline script.
    expect(doc).not.toMatch(/<script(?![^>]*nonce="N0NCE")/);
  });

  test("runtime exposes the React 18 surface models are trained on", () => {
    for (const api of [
      "createElement", "useState", "useEffect", "useMemo", "useRef",
      "createContext", "forwardRef", "memo", "createRoot",
    ]) {
      expect(REACT_RUNTIME_JS).toContain(api);
    }
    expect(REACT_RUNTIME_JS).not.toContain("eval(");
    expect(REACT_RUNTIME_JS).not.toContain("new Function");
    // The runtime must at least be syntactically valid script.
    expect(() => new Function(REACT_RUNTIME_JS)).not.toThrow();
  });

  test("the route compiles @jsx bodies and rejects broken sources", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: SAMPLE,
      stateJSON: "{}",
      initialHeight: 320,
      libs: ["d3"],
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { success: boolean; url: string };
    expect(created.success).toBe(true);
    const docRes = await handleGenUiRoute(
      created.url,
      new Request(BASE + created.url, { method: "GET" }),
      new URL(BASE + created.url),
    ) as Response;
    expect(docRes.status).toBe(200);
    const html = await docRes.text();
    expect(html).toContain("React.createElement");
    expect(html).toContain("window.React = React");

    const bad = await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: "@@@ not jsx",
      initialHeight: 320,
    });
    expect(bad.status).toBe(400);
  });
});
