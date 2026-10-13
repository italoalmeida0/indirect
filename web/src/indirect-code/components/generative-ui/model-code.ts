/**
 * Generative UI model-code boundary (server + tests only — do NOT import from
 * SPA-bundled code; this runs where Bun and the AST libraries are available).
 *
 * The model writes ordinary React code, but it is still model-authored code
 * running in a CSP-locked sandbox document. The enforcement layer for that
 * boundary is structural, not textual:
 *
 *   Bun.Transpiler (tsx -> ESM)   [jsx-compile.ts]
 *   -> acorn parse (ESTree)       — understand the code
 *   -> acorn-walk (ancestor)      — decide what is forbidden (the audit)
 *   -> tree surgery               — remove exactly those nodes
 *   -> astring generate           — deterministic, valid JS output
 *   -> escapeScriptClose          — belt-and-braces for string literals
 *
 * A regex sanitizer is fooled by anything it was not written against: the
 * same call hidden in a computed member, split across lines, or a benign
 * string that merely LOOKS like a call ("eval(" in a code sample) gets cut.
 * With a tree, string literals are data (never touched) and forbidden
 * capabilities are matched by node shape: a `fetch(...)` CallExpression is
 * removed wherever it appears, and `window.__gu.state` reads — which the
 * contract explicitly allows — survive.
 *
 * Forbidden capabilities (the prompt forbids them too; this is the
 * enforcement layer):
 *   - dynamic code: eval, new Function, Function(), importScripts
 *   - network: fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon
 *   - navigation: location assignment/calls, window.open, history writes
 *   - HTML injection sinks: innerHTML/outerHTML/insertAdjacentHTML,
 *     document.write(writeln), setAttribute with on* / javascript: names,
 *     javascript: URLs in href/src-like props
 *   - global pollution: assignment through window/document/globalThis
 *   - dynamic import of anything but https://esm.sh/ string literals
 *
 * Everything else compiles through verbatim (modulo astring formatting).
 * Unparseable code fails closed: it is rejected at compile time and dropped
 * by the sanitizer — code that cannot be parsed cannot be audited.
 */
import { parse, type Node } from "acorn";
import * as walk from "acorn-walk";
import { generate } from "astring";

// Loose ESTree shapes: acorn's Node union covers standard syntax, but the
// audit inspects arbitrary node fields generically.
type AnyNode = any;

/**
 * Re-escapes every "<script" / "</script" (in any case, with optional
 * whitespace) so model text spliced inside a <script> element can never
 * close it or open a sibling script.
 */
export function escapeScriptClose(raw: string): string {
  return raw.replace(/<\s*\/?\s*script/gi, "<\\/script");
}

/** `void 0` — the neutral replacement for a removed expression. */
function void0(): AnyNode {
  return { type: "UnaryExpression", operator: "void", prefix: true, argument: { type: "Literal", value: 0, raw: "0" } };
}

function isNode(v: unknown): v is AnyNode {
  return !!v && typeof v === "object" && typeof (v as AnyNode).type === "string";
}

/** Identifier name of `x` in `x.a.b[...]` (the root of a member chain). */
function rootIdentifier(node: AnyNode | null | undefined): string | null {
  let cur: AnyNode = node;
  while (cur && cur.type === "MemberExpression") cur = cur.object;
  return cur && cur.type === "Identifier" ? cur.name : null;
}

