---
name: generative_ui
description: Interactive generative-UI widgets (charts, calculators, games) design system.
usable: never
tools:
  permissions:
    widget_set: yolo
    widget_list: yolo
    widget_lint: yolo
    widget_read: yolo
    widget_edit: yolo
---
# Interactive widgets (generative_ui)

Render interactive widgets (charts, calculators, comparison tables, forms,
timelines, dashboards, 2D/3D physics simulations, explainers, games) directly
inside your markdown answer whenever interactivity adds value: sliders that
recompute, sortable data, live simulations, or adjustable assumptions.
Controls respond instantly without an extra turn; buttons may call
`window.indirectUi.sendPrompt("...")` for follow-ups.

**Widgets live in the session's widget store, not in the transcript.** You
store a widget's TSX source with the `widget_*` tools (their descriptions
carry the full contract), and your markdown answer mounts it with a
header-only fence that links the stored widget.

## Fence format (in your markdown answer)

Widgets are only mounted when emitted in your **final answer** (blocks
emitted in thoughts or intermediate steps are never rendered). Emit **ONE**
fenced code block tagged `generative_ui` per widget. The fence has **header
lines only — no body**:

- `widget_id:` (required) — the id the widget source was stored under with
  `widget_set`. This is the link: the fence renders the stored source for
  that widget.
- `placeholder:` — 3–8 word sentence-case label shown while loading (e.g.
  `"Building your savings projection"`, never `"Loading"`).
- `state:` — JSON object: the widget's default state, passed as props to
  `App` (and available at `window.__gu.state`). The user's saved state for the
  widget wins over this default. See "Widget state" below for how to seed,
  update and persist it.

````generative_ui
placeholder: Building your savings projection
state: {"amount": 1000, "years": 5}
widget_id: savings
````

Workflow: store the source with `widget_set` (verify with `widget_lint` when
in doubt), then link it with `widget_id:` in the fence. To change a widget
later, edit its stored source with `widget_edit` (targeted replacements) —
avoid rewriting the whole source from scratch with `widget_set`; only do that
when the changes are too tangled to express as edits. The fence stays the
same. Only the LAST fence for a given `widget_id:` mounts live (earlier
duplicates stay unloaded), so prefer one fence per widget.

Unit-testing the widget (recommended for anything with logic): the module
may export MORE than the default `App` — named helpers, pure functions,
reducers, formatters, even small components. `widget_lint` takes an optional
`test` argument: test code (TSX) that imports the widget with
`import { helper } from "widget"`, calls it and throws on a wrong result — a
throw fails the lint, so bugs surface before the widget is shown. Keep the
logic worth testing in exported functions (instead of burying everything
inside `App`) and pass a small test alongside the source, e.g. the `test`
argument of `widget_lint`:

```
test = "import { computeTip } from 'widget';
const s = computeTip({ bill: 100, pct: 15 });
if (s.tip !== 15 || s.total !== 115) throw new Error('bad split: ' + JSON.stringify(s));"
```

Tests run in the same sandbox as the widget (no network, no escape); assert
on exported logic and on a mounted component's props/behavior, not on DOM
layout.

## Widget state: seed from props, persist with `saveState`

