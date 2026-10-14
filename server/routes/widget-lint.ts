/**
 * Generative UI widget lint runner (server side).
 *
 * Pipeline: compile (sucrase + the model-code audit — line-preserving, so
 * every finding maps back to the MODEL's source) → smoke render in the
 * Obscura lint browser (a REAL isolated browser process: no `process`, no
 * `require`, no gateway access from widget code) → optional test code run
 * against the widget module's exports. Errors carry a code frame of the
 * original source (createCodeFrame), pointing at the exact region to fix.
 *
 * There is NO fallback browser: obscura is fetched/installed on demand
 * (see obscura.ts) and a lint without it fails loudly. One obscura process
 * per lint (spawns in ~50ms) — a widget that spins forever is killed with
 * the process, never with the gateway.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileWidgetForLint, SourceMapIndex, type SourcePosition } from "../../web/src/indirect-code/components/generative-ui/lint-compile";
import { createCodeFrame } from "../../web/src/indirect-code/components/generative-ui/code-frame";
import { buildJsxModuleBody, escapeScriptClose } from "../../web/src/indirect-code/components/generative-ui/model-code";
import { buildReactShimModule, buildRuntimeScript, WIDGET_BASE_CSS } from "../../web/src/indirect-code/components/generative-ui/widget-doc";
import { REACT_RUNTIME_JS } from "../../web/src/indirect-code/components/generative-ui/react-runtime";
import { WEBGL_POLYFILL_JS } from "../../web/src/indirect-code/components/generative-ui/webgl-polyfill";
import { SVG_METRICS_POLYFILL_JS } from "../../web/src/indirect-code/components/generative-ui/svg-metrics-polyfill";
import { BROWSER_SHIMS_JS } from "../../web/src/indirect-code/components/generative-ui/browser-shims";
import { ensureObscuraBrowser } from "./obscura";
import { readVendorFile, referencedLibModules } from "./gen-ui-libs";

export type WidgetLintError = {
  phase: "compile" | "audit" | "render" | "test";
  message: string;
  line?: number;
  column?: number;
};

/** One error as the lint page reports it (file + compiled position). */
type PageError = WidgetLintError & { file?: string };

/** Appends an original-source code frame to a lint message. */
function withFrame(message: string, source: string, pos?: SourcePosition): string {
  if (!pos?.line || !source) return message;
  return `${message}
${createCodeFrame(source, { line: pos.line, column: pos.column >= 0 ? pos.column + 1 : undefined })}`;
}

export type WidgetLintResult = {
  ok: boolean;
  errors: WidgetLintError[];
  output: string;
  durationMs: number;
  /** Non-fatal observations (3D/WebGL exercise stats, polyfill notes). */
  notes?: string[];
};

export type WidgetLintRequest = {
  id: string;
  source: string;
  test?: string;
  state?: string;
};

/** Hard ceiling for one lint (browser navigation deadline, seconds). */
const LINT_TIMEOUT_S = 30;
/** Extra test code gets a tighter budget so a hanging test can't stall. */
const TEST_TIMEOUT_S = 10;

/* ---------------- reporting contract (the lint page) ---------------- */

/**
 * The lint page sets `window.__lint_result` as the work progresses and
 * freezes it (`done: true`) when finished. The runner evals the JSON of it;
 * errors that escape the harness land in `errors` via the page's error
 * hooks.
 */
function lintPageHTML(stateJSON: string, hasTest: boolean, libEntries: Record<string, string>): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<style>${WIDGET_BASE_CSS}</style>
<script>${escapeScriptClose(REACT_RUNTIME_JS)}</script>
<script>${escapeScriptClose(WEBGL_POLYFILL_JS)}</script>
<script>${escapeScriptClose(SVG_METRICS_POLYFILL_JS)}</script>
<script>${escapeScriptClose(BROWSER_SHIMS_JS)}</script>
<script type="importmap">${JSON.stringify({
    imports: {
      react: "./react-shim.js",
      "react/jsx-runtime": "./react-shim.js",
      "react/jsx-dev-runtime": "./react-shim.js",
      "react-dom": "./react-shim.js",
      "react-dom/client": "./react-shim.js",
      widget: "./widget.js",
      "./widget": "./widget.js",
      "./widget.js": "./widget.js",
      // Vendored lib bundles the module references (d3, three, …) — same
      // files the served widget docs map, written next to the lint page.
      ...libEntries,
    },
  })}</script>
