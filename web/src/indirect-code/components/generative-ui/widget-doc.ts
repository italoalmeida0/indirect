/**
 * Generative UI widget documents (server + SPA shared).
 *
 * The gateway CSP deliberately does NOT allow inline frames (frame-src is
 * allowlist-only): a widget document is uploaded to
 * /api/indirect-code/gen-ui/widgets and rendered in an iframe pointing at it
 * (sandbox="allow-scripts", opaque origin). This module builds those
 * documents and contains the two boundary sanitizers:
 *
 *  - escapeCSPMeta: model-controlled CSS can never contain "</style" (the
 *    only sequence that can break out of the style element and inject markup
 *    or a competing CSP meta);
 *  - wrapModelJS / closeUnclosedTags: the model's @js body is spliced as text
 *    inside one wrapper <script>; "</script" inside it (strings, regexes) is
 *    re-escaped so it can never close the element.
 *
 * Both are pure functions with unit tests (test/indirect-gen-ui-dsl.test.ts).
 */

export const WIDGET_BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, ui-sans-serif, Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--gu-bg);
  color: var(--gu-text);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  /* The frame auto-fits the root height; the document itself never scrolls. */
  overflow: hidden;
}
::selection { background: color-mix(in oklab, var(--gu-brand) 28%, transparent); }
/* Tokens mirror the host theme (web/style.tailwindcss.css): ink / card /
   elev / line / accent / brand. The widget surface IS the host card color,
   so a widget reads as native transcript content, not an embedded page. */
