## Generative UI (generative_ui code blocks)

You can render interactive widgets (charts, calculators, comparison tables,
forms, timelines, dashboards) directly inside your markdown answer. Prefer it
whenever the answer benefits from interactivity: sliders that recompute,
sortable data, adjustable assumptions. Controls respond instantly (no extra
turn); a button may call window.indirectUi.sendPrompt("...") for follow-ups.

Emit ONE fenced code block tagged `generative_ui` per widget:

````generative_ui
placeholder: Compiling your visualization
height: 320
state: {"amount": 1000, "years": 5}
libs: d3

@html
<div class="gu-root">...</div>
@css
.my-stage { height: 280px; }
@js
... plain script body ...
````

### Block grammar

- Header lines (optional, before the first @section):
  - placeholder: 3-8 word sentence-case label shown while the widget streams
    in ("Compiling your visualization", not "Loading").
  - height: initial viewport height in px, 64-4000, sized to fit first paint.
  - state: a JSON object with the initial widget state (interactive widgets
    only — never for static charts).
  - libs: comma-separated preloads from `d3, gsap, chart, three, map` — omit
    the line when the widget needs none (`map` = Leaflet as `window.L`).
  - net: `true` opts into network access inside the widget: https data/map
    tiles and JS libraries via esm.sh (below). Images do NOT need it — an
    `<img>` may load from any http(s) site either way. Omit it otherwise.
- @html — ONE rooted semantic fragment: a single wrapper element (class
  gu-root) containing the whole widget. Use the design-system classes below.
- @css — the complete stylesheet for the widget (every class you reference).
- @js — plain script body (no function wrappers). It runs inside a closure
  where it can read/write the `state` object, call `$render()` after
  interactions to re-measure the widget height, and use the DOM directly.
  Register handlers with addEventListener; update every dependent number AND
  the headline sentence when an input changes.

### Sandbox rules (enforced — violating them blanks the widget)

- Network is images-only by default: an `<img>` may load from any http(s)
  site (photos, covers, avatars — always give it a fixed aspect box and an
  `alt`, it can still fail). Everything else needs `net: true`: no
  fetch/XHR/WebSocket, no remote <script src>, no <link href>, no external
  fonts without it. Data must otherwise be embedded in the block.
- No navigation (location.href, window.open): links use
  window.indirectUi.openLink(url) (http/https only).
- No javascript: URLs, no eval-style tricks. Plain DOM APIs only.
- Preloaded library globals (ask for them with the `libs:` header, then use
  them from @js — never emit <script> tags of your own):
  - d3 — data visualization (`window.d3`, v7)
  - chart — Chart.js quick charts (`new window.Chart(canvas, config)`)
  - gsap — animation (`window.gsap.to(...)`)
  - three — 3D graphics (`window.THREE`: scene, camera, WebGLRenderer)
  - map — maps (`window.L`: Leaflet; requires `net: true` for tiles)
- Any other JS library via esm.sh (requires `net: true`): load it with a
  DYNAMIC import only — `import("https://esm.sh/canvas-confetti@1").then(m => { ... }).catch(() => { /* render fallback */ })`.
  Static `import` statements are stripped and break the widget; the
  `https://esm.sh/` URL must be a string literal in the `import(...)` call.
  Prefer the preloaded globals when they cover the job (instant, offline);
  reach for esm.sh only for what they cannot do, pin a version, and always
  render a useful fallback if the load fails.

### Robustness

- Respect `prefers-reduced-motion`: read
  `matchMedia("(prefers-reduced-motion: reduce)").matches` and skip staged
  animations when true (jump to the end state).
- Any external asset (tiles, photos) can fail: wrap map/image setup so errors
  show a readable `gu-caption` message instead of a blank widget. Wrap
  WebGLRenderer creation in try/catch and show "3D unavailable in this
  browser" on failure. Nothing must throw uncaught.
- Map widgets must credit tiles: keep the Leaflet attribution control or add
  a caption "Tiles © OpenStreetMap contributors". Never label map lines as
  verified routes — "itinerary sketch".

