/**
 * Generative UI: SVG text-metrics polyfill for the widget LINT page.
 *
 * The headless lint browser (obscura) has no font shaping for SVG text:
 * `getBBox()` on a <text>/<tspan> returns 0x0, `getComputedTextLength()`
 * returns 0 and `getStartPositionOfChar()` does not exist at all. Charts
 * that measure labels (d3 axis ticks, label collision/rotation, wrapping,
 * leader lines) therefore misbehave in the lint smoke render even though
 * real browsers measure fine.
 *
 * This script restores the SVGTextContentElement metrics API from the
 * canvas 2D text measurer (which works correctly in the lint browser) and
 * from the element's computed font. Like the WebGL polyfill it is:
 *   - fallback-only: whenever the native metric is non-zero it wins, so
 *     real browsers keep their exact font shaping;
 *   - install-only-where-needed: on browsers that implement
 *     getStartPositionOfChar AND report non-empty getBBox nothing changes;
 *   - never throwing into widget code: missing pieces degrade to plain
 *     numbers, mirroring the spec's returned shapes.
 *
 * Keep this dependency-free and eval-free (widget CSP has no unsafe-eval).
 */

export const SVG_METRICS_POLYFILL_JS = String.raw`(function () {
  "use strict";

  var win = typeof window !== "undefined" ? window : null;
  if (!win) return;
  if (win.__guSvgMetricsPolyfill) return;

  var doc = win.document;
  if (!doc || !win.SVGTextContentElement || !win.SVGTextContentElement.prototype) {
    win.__guSvgMetricsPolyfill = { installed: false, reason: "no-svg-text" };
    return;
  }

  /* The lint browser lacks getStartPositionOfChar and returns empty text
     metrics. Only patch when that is actually true — a probe <text> with a
     real label must come back with size 0 for the polyfill to engage. */
  var nativeProbeWorks = (function () {
    try {
      var NS = "http://www.w3.org/2000/svg";
      var svg = doc.createElementNS(NS, "svg");
      svg.setAttribute("width", "300");
      svg.setAttribute("height", "100");
      svg.style.position = "absolute";
      svg.style.left = "-9999px";
      var t = doc.createElementNS(NS, "text");
      t.setAttribute("font-size", "16");
      t.textContent = "metric probe";
      svg.appendChild(t);
      (doc.body || doc.documentElement).appendChild(svg);
      var ok =
        typeof t.getStartPositionOfChar === "function" &&
        t.getBBox().width > 0 &&
        t.getComputedTextLength() > 0;
      (doc.body || doc.documentElement).removeChild(svg);
      return ok;
    } catch (e) {
      return true; // cannot probe: assume native, never fight a real browser
    }
  })();

  if (nativeProbeWorks) {
    win.__guSvgMetricsPolyfill = { installed: false, reason: "native-metrics-available" };
    return;
  }

  /* ------------------------------ measuring ---------------------------- */

  var mctx = null;
  function measurer() {
    if (!mctx) {
      var c = doc.createElement("canvas");
      c.width = 8;
      c.height = 8;
      mctx = c.getContext && c.getContext("2d");
    }
    return mctx;
  }

  function fontOf(el) {
    var cs = win.getComputedStyle(el);
    if (cs.font && cs.font !== "normal normal 400 16px sans-serif") return cs.font;
    var size = cs.fontSize || "16px";
    var family = cs.fontFamily || "sans-serif";
    var weight = cs.fontWeight || "normal";
    var style = cs.fontStyle || "normal";
    var variant = cs.fontVariant || "normal";
    return style + " " + variant + " " + weight + " " + size + " " + family;
  }

  function fontSizeOf(el) {
    var cs = win.getComputedStyle(el);
    var px = parseFloat(cs.fontSize);
    return isFinite(px) && px > 0 ? px : 16;
  }

  function textOf(el) {
    // textContent covers <tspan> children; flatten like the SVG layout does.
    return String(el.textContent == null ? "" : el.textContent);
  }

  function measureWidth(el, str) {
    if (!str) return 0;
    var ctx2d = measurer();
    if (!ctx2d) return str.length * fontSizeOf(el) * 0.55;
    try {
      ctx2d.font = fontOf(el);
      var w = ctx2d.measureText(str).width;
      return isFinite(w) ? w : str.length * fontSizeOf(el) * 0.55;
    } catch (e) {
      return str.length * fontSizeOf(el) * 0.55;
    }
  }

  /** Length of an SVGAnimatedLength / SVGLength / number, in user units. */
  function lengthValue(v) {
    if (typeof v === "number") return v;
    try {
      if (v && typeof v.baseVal === "object" && v.baseVal) {
        if (typeof v.baseVal.value === "number") return v.baseVal.value;
      }
      if (v && typeof v.value === "number") return v.value;
    } catch (e) { /* fall through */ }
    return 0;
  }

  /** Anchor-aware origin x of the element's text. */
  function originX(el) {
    var x = 0;
    try {
      x = lengthValue(el.x) || 0;
    } catch (e) { x = 0; }
    var cs = win.getComputedStyle(el);
    var anchor = cs.textAnchor || "start";
    var full = measureWidth(el, textOf(el));
    if (anchor === "middle") x -= full / 2;
    else if (anchor === "end") x -= full;
    return x;
  }

  function originY(el) {
    try {
      return lengthValue(el.y) || 0;
    } catch (e) {
      return 0;
    }
  }

  function charIndex(el, i) {
    var n = textOf(el).length;
    if (!isFinite(i)) return 0;
    return Math.max(0, Math.min(n - 1, Math.floor(i)));
  }

  /* --------------------------- API restoration -------------------------- */

  var proto = win.SVGTextContentElement.prototype;
  var graphicsProto = win.SVGGraphicsElement && win.SVGGraphicsElement.prototype;
  var nativeGetBBox = graphicsProto ? graphicsProto.getBBox : null;

  function nativeBBox(el) {
    if (!nativeGetBBox) return null;
    try {
      var b = nativeGetBBox.call(el);
      return b && (b.width > 0 || b.height > 0) ? b : null;
    } catch (e) {
      return null;
    }
  }

  proto.getComputedTextLength = function () {
    return measureWidth(this, textOf(this));
  };

  proto.getSubStringLength = function (charnum, nchars) {
    var s = textOf(this);
    var start = Math.max(0, Math.floor(charnum || 0));
    var n = Math.max(0, Math.floor(nchars || 0));
    return measureWidth(this, s.substr(start, n));
  };

  proto.getStartPositionOfChar = function (i) {
    var s = textOf(this);
    var idx = charIndex(this, i);
    var before = measureWidth(this, s.slice(0, idx));
    return { x: originX(this) + before, y: originY(this) };
  };

  proto.getEndPositionOfChar = function (i) {
    var s = textOf(this);
    var idx = charIndex(this, i);
    var through = measureWidth(this, s.slice(0, idx + 1));
    return { x: originX(this) + through, y: originY(this) };
  };

  proto.getExtentOfChar = function (i) {
    var s = textOf(this);
    var idx = charIndex(this, i);
    var before = measureWidth(this, s.slice(0, idx));
    var w = measureWidth(this, s.charAt(idx));
    var fs = fontSizeOf(this);
    return { x: originX(this) + before, y: originY(this) - fs * 0.8, width: w, height: fs * 1.2 };
  };

  proto.getCharNumAtPosition = function (point) {
    var s = textOf(this);
    if (!s.length) return -1;
    var px = point && typeof point.x === "number" ? point.x : 0;
    var x0 = originX(this);
    var offset = px - x0;
    if (offset < 0) return -1;
    var acc = 0;
    for (var i = 0; i < s.length; i++) {
      acc += measureWidth(this, s.charAt(i));
      if (offset <= acc) return i;
    }
    return s.length - 1;
  };

  /* getBBox lives on SVGGraphicsElement: shadow it for text elements only
     when the native box is empty (real browsers keep exact shaping). */
  proto.getBBox = function () {
    var native = nativeBBox(this);
    if (native) return native;
    var s = textOf(this);
    if (!s.length) return { x: originX(this), y: originY(this), width: 0, height: 0 };
    var fs = fontSizeOf(this);
    return {
      x: originX(this),
      y: originY(this) - fs * 0.8,
      width: measureWidth(this, s),
      height: fs * 1.2
    };
  };

  win.__guSvgMetricsPolyfill = {
    installed: true,
    reason: "no-native-svg-text-metrics",
    version: 1
  };
})();
`;
