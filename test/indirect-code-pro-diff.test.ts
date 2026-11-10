import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  escapeHtml,
  highlightCodeLines,
  languageForPath,
  mapHljsClasses,
  preloadCodeHighlight,
  splitHighlightedLines,
} from "../web/src/indirect-code/utils/lang";
import {
  deriveDualLineNumbers,
  deriveLineNumbers,
  diffRows,
  parseDiffLine,
} from "../web/src/indirect-code/utils/diffLines";
import {
  applyInlineDiffToHtml,
  buildDiffRows,
  computeInlineDiff,
  pairReplacementBlock,
} from "../web/src/indirect-code/utils/inlineDiff";

/**
 * Verify that an HTML fragment contains only strictly balanced, non-empty
 * `<span ...>...</span>` tags and return its decoded plain text + span tree info.
 */
function inspectSpanHtml(html: string): {
  decodedText: string;
  classes: string[];
  wordAddTexts: string[];
  wordDelTexts: string[];
} {
  const stack: string[] = [];
  const classes: string[] = [];
  const wordAddTexts: string[] = [];
  const wordDelTexts: string[] = [];
  let currentWordAdd: string | null = null;
  let currentWordDel: string | null = null;
  let decodedText = "";

  // Ensure zero empty `<span ...></span>` tags.
  expect(html).not.toMatch(/<span\b[^>]*><\/span>/);

  const tokenRe = /<span\s+class="([^"]*)">|<\/span>|<[^>]*>|&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z0-9]+);|[\s\S]/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const tok = m[0];
    if (m[1] !== undefined) {
      const cls = m[1];
      stack.push(cls);
      classes.push(cls);
      if (cls === "rc-diff-word-add") currentWordAdd = "";
      if (cls === "rc-diff-word-del") currentWordDel = "";
    } else if (tok === "</span>") {
      expect(stack.length).toBeGreaterThan(0);
      const popped = stack.pop()!;
      if (popped === "rc-diff-word-add" && currentWordAdd !== null) {
        wordAddTexts.push(currentWordAdd);
        currentWordAdd = null;
      }
      if (popped === "rc-diff-word-del" && currentWordDel !== null) {
        wordDelTexts.push(currentWordDel);
        currentWordDel = null;
      }
    } else if (tok.startsWith("<")) {
      throw new Error(`Unexpected raw tag or unescaped '<' in HTML: ${tok} (full: ${html})`);
    } else {
      let ch = tok;
      if (tok === "&amp;") ch = "&";
      else if (tok === "&lt;") ch = "<";
      else if (tok === "&gt;") ch = ">";
      else if (tok === "&quot;") ch = '"';
      else if (tok === "&apos;" || tok === "&#39;" || tok === "&#x27;") ch = "'";
      else if (tok.startsWith("&#x") || tok.startsWith("&#X")) {
        ch = String.fromCodePoint(parseInt(tok.slice(3, -1), 16));
      } else if (tok.startsWith("&#")) {
        ch = String.fromCodePoint(parseInt(tok.slice(2, -1), 10));
      }
      decodedText += ch;
      if (currentWordAdd !== null) currentWordAdd += ch;
      if (currentWordDel !== null) currentWordDel += ch;
    }
  }

  expect(stack).toEqual([]);
  return { decodedText, classes, wordAddTexts, wordDelTexts };
}

