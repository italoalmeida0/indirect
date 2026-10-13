/**
 * Generative UI `@jsx` compilation (server + tests only — do NOT import from
 * SPA-bundled code, sucrase is a node dependency).
 *
 * The @jsx format is plain React (JSX + TypeScript types allowed). The source
 * is compiled to `React.createElement` calls at document-build time with
 * sucrase — never inside the widget: the widget CSP has no 'unsafe-eval', so
 * the compiled plain JS is spliced into the doc as a normal script and the
 * embedded REACT_RUNTIME_JS provides the React globals it targets.
 *
 * The `imports` transform keeps this robust for idiomatic React code:
 * `import { useState } from "react"` and `export default App` compile to
 * require()/module.exports, and the widget wrapper supplies a tiny CommonJS
 * shim mapping react / react-dom / react-dom/client onto the runtime globals.
 * Anything genuinely unresolvable (a random package) throws at doc build
 * time and the widget shows a readable error instead of a dead frame.
 */
import { transform } from "sucrase";

export type JsxCompileResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

export function compileJsxModule(src: string): JsxCompileResult {
  try {
    const out = transform(src, {
      transforms: ["jsx", "typescript", "imports"],
      production: true,
    });
    return { ok: true, code: out.code };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
