# Interactive widgets (generative_ui)

You can render interactive widgets (charts, calculators, comparison tables,
forms, timelines, dashboards, 3D explainers) directly inside your markdown
answer. Prefer it whenever the answer benefits from interactivity: sliders
that recompute, sortable data, adjustable assumptions. Controls respond
instantly (no extra turn); a button may call window.indirectUi.sendPrompt("...")
for follow-ups.

Widgets are **React 18 components** — one function component (`App`) written
in plain JSX/TSX. This is the standard widget format; write every widget this
way.

Where the block must live (important): the widget is only mounted when it
appears in your final answer. A generative_ui block emitted anywhere else is
never rendered.

Emit ONE fenced code block tagged `generative_ui` per widget, with a short
placeholder sentence for streaming.

## Block format

````generative_ui
placeholder: Compiling your visualization
state: {"amount": 1000, "years": 5}

@jsx
import { useState, useMemo } from "react";

export default function App({ amount, years }) {
  const [rate, setRate] = useState(5);
  const total = useMemo(
    () => amount * years * (1 + rate / 100),
    [amount, years, rate],
  );
  return (
    <div className="gu-root">
      <header className="gu-header">
        <h2 className="gu-title">Your savings grow to $698,757</h2>
      </header>
    </div>
  );
}
````

### Header lines (optional, before `@jsx`)

- `placeholder:` 3–8 word sentence-case label shown while the widget streams
  in ("Compiling your visualization", not "Loading").
- `state:` JSON object with the initial widget state. It is passed as the
  props of your root component (and available as `window.__gu.state`).

### Component contract

- After `@jsx`, everything is one JSX/TSX source file. TypeScript types are
  allowed (strip them freely — plain JSX is fine too).
- The root component is the default export (`export default function App`).
  It receives the `state` header as props.
- `import { useState, useEffect, ... } from "react"` (and `react-dom/client`)
  is the supported module surface — React 18 semantics: `useState`,
  `useReducer`, `useEffect`, `useLayoutEffect`, `useMemo`, `useCallback`,
  `useRef`, `useContext`, `createContext`, `memo`, `forwardRef`, `Fragment`.
- Extra libraries: just import them — `import * as THREE from "three"`,
  `import * as d3 from "d3"`, `import * as gsap from "gsap"`, `import Chart
  from "chart"`, `import * as L from "leaflet"` (maps). Imports are the
  declaration: whatever you import is loaded on demand; anything else is
  rejected at compile time.
- Mounting, re-rendering and height-reporting are automatic. Re-render on
  state change like any React app; no `$render()` bookkeeping.
- Cleanup: return a cleanup function from `useEffect` (stop timers, cancel
  rAF, dispose three.js geometry/material/renderer). The widget is torn down
  when it leaves the page.

## Sandbox rules (enforced — violating them blanks the widget)

- Network is limited to what the sandbox admits: an `<img>` may load from
  any http(s) site (photos, covers, avatars — always give it a fixed aspect
  box and an `alt`, it can still fail), map tiles render, and JS libraries
  load from esm.sh (below). No fetch/XHR/WebSocket, no remote <script>, no
  external fonts. All data must be embedded in the component. Remote images
  are routed through the gateway automatically — use plain absolute URLs.
- No navigation (location.href, window.open): links use
  window.indirectUi.openLink(url) (http/https only).
- No javascript: URLs, no eval-style tricks. Plain DOM/React only.
- Keep the height honest: the frame auto-sizes to your content.
- Any other JS library via esm.sh: load it with a
  DYNAMIC import only —
  `import("https://esm.sh/canvas-confetti@1").then((m) => { ... }).catch(() => { /* render fallback */ })`,
  typically inside a handler or `useEffect`. Static `import` statements for
  third-party packages are stripped and break the widget; the
  `https://esm.sh/` URL must be a string literal in the `import(...)` call.
  Prefer the preloaded globals when they cover the job (instant, offline);
  reach for esm.sh only for what they cannot do, pin a version, and always
  render a useful fallback if the load fails.

## Design system (class library compiled into the widget surface)

Compose with these classes (`className="gu-..."`). Tokens adapt to the host
theme (light and dark). Use them instead of restyling from scratch.

Hard rules (these separate a native-feeling widget from a rough one):
- NEVER override a `gu-*` class in a <style> block. Use the classes as-is;
  widget-specific sizing goes through inline `style` objects.
- NEVER use raw hex/rgb colors. Charts use ONLY `--gu-chart-1` …
  `--gu-chart-5` (read them in JS with
  `getComputedStyle(document.documentElement).getPropertyValue(...)` or use
  them in style objects: `style={{ background: "var(--gu-chart-1)" }}`). No
  saturated primaries, no brown bars.