/** Property name of `a.b` / `a["b"]` when statically known. */
function propName(node: AnyNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/** Static member chain names: `a.b.c` -> ["b", "c"] (computed -> null). */
function memberProps(node: AnyNode | null | undefined): string[] | null {
  const props: string[] = [];
  let cur: AnyNode = node;
  while (cur && cur.type === "MemberExpression") {
    if (cur.computed) return null;
    const p = propName(cur.property);
    if (p === null) return null;
    props.unshift(p);
    cur = cur.object;
  }
  return cur && cur.type === "Identifier" ? props : null;
}

/** Globals a model may READ but never write (see the widget contract). */
const GLOBAL_ROOTS = new Set(["window", "document", "globalThis", "self", "top", "parent", "location"]);

const NAVIGATION_CALLS = new Set(["assign", "replace", "reload"]);
const HISTORY_CALLS = new Set(["pushState", "replaceState"]);
const DOCUMENT_CALLS = new Set(["write", "writeln"]);
/** Bare-identifier call targets that are always forbidden. */
const FORBIDDEN_IDENT_CALLS = new Set(["eval", "Function", "importScripts", "fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);
/** Member call tails that are forbidden on any receiver. */
const FORBIDDEN_ANY_RECEIVER_CALLS = new Set(["insertAdjacentHTML"]);
/** Attribute names that turn an element into a code/URL sink. */
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "formAction", "xlink:href", "data", "poster"]);

/** Specifiers the widget import map can resolve (see buildJsxImportMap). */
const RESOLVABLE_SPECIFIERS = new Set([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "d3",
  "gsap",
  "chart",
  "chart.js",
  "chart.js/auto",
  "three",
  "leaflet",
]);

/** URL literals allowed for module specifiers: the one vetted lib CDN. */
function allowedSpecifier(spec: string): boolean {
  return RESOLVABLE_SPECIFIERS.has(spec) || /^https:\/\/esm\.sh\//.test(spec);
}

function isJavascriptUrl(v: AnyNode | null | undefined): boolean {
  return !!v && v.type === "Literal" && typeof v.value === "string" && /^\s*javascript:/i.test(String(v.value));
}

/**
 * The audit: true when this expression exercises a forbidden capability.
 * Matched by node shape, so string literals and comments are never affected.
 */
function isForbiddenExpression(node: AnyNode): boolean {
  if (node.type === "ImportExpression") {
    // Only `import("https://esm.sh/...")` string literals are allowed (the
    // compile step rejects the rest with a proper error; the sanitizer
    // removes what slips through — an indirect specifier cannot be audited).
    const src: AnyNode = node.source;
    return !(src && src.type === "Literal" && typeof src.value === "string" && allowedSpecifier(src.value));
  }

  if (node.type === "CallExpression" || node.type === "NewExpression") {
    const callee: AnyNode = node.callee;
    if (callee && callee.type === "Identifier" && FORBIDDEN_IDENT_CALLS.has(callee.name)) return true;
    const tail = callee && callee.type === "MemberExpression" ? propName(callee.property) : null;
    if (tail) {
      if (FORBIDDEN_ANY_RECEIVER_CALLS.has(tail)) return true;
      const root = rootIdentifier(callee);
      if (root === "location" && NAVIGATION_CALLS.has(tail)) return true;
      // window.location.assign / top.location.replace / self.location.reload
      const props = memberProps(callee);
      if (props && props.includes("location") && NAVIGATION_CALLS.has(tail)) return true;
      if (root === "history" && HISTORY_CALLS.has(tail)) return true;
      if ((root === "window" || root === "self" || root === "top" || root === "parent") && tail === "open") return true;
      if (root === "document" && DOCUMENT_CALLS.has(tail)) return true;
      if (root === "navigator" && tail === "sendBeacon") return true;
      if (tail === "setAttribute") {
        // el.setAttribute("onclick", ...) and el.setAttribute(unknown, ...)
        // are injection sinks; a literal non-on* name is a plain attribute.
        const name: AnyNode = node.arguments?.[0];
        if (!name || name.type !== "Literal") return true;
        const n = String(name.value).toLowerCase();
        if (n.startsWith("on")) return true;
        if (URL_ATTRS.has(n) && isJavascriptUrl(node.arguments?.[1])) return true;
      }
    }
    return false;
  }

  if (node.type === "AssignmentExpression") {
    const left: AnyNode = node.left;
    if (left.type === "Identifier") return GLOBAL_ROOTS.has(left.name); // location = ...
    if (left.type !== "MemberExpression") return false;
    const last = propName(left.property);
    if (last === "innerHTML" || last === "outerHTML") return true;
    if (last === "location") return true; // window.location = ...
    if (last && URL_ATTRS.has(last) && isJavascriptUrl(node.right)) return true; // a.href = "javascript:..."
    const root = rootIdentifier(left);
    // Any write through a global root is pollution: window.React = 1,
    // document.title = ..., globalThis.x = ... Reads are untouched.
    return !!root && GLOBAL_ROOTS.has(root);
  }

  return false;
}

/** Object-literal properties to drop entirely (props, not statements). */
function isForbiddenProperty(node: AnyNode): boolean {
  if (node.type !== "Property") return false;
  const key = propName(node.key);
  if (key === "dangerouslySetInnerHTML") return true;
  if (key && URL_ATTRS.has(key) && isJavascriptUrl(node.value)) return true;
  return false;
}

type Verdict = { forbidden: Set<AnyNode>; forbiddenProps: Set<AnyNode> };

/**
 * The decision layer: walk every node with its ancestor chain and record
 * what must go. The walker is also the compatibility gate — a node type
 * acorn-walk cannot traverse throws here and fails closed, never in prod.
 */
function audit(ast: Node): Verdict {
  const forbidden = new Set<AnyNode>();
  const forbiddenProps = new Set<AnyNode>();
  walk.ancestor(ast, {
    Expression(node: AnyNode) {
      if (isForbiddenExpression(node)) forbidden.add(node);
    },
    Property(node: AnyNode) {
      if (isForbiddenProperty(node)) forbiddenProps.add(node);
    },
  });
  return { forbidden, forbiddenProps };
}

/** Apply the audit decisions: replace expressions, drop properties. */
function applyDecisions(node: AnyNode, verdict: Verdict): AnyNode | null {
  if (verdict.forbidden.has(node)) return void0();
  if (verdict.forbiddenProps.has(node)) return null;
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range" || key === "raw") continue;
    const v = node[key];
    if (Array.isArray(v)) {
      node[key] = v.map((c) => (isNode(c) ? applyDecisions(c, verdict) : c)).filter((c) => c !== null);
    } else if (isNode(v)) {
      const r = applyDecisions(v, verdict);
      node[key] = r === null ? void0() : r;
    }
  }
  return node;
}

