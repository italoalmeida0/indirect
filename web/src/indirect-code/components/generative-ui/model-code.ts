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
 *   -> map-safe sanitize          — forbidden ranges replaced in place
 *                                 (magic-string: zero line movement)
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
 *     javascript: URLs in href/src-like props (including static template
 *     literals and `+` concatenations of string literals)
 *   - global pollution: assignment/update through window/document/globalThis,
 *     Object.assign into a global or prototype receiver, and ANY write to an
 *     identifier the module never declares (strict mode: `React = 1`,
 *     `({ window } = o)`, `for (React of xs)` all hit the global object)
 *   - reflection / prototype escapes: constructor/__proto__/prototype
 *     member chains, ownerDocument/defaultView window walk-backs, Reflect.*,
 *     Object reflection helpers plucked as values
 *   - capability member names on ANY receiver (`w.fetch`, `w["Function"]`,
 *     `w.eval`): an alias loses the global root, so the property name is the
 *     remaining evidence; a NON-NUMERIC computed link on a global chain
 *     (`document.body[k]`) is the same unauditable lookup — numeric indices
 *     behind safe heads (`document.forms[0]`) stay ordinary reads
 *   - global-object aliases (`const w = window`, `const O = Object`,
 *     `const h = window.history`, `({} = window)` — a destructuring
 *     assignment evaluates to its right side), for-in/for-of into a
 *     protected target, tagged templates
 *   - destructuring a capability name from a global/Object/Reflect source
 *     (`{ constructor }`, `{ fetch } = window`) — ordinary props of the
 *     same name stay untouched
 *   - named exports of a stripped binding (`export { f }` after the
 *     declaration was cut): the module would fail instantiation
 *   - dynamic import of anything but https://esm.sh/ string literals
 *
 * Everything else compiles through verbatim (byte-identical outside the
 * sanitized spots).
 * Unparseable code fails closed: it is rejected at compile time and dropped
 * by the sanitizer — code that cannot be parsed cannot be audited.
 */
import { parse, tokenizer, type Node } from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

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

/** Identifier name of `x` in `x.a.b[...]` (the root of a member chain). */
function rootIdentifier(node: AnyNode | null | undefined): string | null {
  const root = chainRoot(node);
  return root && root.type === "Identifier" ? root.name : null;
}

/**
 * The VALUE root of a chain, looking through the expressions that hand their
 * right/only operand over verbatim: optional chains (`window?.navigator`),
 * sequences (`(0, window)`) and assignments — `({} = window)` EVALUATES TO
 * `window`, so `({} = window).open(...)` operates on the global exactly like
 * `window.open(...)`. Without this, the destructuring assignment hid the
 * receiver from every root scan.
 */
function chainRoot(node: AnyNode | null | undefined): AnyNode | null {
  let cur: AnyNode = node;
  for (;;) {
    if (cur && cur.type === "MemberExpression") {
      cur = cur.object;
      continue;
    }
    const next = unwrapValue(cur);
    if (!next || next === cur) return cur || null;
    cur = next;
  }
}

/** Unwrap the value-preserving wrappers around an expression (one layer). */
function unwrapValue(node: AnyNode | null | undefined): AnyNode | null {
  let cur = node;
  while (cur) {
    if (cur.type === "ChainExpression") cur = cur.expression;
    else if (cur.type === "SequenceExpression") cur = cur.expressions[cur.expressions.length - 1];
    else if (cur.type === "AssignmentExpression") cur = cur.right;
    else break;
  }
  return cur || null;
}

/**
 * The string a node evaluates to at compile time, or null when it cannot be
 * known for sure: string literals, static template literals and `+`
 * concatenations of those (`"con" + "structor"` IS `"constructor"`). The
 * audit treats such an expression exactly like the literal it produces, so
 * the string-concatenated and template-literal spellings of a capability
 * name cannot hide it.
 */
function staticStringValue(node: AnyNode | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : null;
    case "TemplateLiteral": {
      if (node.expressions.length !== 0 || node.quasis.length !== 1) return null;
      const q = node.quasis[0].value;
      return q.cooked ?? q.raw ?? null;
    }
    case "BinaryExpression": {
      if (node.operator !== "+") return null;
      const left = staticStringValue(node.left);
      const right = staticStringValue(node.right);
      return left !== null && right !== null ? left + right : null;
    }
    case "ParenthesizedExpression":
    case "ChainExpression":
      return staticStringValue(node.expression);
    default:
      return null;
  }
}

/**
 * Property name of `a.b` / `a["b"]` / ``a[`b`]`` / `a["b" + "c"]` when
 * statically known. A COMPUTED identifier (`a[k]`) is a dynamic lookup,
 * never the property `k` — treating it as a name would flag plain local
 * variables (`window[open]`, `arr[fetch]()`) as global property access.
 */
function propName(node: AnyNode | null | undefined, computed = false): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return computed ? null : node.name;
  return staticStringValue(node);
}

/** Static member chain names: `a.b.c` -> ["b", "c"] (dynamic computed -> null). */
function memberProps(node: AnyNode | null | undefined): string[] | null {
  const props = memberLinks(node, false);
  return props ?? null;
}

/**
 * Statically named links of a chain, skipping dynamic (`a[k]`) links. Used
 * only when a dynamic link makes the full chain unauditable: the known
 * prefix still tells whether a reflection object is behind it.
 */
function staticChainNames(node: AnyNode | null | undefined): string[] {
  return memberLinks(node, true) ?? [];
}

/**
 * Links of a member chain, walking through the value-preserving wrappers
 * around its receiver (`({} = window).open`, `(0, window).open`). `skip`
 * drops dynamic computed links; without it a dynamic link means the chain
 * has no static name and the whole scan fails (`null`).
 */
function memberLinks(node: AnyNode | null | undefined, skip: boolean): string[] | null {
  const seq = memberLinkSequence(node);
  if (!seq) return null;
  if (skip) return seq.links.filter((link): link is string => link !== null);
  return seq.links.some((link) => link === null) ? null : (seq.links as string[]);
}

/**
 * The links of a member chain in source order, with `null` for a dynamic
 * computed link (`a[k]`), plus the identifier it is rooted at and whether
 * each link was a NUMERIC literal index (`a[0]`). The audit needs the
 * POSITION and the kind of a dynamic link, not just the static prefix: an
 * index into `document.body.children` is a DOM collection read, while
 * `document.body[k]` can name any property of the body element.
 */
function memberLinkSequence(
  node: AnyNode | null | undefined,
): { root: string; links: Array<string | null>; numeric: boolean[] } | null {
  const links: Array<string | null> = [];
  const numeric: boolean[] = [];
  let cur: AnyNode = node;
  for (;;) {
    if (cur && cur.type === "MemberExpression") {
      links.unshift(propName(cur.property, cur.computed));
      numeric.unshift(
        !!cur.computed && cur.property?.type === "Literal" && typeof cur.property.value === "number",
      );
      cur = cur.object;
      continue;
    }
    const next = unwrapValue(cur);
    if (!next || next === cur) break;
    cur = next;
  }
  return cur && cur.type === "Identifier" ? { root: cur.name, links, numeric } : null;
}

/** Globals a model may READ but never write (see the widget contract). */
const GLOBAL_ROOTS = new Set([
  "window", "document", "globalThis", "self", "top", "parent", "frames",
  "location", "navigator", "history", "Object",
]);
/** Window-family globals: `window.self.top` only spells the same window. */
const WINDOW_ROOTS = new Set(["window", "globalThis", "self", "top", "parent", "frames"]);
/**
 * Global OBJECTS whose bare read binds the object itself — an alias the
 * audit cannot follow (`const w = window; w.fetch(...)`). Only the object
 * side of a member expression (`window.innerWidth`, `navigator.userAgent`,
 * `Object.keys(x)`) keeps the capability auditable; a destructuring source
 * (`const { width } = window`) is audited by the pattern visitor instead
 * (see isPatternSourcePosition). The same objects reached through a window
 * prefix (`const d = window.document`) are aliases too (isGlobalObjectAlias).
 */
const BARE_GLOBAL_ROOTS = new Set([
  "window", "globalThis", "self", "top", "parent", "frames",
  "document", "location", "history", "navigator", "Object",
]);

/** An unshadowed global-object root: GLOBAL_ROOTS or the `Reflect` namespace. */
function isUnboundGlobalRoot(name: string | null | undefined, ancestors?: AnyNode[]): boolean {
  return !!name && (GLOBAL_ROOTS.has(name) || name === "Reflect") && !isLocallyBound(name, ancestors);
}

/**
 * First real property after any WINDOW_ROOTS prefix: `window.self.top.document`
 * -> `{ first: "document", ... }`. The prefix only spells the same window, so
 * capability checks apply to the first non-window link.
 */
function globalHead(root: string, props: string[]): { first: string | null; rest: string[] } {
  let i = 0;
  if (WINDOW_ROOTS.has(root)) {
    while (i < props.length && WINDOW_ROOTS.has(props[i])) i++;
  }
  return { first: i < props.length ? props[i] : null, rest: props.slice(i + 1) };
}

const NAVIGATION_CALLS = new Set(["assign", "replace", "reload"]);
const HISTORY_CALLS = new Set(["pushState", "replaceState", "go", "back", "forward"]);
const DOCUMENT_CALLS = new Set(["write", "writeln"]);
/** Bare-identifier call targets that are always forbidden. */
const FORBIDDEN_IDENT_CALLS = new Set([
  "eval", "Function", "importScripts", "fetch",
  "XMLHttpRequest", "WebSocket", "EventSource",
  "Worker", "SharedWorker", "BroadcastChannel",
  // `window.open` with no window prefix; a locally bound `open` prop stays
  // ordinary component code (see isLocallyBound).
  "open",
]);
/**
 * Bare reads that are always forbidden: reflection (`Reflect`) and every
 * forbidden call target plucked as a VALUE (`const f = fetch; f(...)`,
 * `const E = eval`) — the binding would launder the capability past the
 * call audit. Locally declared bindings of the same name are not globals
 * (see isLocallyBound).
 */
