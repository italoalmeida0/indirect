import { describe, expect, test } from "bun:test";
import { parseInspectTree, parseGlobList } from "../web/src/indirect-code/utils/toolTrees";

// Regression: audit bugs 38, 39 — tool output parsers.

describe("Bug 38 — parseInspectTree nesting and bare single files", () => {
  test("flag-less rows nest by the 4-column flag offset (daemon format)", () => {
    // Real daemon format: indent BEFORE the flag; an empty flag occupies 4
    // columns ("    bin/" = depth 0). Verified against shipped fixtures.
    const raw = "./ (4 entries)\n    bin/\n    cmd/\n      deep.ts (2B, 1 lines)\n    a.ts (1B, 1 lines)\n";
    const tree = parseInspectTree(raw);
    const depths = (tree?.entries ?? []).map((e) => e.depth);
    console.log("depths:", depths, tree?.entries.map((e) => e.name));
    expect(depths).toEqual([0, 0, 1, 0]);
    expect(tree?.entries.map((e) => e.name)).toEqual(["bin", "cmd", "deep.ts", "a.ts"]);
    expect(tree?.entries.map((e) => e.isDir)).toEqual([true, true, false, false]);
  });

  test("flagged rows nest by the flag column", () => {
    const raw = [
      "scope: /x (3 entries)",
      "[M] src/",
      "  [ ] a.ts",
      "  [ ] b.ts",
    ].join("\n");
    const tree = parseInspectTree(raw);
    const depths = (tree?.entries ?? []).map((e) => e.depth);
    expect(depths).toEqual([0, 1, 1]);
  });

  test("bare single-file line without size meta parses", () => {
    const out = parseInspectTree("file.txt");
    // THE FIX: size meta is optional — a bare filename is a valid result.
    expect(out).not.toBeNull();
    expect(out?.entries?.length).toBe(1);
    expect(out?.entries?.[0].name).toBe("file.txt");
  });

  test("single-file line with size meta still parses", () => {
    const out = parseInspectTree("file.txt (4.2 kB, 10 lines, 2024-01-02 10:00)");
    expect(out?.entries?.[0].name).toBe("file.txt");
    expect(out?.entries?.[0].size).toBe("4.2 kB");
    expect(out?.entries?.[0].lines).toBe(10);
  });
});

describe("Bug 39 — parseGlobList accepts filenames starting with (", () => {
  test("a filename beginning with ( parses as a file", () => {
    const out = parseGlobList("(weird)name.ts\nfoo.ts");
    // THE FIX: the truncation marker is detected by its EXACT regex above;
    // the old startsWith("(") heuristic rejected legit names.
    expect(out?.files).toEqual(["(weird)name.ts", "foo.ts"]);
    expect(out?.truncated).toBe(false);
  });

  test("the truncation marker is still detected and stripped", () => {
    const out = parseGlobList("a.ts\nb.ts\n(Truncated: showing first 2 matches)");
    expect(out?.files).toEqual(["a.ts", "b.ts"]);
    expect(out?.truncated).toBe(true);
  });

  test("no match message still parses", () => {
    expect(parseGlobList("No files matched the pattern.")).toEqual({ none: true, files: [], truncated: false });
  });
});