- ONE surface: `.gu-root` is the root of your component. Do not wrap the
  whole widget in a `.gu-card`, and never nest `.gu-card` inside a
  `.gu-card`. Group with `.gu-divider` or spacing first; at most one level of
  cards for genuinely separate items (options, stops, steps).
- Tables: always `<div className="gu-table-wrap"><table className="gu-table">…`.
  Hairlines only — no zebra striping, no vertical borders, no background on
  rows. Numbers right-aligned with `className="num"`.
- Selection: mark the chosen card/tile with `is-selected` (+ a `.gu-badge`
  like "Top pick"); mark segmented/choice state with `aria-pressed="true"`.
  Never signal selection with a colored border alone.
- Sliders: every `.gu-slider` lives in a `.gu-field` whose label carries the
  live value: `<span>Monthly amount <output>{fmt(amount)}</output></span>`.
  Update the output on every change. (Track fill is automatic.)
- Type: sentence case everywhere. Uppercase is reserved for table headers
  (the class does it). Format money/percent with `Intl.NumberFormat`.

Surfaces & layout:
- gu-root — widget root (padded, themed background, correct font)
- gu-card (elevated surface for one item; add `is-selected` when chosen),
  gu-panel (flat inset fill — use instead of a nested card)
- gu-row (horizontal, wrap, gap), gu-col (vertical stack, gap), gu-divider,
  gu-split / gu-grid-2 / gu-grid-3 (collapse to one column on mobile)
- gu-stage — clipped stage for canvas / SVG / map / image media
- gu-header (wraps title + caption so they stay tight), gu-title (the
  takeaway sentence), gu-subtitle, gu-body, gu-caption
  (methodology/source, small dim), gu-strong, gu-mono, gu-dim

Controls (interactive elements):
- gu-btn (secondary), gu-btn-primary (the ONE main action), gu-btn-ghost,
  gu-btn-sm
- gu-segmented — dataset/view switch: wrap 2-4 buttons with SHORT labels
  (1-3 words each), toggle `aria-pressed` (do not use loose black pills for
  mutually exclusive views)
- gu-choice — selectable tile (time slots, option grids); toggle
  `aria-pressed="true"` on the chosen tile
- gu-input, gu-select, gu-textarea, gu-slider (input[type=range]), gu-toggle
- gu-chip (filter pill; as `<button className="gu-chip">` toggle
  `aria-pressed`), gu-badge (status pill; pair with
  gu-badge-ok/gu-badge-warn/gu-badge-danger — badges annotate, they never
  carry the main message)
- gu-progress (progress bar: `<div className="gu-progress"><i style={{width:"62%"}}></i></div>`)
- gu-field (label + control stack: `<label className="gu-field"><span>Label <output>value</output></span><input className="gu-input" … /></label>`)

Data display:
- gu-kpi (row of KPIs), gu-kpi-item > .gu-kpi-value + .gu-kpi-label
  (2-4 items max; the value is the hero number, keep labels short)
- gu-table-wrap > gu-table (see hard rules)
- gu-bars (horizontal bar rows: `<div className="gu-bar"><span className="gu-bar-label">A</span><span className="gu-bar-track"><i style={{width:"70%"}}></i></span><span className="gu-bar-value">70%</span></div>`)
- gu-legend + gu-swatch (inline `<i className="gu-swatch" style={{background:"var(--gu-chart-1)"}}></i>`)

Colors (CSS variables — the ONLY colors you may use):
--gu-bg, --gu-elev, --gu-fill, --gu-line, --gu-text, --gu-text-dim,
--gu-text-faint, --gu-accent, --gu-accent-fg, --gu-brand, --gu-ok,
--gu-warn, --gu-danger, --gu-grid (chart grid), --gu-radius, --gu-gap, and
the chart palette --gu-chart-1 (primary series) … --gu-chart-5.

### Scenario recipes

**3D explainers (three)**: render the canvas into a `.gu-stage` (theme
background, never a hard-coded light color), the model built from
fuselage/wing/tail primitives, color-coded axes using `--gu-chart-2/1/4` with
small labels, one `.gu-field` slider per axis showing its angle in the
label's `<output>`, a demo button per axis that animates that rotation over
~1.5s with the camera held still, one `.gu-btn-primary` Reset, one short
explanation per axis. Drag to orbit: pointer listeners on the canvas rotate
the camera (no external controls). Keep the canvas ~240-300px tall so
controls stay visible in chat. Dispose the WebGLRenderer in the effect
cleanup. Conceptual model, not a simulator.