The `state:` header is the widget's INITIAL state only: it arrives as the
props of `App` (the user's saved state wins over the fence default), so
seeding `useState`/`useReducer` from the props is all the restore logic a
widget needs. Keep live state in the component as usual — and when the user
changes something worth keeping (slider moved, option picked, game
progress), persist it with `window.indirectUi.saveState(snapshot)` (a plain
JSON object, capped at 20 KB; call it on discrete events, never per frame or
per render). `localStorage` and other storage APIs do NOT work in the
sandbox — `saveState` is the only way to keep state. Saved state lives per
session + widget id and comes back as props on the next mount (session
return, reload, reactivation).

## Component contract & sandbox rules (enforced — violations blank the widget)

* **Lifecycle & 60fps loops:** Mounting, state re-rendering, and iframe height
auto-sizing are automatic (no manual `$render()` bookkeeping). Always return
a cleanup function from `useEffect` to clear timers, cancel
`requestAnimationFrame`, clear physics engines, and dispose WebGL/Three.js
resources when the widget unmounts. Never call React `setState` every frame
inside a `requestAnimationFrame` loop — keep high-frequency simulation/game
state in `useRef` or the `useEffect` closure, and update React state only on
discrete events or throttled intervals.
* **Built-in static imports (instant, offline):**
* `import { useState, useReducer, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useContext, createContext, memo, forwardRef, Fragment } from "react"` (and `"react-dom/client"`)
* `import * as THREE from "three"` (3D rendering)
* `import * as CANNON from "cannon-es"` (3D rigid-body physics, pairs with `three`)
* `import Matter from "matter-js"` (2D rigid-body physics, springs, collisions, gravity)
* `import * as d3 from "d3"` (data visualization & math scales)
* `import * as gsap from "gsap"` (tweening & timeline animations)
* `import Chart from "chart"` (Chart.js)
* `import * as L from "leaflet"` (interactive maps)
Static `import` statements for any other package are rejected/stripped at
compile time and break the widget.


* **External libraries via `esm.sh` (dynamic import ONLY):** Prefer built-in
imports above. If an external package is strictly needed, load it via
dynamic `import()` with a string-literal URL, pinned version, and fallback
inside an event handler or `useEffect`:
`import("https://esm.sh/canvas-confetti@1").then((m) => { ... }).catch(() => { /* fallback */ })`
* **Network & media:** No `fetch`, `XHR`, `WebSocket`, remote `<script>`, or
external fonts (system fonts only). Embed all data directly in the component.
`<img>` tags may load any `http(s)` URL (routed through the gateway
automatically — use plain absolute URLs, always include `alt` and a fixed
aspect box like `aspectRatio: "4 / 3", objectFit: "cover"` so failed loads
never collapse layout). Map tiles render normally.
* **Navigation & security:** No `location.href` or `window.open` — use
`window.indirectUi.openLink(url)` (`http`/`https` only). No `javascript:`
URLs, `eval`, `Function`, or HTML-injection sinks.

## Styling scope (what is enforced where)

1. **Widget UI (all non-game HTML/SVG chrome):** Must strictly follow the
Design System below. Use `gu-*` classes as-is (NEVER override them in a
`<style>` block; use inline `style` objects for custom sizing) and ONLY use
`--gu-*` CSS color variables (NEVER raw hex/rgb colors).
2. **Inside a `<canvas>` (2D, WebGL/3D, physics scenes, shaders, sprite art):**
Any color (hex, rgb, gradients, full palettes) is allowed in both widgets
and games.
3. **Games:** Exempt from all Design System (`gu-*`) and color rules. See the
**Games** section below.

## Design system & playbook (for Widget UI)

### Core rules for a "10/10" widget

1. **Answer first:** `.gu-title` states the takeaway with the key number in it
(e.g., *"Investing $1,700/month for 20 years grows to $698,757"*),
`.gu-caption` gives methodology/source in one line, followed by KPIs, then
controls. The user gets the answer before touching anything.
2. **One surface & restraint:** `.gu-root` is the component root. Never wrap
the whole widget in `.gu-card`, and never nest `.gu-card` inside `.gu-card`.
Build the body as a single `.gu-col` (12px gaps) and separate sections with
`.gu-divider` or `.gu-panel` (flat inset fill). Use at most one level of
`.gu-card` for genuinely separate items (options, stops, steps). One idea,
one primary action (`.gu-btn-primary`), no wall of controls, no badge on
every row.
3. **Live consequences:** When a slider or input changes, update every
dependent number, its `<output>` label, AND the `.gu-title` headline. Every
`.gu-slider` must live inside a `.gu-field` whose label displays the live
value: `<span>Monthly amount <output>{fmt(amount)}</output></span>` (track
fill is automatic).
4. **Tables:** Always wrap as `<div className="gu-table-wrap"><table className="gu-table">…`.
Hairlines only — no zebra striping, vertical borders, or row backgrounds.
Right-align tabular numbers with `className="num"`.
5. **Selection & accessibility:** Mark selected cards with `is-selected` + a
`.gu-badge` (e.g., `"Top pick"`), never a colored border alone. Use real
`<button>`, `<input>`, `<label>` elements, `aria-pressed="true"` on active
toggles/segments/choices, and `aria-label` on icon-only buttons.
6. **Typography:** Sentence case everywhere (uppercase is applied automatically
to table headers). Format money and percentages with `Intl.NumberFormat`.
7. **Motion:** Keep CSS transitions to `120–200ms` on hover/press and
bar/progress fills. Avoid decorative UI entrance choreography (physics
simulations, 3D demos, and map pin animations are allowed, but must
respect `prefers-reduced-motion`).
8. **Mobile-first (`~360–680px` width):** Single-column by default; nothing may
require hover or a keyboard. Touch targets `>= 32px` (`>= 40px` for
`.gu-choice` tiles and game controls). Keep chart axis labels inside the
SVG `viewBox`.

### Class & token reference

**Surfaces & layout:**

* `gu-root` — widget root (padded, themed background, correct font)
* `gu-card` — elevated surface for one item (add `is-selected` when chosen)
* `gu-panel` — flat inset fill (use instead of a nested card)
* `gu-row` (horizontal wrap, gap), `gu-col` (vertical stack, 12px gap), `gu-divider`
* `gu-split`, `gu-grid-2`, `gu-grid-3` — responsive grids (collapse to 1 column on mobile)
* `gu-stage` — clipped container for `<canvas>`, `<svg>`, map, or media
* `gu-header` (wraps title + caption tightly), `gu-title`, `gu-subtitle`, `gu-body`, `gu-caption` (methodology/source, small dim), `gu-strong`, `gu-mono`, `gu-dim`

**Controls:**

* `gu-btn` (secondary), `gu-btn-primary` (the ONE main action), `gu-btn-ghost`, `gu-btn-sm`
* `gu-segmented` — dataset/view switch: wrap 2–4 buttons with short labels (1–3 words), toggle `aria-pressed` (never use loose pills for mutually exclusive views)
* `gu-choice` — selectable tile (time slots, option grids); toggle `aria-pressed="true"`
* `gu-input`, `gu-select`, `gu-textarea`, `gu-slider` (`input[type=range]`), `gu-toggle`
* `gu-chip` — filter pill (`<button className="gu-chip">` with `aria-pressed`)
* `gu-badge` — status annotation pill (pair with `gu-badge-ok`, `gu-badge-warn`, `gu-badge-danger`; never use for the main message)
* `gu-progress` — `<div className="gu-progress"><i style={{width:"62%"}}></i></div>`
* `gu-field` — `<label className="gu-field"><span>Label <output>value</output></span><input … /></label>`

**Data display:**

* `gu-kpi` > `gu-kpi-item` > `.gu-kpi-value` + `.gu-kpi-label` (2–4 items max; value is the hero number, keep labels short)
* `gu-table-wrap` > `gu-table` (with `className="num"` on numeric cells)
* `gu-bars` > `gu-bar` — `<div className="gu-bar"><span className="gu-bar-label">A</span><span className="gu-bar-track"><i style={{width:"70%"}}></i></span><span className="gu-bar-value">70%</span></div>`
* `gu-legend` + `gu-swatch` — `<i className="gu-swatch" style={{background:"var(--gu-chart-1)"}}></i>`

**CSS tokens (only colors allowed in Widget UI and SVG charts):**

* Surfaces & text: `--gu-bg`, `--gu-elev`, `--gu-fill`, `--gu-line`, `--gu-text`, `--gu-text-dim`, `--gu-text-faint`
* Semantic & layout: `--gu-accent`, `--gu-accent-fg`, `--gu-brand`, `--gu-ok`, `--gu-warn`, `--gu-danger`, `--gu-grid`, `--gu-radius`, `--gu-gap`
* Chart palette: `--gu-chart-1` (primary series) through `--gu-chart-5`. Read in JS via `getComputedStyle(document.documentElement).getPropertyValue("--gu-chart-1")` or use in inline styles: `style={{ background: "var(--gu-chart-1)" }}`. No saturated primaries or brown bars.

## Scenario recipes

* **Charts (`d3` / `chart`):** Render SVG in a plain block with reserved
margins (`>= 28px` bottom for x-axis labels, `>= 44px` left for y-axis) so
nothing clips. Horizontal gridlines only (`--gu-grid`), bars in
`--gu-chart-1` with `4px` rounded tops, value labels above bars in text
color, axis titles with units, and a `.gu-legend`. Use `.gu-segmented` above
the chart for dataset switches.
* **Comparisons:** Sliders for user preferences at the top, clearly labeled
*"illustrative estimates"* (never live prices). One `.gu-card` per option
(title + price line + at most two `.gu-bar` rows), winner marked with
`is-selected` + `"Top pick"` `.gu-badge`, and a reactive one-line
recommendation sentence below explaining why.
* **Split/sharing calculators:** KPIs first (the answer), then `.gu-field`
inputs with inline validation (`aria-invalid` + `.gu-caption` error), tip
presets as `<button className="gu-chip">` toggles, integer-cent allocation
(distribute remainder cents so shares sum exactly to the total), per-person
breakdown in `.gu-table-wrap > .gu-table`, and no wording that implies real
money is moved or paid.
* **3D explainers & 2D/3D physics simulations (`three`, `cannon-es`, `matter-js`):**
Render the `<canvas>` (`~240–300px` tall so controls stay visible) inside
`.gu-stage` (keep theme background, never hard-code a light background).
* *For 3D conceptual explainers (`three`):* Assemble models from primitive
geometries with color-coded axes (`--gu-chart-2`, `--gu-chart-1`,
`--gu-chart-4`) and small labels. Include one `.gu-field` slider per axis
(with angle in `<output>`), a demo button per axis that animates rotation
over `~1.5s` while holding the camera still, one `.gu-btn-primary` Reset
button, and a short explanation per axis. Implement drag-to-orbit via
pointer listeners on the canvas.
* *For 2D physics (`matter-js`):* Step `Matter.Engine.update(engine, dtMs)`
inside `requestAnimationFrame` (clamping `dtMs <= 33`) and draw bodies on a
custom 2D `<canvas>` (or use `Matter.Render` with `wireframes: false, background: "transparent"`).
* *For 3D physics (`three` + `cannon-es`):* Step `world.step(1 / 60, Math.min(dtSec, 0.1), 3)`
each frame and sync meshes via `mesh.position.copy(body.position)` and
`mesh.quaternion.copy(body.quaternion)`.
* Always expose key parameters (gravity, mass, angle, restitution) as
`.gu-slider` controls + a Reset/Replay button, and clean up engines,
renderers, geometries, and materials on unmount.


* **Map itineraries (`leaflet`):** Render map (`~280–320px` tall) inside
`.gu-stage` with numbered pin markers (`divIcon`) and stop `.gu-card` items
below. Drop pins sequentially with staggered timing and a subtle settle
animation, reveal the connecting polyline afterward, highlight the matching
card with `is-selected` when a pin/card is clicked, and provide pause +
replay controls. Keep the map camera still. Give photo thumbnails a fixed
aspect box (`aspectRatio: "4 / 3", objectFit: "cover"`).

## Games (exempt from Design System — build freely)

A game is not a standard UI widget: drop the `gu-*` class library and build
the entire experience in JSX with custom `<style>` blocks, custom classes, and
whatever palette/shapes the artwork needs (system fonts only). **Make the outer
UI look like the hardware the game came from:**

* **Hardware shell:** Frame the canvas in JSX/CSS to match its era — a Game Boy
gets a molded plastic shell with bezel, power LED, speaker holes, D-pad, and
A/B buttons; an arcade game gets a cabinet bezel and marquee; a DOS/Flash
game gets a CRT monitor; a mobile classic gets a phone frame.
* **Physics & rendering choice:** Use plain 2D `<canvas>` for grid/arcade
classics (Snake, Pong, Pac-Man, Space Invaders); use `matter-js` + 2D
`<canvas>` for 2D physics games (Pinball, Suika/drop-merge, Angry Birds,
ragdolls); use `three` (+ `cannon-es` when rigid-body collisions are needed)
for 3D games. Clamp frame delta (`Math.min(dt, 0.1)`) so tab-switching never
breaks collisions.
* **Real controls:** On-screen D-pad/buttons (`>= 40px` touch targets) must
drive the game via pointer/touch events; desktop keyboard controls
(arrows/WASD/space) are an optional addition, never the only input.
* **Native HUD:** Display score, lives, and level inside the hardware shell
(marquee, status bar, secondary screen) rather than standard widget chrome.
* **Responsive scaling:** Scale down cleanly to `~360px` width (place controls
below the screen on narrow viewports). Use CSS (`width: 100%` +
`aspect-ratio`) over a fixed logical canvas resolution so game logic never
depends on viewport size. Use `image-rendering: pixelated` for pixel art.
* **Sandbox still applies:** No network requests, navigation, `eval`/`Function`,
or HTML-injection sinks. Web Audio, `requestAnimationFrame`, and custom CSS
are fully allowed.
