import { describe, expect, test, beforeAll } from "bun:test";

import { handleGenUiRoute, genUiStoreSize } from "../server/routes/gen-ui";
import { vendorGenUiLibs } from "../scripts/vendor-gen-ui-libs";

/**
 * Generative UI widget documents (black-box route contract).
 *
 * The gateway CSP forbids inline frames, so widget documents are served as
 * real documents under /api/indirect-code/gen-ui/. These tests pin the
 * security contract of that surface: strict sandbox CSP on every response,
 * content-addressed unguessable ids, and no way for model-controlled CSS/JS
 * to break out of its element.
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

describe("gen-ui widget routes", () => {
  // Library bundles are build artifacts; generate them so the lib injection
  // contract below is exercised from a clean checkout too.
  beforeAll(async () => {
    await vendorGenUiLibs();
  });

  test("POST stores a widget and returns its content-addressed URL", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      html: '<div class="gu-root">hi</div>',
      css: ".gu-root{}",
      js: "document.querySelector('.gu-root').style.opacity = '1';",
      stateJSON: "{}",
      initialHeight: 300,
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.success).toBe(true);
    expect(out.url).toMatch(/^\/api\/indirect-code\/gen-ui\/widgets\/[0-9a-f]{64}$/);
  });

  test("identical content deduplicates to the same id", async () => {
    const body = { theme: "dark", html: "<div>same</div>", css: "", js: "", stateJSON: "{}", initialHeight: 200 };
    const a: any = await (await post("/api/indirect-code/gen-ui/widgets", body)).json();
    const b: any = await (await post("/api/indirect-code/gen-ui/widgets", body)).json();
    expect(a.id).toBe(b.id);
  });

  test("GET serves the widget with a locked-down sandbox CSP header", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "light",
      html: '<div class="gu-root"><h2 class="gu-title">T</h2></div>',
      css: "",
      js: "window.__ran = 1;",
      stateJSON: '{"a":1}',
      initialHeight: 320,
    })).json();
    const res = await get(out.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const html = await res.text();
    expect(html).toContain('class="gu-root"');
    expect(html).toContain("window.__gu");
  });

  test("unknown widget id 404s (ids are unguessable sha256 digests)", async () => {
    const res = await get(`/api/indirect-code/gen-ui/widgets/${"0".repeat(64)}`);
    expect(res.status).toBe(404);
  });

  test("oversized widgets are refused", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", {
      html: "<div>" + "a".repeat(1_600_000) + "</div>",
    });
    expect(res.status).toBe(413);
  });

  test("empty widgets are refused", async () => {
    const res = await post("/api/indirect-code/gen-ui/widgets", { html: "", css: "" });
    expect(res.status).toBe(400);
  });

  test("preview shell is served with the same sandbox CSP and runs no model code", async () => {
    const res = await get("/api/indirect-code/gen-ui/preview?theme=light");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("sandbox allow-scripts");
    const html = await res.text();
    expect(html).toContain("__guPreview");
    expect(html).toContain("Idiomorph");
    expect(html).toContain('data-theme="light"');
  });

  test("the store is bounded", () => {
    expect(genUiStoreSize()).toBeGreaterThan(0);
    expect(genUiStoreSize()).toBeLessThanOrEqual(400);
  });

  test("libs header injects the requested library bundles", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      html: '<div class="gu-root">3d</div>',
      css: "",
      js: "window.__ran = 1;",
      stateJSON: "{}",
      initialHeight: 200,
      libs: ["three", "gsap"],
    })).json();
    const html = await (await get(out.url)).text();
    expect(html).toContain("globalThis.THREE=");
    expect(html).toContain("globalThis.gsap=");
    // Canonical injection order: gsap before three.
    expect(html.indexOf("globalThis.gsap=")).toBeLessThan(html.indexOf("globalThis.THREE="));
    // The model script carries the lifecycle contract.
    expect(html).toContain("$onDestroy(__result.destroy)");
  });

  test("net widgets serve the https variant CSP and map libs bundle leaflet", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "light",
      html: '<div class="gu-root" id="map"></div>',
      css: "#map { height: 320px; }",
      js: "window.__made = 1;",
      stateJSON: "{}",
      initialHeight: 320,
      libs: ["map"],
      net: true,
    })).json();
    const res = await get(out.url);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("img-src data: blob: https:");
    expect(csp).toContain("connect-src https:");
    expect(csp).toContain("sandbox allow-scripts");
    const html = await res.text();
    expect(html).toContain("window.L=");
    expect(html).toContain("leaflet"); // css inlined (images as data URIs)
    expect(html).not.toContain("url(images/");
    // Strict widgets (no net) must not gain https access.
    const strict: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "light",
      html: '<div class="gu-root">x</div>',
      css: "", js: "window.__made = 2;", stateJSON: "{}", initialHeight: 320,
    })).json();
    const strictCsp = (await get(strict.url)).headers.get("content-security-policy") || "";
    expect(strictCsp).not.toContain("https:");
    expect(strictCsp).toContain("connect-src 'none'");
  });

  test("widgets default to the d3 bundle and never inline unknown libs", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      html: '<div class="gu-root">chart</div>',
      css: "",
      js: "window.__ran = 2;",
      stateJSON: "{}",
      initialHeight: 200,
      libs: ["evil", "chart"],
    })).json();
    const html = await (await get(out.url)).text();
    expect(html).toContain("globalThis.Chart=");
    expect(html).not.toContain("globalThis.evil");
    // The default (no libs) document still carries d3.
    const def: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      html: '<div class="gu-root">d3</div>',
      css: "", js: "window.__ran = 3;", stateJSON: "{}", initialHeight: 200,
    })).json();
    const defHtml = await (await get(def.url)).text();
    expect(defHtml.length).toBeGreaterThan(100_000);
    expect(defHtml).not.toContain("globalThis.THREE=");
  });
});