const FORBIDDEN_IDENTIFIERS = new Set(["Reflect", ...FORBIDDEN_IDENT_CALLS]);
/** Member call tails that are forbidden on any receiver. */
const FORBIDDEN_ANY_RECEIVER_CALLS = new Set([
  "insertAdjacentHTML",
  // Network primitives — bare `fetch(` is in FORBIDDEN_IDENT_CALLS, but the
  // same calls through a receiver (`window.fetch`, `globalThis.fetch`) must
  // not slip past the audit either.
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  // Dynamic code and beacon exfiltration through any receiver
  // (`dv.eval`, `navigator.sendBeacon` behind an alias).
  "eval", "Function", "sendBeacon",
]);
/**
 * Prototype-chain escape hatches: `f.constructor("code")()` rebuilds
 * `Function` from any function, and `.constructor`/`.__proto__` member
 * ACCESS is the raw material for the same escape — both are forbidden on
 * any receiver (reads included). Widgets never need them.
 *
 * `ownerDocument` / `defaultView` walk any node (or `document.body`) back to
 * the real document/window, `insertAdjacentHTML` / `sendBeacon` are an HTML
 * sink and an exfiltration channel even when PLUCKED as values
 * (`const f = el.insertAdjacentHTML`), and every network / dynamic-code /
 * reflection primitive is named here too: an ALIAS keeps the object but
 * loses the global root (`const w = document.body[k]; w.fetch(...)`), so
 * the property NAME is the last evidence the audit has. None has a
 * legitimate widget use, so the read itself is forbidden at any chain
 * depth.
 */
const FORBIDDEN_MEMBER_PROPS = new Set([
  "constructor", "__proto__", "prototype",
  "ownerDocument", "defaultView",
  "insertAdjacentHTML", "sendBeacon",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "Worker", "SharedWorker", "BroadcastChannel",
  "eval", "Function", "Reflect",
]);
/**
 * Reflection primitives that rebuild the same escapes. They are forbidden
 * when the chain resolves to `Object` (root `Object` or `window.Object`):
 * `const g = Object.getOwnPropertyDescriptor` hands over the capability
 * with no call site left for the audit to inspect.
 */
const FORBIDDEN_REFLECTION_CALLS = new Set([
  "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties",
  "getOwnPropertyDescriptor", "getOwnPropertyDescriptors",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);
/**
 * Navigator capabilities: plucked off the object they bypass every call
 * audit (`const { sendBeacon } = navigator`).
 */
const NAVIGATOR_CAPABILITIES = new Set([
  "sendBeacon", "serviceWorker", "clipboard", "credentials", "storage", "locks",
  "usb", "serial", "hid", "bluetooth", "geolocation", "mediaDevices",
  "permissions", "wakeLock", "share", "vibrate",
]);
/**
 * Capability properties of a window-family root, checked on the FIRST real
 * property only (`window.fetch`, `window.open`, ...). `window.__gu.state.open`
 * names none of them at that position, so the widget host surface survives.
 * `Object`, `location`, `history` and `navigator` are audited by their own
 * prefix rules (see isForbiddenGlobalMember), and `location` is intentionally
 * absent: `window.location.search` is a safe read.
 */
const FORBIDDEN_WINDOW_PROPS = new Set([
  ...FORBIDDEN_IDENTIFIERS,
  ...FORBIDDEN_ANY_RECEIVER_CALLS,
  ...FORBIDDEN_REFLECTION_CALLS,
  // History writes whose VALUE read hands over the capability. `go`/`back`/
  // `forward` are left to the call check: they are ordinary property names
  // on widget state (`window.__gu.state.back`).
  "pushState", "replaceState",
  "defaultView", "write", "writeln",
]);
/**
 * Capability properties of `document`: DOM-writing sinks, the cookie jar,
 * and the chains that reach the window back (`defaultView`, `location`).
 * `document.title`, `document.body` and `document.documentElement` stay.
 */
const FORBIDDEN_DOCUMENT_PROPS = new Set([
  ...DOCUMENT_CALLS, "open", "close", "cookie", "domain", "location", "defaultView",
]);
/**
 * Navigator capabilities that may not be READ off the object: plucking one
 * hands over the API with no call site to audit. `userAgent` (a plain
 * string) and `vibrate` (benign, gesture-gated) stay readable.
 */
const FORBIDDEN_NAVIGATOR_MEMBER_PROPS = new Set(
  [...NAVIGATOR_CAPABILITIES].filter((prop) => prop !== "vibrate" && prop !== "share"),
);
/** Attribute names that turn an element into a code/URL sink. */
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "formAction", "xlink:href", "data", "poster"]);
/**
 * Destructuring keys that are always stripped: prototype escapes and the
 * DOM/HTML sinks are never legitimate props. Every other capability name is
 * only stripped when the pattern reads a protected source (see
 * PROTECTED_PATTERN_KEYS) — `{ open, location, fetch, write } = props` is
 * ordinary component code, so the network/reflection names added to
 * FORBIDDEN_MEMBER_PROPS for aliased receivers stay OUT of this set.
 */
const ALWAYS_FORBIDDEN_PATTERN_KEYS = new Set([
  "constructor", "__proto__", "prototype",
  "ownerDocument", "defaultView",
  "insertAdjacentHTML", "sendBeacon",
]);
/**
 * Capability names that must never be destructured from a global object,
 * `Object` or `Reflect`: the binding hands over the capability without any
 * member chain left to inspect. Safe names (`pathname`, `userAgent`,
 * `innerWidth`, `length`) are absent, so `const { userAgent } = navigator`
 * keeps working.
 */
const PROTECTED_PATTERN_KEYS = new Set([
  ...GLOBAL_ROOTS,
  ...FORBIDDEN_IDENTIFIERS,
  ...FORBIDDEN_ANY_RECEIVER_CALLS,
  ...FORBIDDEN_REFLECTION_CALLS,
  ...NAVIGATOR_CAPABILITIES,
  ...NAVIGATION_CALLS,
  ...HISTORY_CALLS,
  ...DOCUMENT_CALLS,
  "defaultView",
  "Worker", "SharedWorker", "BroadcastChannel",
  // `href` is deliberately absent: `location.href = ...` is already a
  // protected global WRITE (isForbiddenMemberWrite), while `const { href,
  // pathname, search } = location` is an ordinary read of plain strings.
  "open", "close", "stop", "print", "navigate",
  "localStorage", "sessionStorage",
  "indexedDB", "caches", "cookieStore", "cookie", "domain",
  "innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc",
  "write", "writeln", "setAttribute", "sendBeacon", "assign", "Object",
]);

/**
 * Sources whose destructured properties are capability names: a global
 * object (`window`, `navigator`, `history`, `location`, `document`, ...),
 * `Reflect`, or a member chain rooted at one of them (`window.navigator`,
 * `document.defaultView`). Only then are PROTECTED_PATTERN_KEYS stripped;
 * `const { open } = props` stays ordinary component code.
 */
const PROTECTED_PATTERN_ROOTS = new Set([...GLOBAL_ROOTS, "Reflect"]);

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
  "cannon-es",
  "cannon",
  "matter-js",
  "matter",
]);

/** URL literals allowed for module specifiers: the one vetted lib CDN. */
function allowedSpecifier(spec: string): boolean {
  return RESOLVABLE_SPECIFIERS.has(spec) || /^https:\/\/esm\.sh\//.test(spec);
}

function isJavascriptUrl(v: AnyNode | null | undefined): boolean {
  const value = staticStringValue(v);
  return value !== null && /^\s*javascript:/i.test(value);
}

/** True when any static link of a member chain names a prototype escape. */
function hasForbiddenMemberProp(node: AnyNode | null | undefined): boolean {
  let cur: AnyNode = node;
  while (cur && cur.type === "MemberExpression") {
    const p = propName(cur.property, cur.computed);
    if (p && FORBIDDEN_MEMBER_PROPS.has(p)) return true;
    cur = cur.object;
  }
  return false;
}

/** True when a member-expression WRITE reaches a protected sink/global. */
function isForbiddenMemberWrite(node: AnyNode, right?: AnyNode, ancestors?: AnyNode[]): boolean {
  const last = propName(node.property, node.computed);
  if (last === "innerHTML" || last === "outerHTML") return true;
  if (last === "location") return true; // navigation sink: frame.location = ...
  if (last && URL_ATTRS.has(last) && isJavascriptUrl(right)) return true; // a.href = "javascript:..."
  // Any write through an UNSHADOWED global root is pollution: window.React =
  // 1, document.title = ..., globalThis.x = ... Reads are untouched, and a
  // local binding of the same name (`function f(window)`) is not a global.
  if (isUnboundGlobalRoot(rootIdentifier(node), ancestors)) return true;
  return hasForbiddenMemberProp(node);
}

/** Parent of the current node in an acorn-walk ancestor chain. */
function parentOf(ancestors: AnyNode[] | undefined): AnyNode | null {
  return ancestors && ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
}

/**
 * The node that CONTAINS `node` after stepping out of the optional-chain
 * wrapper around it: `window?.navigator` is one expression to its parent, so
 * an `ObjectPattern` source and a member-object check must see the same
 * holder as for `window.navigator`. `top` is that wrapper root (the node
 * itself when there is no chain), comparable with `init`/`right`.
 */
function enclosingOf(
  node: AnyNode,
  ancestors: AnyNode[] | undefined,
): { holder: AnyNode; top: AnyNode; parent: AnyNode | null } | null {
  if (!ancestors) return null;
  let i = ancestors.lastIndexOf(node) - 1;
  if (i < 0) return null;
  while (i >= 0 && ancestors[i].type === "ChainExpression" && ancestors[i].expression === ancestors[i + 1]) i--;
  if (i < 0) return null;
  return { holder: ancestors[i], top: ancestors[i + 1], parent: i > 0 ? ancestors[i - 1] : null };
}

/** True when `node` is the object side of `node.prop` (an auditable read). */
function isMemberObject(node: AnyNode, ancestors: AnyNode[] | undefined): boolean {
  const enc = enclosingOf(node, ancestors);
  return !!enc && enc.holder.type === "MemberExpression" && enc.holder.object === enc.top;
}

/**
 * True when the expression is the OPERAND of `typeof`: the operator yields a
 * type string, never the value, so `typeof window !== "undefined"` cannot
 * hand the global object over.
 */
function isTypeofOperand(node: AnyNode, ancestors?: AnyNode[]): boolean {
  const enc = enclosingOf(node, ancestors);
  return (
    !!enc &&
    enc.holder.type === "UnaryExpression" &&
    enc.holder.operator === "typeof" &&
    enc.holder.argument === enc.top
  );
}

