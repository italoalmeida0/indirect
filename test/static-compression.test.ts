import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Static asset delivery: compression negotiation, validators and the safety
 * rules around them. The dashboard bundle is ~4.7 MB of JavaScript, so an
 * uncompressed response is the difference between a usable and an unusable
 * first paint on a slow link.
 */

const ROOT = path.resolve(import.meta.dir, "..", "tmp", "compression-static");
const BODY = "export const answer = 42;\n".repeat(4000);

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(path.join(ROOT, "assets"), { recursive: true });
  writeFileSync(path.join(ROOT, "assets", "app.js"), BODY);
  writeFileSync(path.join(ROOT, "assets", "small.js"), "x=1");
  writeFileSync(path.join(ROOT, "assets", "logo.png"), Buffer.alloc(4096, 7));
  writeFileSync(path.join(ROOT, "index.html"), "<!doctype html><title>indirect</title>");
  process.env.STATIC_DIR = ROOT;
  const { serveStatic } = require("../server/static") as typeof import("../server/static");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      return serveStatic(req, url.pathname) ?? new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.STATIC_DIR;
});

describe("compression negotiation", () => {
  test("prefers brotli, falls back to gzip, respects q-values", async () => {
    const { negotiateEncoding } = await import("../server/compression");
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("br;q=0.5, gzip;q=0.9")).toBe("gzip");
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding("*")).toBe("br");
    // An explicit identity preference beats the wildcard.
    expect(negotiateEncoding("identity;q=1, *;q=0.1")).toBeNull();
    // q=0 means "not acceptable", never "default".
    expect(negotiateEncoding("br;q=0, gzip;q=0")).toBeNull();
  });

  test("only text-like extensions are eligible", async () => {
    const { isCompressible } = await import("../server/compression");
    for (const ext of [".js", ".mjs", ".css", ".html", ".json", ".svg", ".wasm", ".webmanifest"]) expect(isCompressible(ext)).toBe(true);
    for (const ext of [".png", ".jpg", ".woff2", ".webp", ".ico"]) expect(isCompressible(ext)).toBe(false);
  });
});

describe("static delivery", () => {
  // Bun's fetch transparently decodes a compressed response, so the wire
  // bytes are only visible with `decompress: false`; both views are asserted
  // (the decoded text proves correctness, the raw bytes prove it was smaller).
  test("a compressed asset carries Content-Encoding and a smaller body", async () => {
    // Bun's fetch always advertises its own Accept-Encoding, so "no encoding"
    // has to be requested explicitly.
    const plain = await fetch(`${base}/assets/app.js`, { headers: { "Accept-Encoding": "identity" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(BODY);

    const compressed = await fetch(`${base}/assets/app.js`, { headers: { "Accept-Encoding": "br, gzip" } });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("br");
    expect(compressed.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
    expect(await compressed.text()).toBe(BODY);

    const wire = await fetch(`${base}/assets/app.js`, { headers: { "Accept-Encoding": "br" }, decompress: false });
    const raw = Buffer.from(await wire.arrayBuffer());
    expect(raw.length).toBeLessThan(BODY.length / 4);
    expect(Number(wire.headers.get("content-length"))).toBe(raw.length);
    const { brotliDecompressSync } = await import("node:zlib");
    expect(brotliDecompressSync(raw).toString("utf8")).toBe(BODY);
  });

  test("gzip is used when brotli is not offered, and the payload decompresses exactly", async () => {
    const response = await fetch(`${base}/assets/app.js`, { headers: { "Accept-Encoding": "gzip" }, decompress: false });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const { gunzipSync } = await import("node:zlib");
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8")).toBe(BODY);
  });

  test("no Accept-Encoding means identity", async () => {
    const response = await fetch(`${base}/assets/app.js`, { headers: { "Accept-Encoding": "identity" } });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(BODY);
  });

  test("a tiny asset and a binary asset are never compressed", async () => {
    const small = await fetch(`${base}/assets/small.js`, { headers: { "Accept-Encoding": "br" } });
    expect(small.headers.get("content-encoding")).toBeNull();
    const png = await fetch(`${base}/assets/logo.png`, { headers: { "Accept-Encoding": "br" } });
    expect(png.headers.get("content-encoding")).toBeNull();
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  test("a matching ETag returns 304 with no body", async () => {
    const first = await fetch(`${base}/assets/app.js`);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const conditional = await fetch(`${base}/assets/app.js`, { headers: { "If-None-Match": etag } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
  });

  test("a range request is never compressed, so offsets stay meaningful", async () => {
    const response = await fetch(`${base}/assets/app.js`, { headers: { Range: "bytes=0-9", "Accept-Encoding": "br" } });
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("HTML is compressed but still revalidates", async () => {
    const response = await fetch(`${base}/`, { headers: { "Accept-Encoding": "br" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