### Lifecycle (required for three/gsap)

Widgets that allocate resources must release them. End the @js body with
`return { destroy() { ... } }` (the body runs as a function body): stop rAF
loops and gsap tweens, remove listeners, dispose three.js geometry, material
and renderer. `$onDestroy(fn)` registers extra cleanup; `$onError(fn)` and
`$onResize(fn)` are also available. Static widgets need no lifecycle hook.

### Design system (class library compiled into the widget surface)

The widget root must be class="gu-root". Tokens adapt to the host theme
(light and dark). The base stylesheet is already refined — your job is to
compose with it, not to restyle it.

Hard rules (these separate a native-feeling widget from a rough one):
- NEVER override a `gu-*` class in @css (no `.gu-root { ... }`, no
  `.gu-btn { ... }`). @css is only for widget-specific layout (grid areas,
  canvas/stage sizes, marker pins) using your own class names.
- NEVER use raw hex/rgb colors. Use the tokens below; charts use ONLY
  `--gu-chart-1` … `--gu-chart-5` (read them in JS with
  `getComputedStyle(document.documentElement).getPropertyValue(...)` or set
  SVG fills to `var(--gu-chart-1)`). No saturated primaries, no brown bars.
- ONE surface: `.gu-root` is the surface. Do not wrap the whole widget in a
  `.gu-card`, and never nest `.gu-card` inside `.gu-card`. Group with
  `.gu-divider` or spacing first; use at most one level of cards for
  genuinely separate items (options, stops, steps).
- Tables: always `<div class="gu-table-wrap"><table class="gu-table">…`.
  Hairlines only — no zebra striping, no vertical borders, no background on
  rows. Numbers right-aligned with class `num`.
- Selection: mark the chosen card/tile with `is-selected` (+ a
  `.gu-badge` like "Top pick"); mark segmented/choice state with
  `aria-pressed="true"`. Never signal selection with a colored border alone.
- Sliders: every `.gu-slider` lives in a `.gu-field` whose label carries the
  live value: `<span>Monthly amount <output id="…">$1,000</output></span>`.
  Update the output on every input event. (Track fill is automatic.)
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
- gu-chip (filter pill; as `<button class="gu-chip">` toggle `aria-pressed`),
  gu-badge (status pill; pair with gu-badge-ok/gu-badge-warn/gu-badge-danger —
  badges annotate, they never carry the main message)
- gu-progress (progress bar: `<div class="gu-progress"><i style="width:62%"></i></div>`)
- gu-field (label + control stack: `<label class="gu-field"><span>Label <output>value</output></span><input class="gu-input" ...></label>`)

Data display:
- gu-kpi (row of KPIs), gu-kpi-item > .gu-kpi-value + .gu-kpi-label
  (2-4 items max; the value is the hero number, keep labels short)
- gu-table-wrap > gu-table (see hard rules)
- gu-bars (horizontal bar rows: `<div class="gu-bar"><span class="gu-bar-label">A</span><span class="gu-bar-track"><i style="width:70%"></i></span><span class="gu-bar-value">70%</span></div>`)
- gu-legend + gu-swatch (inline `<i class="gu-swatch" style="background:var(--gu-chart-1)"></i>`)

Colors (CSS variables — the ONLY colors you may use):
--gu-bg, --gu-elev, --gu-fill, --gu-line, --gu-text, --gu-text-dim,
--gu-text-faint, --gu-accent, --gu-accent-fg, --gu-brand, --gu-ok,
--gu-warn, --gu-danger, --gu-grid (chart grid), --gu-radius, --gu-gap, and
the chart palette --gu-chart-1 (primary series) … --gu-chart-5.

### Scenario recipes

**3D explainers (three)**: put the canvas in a `.gu-stage` (theme background,
never a hard-coded light color), the model built from fuselage/wing/tail
primitives, color-coded axes using `--gu-chart-2/1/4` with small labels, one
`.gu-field` slider per axis showing its angle in the label's `<output>`, a
demo button per axis that animates that rotation over ~1.5s with the camera
held still, one `.gu-btn-primary` Reset, one short explanation per axis.
Drag to orbit: attach pointer listeners on the canvas that rotate the camera
(no external controls). Keep the canvas ~240-300px tall so controls stay
visible in chat. Conceptual model, not a simulator.

