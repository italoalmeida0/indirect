/* prelude.js is the sandbox surface for skill modules. It is evaluated by
   shim.c in every fresh skill VM before any module code, wraps everything in
   an IIFE so nothing but `skill` and `__gu_snapshot` reaches the module, and
   owns the two primitives a skill author touches:

     require(name)                 load another skill module (C => Go loader)
     skill.extend(base..., over)   compose skills into a new one

   `__gu_snapshot` is the boundary: it validates plain data and every size
   budget, then serializes the module's default export. Only data crosses
   back to Go — functions, symbols, class instances, accessors, cycles and
   non-finite numbers are rejected here with a message naming the offence.

   No host capability is installed anywhere: the sandbox has no eval, no
   Function, no file, process, network or timing API. */
(function () {
  "use strict";

  /* The same budgets the Lua loader enforced, so a shared-subtree DAG
     (t = {t, t} repeated) is rejected instead of expanding without bound. */
  var MAX_DEPTH = 32;
  var MAX_NODES = 100000;
  var MAX_STRING_BYTES = 4 * 1024 * 1024;

  var OBJECT_PROTO = Object.prototype;

  /* The host must enable QuickJS's compiler for the module itself to be
     compiled (every parse entry point funnels through ctx->eval_internal),
     so the sandbox closes the dynamic-code surface from the JS side: the
     `eval` global, the `Function` global and the derived function
     constructors (Function/GeneratorFunction/AsyncFunction/AsyncGenerator
     Function) all disappear before any module code runs. The sandbox has no
     host capability to reach, and no way to compile code of its own. */
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
     subtree is charged every time it is visited — exactly the Lua rule. */
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

  /* walk visits plain data and throws on anything else. `allowFunctions`
     is used by the extend() copier, which may carry function values by
     reference (the snapshot boundary rejects them if they survive). */
  function walk(value, budget, depth, path, allowFunctions) {
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
        if (allowFunctions) {
          return value;
        }
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
        out.push(walk(value[i], budget, depth + 1, path, allowFunctions));
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
      object[name] = walk(descriptor.value, budget, depth + 1, path, allowFunctions);
    }
    var symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new Error("object keys must be strings (symbols are not supported)");
    }
    path.delete(value);
    return object;
  }

  /* copy is the extend() copier: same plain-data rules, but function values
     are kept by reference so a skill can expose a helper created locally. */
  function copy(value, budget, depth, path) {
    return walk(value, budget, depth, path, true);
  }

  function inheritNames(value) {
    if (value === undefined || value === null) {
      return [];
    }
    if (typeof value === "string") {
      if (value === "") {
        throw new Error("inherit names must not be empty");
      }
      return [value];
    }
    if (Array.isArray(value)) {
      var out = [];
      for (var i = 0; i < value.length; i++) {
        var name = value[i];
        if (typeof name !== "string" || name === "") {
          throw new Error("`inherit` must be an array of skill names");
        }
        out.push(name);
      }
      return out;
    }
    throw new Error("`inherit` must be a string or an array of strings, got " + describe(value));
  }

  function appendUnique(list, name) {
    if (list.indexOf(name) === -1) {
      list.push(name);
    }
  }

  /* normalizeTools lifts a nested `tools` grouping to the top level so
     bases written in either shape merge uniformly; duplicated definitions
     stay in place for the skill decoder to reject. */
  function normalizeTools(object) {
    var tools = object.tools;
    if (!isPlainObject(tools)) {
      return;
    }
    var onlyKnown = true;
    var duplicated = false;
    var keys = Object.keys(tools);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === "approvalMode" || key === "permissions") {
        if (object[key] !== undefined) {
          duplicated = true;
        }
      } else if (key.charAt(0) !== "_") {
        onlyKnown = false;
      }
    }
    if (duplicated) {
      return;
    }
    if (tools.approvalMode !== undefined) {
      object.approvalMode = tools.approvalMode;
    }
    if (tools.permissions !== undefined) {
      object.permissions = tools.permissions;
    }
    if (onlyKnown) {
      delete object.tools;
    }
  }

  function merge(target, source) {
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var current = target[key];
      var incoming = source[key];
      if (isPlainObject(current) && isPlainObject(incoming)) {
        merge(current, incoming);
        continue;
      }
      target[key] = incoming;
    }
  }

  /* extend(base..., overrides) builds a NEW skill object: metadata and
     permissions deep-merge left to right (objects merge, arrays and scalars
     replace), base names and inherit lists union into `inherit` so Resolve
     pulls the bases in, base bodies are NOT copied (they ride the inherit
     chain — copying would print them twice) and the result keeps only the
     override's name and body. With one argument it returns a deep copy. */
  function extend() {
    var count = arguments.length;
    if (count < 1) {
      throw new Error("skill.extend needs at least one object");
    }
    var budget = new Budget();
    var copies = [];
    for (var i = 0; i < count; i++) {
      var raw = arguments[i];
      var object;
      if (typeof raw === "string") {
        if (i === count - 1 && count > 1) {
          throw new Error("skill.extend overrides must be an object (only bases may be module names)");
        }
        object = require(raw);
      } else if (isPlainObject(raw)) {
        object = raw;
      } else {
        throw new Error("skill.extend arguments must be objects or module names, got " + describe(raw));
      }
      copies.push(copy(object, budget, 0, new Set()));
    }
    if (count === 1) {
      return copies[0];
    }

    var result = {};
    var inherit = [];
    for (var b = 0; b < count - 1; b++) {
      var base = copies[b];
      normalizeTools(base);
      var names = inheritNames(base.inherit);
      for (var n = 0; n < names.length; n++) {
        appendUnique(inherit, names[n]);
      }
      if (typeof base.name === "string" && base.name !== "") {
        appendUnique(inherit, base.name);
      }
      delete base.inherit;
      delete base.name;
      delete base.body;
      merge(result, base);
    }

    var overrides = copies[count - 1];
    normalizeTools(overrides);
    var own = inheritNames(overrides.inherit);
    for (var o = 0; o < own.length; o++) {
      appendUnique(inherit, own[o]);
    }
    delete overrides.inherit;
    var hasBody = overrides.body !== undefined && overrides.body !== null;
    merge(result, overrides);
    if (!hasBody) {
      result.body = "";
    }
    if (typeof result.name === "string") {
      inherit = inherit.filter(function (name) {
        return name !== result.name;
      });
    }
    if (inherit.length > 0) {
      result.inherit = inherit;
    } else {
      delete result.inherit;
    }
    return result;
  }

  Object.defineProperty(globalThis, "skill", {
    value: Object.freeze({ extend: extend }),
    writable: false,
    configurable: false,
  });

  removeDynamicCode();

  /* __gu_snapshot is the C boundary: validate, then serialize. The C side
     looks the function up once at sandbox creation, so a module cannot
     replace it by reassigning the global. */
  Object.defineProperty(globalThis, "__gu_snapshot", {
    value: function (value) {
      var budget = new Budget();
      var plain = walk(value, budget, 0, new Set(), false);
      return JSON.stringify(plain);
    },
    writable: false,
    configurable: false,
  });
})();