/**
 * `Object.<method>` / `window.Object.<method>` rules. `assign` is audited
 * with its first argument at the call site (a direct call is not a read);
 * every reflection helper is a capability the read would hand over.
 */
function isForbiddenObjectMethod(method: string | null, node: AnyNode, ancestors?: AnyNode[]): boolean {
  if (!method) return false;
  if (method === "assign") {
    const parent = parentOf(ancestors);
    return !(parent && parent.type === "CallExpression" && parent.callee === node);
  }
  return FORBIDDEN_REFLECTION_CALLS.has(method);
}

/**
 * The `Object.<method>` an unshadowed chain resolves to: root `Object`, or
 * the object after a window prefix (`window.Object`, `globalThis.window.Object`).
 */
function objectMethodOf(
  root: string | null,
  props: string[] | null,
  ancestors?: AnyNode[],
): string | null {
  if (!root || !props || !isUnboundGlobalRoot(root, ancestors)) return null;
  if (root === "Object") return props[0] ?? null;
  if (WINDOW_ROOTS.has(root)) {
    const { first, rest } = globalHead(root, props);
    if (first === "Object") return rest[0] ?? null;
  }
  return null;
}

/**
 * `Object.assign` / `Object.<reflection>` plucked as a VALUE. A direct
 * `Object.assign(...)` call is audited with its first argument; any other
 * read hands the method over untouched, so it must go.
 */
function isForbiddenObjectMemberRead(node: AnyNode, ancestors: AnyNode[] | undefined): boolean {
  if (node.type !== "MemberExpression") return false;
  const method = objectMethodOf(rootIdentifier(node), memberProps(node), ancestors);
  return isForbiddenObjectMethod(method, node, ancestors);
}

/**
 * True when the chain is a global OBJECT read as a value: `const w =
 * window.self`, `const d = window.document`, `const h = window.history`,
 * `const O = window.Object`. Only the object side of a member expression
 * keeps the capability auditable; an ObjectPattern source is audited by the
 * pattern visitor. Bound roots (`state.history`) are not globals.
 */
function isGlobalObjectAlias(node: AnyNode, ancestors?: AnyNode[]): boolean {
  if (node.type !== "MemberExpression") return false;
  const root = rootIdentifier(node);
  if (!isUnboundGlobalRoot(root, ancestors)) return false;
  const props = memberProps(node);
  if (!props || props.length === 0) return false;
  if (!props.every((prop) => BARE_GLOBAL_ROOTS.has(prop))) return false;
  // `typeof window.document` asks for a type string, not the object.
  if (isTypeofOperand(node, ancestors)) return false;
  return !isMemberObject(node, ancestors) && !isPatternSourcePosition(node, ancestors);
}

/**
 * Any statically named link of a global-root chain naming a capability?
 * `window.fetch`, `document.write`, `history.pushState` — the property NAME
 * is the capability, so a bare read of the global object cannot launder it.
 * Only the FIRST real property is capacity-bearing: `window.location.search`
 * and `window.__gu.state.open` are safe reads.
 */
function isForbiddenGlobalMember(node: AnyNode, ancestors?: AnyNode[]): boolean {
  if (!node || node.type !== "MemberExpression") return false;
  const root = rootIdentifier(node);
  if (!root || !isUnboundGlobalRoot(root, ancestors)) return false;
  // Every Reflect member is the escape material, static name or not.
  if (root === "Reflect") return true;
  if (root === "Object") return isForbiddenObjectMemberRead(node, ancestors);
  const props = memberProps(node);
  if (!props) {
    // A dynamic link hides the property name. Apply the same FIRST-property
    // rules to the statically known links and, where the chain stops at a
    // capability NAMESPACE, fail closed (the dynamic name could be `back`).
    const { first, rest } = globalHead(root, staticChainNames(node));
    if (first === null) return false;
    if (first === "__gu" || first === "indirectUi") return false;
    if (first === "Reflect" || first === "Object") return true;
    if (root === "document") return FORBIDDEN_DOCUMENT_PROPS.has(first);
    if (root === "location") return NAVIGATION_CALLS.has(first);
    if (root === "history") return HISTORY_CALLS.has(first);
    if (root === "navigator") return FORBIDDEN_NAVIGATOR_MEMBER_PROPS.has(first);
    if (first === "document") return rest.length === 0 || FORBIDDEN_DOCUMENT_PROPS.has(rest[0]);
    if (first === "location") return rest.length === 0 || NAVIGATION_CALLS.has(rest[0]);
    if (first === "history") return rest.length === 0 || HISTORY_CALLS.has(rest[0]);
    if (first === "navigator") return rest.length === 0 || FORBIDDEN_NAVIGATOR_MEMBER_PROPS.has(rest[0]);
    return FORBIDDEN_WINDOW_PROPS.has(first);
  }
  const { first, rest } = globalHead(root, props);
  if (first === null) return false;
  if (root === "document") return FORBIDDEN_DOCUMENT_PROPS.has(first);
  if (root === "location") return NAVIGATION_CALLS.has(first);
  if (root === "history") return HISTORY_CALLS.has(first);
  if (root === "navigator") return FORBIDDEN_NAVIGATOR_MEMBER_PROPS.has(first);
  // Window-family roots (window, globalThis, self, top, parent, frames).
  if (first === "__gu" || first === "indirectUi") return false;
  if (first === "Reflect") return true;
  if (first === "Object") return isForbiddenObjectMemberRead(node, ancestors);
  if (first === "document") return rest.length > 0 && FORBIDDEN_DOCUMENT_PROPS.has(rest[0]);
  if (first === "location") return rest.length > 0 && NAVIGATION_CALLS.has(rest[0]);
  if (first === "history") return rest.length > 0 && HISTORY_CALLS.has(rest[0]);
  if (first === "navigator") return rest.length > 0 && FORBIDDEN_NAVIGATOR_MEMBER_PROPS.has(rest[0]);
  return FORBIDDEN_WINDOW_PROPS.has(first);
}

/**
 * True when a static prefix of a global chain reads a value whose numeric
 * index is an ordinary collection/string access (`document.body.children`,
 * `document.forms`, `navigator.userAgent`). A capability at the first real
 * position (`document.defaultView`, `window.fetch`) or a namespace hop
 * (`window.document.body`) makes the indexed value unauditable instead.
 */
function staticHeadIsSafe(root: string, links: Array<string | null>): boolean {
  const names = links.filter((link): link is string => link !== null);
  if (names.length === 0) return false;
  if (root === "Reflect" || root === "Object") return false;
  if (WINDOW_ROOTS.has(root)) {
    const { first, rest } = globalHead(root, names);
    if (first === null) return false;
    if (first === "__gu" || first === "indirectUi") return true;
    if (first === "Reflect" || first === "Object") return false;
    if (first === "document") return rest.length > 0 && !FORBIDDEN_DOCUMENT_PROPS.has(rest[0]);
    if (first === "location") return rest.length > 0 && !NAVIGATION_CALLS.has(rest[0]);
    if (first === "history") return rest.length > 0 && !HISTORY_CALLS.has(rest[0]);
    if (first === "navigator") return rest.length > 0 && !FORBIDDEN_NAVIGATOR_MEMBER_PROPS.has(rest[0]);
    return !FORBIDDEN_WINDOW_PROPS.has(first);
  }
  if (root === "document") return !FORBIDDEN_DOCUMENT_PROPS.has(names[0]);
  if (root === "location") return !NAVIGATION_CALLS.has(names[0]);
  if (root === "history") return !HISTORY_CALLS.has(names[0]);
  if (root === "navigator") return !FORBIDDEN_NAVIGATOR_MEMBER_PROPS.has(names[0]);
  return false;
}

/**
 * True when a chain's dynamic link (`a[k]`) performs an unauditable lookup
 * on a chain reached from the global object:
 *   - a dynamic link at the FIRST real position (`window[k]`,
 *     `document[k]`, `window.navigator[k]`) names a capability directly, or
 *   - any NON-NUMERIC dynamic link behind a static head
 *     (`document.body[k]`, `document.body.children[k]`) can name any
 *     property of the object it indexes — including `ownerDocument` /
 *     `defaultView` / `fetch` — so the chain must go.
 * Only a NUMERIC index behind a safe static head is an ordinary read:
 * `document.body.children[0]`, `document.forms[0]`,
 * `navigator.userAgent[0]` index a DOM collection or a string. The widget
 * host namespace (`window.__gu.state[k]`) is trusted state.
 */
function dynamicGlobalCapability(node: AnyNode | null | undefined): boolean {
  const seq = memberLinkSequence(node);
  if (!seq || !seq.links.some((link) => link === null)) return false;
  if (!(GLOBAL_ROOTS.has(seq.root) || seq.root === "Reflect")) return false;
  let links = seq.links;
  let numeric = seq.numeric;
  // The window prefix only spells the same window: `window.self.document[k]`
  // must be judged like `document[k]`.
  let start = 0;
  if (WINDOW_ROOTS.has(seq.root)) {
    for (;;) {
      const name = start < links.length ? links[start] : null;
      if (name === null || !WINDOW_ROOTS.has(name)) break;
      start++;
    }
  }
  links = links.slice(start);
  numeric = numeric.slice(start);
  if (links.length === 0) return false;
  if (WINDOW_ROOTS.has(seq.root) && (links[0] === "__gu" || links[0] === "indirectUi")) return false;
  // The first real link IS the property name the lookup yields.
  if (links[0] === null) return true;
  for (let i = 1; i < links.length; i++) {
    if (links[i] !== null) continue;
    if (!numeric[i]) return true;
    if (!staticHeadIsSafe(seq.root, links.slice(0, i))) return true;
  }
  return false;
}

/**
 * A chain on a protected global whose property NAME is dynamic (`window[k]`,
 * `document[k]`, `globalThis[k]`) — the audit cannot know what the lookup
 * yields. The widget host namespace (`window.__gu.state[k]`) is the trusted
 * API surface, and a destructuring source is owned by the pattern visitor,
 * which strips every binding instead.
 */
function isDynamicProtectedGlobalChain(node: AnyNode | null | undefined, ancestors?: AnyNode[]): boolean {
  if (!node || node.type !== "MemberExpression") return false;
  const root = rootIdentifier(node);
  if (!root || !isUnboundGlobalRoot(root, ancestors)) return false;
  if (memberProps(node) !== null) return false; // a static chain has its own rules
  if (isPatternSourcePosition(node, ancestors)) return false;
  const head = globalHead(root, staticChainNames(node));
  if (WINDOW_ROOTS.has(root) && (head.first === "__gu" || head.first === "indirectUi")) return false;
  return dynamicGlobalCapability(node);
}

