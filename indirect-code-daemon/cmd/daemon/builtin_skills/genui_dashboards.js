export default {
  name: "genui_dashboards",
  description:
    "Craft guide for airy interactive data dashboards, collision-free Chart.js / D3 / SVG analytics, Leaflet maps, financial/planning calculators, and scenario comparators.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Data Dashboards, Maps & Calculators (genui_dashboards)

Deliver clarity in the first second: crisp visual hierarchy, generous whitespace, live cross-filtering, exact numbers, zero overlapping/clipped labels, and effortless 390px mobile stacking.

## 1. Airy executive hierarchy & strict text budget
1. **Crisp header (\`.gu-header\`):** \`.gu-title\` (**<= 6 words**, e.g. \`Series A Runway Planner\` — never a long sentence repeating the KPIs!). Optional 1-line \`.gu-caption\` (**<= 8–10 words**, e.g. \`Illustrative model · tune assumptions below\`, or omit). NEVER put methodology paragraphs, footnotes, or multi-sentence caveats inside the widget — put those briefly in your chat reply.
2. **Hero KPIs (\`.gu-kpi\`):** Strictly **3–4 \`.gu-kpi-item\` cards MAX** (never 5–6!). Label **<= 3 words**, bold tabular value via \`Intl.NumberFormat\`, optional short delta/unit. Automatically renders 3–4 across on desktop and 2×2 on 390px phones.
3. **One hero visual + tabbed views (NO 2000px vertical walls):** Show ONE primary chart/map/matrix and ONE calm control or breakdown panel. If the dashboard offers multiple views (e.g. \`Overview\`, \`Matrix\`, \`Breakdown\`, \`Table\`), switch cleanly with \`.gu-tabs\` / \`.gu-segmented\` (2–4 concise tabs) instead of stacking 5 tall cards vertically! Cap scenario/filter chips in \`.gu-chips\` at **3–5 chips** (1–2 words each).
4. **Controls:** Put 2–4 key sliders in \`.gu-grid-2\` (auto-stacks to 1 col on mobile) with live \`<output>\` values. Cross-highlight when tapping/clicking any chart point, card (\`.gu-card.is-selected\`), bar, or table row (never hover-only).

## 2. Chart.js (\`import Chart from "chart"\` or \`"chart.js/auto"\`) — Zero-bug recipe
- Controllers, scales, elements, and plugins are **auto-registered** (no \`Chart.register(...)\` needed).
- **CRITICAL container rule:** Place \`<canvas>\` inside a wrapper \`<div>\` with an EXPLICIT CSS height (e.g. \`style={{ position: "relative", height: 260 }}\`) and pass \`options: { responsive: true, maintainAspectRatio: false }\` so Chart.js never triggers resize loops.
- **Theme-synced colors:** Read \`getComputedStyle(document.documentElement)\` for \`--gu-chart-1\`..\`--gu-chart-5\`, \`--gu-text-dim\`, \`--gu-grid\`, \`--gu-elev\`, \`--gu-line\`, \`--gu-text\`. Keep the instance in \`useRef\`, call \`chart.update("none")\` on updates, and \`chart.destroy()\` in cleanup.

## 3. Declarative D3 + React SVG — ZERO Overlap & ZERO Clipping (CRITICAL)
- Compute scales, bins, arcs, and paths with \`d3\` inside \`useMemo\` and render declarative JSX \`<svg className="gu-svg" viewBox="0 0 600 280">\` (balanced width **520–640** so \`11.5–13px\` labels remain legible on 390px phones).
- **Generous inner margins:** Always reserve \`left >= 52\`, \`right >= 48\`, \`top >= 28\`, \`bottom >= 40\` inside the \`viewBox\` so axis titles, ticks, and edge data labels NEVER clip!
- **Edge-aware label anchoring:** Whenever a point or bar label sits near the right edge (\`x > plotRight - 72\`), render it to the LEFT (\`x={cx - 8}\`, \`textAnchor="end"\`) so glyphs flow inward and NEVER bleed outside the \`viewBox\`.
- **Mandatory scatter/dense label de-confliction:** Keep point labels short (1 word / <= 10 chars). Before rendering point labels, run a deterministic collision check against previously placed label boxes (\`{ x, y, w, h }\`): try candidate offsets (\`[+8, 0]\`, \`[-8, 0]\`, \`[0, -12]\`, \`[0, +16]\`) clamped inside the plot bounds, and if a dense cluster still collides, show labels only for top/selected points and display full details for any tapped/hovered point in a clean readout bar — NEVER render two overlapping \`<text>\` labels!
- Set explicit high-contrast \`fill\` on SVG labels (\`var(--gu-text)\` on surfaces, \`#ffffff\` or \`var(--gu-bg)\` on saturated fills). Horizontal gridlines only (\`var(--gu-grid)\`), clean \`.gu-legend\` with \`.gu-swatch\`.

## 4. Geographic maps (\`import * as L from "leaflet"\`)
- Mount inside \`.gu-stage\` with explicit height (\`style={{ height: 300, width: "100%" }}\`), Carto Voyager tiles (\`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png\`), \`L.divIcon\` pins (\`--gu-brand\`), synced \`.gu-card.is-selected\` items + \`map.flyTo(...)\`, \`ResizeObserver\` -> \`map.invalidateSize()\`, and \`map.remove()\` on unmount.

## 5. Financial, planning & comparison tools
- Update every KPI, chart series, and table live on input; allocate integer cents for currency/share splits so parts sum strictly to the total; keep tables inside \`.gu-table-wrap\` with <= 4–5 concise columns for crisp mobile readability.
- Persist user-adjusted scenario parameters on discrete changes via \`window.indirectUi.saveState(...)\`.
`,
};
