import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import path from "path";

/**
 * E2E secret hygiene (source contract).
 *
 * Browser/full-stack e2e scripts need real provider keys, but the key must
 * only ever come from the environment or the gitignored .env — never from a
 * literal fallback in source. A missing key fails closed (exit 2), matching
 * the sibling e2e scripts. This test fails if a credential-shaped literal or
 * a key fallback ever creeps back in.
 */
const SCRIPTS = path.join(import.meta.dir, "..", "scripts");

function e2eScripts(): string[] {
  return readdirSync(SCRIPTS)
    .filter((name) => /^test-indirect-.*-e2e\.ts$/.test(name))
    .map((name) => path.join(SCRIPTS, name));
}

const CREDENTIAL_LITERALS: Array<[string, RegExp]> = [
  ["synthetic key", /\bsyn_[a-z0-9]{16,}\b/i],
  ["sk- key", /\bsk-[a-z0-9]{16,}\b/i],
  // envGet("...KEY...") || "literal" — a key must never have a baked-in value.
  ["key fallback literal", /envGet\("[A-Z0-9_]*KEY[A-Z0-9_]*"\)\s*\|\|\s*["'][^"']+["']/],
];

describe("e2e secret hygiene", () => {
  test("no hardcoded credentials in indirect e2e scripts", () => {
    const files = e2eScripts();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [label, pattern] of CREDENTIAL_LITERALS) {
        expect(pattern.test(source), `${path.basename(file)} contains a ${label}`).toBe(false);
      }
    }
  });

  test("generative UI e2e fails closed without SYNTHETIC_API_KEY", () => {
    const source = readFileSync(path.join(SCRIPTS, "test-indirect-gen-ui-e2e.ts"), "utf8");
    expect(source).toContain('envGet("SYNTHETIC_API_KEY")');
    expect(source).toContain("SYNTHETIC_API_KEY missing");
    expect(source).toContain("process.exit(2)");
  });
});