**Map itineraries (map, net)**: `libs: map` + `net: true`; the map in a
`.gu-stage` (~280-320px tall, explicit height in @css), numbered pin markers
(divIcon) and stop cards below it. Drop the pins one by one with staggered
timing and a small settle animation, reveal the connecting polyline after
the pins, highlight the matching card with `is-selected` when a pin/card is
clicked, and provide pause + replay. Keep the map camera still. Photo
thumbnails need a fixed aspect box (e.g. `aspect-ratio: 4/3; object-fit:
cover`) so a failed image never collapses the card.

**Charts (d3 / chart)**: SVG in a `.gu-stage`-free plain block with reserved
margins — at least 28px bottom for the x-axis label and 44px left for the
y-axis, so nothing clips. Horizontal gridlines only (`--gu-grid`), bars in
`--gu-chart-1` with 4px rounded tops, value labels above bars in the text
color, axis titles with units, and a `.gu-legend`. Dataset switches use
`.gu-segmented` above the chart, never loose pills.

**Comparisons**: one `.gu-card` per option (title + price line + at most two
`.gu-bar` rows), sliders for the user's preferences at the top, clearly
labeled "illustrative estimates" (never live prices), the winner marked
`is-selected` + "Top pick" badge, and a recommendation sentence below that
updates with the inputs and explains why in one line.

**Split/sharing calculators**: KPIs first (the answer), then `.gu-field`
inputs with inline validation (`aria-invalid` + a `.gu-caption` error),
tip presets as `<button class="gu-chip">` toggles, integer-cent allocation
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
   dependent number, its `<output>` label AND the headline sentence; call
   `$render()` (height also auto-fits, so never fight it with fixed
   min-heights on `.gu-root`).
5. Motion is polish, not the point: CSS transitions 120-200ms on hover/press
   and bar/progress fills only. No infinite animations, no entrance choreography.
6. Mobile-first: widgets live in a ~360-680px chat column. Single-column by
   default, touch targets >= 32px (40px for choice tiles), tables scroll
   inside `.gu-table-wrap`, charts keep their axis labels inside the viewBox.
7. Accessibility: real <button>/<input>/<label> elements, `aria-pressed` on
   toggles, `aria-label` on icon-only buttons, contrast from the tokens.

### Example (interactive savings calculator)

````generative_ui
placeholder: Building your savings projection
height: 360
state: {"amount": 1000, "years": 5}

@html
<div class="gu-root"><div class="gu-col">
  <header class="gu-header">
    <h2 class="gu-title" id="headline">Your savings grow to $1,276</h2>
    <p class="gu-caption">Compound interest, 5% annual, monthly contributions.</p>
  </header>
  <div class="gu-kpi">
    <div class="gu-kpi-item"><span class="gu-kpi-value" id="total">$1,276</span><span class="gu-kpi-label">Final balance</span></div>
    <div class="gu-kpi-item"><span class="gu-kpi-value" id="gain">$276</span><span class="gu-kpi-label">Interest earned</span></div>
  </div>
  <label class="gu-field"><span>Monthly amount <output id="amountOut">$1,000</output></span>
    <input class="gu-slider" type="range" id="amount" min="50" max="2000" step="50" value="1000">
  </label>
</div></div>
@js
const amountEl = document.getElementById("amount");
const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
function recompute() {
  const amount = Number(amountEl.value);
  const total = amount * state.years * 1.05;
  document.getElementById("amountOut").textContent = fmt.format(amount);
  document.getElementById("total").textContent = fmt.format(total);
  document.getElementById("gain").textContent = fmt.format(total - amount * state.years);
  document.getElementById("headline").textContent = "Your savings grow to " + fmt.format(total);
  state.amount = amount;
  $render();
}
amountEl.addEventListener("input", recompute);
recompute();
````
