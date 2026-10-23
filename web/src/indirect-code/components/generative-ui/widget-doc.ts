/**
 * Generative UI widget documents (server + SPA shared).
 *
 * The gateway CSP deliberately does NOT allow inline frames (frame-src is
 * allowlist-only): a widget document is uploaded to
 * /api/indirect-code/gen-ui/widgets and rendered in an iframe pointing at it
 * (sandbox="allow-scripts", opaque origin). This module builds those
 * documents. The widget is a React component (TSX source) compiled to
 * plain JS at doc build time (Bun.Transpiler, in jsx-compile.ts) and spliced into
 * one wrapper script; the embedded REACT_RUNTIME_JS provides the React
 * globals it targets. The boundary sanitizers guard the splice:
 *
 *  - escapeStyleClose: vetted lib css can never contain "</style";
 *  - escapeScriptClose: model-controlled script text can never close its
 *    element or open a sibling script;
 *  - the model-code boundary (model-code.ts): Bun.Transpiler -> acorn ->
 *    astring — forbidden capability nodes are stripped structurally and
 *    string literals are never touched.
 *
 * All are pure functions with unit tests (test/indirect-gen-ui-dsl.test.ts).
 */

import { REACT_RUNTIME_JS } from "./react-runtime";
import { buildJsxModuleBody, escapeScriptClose, sanitizeModelJS } from "./model-code";

export { buildJsxModuleBody, escapeScriptClose, sanitizeModelJS };

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
  --ink-950: #111315;
  --ink-900: #17191c;
  --ink-850: #1d2024;
  --ink-800: #25282d;
  --ink-700: #30343a;
  --ink-600: #41464e;
  --ink-500: #858b95;
  --ink-400: #9ba1ab;
  --ink-300: #b4bac3;
  --ink-200: #d4d8df;
  --ink-100: #eff1f4;
  --accent: #f2f2f5;
  --accent-500: #f2f2f5;
  --accent-strong: #ffffff;
  --accent-fg: #1c1c1e;
  --brand-300: #8cd8ca;
  --brand-400: #78c9bb;
  --brand-500: #65b8a9;
  --brand-600: #4ba393;
  --card: #1b1e21;
  --elev: #24272b;
  --line: #30343a;
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
  --ink-950: #ffffff;
  --ink-900: #f5f6f8;
  --ink-850: #eef0f3;
  --ink-800: #e7e9ed;
  --ink-700: #dde0e5;
  --ink-600: #595e68;
  --ink-500: #747983;
  --ink-400: #626873;
  --ink-300: #565963;
  --ink-200: #3a3d44;
  --ink-100: #1c1c1e;
  --accent: #1c1c1e;
  --accent-500: #1c1c1e;
  --accent-strong: #000000;
  --accent-fg: #ffffff;
  --brand-300: #0d9488;
  --brand-400: #0f766e;
  --brand-500: #115e59;
  --brand-600: #134e4a;
  --card: #fafbfc;
  --elev: #ffffff;
  --line: #e3e6ea;
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
/* Button base is self-contained per class: gu-btn-primary / gu-btn-ghost /
   gu-btn-sm work standalone (models follow the docs and use one class), and
   stacking them with gu-btn still composes via the later variant rules. */
