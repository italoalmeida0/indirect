import { describe, expect, test, beforeAll } from "bun:test";

import {
  handleGenUiRoute,
  genUiImageCacheSize,
  genUiStoreSize,
  isBlockedAddress,
  sniffImageMime,
} from "../server/routes/gen-ui";
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
    // CSP script sources must be absolute (paths are rejected by the
    // browser): the served modules are pinned to the request origin.
    expect(csp).toContain(`${BASE}/api/indirect-code/gen-ui/lib/`);
    expect(csp).toContain(`${BASE}/api/indirect-code/gen-ui/modules/`);
    // No path-only source ever (CSP rejects those silently).
    expect(csp).not.toMatch(/script-src[^;]*\s\/api/);
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

  test("the import map maps every vendored lib (imports decide the fetches)", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: APP,
      stateJSON: "{}",
    })).json();
    const html = await (await get(out.url)).text();
    // The document is tiny: the libs live in shared, cacheable modules and
    // the browser only fetches what the module actually imports.
    expect(html.length).toBeLessThan(200_000);
    expect(html).not.toContain("globalThis.THREE=");
    const map = JSON.parse(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
    for (const [spec, file] of [
      ["three", "three.js"],
      ["d3", "d3.js"],
      ["gsap", "gsap.js"],
      ["chart", "chart.js"],
      ["leaflet", "leaflet.js"],
      ["cannon-es", "cannon-es.js"],
      ["cannon", "cannon-es.js"],
      ["matter-js", "matter-js.js"],
      ["matter", "matter-js.js"],
    ] as const) {
      expect(map.imports[spec]).toBe(`/api/indirect-code/gen-ui/lib/${file}`);
    }
    // The module endpoint and lib endpoint are reachable and cacheable.
    const lib = await get("/api/indirect-code/gen-ui/lib/three.js");
    expect(lib.status).toBe(200);
    expect(lib.headers.get("access-control-allow-origin")).toBe("*");
    expect(lib.headers.get("cache-control")).toContain("immutable");
  });

  test("every vendored lib exposes the documented API surface", async () => {
    // Regression guard for the vendor entrypoints (scripts/gen-ui-libs/):
    // the widgets are documented to use `import * as L from "leaflet"` /
    // `import * as gsap from "gsap"` and call members on the namespace, so
    // each bundle must re-export the library's named surface — a bare
    // `export default` makes every namespace call fail at runtime.
    const documented: Record<string, string[]> = {
      "three.js": ["Scene", "Mesh", "WebGLRenderer", "PerspectiveCamera", "TorusKnotGeometry", "DirectionalLight"],
      "d3.js": ["select", "scaleLinear", "arc"],
      "gsap.js": ["to", "from", "timeline", "killTweensOf", "set", "default"],
      "chart.js": ["Chart", "default"],
      "leaflet.js": ["map", "marker", "tileLayer", "divIcon", "polyline", "circle", "default"],
      "cannon-es.js": ["World", "Body", "Vec3", "Box", "Sphere", "default"],
      "matter-js.js": ["Engine", "Bodies", "Composite", "World", "Render", "Runner", "default"],
    };
    for (const [file, members] of Object.entries(documented)) {
      const res = await get(`/api/indirect-code/gen-ui/lib/${file}`);
      expect(res.status, file).toBe(200);
      const src = await res.text();
      const exported = new Set<string>();
      for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop();
          if (name) exported.add(name);
        }
      }
      for (const member of members) {
        expect(exported.has(member), `${file} must export ${member} (got ${exported.size} names)`).toBe(true);
      }
    }
  });

  test("lib styles embed in their module (no doc css)", async () => {
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "light",
      jsx: `export default function App() {
        import("https://esm.sh/canvas-confetti@1").then((m) => m.default());
        return <div className="gu-root" id="map">map</div>;
      }`,
      stateJSON: "{}",
    })).json();
    const res = await get(out.url);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("img-src data: blob: https: http:");
    expect(csp).toContain("connect-src https:");
    // esm.sh is the one extra script origin, on every widget.
    expect(csp).toContain("https://esm.sh");
    expect(csp).toContain("sandbox allow-scripts");
    const html = await res.text();
    // The leaflet style (with inlined images) rides inside the lib module,
    // not the document.
    expect(html).not.toContain("url(images/");
    const leaflet = await (await get("/api/indirect-code/gen-ui/lib/leaflet.js")).text();
    expect(leaflet).toContain("leaflet"); // css text embedded
    expect(leaflet).not.toContain("url(images/");
    // The esm.sh dynamic import survives into the served module.
    const moduleUrl = /src="(\/api\/indirect-code\/gen-ui\/modules\/[0-9a-f]{64})"/.exec(html)![1];
    expect(await (await get(moduleUrl)).text()).toContain("https://esm.sh/canvas-confetti@1");
  });

  test("global-style lib usage is detected and side-effect imported", async () => {
    // A model that reads the classic global (no import) still works: the
    // compiler prepends a side-effect import so the module assigns it.
    const out: any = await (await post("/api/indirect-code/gen-ui/widgets", {
      theme: "dark",
      jsx: `export default function App() {
        const scene = new THREE.Scene();
        return <div className="gu-root">{String(!!scene)}</div>;
      }`,
      stateJSON: "{}",
    })).json();
    const html = await (await get(out.url)).text();
    const moduleUrl = /src="(\/api\/indirect-code\/gen-ui\/modules\/[0-9a-f]{64})"/.exec(html)![1];
    const code = await (await get(moduleUrl)).text();
    expect(code).toContain('import "three";');
  });
});

