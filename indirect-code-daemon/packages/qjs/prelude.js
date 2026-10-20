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
  var MAX_NODES = 100000;
  var MAX_STRING_BYTES = 4 * 1024 * 1024;

  var OBJECT_PROTO = Object.prototype;

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
      var proto = Object.getPrototypeOf(samples[i]);
      if (!proto) {
        continue;
      }
      var descriptor = Object.getOwnPropertyDescriptor(proto, "constructor");
      if (descriptor) {
        Object.defineProperty(proto, "constructor", {
          value: undefined,
          writable: descriptor.writable,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
      }
    }
  }

  function utf8Length(s) {
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        var next = s.charCodeAt(i + 1);
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
      if (Array.isArray(value)) {
        return "array";
      }
      var tag = OBJECT_PROTO.toString.call(value);
      return "object (" + tag.slice(8, tag.length - 1) + ")";
    }
    if (type === "number" || type === "string" || type === "boolean") {
      return type;
    }
    return type;
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    var proto = Object.getPrototypeOf(value);
    return proto === OBJECT_PROTO || proto === null;
  }

  /* Budget counts values and string bytes across one traversal, so a shared
     subtree is charged every time it is visited. */
  function Budget() {
    this.nodes = 0;
    this.stringBytes = 0;
  }

  Budget.prototype.count = function () {
    this.nodes++;
    if (this.nodes > MAX_NODES) {
      throw new Error("holds too many values (over " + MAX_NODES + ")");
    }
  };

  Budget.prototype.countString = function (s) {
    this.stringBytes += utf8Length(s);
    if (this.stringBytes > MAX_STRING_BYTES) {
      throw new Error("holds too much text (over " + MAX_STRING_BYTES + " bytes)");
    }
  };

  function checkDepth(depth) {
    if (depth > MAX_DEPTH) {
      throw new Error("is nested too deeply (max " + MAX_DEPTH + " levels)");
    }
  }

  /* walk visits plain data and throws on anything else. */
  function walk(value, budget, depth, path) {
    checkDepth(depth);
    budget.count();
    switch (typeof value) {
      case "string":
        budget.countString(value);
        return value;
      case "number":
        if (!isFinite(value)) {
          throw new Error("contains a non-finite number");
        }
        return value;
      case "boolean":
        return value;
      case "undefined":
        throw new Error("contains a nothing value (use a default instead)");
      case "bigint":
        throw new Error("holds a BigInt value (plain data only)");
      case "symbol":
        throw new Error("holds a symbol value (plain data only)");
      case "function":
        throw new Error("holds a function value (plain data only)");
    }
    if (value === null) {
      return null;
    }
    if (Array.isArray(value)) {
      if (path.has(value)) {
        throw new Error("contains a cycle");
      }
      path.add(value);
      var out = [];
      var length = value.length;
      for (var i = 0; i < length; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          throw new Error("contains a sparse array with a hole at index " + i);
        }
        out.push(walk(value[i], budget, depth + 1, path));
      }
      var extra = Object.keys(value);
      if (extra.length !== length) {
        throw new Error("arrays must hold items only (no extra properties)");
      }
      path.delete(value);
      return out;
    }
    if (!isPlainObject(value)) {
      throw new Error("holds a " + describe(value) + " value (plain data only)");
    }
    if (path.has(value)) {
      throw new Error("contains a cycle");
    }
    path.add(value);
    var object = {};
    var names = Object.getOwnPropertyNames(value);
    for (var n = 0; n < names.length; n++) {
      var name = names[n];
      var descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor.enumerable) {
        throw new Error("objects must not carry hidden properties (" + name + ")");
      }
      if (!("value" in descriptor)) {
        throw new Error("objects must not carry accessors (" + name + ")");
      }
      if (descriptor.value === undefined) {
        continue; /* like a missing key: JSON has no undefined */
      }
      budget.countString(name);
      object[name] = walk(descriptor.value, budget, depth + 1, path);
    }
    var symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new Error("object keys must be strings (symbols are not supported)");
    }
    path.delete(value);
    return object;
  }

  removeDynamicCode();

  /* __gu_snapshot is the C boundary: validate, then serialize. The C side
     looks the function up once at sandbox creation, so a module cannot
     replace it by reassigning the global. */
  Object.defineProperty(globalThis, "__gu_snapshot", {
    value: function (value) {
      var budget = new Budget();
      var plain = walk(value, budget, 0, new Set());
      return JSON.stringify(plain);
    },
    writable: false,
    configurable: false,
  });
})();
