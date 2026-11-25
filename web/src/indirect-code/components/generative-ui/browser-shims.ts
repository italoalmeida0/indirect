/**
 * Generative UI: small browser-API shims for the widget LINT page.
 *
 * The headless lint browser (obscura) is missing a handful of interactive
 * APIs that generated widgets (especially games and immersive demos) call
 * from event handlers or animation loops: `navigator.vibrate`,
 * `Element.requestFullscreen` and `HTMLVideoElement.requestVideoFrameCallback`
 * are simply undefined there. A direct call then throws a TypeError and the
 * smoke render fails for an environment reason, not a widget bug.
 *
 * These shims only fill the MISSING APIs (never overriding a native one) and
 * degrade to no-ops with the shapes callers expect:
 *   - vibrate -> true (spec: whether the call was accepted)
 *   - requestFullscreen -> resolved promise (fullscreenElement stays null)
 *   - requestVideoFrameCallback -> schedules via requestAnimationFrame and
 *     returns a handle, with cancelVideoFrameCallback to undo it
 *
 * Dependency-free and eval-free (widget CSP has no unsafe-eval).
 */

export const BROWSER_SHIMS_JS = String.raw`(function () {
  "use strict";

  var win = typeof window !== "undefined" ? window : null;
  if (!win) return;
  if (win.__guBrowserShims) return;

  var patched = [];

  /* navigator.vibrate: games call it on impact; the spec returns whether
     the pattern was queued. */
  try {
    if (win.navigator && typeof win.navigator.vibrate !== "function") {
      win.navigator.vibrate = function () { return true; };
      patched.push("navigator.vibrate");
    }
  } catch (e) { /* frozen navigator: skip */ }

  /* Element.requestFullscreen / exitFullscreen / fullscreenElement: no
     display to go fullscreen on in the lint browser — resolve quietly. */
  try {
    if (win.Element && win.Element.prototype && typeof win.Element.prototype.requestFullscreen !== "function") {
      win.Element.prototype.requestFullscreen = function () {
        return Promise.resolve();
      };
      patched.push("Element.requestFullscreen");
    }
  } catch (e) { /* skip */ }
  try {
    if (win.document && typeof win.document.exitFullscreen !== "function") {
      win.document.exitFullscreen = function () { return Promise.resolve(); };
      patched.push("document.exitFullscreen");
    }
  } catch (e) { /* skip */ }

  /* video.requestVideoFrameCallback: video textures / frame stepping. No
     video decoding in the lint browser, so schedule the callback once on
     the next frame with a synthetic now/metatime pair. */
  try {
    var vproto = win.HTMLVideoElement && win.HTMLVideoElement.prototype;
    if (vproto && typeof vproto.requestVideoFrameCallback !== "function") {
      var handles = {};
      var nextHandle = 1;
      vproto.requestVideoFrameCallback = function (cb) {
        var id = nextHandle++;
        var video = this;
        win.requestAnimationFrame(function () {
          if (!handles[id]) return;
          delete handles[id];
          var now = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
          try {
            cb(now, {
              presentationTime: now,
              expectedDisplayTime: now + 16,
              width: video.videoWidth || 0,
              height: video.videoHeight || 0,
              mediaTime: video.currentTime || 0,
              presentedFrames: 1,
              processingDuration: 0
            });
          } catch (e) { /* report like the runtime would */ setTimeout(function () { throw e; }, 0); }
        });
        handles[id] = true;
        return id;
      };
      vproto.cancelVideoFrameCallback = function (id) {
        delete handles[id];
      };
      patched.push("HTMLVideoElement.requestVideoFrameCallback");
    }
  } catch (e) { /* skip */ }

  /* Element.setPointerCapture / releasePointerCapture / hasPointerCapture:
     OrbitControls, CAD editors, sliders, and drag-based games rely on pointer
     capture; track captured pointer IDs per element when missing. */
  try {
    var eproto = win.Element && win.Element.prototype;
    if (eproto && typeof eproto.setPointerCapture !== "function") {
      var captured = typeof WeakMap === "function" ? new WeakMap() : null;
      eproto.setPointerCapture = function (pointerId) {
        if (!captured) return;
        var set = captured.get(this);
        if (!set) { set = {}; captured.set(this, set); }
        set[String(pointerId)] = true;
      };
      if (typeof eproto.releasePointerCapture !== "function") {
        eproto.releasePointerCapture = function (pointerId) {
          if (!captured) return;
          var set = captured.get(this);
          if (set) delete set[String(pointerId)];
        };
      }
      if (typeof eproto.hasPointerCapture !== "function") {
        eproto.hasPointerCapture = function (pointerId) {
          if (!captured) return false;
          var set = captured.get(this);
          return !!(set && set[String(pointerId)]);
        };
      }
      patched.push("Element.setPointerCapture");
    }
  } catch (e) { /* skip */ }

  /* Element.requestPointerLock / document.exitPointerLock: sandboxed frames
     and headless lint omit pointer lock; resolve quietly so FPS games degrade
     to pointer-drag / touch / keyboard look without throwing. */
  try {
    if (win.Element && win.Element.prototype && typeof win.Element.prototype.requestPointerLock !== "function") {
      win.Element.prototype.requestPointerLock = function () {
        return Promise.resolve();
      };
      patched.push("Element.requestPointerLock");
    }
  } catch (e) { /* skip */ }
  try {
    if (win.document && typeof win.document.exitPointerLock !== "function") {
      win.document.exitPointerLock = function () {};
      patched.push("document.exitPointerLock");
    }
  } catch (e) { /* skip */ }

  /* CanvasRenderingContext2D & Path2D gaps: Obscura's Path2D lacks curve/shape
     methods (bezierCurveTo, quadraticCurveTo, arcTo, ellipse, roundRect) that
     Chart.js v4 (tension > 0) and canvas apps invoke, and Canvas2D lacks
     getTransform / reset (and may expose its 2D context without a global
     CanvasRenderingContext2D constructor). Only fill missing methods so real
     browsers keep their native vector paths untouched. */
  try {
    var patchCanvas2DTarget = function (target) {
      if (!target || target === Object.prototype) return false;
      var did = false;
      if (typeof target.roundRect !== "function") {
        target.roundRect = function (x, y, w, h, radii) {
          var r = Array.isArray(radii) ? Number(radii[0] || 0) : Number(radii || 0);
          if (!isFinite(r) || r < 0) r = 0;
          var mr = Math.min(Math.abs(w) / 2, Math.abs(h) / 2, r);
          this.moveTo(x + mr, y);
          this.arcTo(x + w, y, x + w, y + h, mr);
          this.arcTo(x + w, y + h, x, y + h, mr);
          this.arcTo(x, y + h, x, y, mr);
          this.arcTo(x, y, x + w, y, mr);
          this.closePath();
        };
        did = true;
      }
      if (typeof target.bezierCurveTo !== "function") {
        target.bezierCurveTo = function (cp1x, cp1y, cp2x, cp2y, x, y) {
          if (typeof this.lineTo === "function") this.lineTo(x, y);
        };
        did = true;
      }
      if (typeof target.quadraticCurveTo !== "function") {
        target.quadraticCurveTo = function (cpx, cpy, x, y) {
          if (typeof this.lineTo === "function") this.lineTo(x, y);
        };
        did = true;
      }
      if (typeof target.ellipse !== "function") {
        target.ellipse = function (x, y, rx, ry, rot, sa, ea, ccw) {
          if (typeof this.arc === "function") this.arc(x, y, Math.max(0, (rx + ry) * 0.5), sa, ea, ccw);
        };
        did = true;
      }
      if (typeof target.getTransform !== "function") {
        target.getTransform = function () {
          if (typeof win.DOMMatrix === "function") {
            try { return new win.DOMMatrix(); } catch (_) {}
          }
          return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, m11: 1, m12: 0, m21: 0, m22: 1, m41: 0, m42: 0, is2D: true, isIdentity: true };
        };
        did = true;
      }
      if (typeof target.reset !== "function") {
        target.reset = function () {
          if (typeof this.setTransform === "function") this.setTransform(1, 0, 0, 1, 0, 0);
          if (typeof this.clearRect === "function" && this.canvas) {
            this.clearRect(0, 0, this.canvas.width || 0, this.canvas.height || 0);
          }
        };
        did = true;
      }
      return did;
    };
    var c2proto = win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype;
    var c2Patched = false;
    if (c2proto && patchCanvas2DTarget(c2proto)) c2Patched = true;
    if (win.document) {
      var c2probeCanvas = win.document.createElement("canvas");
      var c2probeCtx = c2probeCanvas && typeof c2probeCanvas.getContext === "function" ? c2probeCanvas.getContext("2d") : null;
      if (c2probeCtx) {
        var stillMissing =
          typeof c2probeCtx.getTransform !== "function" ||
          typeof c2probeCtx.reset !== "function" ||
          typeof c2probeCtx.roundRect !== "function" ||
          typeof c2probeCtx.bezierCurveTo !== "function" ||
          typeof c2probeCtx.quadraticCurveTo !== "function" ||
          typeof c2probeCtx.ellipse !== "function";
        if (stillMissing) {
          var inferredProto = Object.getPrototypeOf(c2probeCtx);
          if (inferredProto && inferredProto !== Object.prototype && inferredProto !== c2proto) {
            if (patchCanvas2DTarget(inferredProto)) c2Patched = true;
          } else if (win.HTMLCanvasElement && win.HTMLCanvasElement.prototype) {
            var origGetCtx2d = win.HTMLCanvasElement.prototype.getContext;
            if (typeof origGetCtx2d === "function") {
              win.HTMLCanvasElement.prototype.getContext = function (type) {
                var ctx = origGetCtx2d.apply(this, arguments);
                if (ctx && String(type || "").toLowerCase() === "2d") patchCanvas2DTarget(ctx);
                return ctx;
              };
              c2Patched = true;
            }
          }
        }
      }
    }
    if (c2Patched) patched.push("CanvasRenderingContext2D");
  } catch (e) { /* skip */ }

  try {
    var p2proto = win.Path2D && win.Path2D.prototype;
    if (p2proto) {
      var p2Patched = false;
      if (typeof p2proto.bezierCurveTo !== "function") {
        p2proto.bezierCurveTo = function (cp1x, cp1y, cp2x, cp2y, x, y) {
          if (typeof this.lineTo === "function") this.lineTo(x, y);
        };
        p2Patched = true;
      }
      if (typeof p2proto.quadraticCurveTo !== "function") {
        p2proto.quadraticCurveTo = function (cpx, cpy, x, y) {
          if (typeof this.lineTo === "function") this.lineTo(x, y);
        };
        p2Patched = true;
      }
      if (typeof p2proto.arcTo !== "function") {
        p2proto.arcTo = function (x1, y1, x2, y2) {
          if (typeof this.lineTo === "function") this.lineTo(x2, y2);
        };
        p2Patched = true;
      }
      if (typeof p2proto.ellipse !== "function") {
        p2proto.ellipse = function (x, y, rx, ry, rot, sa, ea, ccw) {
          if (typeof this.arc === "function") this.arc(x, y, Math.max(0, (rx + ry) * 0.5), sa, ea, ccw);
        };
        p2Patched = true;
      }
      if (typeof p2proto.roundRect !== "function") {
        p2proto.roundRect = function (x, y, w, h) {
          if (typeof this.rect === "function") this.rect(x, y, w, h);
        };
        p2Patched = true;
      }
      if (typeof p2proto.addPath !== "function") {
        p2proto.addPath = function () {};
        p2Patched = true;
      }
      if (p2Patched) patched.push("Path2D");
    }
  } catch (e) { /* skip */ }

  /* Web Audio API gaps: Obscura exposes a partial AudioContext whose
     AudioParam objects lack ramp/cancel methods (exponentialRampToValueAtTime,
     linearRampToValueAtTime, setTargetAtTime, ...), AnalyserNode lacks
     time-domain data readers (getByteTimeDomainData / getFloatTimeDomainData),
     and lacks nodes like createStereoPanner / createDelay / createWaveShaper /
     createConstantSource / createChannelSplitter / createChannelMerger. Only
     fill missing methods so real browsers keep their native audio graph. */
  try {
    var AudioCtor = win.AudioContext || win.webkitAudioContext;
    if (typeof AudioCtor === "function" && AudioCtor.prototype) {
      var makeAudioParam = function (initial) {
        var p = { value: typeof initial === "number" ? initial : 0 };
        return patchAudioParam(p);
      };
      var patchAudioParam = function (p) {
        if (!p || typeof p !== "object") return p;
        if (typeof p.setValueAtTime !== "function") p.setValueAtTime = function (v) { p.value = v; return p; };
        if (typeof p.linearRampToValueAtTime !== "function") p.linearRampToValueAtTime = function (v) { p.value = v; return p; };
        if (typeof p.exponentialRampToValueAtTime !== "function") p.exponentialRampToValueAtTime = function (v) { p.value = v; return p; };
        if (typeof p.setTargetAtTime !== "function") p.setTargetAtTime = function (v) { p.value = v; return p; };
        if (typeof p.setValueCurveAtTime !== "function") p.setValueCurveAtTime = function (vals) { if (vals && vals.length) p.value = vals[vals.length - 1]; return p; };
        if (typeof p.cancelScheduledValues !== "function") p.cancelScheduledValues = function () { return p; };
        if (typeof p.cancelAndHoldAtTime !== "function") p.cancelAndHoldAtTime = function () { return p; };
        return p;
      };
      var patchAudioNode = function (node) {
        if (!node || typeof node !== "object") return node;
        if (typeof node.connect !== "function") {
          node.connect = function (dest) { return dest; };
        } else if (!node.__guConnectWrapped) {
          var origConnect = node.connect;
          node.connect = function (dest) {
            var res;
            try { res = origConnect.apply(this, arguments); } catch (_) {}
            return res !== undefined ? res : dest;
          };
          node.__guConnectWrapped = true;
        }
        if (typeof node.disconnect !== "function") node.disconnect = function () {};
        var paramNames = ["gain", "frequency", "detune", "Q", "threshold", "knee", "ratio", "attack", "release", "playbackRate", "pan", "delayTime", "offset", "positionX", "positionY", "positionZ"];
        for (var i = 0; i < paramNames.length; i++) {
          var pn = paramNames[i];
          if (node[pn] && typeof node[pn] === "object") patchAudioParam(node[pn]);
        }
        if (typeof node.start === "function" && typeof node.setPeriodicWave !== "function") {
          node.setPeriodicWave = function () {};
        }
        // AnalyserNode time-domain/frequency-domain data methods (audio-reactive synths/oscilloscopes).
        if ("fftSize" in node || typeof node.getByteFrequencyData === "function") {
          if (typeof node.getByteFrequencyData !== "function") {
            node.getByteFrequencyData = function (arr) { if (arr && arr.fill) arr.fill(0); };
          }
          if (typeof node.getFloatFrequencyData !== "function") {
            node.getFloatFrequencyData = function (arr) { if (arr && arr.fill) arr.fill(-100); };
          }
          if (typeof node.getByteTimeDomainData !== "function") {
            node.getByteTimeDomainData = function (arr) { if (arr && arr.fill) arr.fill(128); };
          }
          if (typeof node.getFloatTimeDomainData !== "function") {
            node.getFloatTimeDomainData = function (arr) { if (arr && arr.fill) arr.fill(0); };
          }
        }
        return node;
      };
      var needsAudioPatch = false;
      try {
        var probeCtx = new AudioCtor();
        var probeGain = probeCtx.createGain ? probeCtx.createGain() : null;
        var probeAn = probeCtx.createAnalyser ? probeCtx.createAnalyser() : null;
        if (
          (probeGain && probeGain.gain && typeof probeGain.gain.exponentialRampToValueAtTime !== "function") ||
          (probeAn && typeof probeAn.getByteTimeDomainData !== "function") ||
          typeof probeCtx.createStereoPanner !== "function" ||
          typeof probeCtx.createDelay !== "function" ||
          typeof probeCtx.createConstantSource !== "function"
        ) {
          needsAudioPatch = true;
        }
        if (typeof probeCtx.close === "function") { try { probeCtx.close(); } catch (_) {} }
      } catch (_) {}

      if (needsAudioPatch) {
        if (win.AudioParam && win.AudioParam.prototype) patchAudioParam(win.AudioParam.prototype);
        var aproto = AudioCtor.prototype;
        var wrapFactory = function (name) {
          var orig = aproto[name];
          if (typeof orig !== "function") return;
          aproto[name] = function () { return patchAudioNode(orig.apply(this, arguments)); };
        };
        wrapFactory("createGain");
        wrapFactory("createOscillator");
        wrapFactory("createBiquadFilter");
        wrapFactory("createDynamicsCompressor");
        wrapFactory("createBufferSource");
        wrapFactory("createAnalyser");
        if (typeof aproto.createStereoPanner !== "function") {
          aproto.createStereoPanner = function () { return patchAudioNode({ pan: makeAudioParam(0) }); };
        }
        if (typeof aproto.createDelay !== "function") {
          aproto.createDelay = function () { return patchAudioNode({ delayTime: makeAudioParam(0) }); };
        }
        if (typeof aproto.createWaveShaper !== "function") {
          aproto.createWaveShaper = function () { return patchAudioNode({ curve: null, oversample: "none" }); };
        }
        if (typeof aproto.createConvolver !== "function") {
          aproto.createConvolver = function () { return patchAudioNode({ buffer: null, normalize: true }); };
        }
        if (typeof aproto.createPanner !== "function") {
          aproto.createPanner = function () {
            return patchAudioNode({
              positionX: makeAudioParam(0), positionY: makeAudioParam(0), positionZ: makeAudioParam(0),
              setPosition: function () {}, setOrientation: function () {}
            });
          };
        }
        if (typeof aproto.createConstantSource !== "function") {
          aproto.createConstantSource = function () {
            return patchAudioNode({ offset: makeAudioParam(1), start: function () {}, stop: function () {} });
          };
        }
        if (typeof aproto.createChannelSplitter !== "function") {
          aproto.createChannelSplitter = function () { return patchAudioNode({}); };
        }
        if (typeof aproto.createChannelMerger !== "function") {
          aproto.createChannelMerger = function () { return patchAudioNode({}); };
        }
        if (typeof aproto.createPeriodicWave !== "function") {
          aproto.createPeriodicWave = function () { return {}; };
        }
        patched.push("AudioContext");
      }
    }
  } catch (e) { /* skip */ }

  win.__guBrowserShims = { installed: true, patched: patched };
})();
`;