<script>${escapeScriptClose(buildRuntimeScript({ stateJSON }))}</script>
<script>
window.__lint_result = { errors: [], output: [], done: false, webgl: null };
// WebGL availability for the 3D path: the polyfill installs before any
// widget code runs and reports what it did (contexts, programs, draws).
(function () {
  var pf = window.__guWebglPolyfill;
  window.__lint_result.webgl = {
    installed: !!(pf && pf.installed),
    native: !!(pf && pf.reason === "native-webgl-available"),
    summary: pf && pf.summary ? pf.summary() : null
  };
})();
// Best-effort position extraction from a runtime error (widget.js:12:5 …).
window.__lint_pos = function (e) {
  var s = ((e && e.stack) || "") + "";
  var m = /((?:widget|test)\\.js):(\\d+):(\\d+)/.exec(s);
  if (m) return { file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10) };
  var l = /(\\d+)/.exec(s);
  return { file: "widget.js", line: (e && e.lineno) || undefined, column: undefined };
};
window.__lint_push = function (phase, e, fallback) {
  var p = window.__lint_pos(e);
  window.__lint_result.errors.push({
    phase: phase,
    message: String((e && e.message) || e || fallback).slice(0, 2000),
    line: p.line,
    column: p.column,
    file: p.file
  });
};
// The REAL widget runtime reports through $onError (full error object,
// stack included — the lint extracts positions from it) and through
// { __gu: "error" } host messages (same channel production uses; message
// only). Host bridge calls (sendPrompt/openLink/resize/saveState) are the
// contract itself, not findings.
window.__gu.onError(function (e) { window.__lint_push("render", e, "widget error"); });
window.addEventListener("message", function (ev) {
  var d = ev.data;
  if (d && d.__gu === "error") window.__lint_push("render", { message: d.message }, "widget error");
});
window.addEventListener("error", function (ev) {
  window.__lint_push("render", ev.error || ev, ev.message || "uncaught error");
});
window.addEventListener("unhandledrejection", function (ev) {
  window.__lint_push("render", ev.reason || ev, "unhandled rejection");
});
</script>
<script type="module">
const R = window.__lint_result;
async function phase(name, url, runFn) {
  const before = R.errors.length;
  try {
    const mod = await import(url);
    if (runFn) await runFn(mod);
  } catch (e) {
    R.errors.push({ phase: name, message: String((e && e.message) || e).slice(0, 2000) });
  }
  return R.errors.length === before;
}
if (await phase("render", "./widget.js")) R.output.push("render: ok");
// The widget mounts on the next animation frame (the runtime's $render).
// EXERCISE it then: pump real frames + timers for a while so update-phase
// bugs (game loops, setState ticks, resize handlers) land in errors too —
// a mount-only smoke render misses every "works until the first tick"
// failure.
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
await new Promise((r) => {
  const t0 = Date.now();
  const tick = () => {
    if (Date.now() - t0 > 1200) r();
    else requestAnimationFrame(tick);
  };
  tick();
});
${hasTest ? `if (await phase("test", "./test.js", (mod) => mod.default)) R.output.push("test: ok");` : ""}
try {
  var pf = window.__guWebglPolyfill;
  if (pf && pf.summary) {
    R.webgl = { installed: !!pf.installed, native: pf.reason === "native-webgl-available", summary: pf.summary() };
    // Shader compile/link diagnostics are REAL widget bugs (a driver reports
    // them the same way) — surface them as render findings.
    var se = (R.webgl.summary && R.webgl.summary.shaderErrors) || [];
    for (var wi = 0; wi < se.length; wi++) {
      R.errors.push({ phase: "render", message: "WebGL shader compile/link failed: " + se[wi], file: "widget.js" });
    }
  }
} catch (e) { /* stats are best-effort */ }
R.done = true;
</script>
</body></html>`;
}

/** The test module: the model's test code plus the exported fn runner. */
function testModuleSource(testCode: string): string {
  // escapeScriptClose is belt-and-braces: the test code is model-authored
  // and the module is inlined into a <script type="module"> tag.
  return `${escapeScriptClose(testCode)}