/**
 * The same chain READ as a value. A bare statement (`window[open];`) keeps
 * working; a call (`window[k](...)`) or any other position (`const f =
 * window[k]`, `fn(window[k])`) hands over whatever capability the dynamic
 * name resolves to.
 */
function isDynamicGlobalMember(node: AnyNode, ancestors?: AnyNode[]): boolean {
  if (!isDynamicProtectedGlobalChain(node, ancestors)) return false;
  const parent = parentOf(ancestors);
  return !!parent && parent.type !== "ExpressionStatement";
}

/**
 * `Object.assign` first argument: missing, a global root / `Object` /
 * `Reflect`, a prototype chain, or a spread whose target cannot be audited.
 * `Object.assign(({} = window), ...)` targets the same global: the
 * assignment evaluates to its right side.
 */
function isProtectedReceiver(node: AnyNode | null | undefined, ancestors?: AnyNode[]): boolean {
  if (!node) return true;
  const target = unwrapValue(node);
  if (!target) return true;
  if (target.type === "SpreadElement") return true;
  if (target.type === "Identifier") {
    return (
      isUnboundGlobalRoot(target.name, ancestors) ||
      (FORBIDDEN_IDENTIFIERS.has(target.name) && !isLocallyBound(target.name, ancestors))
    );
  }
  return isForbiddenTarget(target, undefined, ancestors);
}

/** Grandparent of the current node in an acorn-walk ancestor chain. */
function grandParentOf(ancestors: AnyNode[] | undefined): AnyNode | null {
  return ancestors && ancestors.length >= 3 ? ancestors[ancestors.length - 3] : null;
}

/** Identifier names bound by a binding pattern (`{ a, b: [c] }`, `[d]`, `...e`). */
function addBindingNames(node: AnyNode | null | undefined, out: Set<string>): void {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      out.add(node.name);
      return;
    case "ObjectPattern":
      for (const prop of node.properties || []) {
        addBindingNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      }
      return;
    case "ArrayPattern":
      for (const el of node.elements || []) addBindingNames(el, out);
      return;
    case "AssignmentPattern":
      addBindingNames(node.left, out);
      return;
    case "RestElement":
      addBindingNames(node.argument, out);
      return;
  }
}

/** Node types that open a lexical scope for `isLocallyBound`. */
const SCOPE_TYPES = new Set([
  "Program", "BlockStatement", "StaticBlock", "SwitchStatement",
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "ForStatement", "ForInStatement", "ForOfStatement", "CatchClause",
  "ClassDeclaration", "ClassExpression",
]);

/** Declarations a scope node contributes to its own lexical scope. */
function scopeDeclarations(scope: AnyNode): Set<string> {
  const out = new Set<string>();
  const statement = (stmt: AnyNode) => {
    if (!stmt) return;
    switch (stmt.type) {
      case "VariableDeclaration":
        for (const decl of stmt.declarations || []) addBindingNames(decl.id, out);
        return;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        if (stmt.id) out.add(stmt.id.name);
        return;
      case "ImportDeclaration":
        for (const spec of stmt.specifiers || []) if (spec.local) out.add(spec.local.name);
        return;
      case "ExportNamedDeclaration":
        statement(stmt.declaration);
        return;
      case "ExportDefaultDeclaration": {
        const decl = stmt.declaration;
        if (decl && (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
          out.add(decl.id.name);
        }
        return;
      }
    }
  };
  switch (scope.type) {
    case "Program":
    case "BlockStatement":
    case "StaticBlock":
      for (const stmt of scope.body || []) statement(stmt);
      break;
    case "SwitchStatement":
      for (const c of scope.cases || []) for (const stmt of c.consequent || []) statement(stmt);
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      if (scope.id) addBindingNames(scope.id, out);
      for (const param of scope.params || []) addBindingNames(param, out);
      break;
    case "ForStatement":
      if (scope.init && scope.init.type === "VariableDeclaration") {
        for (const decl of scope.init.declarations || []) addBindingNames(decl.id, out);
      }
      break;
    case "ForInStatement":
    case "ForOfStatement":
      if (scope.left && scope.left.type === "VariableDeclaration") {
        for (const decl of scope.left.declarations || []) addBindingNames(decl.id, out);
      }
      break;
    case "CatchClause":
      addBindingNames(scope.param, out);
      break;
    case "ClassDeclaration":
    case "ClassExpression":
      if (scope.id) addBindingNames(scope.id, out);
      break;
  }
  return out;
}

/** Memoized binding names per scope node (the AST is immutable per parse). */
const scopeBindingCache = new WeakMap<AnyNode, Set<string>>();

function scopeNames(scope: AnyNode): Set<string> {
  let names = scopeBindingCache.get(scope);
  if (!names) {
    names = scopeDeclarations(scope);
    scopeBindingCache.set(scope, names);
  }
  return names;
}

/**
 * True when `name` is declared by any scope enclosing the node. A local
 * binding is not a global: `const top = 10` / `function App({ location })`
 * must not be treated as the write-only global of the same name.
 */
function isLocallyBound(name: string, ancestors?: AnyNode[]): boolean {
  if (!ancestors) return false;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const scope = ancestors[i];
    if (SCOPE_TYPES.has(scope.type) && scopeNames(scope).has(name)) return true;
  }
  return false;
}

/** The innermost scope node that DECLARES `name` around the node. */
function bindingScopeFor(name: string, ancestors?: AnyNode[]): AnyNode | null {
  if (!ancestors) return null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const scope = ancestors[i];
    if (SCOPE_TYPES.has(scope.type) && scopeNames(scope).has(name)) return scope;
  }
  return null;
}

/**
 * The scope a declaration made here binds into: the innermost enclosing
 * scope node. A stripped destructuring registers ITS scope, so a reference
 * inside a nested function that redeclares the name (`function g(fetch)`)
 * resolves to that function's scope instead and is not cut.
 */
function bindingScopeOf(ancestors?: AnyNode[]): AnyNode | null {
  if (!ancestors) return null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (SCOPE_TYPES.has(ancestors[i].type)) return ancestors[i];
  }
  return null;
}

/**
 * True when `node` is READ as a value. Binding identifiers, declaration
 * names, non-computed property names, labels and assignment/loop targets are
 * not references — replacing them with `(void 0)` would break the syntax
 * (`{ (void 0) }`, `for ((void 0) of x)`) or the binding.
 */
function isIdentifierReference(node: AnyNode, ancestors?: AnyNode[]): boolean {
  const parent = parentOf(ancestors);
  if (!parent) return false;
  switch (parent.type) {
    case "MemberExpression":
      return parent.object === node || (parent.computed && parent.property === node);
    case "Property":
      // Non-computed keys are names, not reads; shorthand values and values
      // are reads.
      if (parent.key === node && !parent.computed && parent.value !== node) return false;
      return true;
    case "PropertyDefinition":
    case "MethodDefinition":
      return parent.computed || parent.value === node;
    case "VariableDeclarator":
      return parent.init === node;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return parent.body === node;
    case "ClassDeclaration":
    case "ClassExpression":
      return parent.superClass === node;
    case "AssignmentPattern":
      return parent.right === node;
    case "AssignmentExpression":
    case "UpdateExpression":
    case "ForInStatement":
    case "ForOfStatement":
      // The left side is a write target, never a read.
      return parent.right === node;
    case "CatchClause":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
    case "MetaProperty":
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "RestElement":
    case "ObjectPattern":
    case "ArrayPattern":
      return false;
    default:
      return true;
  }
}

/** True when a binding pattern declares at least one object pattern. */
function patternContainsObject(pattern: AnyNode | null | undefined): boolean {
  if (!pattern) return false;
  switch (pattern.type) {
    case "ObjectPattern":
      return true;
    case "ArrayPattern":
      return (pattern.elements || []).some((el: AnyNode) => patternContainsObject(el));
    case "AssignmentPattern":
      return patternContainsObject(pattern.left);
    case "RestElement":
      return patternContainsObject(pattern.argument);
    default:
      return false;
  }
}

/**
 * True when `node` is the expression a destructuring pattern reads: the
 * declarator init / assignment right / loop right behind an object pattern,
 * or the default of a pattern parameter (`function App({ width } = window)`).
 * The pattern visitor audits those sources (it strips capability keys and
 * reports the declaration when nothing safe remains), so a bare root there
 * is not a blind alias.
 *
 * An AssignmentExpression used as a pattern is only exempt when it is a
 * STANDALONE statement (`({ width } = window);`). Anywhere else its VALUE is
 * `window` itself, which escapes into the enclosing expression
 * (`const w = ({ } = window)`, `({ } = window).open(...)`), so it must be
 * flagged as the global read it really is. An EMPTY pattern binds nothing —
 * `const {} = window` is an alias like `const w = window`.
 */
function isPatternSourcePosition(node: AnyNode, ancestors?: AnyNode[]): boolean {
  const enc = enclosingOf(node, ancestors);
  if (!enc) return false;
  const { holder, top, parent } = enc;
  if (holder.type === "VariableDeclarator") {
    return holder.init === top && holder.id?.type === "ObjectPattern" && (holder.id.properties?.length ?? 0) > 0;
  }
  if (holder.type === "AssignmentExpression") {
    return (
      holder.right === top &&
      holder.left?.type === "ObjectPattern" &&
      (holder.left.properties?.length ?? 0) > 0 &&
      parent?.type === "ExpressionStatement"
    );
  }
  if (holder.type === "ForInStatement" || holder.type === "ForOfStatement") {
    return holder.right === top && patternContainsObject(holder.left);
  }
  if (holder.type === "AssignmentPattern") return holder.right === top && patternContainsObject(holder.left);
  return false;
}

/** What a destructuring source is: why its pattern must be stripped. */
type PatternSourceInfo = { protected: boolean; reflect: boolean; dynamic: boolean };

const NO_PATTERN_SOURCE: PatternSourceInfo = { protected: false, reflect: false, dynamic: false };

