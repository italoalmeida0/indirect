import { describe, expect, test, beforeAll } from "bun:test";

import { parseGenerativeUiDsl, hasWidgetBody } from "../web/src/indirect-code/components/generative-ui/dsl";
import { compileJsxModule } from "../web/src/indirect-code/components/generative-ui/jsx-compile";
import {
  buildJsxImportMap,
  buildJsxModuleBody,
  buildReactShimModule,
  buildWidgetDocument,
} from "../web/src/indirect-code/components/generative-ui/widget-doc";
import { REACT_RUNTIME_JS } from "../web/src/indirect-code/components/generative-ui/react-runtime";
import { handleGenUiRoute } from "../server/routes/gen-ui";
import { vendorGenUiLibs } from "../scripts/vendor-gen-ui-libs";

/**
 * Generative UI `@jsx` widgets: body parsing, Bun compilation at doc build
 * time, the served-module architecture (import map + stored ESM + vendored
 * lib modules) and the embedded React runtime.
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

async function get(fullPath: string): Promise<Response> {
  const url = new URL(BASE + fullPath);
  const res = await handleGenUiRoute(url.pathname, new Request(url.toString()), url);
  if (!res) throw new Error(`route not handled: ${fullPath}`);
  return res;
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
    // This format is source-only: nothing else is parsed out of the body.
    expect(data.placeholder).toBeUndefined();
    expect(data.state).toBeUndefined();
  });

  test("header keys still parse before @jsx; later lines are never re-parsed", () => {
    const data = parseGenerativeUiDsl(
      'placeholder: Compiling\nstate: {"a": 1}\n\n' + SAMPLE,
    );
    expect(data.placeholder).toBe("Compiling");
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

const SRC = parseGenerativeUiDsl(SAMPLE).jsx!;

describe("generative ui @jsx compilation", () => {
  test("compiles JSX to React.createElement and keeps ESM imports", () => {
    const out = compileJsxModule(SRC);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain("React.createElement");
    expect(out.code).not.toContain("<button");
    // ESM is the widget module format: imports/exports are preserved and
    // resolved by the document's import map.
    expect(out.code).toContain('import { useState } from "react"');
    expect(out.code).toContain("export default function App");
  });

  test("a broken source reports the error instead of throwing", () => {
    const out = compileJsxModule("export default function App( { return <div/>; }");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.length).toBeGreaterThan(0);
  });

  test("specifiers outside the import map are refused at compile time", () => {
    const out = compileJsxModule('import x from "left-pad"; export default function App() { return <div/>; }');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("unsupported import");
    expect(out.error).toContain("left-pad");
    // esm.sh URLs are fine as source (always allowed; the CSP only admits
    // that one CDN).
    const esm = compileJsxModule('export default function App() { import("https://esm.sh/x@1"); return <div/>; }');
    expect(esm.ok).toBe(true);
  });

  test("buildJsxModuleBody appends the auto-mount and never leaks script closers", () => {
    const out = compileJsxModule(SRC);
    if (!out.ok) throw new Error(out.error);
    const body = buildJsxModuleBody(out.code);
    expect(body).toContain("export default function App");
    expect(body).toContain("window.ReactDOMClient.createRoot(document.body)");
    expect(body).toContain("window.React.createElement(__app");
    expect(body).not.toContain("require(");
    // Model code can never close a script element (it is served as its own
    // module, but escapeScriptClose is the belt-and-braces layer).
    const evil = buildJsxModuleBody('var s = "</script><script>window.evil=1</script>";');
    expect(evil).not.toContain("</script>");
    expect(evil).toContain("<\\/script");
  });

  test("the import map resolves react and the vendored libs", () => {
    const map = JSON.parse(buildJsxImportMap({
      react: "/api/indirect-code/gen-ui/lib/react-shim.js",
      libs: { three: "/api/indirect-code/gen-ui/lib/three.js", chart: "/api/indirect-code/gen-ui/lib/chart.js" },
    }));
    expect(map.imports.react).toBe("/api/indirect-code/gen-ui/lib/react-shim.js");
    expect(map.imports["react-dom/client"]).toBe("/api/indirect-code/gen-ui/lib/react-shim.js");
    expect(map.imports["react/jsx-runtime"]).toBe("/api/indirect-code/gen-ui/lib/react-shim.js");
    expect(map.imports.three).toBe("/api/indirect-code/gen-ui/lib/three.js");
    expect(map.imports["chart.js/auto"]).toBe("/api/indirect-code/gen-ui/lib/chart.js");
    expect(map.imports.d3).toBeUndefined();
  });

  test("the react shim re-exports the runtime surface as a module", () => {
    const shim = buildReactShimModule();
    for (const api of ["useState", "useEffect", "createRoot", "createElement", "Fragment", "jsx"]) {
      expect(shim).toContain(api);
    }
    expect(shim).toContain("export default React");
    expect(shim).not.toContain("eval(");
  });
});

describe("generative ui @jsx documents", () => {
  const doc = buildWidgetDocument({
    theme: "dark",
    moduleUrl: "/api/indirect-code/gen-ui/modules/abc",
    importMap: buildJsxImportMap({
      react: "/api/indirect-code/gen-ui/lib/react-shim.js",
      libs: {},
    }),
    stateJSON: '{"n":2}',
    scriptNonce: "N0NCE",
  });

  test("the document embeds the runtime and loads the module via import map", () => {
    expect(doc).toContain("window.React = React");
    expect(doc).toContain('<script type="importmap" nonce="N0NCE">');
    expect(doc).toContain('<script type="module" src="/api/indirect-code/gen-ui/modules/abc"');
    // Inline scripts only: the runtime and the bridge (the model lives in
    // the served module).
    expect(doc).not.toMatch(/<script(?![^>]*(nonce="N0NCE"|type="importmap"|type="module"))/);
    expect(doc).toContain("window.__gu");
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
});

describe("generative ui module routes", () => {
  beforeAll(async () => {
    await vendorGenUiLibs();
  });

  test("the route compiles @jsx bodies, stores the module and serves both", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: SRC,
      stateJSON: "{}",
      libs: ["d3"],
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { success: boolean; url: string };
    expect(created.success).toBe(true);

    const docRes = await get(created.url);
    expect(docRes.status).toBe(200);
    const html = await docRes.text();
    // The document is small: runtime + bridge only, the widget is a module.
    expect(html.length).toBeLessThan(200_000);
    expect(html).toContain("window.React = React");
    expect(html).toContain("/api/indirect-code/gen-ui/modules/");

    const moduleUrl = /src="(\/api\/indirect-code\/gen-ui\/modules\/[0-9a-f]{64})"/.exec(html)?.[1];
    expect(moduleUrl).toBeTruthy();
    const modRes = await get(moduleUrl!);
    expect(modRes.status).toBe(200);
    expect(modRes.headers.get("content-type")).toContain("text/javascript");
    expect(modRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(modRes.headers.get("cache-control")).toContain("immutable");
    const code = await modRes.text();
    expect(code).toContain("React.createElement");
    expect(code).toContain("createRoot(document.body)");

    const bad = await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: "@@@ not jsx",
    });
    expect(bad.status).toBe(400);
  });

  test("identical module bodies share one module entry", async () => {
    const a = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark", jsx: SRC, stateJSON: "{}",
    })).json() as { url: string };
    const b = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "light", jsx: SRC, stateJSON: '{"x":1}',
    })).json() as { url: string };
    // Different documents (theme/state), same widget module.
    expect(a.url).not.toBe(b.url);
    const modA = /src="(\/api\/indirect-code\/gen-ui\/modules\/[0-9a-f]{64})"/.exec(await (await get(a.url)).text())?.[1];
    const modB = /src="(\/api\/indirect-code\/gen-ui\/modules\/[0-9a-f]{64})"/.exec(await (await get(b.url)).text())?.[1];
    expect(modA).toBe(modB);
  });

  test("vendored lib modules and the react shim are served as ESM", async () => {
    const shim = await get("/api/indirect-code/gen-ui/lib/react-shim.js");
    expect(shim.status).toBe(200);
    expect(shim.headers.get("access-control-allow-origin")).toBe("*");
    expect(await shim.text()).toContain("export default React");

    const three = await get("/api/indirect-code/gen-ui/lib/three.js");
    expect(three.status).toBe(200);
    const code = await three.text();
    expect(code).toContain("globalThis.THREE=");
    expect(/\bexport\b/.test(code)).toBe(true);

    // Unknown / traversal names are refused.
    expect((await get("/api/indirect-code/gen-ui/lib/evil.js")).status).toBe(404);
    expect((await get("/api/indirect-code/gen-ui/lib/..%2Fpackage.json")).status).toBe(404);
    expect((await get("/api/indirect-code/gen-ui/modules/" + "0".repeat(64))).status).toBe(404);
  });
});