;export default (async () => {
  if (typeof test === "function") { await test(); }
  else if (typeof run === "function") { await run(); }
})();`;
}

/* ---------------- phases ---------------- */

function compilePhase(source: string): { ok: boolean; code: string; map: SourceMapIndex | null; errors: WidgetLintError[] } {
  const compiled = compileWidgetForLint(source);
  if (!compiled.ok) {
    const auditLike = /import|specifier|parseable|unsupported syntax|forbidden/i.test(compiled.error);
    return {
      ok: false,
      code: "",
      map: null,
      errors: [{
        phase: auditLike ? "audit" : "compile",
        message: withFrame(compiled.error, source, compiled.pos),
        line: compiled.pos?.line,
        column: compiled.pos?.column,
      }],
    };
  }
  // Capabilities the boundary stripped are lint findings too (with the
  // ORIGINAL line they sit on): the widget saved WITHOUT them, and the
  // model needs to know why its code behaves differently.
  const errors: WidgetLintError[] = compiled.findings.map((f) => ({
    phase: "audit" as const,
    line: f.line,
    column: f.column,
    message: withFrame(`${f.reason} — removed from the module (the widget runs without it)`, source, f.line ? { line: f.line, column: f.column ?? 0 } : undefined),
  }));
  return { ok: true, code: compiled.code, map: compiled.map, errors };
}

/* ---------------- entry ---------------- */

export async function runWidgetLint(req: WidgetLintRequest): Promise<WidgetLintResult> {
  try {
    return await runWidgetLintInner(req);
  } catch (e) {
    // The lint is the model's feedback loop: an internal failure must come
    // back as a finding with the real message, never as a thrown error.
    return {
      ok: false,
      errors: [{ phase: "compile", message: `internal lint error: ${e instanceof Error ? e.message : String(e)}` }],
      output: "",
      durationMs: 0,
    };
  }
}

async function runWidgetLintInner(req: WidgetLintRequest): Promise<WidgetLintResult> {
  const started = Date.now();
  const errors: WidgetLintError[] = [];
  const output: string[] = [];

  const compiled = compilePhase(req.source);
  if (!compiled.ok) {
    errors.push(...compiled.errors);
    return { ok: false, errors, output: "", durationMs: Date.now() - started };
  }
  // Stripped-capability findings are reported WITH the render (the module
  // was sanitized, so it still runs — but the model must know what went).
  errors.push(...compiled.errors);

  let stateJSON = "{}";
  const rawState = typeof req.state === "string" ? req.state.trim() : "";
  if (rawState) {
    try {
      stateJSON = JSON.stringify(JSON.parse(rawState));
    } catch {
      errors.push({ phase: "render", message: `state header is not valid JSON: ${rawState.slice(0, 120)}` });
    }
  }

  let testModule: string | null = null;
  let testMap: SourceMapIndex | null = null;
  const testSource = req.test ?? "";
  if (req.test && req.test.trim()) {
    // The test imports the widget module with the "widget" specifier —
    // route it through an allowed placeholder for the audit, then back to
    // the colocated ./widget.js the lint page maps.
    const placeholder = "https://esm.sh/__widget__";
    const widgetSpec = /(from\s*|\bimport\s*(?:\(\s*)?)(["'])(\.\/)?widget(\.tsx)?\2/g;
    const src = req.test.replace(widgetSpec, (_m, pre: string, q: string) => `${pre}${q}${placeholder}${q}`);
    if (!src.includes(placeholder)) {
      errors.push({ phase: "test", message: `test code must import the widget module ("widget" or "./widget") to exercise its exports` });
    } else {
      const compiledTest = compilePhase(src);
      if (!compiledTest.ok) {
        // The test-code boundary failure keeps the historical "audit"
        // phase label (the boundary = transform + audit).
        for (const e of compiledTest.errors) {
          errors.push({ ...e, phase: e.phase === "compile" ? "audit" : e.phase });
        }
      } else {
        for (const f of compiledTest.errors) errors.push(f);
        testMap = compiledTest.map;
        testModule = testModuleSource(compiledTest.code.split(placeholder).join("./widget.js"));
      }
    }
  }

  const { errors: renderErrors, webgl } = await runInObscura({
    widgetModule: buildJsxModuleBody(compiled.code),
    testModule,
    stateJSON,
    timeoutS: testModule ? Math.min(LINT_TIMEOUT_S, TEST_TIMEOUT_S + 5) : LINT_TIMEOUT_S,
    widgetMap: compiled.map,
    testMap: testMap,
    widgetSource: req.source,
    testSource: testSource,
  });
  // Shader compile/link failures reported by the WebGL polyfill are real
  // widget bugs (a driver reports them identically) — fail the lint with
  // them. Environment limitations of the lint browser (software
  // rasterization, no MSAA resolve, …) are NOT widget bugs: production
  // browsers have real WebGL. They surface as notes instead of failing.
  const isShaderBug = (m: string) => m.startsWith("WebGL shader compile/link failed:");
  const shaderBugs = renderErrors.filter((e) => isShaderBug(e.message));
  const real = renderErrors.filter((e) => !isLintEnvLimitation(e.message) && !isShaderBug(e.message));
  const envNotes = renderErrors.filter((e) => isLintEnvLimitation(e.message) && !isShaderBug(e.message));
  errors.push(...real, ...shaderBugs);
  const notes = webglNotes(webgl);
  for (const e of envNotes.slice(0, 3)) {
    notes.push(`lint-browser limitation (not a widget bug): ${e.message.split("\n")[0]}`);
  }
  if (!errors.some((e) => e.phase === "render")) {
    output.push("render: ok");
    if (testModule && !errors.some((e) => e.phase === "test")) output.push("test: ok");
  }

  return { ok: errors.length === 0, errors, notes, output: output.join("\n"), durationMs: Date.now() - started };
}

type ObscuraRun = {
  widgetModule: string;
  testModule: string | null;
  stateJSON: string;
  timeoutS: number;
  /** Original-source mapping + text for code frames (widget / test). */
  widgetMap: SourceMapIndex | null;
  testMap: SourceMapIndex | null;
  widgetSource: string;
  testSource: string;
};
type LintPageResult = { errors?: PageError[]; output?: string[]; done?: boolean; webgl?: WebGLReport | null };

/** WebGL availability + exercise stats reported by the lint page polyfill. */
type WebGLReport = {
  installed?: boolean;
  native?: boolean;
  summary?: {
    contexts?: number;
    programs?: number;
    shaders?: number;
    drawCalls?: number;
    clearCalls?: number;
    compileErrors?: number;
    linkErrors?: number;
    uniformsSet?: number;
    textures?: number;
    buffers?: number;
    warnings?: string[];
    shaderErrors?: string[];
  } | null;
};

/**
 * Turns the WebGL report into non-fatal notes: how much of the 3D path the
 * smoke render actually exercised. Only widgets that actually used WebGL
 * get a note (that it was tested on the polyfill); a 2D widget says nothing.
 */
function webglNotes(webgl: WebGLReport | null | undefined): string[] {
  if (!webgl) return [];
  const s = webgl.summary;
  if (!s) return [];
  if ((s.contexts ?? 0) === 0) return []; // never exercised: nothing to report
  const via = webgl.native ? "WebGL" : "WebGL polyfill (software)";
  const notes: string[] = [];
  notes.push(
    `3D exercised via ${via}: ${s.contexts} context(s), ${s.programs} program(s), ` +
      `${s.shaders} shader(s), ${s.drawCalls} draw call(s), ${s.uniformsSet} uniform(s), ` +
      `${s.textures} texture(s), ${s.buffers} buffer(s)`,
  );
  if (s.warnings && s.warnings.length > 0) notes.push(`3D notes: ${s.warnings.slice(0, 6).join("; ")}`);
  return notes;
}

/**
 * The lint browser ships no GPU. The WebGL polyfill makes the whole
 * three.js/WebGL API work in software, so 3D widgets ARE exercised there —
 * only things a polyfill cannot faithfully emulate (real rasterization,
 * MSAA resolve, GPU sync timing) may remain as environment limitations.
 * They surface as notes; every other render error is a finding.
 */
function isLintEnvLimitation(message: string): boolean {
  return /no 3d support|GPU device (?:lost|removed)|Error creating (?:GL|WebGL|a WebGL)|software-simplified by the (?:software )?polyfill/i.test(
    message,
  );
}

/** Same phase + same first line = the same finding (dual reporting paths). */
function dedupeErrors(errors: WidgetLintError[]): WidgetLintError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = e.phase + "\u0000" + e.message.split("\n")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Maps one page error (compiled position inside widget.js/test.js) back to
 * the MODEL's source and appends a code frame pointing at the region to fix.
 */
function finalizePageError(e: PageError, run: ObscuraRun): WidgetLintError {
  const isTest = e.file === "test.js" || e.phase === "test";
  const map = isTest ? run.testMap : run.widgetMap;
  const source = isTest ? run.testSource : run.widgetSource;
  let pos: SourcePosition | undefined;
  if (e.line && map) {
    const orig = map.originalPositionFor(e.line, typeof e.column === "number" && e.column > 0 ? e.column - 1 : 0);
    if (orig) pos = orig;
    else pos = { line: e.line, column: 0 };
  } else if (e.line) {
    pos = { line: e.line, column: 0 };
  }
  return {
    phase: e.phase,
    line: pos?.line,
    column: pos?.column,
    message: withFrame(String(e.message || "").slice(0, 2000), source, pos),
  };
}

/**
 * One obscura attempt. The `--eval` snapshot is taken when the page load
 * settles, which happens EARLY when the harness is blocked on a hanging
 * test — so a "not done" result is inconclusive and the runner retries
 * until the deadline.
 */
async function obscuraOnce(binary: string, dir: string, timeoutS: number): Promise<{ parsed: LintPageResult | null; raw: string; stderr: string }> {
  let proc;
  try {
    proc = Bun.spawn(
      [binary, "fetch", `file://${path.join(dir, "lint.html")}`, "--eval", "JSON.stringify(window.__lint_result)", "--quiet", "--timeout", String(timeoutS)],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch (e) {
    // posix_spawn ENOENT on an existing file = the dynamic loader is
    // missing (glibc binary on a musl/distroless image).
    return {
      parsed: null,
      raw: "",
      stderr:
        `lint browser cannot start (${e instanceof Error ? e.message : String(e)}) — ` +
        `obscura needs glibc: run the gateway on a glibc base image (e.g. debian:slim), ` +
        `install gcompat on Alpine, or set OBSCURA_PATH to a working binary`,
    };
  }
  const killer = setTimeout(() => proc.kill(), timeoutS * 1000 + 2000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(killer);
  const out = stdout.trim();
  let parsed: LintPageResult | null;
  try {
    parsed = out ? JSON.parse(out) : null;
  } catch {
    parsed = null;
  }
  return { parsed, raw: out, stderr };
}