describe("pro-grade language resolution & hljs class mapping", () => {
  test("maps common basenames, lockfiles, and dotfiles accurately", () => {
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("ops/Dockerfile.prod")).toBe("dockerfile");
    expect(languageForPath("Containerfile")).toBe("dockerfile");
    expect(languageForPath("Makefile")).toBe("makefile");
    expect(languageForPath("GNUmakefile")).toBe("makefile");
    expect(languageForPath("Justfile")).toBe("makefile");
    expect(languageForPath("CMakeLists.txt")).toBe("cmake");
    expect(languageForPath("indirect-code-daemon/go.mod")).toBe("go");
    expect(languageForPath("indirect-code-daemon/go.sum")).toBe("plaintext");
    expect(languageForPath("Cargo.lock")).toBe("ini");
    expect(languageForPath(".gitignore")).toBe("ini");
    expect(languageForPath(".dockerignore")).toBe("ini");
    expect(languageForPath(".npmrc")).toBe("ini");
    expect(languageForPath(".editorconfig")).toBe("ini");
    expect(languageForPath(".env")).toBe("ini");
    expect(languageForPath(".env.production")).toBe("ini");
    expect(languageForPath(".bashrc")).toBe("bash");
    expect(languageForPath(".zshrc")).toBe("bash");
    expect(languageForPath("UNKNOWN_EXTENSIONLESS_FILE")).toBeUndefined();
  });

  test("maps multi-class tiered hljs scopes cleanly without dangling modifiers", () => {
    const sample = [
      '<span class="hljs-title class_ inherited__">BaseWidget</span>',
      '<span class="hljs-title function_ invoke__">computeDiff</span>',
      '<span class="hljs-variable language_">this</span>',
      '<span class="hljs-property">lineNum</span>',
      '<span class="hljs-comment">/** doc */</span>',
    ].join(" ");
    const mapped = mapHljsClasses(sample);
    expect(mapped).toContain('class="tok-class"');
    expect(mapped).toContain('class="tok-fn"');
    expect(mapped).toContain('class="tok-var"');
    expect(mapped).toContain('class="tok-attr"');
    expect(mapped).toContain('class="tok-com"');
    expect(mapped).not.toMatch(/function_|class_|inherited__|invoke__|language_/);
  });

  test("never runs highlightAuto when language is undefined", async () => {
    await preloadCodeHighlight();
    const unknownLines = [
      "# plain note with 'single quote' and -- dashes",
      "const for return if else ; select * from table",
    ];
    const htmlLines = await highlightCodeLines(unknownLines, undefined);
    expect(htmlLines).toEqual(unknownLines.map(escapeHtml));
  });
});

