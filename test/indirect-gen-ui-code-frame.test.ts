import { describe, expect, test } from "bun:test";

import { createCodeFrame } from "../web/src/indirect-code/components/generative-ui/code-frame";
import { compileWidgetForLint } from "../web/src/indirect-code/components/generative-ui/lint-compile";

/**
 * Code frames point at the MODEL's original source (the lint compiles with
 * sucrase + source map, so frames come from real original positions).
 */
describe("createCodeFrame", () => {
  const source = ["line one", "line two", "line three", "line four", "line five"].join("\n");

  test("gutter + caret under the column", () => {
    const frame = createCodeFrame(source, { line: 3, column: 6, context: 1 });
    expect(frame).toBe(["2 | line two", "3 | line three", "  |      ^", "4 | line four"].join("\n"));
  });

  test("context clamps at the ends", () => {
    const frame = createCodeFrame(source, { line: 1, context: 1 });
    expect(frame.split("\n")[0]).toBe("1 | line one");
    expect(frame).toContain("2 | line two");
    expect(frame).not.toContain("3 |");
    const last = createCodeFrame(source, { line: 5, context: 1 });
    expect(last).toContain("5 | line five");
    expect(last).not.toContain("6 |");
  });

  test("no column means no caret row", () => {
    const frame = createCodeFrame(source, { line: 2, context: 1 });
    expect(frame).toBe(["1 | line one", "2 | line two", "3 | line three"].join("\n"));
  });

  test("wider gutters keep the caret aligned", () => {
    const many = Array.from({ length: 12 }, (_, i) => `x${i + 1}`).join("\n");
    const frame = createCodeFrame(many, { line: 10, column: 2, context: 1 });
    const lines = frame.split("\n");
    expect(lines[0]).toBe(" 9 | x9");
    expect(lines[1]).toBe("10 | x10");
    expect(lines[2]).toBe("   |  ^");
  });
});

describe("lint compile maps back to the model source", () => {
  test("syntax errors carry the original line (JSX above reflows)", () => {
    const src = `export default function App() {
  return (
    <div className="x">
      <span>hi</span>
    </div>
  );
}

export function broken() {
  const x = ;
}
`;
    const res = compileWidgetForLint(src);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.pos?.line).toBe(10);
  });

  test("audit findings land on original lines", () => {
    const src = `export default function App() {
  const [n] = useState(0);
  globalThis.fetch("https://evil.example/x");
  return <div>{n}</div>;
}
`;
    const res = compileWidgetForLint(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.findings[0].line).toBe(3);
  });

  test("SourceMapIndex resolves generated positions through a real sucrase map", () => {
    const src = `const a = 1;
const b = 2;
export default a + b;
`;
    const res = compileWidgetForLint(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // sucrase is line-preserving: generated line 2 is original line 2.
    const pos = res.map.originalPositionFor(2, 0);
    expect(pos?.line).toBe(2);
    expect(res.map.originalPositionFor(99, 0)).toBeNull();
  });
});