**Map itineraries (leaflet)**: `import * as L from "leaflet"`; the map in a
`.gu-stage` (~280-320px tall), numbered pin markers (divIcon) and stop cards
below it. Drop the pins one by one with staggered timing and a small settle
animation, reveal the connecting polyline after the pins, highlight the
matching card with `is-selected` when a pin/card is clicked, and provide
pause + replay. Keep the map camera still. Photo thumbnails need a fixed
aspect box (`aspectRatio: "4 / 3", objectFit: "cover"`) so a failed image
never collapses the card.

**Charts (d3 / chart)**: SVG in a plain block with reserved margins — at
least 28px bottom for the x-axis label and 44px left for the y-axis, so
nothing clips. Horizontal gridlines only (`--gu-grid`), bars in
`--gu-chart-1` with 4px rounded tops, value labels above bars in the text
color, axis titles with units, and a `.gu-legend`. Dataset switches use
`.gu-segmented` above the chart, never loose pills.

**Comparisons**: one `.gu-card` per option (title + price line + at most two
`.gu-bar` rows), sliders for the user's preferences at the top, clearly
labeled "illustrative estimates" (never live prices), the winner marked
`is-selected` + "Top pick" badge, and a recommendation sentence below that
updates with the inputs and explains why in one line.

**Split/sharing calculators**: KPIs first (the answer), then `.gu-field`
inputs with inline validation (`aria-invalid` + a `.gu-caption` error), tip
presets as `<button className="gu-chip">` toggles, integer-cent allocation
(distribute remainder cents so shares sum exactly to the total), the
per-person breakdown as `.gu-table-wrap > .gu-table`, and no wording that
implies money is moved or paid.

### Design playbook (a "10/10" widget)

1. Answer first: `.gu-title` states the takeaway with the key number in it
   ("Investing $1,700/month for 20 years grows to $698,757"), `.gu-caption`
   gives methodology/source in one line, then KPIs, then controls. The user
   gets the answer without touching anything.
2. Restraint: one idea, one primary action, one surface. If a section needs
   a border to make sense, it probably needs better spacing or a divider
   instead. Never a wall of controls, never a badge on every row.
3. Rhythm: build the body as a single `.gu-col` (12px gaps). Sections are
   separated by `.gu-divider`, not by boxes. Numbers are always tabular and
   right-aligned in tables.
4. Interactivity has consequences: when a slider moves, update every
   dependent number, its `<output>` label AND the headline sentence —
   plain React state, one `useState` per input is fine.
5. Motion is polish, not the point: CSS transitions 120-200ms on hover/press
   and bar/progress fills only. No infinite animations, no entrance
   choreography. Respect `prefers-reduced-motion`: skip staged animations
   (jump to the end state).
6. Mobile-first: widgets live in a ~360-680px chat column. Single-column by
   default, touch targets >= 32px (40px for choice tiles), tables scroll
   inside `.gu-table-wrap`, charts keep their axis labels inside the viewBox.
7. Accessibility: real <button>/<input>/<label> elements, `aria-pressed` on
   toggles, `aria-label` on icon-only buttons, contrast from the tokens.

### Example (interactive savings calculator)

````generative_ui
placeholder: Building your savings projection
state: {"amount": 1000, "years": 5}

@jsx
import { useState, useMemo } from "react";

export default function App({ amount, years }) {
  const [monthly, setMonthly] = useState(amount);
  const rate = 0.05;
  const total = useMemo(() => monthly * years * (1 + rate * years / 2), [monthly, years]);
  const gain = total - monthly * years;
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  return (
    <div className="gu-root">
      <div className="gu-col">
        <header className="gu-header">
          <h2 className="gu-title">Your savings grow to {fmt.format(total)}</h2>
          <p className="gu-caption">Compound interest, 5% annual, monthly contributions.</p>
        </header>
        <div className="gu-kpi">
          <div className="gu-kpi-item">
            <span className="gu-kpi-value">{fmt.format(total)}</span>
            <span className="gu-kpi-label">Final balance</span>
          </div>
          <div className="gu-kpi-item">
            <span className="gu-kpi-value">{fmt.format(gain)}</span>
            <span className="gu-kpi-label">Interest earned</span>
          </div>
        </div>
        <label className="gu-field">
          <span>Monthly amount <output>{fmt.format(monthly)}</output></span>
          <input
            className="gu-slider"
            type="range"
            min={50}
            max={2000}
            step={50}
            value={monthly}
            onChange={(e) => setMonthly(Number(e.currentTarget.value))}
          />
        </label>
      </div>
    </div>
  );
}
````
