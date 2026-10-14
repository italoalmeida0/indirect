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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileWidgetForLint, SourceMapIndex, type SourcePosition } from "../../web/src/indirect-code/components/generative-ui/lint-compile";
import { createCodeFrame } from "../../web/src/indirect-code/components/generative-ui/code-frame";
import { buildJsxModuleBody, escapeScriptClose } from "../../web/src/indirect-code/components/generative-ui/model-code";
import { buildReactShimModule } from "../../web/src/indirect-code/components/generative-ui/widget-doc";
import { REACT_RUNTIME_JS } from "../../web/src/indirect-code/components/generative-ui/react-runtime";
import { ensureObscuraBrowser } from "./obscura";

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
function lintPageHTML(stateJSON: string, hasTest: boolean): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script>${escapeScriptClose(REACT_RUNTIME_JS)}</script>
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
    },
  })}</script>
<script>
window.__lint_result = { errors: [], output: [], done: false };
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
window.__gu = {
  state: ${stateJSON},
  error: null,
  reportError: function (e) { window.__lint_push("render", e, "widget error"); },
  onDestroy: function () {},
  saveState: function () {}
};
window.addEventListener("error", function (ev) {
  window.__lint_push("render", ev.error || ev, ev.message || "uncaught error");
});
window.addEventListener("unhandledrejection", function (ev) {
  window.__lint_push("render", ev.reason, "unhandled rejection");
});
</script>
<script type="module">
// Top-level await all the way: the page's load event (and therefore
// obscura's --eval) waits for this module's completion — a dynamic
// import of a hanging test blocks it and trips the navigation deadline.
const R = window.__lint_result;
async function phase(name, url, runFn) {
  const before = R.errors.length;
  try {
    const mod = await import(url);
    if (runFn) await runFn(mod);
  } catch (e) {
    window.__lint_push(name, e, "error");
  }
  return R.errors.length === before;
}
if (await phase("render", "./widget.js")) R.output.push("render: ok (obscura smoke render)");
${hasTest ? `if (await phase("test", "./test.js", (mod) => mod.default)) R.output.push("test: ok");` : ""}
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
  if (req.state && req.state.trim()) {
    try {
      stateJSON = JSON.stringify(JSON.parse(req.state));
    } catch {
      errors.push({ phase: "render", message: `state header is not valid JSON: ${req.state.slice(0, 120)}` });
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

  const renderErrors = await runInObscura({
    widgetModule: buildJsxModuleBody(compiled.code),
    testModule,
    stateJSON,
    timeoutS: testModule ? Math.min(LINT_TIMEOUT_S, TEST_TIMEOUT_S + 5) : LINT_TIMEOUT_S,
    widgetMap: compiled.map,
    testMap: testMap,
    widgetSource: req.source,
    testSource: testSource,
  });
  errors.push(...renderErrors);
  if (!errors.some((e) => e.phase === "render")) {
    output.push("render: ok (obscura smoke render)");
    if (testModule && !errors.some((e) => e.phase === "test")) output.push("test: ok");
  }

  return { ok: errors.length === 0, errors, output: output.join("\n"), durationMs: Date.now() - started };
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
type LintPageResult = { errors?: PageError[]; output?: string[]; done?: boolean };

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
  const proc = Bun.spawn(
    [binary, "fetch", `file://${path.join(dir, "lint.html")}`, "--eval", "JSON.stringify(window.__lint_result)", "--quiet", "--timeout", String(timeoutS)],
    { stdout: "pipe", stderr: "pipe" },
  );
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

async function runInObscura(run: ObscuraRun): Promise<WidgetLintError[]> {
  let binary: string;
  try {
    binary = await ensureObscuraBrowser();
  } catch (e) {
    return [{ phase: "render", message: `lint browser unavailable: ${e instanceof Error ? e.message : String(e)}` }];
  }

  const dir = mkdtempSync(path.join(tmpdir(), "gen-ui-lint-"));
  try {
    writeFileSync(path.join(dir, "lint.html"), lintPageHTML(run.stateJSON, !!run.testModule));
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
        return (last.parsed.errors || []).map((e) => finalizePageError(e, run));
      }
    }

    // Deadline passed without a finished result: a hang somewhere. Errors
    // recorded before the hang are real findings — keep them, append the
    // timeout verdict.
    const found = (last?.parsed?.errors || []).map((e) => finalizePageError(e, run));
    return [...found, { phase: run.testModule ? "test" : "render", message: `lint timed out after ${run.timeoutS}s` }];
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
