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
html { overflow-x: clip; }
body {
  font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--gu-bg);
  color: var(--gu-text);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  /* The frame auto-fits the root height; flow-root keeps child margins inside
     body so non-.gu-root game shells never clip. */
  display: flow-root;
  overflow: hidden;
}
img, canvas, svg { max-width: 100%; }
html[data-fullscreen="true"] { height: 100%; }
html[data-fullscreen="true"] body {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
}
html[data-fullscreen="true"] .gu-root {
  flex: 1 0 auto;
  min-height: 100%;
}
html[data-fullscreen="true"] body > div:not(.gu-root) {
  flex: 1 0 100%;
  min-height: 100%;
  max-height: none !important;
  aspect-ratio: auto !important;
}
html[data-fullscreen="true"] .gu-game-stage {
  max-height: none !important;
  aspect-ratio: auto !important;
  border-radius: 0 !important;
}
html[data-fullscreen="true"] .gu-game-stage:only-child {
  height: 100% !important;
  min-height: 100vh !important;
}
canvas:focus:not(:focus-visible) { outline: none; }
canvas:focus-visible { outline: 2px solid var(--gu-brand); outline-offset: -2px; }
::selection { background: color-mix(in oklab, var(--gu-brand) 28%, transparent); }
/* Tokens mirror the host Arc theme (web/src/ds/tokens.css). The widget surface
   IS the host --surface color, so a widget reads as native transcript content,
   not an embedded page. */