describe("stateful multi-line syntax highlighting & HTML span balancer", () => {
  test("balances nested spans across newlines via splitHighlightedLines", () => {
    const rawHtml =
      '<span class="tok-com">/**\n * <span class="tok-doc">@param</span> x\n * details\n */</span>\n<span class="tok-kw">const</span> x = <span class="tok-num">1</span>;';
    const lines = splitHighlightedLines(rawHtml);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      inspectSpanHtml(line);
    }
    expect(lines[0]).toBe('<span class="tok-com">/**</span>');
    expect(lines[1]).toBe('<span class="tok-com"> * <span class="tok-doc">@param</span> x</span>');
    expect(lines[2]).toBe('<span class="tok-com"> * details</span>');
    expect(lines[3]).toBe('<span class="tok-com"> */</span>');
    expect(lines[4]).toContain('class="tok-kw"');
  });

  test("preserves .tok-com across multi-line block comments spanning context, -, and + diff lines", async () => {
    const diff = [
      "--- a/src/engine.ts",
      "+++ b/src/engine.ts",
      "@@ -1,6 +1,7 @@",
      " /**",
      "- * Old comment mentioning for const and return keywords */",
      "+ * New comment mentioning for const and return keywords",
      "+ * across multiple added lines with type interface class",
      "+ */",
      " export function run(): boolean {",
      "   return true;",
    ].join("\n");

    const parsed = diffRows(diff);
    const rendered = await buildDiffRows(parsed, languageForPath("src/engine.ts"));

    for (const row of rendered) {
      const info = inspectSpanHtml(row.codeHtml);
      expect(info.decodedText).toBe(row.rawCode);
    }

    // Every comment line (context `/**`, del line, and all 3 add lines) MUST be
    // `.tok-com` and MUST NOT highlight `for`/`const`/`return`/`type` as `.tok-kw`!
    const commentRows = rendered.slice(1, 6);
    expect(commentRows).toHaveLength(5);
    for (const r of commentRows) {
      const info = inspectSpanHtml(r.codeHtml);
      expect(info.classes).toContain("tok-com");
      expect(info.classes).not.toContain("tok-kw");
    }

    // Live code immediately following `*/` highlights keywords normally.
    const exportRow = rendered[6]!;
    expect(inspectSpanHtml(exportRow.codeHtml).classes).toContain("tok-kw");
  });

  test("handles unified diff hunks starting mid-block-comment without breaking regex literals", async () => {
    const midCommentDiff = [
      "@@ -18,5 +18,5 @@",
      "  * Middle of long JSDoc with const and return",
      "- * old parameter description for value",
      "+ * new parameter description for value",
      "  */",
      " const pattern = /foo*/;",
    ].join("\n");

    const rendered = await buildDiffRows(diffRows(midCommentDiff), "typescript");
    // Lines 1..4 inside the hunk are the tail of the open JSDoc comment.
    for (const r of rendered.slice(1, 5)) {
      const info = inspectSpanHtml(r.codeHtml);
      expect(info.classes).toContain("tok-com");
      expect(info.classes).not.toContain("tok-kw");
    }
    // Line 5 (`const pattern = /foo*/;`) is live code!
    const codeInfo = inspectSpanHtml(rendered[5]!.codeHtml);
    expect(codeInfo.classes).toContain("tok-kw");

    // A normal hunk containing `const pattern = /foo*/;` (no open comment) must NOT treat it as a comment closer.
    const regexHunk = [
      "@@ -1,3 +1,3 @@",
      " const first = 1;",
      "-const pattern = /foo*/;",
      "+const pattern = /bar*/;",
    ].join("\n");
    const regexRendered = await buildDiffRows(diffRows(regexHunk), "typescript");
    expect(inspectSpanHtml(regexRendered[1]!.codeHtml).classes).toContain("tok-kw");
    expect(inspectSpanHtml(regexRendered[1]!.codeHtml).classes).not.toContain("tok-com");
  });

  test("highlights # comments in YAML, Python, and Dockerfile plus multi-line Python docstrings & HTML comments", async () => {
    for (const [filename, snippet] of [
      ["config.yaml", "@@ -1,2 +1,2 @@\n # YAML comment with const and true\n-port: 3000\n+port: 8080"],
      ["script.py", '@@ -1,5 +1,5 @@\n # Python hash comment\n """\n-old docstring def return\n+new docstring class import\n """'],
      ["Dockerfile", "@@ -1,3 +1,3 @@\n # Base container image\n-FROM alpine:3.18\n+FROM alpine:3.20"],
      ["view.html", "@@ -1,4 +1,4 @@\n <!--\n-  <div>old comment</div>\n+  <div>new comment</div>\n -->"],
    ] as const) {
      const rendered = await buildDiffRows(diffRows(snippet), languageForPath(filename));
      const commentRow = rendered[1]!;
      const info = inspectSpanHtml(commentRow.codeHtml);
      expect(info.classes).toContain("tok-com");
      for (const r of rendered) {
        expect(inspectSpanHtml(r.codeHtml).decodedText).toBe(r.rawCode);
      }
    }
  });
});