.gu-btn, .gu-btn-primary, .gu-btn-ghost, .gu-btn-sm {
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
.gu-btn:hover, .gu-btn-primary:hover, .gu-btn-ghost:hover, .gu-btn-sm:hover {
  background: color-mix(in oklab, var(--gu-elev) 88%, var(--gu-text) 5%);
}
.gu-btn:active, .gu-btn-primary:active, .gu-btn-ghost:active, .gu-btn-sm:active { transform: translateY(1px); }
.gu-btn:focus-visible, .gu-btn-primary:focus-visible, .gu-btn-ghost:focus-visible, .gu-btn-sm:focus-visible {
  outline: 2px solid var(--gu-brand); outline-offset: 2px;
}
.gu-btn:disabled, .gu-btn-primary:disabled, .gu-btn-ghost:disabled, .gu-btn-sm:disabled { opacity: 0.45; pointer-events: none; }
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
  --p: 0%;
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
 * close it or open a sibling script. Owned by model-code.ts (the model-code
 * boundary); imported + re-exported here for the HTML document assembly.
 */

/** Same idea for CSS spliced into a <style> element ("</style"). */
export function escapeStyleClose(raw: string): string {
  return raw.replace(/<\s*\/\s*style/gi, "<\\/style");
}

/**
 * The widget module body is built in model-code.ts (the model-code boundary:
 * Bun.Transpiler -> acorn -> astring); re-exported above so document
 * assembly keeps one import site.
 */

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
    prefillPrompt: function (text) { if (typeof text === "string" && text.trim()) window.parent.postMessage({ __gu: "prefillPrompt", text: String(text).slice(0, 4000) }, "*"); },
    openLink: function (url) { if (typeof url === "string") window.parent.postMessage({ __gu: "openLink", url: String(url).slice(0, 2048) }, "*"); },
    resize: function (height) { window.parent.postMessage({ __gu: "resize", height: Number(height) }, "*"); },
    saveState: function (s) {
      try {
        var str = JSON.stringify(s === undefined ? window.__gu.state : s);
        if (typeof str === "string" && str.length <= 20000) {
          window.parent.postMessage({ __gu: "state", state: str }, "*");
        }
      } catch {}
    }
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
  // portion without any model-side bookkeeping. Tracks the exact center of the
  // 20px thumb from 0% to 100%.
  function __syncSlider(el) {
    if (!el || el.type !== "range") return;
    var min = Number(el.min);
    if (!Number.isFinite(min)) min = 0;
    var max = Number(el.max);
    if (!Number.isFinite(max) || max <= min) max = min + 100;
    var val = Number(el.value);
    if (!Number.isFinite(val)) val = min;
    var ratio = Math.min(1, Math.max(0, (val - min) / (max - min)));
    // Thumb diameter is 20px. Center of thumb travels from 10px to (width - 10px).
    // Exact center offset: (0.5 - ratio) * 20px.
    var next = "calc(" + (ratio * 100).toFixed(2) + "% + " + ((0.5 - ratio) * 20).toFixed(2) + "px)";
    if (el.style.getPropertyValue("--p") !== next) el.style.setProperty("--p", next);
  }
  function __syncSliders(scope) {
    var list = (scope || document).querySelectorAll('input[type="range"]');
    for (var i = 0; i < list.length; i++) __syncSlider(list[i]);
  }
  try {
    var __proto = HTMLInputElement.prototype;
    var __desc = Object.getOwnPropertyDescriptor(__proto, "value");
    if (__desc && __desc.set) {
      Object.defineProperty(__proto, "value", {
        set: function (v) {
          __desc.set.call(this, v);
          if (this.type === "range") __syncSlider(this);
        },
        get: __desc.get,
        configurable: true
      });
    }
  } catch (_) {}
  document.addEventListener("input", function (ev) { __syncSlider(ev.target); }, true);
  document.addEventListener("change", function (ev) { __syncSlider(ev.target); }, true);
  // Remote images go through the gateway image proxy: it bypasses hotlink
  // protection (no referrer), caches one copy per URL, and validates the
  // payload (magic bytes) before the frame ever sees it. On proxy refusal
  // there is one direct attempt against the original host, then the img
  // simply stays broken (the runtime never hides errors silently).
  function __proxyImg(img) {
    if (!img || img.tagName !== "IMG") return;
    var src = img.getAttribute("src") || "";
    // data:/blob:/same-origin untouched (no regex: the slash closes a
    // regex literal inside this template).
    if (src.indexOf("http://") !== 0 && src.indexOf("https://") !== 0) return;
    if (img.getAttribute("data-gu-proxy")) return; // already rewritten
    img.setAttribute("data-gu-proxy", "1");
    img.setAttribute("data-gu-orig", src);
    img.src = "/api/indirect-code/gen-ui/img?u=" + encodeURIComponent(src);
    img.addEventListener("error", function () {
      if (img.getAttribute("data-gu-fallback")) return;
      img.setAttribute("data-gu-fallback", "1");
      img.src = img.getAttribute("data-gu-orig") || src;
    }, { once: true });
  }
  function __proxyImages(scope) {
    var list = (scope || document).querySelectorAll("img[src]");
    for (var i = 0; i < list.length; i++) __proxyImg(list[i]);
  }
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
    saveState: __host.saveState,
    error: null
  };
  function __bootObservers() {
    var root = document.querySelector(".gu-root") || document.body;
    __syncSliders(document);
    __proxyImages(document);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        __scheduleHeight();
      });
    }
    __scheduleHeight();
    setTimeout(__scheduleHeight, 350);
    try {
      if (typeof ResizeObserver === "function") {
        var ro = new ResizeObserver(__scheduleHeight);
        if (root) ro.observe(root);
        if (document.body && document.body !== root) ro.observe(document.body);
        if (document.documentElement) ro.observe(document.documentElement);
      }
    } catch {}
    try {
      // childList only: observing style/class attributes self-triggers on
      // slider fill writes and fires per frame during gsap/canvas
      // animations. Size changes from attribute churn are ResizeObserver's
      // job above; this observer only needs newly added nodes/sliders.
      new MutationObserver(function (records) {
        __syncSliders(document);
        for (var i = 0; i < records.length; i++) {
          var nodes = records[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === "IMG") __proxyImg(n);
            else if (n.querySelectorAll) __proxyImages(n);
          }
        }
        __scheduleHeight();
      }).observe(root, { childList: true, subtree: true });
    } catch {}
    try {
      // src attribute changes on existing images (React updates) — style
      // writes never match this filter, so animations cannot churn it.
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var t = records[i].target;
          if (t && t.tagName === "IMG") __proxyImg(t);
        }
      }).observe(root, { attributes: true, attributeFilter: ["src"], subtree: true });
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
 * The react shim module (served from /lib/react-shim.js): a real ES module
 * re-exporting the embedded runtime (installed inline in the document by
 * REACT_RUNTIME_JS before this module loads), so widget code can
 * `import { useState } from "react"`. The widget import map points react,
 * react-dom, react-dom/client and the jsx-runtime specifiers at this one
 * module (it exports the union of those surfaces).
 */
