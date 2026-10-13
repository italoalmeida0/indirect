import { describe, expect, test, beforeAll } from "bun:test";

import { handleGenUiRoute, genUiStoreSize } from "../server/routes/gen-ui";
import { vendorGenUiLibs } from "../scripts/vendor-gen-ui-libs";

/**
 * Generative UI widget documents (black-box route contract, React `@jsx`
 * widgets only).
 *
 * The gateway CSP forbids inline frames, so widget documents are served as
 * real documents under /api/indirect-code/gen-ui/. These tests pin the
 * security contract of that surface: strict sandbox CSP on every response,
 * content-addressed unguessable ids, compilation at doc build time (the
 * sandbox has no eval) and no way for model code to break out of its script
 * element.
 */
const BASE = "http://gw.test";

const APP = `import { useState } from "react";
export default function App() {
  const [x] = useState(1);
  return <div className="gu-root"><h2 className="gu-title">hi {x}</h2></div>;
}`;

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

describe("gen-ui widget routes", () => {
  // Library bundles are build artifacts; generate them so the lib injection
  // contract below is exercised from a clean checkout too.
  beforeAll(async () => {
    await vendorGenUiLibs();
  });

  test("POST stores a widget and returns its content-addressed URL", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: APP,
      stateJSON: "{}",
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.success).toBe(true);
    expect(out.url).toMatch(/^\/api\/indirect-code\/gen-ui\/widgets\/[0-9a-f]{64}$/);
  });

  test("identical content deduplicates to the same id", async () => {
    const body = { theme: "dark", jsx: APP, stateJSON: "{}" };
    const a: any = await (await post("/api/indirect-code/gen-ui/widgets", body)).json();
    const b: any = await (await post("/api/indirect-code/gen-ui/widgets", body)).json();
    expect(a.id).toBe(b.id);
  });

  test("GET serves the widget with a locked-down sandbox CSP header", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "light",
      jsx: APP,
      stateJSON: '{"a":1}',
    })).json();
    const res = await get(out.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    // Network is limited to images, https data and the esm.sh lib CDN.
    expect(csp).toContain("connect-src https:");
    expect(csp).toContain("https://esm.sh");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const html = await res.text();
    // The document carries the React runtime + the bridge; the widget code
    // lives in its own served module (referenced by the import map).
    expect(html).toContain("window.React = React");
    expect(html).toContain("window.__gu");
    expect(html).toContain('<script type="importmap"');
    expect(html).toContain("/api/indirect-code/gen-ui/modules/");
  });

  test("unknown widget id 404s (ids are unguessable sha256 digests)", async () => {
    const res = await get(`/api/indirect-code/gen-ui/widgets/${"0".repeat(64)}`);
    expect(res.status).toBe(404);
  });

  test("oversized widgets are refused", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", {
      jsx: "const a = '" + "a".repeat(1_600_000) + "';",
    });
    expect(res.status).toBe(413);
  });

  test("empty widgets are refused", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", { jsx: "" });
    expect(res.status).toBe(400);
  });

  test("sources that do not compile are refused with the compiler message", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", {
      jsx: "export default function App( { return <div/>;",
    });
    expect(res.status).toBe(400);
    const out: any = await res.json();
    expect(String(out.error)).toContain("invalid jsx");
  });

  test("the store is bounded", () => {
    expect(genUiStoreSize()).toBeGreaterThan(0);
    expect(genUiStoreSize()).toBeLessThanOrEqual(400);
  });

  test("libs header maps the requested modules in the import map", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: APP,
      stateJSON: "{}",
      libs: ["three", "gsap"],
    })).json();
    const html = await (await get(out.url)).text();
    // The document is tiny: the libs live in shared, cacheable modules.
    expect(html.length).toBeLessThan(200_000);
    expect(html).not.toContain("globalThis.THREE=");
    const map = JSON.parse(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(map.imports.three).toBe("/api/indirect-code/gen-ui/lib/three.js");
    expect(map.imports.gsap).toBe("/api/indirect-code/gen-ui/lib/gsap.js");
    expect(map.imports.d3).toBeUndefined();
    // The module endpoint and lib endpoint are reachable and cacheable.
    const lib = await get("/api/indirect-code/gen-ui/lib/three.js");
    expect(lib.status).toBe(200);
    expect(lib.headers.get("access-control-allow-origin")).toBe("*");
    expect(lib.headers.get("cache-control")).toContain("immutable");
  });

  test("widgets always serve the https/esm.sh CSP and map libs bundle leaflet", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "light",
      jsx: `export default function App() {
        import("https://esm.sh/canvas-confetti@1").then((m) => m.default());
        return <div className="gu-root" id="map">map</div>;
      }`,
      stateJSON: "{}",
      libs: ["map"],
    })).json();
    const res = await get(out.url);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("img-src data: blob: https: http:");
    expect(csp).toContain("connect-src https:");
    // esm.sh is the one extra script origin, on every widget.
    expect(csp).toContain("https://esm.sh");
    expect(csp).toContain("sandbox allow-scripts");
    const html = await res.text();
    // The leaflet stylesheet (with inlined images) is inlined in the doc.
    expect(html).toContain("leaflet");
    expect(html).not.toContain("url(images/");
    // The esm.sh dynamic import survives into the served module.
    const moduleUrl = /src="(\/api\/indirect-code\/gen-ui\/modules\/[0-9a-f]{64})"/.exec(html)![1];
    expect(await (await get(moduleUrl)).text()).toContain("https://esm.sh/canvas-confetti@1");
  });

  test("widgets default to the d3 module and drop unknown libs", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: APP,
      stateJSON: "{}",
      libs: ["evil", "chart"],
    })).json();
    const html = await (await get(out.url)).text();
    const map = JSON.parse(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(map.imports.chart).toBe("/api/indirect-code/gen-ui/lib/chart.js");
    expect(map.imports.evil).toBeUndefined();
    // The default (no libs) document still maps d3.
    const def: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: APP,
      stateJSON: "{}",
    })).json();
    const defHtml = await (await get(def.url)).text();
    const defMap = JSON.parse(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(defHtml)![1]);
    expect(defMap.imports.d3).toBe("/api/indirect-code/gen-ui/lib/d3.js");
    expect(defMap.imports.three).toBeUndefined();
  });
});