async function runInObscura(run: ObscuraRun): Promise<{ errors: WidgetLintError[]; webgl: WebGLReport | null }> {
  let binary: string;
  try {
    binary = await ensureObscuraBrowser();
  } catch (e) {
    return {
      errors: [{ phase: "render", message: `lint browser unavailable: ${e instanceof Error ? e.message : String(e)}` }],
      webgl: null,
    };
  }

  const dir = mkdtempSync(path.join(tmpdir(), "gen-ui-lint-"));
  try {
    // Vendored lib bundles the widget (or test) references — a lib global
    // like `d3` lands here as an appended side-effect import. Missing
    // bundles stay missing on purpose: the import error is a real finding.
    const libEntries: Record<string, string> = {};
    const allCode = run.widgetModule + (run.testModule ? `\n${run.testModule}` : "");
    for (const [spec, file] of referencedLibModules(allCode)) {
      const source = readVendorFile(file);
      if (source == null) continue;
      mkdirSync(path.join(dir, "lib"), { recursive: true });
      writeFileSync(path.join(dir, "lib", file), source);
      libEntries[spec] = `./lib/${file}`;
    }
    writeFileSync(path.join(dir, "lint.html"), lintPageHTML(run.stateJSON, !!run.testModule, libEntries));
    writeFileSync(path.join(dir, "react-shim.js"), buildReactShimModule());
    writeFileSync(path.join(dir, "widget.js"), run.widgetModule);
    if (run.testModule) writeFileSync(path.join(dir, "test.js"), run.testModule);

    // The page is a file:// document with no gateway access — the browser
    // process IS the sandbox. `window.__lint_result.done` carries the
    // verdict; a hanging render/test never sets it, and the deadline below
    // is what turns that into a "timed out" lint error.
    const deadline = Date.now() + run.timeoutS * 1000;
    let last: Awaited<ReturnType<typeof obscuraOnce>> | null = null;
    while (Date.now() < deadline) {
      last = await obscuraOnce(binary, dir, Math.max(2, Math.ceil((deadline - Date.now()) / 1000)));
      if (last.parsed && last.parsed.done) {
        return {
          errors: dedupeErrors((last.parsed.errors || []).map((e) => finalizePageError(e, run))),
          webgl: last.parsed.webgl ?? null,
        };
      }
    }

    // Deadline passed without a finished result: a hang somewhere. Errors
    // recorded before the hang are real findings — keep them, append the
    // timeout verdict.
    const found = dedupeErrors((last?.parsed?.errors || []).map((e) => finalizePageError(e, run)));
    return {
      errors: [...found, { phase: run.testModule ? "test" : "render", message: `lint timed out after ${run.timeoutS}s` }],
      webgl: last?.parsed?.webgl ?? null,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
