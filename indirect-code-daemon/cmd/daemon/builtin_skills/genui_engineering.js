export default {
  name: "genui_engineering",
  description:
    "Craft guide for airy, mobile-ready developer & software-engineering instruments: interactive system architectures, protocol/sequence tracers, state-machine/concurrency/distributed-systems simulators, algorithm step-throughs, and DB/memory/latency explorers.",
  usable: "yolo",
  mode: "agentic",
  requires: ["generative_ui_agentic"],
  body: `# Craft guide: Software Engineering & Architecture Visualizers (genui_engineering)

Build a **crisp, airy interactive engineering instrument** where the developer steps execution, injects real events/faults, inspects internal node/frame state, and verifies invariants directly — zero dense panel soup, zero essay text inside the UI, and effortless 390px mobile stacking.

## 1. Ground in real facts (or go straight to \`widget_set\` for conceptual systems)
- When visualizing a user's existing repo in Agentic mode, populate real service/module/symbol/table names and measured figures from what you read.
- When asked for a **conceptual/general engineering simulator** (e.g. Raft, LSM/B-Tree, TCP congestion, HTTP cache/SWR, WebRTC ICE, event loop) without referencing repo files, **do NOT run \`bash\`, \`ls\`, \`mkdir\`, or workspace file writes** — plan briefly (pure transition reducer, 3–4 presets, clean layout) and call \`widget_set({ id, content, state })\` directly!

## 2. Strict text budget & calm tabbed workspace (CRITICAL)
- **Header (\`.gu-header\`):** Crisp \`.gu-title\` (**<= 6 words**, e.g. \`TCP Congestion Control Lab\` — never repeat KPIs in the title!). Optional 1-line \`.gu-caption\` (**<= 8 words**, or omit). **NEVER put multi-sentence conceptual explanations inside the widget** — put architecture explanations concisely in \`final_message_to_user\`.
- **Hero KPIs (\`.gu-kpi\`):** Strictly **3–4 tiles MAX** (never 5–6 squeezed in one row!), short 1–2 word labels (e.g. \`cwnd\`, \`ssthresh\`, \`In Flight\`, \`State\`), tabular values. Auto-collapses to 2×2 on 390px phones.
- **Compact transport + presets bar:** One clean wrapping \`.gu-row\` with \`Play\`/\`Pause\` (\`.gu-btn-primary\`), \`Step\`, \`Reset\`, compact \`Step 4/24\` badge, and **3–4 scenario presets** in \`.gu-chips\` (1–2 words each).
- **Calm \`.gu-split\` + tabbed panel (NEVER stack 4 dense panels vertically!):**
  - **Left (\`2fr\`):** Hero interactive SVG diagram / state machine / tree / timeline stage (click/tap any node, block, or edge to select it).
  - **Right (\`1fr\`):** ONE calm \`.gu-card\` with **\`.gu-tabs\`** switching cleanly between **2–3 focused views** — e.g. \`Inspect\` (selected node/frame state + 2–4 crisp fault/event injection buttons like \`Drop Packet\`, \`Compact\`, \`Split\`), \`Tune\` (2–4 key sliders), and \`Trace\` (compact scrollable monospace log, \`maxHeight: 220px\`, click any row to jump to that step).
  - On Desktop, the whole instrument breathes in one clean viewport; on 390px Mobile, \`.gu-split\` stacks the diagram cleanly above the tabbed panel with zero overflow!

## 3. Deterministic simulation & collision-free SVG diagrams
- **Pure deterministic reducer:** Model transitions as pure functions producing immutable snapshots (\`steps[]\` + concise trace entries) so stepping backward/forward and jumping from \`Trace\` is instant and deterministic. Export the step helper and optionally assert structural invariants with ONE \`widget_lint({ id, test })\` call.
- **Legible, collision-free SVG (\`viewBox\` width 540–660):**
  - Keep **4–10 readable nodes per view** (split large systems with \`.gu-tabs\` perspectives instead of cramming tiny boxes).
  - Use a balanced \`viewBox\` width (**540–660**) with \`11.5–13px\` labels and generous inner margins (**>= 28–36px**) so text stays razor-sharp and never clips or overlaps when scaled to 350px on mobile!
  - Use orthogonal or gentle Bezier edges, \`<defs><marker id="..." refX="..." refY="..." markerWidth="..." markerHeight="..." orient="auto">\` arrowheads, and concise animated in-flight packet/event badges (\`ACK\`, \`SPLIT\`, \`503\`).
- **Semantic state tokens ONLY (dark + light safe):**
  - \`--gu-brand\` — active / leader / selected focus
  - \`--gu-ok\` — healthy / committed / hit / open-ok
  - \`--gu-warn\` — degraded / half-open / retrying / compacting / stale
  - \`--gu-danger\` — failed / dropped / timeout / rejected / split-alert
  - \`--gu-line\` / \`--gu-fill\` / \`--gu-elev\` — neutral structure (NEVER hardcoded \`#000\`/\`#0a0a0a\` inner boxes!)
- Render identifiers, keys, routes, and payloads in \`.gu-mono\`. Persist active preset/parameters via \`window.indirectUi.saveState(...)\` on discrete user changes.
`,
};
