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

  win.__guBrowserShims = { installed: true, patched: patched };
})();
`;
