/* prelude.js is the sandbox surface for skill modules. It is evaluated by
   shim.c in every fresh skill VM before any module code and wraps everything
   in an IIFE, so nothing but `__gu_snapshot` reaches the module.

   There is deliberately no host API here: skills compose with plain ES
   modules (`import base from "skill:agentic_base"`) and plain JavaScript
   (spread, concatenation, template literals). The C loader resolves those
   imports; this file only closes the dynamic-code surface and installs the
   snapshot boundary.

   `__gu_snapshot` validates plain data and every size budget, then
   serializes the module's default export. Only data crosses back to Go —
   functions, symbols, class instances, accessors, cycles and non-finite
   numbers are rejected here with a message naming the offence. */
(function () {
  "use strict";

  /* Budgets cap a shared-subtree DAG so it is rejected instead of expanding
     without bound: t = {t, t} repeated. */
  var MAX_DEPTH = 32;
  var MAX_NODES = 10000;
  var MAX_STRING_BYTES = 4 * 1024 * 1024;

  var OBJECT_PROTO = Object.prototype;
  var ARRAY_PROTO = Array.prototype;

  /* Every intrinsic the snapshot boundary relies on is captured HERE, before
     any module code runs: a module may reassign Object.keys, JSON.stringify,
     Array.prototype.push or Function.prototype.call, and the walk must not
     pick the patched versions up at snapshot time. Go re-validates the
     decoded object anyway; this keeps the JS-side checks honest too. */
  var bind = Function.prototype.bind;
  var uncurryThis = bind.bind(Function.prototype.call);
  var createObject = Object.create;
  var getPrototypeOf = Object.getPrototypeOf;
  var getOwnPropertyNames = Object.getOwnPropertyNames;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var getOwnPropertySymbols = Object.getOwnPropertySymbols;
  var defineProperty = Object.defineProperty;
  var isArray = Array.isArray;
  var jsonStringify = JSON.stringify;
  var objectToString = uncurryThis(OBJECT_PROTO.toString);
  var hasOwnProperty = uncurryThis(OBJECT_PROTO.hasOwnProperty);
  var stringSlice = uncurryThis(String.prototype.slice);
  var charCodeAt = uncurryThis(String.prototype.charCodeAt);
  var isFiniteNumber = isFinite;
  var ErrorCtor = Error;

  /* The host must enable QuickJS's compiler for modules to be compiled at
     all (every parse entry point funnels through ctx->eval_internal), so the
     sandbox closes the dynamic-code surface from the JS side: the `eval`
     global, the `Function` global and the derived function constructors
     (Function/GeneratorFunction/AsyncFunction/AsyncGeneratorFunction) all
     disappear before any module code runs. The sandbox has no host
     capability to reach, and no way to compile code of its own. */
  function removeDynamicCode() {
    delete globalThis.eval;
    delete globalThis.Function;
    var samples = [function () {}, function* () {}, async function () {}, async function* () {}];
    for (var i = 0; i < samples.length; i++) {
      var proto = getPrototypeOf(samples[i]);
      if (!proto) {
        continue;
      }
      var descriptor = getOwnPropertyDescriptor(proto, "constructor");
      if (descriptor) {
        defineProperty(proto, "constructor", {
          value: undefined,
          writable: descriptor.writable,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
      }
    }
  }

  function fail(message) {
    throw new ErrorCtor(message);
  }

  function utf8Length(s) {
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var code = charCodeAt(s, i);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        var next = charCodeAt(s, i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i++;
          continue;
        }
        bytes += 3;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function describe(value) {
    if (value === null) {
      return "null";
    }
    if (value === undefined) {
      return "nothing";
    }
    var type = typeof value;
    if (type === "object") {
      if (isArray(value)) {
        return "array";
      }
      var tag = objectToString(value);
      return "object (" + stringSlice(tag, 8, tag.length - 1) + ")";
    }
    return type;
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object" || isArray(value)) {
      return false;
    }
    var proto = getPrototypeOf(value);
    return proto === OBJECT_PROTO || proto === null;
  }

  /* Budget counts values and string bytes across one traversal, so a shared
     subtree is charged every time it is visited. A null-prototype record so
     neither Object.prototype nor a class prototype is consulted. */
  function newBudget() {
    var budget = createObject(null);
    budget.nodes = 0;
    budget.stringBytes = 0;
    return budget;
  }

  function countNode(budget) {
    budget.nodes++;
    if (budget.nodes > MAX_NODES) {
      fail("holds too many values (over " + MAX_NODES + ")");
    }
  }

  function countString(budget, s) {
    budget.stringBytes += utf8Length(s);
    if (budget.stringBytes > MAX_STRING_BYTES) {
      fail("holds too much text (over " + MAX_STRING_BYTES + " bytes)");
    }
  }

  function checkDepth(depth) {
    if (depth > MAX_DEPTH) {
      fail("is nested too deeply (max " + MAX_DEPTH + " levels)");
    }
  }

  /* path is the chain of containers from the root to the current value (a
     null-prototype object indexed by depth: at most MAX_DEPTH entries, so a
     linear scan is cheap and no prototype setter on Object.prototype or
     Array.prototype can observe or intercept slot writes). */
  function onPath(path, depth, value) {
    for (var i = 0; i < depth; i++) {
      if (path[i] === value) {
        return true;
      }
    }
    return false;
  }

  /* ownDataDescriptor reads one own property descriptor: accessors and
     hidden properties are rejected instead of being invoked. Every check is
     an OWN-property check — `in` would consult a prototype the module may
     have extended. */
  function ownDataDescriptor(value, name) {
    var descriptor = getOwnPropertyDescriptor(value, name);
    if (!descriptor) {
      return undefined;
    }
    if (!descriptor.enumerable) {
      fail("objects must not carry hidden properties (" + name + ")");
    }
    if (!hasOwnProperty(descriptor, "value")) {
      fail("objects must not carry accessors (" + name + ")");
    }
    return descriptor;
  }

  /* quote serializes one primitive string. JSON.stringify never consults
     toJSON for primitives, so a module patching a prototype cannot reach
     this path. */
  function quote(s) {
    return jsonStringify(s);
  }

  /* walk validates plain data and returns its JSON text directly: no
     intermediate objects, so no prototype hook (setters, toJSON) can run
     while the snapshot is serialized. */
  function walk(value, budget, depth, path) {
    checkDepth(depth);
    countNode(budget);
    switch (typeof value) {
      case "string":
        countString(budget, value);
        return quote(value);
      case "number":
        if (!isFiniteNumber(value)) {
          fail("contains a non-finite number");
        }
        return quote(value);
      case "boolean":
        return value ? "true" : "false";
      case "undefined":
        fail("contains a nothing value (use a default instead)");
        break;
      case "bigint":
        fail("holds a BigInt value (plain data only)");
        break;
      case "symbol":
        fail("holds a symbol value (plain data only)");
        break;
      case "function":
        fail("holds a function value (plain data only)");
        break;
    }
    if (value === null) {
      return "null";
    }
    if (onPath(path, depth, value)) {
      fail("contains a cycle");
    }
    path[depth] = value;
    var names = getOwnPropertyNames(value);
    if (getOwnPropertySymbols(value).length > 0) {
      fail("object keys must be strings (symbols are not supported)");
    }
    var text;
    if (isArray(value)) {
      if (getPrototypeOf(value) !== ARRAY_PROTO) {
        fail("holds a " + describe(value) + " value (plain data only)");
      }
      var length = getOwnPropertyDescriptor(value, "length").value;
      text = "[";
      for (var i = 0; i < length; i++) {
        var itemDesc = ownDataDescriptor(value, "" + i);
        if (!itemDesc) {
          fail("contains a sparse array with a hole at index " + i);
        }
        text += (i > 0 ? "," : "") + walk(itemDesc.value, budget, depth + 1, path);
      }
      /* own names = indexes + "length"; anything else is an extra key. */
      if (names.length !== length + 1) {
        fail("arrays must hold items only (no extra properties)");
      }
      path[depth] = undefined;
      return text + "]";
    }
    if (!isPlainObject(value)) {
      fail("holds a " + describe(value) + " value (plain data only)");
    }
    text = "{";
    var first = true;
    for (var n = 0; n < names.length; n++) {
      var name = names[n];
      var propDesc = ownDataDescriptor(value, name);
      if (!propDesc || propDesc.value === undefined) {
        continue; /* like a missing key: JSON has no undefined */
      }
      countString(budget, name);
      text += (first ? "" : ",") + quote(name) + ":" + walk(propDesc.value, budget, depth + 1, path);
      first = false;
    }
    path[depth] = undefined;
    return text + "}";
  }

  removeDynamicCode();

  /* __gu_snapshot is the C boundary: validate, then serialize. The C side
     looks the function up once at sandbox creation, so a module cannot
     replace it by reassigning the global. */
  defineProperty(globalThis, "__gu_snapshot", {
    value: function (value) {
      return walk(value, newBudget(), 0, createObject(null));
    },
    writable: false,
    configurable: false,
  });
})();