/**
 * Classify a destructuring source. A protected global / `Object` / `Reflect`
 * source strips capability keys (`window.navigator`, `document.defaultView`,
 * `globalThis.window.document`). A `Reflect` chain strips EVERY key. A chain
 * with a dynamic link (`window[k]`, `document[k]`) hides its property name,
 * so every key must go too — the pattern could otherwise bind `fetch` by
 * name. `dynamic` follows dynamicGlobalCapability: only a lookup ON the
 * global object itself counts (`window[k]`, `document[k]`), not an index
 * into a DOM collection reached from it (`document.body.children[k]`).
 */
function patternSourceInfo(node: AnyNode | null | undefined, ancestors?: AnyNode[]): PatternSourceInfo {
  const expr = unwrapValue(node);
  if (!expr) return NO_PATTERN_SOURCE;
  if (expr.type === "Identifier") {
    if (isLocallyBound(expr.name, ancestors)) return NO_PATTERN_SOURCE;
    if (expr.name === "Reflect") return { protected: true, reflect: true, dynamic: false };
    if (PROTECTED_PATTERN_ROOTS.has(expr.name)) return { protected: true, reflect: false, dynamic: false };
    return NO_PATTERN_SOURCE;
  }
  if (expr.type !== "MemberExpression") return NO_PATTERN_SOURCE;
  const root = rootIdentifier(expr);
  if (!root || !PROTECTED_PATTERN_ROOTS.has(root) || isLocallyBound(root, ancestors)) return NO_PATTERN_SOURCE;
  const props = memberProps(expr);
  if (!props) {
    if (!dynamicGlobalCapability(expr)) return NO_PATTERN_SOURCE;
    const { first } = globalHead(root, staticChainNames(expr));
    if (WINDOW_ROOTS.has(root) && (first === "__gu" || first === "indirectUi")) return NO_PATTERN_SOURCE;
    return { protected: true, reflect: false, dynamic: true };
  }
  const { first } = globalHead(root, props);
  if (WINDOW_ROOTS.has(root) && (first === "__gu" || first === "indirectUi")) return NO_PATTERN_SOURCE;
  // Root `Reflect`, or a `Reflect` reached through a window prefix
  // (`window.Reflect`): every member would hand over the escape material.
  return { protected: true, reflect: root === "Reflect" || first === "Reflect", dynamic: false };
}

/**
 * The expressions an ObjectPattern is read from: the declarator init /
 * assignment right / loop right it is bound from, plus any `= default`
 * pattern it sits behind. `direct` marks the pattern that IS the
 * destructuring target — only that one may cut the source expression itself.
 */
function patternOrigin(node: AnyNode, ancestors?: AnyNode[]): { sources: AnyNode[]; direct: boolean } {
  if (!ancestors) return { sources: [], direct: false };
  const sources: AnyNode[] = [];
  let child: AnyNode = node;
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const parent: AnyNode = ancestors[i];
    switch (parent.type) {
      case "Property":
      case "ObjectPattern":
      case "ArrayPattern":
      case "RestElement":
        child = parent;
        continue;
      case "AssignmentPattern":
        if (parent.left === child && parent.right) sources.push(parent.right);
        child = parent;
        continue;
      case "VariableDeclarator":
        if (parent.id !== child) return { sources, direct: false };
        if (parent.init) {
          sources.push(parent.init);
          return { sources, direct: parent.id === node };
        }
        child = parent;
        continue;
      case "VariableDeclaration":
        child = parent;
        continue;
      case "AssignmentExpression":
        if (parent.left !== child) return { sources, direct: false };
        if (parent.right) sources.push(parent.right);
        return { sources, direct: parent.left === node };
      case "ForInStatement":
      case "ForOfStatement":
        if (parent.left === child && parent.right) sources.push(parent.right);
        return { sources, direct: false };
      default:
        return { sources, direct: false };
    }
  }
  return { sources, direct: false };
}

/** The ObjectPattern a property value binds through (`{ a: { b } = {} }`). */
function innerObjectPattern(value: AnyNode | null | undefined): AnyNode | null {
  let cur = value;
  while (cur && cur.type === "AssignmentPattern") cur = cur.left;
  return cur && cur.type === "ObjectPattern" ? cur : null;
}

/**
 * True when an assignment/update target reaches a protected write. Targets
 * are PATTERNS: acorn-walk visits `AssignmentExpression.left` as a Pattern,
 * so a destructuring target (`[el.innerHTML] = [...]`, `({ a: window.x } = o)`)
 * never reaches the Expression visitor. This walks the pattern itself.
 *
 * An UNBOUND identifier target is NEVER a local write: a module is always
 * strict, so `React = 1`, `({ window } = o)`, `[window] = [1]` and
 * `for (React of [fake])` either throw a ReferenceError or overwrite a
 * property on the global object (`window.React`, `window.__gu`). Legitimate
 * destructuring assignments declare the local first (`let top; ({ top } =
 * rect)`), so the binding check is the whole rule.
 */
function isForbiddenTarget(
  node: AnyNode | null | undefined,
  right?: AnyNode,
  ancestors?: AnyNode[],
): boolean {
  if (!node) return false;
  switch (node.type) {
    case "Identifier":
      return !isLocallyBound(node.name, ancestors);
    case "MemberExpression":
      return isForbiddenMemberWrite(node, right, ancestors);
    case "AssignmentPattern":
      return isForbiddenTarget(node.left, right, ancestors);
    case "RestElement":
      return isForbiddenTarget(node.argument, right, ancestors);
    case "ArrayPattern":
      return (node.elements || []).some((el: AnyNode) => isForbiddenTarget(el, right, ancestors));
    case "ObjectPattern":
      return (node.properties || []).some((prop: AnyNode) =>
        prop.type === "RestElement"
          ? isForbiddenTarget(prop.argument, right, ancestors)
          : isForbiddenTarget(prop.value, right, ancestors),
      );
    default:
      return false;
  }
}

/**
 * True when any identifier a target pattern assigns is a binding the pattern
 * audit STRIPPED. The declaration is still in the AST (so `isLocallyBound`
 * says yes) even though its written form is gone; a write left in place
 * would fall through to the global of the same name
 * (`let { fetch: React } = window; React = fake`).
 */
function targetHasStrippedBinding(
  node: AnyNode | null | undefined,
  ancestors: AnyNode[],
  strippedBindings: Map<string, Set<AnyNode>>,
): boolean {
  if (!node) return false;
  switch (node.type) {
    case "Identifier": {
      const scopes = strippedBindings.get(node.name);
      if (!scopes) return false;
      const scope = bindingScopeFor(node.name, ancestors);
      return !!scope && scopes.has(scope);
    }
    case "AssignmentPattern":
      return targetHasStrippedBinding(node.left, ancestors, strippedBindings);
    case "RestElement":
      return targetHasStrippedBinding(node.argument, ancestors, strippedBindings);
    case "ArrayPattern":
      return (node.elements || []).some((el: AnyNode) =>
        targetHasStrippedBinding(el, ancestors, strippedBindings),
      );
    case "ObjectPattern":
      return (node.properties || []).some((prop: AnyNode) =>
        targetHasStrippedBinding(prop.type === "RestElement" ? prop.argument : prop.value, ancestors, strippedBindings),
      );
    default:
      return false;
  }
}

/**
 * Call-shaped targets (CallExpression / NewExpression / tagged template):
 * the callee is audited like any member read, plus argument-sensitive checks
 * (`Object.assign` first argument). Global-root rules only apply to an
 * UNSHADOWED root: `state.history.back()` and a `history` prop are the
 * widget's own data (see isLocallyBound).
 */
function isForbiddenCallTarget(
  callee: AnyNode | null | undefined,
  args: AnyNode[] | undefined,
  ancestors?: AnyNode[],
): boolean {
  if (!callee) return false;
  // A locally declared `fetch`/`eval`/`open` is the widget's own binding,
  // not the global capability (`function f(fetch) { fetch(); }`).
  if (callee.type === "Identifier") {
    return FORBIDDEN_IDENT_CALLS.has(callee.name) && !isLocallyBound(callee.name, ancestors);
  }
  if (callee.type !== "MemberExpression") return false;
  // `window[k](...)` / `document[k](...)`: the callee name is dynamic, so
  // the chain can reach any capability and the whole call must go.
  if (isDynamicProtectedGlobalChain(callee, ancestors)) return true;
  const tail = propName(callee.property, callee.computed);
  // Object.assign(window, ...) / Object.assign(Fn.prototype, ...) pollutes
  // a protected receiver — a global/prototype write without `a.b =`.
  // `window.Object.assign` (any window prefix) spells the same call.
  if (tail === "assign" && objectMethodOf(rootIdentifier(callee), memberProps(callee), ancestors) === "assign") {
    return isProtectedReceiver(args?.[0], ancestors);
  }
  // Every capability chain (window.fetch, document.write, history.pushState,
  // location.assign, navigator.sendBeacon, Object.defineProperty, ...) is
  // audited by isForbiddenGlobalMember; a dynamic link cannot be named, so
  // only the universal tail rules remain for it.
  if (isForbiddenGlobalMember(callee, ancestors)) return true;
  if (tail) {
    if (FORBIDDEN_ANY_RECEIVER_CALLS.has(tail)) return true;
    if (FORBIDDEN_MEMBER_PROPS.has(tail)) return true;
    if (tail === "setAttribute") {
      // el.setAttribute("onclick", ...) and el.setAttribute(unknown, ...)
      // are injection sinks; a literal non-on* name is a plain attribute.
      const name: AnyNode = args?.[0];
      if (!name || name.type !== "Literal") return true;
      const n = String(name.value).toLowerCase();
      if (n.startsWith("on")) return true;
      if (URL_ATTRS.has(n) && isJavascriptUrl(args?.[1])) return true;
    }
  }
  return false;
}

/**
 * The audit: true when this node exercises a forbidden capability.
 * Matched by node shape, so string literals and comments are never affected.
 */