describe("unified diff parsing, dual gutters, hunk headers & no-newline metadata", () => {
  test("treats '\\ No newline at end of file' as non-code metadata without shifting line numbers", () => {
    const unified = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,3 @@ export function greet() {",
      "   const prefix = 'hi';",
      "-  return prefix;",
      "\\ No newline at end of file",
      "+  return `${prefix}!`;",
      "@@ -25,2 +25,2 @@ export function bye() {",
      "   const done = true;",
      "-  return false;",
      "+  return done;",
      "\\ No newline at end of file",
    ].join("\n");

    const lineNums = deriveLineNumbers(unified);
    expect(lineNums).toEqual(["", "10", "11", "", "11", "", "25", "26", "26", ""]);
    expect(parseDiffLine("\\ No newline at end of file")).toEqual({
      lineNum: "",
      marker: "",
      code: "\\ No newline at end of file",
      kind: "meta",
    });

    const dual = deriveDualLineNumbers(unified)!;
    expect(dual[3]).toEqual({ lineNum: "", oldLineNum: "", newLineNum: "" });
    // Line after `\ No newline` in hunk 1 MUST be newLine 11, NOT 12!
    expect(dual[4]).toEqual({ lineNum: "11", oldLineNum: "", newLineNum: "11" });
    // Hunk 2 stays aligned as well.
    expect(dual[6]).toEqual({ lineNum: "25", oldLineNum: "25", newLineNum: "25" });

    const rows = diffRows(unified);
    expect(rows[0]!.hunkHeader).toEqual({
      range: "@@ -10,3 +10,3 @@",
      context: "export function greet() {",
    });
    expect(rows[0]!.kind).toBe("ellipsis");
    expect(rows[3]!.kind).toBe("meta");
    expect(rows[3]!.lineNum).toBe("");
    expect(rows[3]!.oldLineNum).toBe("");
    expect(rows[3]!.newLineNum).toBe("");
  });

  test("populates dual old/new line numbers for unified diffs while keeping single numbers for daemon edit diffs", () => {
    const unified = [
      "@@ -5,3 +5,4 @@",
      " keep_a",
      "-old_b",
      "+new_b1",
      "+new_b2",
      " keep_c",
    ].join("\n");

    const uRows = diffRows(unified);
    expect(uRows.map((r) => [r.oldLineNum, r.newLineNum])).toEqual([
      ["", ""],
      ["5", "5"],
      ["6", ""],
      ["", "6"],
      ["", "7"],
      ["7", "8"],
    ]);

    const editToolDiff = "12:-const x = 1;\n12:+const x = 2;\n13: return x;";
    const eRows = diffRows(editToolDiff);
    expect(eRows[0]!.oldLineNum).toBeUndefined();
    expect(eRows[0]!.newLineNum).toBeUndefined();
    expect(eRows.map((r) => r.lineNum)).toEqual(["12", "12", "13"]);
  });
});

