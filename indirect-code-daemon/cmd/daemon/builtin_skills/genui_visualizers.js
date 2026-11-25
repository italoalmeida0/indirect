export default {
  name: "genui_visualizers",
  description:
    "Craft guide for general 2D & 3D interactive simulations, generative/orbital/particle/ecological/fractal sandboxes, and visual explorable models (for dedicated STEM/clinical labs see genui_science; for architecture/CAD/floorplans see genui_spatial; for audio/design/sketch studios see genui_creative).",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Creative Labs, Scientific & Spatial Visualizers (genui_visualizers)

Build a **gallery-grade interactive instrument or creative sandbox**, not a static diagram or text wall. Unite: (1) one commanding visual stage (65–80% of attention: 3D WebGL, DPR Canvas, or crisp SVG), (2) direct manipulation (drag/launch/paint/orbit/click-to-inspect), (3) live domain readouts with real units, and (4) **3–5 curated presets** for one-tap exploration — zero explanatory prose inside the widget (put explanations in your chat reply).

## 1. Choose the right visual medium
- **Creative Interactive Studios & Generative Sandboxes (DPR \`<canvas>\` / \`three\` + optional Web Audio):**
  - Ideal for: procedural synthesizers & step sequencers with live 2D/3D audio-reactive visuals, orbital gravity / N-body solar-system builders, fluid/boids/bioluminescent ecosystems, fractal/wave/shader playgrounds, kinetic typography & generative art.
  - **Instant delight:** Animate smoothly on mount (subtle living motion or ready-to-play groove). For audio labs, unlock/resume \`AudioContext\` on the first Play/pad tap, pipe output through an \`AnalyserNode\` (\`getByteTimeDomainData\` / \`getByteFrequencyData\`) to drive 60fps reactive waves/rings/3D geometry, and provide tactile tap pads/steps + compact \`Play\`/\`Mute\` + tempo/mood presets.
  - **Direct gesture craft:** Let users click/drag right on the \`.gu-canvas-interactive\` stage (e.g., drag-to-slingshot a planet with live velocity/orbit preview, paint attractors/particles, tap harmonic pads) — works identically via touch on 390px phones and mouse on desktop!
- **3D Spatial, Structural & Scientific (\`three\`):**
  - Ideal for: architectural massing & sun/shadow studies, 3D molecules & crystal lattices (CPK colors, sphere atoms, cylinder bonds, angle/dipole cues), 3D geometry/vectors/surfaces, mechanical assemblies, optical rigs.
  - Use built-in \`new THREE.OrbitControls(camera, renderer.domElement)\` (exported directly from \`"three"\`!) with \`enableDamping = true\`, \`dampingFactor = 0.08\`, \`controls.update()\` in rAF, and \`controls.dispose()\` on unmount.
  - **Studio lighting:** Bright \`HemisphereLight\` + key \`DirectionalLight\` (\`shadowMap.enabled = true\` for sunlight/massing) + fill/rim light (or \`THREE.RoomEnvironment\` via \`PMREMGenerator\` for glass/metal), luminous theme-safe backdrop, and subtle ground scale/grid cues — never dark murky shapes on flat black.
- **Precision 2D Blueprints, Schematics & Professional Diagrams (Responsive \`<svg>\`):**
  - Ideal for: architectural floor plans (scaled grid, walls, door swings, exact \`m²\`/\`ft²\` totals), circuits, optical benches, anatomy, force diagrams, and legal/process timelines.
  - Use balanced \`viewBox\` widths (**520–680**) with generous inner margins (**>= 36–44px**), \`<defs><marker ...>\` arrowheads, and explicit high-contrast text \`fill\` (\`var(--gu-text)\` on surfaces, \`#ffffff\` or \`var(--gu-bg)\` on saturated shapes). Flip \`textAnchor="end"\` near right edges and de-conflict nearby labels so zero text overlaps or clips on desktop or 390px mobile.

## 2. Domain fidelity, airy restraint & mobile-first layout
- **Real governing math:** Compute genuine physics, chemistry, optics, acoustics, geometry, or area/sunlight math (e.g. gravitational acceleration, VSEPR angles, harmonic frequencies, Snell's law, solar elevation/azimuth) — never fake decorative sine waves.
- **Strict text budget & zero clutter:**
  - \`.gu-title\`: **<= 5–6 words** (NEVER repeat 4 KPI numbers in the title!). Optional \`.gu-caption\`: **<= 8–10 words** or omit. Zero multi-sentence explanations or \`.gu-callout\` paragraphs!
  - **Max 3–4 KPIs** in \`.gu-kpi\` (auto-stacks <= 2/row on 390px phones) — never 5–6 cramped boxes!
  - **Max 3–5 presets** in \`.gu-chips\` or \`.gu-tabs\` (1–2 word labels).
  - **Calm controls:** Keep the hero stage commanding (\`height: clamp(280px, 44vh, 400px)\` inline, \`100vh\` when fullscreen via \`window.__gu.onFullscreen\`), and group controls cleanly below or in \`.gu-split\`. When there are > 4 sliders/inspectors, organize them into **2–3 \`.gu-tabs\`** (e.g. \`Scene\`, \`Parameters\`, \`Inspect\`) instead of dumping 8 sliders at once.
  - Put ALL stage overlays in **ONE \`.gu-stage-hud\`** bar with **max 2–3 compact \`.gu-hud-pill\`s**, clear of the central subject and desktop's top-right host toolbar.
  - Persist selected preset/parameters on discrete user changes via \`window.indirectUi.saveState(...)\`.
`,
};