function isForbiddenExpression(node: AnyNode, ancestors?: AnyNode[]): boolean {
  if (node.type === "Identifier") {
    if (!isIdentifierReference(node, ancestors)) return false;
    // Locals shadow globals: `const top = 10` / `function f(window)` is not
    // the write-only global of the same name.
    if (isLocallyBound(node.name, ancestors)) return false;
    // `const { width } = window`: the pattern visitor owns this read. It
    // strips the capability keys and drops the source only when nothing safe
    // remains, so `{ userAgent } = navigator` keeps working.
    if (PROTECTED_PATTERN_ROOTS.has(node.name) && isPatternSourcePosition(node, ancestors)) return false;
    if (FORBIDDEN_IDENTIFIERS.has(node.name)) return true;
    // `const w = window` aliases the global object; `window.innerWidth`
    // keeps the capability behind an auditable member chain, and
    // `typeof window` only probes for a type string.
    return BARE_GLOBAL_ROOTS.has(node.name) && !isMemberObject(node, ancestors) && !isTypeofOperand(node, ancestors);
  }

  if (node.type === "ImportExpression") {
    // Only `import("https://esm.sh/...")` string literals are allowed (the
    // compile step rejects the rest with a proper error; the sanitizer
    // removes what slips through — an indirect specifier cannot be audited).
    const src: AnyNode = node.source;
    return !(src && src.type === "Literal" && typeof src.value === "string" && allowedSpecifier(src.value));
  }

  if (node.type === "CallExpression" || node.type === "NewExpression") {
    return isForbiddenCallTarget(node.callee, node.arguments, ancestors);
  }

  // `` fetch`https://evil.example` `` / `` window.eval`alert(1)` `` run the
  // tag exactly like a call: the same callee checks apply.
  if (node.type === "TaggedTemplateExpression") {
    return isForbiddenCallTarget(node.tag, [], ancestors);
  }

  if (node.type === "AssignmentExpression") {
    // The whole assignment goes: replacing only its target would leave
    // `(void 0) = ...` / `(void 0).x = ...` (invalid or a runtime write).
    return isForbiddenTarget(node.left, node.right, ancestors);
  }

  if (node.type === "UpdateExpression") {
    // `window.x++` / `o.__proto__.x++` write the target just like `=`.
    return isForbiddenTarget(node.argument, undefined, ancestors);
  }

  if (node.type === "UnaryExpression") {
    // `delete window.x` / `delete Foo.prototype.bar` removes a capability or
    // a guard through the same protected write target as an assignment.
    return node.operator === "delete" && isForbiddenTarget(node.argument, undefined, ancestors);
  }

  // Prototype escapes are reads too: `f.constructor`, `x.__proto__`,
  // `Fn.prototype` — the material for the Function() bypass. Runs on the
  // MemberExpression itself (not just calls); the OUTERMOST cut wins, so a
  // chain such as `({}).constructor.name` collapses to one `(void 0)`.
  // Reflect members are the same material (`Reflect.get(fn, "constructor")`),
  // including a reference plucked out for a later indirect call.
  if (node.type === "MemberExpression") {
    return (
      hasForbiddenMemberProp(node) ||
      isForbiddenGlobalMember(node, ancestors) ||
      isForbiddenObjectMemberRead(node, ancestors) ||
      isGlobalObjectAlias(node, ancestors) ||
      isDynamicGlobalMember(node, ancestors)
    );
  }

  return false;
}

/** Object-literal properties to drop entirely (props, not statements). */
function isForbiddenProperty(node: AnyNode): boolean {
  if (node.type !== "Property") return false;
  const key = propName(node.key, node.computed);
  if (key === "dangerouslySetInnerHTML") return true;
  if (key && URL_ATTRS.has(key) && isJavascriptUrl(node.value)) return true;
  return false;
}

/**
 * Audit verdict: what to cut (byte ranges in the parsed source) + what was
 * cut (findings, for the lint report). The sanitizer REPLACES those ranges
 * in place (magic-string), never regenerates the tree — so every line the
 * model wrote stays on its own line and any upstream source map keeps
 * pointing at the right region.
 */
type Verdict = {
  /** Expression nodes to replace with `(void 0)`. */
  forbidden: AnyNode[];
  /** Object-literal / ObjectPattern properties and export specifiers to drop (with their comma). */
  forbiddenProps: AnyNode[];
  /** Positions where a `;` must be inserted (ASI guard, see asiGuardPosition). */
  insertions: number[];
  stripped: AuditFinding[];
};

/** One sanitized capability, with its location for the lint report. */
export type AuditFinding = { line?: number; column?: number; reason: string };

/** Short human label for a sanitized node — the lint shows it per line. */
function describeForbidden(node: AnyNode): string {
  if (node.type === "Identifier") {
    return `\`${node.name}\` reference (forbidden capability)`;
  }
  if (node.type === "MemberExpression") {
    return `\`.${propName(node.property, node.computed)}\` access (prototype-chain escape)`;
  }
  if (node.type === "CallExpression" || node.type === "NewExpression") {
    const callee: AnyNode = node.callee;
    const tail = callee && callee.type === "MemberExpression" ? propName(callee.property, callee.computed) : null;
    const name = callee && callee.type === "Identifier" ? callee.name : tail;
    return `\`${name || node.type}\` call (forbidden capability)`;
  }
  if (node.type === "TaggedTemplateExpression") {
    const tag: AnyNode = node.tag;
    const name = tag && tag.type === "Identifier" ? tag.name : tag && tag.type === "MemberExpression" ? propName(tag.property, tag.computed) : null;
    return `\`${name || "tagged template"}\` tagged template (forbidden capability)`;
  }
  if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
    return "loop into a protected assignment target";
  }
  if (node.type === "VariableDeclaration") return "destructuring of forbidden capability names";
  if (node.type === "AssignmentExpression") return "assignment to a protected target";
  if (node.type === "UpdateExpression") return "update of a protected target";
  if (node.type === "UnaryExpression") return "`delete` of a protected target";
  if (node.type === "Property") {
    const key = propName(node.key, node.computed);
    return key ? `\`${key}\` property (forbidden capability)` : "forbidden property";
  }
  if (node.type === "ExportSpecifier") {
    return `\`${node.local?.name}\` export of a removed binding`;
  }
  if (node.type === "ExportNamedDeclaration") return "export of a removed binding";
  if (node.type === "ImportExpression") return "dynamic import of a non-whitelisted specifier";
  return "forbidden capability";
}

/**
 * Cut a list item WITH the comma that separates it (keep the leading one):
 * the surrounding object literal / pattern stays parseable without reflow.
 */
function cutItemWithComma(node: AnyNode, items: AnyNode[], source: string): [number, number] {
  const idx = items.indexOf(node);
  const next = idx >= 0 ? items[idx + 1] : null;
  if (next) return [node.start, next.start];
  const tail = source.slice(node.end).match(/^\s*,/);
  return [node.start, tail ? node.end + tail[0].length : node.end];
}

/**
 * Parents that hold a LIST of statements: a leading `;` there is always a
 * valid (empty) statement. The single-statement slots (`if`/loop bodies,
 * `do` bodies, labels) must NOT get one — an extra statement would detach
 * the body from its `else`/`while`.
 */
const STATEMENT_LIST_TYPES: Record<string, true> = {
  Program: true,
  BlockStatement: true,
  StaticBlock: true,
  SwitchCase: true,
};

/**
 * True when a parenthesized replacement would sit at the START of an
 * expression statement in a statement list. The source statement previously
 * began with a token (`fetch`) that terminated the previous line by ASI;
 * `(void 0)` would instead be parsed as a CALL on it. A `;` keeps the two
 * statements apart.
 */
function startsListedStatement(node: AnyNode, ancestors?: AnyNode[]): boolean {
  if (!ancestors) return false;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const stmt = ancestors[i];
    if (stmt.type !== "ExpressionStatement") continue;
    if (stmt.expression === node || stmt.start !== node.start) return false;
    const parent = i > 0 ? ancestors[i - 1] : null;
    return !!parent && STATEMENT_LIST_TYPES[parent.type] === true;
  }
  return false;
}

/** Characters that can END an expression, and therefore a statement. */
const STATEMENT_END_CHAR = /[)\]}"'`\w$]/;

/**
 * Bracket depth at `pos`, counted from TOKENS: a `(`, `[`, `{` in a string,
 * comment or regex literal is data and never moves the counter.
 */
function bracketDepthAt(source: string, pos: number): number {
  let depth = 0;
  try {
    const tokens = tokenizer(source, { ecmaVersion: "latest", sourceType: "module" });
    for (;;) {
      const token = tokens.getToken();
      if (token.start >= pos || token.type.label === "eof") break;
      switch (token.type.label) {
        case "(":
        case "[":
        case "{":
        case "${":
          depth++;
          break;
        case ")":
        case "]":
        case "}":
          depth--;
          break;
      }
    }
  } catch {
    return -1;
  }
  return depth;
}

/**
 * Position where a `;` must be inserted so a sanitized STATEMENT-INITIAL
 * sub-expression does not continue the previous line as a call or index:
 * `foo()\n(fetch(u)).then(...)` parses as `foo()(fetch(u))`, and replacing
 * `fetch(u)` in place would leave one statement where the model wrote two.
 * A `;` before the line's `(`/`[` restores the split. Genuine continuation
 * lines are left alone: the previous line must end with a token that can
 * close a statement (`)`, an identifier, a literal, ...) and the bracket
 * must sit at statement level — `foo(\n  bar\n  (fetch(u))\n)` is inside a
 * call's argument list and cannot take a `;` there.
 *
 * Two AST gates keep the guard out of slots that take ONE statement:
 *   - The enclosing ExpressionStatement must be a LIST ITEM (`if (ok)\n
 *     (fetch(u))` is the `if` body: a `;` there would become an
 *     EmptyStatement body and orphan the `else`/`while`).
 *   - The statement must actually START on an earlier line and continue here
 *     through the leading bracket (`stmt.start < pos` plus a newline in
 *     between). When the statement starts at the bracket, a previous
 *     statement already ended — no guard needed.
 */
