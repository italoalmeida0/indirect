import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

import { baseHeaders } from "../server/http";

/**
 * CSP inline-script contract (black-box).
 *
 * index.html ships two inline scripts that must run before first paint (the
 * touch-device flag and the theme/favicon init). The gateway CSP deliberately
 * avoids 'unsafe-inline', so every one of those scripts is allowlisted by the
 * sha256 hash of its exact textContent. This test recomputes those hashes and
 * fails whenever index.html changes without the CSP being updated — the drift
 * that silently broke the SPA with a script-src violation.
 */
const ROOT = path.join(import.meta.dir, "..");

function inlineScripts(htmlPath: string): string[] {
  const html = readFileSync(htmlPath, "utf8");
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/i.test(m[1]) && m[2].trim() !== "") out.push(m[2]);
  }
  return out;
}

function scriptHash(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("base64");
}

describe("CSP inline script hashes", () => {
  const headers = baseHeaders(undefined, true);
  const csp = headers.get("Content-Security-Policy") || "";
  const permissionsPolicy = headers.get("Permissions-Policy") || "";
  const directives = csp.split(";").map((s) => s.trim());
  const scriptSrc = directives.find((s) => s.startsWith("script-src ")) || "";
  const workerSrc = directives.find((s) => s.startsWith("worker-src ")) || "";
  const connectSrc = directives.find((s) => s.startsWith("connect-src ")) || "";
  const imgSrc = directives.find((s) => s.startsWith("img-src ")) || "";

  test("script-src never falls back to unsafe-inline or unsafe-eval and stays free of external CDNs", () => {
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("cdn.jsdelivr.net");
    expect(scriptSrc).not.toContain("unpkg.com");
    expect(scriptSrc).not.toContain("esm.sh");
  });

  test("voice CSP & Permissions-Policy allow self-hosted microphone and workers without external model CDNs", () => {
    expect(permissionsPolicy).toContain("microphone=(self)");
    expect(permissionsPolicy).not.toContain("microphone=()");
    expect(permissionsPolicy).toContain("camera=()");
    expect(permissionsPolicy).toContain("geolocation=()");
    expect(workerSrc).toBe("worker-src 'self'");
    expect(connectSrc).not.toContain("huggingface.co");
    expect(connectSrc).not.toContain("hf.co");
    expect(connectSrc).not.toContain("cdn.jsdelivr.net");
  });

  test("img-src allows blob: ObjectURLs for CAS transcript images", () => {
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain("data:");
    expect(imgSrc).toContain("blob:");
  });

  test("every inline script in web/index.html is allowlisted by hash", () => {
    const scripts = inlineScripts(path.join(ROOT, "web", "index.html"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) {
      expect(scriptSrc).toContain(`'sha256-${scriptHash(source)}'`);
    }
  });

  test("the built SPA keeps the same inline scripts as the source", () => {
    const distPath = path.join(ROOT, "dist", "index.html");
    let distScripts: string[];
    try {
      distScripts = inlineScripts(distPath);
    } catch {
      // dist/ is a local build artifact; skip when it has not been built.
      return;
    }
    const sourceScripts = inlineScripts(path.join(ROOT, "web", "index.html"));
    expect(distScripts.map(scriptHash)).toEqual(sourceScripts.map(scriptHash));
    for (const source of distScripts) {
      expect(scriptSrc).toContain(`'sha256-${scriptHash(source)}'`);
    }
  });
});