:root {
  color-scheme: dark;
  --ink-950: oklch(19% 0 0);
  --ink-900: oklch(21.5% 0 0);
  --ink-850: oklch(23% 0 0);
  --ink-800: oklch(26% 0 0);
  --ink-700: oklch(29% 0 0);
  --ink-600: oklch(64% 0 0);
  --ink-500: oklch(64% 0 0);
  --ink-400: oklch(78% 0 0);
  --ink-300: oklch(84% 0 0);
  --ink-200: oklch(90% 0 0);
  --ink-100: oklch(93.5% 0 0);
  --accent: oklch(96% 0 0);
  --accent-500: oklch(96% 0 0);
  --accent-strong: oklch(100% 0 0);
  --accent-fg: oklch(19% 0 0);
  --gu-bg: oklch(21.5% 0 0);
  --gu-elev: oklch(25% 0 0);
  --gu-fill: oklch(26% 0 0);
  --gu-line: oklch(29% 0 0);
  --gu-text: oklch(93.5% 0 0);
  --gu-text-muted: oklch(78% 0 0);
  --gu-text-dim: var(--gu-text-muted);
  --gu-text-faint: oklch(64% 0 0);
  --gu-accent: oklch(96% 0 0);
  --gu-accent-fg: oklch(19% 0 0);
  --gu-brand: oklch(72% 0.13 182);
  --brand-300: color-mix(in oklab, var(--gu-brand) 82%, white);
  --brand-400: var(--gu-brand);
  --brand-500: var(--gu-brand);
  --brand-600: color-mix(in oklab, var(--gu-brand) 82%, black);
  --card: var(--gu-bg);
  --elev: var(--gu-elev);
  --line: var(--gu-line);
  --gu-ok: oklch(79% 0.14 162);
  --gu-warn: oklch(73.5% 0.105 74);
  --gu-danger: oklch(71% 0.155 8);
  --gu-grid: oklch(29% 0 0);
  --gu-chart-1: var(--gu-brand);
  --gu-chart-2: oklch(74% 0.125 290);
  --gu-chart-3: oklch(73.5% 0.105 74);
  --gu-chart-4: oklch(79% 0.095 236);
  --gu-chart-5: oklch(78% 0 0);
  --gu-radius: 12px;
  --gu-radius-sm: 8px;
  --gu-gap: 16px;
  --gu-gap-sm: 10px;
  --gu-shadow: 0 1px 2px oklch(0% 0 0 / 0.18);
  --gu-thumb: oklch(97% 0 0);
}
[data-theme="light"] {
  color-scheme: light;
  --ink-950: oklch(100% 0 0);
  --ink-900: oklch(98.6% 0 0);
  --ink-850: oklch(97.5% 0 0);
  --ink-800: oklch(95.8% 0 0);
  --ink-700: oklch(90% 0 0);
  --ink-600: oklch(54% 0 0);
  --ink-500: oklch(54% 0 0);
  --ink-400: oklch(42% 0 0);
  --ink-300: oklch(34% 0 0);
  --ink-200: oklch(23% 0 0);
  --ink-100: oklch(18% 0 0);
  --accent: oklch(15% 0 0);
  --accent-500: oklch(15% 0 0);
  --accent-strong: oklch(15% 0 0);
  --accent-fg: oklch(100% 0 0);
  --gu-bg: oklch(100% 0 0);
  --gu-elev: oklch(97.5% 0 0);
  --gu-fill: oklch(95.8% 0 0);
  --gu-line: oklch(90% 0 0);
  --gu-text: oklch(18% 0 0);
  --gu-text-muted: oklch(42% 0 0);
  --gu-text-dim: var(--gu-text-muted);
  --gu-text-faint: oklch(54% 0 0);
  --gu-accent: oklch(15% 0 0);
  --gu-accent-fg: oklch(100% 0 0);
  --gu-brand: oklch(54% 0.12 182);
  --gu-ok: oklch(50% 0.12 162);
  --gu-warn: oklch(55% 0.12 68);
  --gu-danger: oklch(53% 0.18 10);
  --gu-grid: oklch(90% 0 0);
  --gu-chart-1: var(--gu-brand);
  --gu-chart-2: oklch(51% 0.16 290);
  --gu-chart-3: oklch(55% 0.12 68);
  --gu-chart-4: oklch(51% 0.11 240);
  --gu-chart-5: oklch(42% 0 0);
  --gu-shadow: 0 1px 2px oklch(0% 0 0 / 0.04);
  --gu-thumb: oklch(100% 0 0);
}
/* Host accent overrides (synced from html[data-accent]). */
:root[data-accent="neutral"] { --gu-brand: oklch(80% 0 0); }
:root[data-accent="violet"] { --gu-brand: oklch(70% 0.18 290); }
:root[data-accent="blue"] { --gu-brand: oklch(72% 0.15 256); }
:root[data-accent="green"] { --gu-brand: oklch(79% 0.14 162); }
:root[data-accent="amber"] { --gu-brand: oklch(85% 0.14 84); }
:root[data-accent="orange"] { --gu-brand: oklch(79% 0.14 58); }
:root[data-accent="coral"] { --gu-brand: oklch(75% 0.14 25); }
:root[data-accent="rose"] { --gu-brand: oklch(76% 0.15 352); }
:root[data-theme="light"][data-accent="neutral"] { --gu-brand: oklch(33% 0 0); }
:root[data-theme="light"][data-accent="violet"] { --gu-brand: oklch(54% 0.24 287); }
:root[data-theme="light"][data-accent="blue"] { --gu-brand: oklch(53% 0.22 260); }
:root[data-theme="light"][data-accent="green"] { --gu-brand: oklch(58% 0.14 162); }
:root[data-theme="light"][data-accent="amber"] { --gu-brand: oklch(60% 0.14 75); }
:root[data-theme="light"][data-accent="orange"] { --gu-brand: oklch(61% 0.16 53); }
:root[data-theme="light"][data-accent="coral"] { --gu-brand: oklch(59% 0.19 26); }
:root[data-theme="light"][data-accent="rose"] { --gu-brand: oklch(58% 0.2 354); }
.gu-root {
  padding: 20px;
  background: var(--gu-bg);
  color: var(--gu-text);
  font-size: 13.5px;
  line-height: 1.55;
  min-height: 100%;
  overflow-x: clip;
}
.gu-root * { min-width: 0; }
.gu-root img, .gu-root canvas, .gu-root svg { max-width: 100%; }
.gu-root img { display: block; border-radius: var(--gu-radius-sm); }
/* Header group: title + caption stay tight wherever they sit. */
.gu-header { margin-bottom: 14px; }
.gu-header .gu-title, .gu-header .gu-subtitle { margin-bottom: 3px; }
.gu-header .gu-caption, .gu-header .gu-body { margin: 0; }
/* Type scale: one clear hierarchy (title > subtitle > body > caption), weights 400/500 only. */
.gu-title { font-size: 18px; font-weight: 500; line-height: 1.28; letter-spacing: -0.02em; text-wrap: balance; margin: 0 0 4px; color: var(--gu-text); }
.gu-subtitle { font-size: 14px; font-weight: 500; line-height: 1.38; letter-spacing: -0.01em; margin: 0 0 4px; color: var(--gu-text); }
.gu-body { margin: 0 0 12px; color: var(--gu-text); text-wrap: pretty; }
.gu-caption { font-size: 12.5px; line-height: 1.5; color: var(--gu-text-faint); margin: 0 0 12px; text-wrap: pretty; }
.gu-strong { font-weight: 500; }
.gu-dim { color: var(--gu-text-dim); }
.gu-mono { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.gu-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gu-gap-sm) 12px; }
.gu-col, .gu-stack { display: flex; flex-direction: column; gap: var(--gu-gap); }
.gu-stack-sm { display: flex; flex-direction: column; gap: var(--gu-gap-sm); }
.gu-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }
/* Inside a stack the gap owns the rhythm; block margins would double it. */
.gu-col > :is(.gu-title, .gu-subtitle, .gu-body, .gu-caption, .gu-divider, .gu-header),
.gu-stack > :is(.gu-title, .gu-subtitle, .gu-body, .gu-caption, .gu-divider, .gu-header),
.gu-stack-sm > :is(.gu-title, .gu-subtitle, .gu-body, .gu-caption, .gu-divider, .gu-header) { margin: 0; }
.gu-spacer { flex: 1 1 auto; }
.gu-divider { border: 0; border-top: 1px solid var(--gu-line); margin: 16px 0; }
/* Surfaces: prefer ONE surface per widget. Cards rest on a crisp 1px border, no drop shadows. */
.gu-card {
  background: var(--gu-elev);
  border: 1px solid var(--gu-line);
  border-radius: 14px;
  padding: 16px 18px;
}
.gu-card.is-selected {
  background: color-mix(in oklab, var(--gu-brand) 6%, var(--gu-elev));
  box-shadow: inset 0 0 0 1.5px var(--gu-brand);
  border-color: transparent;
}
.gu-panel {
  background: var(--gu-fill);
  border: 0;
  border-radius: var(--gu-radius);
  padding: 14px 16px;
}
/* Button base is self-contained per class: gu-btn-primary / gu-btn-ghost /
   gu-btn-sm work standalone (models follow the docs and use one class), and
   stacking them with gu-btn still composes via the later variant rules. */