describe("intra-line word & character diffing + HTML entity/span interleaving", () => {
  test("highlights precise token/subword edits and coalesces 1-2 char islands", () => {
    // Subword + alphabetic stem refinement (`renderItem` -> `renderItems` highlights only `s`)
    const plural = computeInlineDiff("  return renderItem(id);", "  return renderItems(id);");
    expect(plural.paired).toBe(true);
    expect(plural.delRanges).toEqual([]);
    expect(plural.addRanges).toEqual([{ start: 19, end: 20 }]);
    expect("  return renderItems(id);".slice(19, 20)).toBe("s");

    // Numbers replace as whole numeric tokens (`1000` -> `5000`, never `1` -> `5`)
    const numeric = computeInlineDiff("const timeout = 1000;", "const timeout = 5000;");
    expect(numeric.paired).toBe(true);
    expect("const timeout = 1000;".slice(numeric.delRanges[0]!.start, numeric.delRanges[0]!.end)).toBe("1000");
    expect("const timeout = 5000;".slice(numeric.addRanges[0]!.start, numeric.addRanges[0]!.end)).toBe("5000");

    // 1-2 char island between adjacent edits coalesces into one crisp highlight
    const island = computeInlineDiff("const size = 12px;", "const size = 24rem;");
    expect(island.paired).toBe(true);
    expect(island.delRanges).toHaveLength(1);
    expect(island.addRanges).toHaveLength(1);

    // >=3 char unchanged separator (` = `) stays unhighlighted between two separate edits
    const twoEdits = computeInlineDiff("  oldKey = 10;", "  newKey = 20;");
    expect(twoEdits.paired).toBe(true);
    expect(twoEdits.delRanges.map((r) => "  oldKey = 10;".slice(r.start, r.end))).toEqual(["old", "10"]);
    expect(twoEdits.addRanges.map((r) => "  newKey = 20;".slice(r.start, r.end))).toEqual(["new", "20"]);
  });

  test("gates out completely unrelated replacement lines even with heavy shared indentation", () => {
    const unrelated = computeInlineDiff(
      "            return null;",
      "            throw new Error(msg);",
    );
    expect(unrelated.paired).toBe(false);
    expect(unrelated.delRanges).toEqual([]);
    expect(unrelated.addRanges).toEqual([]);

    const blankVsCode = computeInlineDiff("    ", "    const a = 1;");
    expect(blankVsCode.paired).toBe(false);
  });

  test("aligns multi-line replacement blocks via order-preserving DP", () => {
    const delLines = [
      "  const url = buildUrl(oldHost, port);",
      "  return fetchJson(url);",
    ];
    const addLines = [
      "  const url = buildUrl(newHost, port, true);",
      "  auditRequest(url);",
      "  return fetchJson(url, { retries: 2 });",
    ];

    const block = pairReplacementBlock(delLines, addLines);
    // `delLines[0]` pairs with `addLines[0]` (`old` -> `new`, plus `, true` added)
    expect(block.delRangesByIndex.has(0)).toBe(true);
    expect(block.addRangesByIndex.has(0)).toBe(true);
    // Newly inserted middle line `addLines[1]` stays unpaired (no false confetti!)
    expect(block.addRangesByIndex.has(1)).toBe(false);
    // `delLines[1]` pairs with `addLines[2]` (pure insertion `, { retries: 2 }` on add side!)
    expect(block.delRangesByIndex.has(1)).toBe(false);
    expect(block.addRangesByIndex.has(2)).toBe(true);
    const r2 = block.addRangesByIndex.get(2)!;
    expect(addLines[2]!.slice(r2[0]!.start, r2[0]!.end)).toBe(", { retries: 2 }");
  });

  test("interleaves word-diff spans cleanly across HTML entities (<, >, &, quotes, emoji) and nested .tok-* spans", async () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      "-const ok = a < 10 && label === \"old's 🚀\" && b > 0;",
      "\\ No newline at end of file",
      "+const ok = a <= 25 && label === \"new's 🚀\" && b >= 1;",
    ].join("\n");

    const rendered = await buildDiffRows(diffRows(diff), "typescript");
    const delRow = rendered[1]!;
    const addRow = rendered[3]!;

    const delInfo = inspectSpanHtml(delRow.codeHtml);
    const addInfo = inspectSpanHtml(addRow.codeHtml);

    // Exact decoded source text preserved despite `&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#x27;`, and `🚀`.
    expect(delInfo.decodedText).toBe(delRow.rawCode);
    expect(addInfo.decodedText).toBe(addRow.rawCode);

    // Syntax token foreground spans remain intact AND word-diff spans highlight exact changes!
    expect(delInfo.classes).toContain("tok-kw");
    expect(delInfo.classes).toContain("tok-str");
    expect(delInfo.classes).toContain("tok-num");
    expect(delInfo.classes).toContain("rc-diff-word-del");
    expect(addInfo.classes).toContain("rc-diff-word-add");

    expect(delInfo.wordDelTexts.join("|")).toContain("10");
    expect(delInfo.wordDelTexts.join("|")).toContain("old");
    expect(addInfo.wordAddTexts.join("|")).toContain("25");
    expect(addInfo.wordAddTexts.join("|")).toContain("new");

    // Also test direct boundary splitting across an entity immediately before a syntax span.
    const rawHtml = 'a &lt; <span class="tok-num">10</span> &amp; b';
    const overlaid = applyInlineDiffToHtml(rawHtml, [{ start: 2, end: 6 }], "rc-diff-word-add");
    const overlaidInfo = inspectSpanHtml(overlaid);
    expect(overlaidInfo.decodedText).toBe("a < 10 & b");
    expect(overlaidInfo.wordAddTexts.join("")).toBe("< 10");
  });
});

describe("code.css pro-diff tokens & mobile sidebar rule cleanup", () => {
  test("declares semantic diff styles and removes legacy mobile inline row-action rules", () => {
    const css = readFileSync("web/src/styles/code.css", "utf8");
    expect(css).toContain(".rc-diff-word-add");
    expect(css).toContain(".rc-diff-word-del");
    expect(css).toContain(".rc-diff-hunk");
    expect(css).not.toContain("html.mobile .rc-sidebar .rc-row-actions");
    expect(css).not.toContain("html.mobile .rc-sidebar .rc-row-time");
    expect(css).not.toContain("html.mobile .rc-sidebar .rc-row-action");
    expect(css).toContain("html.mobile .rc-sidebar-toggle");
    expect(css).toContain("html.mobile .rc-composer-add");
    expect(css).toContain("html.mobile .rc-composer-send");
  });
});
