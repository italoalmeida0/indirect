export default {
  name: "generative_ui",
  description: "Core Generative UI widget runtime, sandbox contract, mobile-first layout, and visual design craft.",
  usable: "never",
  provides: ["generative_ui"],
  permissions: {
    widget_set: "yolo",
    widget_list: "yolo",
    widget_lint: "yolo",
    widget_read: "yolo",
    widget_edit: "yolo",
  },
  body: `# Interactive widgets (generative_ui)

Render live, interactive React 18 TSX widgets inside your final answer whenever direct manipulation, live calculation, visualization, simulation, or play makes the answer dramatically clearer than static text. Skip widgets for simple factual or short answers.

**Execution & scope discipline (critical):** Plan briefly (layout, state, and key equations/mechanics only — NEVER pre-draft full TSX code in your reasoning) and call \`widget_set\` promptly. Ship one cohesive, self-contained TSX module (~160–380 lines for tools/visualizers, up to ~480 lines for rich 3D/RPG games) with clean helpers — never waste tokens on bloated boilerplate or prose paragraphs.

## Fence format & workflow

**CRITICAL — Widgets live in the session store, and \`widget_set\` alone renders NOTHING until you emit the fence.** Store raw TSX source (no markdown fences) with \`widget_set\`, pass matching \`state\` JSON so gateway lint smoke-renders with real props, fix any reported lint error, and **mount it right at the top of your final reply** with ONE header-only \`generative_ui\` fence:

\`\`\`\`generative_ui
widget_id: compound_growth
placeholder: Interactive compound growth projector
state: {"principal": 10000, "years": 15}
\`\`\`\`

- \`widget_id:\` (required) — exact id stored via \`widget_set\` (letters, digits, \`-\`, \`_\`, \`:\`, \`.\`). Only the LAST fence for a given \`widget_id:\` mounts live.
- \`placeholder:\` — 3–8 word sentence-case loading label (never \`"Loading"\`).
- \`state:\` — JSON object passed as initial props to \`export default function App(props)\` (also at \`window.__gu.state\`). Any user-saved state shallow-merges over this default on reload (\`{ ...fenceDefault, ...saved }\`, saved wins).
- **Lint & logic testing:** \`widget_set\` ALREADY runs full gateway lint (compile, import audit, smoke render). Once \`widget_set\` passes lint, do NOT loop extra lint passes unless verifying core pure logic: export pure helpers alongside \`App\` and run \`widget_lint({ id, test })\` ONCE asserting structural/monotonic/conservation invariants (NEVER brittle exact magic-number assertions).
- **Natural reply prose:** Explain the concept or controls concisely in your chat reply — NEVER echo internal skill wording in chat, and NEVER duplicate your chat explanation inside the widget.

## Built-in offline imports (instant — never static-import unknown packages)

- \`import { useState, useReducer, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useContext, createContext, memo, forwardRef, Fragment } from "react"\` (plus \`"react-dom/client"\`)
- \`import * as THREE from "three"\` — 3D WebGL. Also exports \`OrbitControls\`, \`RoomEnvironment\`, and \`RoundedBoxGeometry\` directly from \`"three"\`, on \`THREE.*\`, and via \`"three/addons/..."\` / \`"three/examples/jsm/..."\`.
- \`import * as CANNON from "cannon-es"\` — 3D rigid-body physics (pairs with \`three\`).
- \`import Matter from "matter-js"\` (or named \`{ Engine, Bodies, Composite, World, Body, Events, Query, Vector, Constraint }\`) — 2D rigid-body physics.
- \`import * as d3 from "d3"\` — scales, shapes, layouts, math helpers.
- \`import * as gsap from "gsap"\` (or \`import gsap from "gsap"\`) — timelines & tweening.
- \`import Chart from "chart"\` (or \`"chart.js/auto"\`) — Chart.js v4, auto-registered (no \`Chart.register\` needed).
- \`import * as L from "leaflet"\` — interactive maps (CSS & icons bundled automatically).

**NEVER static-import unbundled packages** (\`lucide-react\`, \`recharts\`, \`framer-motion\`, \`lodash\`, etc.) — they fail compile/audit. Draw crisp inline \`<svg>\` icons instead. External libraries may ONLY be loaded via dynamic \`import("https://esm.sh/pkg@ver")\` with a string-literal URL and \`.catch(...)\` fallback.

## Runtime APIs & sandbox rules (pass lint on the 1st try)

- **State & host bridge (\`window.indirectUi\` / \`window.__gu\`):**
  - \`window.indirectUi.saveState(snapshot)\` (alias \`window.__gu.saveState(snapshot)\`) — synchronously persists a plain JSON object (**up to 64 KB**) to host storage per host + session + widget, updates \`window.__gu.state\`, and returns \`true\`/\`false\`. Call ONLY on discrete user events or milestones (never per frame or per render). Hydrate initial \`useState\`/\`useReducer\` from \`App(props)\`.
  - \`window.indirectUi.sendPrompt(text)\` / \`prefillPrompt(text)\` — trigger follow-up turns from action buttons.
  - \`window.indirectUi.openLink(url)\` — open \`http\`/\`https\` links safely.
- **Canvas & fullscreen helpers (\`window.__gu\`):**
  - \`window.__gu.fitCanvas(canvas, cssW?, cssH?)\` — sets crisp DPR backing size (\`dpr <= 2\`) and returns \`{ width, height, dpr }\`.
  - \`window.__gu.isFullscreen\` & \`window.__gu.onFullscreen(fn)\` (returns an unsubscribe cleanup fn) — react to fullscreen toggles (\`window\` also fires \`resize\`; observe stage containers with \`ResizeObserver\`).
- **Hard sandbox rules (violations fail lint or blank the widget):**
  1. **NO \`localStorage\` / \`sessionStorage\`** — throws \`SecurityError\` and fails lint; always use \`window.indirectUi.saveState(obj)\`.
  2. **NO writing to \`window.*\` or \`document.*\`** (never \`document.body.style.cursor = ...\`, \`window.onkeydown = ...\`, or \`window.__myFn = ...\`) — mutate refs (\`canvasRef.current.style.cursor = "grabbing"\`), bridge React UI and canvas loops via \`useRef\` callbacks, and attach listeners with \`window.addEventListener(...)\` + cleanup.
  3. **NO aliasing globals** (\`const w = window\`, \`const d = document\`, \`const O = Object\`, \`e.target === document\`) — read properties directly (\`window.innerWidth\`, \`Object.keys(...)\`). Static feature checks like \`"ontouchstart" in window\` or \`"AudioContext" in window\` are allowed.
  4. **NO** \`.constructor\`, \`.__proto__\`, \`.prototype\`, \`Reflect\`, \`Object.defineProperty\`, \`Object.getPrototypeOf\`, \`eval\`, \`new Function\`, \`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`, \`Worker\`, \`innerHTML\`, \`dangerouslySetInnerHTML\`, or \`el.setAttribute(dynamicVar, ...)\` (literal attribute names are fine).
  5. **Pointer lock & fullscreen:** \`requestPointerLock\` / \`requestFullscreen\` degrade quietly inside sandboxed iframes — NEVER rely on pointer lock alone; always support pointer drag, touch controls, and keyboard.
  6. **60fps hygiene & cleanup:** Never call React \`setState\` every frame inside \`requestAnimationFrame\` — keep high-frequency simulation state in \`useRef\` and push throttled/discrete HUD updates. Always return a \`useEffect\` cleanup to cancel rAF/timers, remove listeners, \`chart.destroy()\`, \`map.remove()\`, disconnect \`ResizeObserver\`, close \`AudioContext\`, and dispose Three.js renderer/controls/geometries/materials/textures.
  7. **Web Audio & media:** Create/resume \`AudioContext\` lazily inside a user click/keydown/tap gesture (never auto-play on mount). Embed all data inline (system fonts only). \`<img>\` supports \`http(s)\` URLs (always set \`alt\`, fixed \`aspectRatio\`, and \`objectFit: "cover"\`).

## Design craft, text budget & mobile-first layout (CRITICAL)

1. **Strict text budget — Widget = instrument, Chat = explanation:**
   - **NEVER put multi-sentence explanations, tutorial paragraphs, methodology essays, caveats, or textbook callouts inside a widget.** Put explanations briefly in your chat reply instead.
   - Inside the widget, use ONLY crisp UI micro-copy:
     - \`.gu-title\`: **<= 5–6 words** (concise name or crisp verdict — never a metric-stuffed sentence).
     - Optional \`.gu-caption\`: **<= 8–10 words** (or OMIT completely when the title and controls are self-evident).
     - KPI strip (\`.gu-kpi\` / \`.gu-kpis\`): **MAX 3–4 tiles** (NEVER 5–6 squeezed in a row!), label **<= 3 words**, bold tabular value, optional short delta/unit.
     - Buttons, chips, tabs: **1–2 words** each.
     - **Zero duplication:** never repeat the exact same metric or status in header + KPI + HUD + footer. Avoid prose callout boxes.
2. **Airy whitespace & calm hierarchy:**
   - Give **one hero visual/interactive stage 65–80% of attention** plus **one calm grouped control surface**. Never dump 4 stacked panels, 8 sliders, and 10 preset chips onto one screen — organize secondary panels/knobs/logs into **2–4 compact \`.gu-tabs\`** (or \`.gu-segmented\`) and cap preset strips at **3–5 presets**.
   - Let \`.gu-root\`, \`.gu-stack\`, \`.gu-card\`, and \`.gu-panel\` own breathing room (\`16px\` gaps, generous padding). Never wrap the whole widget in \`.gu-card\` or nest \`.gu-card\` inside \`.gu-card\`. Use at most ONE \`.gu-btn-primary\`.
3. **Mobile-first responsive (390px phone + desktop, ZERO horizontal overflow):**
   - Every widget MUST render cleanly at **390px width** with **zero horizontal overflow** (\`scrollWidth <= clientWidth\`).
   - NEVER hardcode wide fixed pixel widths or fixed 4–6 column desktop grids. Use \`.gu-split\`, \`.gu-grid\`, \`.gu-grid-2\`, \`.gu-grid-3\`, \`.gu-grid-4\`, \`.gu-kpi\`, \`.gu-tabs\`, \`.gu-chips\`, or \`repeat(auto-fit, minmax(min(100%, 150px), 1fr))\` (KPIs auto-cap at <= 2/row on 390px phones).
   - Keep stage overlays minimal: **max 2–3 compact frosted \`.gu-hud-pill\`s** inside **ONE \`.gu-stage-hud\`** bar (never mount two \`.gu-stage-hud\` divs, and NEVER add a custom fullscreen button — the host toolbar provides Fullscreen, Reload, Inspect, and Reset). On desktop (\`>= 640px\`), keep the top-right ~140px clear of the host toolbar; on mobile (\`<= 639px\`), the host toolbar docks above the iframe automatically.
   - Never rely on hover-only interaction — every inspectable node/point must respond to tap/click.
4. **Collision-free SVG & chart labels (zero overlap, zero clipping):**
   - Keep SVG \`viewBox\` widths balanced (**520–680**) with \`11.5–13px\` labels so text stays legible when scaled down to 350px on phones. Build closed \`<path d>\` strings cleanly (\`pts.map((p, i) => \`\${i ? "L" : "M"}\${p.x},\${p.y}\`).join(" ") + " Z"\`, never trailing \`L Z\`).
   - Reserve generous inner plot margins (**>= 36–48px** on left/right/top/bottom inside \`viewBox\`). For points near the right edge (\`x > plotRight - 72\`), flip \`textAnchor="end"\` with a negative \`dx\` so labels flow INWARD and NEVER clip off the SVG edge.
   - Keep chart labels short (1–2 words) and run a deterministic collision check/nudge on nearby points (or show full details on tap/hover) — NEVER let two \`<svg>\` text elements overlap.
5. **Dual-theme harmony (dark + light):**
   - In HTML/SVG widget chrome (including inspector, trace, log, and status boxes), use ONLY \`--gu-*\` tokens (\`--gu-bg\`, \`--gu-elev\`, \`--gu-fill\`, \`--gu-line\`, \`--gu-text\`, \`--gu-text-dim\`, \`--gu-text-faint\`, \`--gu-accent\`, \`--gu-accent-fg\`, \`--gu-brand\`, \`--gu-ok\`, \`--gu-warn\`, \`--gu-danger\`, \`--gu-grid\`, \`--gu-chart-1\`..\`--gu-chart-5\`) — NEVER hardcode raw hex/rgb or black \`#000\`/\`#0a0a0a\` fills in widget chrome. Set explicit high-contrast \`fill\` on SVG text (\`#ffffff\` or \`var(--gu-bg)\` on saturated fills, \`var(--gu-text)\` on surfaces). (Inside \`<canvas>\` 2D/WebGL worlds and games, rich custom color/lighting palettes ARE allowed.)
6. **Controls & class quick reference:**
   - Wrap every \`.gu-slider\` in \`<label className="gu-field"><span>Label <output>{val}</output></span><input type="range" className="gu-slider" ... /></label>\` (track fill is automatic).
   - Use \`.gu-tabs\` / \`.gu-segmented\` (\`aria-selected\`/\`aria-pressed\`) for view switches, \`button.gu-chip\` (\`aria-pressed\`) inside \`.gu-chips\` for filters/presets, \`.gu-choice\` for selectable tiles, and \`.gu-table-wrap > .gu-table\` (\`className="num"\` on numeric cols). Format numbers with \`Intl.NumberFormat\`; keep sentence case.
   - *Layout:* \`gu-root\`, \`gu-header\`, \`gu-stack\` (\`gu-col\`), \`gu-stack-sm\`, \`gu-row\`, \`gu-chips\`, \`gu-spacer\`, \`gu-divider\`, \`gu-grid\`, \`gu-split\`, \`gu-grid-2\`, \`gu-grid-3\`, \`gu-grid-4\`, \`gu-card\` (\`is-selected\`), \`gu-panel\`
   - *Stage & Touch:* \`gu-stage\`, \`gu-game-stage\`, \`gu-stage-hud\`, \`gu-hud-pill\`, \`gu-canvas-interactive\`, \`gu-touch-controls\`, \`gu-touch-bar\`, \`gu-touch-group\`, \`gu-touch-btn\`, \`gu-touch-btn-primary\`, \`gu-touch-btn-round\`, \`gu-dpad\`, \`gu-kbd\`, \`gu-svg\`
   - *Type:* \`gu-title\`, \`gu-subtitle\`, \`gu-body\`, \`gu-caption\`, \`gu-strong\`, \`gu-mono\`, \`gu-dim\`
   - *Controls:* \`gu-btn\`, \`gu-btn-primary\`, \`gu-btn-ghost\`, \`gu-btn-sm\`, \`gu-tabs\` (\`gu-segmented\`), \`gu-choice\`, \`gu-field\`, \`gu-slider\`, \`gu-input\`, \`gu-select\`, \`gu-textarea\`, \`gu-toggle\`, \`gu-chip\`, \`gu-badge\` (\`-ok\`/\`-warn\`/\`-danger\`), \`gu-progress\`
   - *Data:* \`gu-kpi\` (\`gu-kpis\`) / \`gu-kpi-item\` / \`gu-kpi-value\` / \`gu-kpi-label\`, \`gu-table-wrap\` / \`gu-table\`, \`gu-bars\` / \`gu-bar\` / \`gu-bar-label\` / \`gu-bar-track\` / \`gu-bar-value\`, \`gu-legend\` / \`gu-swatch\`
`,
};