/** Parse model JS; null when it is not a parseable ES module. */
function parseModelModule(js: string): Node | null {
  try {
    return parse(js, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return null;
  }
}

/**
 * Import audit: every static and dynamic specifier must be a literal the
 * widget import map (or the one vetted CDN) can resolve. Anything else —
 * bare package names, foreign URLs, variables, template literals — is a
 * compile error with a message the model can act on.
 */
function auditImports(ast: Node): string | null {
  const bad: string[] = [];
  let indirect = 0;
  walk.simple(ast, {
    ImportDeclaration(node: AnyNode) {
      if (!allowedSpecifier(String(node.source.value))) bad.push(String(node.source.value));
    },
    ExportNamedDeclaration(node: AnyNode) {
      if (node.source && !allowedSpecifier(String(node.source.value))) bad.push(String(node.source.value));
    },
    ExportAllDeclaration(node: AnyNode) {
      if (!allowedSpecifier(String(node.source.value))) bad.push(String(node.source.value));
    },
    ImportExpression(node: AnyNode) {
      const src: AnyNode = node.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string") indirect++;
      else if (!allowedSpecifier(src.value)) bad.push(String(src.value));
    },
  });
  if (bad.length) {
    return (
      `unsupported import${bad.length > 1 ? "s" : ""}: ${bad.map((s) => JSON.stringify(s)).join(", ")} — ` +
      `widgets may only import react / react-dom and the preloaded libs ` +
      `(d3, gsap, chart, three, leaflet); esm.sh needs net: true`
    );
  }
  if (indirect) {
    return `dynamic import specifier must be a literal string — widgets may only import the preloaded libs or https://esm.sh/ URLs`;
  }
  return null;
}

export type ModelModuleResult = { ok: true; code: string } | { ok: false; error: string };

function regenerate(ast: Node, verdict: Verdict): string {
  return generate(applyDecisions(ast as AnyNode, verdict) as Node);
}

/**
 * The full model-code boundary on compiled (post-Bun) module code: parse,
 * audit imports, sanitize forbidden capabilities, regenerate. Returns the
 * final module source, or a compile error the model can act on. This is
 * the entry point compileJsxModule uses.
 */
export function enforceModelModule(compiledCode: string): ModelModuleResult {
  const ast = parseModelModule(compiledCode);
  if (!ast) return { ok: false, error: "invalid widget code: not parseable as an ES module" };
  const importError = auditImports(ast);
  if (importError) return { ok: false, error: importError };
  try {
    return { ok: true, code: regenerate(ast, audit(ast)) };
  } catch {
    // astring/walk could not process a node type: fail closed.
    return { ok: false, error: "invalid widget code: unsupported syntax" };
  }
}

/**
 * Sanitize model-authored module code (belt-and-braces entry point used by
 * the module-body builder). Parses the code, removes every node that
 * exercises a forbidden capability, and regenerates deterministic JS.
 * Static imports are the module format and survive (they are validated at
 * compile time by enforceModelModule); unparseable input is dropped
 * entirely (fail closed).
 */
export function sanitizeModelJS(js: string): string {
  const ast = parseModelModule(js);
  if (!ast) return "";
  try {
    return regenerate(ast, audit(ast));
  } catch {
    return "";
  }
}

/**
 * The widget module body: the compiled ESM source plus the auto-mount
 * glue — the App root (`export default function App`, or the default
 * export) rendered into document.body with the `state` header as props.
 * The module is stored and served whole (text/javascript), so model code
 * never lives inside the HTML document.
 */
export function buildJsxModuleBody(compiledCode: string): string {
  return `${escapeScriptClose(sanitizeModelJS(compiledCode))}
;
(function () {
  "use strict";
  var __app = null;
  try {
    // Module-scope binding: "export default function App", named App, or the
    // default export alias. Missing binding is a ReferenceError -> null.
    __app = App;
  } catch (err) { __app = null; }
  try {
    if (!__app && typeof window.App === "function") __app = window.App;
    if (!__app) {
      if (window.__gu && window.__gu.reportError) window.__gu.reportError(new Error("widget: export a default React component (App)"));
      return;
    }
    var root = window.ReactDOMClient.createRoot(document.body);
    root.render(window.React.createElement(__app, (window.__gu && window.__gu.state) || {}));
    if (window.__gu && window.__gu.onDestroy) window.__gu.onDestroy(function () { root.unmount(); });
  } catch (err) {
    try { if (window.__gu && window.__gu.reportError) window.__gu.reportError(err); else if (window.__gu) window.__gu.error = String(err); } catch {}
  }
})();
`;
}