function asiGuardPosition(node: AnyNode, source: string, ancestors?: AnyNode[]): number | null {
  if (node.start < 1 || !ancestors) return null;
  let stmt: AnyNode | null = null;
  let stmtIndex = -1;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].type !== "ExpressionStatement") continue;
    stmt = ancestors[i];
    stmtIndex = i;
    break;
  }
  if (!stmt || stmtIndex === 0) return null;
  if (STATEMENT_LIST_TYPES[ancestors[stmtIndex - 1].type] !== true) return null;
  const lineStart = source.lastIndexOf("\n", node.start - 1) + 1;
  if (lineStart === 0) return null;
  const lead = source.slice(lineStart, node.start);
  const open = /^[ \t]*([([]+)$/.exec(lead);
  if (!open) return null;
  const prevLine = source.slice(0, lineStart - 1).replace(/[ \t\r]+$/, "");
  if (!STATEMENT_END_CHAR.test(prevLine.slice(-1))) return null;
  const bracket = lineStart + lead.indexOf(open[1]);
  if (stmt.start >= bracket) return null;
  if (!source.slice(stmt.start, bracket).includes("\n")) return null;
  if (bracketDepthAt(source, bracket) !== 0) return null;
  return bracket;
}

/**
 * Replacement text for a flagged node. A forbidden loop or declaration IS a
 * statement: it becomes one expression statement (`void 0;`), which is valid
 * exactly where the grammar requires a SINGLE statement (`if (...) <stmt>
 * else <stmt>`, `do <stmt> while (...)`). `void` is a keyword, so the text
 * never glues onto a preceding line the way `(void 0)` would. A forbidden
 * expression that IS the whole expression statement drops its parentheses
 * for the same reason; a statement-INITIAL sub-expression adds a `;` guard;
 * everywhere else the parentheses are load-bearing (`(void 0).then(...)`
 * must stay a primary expression).
 */
function replacementFor(node: AnyNode, ancestors?: AnyNode[]): string {
  if (node.type === "ForInStatement" || node.type === "ForOfStatement") return "void 0;";
  // A local `export { f }` whose every specifier is gone is a STATEMENT in a
  // statement list: one `void 0;` keeps the module parseable.
  if (node.type === "ExportNamedDeclaration") return "void 0;";
  const at = ancestors ? ancestors.indexOf(node) : -1;
  const parent = ancestors && at > 0 ? ancestors[at - 1] : parentOf(ancestors);
  if (node.type === "VariableDeclaration") {
    // `for (const { x } = y; ; )` is an EXPRESSION slot: a trailing
    // statement semicolon there would add a fourth `for` separator.
    return parent && parent.type === "ForStatement" && parent.init === node ? "void 0" : "void 0;";
  }
  if (parent && parent.type === "ExpressionStatement" && parent.expression === node) return "void 0";
  return startsListedStatement(node, ancestors) ? ";(void 0)" : "(void 0)";
}

/**
 * The decision layer: walk every node with its ancestor chain and record
 * what must go (with the line it sits on, for the lint report). The walker
 * is also the compatibility gate — a node type acorn-walk cannot traverse
 * throws here and fails closed, never in prod.
 */
function audit(ast: Node, source: string): Verdict {
  const forbidden: AnyNode[] = [];
  const forbiddenProps: AnyNode[] = [];
  const insertions: number[] = [];
  const entries: Array<{ node: AnyNode; finding: AuditFinding }> = [];
  const recorded = new Set<AnyNode>();
  /**
   * Bindings removed by the pattern audit, keyed by scope: their later reads
   * must go too, but only inside the scope that actually owned the removed
   * declaration (`function g(c)` shadows the `c` stripped outside it).
   */
  const strippedBindings = new Map<string, Set<AnyNode>>();
  /** ObjectPatterns left with no properties at all (inner cuts propagate out). */
  const strippedPatterns = new Set<AnyNode>();
  const record = (node: AnyNode) => {
    if (recorded.has(node)) return;
    recorded.add(node);
    entries.push({
      node,
      finding: { line: node.loc?.start?.line, column: node.loc?.start?.column, reason: describeForbidden(node) },
    });
  };
  const cutProperty = (prop: AnyNode, items: AnyNode[]) => {
    forbiddenProps.push(prop);
    record(prop);
    prop.cutRange = cutItemWithComma(prop, items, source);
  };
  /** Register every identifier a stripped binding pattern removed. */
  const stripBindings = (pattern: AnyNode, ancestors: AnyNode[]) => {
    const names = new Set<string>();
    addBindingNames(pattern, names);
    const scope = bindingScopeOf(ancestors);
    if (!scope) return;
    for (const name of names) {
      let scopes = strippedBindings.get(name);
      if (!scopes) {
        scopes = new Set();
        strippedBindings.set(name, scopes);
      }
      scopes.add(scope);
    }
  };
  const mark = (node: AnyNode, ancestors: AnyNode[]) => {
    node.cutText = replacementFor(node, ancestors);
    if (node.cutText === "(void 0)") {
      // A line-leading `(`/`[` would swallow the replacement into the
      // previous statement; the inserted `;` restores the statement split.
      const guard = asiGuardPosition(node, source, ancestors);
      if (guard !== null) insertions.push(guard);
    }
    forbidden.push(node);
    record(node);
  };
  const flag = (node: AnyNode, ancestors: AnyNode[]) => {
    const parent = parentOf(ancestors);
    const grand = grandParentOf(ancestors);
    // A shorthand object literal (`{ window }`) shares one identifier between
    // key and value: replacing only the value yields `{ (void 0) }`, which is
    // not valid JS. Cut the whole property (with its comma) instead.
    if (
      parent &&
      parent.type === "Property" &&
      parent.shorthand &&
      parent.value === node &&
      grand &&
      grand.type === "ObjectExpression"
    ) {
      cutProperty(parent, grand.properties || []);
      return;
    }
    mark(node, ancestors);
  };
  walk.ancestor(ast, {
    Expression(node: AnyNode, ancestors: AnyNode[]) {
      if (isForbiddenExpression(node, ancestors)) flag(node, ancestors);
    },
    Property(node: AnyNode, ancestors: AnyNode[]) {
      if (!isForbiddenProperty(node)) return;
      const parent = parentOf(ancestors);
      const items: AnyNode[] = (parent && (parent.properties || parent.value?.elements)) || [];
      cutProperty(node, items);
    },
    /**
     * ObjectPattern properties never reach the `Property` visitor (acorn-walk
     * walks pattern VALUES), so `const { constructor } = fn` and
     * `const { fetch } = window` need their own visitor. Dropping the
     * property leaves `{}` / `{ keep }` — valid destructuring that can no
     * longer bind the capability. Only prototype escapes are stripped
     * unconditionally: `{ open, location } = props` is ordinary widget code.
     * A protected source strips capability keys; a Reflect source or a
     * dynamic member (`window[k]`) strips EVERY key, since the property name
     * cannot be audited. Nested patterns are visited first (post-order), so
     * an inner pattern that ends up empty takes its outer property with it.
     * A declaration left with no properties at all goes WHOLE: an empty
     * pattern over a cut source (`const {} = (void 0)`) throws at runtime.
     */
    ObjectPattern(node: AnyNode, ancestors: AnyNode[]) {
      const items: AnyNode[] = node.properties || [];
      const origin = patternOrigin(node, ancestors);
      const infos = origin.sources.map((src) => patternSourceInfo(src, ancestors));
      const protectedSource = infos.some((info) => info.protected);
      const reflect = infos.some((info) => info.reflect);
      const dynamicSource = infos.some((info) => info.dynamic);
      let kept = 0;
      for (const prop of items) {
        if (prop.type === "RestElement") {
          // `{ ...rest } = window` copies EVERY property, `fetch` included.
          if (protectedSource) {
            cutProperty(prop, items);
            stripBindings(prop.argument, ancestors);
          } else {
            kept++;
          }
          continue;
        }
        const key = propName(prop.key, prop.computed);
        const inner = innerObjectPattern(prop.value);
        const always = key !== null && ALWAYS_FORBIDDEN_PATTERN_KEYS.has(key);
        const contextual =
          protectedSource && key !== null && (reflect || dynamicSource || PROTECTED_PATTERN_KEYS.has(key));
        // A dynamic computed key cannot be audited on ANY source:
        // `const { [k]: c } = v` can bind `constructor`/`__proto__` from
        // whatever `v` is, so the property always goes.
        const dynamicKey = prop.computed && key === null;
        if (always || contextual || dynamicKey || (inner !== null && strippedPatterns.has(inner))) {
          cutProperty(prop, items);
          stripBindings(prop.value, ancestors);
        } else {
          kept++;
        }
      }
      const empty = items.length === 0;
      if (!empty && kept === 0) strippedPatterns.add(node);
      // An EMPTY pattern over a protected source (`const {} = window`,
      // `({} = window)`) binds nothing but still hands the source object
      // over: the pattern VALUE is the right-hand side. It is the same alias
      // as `const w = window`, so the declaration/assignment goes whole.
      if (!origin.direct || kept > 0 || (empty && !protectedSource)) return;
      // The pattern binds nothing anymore. Removing only its properties would
      // leave `const {} = (void 0)` (a TypeError) once the source is cut, so
      // the declaration/assignment goes with it when it can go whole.
      const parent = parentOf(ancestors);
      if (parent && parent.type === "AssignmentExpression") {
        mark(parent, ancestors);
      } else if (parent && parent.type === "VariableDeclarator") {
        const at = ancestors.indexOf(parent);
        const decl = at > 0 ? ancestors[at - 1] : null;
        const outer = at > 1 ? ancestors[at - 2] : null;
        if (
          decl &&
          decl.type === "VariableDeclaration" &&
          (decl.declarations || []).length === 1 &&
          outer?.type !== "ExportNamedDeclaration"
        ) {
          mark(decl, ancestors);
        }
      }
    },
    /**
     * `for (window.y in x)` / `for ([el.innerHTML] of x)` assign into a
     * protected target on every iteration. Replacing the pattern alone would
     * leave invalid JS (`for ((void 0) of x)`), so the WHOLE loop becomes an
     * expression statement; the sanitizer keeps its newlines.
     */
    ForInStatement(node: AnyNode, ancestors: AnyNode[]) {
      if (node.left && node.left.type !== "VariableDeclaration" && isForbiddenTarget(node.left, undefined, ancestors)) {
        mark(node, ancestors);
      }
    },
    ForOfStatement(node: AnyNode, ancestors: AnyNode[]) {
      if (node.left && node.left.type !== "VariableDeclaration" && isForbiddenTarget(node.left, undefined, ancestors)) {
        mark(node, ancestors);
      }
    },
  });
  // A stripped destructuring binding must not silently fall back to the
  // GLOBAL of the same name: `const { fetch } = window; const f = fetch;`
  // would otherwise re-import the capability the cut just removed. The
  // scope guard keeps a shadowed inner binding (`function g(fetch)`) whole.
  // Writes are visited too: `let { fetch: React } = window; React = fake`
  // only assigns the binding the cut just removed, so the write would reach
  // `window.React` once the declaration is gone.
  if (strippedBindings.size > 0) {
    walk.ancestor(ast, {
      Expression(node: AnyNode, ancestors: AnyNode[]) {
        if (node.type === "AssignmentExpression") {
          if (targetHasStrippedBinding(node.left, ancestors, strippedBindings)) flag(node, ancestors);
          return;
        }
        if (node.type === "UpdateExpression") {
          if (targetHasStrippedBinding(node.argument, ancestors, strippedBindings)) flag(node, ancestors);
          return;
        }
        if (node.type !== "Identifier") return;
        const scopes = strippedBindings.get(node.name);
        if (!scopes) return;
        if (!isIdentifierReference(node, ancestors)) return;
        const scope = bindingScopeFor(node.name, ancestors);
        if (!scope || !scopes.has(scope)) return;
        flag(node, ancestors);
      },
      ForInStatement(node: AnyNode, ancestors: AnyNode[]) {
        if (
          node.left &&
          node.left.type !== "VariableDeclaration" &&
          targetHasStrippedBinding(node.left, ancestors, strippedBindings)
        ) {
          flag(node, ancestors);
        }
      },
      ForOfStatement(node: AnyNode, ancestors: AnyNode[]) {
        if (
          node.left &&
          node.left.type !== "VariableDeclaration" &&
          targetHasStrippedBinding(node.left, ancestors, strippedBindings)
        ) {
          flag(node, ancestors);
        }
      },
    });
  }
  // A local `export { f }` must name a binding the module still declares:
  // once the pattern audit removed `const { fetch: f } = window`, leaving
  // `export { f }` makes ESM instantiation fail ("f is not declared in this
  // file"), and an already-unbound `export { window }` is the same fatal
  // shape. Cut the specifier with its comma; cut the whole declaration when
  // nothing exportable is left.
  walk.ancestor(ast, {
    ExportNamedDeclaration(node: AnyNode, ancestors: AnyNode[]) {
      if (node.source || !(node.specifiers || []).length) return;
      const specs: AnyNode[] = node.specifiers;
      const invalid = specs.filter((spec) => {
        const localName: string | undefined = spec.local?.name;
        if (!localName) return false;
        const scopes = strippedBindings.get(localName);
        const scope = bindingScopeFor(localName, ancestors);
        if (scopes && scope && scopes.has(scope)) return true;
        return !isLocallyBound(localName, ancestors);
      });
      if (invalid.length === 0) return;
      if (invalid.length === specs.length) {
        mark(node, ancestors);
        return;
      }
      for (const spec of invalid) {
        forbiddenProps.push(spec);
        record(spec);
        spec.cutRange = cutItemWithComma(spec, specs, source);
      }
    },
  });
  // Nested matches (a forbidden call inside a forbidden member chain, a
  // pattern property inside a sanitized statement) share one cut range:
  // keep only the OUTERMOST finding, so the report never repeats the same
  // sanitized region.
  const stripped = entries
    .filter(
      ({ node }, i) =>
        !entries.some(
          ({ node: outer }, j) =>
            i !== j &&
            outer.start <= node.start &&
            outer.end >= node.end &&
            (outer.start < node.start || outer.end > node.end),
        ),
    )
    .map(({ finding }) => finding);
  return { forbidden, forbiddenProps, insertions, stripped };
}

/** Parse model JS; null when it is not a parseable ES module. */
function parseModelModule(js: string): Node | null {
  try {
    return parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch {
    return null;
  }
}

/**
 * Import audit: every static and dynamic specifier must be a literal the
 * widget import map (or the one vetted CDN) can resolve. Anything else —
 * bare package names, foreign URLs, variables, template literals — is a
 * compile error with a message the model can act on (plus the location of
 * the first offending specifier, for the lint code frame).
 */
function auditImports(ast: Node): { error: string; loc?: { line?: number; column?: number } } | null {
  const bad: string[] = [];
  let indirect = 0;
  let firstLoc: { line?: number; column?: number } | undefined;
  const mark = (node: AnyNode) => {
    if (!firstLoc) firstLoc = { line: node.loc?.start?.line, column: node.loc?.start?.column };
  };
  walk.simple(ast, {
    ImportDeclaration(node: AnyNode) {
      if (!allowedSpecifier(String(node.source.value))) {
        bad.push(String(node.source.value));
        mark(node);
      }
    },
    ExportNamedDeclaration(node: AnyNode) {
      if (node.source && !allowedSpecifier(String(node.source.value))) {
        bad.push(String(node.source.value));
        mark(node);
      }
    },
    ExportAllDeclaration(node: AnyNode) {
      if (!allowedSpecifier(String(node.source.value))) {
        bad.push(String(node.source.value));
        mark(node);
      }
    },
    ImportExpression(node: AnyNode) {
      const src: AnyNode = node.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string") {
        indirect++;
        mark(node);
      } else if (!allowedSpecifier(src.value)) {
        bad.push(String(src.value));
        mark(node);
      }
    },
  });
  if (bad.length) {
    return {
      loc: firstLoc,
      error:
        `unsupported import${bad.length > 1 ? "s" : ""}: ${bad.map((s) => JSON.stringify(s)).join(", ")} — ` +
        `widgets may only import react / react-dom and the preloaded libs ` +
        `(d3, gsap, chart, three, leaflet, cannon-es, matter-js); esm.sh needs net: true`,
    };
  }
  if (indirect) {
    return {
      loc: firstLoc,
      error: `dynamic import specifier must be a literal string — widgets may only import the preloaded libs or https://esm.sh/ URLs`,
    };
  }
  return null;
}

export type ModelModuleResult =
  | { ok: true; code: string; stripped: AuditFinding[]; map: object }
  | { ok: false; error: string; errorLoc?: { line?: number; column?: number } };

/**
 * Sanitize + report (the audit boundary's main entry): the returned `code`
 * is the input with forbidden ranges replaced in place — line numbers and
 * upstream source maps stay valid. Fails closed on anything unparseable.
 */
export function sanitizeModelModule(compiledCode: string): ModelModuleResult {
  const ast = parseModelModule(compiledCode);
  if (!ast) return { ok: false, error: "invalid widget code: not parseable as an ES module" };
  const importError = auditImports(ast);
  if (importError) return { ok: false, error: importError.error, errorLoc: importError.loc };
  try {
    const verdict = audit(ast, compiledCode);
    const { code, map } = sanitizeCode(compiledCode, verdict);
    return { ok: true, code, map, stripped: verdict.stripped };
  } catch {
    // acorn-walk could not process a node type: fail closed.
    return { ok: false, error: "invalid widget code: unsupported syntax" };
  }
}

/**
 * Map-safe sanitize: replaces the forbidden ranges with `(void 0)` / deletes
 * forbidden properties IN PLACE (magic-string). Each node carries the text
 * chosen by `replacementFor`: a single `void 0;` expression statement where
 * the grammar requires one statement (`if/else`, `do/while`) or a whole
 * declaration/assignment goes, a bare `void 0` for a whole expression
 * statement (a keyword cannot glue onto the previous line), and the
 * parenthesized `(void 0)` only for sub-expressions — the parentheses are
 * load-bearing there (`fetch(u).then(...)`, while bare `void 0.then(...)`
 * lexes as `0.` + identifier). Every replacement carries the newlines the
 * removed text spanned, so ALL lines the model wrote stay on their own line
 * — source maps survive the sanitize.
 */
function sanitizeCode(code: string, verdict: Verdict): { code: string; map: object } {
  const ms = new MagicString(code);
  // Forbidden ranges can nest (a `.constructor` call inside a forbidden
  // `fetch`, say). magic-string cannot overwrite overlapping ranges, so
  // apply the OUTERMOST cut first and drop every edit that overlaps one
  // already applied — the outer replacement covers the inner escape anyway.
  type Cut = { a: number; b: number; text: string };
  const cuts: Cut[] = [];
  for (const prop of verdict.forbiddenProps) {
    const [a, b] = prop.cutRange ?? [prop.start, prop.end];
    cuts.push({ a, b, text: "" });
  }
  for (const node of verdict.forbidden) {
    cuts.push({ a: node.start, b: node.end, text: node.cutText ?? "(void 0)" });
  }
  cuts.sort((x, y) => x.a - y.a || y.b - x.b);
  // Apply the OUTERMOST non-overlapping cuts; nested edits are dropped.
  const applied: Cut[] = [];
  let lastEnd = -1;
  for (const cut of cuts) {
    if (cut.a < lastEnd) continue; // nested/overlapping: outer cut wins
    lastEnd = cut.b;
    applied.push(cut);
  }
  // ASI guards: a `;` that starts a statement-continuation line. A guard
  // inside an applied cut is moot (that text is replaced anyway); one AT the
  // cut start prefixes the replacement, because magic-string drops an
  // insertion made exactly where an overwrite begins.
  for (const pos of new Set(verdict.insertions)) {
    const host = applied.find((cut) => cut.a <= pos && pos < cut.b);
    if (!host) ms.appendLeft(pos, ";");
    else if (host.a === pos && host.text && !host.text.startsWith(";")) host.text = `;${host.text}`;
  }
  for (const cut of applied) {
    const newlines = (code.slice(cut.a, cut.b).match(/\n/g) || []).length;
    ms.overwrite(cut.a, cut.b, cut.text + "\n".repeat(newlines));
  }
  return {
    code: ms.toString(),
    // source-map from the sanitized text back to the text being sanitized —
    // the lint chains this with the transpile map (remapping) so frames
    // survive BOTH stages.
    map: ms.generateMap({ source: "widget.js", includeContent: false, hires: true }) as unknown as object,
  };
}

/**
 * The full model-code boundary on compiled (post-Bun) module code: parse,
 * audit imports, sanitize forbidden capabilities, regenerate. Returns the
 * final module source (plus the sanitized findings, with lines, for lint
 * reporting), or a compile error the model can act on. This is the entry
 * point compileJsxModule uses.
 */
export function enforceModelModule(compiledCode: string): ModelModuleResult {
  return sanitizeModelModule(compiledCode);
}

/**
 * Sanitize model-authored module code (belt-and-braces entry point used by
 * the module-body builder): forbidden capability ranges are replaced in
 * place, everything else is untouched. Unparseable input passes through
 * unchanged — by this point the code already compiled, so anything odd
 * here must NOT shift a single line of the model's source.
 */
export function sanitizeModelJS(js: string): string {
  const ast = parseModelModule(js);
  if (!ast) return js;
  try {
    return sanitizeCode(js, audit(ast, js)).code;
  } catch {
    return js;
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
