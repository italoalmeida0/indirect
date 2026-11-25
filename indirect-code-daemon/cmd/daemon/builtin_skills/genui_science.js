export default {
  name: "genui_science",
  description:
    "Craft guide for STEM & clinical interactive labs across physics, chemistry, biology, medicine/pharmacology, and mathematics: genuine governing equations, exact SI/clinical units, live plots, and 3D molecular or field visualizers.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Science, Math & Clinical Labs (genui_science)

Build a **rigorous, hands-on interactive laboratory** where users manipulate real physical, chemical, biological, clinical, or mathematical variables and immediately see exact curves, 2D/3D phenomena, conservation laws, and units respond — never decorative fake animations or textbook essays inside the widget.

## 1. Domain rigor & genuine governing models
- **Physics & Electromagnetism:** Real analytical or stable numerical integration (RK4 / velocity-Verlet with clamped \`dt\`) for kinematics, springs/pendulums, orbital mechanics, wave interference/Doppler, Snell/thin-lens optics, thermodynamics (PV/Carnot), and RC/RLC/Ohm circuits. Display exact SI units (\`m/s\`, \`N\`, \`J\`, \`Hz\`, \`Ω\`, \`K\`, \`eV\`) and check conservation quantities where relevant.
- **Chemistry & Materials:**
  - 3D molecular & crystal viewers in \`three\` with \`OrbitControls\`, standard CPK element colors (C dark slate, H crisp white, O red, N blue, S yellow, P orange, halogens green), sphere atoms + cylinder bonds (single/double/triple), bond-angle & dipole indicators, and studio lighting (\`HemisphereLight\` + key + rim).
  - Stoichiometry, limiting-reagent, Henderson-Hasselbalch / acid-base titration curves (exact proton-balance solve), Arrhenius reaction kinetics, and gas-law calculators.
- **Biology, Medicine & Pharmacology:**
  - Compartmental pharmacokinetics (1-/2-compartment PK/PD dosing curves with therapeutic window shading, \`Cmax\`, \`Tmax\`, \`t½\`, steady-state trough), SIR/SEIR epidemiological curves, Hardy-Weinberg / Punnett genetics, action-potential / ECG / spirometry waveform simulators, and interactive anatomical/cellular schematics (clean tap-to-inspect SVG layers).
  - Keep clinical calculators clearly labeled as educational/illustrative via a short <= 6-word caption — put medical caveats in chat prose, never in verbose widget banners.
- **Mathematics & Statistics:**
  - Interactive function/derivative/integral explorers, 2D/3D parametric surfaces & vector fields, linear-algebra matrix/eigenvalue/SVD transformation stages (draggable basis vectors!), phase portraits, probability distributions (Normal, Binomial, Poisson, Beta, Student-t with live PDF/CDF/p-value shading), and Monte Carlo convergence labs.

## 2. Visual craft, controls & mobile layout
- **Hero experiment stage (65–80% of footprint):** One crisp SVG (\`viewBox\` 540–660, inner plot margins >= 44px, collision-free edge-aware labels), DPR 2D \`<canvas>\`, Chart.js curve, or \`three\` 3D scene — paired with **3–5 canonical domain presets** in \`.gu-chips\` (e.g. \`Water H₂O\`, \`Methane CH₄\`, \`Benzene C₆H₆\` or \`Underdamped\`, \`Critical\`, \`Overdamped\`).
- **Strict text budget:** \`.gu-title\` <= 6 words, **max 3–4 KPI readouts** in \`.gu-kpi\` with explicit units and tabular numerals, zero prose derivations inside the widget (explain equations concisely in your chat reply).
- **Calm controls & inspection:** Put 2–4 primary sliders in \`.gu-grid-2\`; if there are secondary tabs (\`Controls\`, \`Graph\`, \`Data\`), group them in \`.gu-tabs\` so 390px phones stay clean with zero horizontal overflow. Persist parameters via \`window.indirectUi.saveState(...)\` and optionally let users attach experiment results/tables to chat via \`window.__gu.attach({ key: "lab-data", name: "results.json", content })\`.
`,
};