.gu-btn, .gu-btn-primary, .gu-btn-ghost, .gu-btn-sm {
  appearance: none; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 32px; padding: 0 14px;
  font: inherit; font-size: 13px; font-weight: 500; line-height: 1.2; white-space: nowrap;
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
/* Segmented control & tabs: use for dataset / view switches instead of loose pills.
   Horizontally scrollable on narrow mobile screens so multi-tab strips never overflow or crush. */
.gu-segmented, .gu-tabs {
  display: inline-flex; align-items: center; gap: 2px; padding: 3px; max-width: 100%;
  background: var(--gu-fill); border-radius: 10px;
  overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;
}
.gu-segmented::-webkit-scrollbar, .gu-tabs::-webkit-scrollbar { display: none; }
.gu-segmented .gu-btn, .gu-segmented button,
.gu-tabs .gu-btn, .gu-tabs button {
  flex: 0 0 auto;
  min-height: 30px; padding: 0 12px;
  font-family: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
  white-space: nowrap;
  background: transparent; border: 0; border-radius: 8px; box-shadow: none; color: var(--gu-text-dim);
  transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.gu-segmented .gu-btn:hover, .gu-segmented button:hover,
.gu-tabs .gu-btn:hover, .gu-tabs button:hover { color: var(--gu-text); background: transparent; }
.gu-segmented .gu-btn[aria-pressed="true"], .gu-segmented button[aria-pressed="true"],
.gu-segmented .gu-btn[aria-selected="true"], .gu-segmented button[aria-selected="true"],
.gu-segmented .gu-btn.is-active, .gu-segmented button.is-active,
.gu-tabs .gu-btn[aria-pressed="true"], .gu-tabs button[aria-pressed="true"],
.gu-tabs .gu-btn[aria-selected="true"], .gu-tabs button[aria-selected="true"],
.gu-tabs .gu-btn.is-active, .gu-tabs button.is-active {
  background: var(--gu-elev); color: var(--gu-text); box-shadow: var(--gu-shadow);
}
/* Choice tiles (time slots, option grids). */
.gu-choice {
  appearance: none; cursor: pointer; -webkit-tap-highlight-color: transparent;
  min-height: 40px; padding: 8px 10px;
  font: inherit; font-size: 13px; font-weight: 500; color: var(--gu-text);
  background: var(--gu-elev); border: 1px solid var(--gu-line); border-radius: 10px;
  transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.gu-choice:hover { background: color-mix(in oklab, var(--gu-elev) 88%, var(--gu-text) 5%); }
.gu-choice:focus-visible { outline: 2px solid var(--gu-brand); outline-offset: 2px; }
.gu-choice[aria-pressed="true"], .gu-choice.is-selected, .gu-choice.selected {
  background: color-mix(in oklab, var(--gu-brand) 14%, var(--gu-elev));
  color: var(--gu-text);
  border-color: color-mix(in oklab, var(--gu-brand) 58%, var(--gu-line));
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--gu-brand) 36%, transparent);
}
.gu-choice[aria-pressed="true"]:hover, .gu-choice.is-selected:hover, .gu-choice.selected:hover {
  background: color-mix(in oklab, var(--gu-brand) 19%, var(--gu-elev));
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
.gu-select option, select option { background: var(--gu-elev); color: var(--gu-text); }
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
.gu-field > span { font-size: 12px; font-weight: 500; color: var(--gu-text-dim); display: flex; justify-content: space-between; gap: 8px; }
.gu-field > span output, .gu-field > span .gu-field-value { font-weight: 500; color: var(--gu-text); font-variant-numeric: tabular-nums; }
.gu-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; min-height: 28px; }
.gu-chip {
  display: inline-flex; align-items: center; gap: 5px;
  min-height: 24px; padding: 2px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 500;
  color: var(--gu-text-dim);
  background: var(--gu-fill);
  border: 0;
}
button.gu-chip { appearance: none; cursor: pointer; font-family: inherit; transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease; }
button.gu-chip:hover { color: var(--gu-text); }
button.gu-chip:focus-visible { outline: 2px solid var(--gu-brand); outline-offset: 2px; }
button.gu-chip[aria-pressed="true"], button.gu-chip.is-active {
  background: color-mix(in oklab, var(--gu-brand) 16%, var(--gu-elev));
  color: var(--gu-text);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--gu-brand) 54%, transparent);
}
button.gu-chip[aria-pressed="true"]:hover, button.gu-chip.is-active:hover {
  background: color-mix(in oklab, var(--gu-brand) 22%, var(--gu-elev));
}
.gu-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 500; line-height: 1.4; white-space: nowrap;
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
.gu-kpi, .gu-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 152px), 1fr));
  gap: var(--gu-gap-sm);
}
.gu-kpi-item {
  background: var(--gu-elev);
  border: 1px solid var(--gu-line);
  border-radius: 12px;
  padding: 14px 16px;
  min-width: 0;
}
.gu-kpi-value {
  display: block; font-size: 22px; font-weight: 500; line-height: 1.15;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
}
.gu-kpi-label { display: block; font-size: 12px; font-weight: 500; color: var(--gu-text-faint); margin-top: 4px; }
/* Tables: hairlines only, no zebra, always inside .gu-table-wrap. */
.gu-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: var(--gu-radius); }
.gu-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.gu-table th {
  text-align: left; font-size: 11px; font-weight: 500;
  color: var(--gu-text-faint); white-space: nowrap;
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
.gu-bar-value { flex: 0 0 auto; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
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
.gu-stage { position: relative; border-radius: 12px; overflow: hidden; background: var(--gu-fill); }
.gu-stage canvas { display: block; }
.gu-game-stage {
  position: relative; width: 100%; overflow: hidden; background: var(--gu-fill);
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.gu-game-stage canvas { display: block; width: 100%; height: 100%; }
.gu-canvas-interactive {
  touch-action: none; user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  cursor: grab;
}
.gu-canvas-interactive:active { cursor: grabbing; }
.gu-stage-hud {
  position: absolute; top: 10px; left: 10px; right: 10px; z-index: 2;
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 6px;
  pointer-events: none;
}
.gu-stage-hud > * { pointer-events: auto; max-width: 100%; }
.gu-hud-pill {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 3px 10px; border-radius: 999px;
  font-size: 11.5px; font-weight: 500; line-height: 1.4; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
  color: var(--gu-text);
  background: color-mix(in oklab, var(--gu-bg) 80%, transparent);
  border: 1px solid color-mix(in oklab, var(--gu-line) 85%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
/* Mobile & desktop game touch controls: glassmorphic >=44px targets, zero scroll/callout leak. */
.gu-touch-controls {
  position: absolute; left: 10px; right: 10px; bottom: 10px; z-index: 3;
  display: flex; align-items: flex-end; justify-content: space-between; gap: 10px;
  pointer-events: none;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.gu-touch-controls > * { pointer-events: auto; }
.gu-touch-bar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px;
  background: var(--gu-elev); border-top: 1px solid var(--gu-line);
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.gu-touch-group {
  display: inline-flex; align-items: center; gap: 8px; flex-wrap: nowrap;
}
.gu-touch-btn, .gu-touch-btn-primary {
  appearance: none; cursor: pointer;
  touch-action: none; user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-width: 48px; min-height: 48px; padding: 0 13px;
  font: inherit; font-size: 13px; font-weight: 500; line-height: 1; white-space: nowrap;
  color: var(--gu-text);
  background: color-mix(in oklab, var(--gu-bg) 74%, transparent);
  border: 1px solid color-mix(in oklab, var(--gu-text) 22%, transparent);
  border-radius: 14px;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 2px 8px oklch(0% 0 0 / 0.22);
  transition: transform 80ms ease, background 100ms ease, border-color 100ms ease;
}
.gu-touch-btn:active, .gu-touch-btn.is-active, .gu-touch-btn[aria-pressed="true"],
.gu-touch-btn-primary:active, .gu-touch-btn-primary.is-active, .gu-touch-btn-primary[aria-pressed="true"] {
  transform: scale(0.93);
  background: color-mix(in oklab, var(--gu-brand) 34%, var(--gu-bg));
  border-color: var(--gu-brand);
}
.gu-touch-btn-primary {
  background: color-mix(in oklab, var(--gu-brand) 28%, var(--gu-bg));
  border-color: color-mix(in oklab, var(--gu-brand) 70%, transparent);
}
.gu-touch-btn-primary:active, .gu-touch-btn-primary.is-active, .gu-touch-btn-primary[aria-pressed="true"] {
  background: color-mix(in oklab, var(--gu-brand) 52%, var(--gu-bg));
}
.gu-touch-btn-round {
  border-radius: 999px; width: 52px; height: 52px; min-width: 52px; min-height: 52px; padding: 0;
}
.gu-dpad {
  display: grid;
  grid-template-columns: repeat(3, 44px);
  grid-template-rows: repeat(3, 44px);
  gap: 4px;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.gu-dpad .gu-touch-btn, .gu-dpad .gu-touch-btn-primary {
  min-width: 44px; min-height: 44px; width: 44px; height: 44px;
  padding: 0; border-radius: 12px;
}
.gu-kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: 5px;
  font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px; font-weight: 500; line-height: 1;
  color: var(--gu-text-dim);
  background: var(--gu-elev);
  border: 1px solid var(--gu-line);
  box-shadow: inset 0 -1px 0 var(--gu-line);
}
.gu-callout {
  padding: 12px 14px; border-radius: var(--gu-radius-sm);
  background: var(--gu-fill);
  border-left: 2.5px solid var(--gu-brand);
  font-size: 12.5px; line-height: 1.5; color: var(--gu-text-dim);
}
.gu-root .leaflet-container { font: inherit; border-radius: 12px; background: var(--gu-fill); }
.gu-root .leaflet-control-attribution {
  font-size: 10px; line-height: 1.4; padding: 1px 6px;
  background: color-mix(in oklab, var(--gu-elev) 82%, transparent); color: var(--gu-text-faint);
}
.gu-root .leaflet-bar { border: 1px solid var(--gu-line); border-radius: 8px; overflow: hidden; box-shadow: var(--gu-shadow); }
.gu-root .leaflet-bar a { background: var(--gu-elev); color: var(--gu-text); border-bottom-color: var(--gu-line); }
/* Multi-column layouts (responsive auto-fit + explicit splits/grids). */
.gu-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--gu-gap);
  align-items: start;
}
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
.gu-grid-4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--gu-gap);
  align-items: start;
}
@media (max-width: 640px) {
  .gu-split { grid-template-columns: minmax(0, 1fr); }
  .gu-grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  :root { --gu-gap: 12px; }
  .gu-root { padding: 16px; }
  .gu-card { padding: 14px; }
  .gu-panel { padding: 12px; }
  .gu-grid-2, .gu-grid-3 { grid-template-columns: minmax(0, 1fr); }
  .gu-kpi, .gu-kpis { grid-template-columns: repeat(auto-fit, minmax(min(100%, 144px), 1fr)); }
  .gu-kpi-item { padding: 12px 14px; }
  .gu-kpi-value { font-size: 19px; }
  .gu-stage-hud { top: 8px; left: 8px; right: 8px; gap: 5px; }
  .gu-hud-pill { padding: 3px 8px; font-size: 11px; gap: 4px; }
  .gu-btn, .gu-btn-primary, .gu-btn-ghost { min-height: 36px; }
  .gu-btn-sm { min-height: 32px; }
  .gu-segmented .gu-btn, .gu-segmented button,
  .gu-tabs .gu-btn, .gu-tabs button { min-height: 32px; padding: 0 11px; }
  .gu-chip { min-height: 28px; padding: 4px 11px; }
  .gu-slider { height: 36px; }
}
@media (max-width: 480px) {
  /* Bars stack: label + value on one line, full-width track below. */
  .gu-bar { flex-wrap: wrap; row-gap: 4px; }
  .gu-bar-label { flex: 1 1 auto; }
  .gu-bar-track { order: 3; flex: 1 1 100%; }
  .gu-bar-value { margin-left: auto; }
}
@media (max-width: 420px) {
  .gu-root { padding: 14px; }
  .gu-title { font-size: 16.5px; }
  .gu-touch-controls { left: 8px; right: 8px; bottom: 8px; gap: 6px; }
  .gu-touch-btn, .gu-touch-btn-primary { min-width: 44px; min-height: 44px; font-size: 12.5px; padding: 0 10px; }
  .gu-touch-btn-round { width: 48px; height: 48px; min-width: 48px; min-height: 48px; }
  .gu-dpad { grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(3, 44px); gap: 3px; }
}
.gu-hidden { display: none !important; }
@media (hover: hover) and (pointer: fine) {
  *, *::before, *::after { --gu-scrollbar-thumb: transparent; --gu-sb-pad: 3px; }
  *:hover { --gu-scrollbar-thumb: color-mix(in oklab, var(--gu-text) 22%, transparent); }
  ::-webkit-scrollbar { width: 12px; height: 12px; }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner, ::-webkit-resizer { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background-color: var(--gu-scrollbar-thumb);
    border: var(--gu-sb-pad) solid transparent;
    border-radius: 9999px;
    background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover, ::-webkit-scrollbar-thumb:active {
    background-color: var(--gu-text-faint);
    --gu-sb-pad: 1px;
    border-width: 1px;
    background-clip: content-box;
  }
  @-moz-document url-prefix() {
    * { scrollbar-width: thin; scrollbar-color: transparent transparent; }
    *:hover { scrollbar-color: color-mix(in oklab, var(--gu-text) 22%, transparent) transparent; }
  }
}
@media (hover: none), (pointer: coarse) {
  ::-webkit-scrollbar { display: none; width: 0; height: 0; }
  * { scrollbar-width: none; -ms-overflow-style: none; }
}
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
  var __fullscreenListeners = [];
  var __isFullscreen = false;
  var __errorHandler = null;
  var __host = {
    sendPrompt: function (text) { if (typeof text === "string" && text.trim()) window.parent.postMessage({ __gu: "sendPrompt", text: String(text).slice(0, 4000) }, "*"); },
    prefillPrompt: function (text) { if (typeof text === "string" && text.trim()) window.parent.postMessage({ __gu: "prefillPrompt", text: String(text).slice(0, 4000) }, "*"); },
    openLink: function (url) { if (typeof url === "string") window.parent.postMessage({ __gu: "openLink", url: String(url).slice(0, 2048) }, "*"); },
    resize: function (height) { if (!__isFullscreen) window.parent.postMessage({ __gu: "resize", height: Number(height) }, "*"); },
    saveState: function (s) {
      try {
        var payload = s === undefined ? (window.__gu && window.__gu.state) : s;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
        var str = JSON.stringify(payload);
        if (typeof str !== "string" || str.length > 65536) return false;
        try {
          var copy = JSON.parse(str);
          if (window.__gu) window.__gu.state = copy;
        } catch {}
        try {
          window.parent.postMessage({ __gu: "state", state: str }, "*");
        } catch {}
        return true;
      } catch {
        return false;
      }
    }
  };
  window.indirectUi = Object.freeze(__host);
  var __lastHeight = 0;
  function __measure() {
    var root = document.querySelector(".gu-root") || document.body;
    return Math.ceil(root.getBoundingClientRect().height);
  }
  function __postHeight(height) {
    if (__isFullscreen) return height;
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
  function $onResize(fn) {
    if (typeof fn !== "function") return function () {};
    __resizers.push(fn);
    return function () {
      var idx = __resizers.indexOf(fn);
      if (idx >= 0) __resizers.splice(idx, 1);
    };
  }
  function $onFullscreen(fn) {
    if (typeof fn !== "function") return function () {};
    __fullscreenListeners.push(fn);
    return function () {
      var idx = __fullscreenListeners.indexOf(fn);
      if (idx >= 0) __fullscreenListeners.splice(idx, 1);
    };
  }
  function $onError(fn) { if (typeof fn === "function") __errorHandler = fn; }
  function fitCanvas(canvas, cssW, cssH) {
    if (!canvas) return { width: 0, height: 0, dpr: 1 };
    var dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    var rect = (!cssW || !cssH) && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    var w = Math.max(1, Math.round(cssW || (rect && rect.width) || canvas.clientWidth || canvas.width || 300));
    var h = Math.max(1, Math.round(cssH || (rect && rect.height) || canvas.clientHeight || canvas.height || 200));
    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    return { width: w, height: h, dpr: dpr };
  }
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
    onDestroy: $onDestroy, onResize: $onResize, onFullscreen: $onFullscreen, onError: $onError,
    fitCanvas: fitCanvas, isFullscreen: false,
    reportError: reportError, destroy: runDestroy,
    saveState: __host.saveState,
    error: null
  };
  // Keyboard & pointer ergonomics: track widget-owned keydown/keyup listeners
  // BEFORE widget code runs so Space/Arrow keys never scroll-chain into the
  // parent chat while playing a game, and clicking a canvas focuses it cleanly.
  var __keyListenerCount = 0;
  function __isTextInputControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!el.isContentEditable;
  }
  function __isNativeKeyControl(el) {
    if (__isTextInputControl(el)) return true;
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    return tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
  }
  function __isTouchGameButton(el) {
    return !!(el && el.nodeType === 1 && el.closest && el.closest(".gu-touch-btn,.gu-touch-btn-primary,.gu-touch-controls,.gu-dpad"));
  }
  function __hasReactKeyHandler(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.__guHasKey) return true;
      cur = cur.parentElement;
    }
    return false;
  }
  window.addEventListener("keydown", function (ev) {
    if (!ev || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var t = ev.target;
    if (ev.key === "Escape" && __isFullscreen && !__isNativeKeyControl(t)) {
      // Defer past widget-owned window keydown listeners (registered later)
      // so a game calling ev.preventDefault() on Escape to pause does not
      // accidentally exit fullscreen.
      var defer = typeof queueMicrotask === "function" ? queueMicrotask : function (fn) { Promise.resolve().then(fn); };
      defer(function () {
        if (!ev.defaultPrevented && __isFullscreen) {
          try { window.parent.postMessage({ __gu: "escape" }, "*"); } catch {}
        }
      });
      return;
    }
    var isSpace = ev.key === " ";
    var isArrow = ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowRight";
    if (!isSpace && !isArrow) return;
    if (__isTextInputControl(t)) return;
    if (isSpace && __isNativeKeyControl(t) && !__isTouchGameButton(t)) return;
    if (__keyListenerCount > 0 || __hasReactKeyHandler(t) || (t && t.tagName === "CANVAS")) {
      ev.preventDefault();
    }
  });
  document.addEventListener("pointerdown", function (ev) {
    // Always focus the widget frame on pointerdown even when a game button
    // (e.g. PLAY / FIRE) calls ev.preventDefault() in onPointerDown, so
    // subsequent keyboard controls target the game instead of scrolling chat.
    try { window.focus(); } catch {}
    var t = ev.target;
    if (!t || t.nodeType !== 1) return;
    if (__isNativeKeyControl(t) || (t.closest && t.closest("input,textarea,select,button,a,label,summary,[contenteditable]"))) return;
    var canvas = t.tagName === "CANVAS" ? t : (t.closest ? t.closest("canvas") : null);
    if (canvas) {
      if (canvas.tabIndex < 0 && (__keyListenerCount > 0 || __hasReactKeyHandler(canvas))) {
        canvas.setAttribute("tabindex", "0");
      }
      if (canvas.tabIndex >= 0 && typeof canvas.focus === "function") {
        try { canvas.focus({ preventScroll: true }); } catch {}
      }
    }
  }, true);
  function __wrapKeyListeners(target) {
    if (!target || typeof target.addEventListener !== "function") return;
    var origAdd = target.addEventListener;
    var origRemove = target.removeEventListener;
    target.addEventListener = function (type, listener) {
      if ((type === "keydown" || type === "keyup") && listener) __keyListenerCount++;
      return origAdd.apply(this, arguments);
    };
    target.removeEventListener = function (type, listener) {
      if ((type === "keydown" || type === "keyup") && listener) __keyListenerCount = Math.max(0, __keyListenerCount - 1);
      return origRemove.apply(this, arguments);
    };
  }
  __wrapKeyListeners(window);
  __wrapKeyListeners(document);
  // Sandboxed widget frames omit allow-pointer-lock and allow-fullscreen:
  // degrade requestPointerLock / exitPointerLock / requestFullscreen quietly
  // instead of throwing or emitting unhandled SecurityError rejections so
  // FPS drag-aim, touch pads and keyboard controls work cleanly everywhere.
  try {
    var __elProto = typeof Element !== "undefined" ? Element.prototype : null;
    if (__elProto) {
      var __origRpl = __elProto.requestPointerLock;
      __elProto.requestPointerLock = function () {
        if (typeof __origRpl === "function") {
          try {
            var res = __origRpl.apply(this, arguments);
            if (res && typeof res.catch === "function") {
              return res.catch(function () { return undefined; });
            }
            return res;
          } catch (_) {
            return Promise.resolve();
          }
        }
        return Promise.resolve();
      };
      var __origRfs = __elProto.requestFullscreen;
      if (typeof __origRfs === "function") {
        __elProto.requestFullscreen = function () {
          try {
            var res = __origRfs.apply(this, arguments);
            if (res && typeof res.catch === "function") {
              return res.catch(function () { return undefined; });
            }
            return res;
          } catch (_) {
            return Promise.resolve();
          }
        };
      }
    }
    if (document) {
      if (typeof document.exitPointerLock !== "function") {
        document.exitPointerLock = function () {};
      } else {
        var __origEpl = document.exitPointerLock;
        document.exitPointerLock = function () {
          try { return __origEpl.apply(this, arguments); } catch (_) { return undefined; }
        };
      }
    }
  } catch (_) {}
  // Suppress long-press context menus on mobile touch game controls and canvases.
  document.addEventListener("contextmenu", function (ev) {
    var t = ev.target;
    if (t && t.nodeType === 1 && t.closest && t.closest(".gu-touch-controls,.gu-touch-bar,.gu-touch-btn,.gu-touch-btn-primary,.gu-dpad,.gu-canvas-interactive")) {
      ev.preventDefault();
    }
  });
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
  // Receive live host theme/accent and fullscreen updates from the parent window.
  var __accents = { teal: 1, neutral: 1, violet: 1, blue: 1, green: 1, amber: 1, orange: 1, coral: 1, rose: 1 };
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.__gu === "theme") {
      if (d.theme === "dark" || d.theme === "light") {
        document.documentElement.setAttribute("data-theme", d.theme);
      }
      if (typeof d.accent === "string" && __accents[d.accent]) {
        if (d.accent === "teal") document.documentElement.removeAttribute("data-accent");
        else document.documentElement.setAttribute("data-accent", d.accent);
      }
      return;
    }
    if (d.__gu === "fullscreen") {
      var nextFs = !!d.expanded;
      if (nextFs === __isFullscreen) return;
      __isFullscreen = nextFs;
      window.__gu.isFullscreen = nextFs;
      if (nextFs) document.documentElement.setAttribute("data-fullscreen", "true");
      else document.documentElement.removeAttribute("data-fullscreen");
      for (var i = 0; i < __fullscreenListeners.length; i++) {
        try { __fullscreenListeners[i](nextFs); } catch (err) { reportError(err); }
      }
      try { window.dispatchEvent(new Event("resize")); } catch {}
      requestAnimationFrame(function () {
        try { window.dispatchEvent(new Event("resize")); } catch {}
        if (!nextFs) {
          __lastHeight = 0;
          __scheduleHeight();
        }
      });
    }
  });
  try { window.parent.postMessage({ __gu: "ready" }, "*"); } catch {}
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
  if (moduleUrls.libs.three) {
    imports["three/addons/controls/OrbitControls.js"] = moduleUrls.libs.three;
    imports["three/addons/controls/OrbitControls"] = moduleUrls.libs.three;
    imports["three/examples/jsm/controls/OrbitControls.js"] = moduleUrls.libs.three;
    imports["three/examples/jsm/controls/OrbitControls"] = moduleUrls.libs.three;
    imports["three/addons/environments/RoomEnvironment.js"] = moduleUrls.libs.three;
    imports["three/addons/environments/RoomEnvironment"] = moduleUrls.libs.three;
    imports["three/examples/jsm/environments/RoomEnvironment.js"] = moduleUrls.libs.three;
    imports["three/examples/jsm/environments/RoomEnvironment"] = moduleUrls.libs.three;
    imports["three/addons/geometries/RoundedBoxGeometry.js"] = moduleUrls.libs.three;
    imports["three/addons/geometries/RoundedBoxGeometry"] = moduleUrls.libs.three;
    imports["three/examples/jsm/geometries/RoundedBoxGeometry.js"] = moduleUrls.libs.three;
    imports["three/examples/jsm/geometries/RoundedBoxGeometry"] = moduleUrls.libs.three;
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
  /** Optional host accent (defaults to "teal" when omitted). */
  accent?: string;
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

const VALID_DOC_ACCENTS = new Set([
  "neutral",
  "violet",
  "blue",
  "green",
  "amber",
  "orange",
  "coral",
  "rose",
]);

/**
 * The final widget document. Served by /api/indirect-code/gen-ui/widgets/:id
 * with widgetCSP() as a response header (CSP meta is inert here — the header
 * always wins — but is kept as belt-and-braces for file:// or extension
 * contexts).
 */
export function buildWidgetDocument(params: WidgetDocParams): string {
  const accentAttr =
    params.accent && VALID_DOC_ACCENTS.has(params.accent) ? ` data-accent="${params.accent}"` : "";
  return `<!doctype html>
<html data-theme="${params.theme}"${accentAttr}><head><meta charset="utf-8">
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