:root {
  color-scheme: dark;
  --gu-bg: #1b1e21;
  --gu-elev: #24272b;
  --gu-fill: #25282d;
  --gu-line: #30343a;
  --gu-text: #eff1f4;
  --gu-text-dim: #9ba1ab;
  --gu-text-faint: #858b95;
  --gu-accent: #f2f2f5;
  --gu-accent-fg: #1c1c1e;
  --gu-brand: #65b8a9;
  --gu-ok: #65b8a9;
  --gu-warn: #d9a441;
  --gu-danger: #d97070;
  --gu-grid: #232329;
  --gu-chart-1: #65b8a9;
  --gu-chart-2: #7aa2c9;
  --gu-chart-3: #d4a24e;
  --gu-chart-4: #c48a9a;
  --gu-chart-5: #9ba1ab;
  --gu-radius: 10px;
  --gu-radius-sm: 7px;
  --gu-gap: 12px;
  --gu-shadow: 0 1px 2px rgb(0 0 0 / 18%);
  --gu-thumb: #ffffff;
}
[data-theme="light"] {
  color-scheme: light;
  --gu-bg: #fafbfc;
  --gu-elev: #ffffff;
  --gu-fill: #eef0f3;
  --gu-line: #e3e6ea;
  --gu-text: #1c1c1e;
  --gu-text-dim: #565963;
  --gu-text-faint: #747983;
  --gu-accent: #1c1c1e;
  --gu-accent-fg: #ffffff;
  --gu-brand: #147a6e;
  --gu-ok: #32753f;
  --gu-warn: #8a5b00;
  --gu-danger: #c03535;
  --gu-grid: #e8e9ed;
  --gu-chart-1: #147a6e;
  --gu-chart-2: #3f6391;
  --gu-chart-3: #a8741a;
  --gu-chart-4: #9b5d70;
  --gu-chart-5: #6b707c;
  --gu-shadow: 0 1px 2px rgb(28 28 30 / 5%);
  --gu-thumb: #ffffff;
}
.gu-root {
  padding: 16px;
  background: var(--gu-bg);
  color: var(--gu-text);
  font-size: 13px;
  line-height: 1.55;
  min-height: 100%;
}
@media (max-width: 420px) { .gu-root { padding: 14px; } }
.gu-root * { min-width: 0; }
.gu-root img, .gu-root canvas, .gu-root svg { max-width: 100%; }
.gu-root img { display: block; border-radius: var(--gu-radius-sm); }
/* Header group: title + caption stay tight wherever they sit. */
.gu-header .gu-title, .gu-header .gu-subtitle { margin-bottom: 2px; }
.gu-header .gu-caption, .gu-header .gu-body { margin: 0; }
/* Type scale: one clear hierarchy (title > subtitle > body > caption). */
.gu-title { font-size: 17px; font-weight: 600; line-height: 1.3; letter-spacing: -0.02em; text-wrap: balance; margin: 0 0 3px; color: var(--gu-text); }
.gu-subtitle { font-size: 13.5px; font-weight: 600; line-height: 1.4; letter-spacing: -0.01em; margin: 0 0 3px; color: var(--gu-text); }
.gu-body { margin: 0 0 10px; color: var(--gu-text); text-wrap: pretty; }
.gu-caption { font-size: 12px; line-height: 1.5; color: var(--gu-text-faint); margin: 0 0 12px; text-wrap: pretty; }
.gu-strong { font-weight: 600; }
.gu-dim { color: var(--gu-text-dim); }
.gu-mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.gu-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gu-gap); }
.gu-col { display: flex; flex-direction: column; gap: var(--gu-gap); }
/* Inside a stack the gap owns the rhythm; block margins would double it. */
.gu-col > :is(.gu-title, .gu-subtitle, .gu-body, .gu-caption, .gu-divider) { margin: 0; }
.gu-spacer { flex: 1 1 auto; }
.gu-divider { border: 0; border-top: 1px solid var(--gu-line); margin: 12px 0; }
/* Surfaces: prefer ONE surface per widget. Cards group; panels nest flat. */
.gu-card {
  background: var(--gu-elev);
  border: 1px solid var(--gu-line);
  border-radius: 12px;
  box-shadow: var(--gu-shadow);
  padding: 14px;
}
.gu-card.is-selected {
  background: color-mix(in oklab, var(--gu-brand) 6%, var(--gu-elev));
  box-shadow: inset 0 0 0 1.5px var(--gu-brand), var(--gu-shadow);
  border-color: transparent;
}
.gu-panel {
  background: var(--gu-fill);
  border: 0;
  border-radius: var(--gu-radius);
  padding: 12px;
}
.gu-btn {
  appearance: none; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 32px; padding: 0 14px;
  font: inherit; font-size: 13px; font-weight: 550; line-height: 1.2; white-space: nowrap;
  color: var(--gu-text);
  background: var(--gu-elev);
  border: 1px solid var(--gu-line);
  border-radius: 9px;
  box-shadow: var(--gu-shadow);
  transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 100ms ease;
}
.gu-btn:hover { background: color-mix(in oklab, var(--gu-elev) 88%, var(--gu-text) 5%); }
.gu-btn:active { transform: translateY(1px); }
.gu-btn:focus-visible { outline: 2px solid var(--gu-brand); outline-offset: 2px; }
.gu-btn:disabled { opacity: 0.45; pointer-events: none; }
.gu-btn-primary {
  background: var(--gu-accent); color: var(--gu-accent-fg); border-color: transparent;
  box-shadow: var(--gu-shadow);
}
.gu-btn-primary:hover { background: color-mix(in oklab, var(--gu-accent) 90%, var(--gu-accent-fg)); }
.gu-btn-ghost {
  background: transparent; border-color: transparent; color: var(--gu-text-dim); box-shadow: none;
}
.gu-btn-ghost:hover { background: color-mix(in oklab, var(--gu-text) 7%, transparent); color: var(--gu-text); }
.gu-btn-sm { min-height: 28px; padding: 0 10px; font-size: 12px; border-radius: 7px; }
/* Segmented control: use for dataset / view switches instead of loose pills. */
.gu-segmented {
  display: inline-flex; align-items: center; gap: 2px; padding: 2px; max-width: 100%;
  background: var(--gu-fill); border-radius: 10px;
}
.gu-segmented .gu-btn, .gu-segmented button {
  min-height: 28px; padding: 0 12px; min-width: 0;
  font-family: inherit; font-size: 12.5px; font-weight: 550; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: transparent; border: 0; border-radius: 8px; box-shadow: none; color: var(--gu-text-dim);
}
.gu-segmented .gu-btn:hover, .gu-segmented button:hover { color: var(--gu-text); background: transparent; }
.gu-segmented .gu-btn[aria-pressed="true"], .gu-segmented button[aria-pressed="true"],
.gu-segmented .gu-btn.is-active, .gu-segmented button.is-active {
  background: var(--gu-elev); color: var(--gu-text); box-shadow: var(--gu-shadow);
}
/* Choice tiles (time slots, option grids). */
.gu-choice {
  appearance: none; cursor: pointer; -webkit-tap-highlight-color: transparent;
  min-height: 40px; padding: 8px 10px;
  font: inherit; font-size: 13px; font-weight: 550; color: var(--gu-text);
  background: var(--gu-elev); border: 1px solid var(--gu-line); border-radius: 10px;
  transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.gu-choice:hover { background: color-mix(in oklab, var(--gu-elev) 88%, var(--gu-text) 5%); }
.gu-choice:focus-visible { outline: 2px solid var(--gu-brand); outline-offset: 2px; }
.gu-choice[aria-pressed="true"], .gu-choice.is-selected, .gu-choice.selected {
  background: var(--gu-accent); color: var(--gu-accent-fg); border-color: transparent;
}
.gu-input, .gu-select, .gu-textarea {
  width: 100%; font: inherit; font-size: 13px; font-variant-numeric: tabular-nums;
  color: var(--gu-text);
  background: var(--gu-elev);
  border: 1px solid var(--gu-line);
  border-radius: 9px;
  padding: 7px 10px;
  min-height: 34px;
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 3%);
  transition: border-color 140ms ease;
}
.gu-select { appearance: auto; }
.gu-textarea { min-height: 64px; resize: vertical; }
.gu-input::placeholder, .gu-textarea::placeholder { color: var(--gu-text-faint); }
.gu-input:focus, .gu-select:focus, .gu-textarea:focus { border-color: var(--gu-brand); }
.gu-input:focus-visible, .gu-select:focus-visible, .gu-textarea:focus-visible {
  outline: 2px solid var(--gu-brand); outline-offset: 1px;
}
.gu-input[aria-invalid="true"], .gu-select[aria-invalid="true"] { border-color: var(--gu-danger); }
/* Slider: thin 4px track + white thumb. Set --p (0-100%) from JS on input
   to paint the filled portion; without it the track stays neutral. */