describe("gen-ui image proxy", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const realFetch = globalThis.fetch;
  let fetchCalls: string[] = [];

  function stub(handler: (url: string) => Response | Promise<Response>): void {
    fetchCalls = [];
    (globalThis as any).fetch = async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? input);
      fetchCalls.push(url);
      return handler(url);
    };
  }

  function img(u: string): Promise<Response> {
    return handleGenUiRoute(
      "/api/indirect-code/gen-ui/img",
      new Request(`${BASE}/api/indirect-code/gen-ui/img?u=${encodeURIComponent(u)}`),
      new URL(`${BASE}/api/indirect-code/gen-ui/img?u=${encodeURIComponent(u)}`),
    ) as Promise<Response>;
  }

  test("sniffImageMime trusts the bytes, not the header", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(new TextEncoder().encode("<html>oops</html>"))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x"><rect/></svg>'))).toBe("image/svg+xml");
    expect(sniffImageMime(new Uint8Array(4))).toBeNull();
  });

  test("isBlockedAddress covers loopback, RFC1918, link-local and metadata", () => {
    for (const host of [
      "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.9.9", "192.168.1.1",
      "169.254.169.254", "100.100.100.100", "224.0.0.1", "::1", "[::1]",
      "fe80::1", "fd00::1", "localhost", "db.internal", "printer.local",
    ]) {
      expect(isBlockedAddress(host)).toBe(true);
    }
    for (const host of ["8.8.8.8", "1.1.1.1", "example.com", "2606:4700::1111", "cdn.example.org"]) {
      expect(isBlockedAddress(host)).toBe(false);
    }
  });

  test("SSRF targets are refused without ever fetching", async () => {
    stub(() => { throw new Error("fetch must not be called"); });
    for (const u of [
      "http://127.0.0.1/x.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/admin",
      "https://db.internal/secret.png",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      const res = await img(u);
      expect(res.status).toBe(400);
      expect(fetchCalls.length).toBe(0);
    }
    const missing = await img("");
    expect(missing.status).toBe(400);
  });

  test("images are served by their binary signature with hardening headers", async () => {
    // Upstream lies with a text/plain header; the bytes are what count.
    stub(() => new Response(PNG, { status: 200, headers: { "content-type": "text/plain" } }));
    const res = await img("https://8.8.8.8/pic.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // Cached: the second request never re-fetches.
    const before = fetchCalls.length;
    const again = await img("https://8.8.8.8/pic.png");
    expect(again.status).toBe(200);
    expect(fetchCalls.length).toBe(before);
    expect(genUiImageCacheSize()).toBeGreaterThan(0);
  });

  test("documents and oversized payloads are refused", async () => {
    stub(() => new Response("<html>error page</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const doc = await img("https://8.8.8.8/landing");
    expect(doc.status).toBe(415);

    stub(() => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": "99999999999" } }));
    const big = await img("https://8.8.8.8/huge.png");
    expect(big.status).toBe(413);

    stub(() => new Response("nope", { status: 404 }));
    const missing = await img("https://8.8.8.8/gone.png");
    expect(missing.status).toBe(400);
  });

  test("redirect hops are re-validated and bounded", async () => {
    stub((url) => {
      if (url === "https://8.8.8.8/start.png") {
        return new Response(null, { status: 302, headers: { location: "https://1.1.1.1/final.png" } });
      }
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    });
    const ok = await img("https://8.8.8.8/start.png");
    expect(ok.status).toBe(200);
    expect(fetchCalls).toEqual(["https://8.8.8.8/start.png", "https://1.1.1.1/final.png"]);

    stub((url) => {
      if (url.startsWith("https://cdn.example.com")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } });
      }
      throw new Error("fetch must not follow a blocked hop");
    });
    const ssrf = await img("https://8.8.8.8/trap.png");
    expect(ssrf.status).toBe(400);

    stub((url) => new Response(null, { status: 302, headers: { location: url + "/again" } }));
    const loop = await img("https://8.8.8.8/loop.png");
    expect(loop.status).toBe(400);
    expect(fetchCalls.length).toBeLessThanOrEqual(4); // initial + 3 redirects
  });

  test("teardown", () => {
    globalThis.fetch = realFetch;
    expect(true).toBe(true);
  });
});
