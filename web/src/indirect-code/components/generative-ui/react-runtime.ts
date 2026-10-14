/**
 * Generative UI: a compact React 1:1 runtime embedded into `generative_ui`
 * widget documents. The widget format is plain React — function components,
 * hooks, className/style objects, Context, memo/forwardRef, an App root —
 * compiled to `React.createElement` calls by Bun.Transpiler at doc build time
 * (jsx-compile.ts). This runtime provides the same public surface the
 * compiled code touches, over a minimal fiber reconciler.
 *
 * API semantics mirror React 18 (function + class components, hooks). There
 * is no concurrent scheduling: setState re-renders on a microtask. Widgets
 * are small, so reconciliation is a keyed/positional DOM diff — enough to
 * keep input focus and slider drags alive across renders.
 *
 * Globals exposed inside the widget document:
 *   React, ReactDOM, ReactDOMClient
 *   plus bare hook aliases (useState, useEffect, ...) for import-free code.
 *
 * Keep this dependency-free and eval-free: the widget CSP has no
 * 'unsafe-eval' and no network. Top-level `return`-able plain script body.
 */

export const REACT_RUNTIME_JS = String.raw`(function () {
  "use strict";

  /* ---------------- elements ---------------- */

  var REACT_ELEMENT_TYPE = (typeof Symbol === "function" && Symbol.for) ? Symbol.for("react.element") : 0xeac7;
  var REACT_FRAGMENT_TYPE = (typeof Symbol === "function" && Symbol.for) ? Symbol.for("react.fragment") : 0xeacb;
  var FORWARD_REF_TYPE = (typeof Symbol === "function" && Symbol.for) ? Symbol.for("react.forward_ref") : 0xead0;
  var MEMO_TYPE = (typeof Symbol === "function" && Symbol.for) ? Symbol.for("react.memo") : 0xead3;
  var PROVIDER_TYPE = (typeof Symbol === "function" && Symbol.for) ? Symbol.for("react.context") : 0xeace;

  var Fragment = REACT_FRAGMENT_TYPE;

  function createElement(type, config) {
    var props = {};
    var key = null;
    var ref = null;
    if (config != null) {
      if (config.key !== undefined && config.key !== null) key = "" + config.key;
      if (config.ref !== undefined) ref = config.ref;
      for (var k in config) {
        if (!Object.prototype.hasOwnProperty.call(config, k)) continue;
        if (k === "key" || k === "ref" || k === "__self" || k === "__source") continue;
        props[k] = config[k];
      }
    }
    var n = arguments.length - 2;
    if (n === 1) {
      props.children = arguments[2];
    } else if (n > 1) {
      var children = new Array(n);
      for (var i = 0; i < n; i++) children[i] = arguments[i + 2];
      props.children = children;
    }
    if (type && type.defaultProps) {
      var defs = type.defaultProps;
      for (var dk in defs) {
        if (props[dk] === undefined) props[dk] = defs[dk];
      }
    }
    return { $$typeof: REACT_ELEMENT_TYPE, type: type, key: key, ref: ref, props: props };
  }

  function cloneElement(element) {
    if (element == null || typeof element !== "object") return element;
    var args = [element.type, element.props];
    for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
    var copy = createElement.apply(null, args);
    copy.key = element.key;
    copy.ref = element.ref;
    return copy;
  }

  function isValidElement(x) {
    return !!x && typeof x === "object" && x.$$typeof === REACT_ELEMENT_TYPE;
  }

  function flattenInto(children, out) {
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) flattenInto(children[i], out);
    } else {
      out.push(children);
    }
  }

  function notNull(x) { return x != null; }

  var Children = {
    map: function (children, fn) {
      var out = [];
      flattenInto(children, out);
      var res = [];
      for (var i = 0; i < out.length; i++) {
        var r = fn(out[i], i);
        if (Array.isArray(r)) flattenInto(r, res);
        else res.push(r);
      }
      return res.filter(notNull);
    },
    forEach: function (children, fn) {
      var out = [];
      flattenInto(children, out);
      for (var i = 0; i < out.length; i++) fn(out[i], i);
    },
    count: function (children) {
      var out = [];
      flattenInto(children, out);
      return out.length;
    },
    only: function (children) {
      var out = [];
      flattenInto(children, out);
      if (out.length !== 1 || !isValidElement(out[0])) {
        throw new Error("Children.only: expected a single element");
      }
      return out[0];
    },
    toArray: function (children) {
      var out = [];
      flattenInto(children, out);
      return out;
    },
  };

  /* ---------------- class components ---------------- */

  function Component(props, context) {
    this.props = props;
    this.context = context;
    this.refs = {};
  }
  Component.prototype.isReactComponent = {};
  Component.prototype.setState = function (partial) {
    var fiber = this.__fiber;
    if (!fiber) return;
    if (typeof partial === "function") {
      var fn = partial;
      this.__pending = function (prev) {
        var next = fn(prev, this.props);
        return next == null ? prev : Object.assign({}, prev, next);
      }.bind(this);
    } else if (partial != null) {
      this.__pending = function (prev) { return Object.assign({}, prev, partial); };
    }
    scheduleRender(fiber);
  };
  Component.prototype.forceUpdate = function () {
    if (this.__fiber) scheduleRender(this.__fiber);
  };

  function PureComponent(props, context) {
    Component.call(this, props, context);
  }
  PureComponent.prototype = Object.create(Component.prototype);
  PureComponent.prototype.constructor = PureComponent;
  PureComponent.prototype.isPureReactComponent = true;

  /* ---------------- context ---------------- */

  var contextCounter = 0;

  function createContext(defaultValue) {
    var id = "ctx" + (++contextCounter);
    function Provider(props) {
      Provider.__value = props.value === undefined ? defaultValue : props.value;
      return props.children;
    }
    Provider.__isProvider = true;
    Provider.__id = id;
    Provider.__defaultValue = defaultValue;
    Provider.__value = defaultValue;
    var context = {
      $$typeof: PROVIDER_TYPE,
      _id: id,
      Provider: Provider,
      Consumer: function (props) {
        return props.children(readContext(context));
      },
    };
    return context;
  }

  function readContext(context) {
    var fiber = currentFiber;
    while (fiber) {
      if (fiber.__contexts && Object.prototype.hasOwnProperty.call(fiber.__contexts, context._id)) {
        return fiber.__contexts[context._id];
      }
      fiber = fiber.parent;
    }
    return context.__defaultValue;
  }

  /* ---------------- hooks ---------------- */

  var currentFiber = null;
  var hookIndex = 0;
  var pendingEffects = [];
  var pendingLayoutEffects = [];

  function getHook(initial) {
    var fiber = currentFiber;
    var hooks = fiber.hooks || (fiber.hooks = []);
    var i = hookIndex++;
    var hook = hooks[i];
    if (!hook) {
      hook = { state: initial, queue: [], cleanup: null, init: false };
      hooks[i] = hook;
    }
    return hook;
  }

  function basicStateReducer(state, action) {
    return typeof action === "function" ? action(state) : action;
  }

  function useState(initial) {
    return useReducer(basicStateReducer, initial);
  }

  function useReducer(reducer, initialArg, init) {
    var hook = getHook(undefined);
    if (!hook.init) {
      hook.state = typeof init === "function" ? init(initialArg) : initialArg;
      hook.init = true;
    }
    var fiber = currentFiber;
    var dispatch = hook.dispatch;
    if (!dispatch) {
      dispatch = hook.dispatch = function (action) {
        hook.queue.push(function (prev) { return hook.reducer(prev, action); });
        scheduleRender(fiber);
      };
    }
    hook.reducer = reducer;
    var state = hook.state;
    for (var i = 0; i < hook.queue.length; i++) state = hook.queue[i](state);
    hook.queue.length = 0;
    hook.state = state;
    return [state, dispatch];
  }

  function useMemo(factory, deps) {
    var hook = getHook(undefined);
    if (!hook.init || depsChanged(hook.deps, deps)) {
      hook.deps = deps;
      hook.state = factory();
      hook.init = true;
    }
    return hook.state;
  }

  function useCallback(fn, deps) {
    return useMemo(function () { return fn; }, deps);
  }

  function useRef(initial) {
    var hook = getHook(undefined);
    if (!hook.init) {
      hook.state = { current: initial };
      hook.init = true;
    }
    return hook.state;
  }

  function useEffect(fn, deps) {
    var hook = getHook(undefined);
    if (!hook.init || depsChanged(hook.deps, deps)) {
      hook.deps = deps;
      hook.init = true;
      pendingEffects.push({ hook: hook, fn: fn });
    }
  }

  function useLayoutEffect(fn, deps) {
    var hook = getHook(undefined);
    if (!hook.init || depsChanged(hook.deps, deps)) {
      hook.deps = deps;
      hook.init = true;
      pendingLayoutEffects.push({ hook: hook, fn: fn });
    }
  }

  function useContext(context) {
    return readContext(context);
  }

  var idCounter = 0;

  function useId() {
    var hook = getHook(undefined);
    if (!hook.init) {
      hook.state = ":r" + (++idCounter) + ":";
      hook.init = true;
    }
    return hook.state;
  }

  function useDebugValue(value) { /* no-op */ }

  function useImperativeHandle(ref, factory, deps) {
    useLayoutEffect(function () {
      if (typeof ref === "function") {
        var cleanup = ref(factory());
        return function () {
          if (typeof cleanup === "function") cleanup();
          else ref(null);
        };
      }
      if (ref && typeof ref === "object") {
        ref.current = factory();
        return function () { ref.current = null; };
      }
    }, deps);
  }

  function useTransition() {
    return [false, function (fn) { if (typeof fn === "function") fn(); }];
  }

  function useDeferredValue(value) {
    return value;
  }

  function useSyncExternalStore(subscribe, getSnapshot) {
    var hook = getHook(undefined);
    if (!hook.init) {
      hook.state = getSnapshot();
      hook.init = true;
    }
    useEffect(function () {
      hook.state = getSnapshot();
      return subscribe(function () {
        var next = getSnapshot();
        if (!Object.is(next, hook.state)) {
          hook.state = next;
          scheduleRender(currentFiberOf(hook));
        }
      });
    }, [subscribe, getSnapshot]);
    return hook.state;
  }

  var hookRootFiber = null;
  function currentFiberOf() { return hookRootFiber; }

  function startTransition(fn) {
    if (typeof fn === "function") fn();
  }

  function depsChanged(a, b) {
    if (a === undefined || b === undefined) return true;
    if (a.length !== b.length) return true;
    for (var i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return true;
    }
    return false;
  }

  function runEffects(list) {
    var entries = list.splice(0, list.length);
    for (var i = 0; i < entries.length; i++) {
      var hook = entries[i].hook;
      if (hook.cleanup) {
        try { hook.cleanup(); } catch (err) { reportError(err); }
        hook.cleanup = null;
      }
      try {
        var cleanup = entries[i].fn();
        if (typeof cleanup === "function") hook.cleanup = cleanup;
      } catch (err) { reportError(err); }
    }
  }

  function runCleanup(fiber) {
    if (!fiber || !fiber.hooks) return;
    for (var i = 0; i < fiber.hooks.length; i++) {
      var hook = fiber.hooks[i];
      if (hook && hook.cleanup) {
        try { hook.cleanup(); } catch (err) { reportError(err); }
        hook.cleanup = null;
      }
    }
  }

  function reportError(err) {
    try {
      console.error("[generative-ui]", err);
    } catch (ignore) {}
    try {
      if (window.__gu && window.__gu.reportError) window.__gu.reportError(err);
    } catch (ignore) {}
  }

  /* ---------------- memo / forwardRef ---------------- */

  function memo(type, areEqual) {
    return { $$typeof: MEMO_TYPE, type: type, compare: areEqual || shallowEqual };
  }

  function forwardRef(render) {
    return { $$typeof: FORWARD_REF_TYPE, render: render };
  }

  function shallowEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !Object.is(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }

  /* ---------------- reconciler ----------------
   *
   * Fiber: { type, props, key, ref, dom, nodes, children, hooks, parent,
   *          instance, __contexts, __root, __holder }
   * "nodes" is the ordered DOM surface the fiber contributes to its parent.
   * Placement walks a cursor through the managed DOM parent and inserts /
   * reuses nodes in order, so keyed moves and text updates keep their DOM.
   */

  var dirtyRoots = [];
  var flushScheduled = false;

  function scheduleRender(fiber) {
    var root = fiber.__root;
    if (!root || root.__unmounted) return;
    hookRootFiber = fiber;
    if (dirtyRoots.indexOf(root) === -1) dirtyRoots.push(root);
    if (!flushScheduled) {
      flushScheduled = true;
      Promise.resolve().then(flushRoots);
    }
  }

  function flushRoots() {
    flushScheduled = false;
    var roots = dirtyRoots.splice(0, dirtyRoots.length);
    for (var i = 0; i < roots.length; i++) {
      if (!roots[i].__unmounted) renderRoot(roots[i]);
    }
  }

  function createRoot(container) {
    var root = {
      __container: container,
      __fiber: null,
      __unmounted: false,
      __element: null,
      render: function (element) {
        root.__element = element;
        if (!root.__unmounted) renderRoot(root);
      },
      unmount: function () {
        root.__unmounted = true;
        if (root.__fiber) {
          unmountFiber(root.__fiber);
          root.__fiber = null;
        }
        container.innerHTML = "";
      },
    };
    return root;
  }

  function renderRoot(root) {
    var container = root.__container;
    var element = root.__element;
    if (element === undefined || element === null) {
      container.innerHTML = "";
      root.__fiber = null;
      return;
    }
    var host = root.__fiber;
    if (!host) {
      host = {
        type: null,
        props: {},
        key: null,
        ref: null,
        dom: container,
        nodes: [],
        children: [],
        hooks: null,
        parent: null,
        instance: null,
        __contexts: {},
        __root: root,
      };
      root.__fiber = host;
    }
    reconcileChildren(host, [element], container);
    runEffects(pendingLayoutEffects);
    runEffects(pendingEffects);
    afterRender();
  }

  function afterRender() {
    try {
      if (window.__gu && window.__gu.render) window.__gu.render();
    } catch (err) { reportError(err); }
    try {
      if (typeof window.__guOnWidgetRender === "function") window.__guOnWidgetRender(document.body);
    } catch (err) { reportError(err); }
  }

  var TEXT_TYPE = "#text";

  function sameType(a, b) {
    if (a === b) return true;
    if (a && b && typeof a === "object" && typeof b === "object") {
      if (a.$$typeof === MEMO_TYPE && b.$$typeof === MEMO_TYPE) return sameType(a.type, b.type);
      if (a.$$typeof === FORWARD_REF_TYPE && b.$$typeof === FORWARD_REF_TYPE) return a.render === b.render;
    }
    return false;
  }

  /**
   * Reconcile rendered children into parentFiber, diffing against
   * parentFiber.children and placing the produced DOM under domParent.
   */
  function reconcileChildren(parentFiber, elements, domParent) {
    var oldFibers = parentFiber.children;
    var used = {};
    var i;

    var flat = [];
    flattenInto(elements, flat);

    var newFibers = new Array(flat.length);
    var cursor = domParent.firstChild;

    for (var idx = 0; idx < flat.length; idx++) {
      var el = flat[idx];
      if (el === null || el === undefined || typeof el === "boolean") {
        newFibers[idx] = null;
        continue;
      }

      var elKey = (typeof el === "object" && el.key != null) ? "k" + el.key : null;
      var type = typeof el === "object" ? el.type : TEXT_TYPE;
      var match = null;

      if (elKey != null) {
        for (i = 0; i < oldFibers.length; i++) {
          if (used[i]) continue;
          var of = oldFibers[i];
          if (of && of.key != null && "k" + of.key === elKey && sameType(of.type, type)) {
            match = of;
            used[i] = true;
            break;
          }
        }
      }
      if (!match) {
        for (i = 0; i < oldFibers.length; i++) {
          if (used[i]) continue;
          var cand = oldFibers[i];
          if (cand && cand.key == null && sameType(cand.type, type)) {
            match = cand;
            used[i] = true;
            break;
          }
        }
      }

      var fiber;
      if (match) {
        fiber = match;
        fiber.props = typeof el === "object" ? el.props : { value: el };
        fiber.ref = typeof el === "object" ? el.ref : null;
      } else {
        fiber = {
          type: type,
          props: typeof el === "object" ? el.props : { value: el },
          key: typeof el === "object" ? el.key : null,
          ref: typeof el === "object" ? el.ref : null,
          dom: null,
          nodes: [],
          children: [],
          hooks: null,
          parent: null,
          instance: null,
          __contexts: parentFiber.__contexts,
          __root: parentFiber.__root,
        };
      }
      fiber.parent = parentFiber;
      fiber.__root = parentFiber.__root;
      if (!fiber.__contexts || fiber.__contexts === (parentFiber.parent && parentFiber.parent.__contexts)) {
        fiber.__contexts = parentFiber.__contexts;
      }

      renderFiber(fiber);
      newFibers[idx] = fiber;

      // Placement: walk the cursor past nodes already in place, insert the
      // fiber's DOM surface before it otherwise.
      for (var ni = 0; ni < fiber.nodes.length; ni++) {
        var node = fiber.nodes[ni];
        if (!node) continue;
        if (cursor === node) {
          cursor = node.nextSibling;
        } else {
          domParent.insertBefore(node, cursor);
        }
      }
    }

    // Unmount leftovers.
    for (i = 0; i < oldFibers.length; i++) {
      if (!used[i]) unmountFiber(oldFibers[i]);
    }
    parentFiber.children = newFibers;
  }

  function unmountFiber(fiber) {
    if (!fiber) return;
    runCleanup(fiber);
    if (fiber.instance) {
      try {
        if (typeof fiber.instance.componentWillUnmount === "function") fiber.instance.componentWillUnmount();
      } catch (err) { reportError(err); }
    }
    if (fiber.ref) {
      try { setRef(fiber.ref, null); } catch (err) { reportError(err); }
    }
    for (var i = 0; i < fiber.children.length; i++) unmountFiber(fiber.children[i]);
    for (i = 0; i < fiber.nodes.length; i++) {
      var node = fiber.nodes[i];
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    if (fiber.__holder) unmountFiber(fiber.__holder);
  }

  /** Render one fiber in place; sets fiber.nodes (its DOM surface). */
  function renderFiber(fiber) {
    var type = fiber.type;
    var props = fiber.props;

    // Text / number.
    if (type === TEXT_TYPE) {
      var text = String(props.value);
      if (!fiber.dom) fiber.dom = document.createTextNode(text);
      else if (fiber.dom.nodeValue !== text) fiber.dom.nodeValue = text;
      fiber.nodes = [fiber.dom];
      return;
    }

    // Fragment: marker + children in the parent DOM.
    if (type === Fragment || type === REACT_FRAGMENT_TYPE) {
      if (!fiber.dom) fiber.dom = document.createComment("");
      var fragDom = findDomParent(fiber);
      var holder = ensureHolder(fiber);
      reconcileChildren(holder, [props.children], fragDom);
      fiber.nodes = [fiber.dom].concat(surfaceNodes(holder.children));
      return;
    }

    // Plain DOM element.
    if (typeof type === "string") {
      if (!fiber.dom) fiber.dom = createElementForType(type);
      applyProps(fiber.dom, fiber.__prevProps || {}, props, type);
      fiber.__prevProps = props;
      reconcileChildren(fiber, props.children, fiber.dom);
      fiber.nodes = [fiber.dom];
      applyRef(fiber);
      return;
    }

    // memo(): unwrap.
    if (type && type.$$typeof === MEMO_TYPE) {
      if (fiber.__prevProps && type.compare && type.compare(fiber.__prevProps, props)) {
        // Same props: keep subtree as-is.
        fiber.nodes = componentSurface(fiber);
        fiber.__prevProps = props;
        return;
      }
      fiber.__prevProps = props;
      fiber.type = type.type;
      renderFiber(fiber);
      return;
    }

    // forwardRef
    if (type && type.$$typeof === FORWARD_REF_TYPE) {
      var frEl = type.render(props, fiber.ref || null);
      renderChildIntoFiber(fiber, frEl);
      return;
    }

    // Context provider
    if (type && type.__isProvider) {
      if (!fiber.dom) fiber.dom = document.createComment("");
      var contexts = Object.assign({}, fiber.parent ? fiber.parent.__contexts : {});
      contexts[type.__id] = props.value === undefined ? type.__defaultValue : props.value;
      fiber.__contexts = contexts;
      var provHolder = ensureHolder(fiber);
      provHolder.__contexts = contexts;
      // Descendants read context through the fiber chain.
      var saved = currentFiber;
      currentFiber = fiber;
      reconcileChildren(provHolder, [props.children], findDomParent(fiber));
      currentFiber = saved;
      fiber.nodes = [fiber.dom].concat(surfaceNodes(provHolder.children));
      return;
    }

    // Class component.
    var isClass = typeof type === "function" && type.prototype && type.prototype.isReactComponent;
    if (isClass) {
      var inst = fiber.instance;
      if (!inst) {
        inst = new type(props, {});
        fiber.instance = inst;
        inst.__fiber = fiber;
        inst.props = props;
        if (inst.state === undefined) inst.state = null;
        if (typeof inst.componentDidMount === "function") {
          pendingEffects.push({
            hook: { cleanup: null },
            fn: function () { inst.componentDidMount(); },
          });
        }
      } else {
        var prevProps = inst.props;
        var prevState = inst.state;
        if (inst.__pending) {
          var pend = inst.__pending;
          inst.__pending = null;
          inst.state = pend(inst.state == null ? {} : inst.state);
        }
        inst.props = props;
        if (inst.isPureReactComponent && shallowEqual(prevProps, props) && inst.state === prevState) {
          fiber.nodes = componentSurface(fiber);
          return;
        }
        if (typeof inst.componentDidUpdate === "function") {
          pendingEffects.push({
            hook: { cleanup: null },
            fn: function () { inst.componentDidUpdate(prevProps, prevState); },
          });
        }
      }
      var classEl = inst.render();
      renderChildIntoFiber(fiber, classEl);
      applyRef(fiber);
      return;
    }

    // Function component.
    var prev = currentFiber;
    currentFiber = fiber;
    hookIndex = 0;
    var out;
    try {
      out = type(props);
    } finally {
      currentFiber = prev;
    }
    renderChildIntoFiber(fiber, out);
    applyRef(fiber);
  }

  function componentSurface(fiber) {
    var holder = fiber.__holder;
    return holder ? surfaceNodes(holder.children) : (fiber.nodes || []);
  }

  function surfaceNodes(children) {
    var nodes = [];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c && c.nodes) {
        for (var j = 0; j < c.nodes.length; j++) {
          if (c.nodes[j]) nodes.push(c.nodes[j]);
        }
      }
    }
    return nodes;
  }

  function ensureHolder(fiber) {
    var holder = fiber.__holder;
    if (!holder) {
      holder = {
        type: null,
        props: {},
        key: null,
        ref: null,
        dom: null,
        nodes: [],
        children: [],
        hooks: null,
        parent: fiber,
        instance: null,
        __contexts: fiber.__contexts,
        __root: fiber.__root,
      };
      fiber.__holder = holder;
    }
    holder.parent = fiber;
    holder.__root = fiber.__root;
    if (fiber.type && fiber.type.__isProvider) holder.__contexts = fiber.__contexts;
    return holder;
  }

  /** Render a component's single output (may be an array) into its holder. */
  function renderChildIntoFiber(fiber, childEl) {
    var holder = ensureHolder(fiber);
    reconcileChildren(holder, [childEl], findDomParent(fiber));
    fiber.nodes = surfaceNodes(holder.children);
  }

  function findDomParent(fiber) {
    var p = fiber.parent;
    while (p) {
      if (p.dom && p.dom.nodeType === 1) return p.dom;
      p = p.parent;
    }
    return (fiber.__root && fiber.__root.dom) || document.body;
  }

  function applyRef(fiber) {
    if (!fiber.ref) return;
    var value = fiber.dom && fiber.dom.nodeType === 1 ? fiber.dom : null;
    setRef(fiber.ref, value);
  }

  /* ---------------- props / DOM ---------------- */

  /**
   * Element factory with namespace awareness. React creates SVG/MathML
   * children with createElementNS — creating <svg>/<text>/<path> with plain
   * document.createElement produces HTMLUnknownElement-in-HTML-namespace
   * nodes that never render and have no SVG geometry API (getBBox,
   * getTotalLength, …). Tag-local names (svg, text, a, …) route through the
   * parent's namespace so an HTML <a> stays HTML while an SVG <a> stays SVG.
   */
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MATHML_NS = "http://www.w3.org/1998/Math/MathML";
  var SVG_TAGS = {
    svg: 1, animate: 1, animateMotion: 1, animateTransform: 1, circle: 1,
    clipPath: 1, defs: 1, desc: 1, ellipse: 1, feBlend: 1, feColorMatrix: 1,
    feComponentTransfer: 1, feComposite: 1, feConvolveMatrix: 1,
    feDiffuseLighting: 1, feDisplacementMap: 1, feDistantLight: 1,
    feDropShadow: 1, feFlood: 1, feFuncA: 1, feFuncB: 1, feFuncG: 1,
    feFuncR: 1, feGaussianBlur: 1, feImage: 1, feMerge: 1, feMergeNode: 1,
    feMorphology: 1, feOffset: 1, fePointLight: 1, feSpecularLighting: 1,
    feSpotLight: 1, feTile: 1, feTurbulence: 1, filter: 1, foreignObject: 1,
    g: 1, image: 1, line: 1, linearGradient: 1, marker: 1, mask: 1,
    metadata: 1, mpath: 1, path: 1, pattern: 1, polygon: 1, polyline: 1,
    radialGradient: 1, rect: 1, set: 1, stop: 1, switch: 1, symbol: 1,
    text: 1, textPath: 1, title: 1, tspan: 1, use: 1, view: 1
  };
  // Lowercase aliases (JSX can carry all-lowercase tag names).
  for (var svgKey in SVG_TAGS) SVG_TAGS[svgKey.toLowerCase()] = 1;

  var MATHML_TAGS = {
    math: 1, mrow: 1, mi: 1, mn: 1, mo: 1, ms: 1, mtext: 1, mfrac: 1,
    msqrt: 1, mroot: 1, mstyle: 1, merror: 1, mpadded: 1, mphantom: 1,
    mfenced: 1, menclose: 1, msub: 1, msup: 1, msubsup: 1, munder: 1,
    mover: 1, munderover: 1, mmultiscripts: 1, mtable: 1, mtr: 1, mtd: 1,
    maction: 1, semantics: 1
  };
  for (var mathKey in MATHML_TAGS) MATHML_TAGS[mathKey.toLowerCase()] = 1;

  /** Tags that stay HTML even inside SVG (foreignObject content) or that
      are tag-local between HTML and SVG (<a>, <title>, …). */
  var HTML_TAGS = {
    a: 1, abbr: 1, address: 1, article: 1, aside: 1, b: 1, blockquote: 1,
    br: 1, button: 1, canvas: 1, code: 1, dd: 1, details: 1, div: 1, dl: 1,
    dt: 1, em: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, i: 1,
    img: 1, input: 1, label: 1, li: 1, main: 1, nav: 1, ol: 1, option: 1,
    p: 1, pre: 1, section: 1, select: 1, small: 1, span: 1, strong: 1,
    sub: 1, summary: 1, sup: 1, table: 1, tbody: 1, td: 1, textarea: 1,
    tfoot: 1, th: 1, thead: 1, tr: 1, u: 1, ul: 1, video: 1, audio: 1
  };

  function namespaceFor(type, parent) {
    var t = String(type);
    var lower = t.toLowerCase();
    // Registry-based, exactly like React's createElementNS decision: the
    // tag name alone picks the namespace (so <a>/<title> stay HTML, nested
    // <svg> inside <foreignObject> is still SVG). The parent is only a
    // fallback for unknown custom elements written all-lowercase inside an
    // SVG subtree (d3-style helpers).
    if (SVG_TAGS[t] || (SVG_TAGS[lower] && t !== lower)) return SVG_NS;
    if (MATHML_TAGS[t] || (MATHML_TAGS[lower] && t !== lower)) return MATHML_NS;
    var parentNs = parent && parent.namespaceURI;
    if (t === lower && parentNs === SVG_NS && !HTML_TAGS[lower]) return SVG_NS;
    if (t === lower && parentNs === MATHML_NS && !HTML_TAGS[lower]) return MATHML_NS;
    return null;
  }

  function createElementForType(type, parent) {
    var ns = namespaceFor(type, parent);
    if (ns) {
      try { return document.createElementNS(ns, String(type)); } catch (ignore) {}
    }
    return document.createElement(String(type));
  }
  /**
   * React-style SVG attribute names. JSX carries React prop names in camel
   * case (fontSize, textLength, gradientTransform, …) which are NOT valid
   * attribute names on real SVG elements — the DOM maps them to their
   * exact (mostly hyphen/lowercase) spellings. HTML data-/aria- and custom
   * attributes pass through unchanged.
   */
  var SVG_ATTRS = {
    accentHeight: "accent-height", accentheight: "accent-height",
    alignmentBaseline: "alignment-baseline", alignmentbaseline: "alignment-baseline",
    arabicForm: "arabic-form", arabicform: "arabic-form",
    baselineShift: "baseline-shift", baselineshift: "baseline-shift",
    capHeight: "cap-height", capheight: "cap-height",
    clipPath: "clip-path", clippath: "clip-path",
    clipRule: "clip-rule", cliprule: "clip-rule",
    colorInterpolation: "color-interpolation", colorinterpolation: "color-interpolation",
    colorInterpolationFilters: "color-interpolation-filters",
    colorProfile: "color-profile", colorprofile: "color-profile",
    colorRendering: "color-rendering", colorrendering: "color-rendering",
    dominantBaseline: "dominant-baseline", dominantbaseline: "dominant-baseline",
    enableBackground: "enable-background", enablebackground: "enable-background",
    fillOpacity: "fill-opacity", fillopacity: "fill-opacity",
    fillRule: "fill-rule", fillrule: "fill-rule",
    floodColor: "flood-color", floodcolor: "flood-color",
    floodOpacity: "flood-opacity", floodopacity: "flood-opacity",
    fontFamily: "font-family", fontfamily: "font-family",
    fontSize: "font-size", fontsize: "font-size",
    fontSizeAdjust: "font-size-adjust", fontsizeadjust: "font-size-adjust",
    fontStretch: "font-stretch", fontstretch: "font-stretch",
    fontStyle: "font-style", fontstyle: "font-style",
    fontVariant: "font-variant", fontvariant: "font-variant",
    fontWeight: "font-weight", fontweight: "font-weight",
    glyphName: "glyph-name", glyphname: "glyph-name",
    glyphOrientationHorizontal: "glyph-orientation-horizontal",
    glyphOrientationVertical: "glyph-orientation-vertical",
    horizAdvX: "horiz-adv-x", horizadvx: "horiz-adv-x",
    horizOriginX: "horiz-origin-x", horizoriginx: "horiz-origin-x",
    imageRendering: "image-rendering", imagerendering: "image-rendering",
    letterSpacing: "letter-spacing", letterspacing: "letter-spacing",
    lightingColor: "lighting-color", lightingcolor: "lighting-color",
    markerEnd: "marker-end", markerend: "marker-end",
    markerMid: "marker-mid", markermid: "marker-mid",
    markerStart: "marker-start", markerstart: "marker-start",
    overlinePosition: "overline-position", overlineposition: "overline-position",
    overlineThickness: "overline-thickness", overlinethickness: "overline-thickness",
    paintOrder: "paint-order", paintorder: "paint-order",
    panose1: "panose-1", panose: "panose-1",
    pointerEvents: "pointer-events", pointerevents: "pointer-events",
    renderingIntent: "rendering-intent", renderingintent: "rendering-intent",
    shapeRendering: "shape-rendering", shaperendering: "shape-rendering",
    stopColor: "stop-color", stopcolor: "stop-color",
    stopOpacity: "stop-opacity", stopopacity: "stop-opacity",
    strikethroughPosition: "strikethrough-position", strikethroughposition: "strikethrough-position",
    strikethroughThickness: "strikethrough-thickness", strikethroughthickness: "strikethrough-thickness",
    strokeDasharray: "stroke-dasharray", strokedasharray: "stroke-dasharray",
    strokeDashoffset: "stroke-dashoffset", strokedashoffset: "stroke-dashoffset",
    strokeLinecap: "stroke-linecap", strokelinecap: "stroke-linecap",
    strokeLinejoin: "stroke-linejoin", strokelinejoin: "stroke-linejoin",
    strokeMiterlimit: "stroke-miterlimit", strokemiterlimit: "stroke-miterlimit",
    strokeOpacity: "stroke-opacity", strokeopacity: "stroke-opacity",
    strokeWidth: "stroke-width", strokewidth: "stroke-width",
    textAnchor: "text-anchor", textanchor: "text-anchor",
    textDecoration: "text-decoration", textdecoration: "text-decoration",
    textRendering: "text-rendering", textrendering: "text-rendering",
    textLength: "text-length",
    underlinePosition: "underline-position", underlineposition: "underline-position",
    underlineThickness: "underline-thickness", underlinethickness: "underline-thickness",
    unicodeBidi: "unicode-bidi", unicodedebi: "unicode-bidi",
    unicodeRange: "unicode-range", unicoderange: "unicode-range",
    unitsPerEm: "units-per-em", unitsperem: "units-per-em",
    vAlphabetic: "v-alphabetic", valphabetic: "v-alphabetic",
    vHanging: "v-hanging", vhanging: "v-hanging",
    vIdeographic: "v-ideographic", videographic: "v-ideographic",
    vMathematical: "v-mathematical", vmathematical: "v-mathematical",
    vectorEffect: "vector-effect", vectoreffect: "vector-effect",
    vertAdvY: "vert-adv-y", vertadvy: "vert-adv-y",
    vertOriginX: "vert-origin-x", vertoriginx: "vert-origin-x",
    vertOriginY: "vert-origin-y", vertoriginy: "vert-origin-y",
    wordSpacing: "word-spacing", wordspacing: "word-spacing",
    writingMode: "writing-mode", writingmode: "writing-mode",
    xHeight: "x-height", xheight: "x-height",
    xlinkActuate: "xlink:actuate", xlinkArcrole: "xlink:arcrole",
    xlinkHref: "xlink:href", xlinkRole: "xlink:role",
    xlinkShow: "xlink:show", xlinkTitle: "xlink:title",
    xlinkType: "xlink:type",
    xmlBase: "xml:base", xmlLang: "xml:lang", xmlSpace: "xml:space",
    xmlnsXlink: "xmlns:xlink",
    gradientTransform: "gradientTransform", gradientUnits: "gradientUnits",
    spreadMethod: "spreadMethod", transformOrigin: "transform-origin",
    viewBox: "viewBox", preserveAspectRatio: "preserveAspectRatio",
    pathLength: "pathLength", attributeName: "attributeName",
    attributeType: "attributeType", calcMode: "calcMode",
    keyTimes: "keyTimes", keySplines: "keySplines",
    repeatCount: "repeatCount", repeatDur: "repeatDur",
    requiredExtensions: "requiredExtensions", systemLanguage: "systemLanguage",
    clipPathUnits: "clipPathUnits", maskUnits: "maskUnits",
    maskContentUnits: "maskContentUnits", filterUnits: "filterUnits",
    primitiveUnits: "primitiveUnits", filterRes: "filterRes",
    patternContentUnits: "patternContentUnits", patternUnits: "patternUnits",
    patternTransform: "patternTransform", stdDeviation: "stdDeviation",
    surfaceScale: "surfaceScale", specularConstant: "specularConstant",
    specularExponent: "specularExponent", diffuseConstant: "diffuseConstant",
    kernelMatrix: "kernelMatrix", kernelUnitLength: "kernelUnitLength",
    targetX: "targetX", targetY: "targetY", order: "order",
    preserveAlpha: "preserveAlpha", pointsAtX: "pointsAtX",
    pointsAtY: "pointsAtY", pointsAtZ: "pointsAtZ",
    limitingConeAngle: "limitingConeAngle", azimuth: "azimuth",
    elevation: "elevation", baseFrequency: "baseFrequency",
    numOctaves: "numOctaves", seed: "seed", stitchTiles: "stitchTiles",
    tableValues: "tableValues", slope: "slope", intercept: "intercept",
    amplitude: "amplitude", exponent: "exponent", offset: "offset",
    crossOrigin: "crossorigin", referrerPolicy: "referrerpolicy",
    htmlFor: "for"
  };

  /** Attribute name for a JSX prop on this element (React parity). */
  function attrNameFor(dom, name) {
    if (name === "className") return "class";
    if (name === "htmlFor") return "for";
    var ns = dom && dom.namespaceURI;
    if (ns === SVG_NS || ns === MATHML_NS) {
      var mapped = SVG_ATTRS[name];
      if (mapped) return mapped;
      // Unknown camelCase prop on SVG: attributes are case-SENSITIVE there,
      // and JSX carries React prop spelling. Use the lowercase attribute
      // spelling browsers (and every d3 example) expect.
      if (name !== name.toLowerCase() && name.indexOf("data-") !== 0 && name.indexOf("aria-") !== 0) {
        return name.replace(/[A-Z]/g, function (ch) { return "-" + ch.toLowerCase(); });
      }
      return name;
    }
    return SVG_ATTRS[name] || name;
  }

  var RESERVED = {
    children: 1, key: 1, ref: 1, dangerouslySetInnerHTML: 1,
    __self: 1, __source: 1,
  };

  function applyProps(dom, oldProps, newProps) {
    var k;
    for (k in oldProps) {
      if (!Object.prototype.hasOwnProperty.call(oldProps, k)) continue;
      if (RESERVED[k]) continue;
      if (newProps[k] !== undefined) continue;
      if (k === "className") dom.removeAttribute("class");
      else if (k === "style") dom.removeAttribute("style");
      else if (k.slice(0, 2) === "on" && typeof oldProps[k] === "function") removeEventListener(dom, k, oldProps[k]);
      else if (k === "htmlFor") dom.removeAttribute("for");
      else if (k === "value" || k === "checked" || k === "selected") setControlProp(dom, k, k === "value" ? "" : false);
      else dom.removeAttribute(attrNameFor(dom, k));
    }
    for (k in newProps) {
      if (!Object.prototype.hasOwnProperty.call(newProps, k)) continue;
      if (RESERVED[k]) continue;
      var v = newProps[k];
      var ov = oldProps[k];
      if (v === ov) continue;
      if (k === "className") setAttr(dom, "class", v);
      else if (k === "style") applyStyle(dom, ov, v);
      else if (k === "htmlFor") setAttr(dom, "for", v);
      else if (k.slice(0, 2) === "on") {
        if (typeof ov === "function") removeEventListener(dom, k, ov);
        if (typeof v === "function") addEventListener(dom, k, v);
      } else if (k === "value" || k === "checked" || k === "selected") {
        setControlProp(dom, k, v);
      } else if (k === "dangerouslySetInnerHTML") {
        // Deliberately ignored: widgets are model-authored and the DSL
        // documents this prop as inert. Honoring it would turn any model
        // string into raw HTML in the sandboxed document (inline event
        // handler attributes there execute), so the runtime never writes
        // innerHTML on a model's behalf.
      } else if (k.slice(0, 5) === "aria-") {
        // ARIA is string-valued in React: aria-pressed={true} is
        // aria-pressed="true", and false is "false" (never an empty
        // attribute — CSS and AT both key on the string).
        setAttr(dom, k, v === true ? "true" : v === false ? "false" : v);
      } else if (v === true) setAttr(dom, attrNameFor(dom, k), "");
      else if (v === false || v === null || v === undefined) dom.removeAttribute(attrNameFor(dom, k));
      else setAttr(dom, attrNameFor(dom, k), v);
    }
  }

  function setControlProp(dom, k, v) {
    try { dom[k] = v; } catch (ignore) {}
  }

  function setAttr(dom, name, v) {
    try { dom.setAttribute(name, String(v)); } catch (ignore) {}
  }

  var LISTENERS = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  var listenerId = 0;

  function eventName(prop) {
    var name = prop.slice(2).toLowerCase();
    if (name === "doubleclick") return "dblclick";
    // React parity: onChange is the DOM input event (range/checkbox/select
    // fire input on every interaction, change only on commit).
    if (name === "change") return "input";
    return name;
  }

  function listenerKey(prop, fn) {
    return prop + "|" + (fn.__guId || (fn.__guId = ++listenerId));
  }

  function addEventListener(dom, prop, fn) {
    var ev = eventName(prop);
    if (!LISTENERS) { dom.addEventListener(ev, fn); return; }
    var map = LISTENERS.get(dom);
    if (!map) { map = {}; LISTENERS.set(dom, map); }
    map[listenerKey(prop, fn)] = { ev: ev, fn: fn };
    dom.addEventListener(ev, fn);
  }

  function removeEventListener(dom, prop, fn) {
    var ev = eventName(prop);
    if (!LISTENERS) { dom.removeEventListener(ev, fn); return; }
    var map = LISTENERS.get(dom);
    if (!map) return;
    var key = listenerKey(prop, fn);
    var entry = map[key];
    if (entry) {
      dom.removeEventListener(entry.ev, entry.fn);
      delete map[key];
    }
  }

  function applyStyle(dom, oldV, newV) {
    // SVG/MathML elements have no CSSStyleDeclaration in every engine;
    // style there is an SVGAnimatedString. Never write through it.
    var css = dom.style;
    if (!css) {
      if (typeof newV === "string") setAttr(dom, "style", newV);
      else if (newV && typeof newV === "object") {
        var flat = "";
        for (var sk in newV) {
          if (!Object.prototype.hasOwnProperty.call(newV, sk)) continue;
          if (newV[sk] === null || newV[sk] === undefined || newV[sk] === false) continue;
          flat += sk + ":" + newV[sk] + ";";
        }
        if (flat) setAttr(dom, "style", flat);
        else dom.removeAttribute("style");
      } else dom.removeAttribute("style");
      return;
    }
    if (typeof newV === "string") {
      css.cssText = newV;
      return;
    }
    if (typeof oldV === "string") css.cssText = "";
    if (!newV || typeof newV !== "object") {
      dom.removeAttribute("style");
      return;
    }
    if (oldV && typeof oldV === "object") {
      for (var ok in oldV) {
        if (!Object.prototype.hasOwnProperty.call(oldV, ok)) continue;
        if (newV[ok] === undefined) css[ok] = "";
      }
    }
    for (var k in newV) {
      if (!Object.prototype.hasOwnProperty.call(newV, k)) continue;
      var v = newV[k];
      if (v === null || v === undefined || v === false) css[k] = "";
      else css[k] = v;
    }
  }

  function setRef(ref, value) {
    if (!ref) return;
    if (typeof ref === "function") ref(value);
    else if (typeof ref === "object") ref.current = value;
  }

  /* ---------------- legacy ReactDOM ---------------- */

  var legacyRoots = [];

  function legacyRender(element, container) {
    var entry = null;
    for (var i = 0; i < legacyRoots.length; i++) {
      if (legacyRoots[i].container === container) entry = legacyRoots[i];
    }
    if (!entry) {
      entry = { container: container, root: createRoot(container) };
      legacyRoots.push(entry);
    }
    entry.root.render(element);
  }

  function unmountComponentAtNode(container) {
    for (var i = legacyRoots.length - 1; i >= 0; i--) {
      if (legacyRoots[i].container === container) {
        legacyRoots[i].root.unmount();
        legacyRoots.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function createPortal(children, container) {
    return createElement(PortalHost, { children: children, container: container });
  }

  function PortalHost(props) {
    useEffect(function () {
      var root = createRoot(props.container);
      root.render(props.children);
      return function () { root.unmount(); };
    }, [props.container]);
    return null;
  }

  /* ---------------- exports ---------------- */

  var React = {
    version: "18.3.1-gu",
    Children: Children,
    Component: Component,
    PureComponent: PureComponent,
    Fragment: Fragment,
    createElement: createElement,
    cloneElement: cloneElement,
    createContext: createContext,
    isValidElement: isValidElement,
    forwardRef: forwardRef,
    memo: memo,
    useState: useState,
    useReducer: useReducer,
    useEffect: useEffect,
    useLayoutEffect: useLayoutEffect,
    useMemo: useMemo,
    useCallback: useCallback,
    useRef: useRef,
    useContext: useContext,
    useId: useId,
    useDebugValue: useDebugValue,
    useImperativeHandle: useImperativeHandle,
    useTransition: useTransition,
    useDeferredValue: useDeferredValue,
    useSyncExternalStore: useSyncExternalStore,
    startTransition: startTransition,
  };

  var ReactDOM = {
    version: React.version,
    render: legacyRender,
    unmountComponentAtNode: unmountComponentAtNode,
    createPortal: createPortal,
  };

  var ReactDOMClient = {
    createRoot: createRoot,
    hydrateRoot: function (container, element) {
      var root = createRoot(container);
      root.render(element);
      return root;
    },
  };

  window.React = React;
  window.ReactDOM = ReactDOM;
  window.ReactDOMClient = ReactDOMClient;
  // Import-free hooks for models that skip the react import line.
  window.useState = useState;
  window.useReducer = useReducer;
  window.useEffect = useEffect;
  window.useLayoutEffect = useLayoutEffect;
  window.useMemo = useMemo;
  window.useCallback = useCallback;
  window.useRef = useRef;
  window.useContext = useContext;
  window.useId = useId;
  window.Fragment = Fragment;
})();`;