export function buildReactShimModule(): string {
  return `const React = window.React;
if (!React) throw new Error("generative-ui runtime missing");
export default React;
export const Children = React.Children, Component = React.Component,
  PureComponent = React.PureComponent, Fragment = React.Fragment,
  createElement = React.createElement, cloneElement = React.cloneElement,
  createContext = React.createContext, isValidElement = React.isValidElement,
  forwardRef = React.forwardRef, memo = React.memo,
  useState = React.useState, useReducer = React.useReducer,
  useEffect = React.useEffect, useLayoutEffect = React.useLayoutEffect,
  useMemo = React.useMemo, useCallback = React.useCallback,
  useRef = React.useRef, useContext = React.useContext, useId = React.useId,
  useDebugValue = React.useDebugValue, useImperativeHandle = React.useImperativeHandle,
  useTransition = React.useTransition, useDeferredValue = React.useDeferredValue,
  useSyncExternalStore = React.useSyncExternalStore, startTransition = React.startTransition;
export const jsx = React.createElement, jsxs = React.createElement,
  jsxDEV = React.createElement;
export const createRoot = window.ReactDOMClient.createRoot,
  hydrateRoot = window.ReactDOMClient.hydrateRoot,
  render = window.ReactDOM.render,
  unmountComponentAtNode = window.ReactDOM.unmountComponentAtNode,
  createPortal = window.ReactDOM.createPortal;
`;
}

