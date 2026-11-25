import generativeUI from "skill:generative_ui";

/* Self-activatable Generative UI skill for agentic sessions (Build, Plan,
   Learning). Not active by default: the agent discovers it in use_skill and
   activates it mid-turn whenever an interactive developer visualization makes
   the answer dramatically clearer. Activating it immediately grants widget_*
   tools and unlocks the agentic Gen-UI craft subskills on the next step. */
export default {
  ...generativeUI,
  name: "generative_ui_agentic",
  description:
    "Activate when an interactive visual widget makes a developer or professional answer dramatically clearer than static text: system/service architecture topologies, protocol/sequence tracers, state-machine/concurrency/distributed-systems simulators, algorithm/data-structure debuggers, AST/memory/DB-schema/latency explorers, interactive forms/configurators/spec builders that attach structured data back to chat, embedded AI prompt/eval harnesses, scientific/spatial/CAD/financial models, or live UI prototypes. Do NOT activate for simple coding Q&A, routine file edits, short snippets, or plain CLI/test explanations.",
  usable: "yolo",
  mode: "agentic",
  provides: ["generative_ui", "generative_ui_agentic"],
  permissions: {
    ...generativeUI.permissions,
    widget_read: "deny",
    widget_edit: "deny",
  },
  body: `## Agentic delivery & unlocked craft subskills

- **Where the fence lives (critical):** A \`generative_ui\` fence ONLY mounts when placed inside the \`final_message_to_user\` field of \`finish_entire_request\`. A fence written anywhere else (intermediate text, summaries, files) is never rendered. Keep conceptual explanations concisely in \`final_message_to_user\` — NEVER paste explanatory paragraphs inside the widget.
- **Authoring & updating widgets cleanly (fast path):** Store widget TSX directly via \`widget_set({ id, content, state })\` — this works cleanly in Build, Plan, AND Learning modes without creating untracked files in the user's git workspace. For conceptual or standalone interactive visualizers/simulators (where the user did NOT ask to inspect existing repo files), **skip workspace probes (\`bash\`, \`ls\`, \`mkdir\`, \`write\`, \`glob\`) completely**, plan briefly in a few bullets (never pre-draft TSX in reasoning), and call \`widget_set({ id, content, state })\` directly right after loading the subskill. To update an inline widget in Agentic mode, call \`widget_set({ id, content, state })\` directly — **never search disk for it or write temp files into \`brain/\`**. Once \`widget_set\` passes lint (and at most ONE optional \`widget_lint\` invariant check), **immediately call \`finish_entire_request\`** with the \`generative_ui\` fence in \`final_message_to_user\`. (Pass \`src_file\` only if you already wrote a file on disk.)
- **Load the matching unlocked craft subskill FIRST** via \`use_skill({ name: "<name>", once: true })\` before writing widget code:
  - \`genui_engineering\` — interactive system/service architectures, protocol & sequence tracers, state-machine/concurrency/distributed-systems simulators, algorithm step-throughs, AST/memory/DB-schema & latency/flame explorers.
  - \`genui_ai_apps\` — embedded AI widgets using \`window.__gu.ai\` (prompt/eval workbenches, custom chat harnesses with model & effort pickers, AI-driven analyzers).
  - \`genui_forms\` — interactive forms, spec/schema configurators, review rubrics & wizards that attach structured JSON/Markdown back to the composer via \`window.__gu.attach\`.
  - \`genui_dashboards\` — benchmark/telemetry/metric dashboards (Chart.js / D3), geographic maps & quantitative comparators.
  - \`genui_visualizers\` — 2D & 3D interactive simulations, shader/particle/graph sandboxes & visual models.
  - \`genui_science\` — physics, chemistry, biology, medicine & mathematics interactive labs.
  - \`genui_spatial\` — architecture, floorplans, CAD, 3D massing & mechanical/GIS layouts.
  - \`genui_business\` — finance, legal/compliance, strategy & Gantt/project/ops workbenches.
  - \`genui_education\` — interactive learning drills, step-by-step worked trainers & diagnostic assessments.
  - \`genui_creative\` — audio/synth tools, color/typography/design systems & drawing/wireframe canvases.

` + generativeUI.body,
};
