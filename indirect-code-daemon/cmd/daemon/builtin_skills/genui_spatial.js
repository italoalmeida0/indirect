export default {
  name: "genui_spatial",
  description:
    "Craft guide for architecture, interior floorplans, 3D massing & sun/shadow studies, CAD/mechanical cross-sections, and urban/GIS site planners with true-to-scale measurements and direct manipulation.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Architecture, CAD, Floorplans & Spatial Design (genui_spatial)

Build a **true-to-scale interactive spatial instrument** — floorplan editors, 3D architectural massing & sunlight studies, mechanical/structural cross-sections, interior layout planners, or urban/site GIS tools — with real physical dimensions, grid snapping, and direct tap/drag manipulation.

## 1. Choose the right spatial canvas
- **2D Architectural Floorplans, Interiors & Site Plans (Interactive SVG or DPR Canvas):**
  - Maintain ONE canonical physical coordinate scale (e.g. meters, with an optional \`m\` / \`ft\` unit toggle) and snap draggable rooms/furniture/partitions to a crisp grid (e.g. \`0.25m\` or \`0.5m\`).
  - Render clear architectural conventions: thick double-line exterior walls, crisp interior partitions, quarter-circle door swing arcs, window glazing ticks, subtle scale bar + North arrow, clean exterior dimension chains, and centered room labels showing **name + exact computed area (\`18.4 m²\`)** — de-conflicted so labels never clip outside small rooms!
  - Support direct pointer drag (\`onPointerDown\`/\`Move\`/\`Up\` with \`setPointerCapture\`) + tap-to-select + rotate/resize/add/delete controls in a compact inspector panel (works seamlessly on 390px touchscreens and desktop).
- **3D Architectural Massing, Sun/Shadow & Mechanical Assemblies (\`three\`):**
  - Use \`THREE.OrbitControls\` (\`enableDamping = true\`, \`controls.dispose()\` on cleanup), soft sky/ground hemisphere lighting, \`DirectionalLight\` with real shadow maps (\`shadowMap.enabled = true\`) driven by latitude / date / solar hour sliders (real solar elevation & azimuth math!), subtle ground metric grid, and crisp edge outlines or material contrast so volumes read unmistakably in both light and dark host themes.
  - Keep camera presets (\`Iso\`, \`Top\`, \`South\`, \`Street\`) in 3–4 compact chips inside ONE \`.gu-stage-hud\` or control bar.
- **Urban, Logistics, Real-Estate & GIS Planners (\`leaflet\`):**
  - Mount in \`.gu-stage\` with explicit height (\`300–360px\`), Carto Voyager tiles, custom \`L.divIcon\` pins, radius/isochrone/route polylines, distance/area readouts (Haversine/spherical math), synced sidebar/tab cards + \`map.flyTo(...)\`, \`ResizeObserver\` -> \`map.invalidateSize()\`, and \`map.remove()\` on cleanup.

## 2. Precision readouts, export & mobile ergonomics
- **Strict text budget:** \`.gu-title\` <= 6 words, **max 3–4 KPIs** (e.g. \`Gross Area\`, \`Net Usable\`, \`Perimeter\`, \`Ratio\`), **3–4 presets** (e.g. \`Studio\`, \`2-Bed\`, \`L-Shape\`), zero architectural essays inside the widget.
- **Save & attach back to chat:** Persist layouts via \`window.indirectUi.saveState(...)\` on discrete drop/edit events. Offer a crisp \`Attach plan\` / \`Update plan\` button calling \`window.__gu.attach({ key: "floorplan", name: "layout.json", content })\` (or canvas PNG via \`dataUrl\`) so the user can edit a room layout visually and send the exact updated dimensions back to you for review, code-compliance checks, or cost estimation!
- **Mobile 390px:** Use \`.gu-split\` (stage on top, compact tabbed \`Element\` / \`Add\` / \`Metrics\` panel below on narrow screens) and keep all interactive handles >= 36–44px touch targets with zero horizontal overflow.
`,
};