/**
 * The widget import map: widget modules are plain ESM and resolve react /
 * react-dom / the jsx-runtime specifiers to the shim module and the
 * preloaded libs (d3, gsap, chart, three, leaflet) to their vendored
 * modules. Every vendored lib is always mapped — an unused entry costs a
 * few bytes of JSON and is never fetched (the browser only loads what the
 * module imports). Everything else is rejected at compile time.
 */
export function buildJsxImportMap(moduleUrls: {
  react: string;
  /** Specifier -> module URL (e.g. "three" -> "/.../lib/three.js"). */
  libs: Record<string, string>;
}): string {
  const imports: Record<string, string> = {
    react: moduleUrls.react,
    "react/jsx-runtime": moduleUrls.react,
    "react/jsx-dev-runtime": moduleUrls.react,
    "react-dom": moduleUrls.react,
    "react-dom/client": moduleUrls.react,
  };
  for (const [name, url] of Object.entries(moduleUrls.libs)) imports[name] = url;
  // chart.js entry points resolve to the same chart module.
  if (moduleUrls.libs.chart) {
    imports["chart.js"] = moduleUrls.libs.chart;
    imports["chart.js/auto"] = moduleUrls.libs.chart;
  }
  if (moduleUrls.libs["cannon-es"]) {
    imports.cannon = moduleUrls.libs["cannon-es"];
  }
  if (moduleUrls.libs["matter-js"]) {
    imports.matter = moduleUrls.libs["matter-js"];
  }
  return JSON.stringify({ imports });
}

export type WidgetDocParams = {
  theme: "dark" | "light";
  /** URL of the stored widget module (compiled TSX source, served as ESM). */
  moduleUrl: string;
  /** JSON import map (from buildJsxImportMap) resolving react + lib modules. */
  importMap: string;
  stateJSON: string;
  scriptNonce: string;
  /** Public origin of this deployment (absolute CSP sources — see moduleSrc). */
  origin: string;
};

/**
 * Images may load from any http(s) site in every variant (photos, covers,
 * avatars). Images cannot script or read the page, and the frame sends no
 * referrer; everything beyond images stays locked down per variant below.
 */
const WIDGET_IMG_SRC = "img-src data: blob: https: http:";

/**
 * Sources of the served widget modules (import map targets): the vendored
 * library bundles and the stored widget modules. These MUST be absolute —
 * CSP rejects path-only sources, and in the sandbox the document has an
 * opaque origin, so 'self' matches nothing. The public origin comes from
 * the request (see requestOrigin in the route).
 */
function moduleSrc(origin: string): string {
  return `${origin}/api/indirect-code/gen-ui/lib/ ${origin}/api/indirect-code/gen-ui/modules/`;
}

/**
 * The widget CSP. Network is images + https data + esm.sh (the one allowed
 * script origin besides the nonce and the served widget modules). Still no
 * cookies or same-origin access — the sandbox keeps the document in an
 * opaque origin (`sandbox allow-scripts` applies even when the document is
 * opened at top level).
 */
export function widgetCSP(nonce: string, origin: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    WIDGET_IMG_SRC,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}' ${moduleSrc(origin)} https://esm.sh`,
    "font-src data:",
    "connect-src https:",
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
export function widgetMetaCSP(nonce: string, origin: string): string {
  return [
    "default-src 'none'",
    WIDGET_IMG_SRC,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}' ${moduleSrc(origin)} https://esm.sh`,
    "font-src data:",
    "connect-src https:",
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
  return `<!doctype html>
<html data-theme="${params.theme}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${widgetMetaCSP(params.scriptNonce, params.origin)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${WIDGET_BASE_CSS}</style>
<script type="importmap" nonce="${params.scriptNonce}">${escapeScriptClose(params.importMap)}</script>
</head>
<body>
<script nonce="${params.scriptNonce}">${escapeScriptClose(REACT_RUNTIME_JS)}</script>
<script nonce="${params.scriptNonce}">${escapeScriptClose(buildRuntimeScript({
    stateJSON: params.stateJSON,
  }))}</script>
<script type="module" src="${params.moduleUrl}" crossorigin="anonymous"></script>
</body></html>`;
}