.gu-slider {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 28px; margin: 0; background: transparent; cursor: pointer;
  --p: 50%;
}
.gu-slider::-webkit-slider-runnable-track {
  height: 4px; border-radius: 999px;
  background: linear-gradient(to right, var(--gu-brand) 0 var(--p), var(--gu-fill) var(--p) 100%);
}
.gu-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 20px; height: 20px; margin-top: -8px; border-radius: 50%;
  background: var(--gu-thumb);
  border: 0.5px solid color-mix(in oklab, var(--gu-text) 18%, transparent);
  box-shadow: 0 1px 3px rgb(0 0 0 / 22%), 0 0 0 0.5px rgb(0 0 0 / 4%);
}
.gu-slider::-moz-range-track { height: 4px; border-radius: 999px; background: var(--gu-fill); }
.gu-slider::-moz-range-progress { height: 4px; border-radius: 999px; background: var(--gu-brand); }
.gu-slider::-moz-range-thumb {
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--gu-thumb);
  border: 0.5px solid color-mix(in oklab, var(--gu-text) 18%, transparent);
  box-shadow: 0 1px 3px rgb(0 0 0 / 22%);
}
.gu-slider:focus-visible { outline: 2px solid var(--gu-brand); outline-offset: 2px; border-radius: 8px; }
.gu-root input[type="checkbox"], .gu-root input[type="radio"] {
  width: 17px; height: 17px; margin: 0; flex: none; accent-color: var(--gu-accent); cursor: pointer;
}
.gu-field { display: flex; flex-direction: column; gap: 6px; }
.gu-field > span { font-size: 12px; font-weight: 550; color: var(--gu-text-dim); display: flex; justify-content: space-between; gap: 8px; }
.gu-field > span output, .gu-field > span .gu-field-value { font-weight: 600; color: var(--gu-text); font-variant-numeric: tabular-nums; }
.gu-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; min-height: 28px; }
.gu-chip {
  display: inline-flex; align-items: center; gap: 5px;
  min-height: 24px; padding: 2px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 550;
  color: var(--gu-text-dim);
  background: var(--gu-fill);
  border: 0;
}
button.gu-chip { appearance: none; cursor: pointer; font-family: inherit; transition: background 140ms ease, color 140ms ease; }
button.gu-chip:hover { color: var(--gu-text); }
button.gu-chip:focus-visible { outline: 2px solid var(--gu-brand); outline-offset: 2px; }
button.gu-chip[aria-pressed="true"], button.gu-chip.is-active {
  background: var(--gu-accent); color: var(--gu-accent-fg);
}
.gu-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 1.4; white-space: nowrap;
  color: var(--gu-text-dim);
  background: var(--gu-fill);
}
.gu-badge-ok { color: var(--gu-ok); background: color-mix(in oklab, var(--gu-ok) 12%, transparent); }
.gu-badge-warn { color: var(--gu-warn); background: color-mix(in oklab, var(--gu-warn) 12%, transparent); }
.gu-badge-danger { color: var(--gu-danger); background: color-mix(in oklab, var(--gu-danger) 12%, transparent); }
.gu-progress {
  height: 5px; border-radius: 999px; overflow: hidden;
  background: var(--gu-fill);
}
.gu-progress > i {
  display: block; height: 100%; border-radius: 999px;
  background: var(--gu-brand);
  transition: width 260ms ease;
}
.gu-kpi { display: flex; flex-wrap: wrap; gap: var(--gu-gap); }
.gu-kpi-item {
  flex: 1 1 110px;
  background: var(--gu-elev);
  border: 1px solid var(--gu-line);
  border-radius: 12px;
  box-shadow: var(--gu-shadow);
  padding: 12px;
}
.gu-kpi-value { display: block; font-size: 21px; font-weight: 650; line-height: 1.15; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.gu-kpi-label { display: block; font-size: 12px; font-weight: 500; color: var(--gu-text-faint); margin-top: 2px; }
/* Tables: hairlines only, no zebra, always inside .gu-table-wrap. */
.gu-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: var(--gu-radius); }
.gu-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.gu-table th {
  text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--gu-text-faint); white-space: nowrap;
  padding: 8px 10px; border-bottom: 1px solid var(--gu-line);
}
.gu-table td {
  padding: 9px 10px; border-bottom: 1px solid var(--gu-line);
  font-variant-numeric: tabular-nums; vertical-align: middle;
}
.gu-table tbody tr { background: transparent; }
.gu-table tbody tr:nth-child(even) { background: transparent; }
.gu-table tbody tr:last-child td { border-bottom: 0; }
.gu-table .num, .gu-table td.num, .gu-table th.num { text-align: right; }
.gu-bars { display: flex; flex-direction: column; gap: 8px; }
.gu-bar { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
.gu-bar-label { flex: 0 0 84px; color: var(--gu-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gu-bar-track {
  flex: 1 1 auto; height: 5px; border-radius: 999px; overflow: hidden;
  background: var(--gu-fill);
}
.gu-bar-track > i {
  display: block; height: 100%; border-radius: 999px;
  background: var(--gu-chart-1);
  transition: width 260ms ease;
}
.gu-bar-value { flex: 0 0 auto; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.gu-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--gu-text-dim); }
.gu-swatch {
  display: inline-block; width: 9px; height: 9px; border-radius: 3px;
  margin-right: 5px; vertical-align: -1px;
  background: var(--gu-chart-1);
}
.gu-svg { display: block; width: 100%; height: auto; overflow: visible; }
.gu-svg text { fill: var(--gu-text-faint); font-size: 11px; font-family: inherit; }
.gu-svg .axis-line, .gu-svg .grid-line { stroke: var(--gu-grid); stroke-width: 1; }
/* Media, map and 3D stages share one clipped stage treatment. */
.gu-stage { border-radius: 12px; overflow: hidden; background: var(--gu-fill); }
.gu-stage canvas { display: block; }
.gu-root .leaflet-container { font: inherit; border-radius: 12px; background: var(--gu-fill); }
.gu-root .leaflet-control-attribution {
  font-size: 10px; line-height: 1.4; padding: 1px 6px;
  background: color-mix(in oklab, var(--gu-elev) 82%, transparent); color: var(--gu-text-faint);
}
.gu-root .leaflet-bar { border: 1px solid var(--gu-line); border-radius: 8px; overflow: hidden; box-shadow: var(--gu-shadow); }
.gu-root .leaflet-bar a { background: var(--gu-elev); color: var(--gu-text); border-bottom-color: var(--gu-line); }
/* Multi-column layouts (reference: cards in a main+side grid). */
.gu-split {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--gu-gap);
  align-items: start;
}
.gu-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--gu-gap);
  align-items: start;
}
.gu-grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gu-gap);
  align-items: start;
}
@media (max-width: 640px) {
  .gu-split, .gu-grid-2, .gu-grid-3 { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 480px) {
  /* Bars stack: label + value on one line, full-width track below. */
  .gu-bar { flex-wrap: wrap; row-gap: 4px; }
  .gu-bar-label { flex: 1 1 auto; }
  .gu-bar-track { order: 3; flex: 1 1 100%; }
  .gu-bar-value { margin-left: auto; }
}
.gu-hidden { display: none !important; }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;

/** Nonce for the single inline runtime script of a widget document. */
export function makeScriptNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Re-escapes every "<script" / "</script" (in any case, with optional
 * whitespace) so model text spliced inside a <script> element can never
 * close it or open a sibling script.
 */
export function escapeScriptClose(raw: string): string {
  return raw.replace(/<\s*\/?\s*script/gi, "<\\/script");
}

/** Same idea for CSS spliced into a <style> element ("</style"). */
export function escapeStyleClose(raw: string): string {
  return raw.replace(/<\s*\/\s*style/gi, "<\\/style");
}

/**
 * The model's @js body is spliced as one script block. Statements that the
 * sandbox forbids are stripped before they ever reach the frame (the Go-side
 * prompt forbids them too; this is the enforcement layer).
 */
/** Dynamic imports are allowed only from this CDN, and only in net widgets. */
const ESM_SH_DYNAMIC_IMPORT = /\bimport\s*\(\s*["']https:\/\/esm\.sh\//;

export function sanitizeModelJS(js: string, opts?: { allowEsmSh?: boolean }): string {
  const out: string[] = [];
  for (const line of js.split("\n")) {
    if (opts?.allowEsmSh && ESM_SH_DYNAMIC_IMPORT.test(line)) {
      out.push(line);
      continue;
    }
    if (/\b(import\s|export\s|import\(|eval\s*\(|new\s+Function\s*\()/.test(line)) continue;
    if (/\b(location\s*\.\s*(href|assign|replace)|window\s*\.\s*open\s*\(|top\s*\.\s*location|parent\s*\.\s*location)/.test(line)) continue;
    if (/\b(fetch\s*\(|XMLHttpRequest|WebSocket|importScripts\s*\(|navigator\s*\.\s*sendBeacon)/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Runtime script of a widget document (see prompt_gen_ui.go for the contract). */
export function buildRuntimeScript(params: { stateJSON: string }): string {
  const stateJSON = params.stateJSON.trim() || "{}";
  return `
(function () {
  "use strict";
  var state = ${stateJSON};
  var __destroyers = [];
  var __resizers = [];
  var __errorHandler = null;
  var __host = {
    sendPrompt: function (text) { if (typeof text === "string" && text.trim()) window.parent.postMessage({ __gu: "sendPrompt", text: String(text).slice(0, 4000) }, "*"); },
    openLink: function (url) { if (typeof url === "string") window.parent.postMessage({ __gu: "openLink", url: String(url).slice(0, 2048) }, "*"); },
    resize: function (height) { window.parent.postMessage({ __gu: "resize", height: Number(height) }, "*"); }
  };
  window.indirectUi = Object.freeze(__host);
  var __lastHeight = 0;
  function __measure() {
    var root = document.querySelector(".gu-root") || document.body;
    return Math.ceil(root.getBoundingClientRect().height);
  }
  function __postHeight(height) {
    if (height > 0 && Math.abs(height - __lastHeight) > 1) {
      __lastHeight = height;
      window.parent.postMessage({ __gu: "resize", height: height }, "*");
    }
    return height;
  }
  function $render() {
    var height = __postHeight(__measure());
    for (var i = 0; i < __resizers.length; i++) { try { __resizers[i](height); } catch (err) { reportError(err); } }
    return undefined;
  }
  // Auto height: charts, maps and 3D stages mutate the DOM without calling
  // $render (d3 draws, Leaflet tiles, images load). Observe the root so the
  // frame always fits the painted content instead of clipping it. Flush on
  // rAF OR a timer, whichever comes first: rAF is throttled for offscreen
  // frames, and a below-the-fold widget must still size itself.
  var __heightRaf = 0;
  var __heightTimer = 0;
  function __flushHeight() {
    if (__heightRaf) cancelAnimationFrame(__heightRaf);
    if (__heightTimer) clearTimeout(__heightTimer);
    __heightRaf = 0;
    __heightTimer = 0;
    __postHeight(__measure());
  }
  function __scheduleHeight() {
    if (__heightRaf || __heightTimer) return;
    __heightRaf = requestAnimationFrame(__flushHeight);
    __heightTimer = setTimeout(__flushHeight, 120);
  }
  // Slider fill: keep --p in sync so the thin track paints its filled
  // portion without any model-side bookkeeping.
  function __syncSlider(el) {
    if (!el || el.type !== "range") return;
    var min = Number(el.min) || 0, max = Number(el.max);
    if (!Number.isFinite(max) || max <= min) max = min + 100;
    var pct = ((Number(el.value) - min) / (max - min)) * 100;
    if (!Number.isFinite(pct)) return;
    var next = Math.min(100, Math.max(0, pct)) + "%";
    if (el.style.getPropertyValue("--p") !== next) el.style.setProperty("--p", next);
  }
  function __syncSliders(scope) {
    var list = (scope || document).querySelectorAll('input[type="range"]');
    for (var i = 0; i < list.length; i++) __syncSlider(list[i]);
  }
  document.addEventListener("input", function (ev) { __syncSlider(ev.target); }, true);
  document.addEventListener("change", function (ev) { __syncSlider(ev.target); }, true);
  function $onDestroy(fn) { if (typeof fn === "function") __destroyers.push(fn); }
  function $onResize(fn) { if (typeof fn === "function") __resizers.push(fn); }
  function $onError(fn) { if (typeof fn === "function") __errorHandler = fn; }
  function reportError(err) {
    try {
      var message = String((err && err.message) || err).slice(0, 500);
      if (window.__gu) window.__gu.error = message;
      if (__errorHandler) __errorHandler(err);
      window.parent.postMessage({ __gu: "error", message: message }, "*");
    } catch {}
  }
  function runDestroy() {
    var list = __destroyers.splice(0, __destroyers.length);
    for (var i = 0; i < list.length; i++) { try { list[i](); } catch (err) { reportError(err); } }
  }
  window.__gu = {
    state: state, render: $render,
    onDestroy: $onDestroy, onResize: $onResize, onError: $onError,
    reportError: reportError, destroy: runDestroy,
    error: null
  };
  function __bootObservers() {
    var root = document.querySelector(".gu-root") || document.body;
    __syncSliders(document);
    __scheduleHeight();
    try {
      if (typeof ResizeObserver === "function") new ResizeObserver(__scheduleHeight).observe(root);
    } catch {}
    try {
      // childList only: observing style/class attributes self-triggers on
      // slider fill writes and fires per frame during gsap/canvas
      // animations. Size changes from attribute churn are ResizeObserver's
      // job above; this observer only needs newly added nodes/sliders.
      new MutationObserver(function () { __syncSliders(document); __scheduleHeight(); })
        .observe(root, { childList: true, subtree: true });
    } catch {}
    window.addEventListener("load", __scheduleHeight);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", __bootObservers);
  else __bootObservers();
  // Uncaught model errors (including async/esm load failures) surface in
  // the host error footer instead of dying silently inside the frame.
  window.addEventListener("error", function (ev) {
    if (ev && ev.message) reportError(ev.error || ev.message);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    reportError((ev && ev.reason) || "Unhandled promise rejection");
  });
  // Runs when the widget leaves the page (iframe swap, navigation, close).
  window.addEventListener("pagehide", runDestroy);
})();
`;
}

/**
 * The model's @js body, in its own <script> element so a parse error in
 * model code can never take the runtime (bridge, $render) down with it.
 *
 * The body is spliced (as escaped text) into one wrapper function with
 * `state`, `$render()`, `$onDestroy()`, `$onError()`, `$onResize()` and
 * `window.indirectUi` in scope — exactly the DSL contract. It may end with
 * `return { destroy() {...} }` to release resources (three.js, gsap, rAF):
 * the returned destroy() is registered as a cleanup hook. No eval: the
 * widget CSP has no 'unsafe-eval', and a syntax error in the body only
 * kills this one script element.
 */
export function buildModelScript(js: string, opts?: { allowEsmSh?: boolean }): string {
  return `
(function () {
  "use strict";
  var state = window.__gu && window.__gu.state || {};
  var $render = window.__gu && window.__gu.render || function () {};
  var $onDestroy = window.__gu && window.__gu.onDestroy || function () {};
  var $onError = window.__gu && window.__gu.onError || function () {};
  var $onResize = window.__gu && window.__gu.onResize || function () {};
  try {
    var __result = (function () {
${escapeScriptClose(sanitizeModelJS(js, opts))}
    })();
    if (__result && typeof __result.destroy === "function") $onDestroy(__result.destroy);
  } catch (err) {
    try { if (window.__gu && window.__gu.reportError) window.__gu.reportError(err); else if (window.__gu) window.__gu.error = String(err); } catch {}
  }
})();
`;
}

export type WidgetDocParams = {
  theme: "dark" | "light";
  html: string;
  css: string;
  stateJSON: string;
  js: string;
  initialHeight: number;
  scriptNonce: string;
  /** Preloaded library sources (IIFE globals), keyed by lib name. */
  libs?: Record<string, string>;
  /** Preloaded library stylesheets (leaf map css), keyed by lib name. */
  libCss?: Record<string, string>;
  /** Opt-in network capability (`net: true` header): https images/tiles. */
  net?: boolean;
};

/**
 * Injection order matters: chart.js and three.js may pull utilities from
 * gsap-style helpers and d3 is standalone, but keeping one fixed order makes
 * the document byte-stable for content-addressed ids.
 */
const LIB_ORDER = ["d3", "gsap", "chart", "three", "map"];

/**
 * Images may load from any http(s) site in every variant (photos, covers,
 * avatars). Images cannot script or read the page, and the frame sends no
 * referrer; everything beyond images stays locked down per variant below.
 */
const WIDGET_IMG_SRC = "img-src data: blob: https: http:";

/**
 * Opt-in network variant (`net: true` DSL header): on top of any-site
 * images, the widget may fetch https data/map tiles and dynamically import
 * JS libraries from esm.sh (the only allowed script origin besides the
 * nonce). Still no cookies or same-origin access — the sandbox keeps the
 * document in an opaque origin.
 */
export function widgetNetCSP(nonce: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    WIDGET_IMG_SRC,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}' https://esm.sh`,
    "font-src data:",
    "connect-src https:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function widgetCSP(nonce: string): string {
  return [
    // `sandbox allow-scripts` applies even when the document is opened at
    // top level: the widget always runs in an opaque origin, no cookies, no
    // storage, no network beyond http(s) images — otherwise identical to a
    // sandboxed iframe.
    "sandbox allow-scripts",
    "default-src 'none'",
    WIDGET_IMG_SRC,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * The meta-tag variant: `sandbox` and `frame-ancestors` are ignored when
 * delivered via <meta>, so they are omitted (the response header carries
 * them; the meta is belt-and-braces for non-HTTP contexts only).
 */
export function widgetMetaNetCSP(nonce: string): string {
  return [
    "default-src 'none'",
    WIDGET_IMG_SRC,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}' https://esm.sh`,
    "font-src data:",
    "connect-src https:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function widgetMetaCSP(nonce: string): string {
  return [
    "default-src 'none'",
    WIDGET_IMG_SRC,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The final widget document. Served by /api/indirect-code/gen-ui/widgets/:id
 * with widgetCSP() as a response header (CSP meta is inert here — the header
 * always wins — but is kept as belt-and-braces for file:// or extension
 * contexts).
 */
export function buildWidgetDocument(params: WidgetDocParams): string {
  const libs = params.libs ?? {};
  const libCss = params.libCss ?? {};
  const libScripts = LIB_ORDER.filter((name) => libs[name])
    .map((name) => `<script nonce="${params.scriptNonce}">${escapeScriptClose(libs[name])}\n</script>\n`)
    .join("");
  const libStyles = LIB_ORDER.filter((name) => libCss[name])
    .map((name) => `<style>${escapeStyleClose(libCss[name])}</style>\n`)
    .join("");
  return `<!doctype html>
<html data-theme="${params.theme}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${params.net ? widgetMetaNetCSP(params.scriptNonce) : widgetMetaCSP(params.scriptNonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${WIDGET_BASE_CSS}</style>
${libStyles}
<style>${escapeStyleClose(params.css || "")}</style>
</head>
<body style="min-height:${params.initialHeight}px">
${params.html || ""}
${libScripts}<script nonce="${params.scriptNonce}">${escapeScriptClose(buildRuntimeScript({
    stateJSON: params.stateJSON,
  }))}</script>
<script nonce="${params.scriptNonce}">${escapeScriptClose(buildModelScript(params.js, { allowEsmSh: params.net === true }))}</script>
</body></html>`;
}

export type PreviewDocParams = {
  theme: "dark" | "light";
  scriptNonce: string;
};

/**
 * The streaming preview document: an empty shell whose listener accepts
 * partial HTML/CSS fragments over postMessage and morphs them in place
 * (Idiomorph preserves DOM state and focus while the model streams). It runs
 * no model code at all.
 */
export function buildPreviewDocument(params: PreviewDocParams): string {
  return `<!doctype html>
<html data-theme="${params.theme}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${widgetMetaCSP(params.scriptNonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${WIDGET_BASE_CSS}</style>

<style id="gu-style"></style>
</head><body><div id="gu-preview-root" class="gu-root"></div>
<script nonce="${params.scriptNonce}">window.__guPreview = true;</script>
<script nonce="${params.scriptNonce}">__IDIOMORPH__</script>
</body></html>`;
}

/** Injects the Idiomorph source into the preview document placeholder. */
export function withIdiomorph(doc: string, idiomorphSource: string): string {
  return doc.replace("__IDIOMORPH__", escapeScriptClose(idiomorphSource) + PREVIEW_LISTENER);
}

const PREVIEW_LISTENER = `
(function(){
  var root = document.getElementById("gu-preview-root");
  var style = document.getElementById("gu-style");
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.__guPreview !== true) return;
    if (typeof data.css === "string") style.textContent = data.css;
    if (typeof data.html === "string") {
      if (data.html.indexOf("<") === -1 || isSingleRootSafe(data.html)) {
        root.innerHTML = "";
        var tpl = document.createElement("template");
        tpl.innerHTML = data.html;
        root.appendChild(tpl.content);
      } else {
        Idiomorph.morph(root, data.html, { morphStyle: "innerHTML" });
      }
    }
    window.parent.postMessage({ __gu: "resize", height: Math.ceil(root.getBoundingClientRect().height) }, "*");
  });
  function isSingleRootSafe(html) {
    var tpl = document.createElement("template");
    tpl.innerHTML = html;
    return tpl.content.children.length === 1 && !tpl.textContent.trim();
  }
  window.parent.postMessage({ __gu: "resize", height: Math.ceil(root.getBoundingClientRect().height) }, "*");
})();
`;
