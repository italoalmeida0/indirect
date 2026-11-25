import generativeUI from "skill:generative_ui";

export default {
  ...generativeUI,
  name: "generative_ui_talk",
  description: "Generative UI delivery for talk sessions (widgets mounted directly in reply text).",
  usable: "never",
  provides: ["generative_ui", "generative_ui_talk"],
  permissions: {
    ...generativeUI.permissions,
    widget_set: {
      policy: generativeUI.permissions.widget_set,
      args: {
        src_file: "deny",
      },
    },
  },
  body: `## Talk delivery & specialized craft subskills

- **Where the fence lives (CRITICAL):** \`widget_set\` alone renders NOTHING — always emit the \`generative_ui\` fence (with matching \`widget_id:\`) right at the top of your final reply text immediately after \`widget_set\` passes (never in files or tool output). Keep explanations and control tips concisely in your chat reply — NEVER repeat prose paragraphs inside the widget.
- **Authoring & edits:** Store new widgets with \`widget_set({ id, content, state })\`. To iterate on an existing widget, prefer targeted \`widget_edit\` over rewriting the whole source; inspect with \`widget_read\` / \`widget_list\`.
- **Load the matching domain craft subskill FIRST** via \`use_skill({ name: "<name>", once: true })\` before writing code for rich widgets (you may load 2 when combining domains, e.g. \`genui_games\` + \`genui_ai_apps\` for AI chess/RPG/fighting games):
  - \`genui_games\` — 2D & 3D playable games (arcade, action, 3D racing, first-person 3D arenas, persistent-world RPGs with save, physics, puzzle, strategy).
  - \`genui_ai_apps\` — AI-powered widgets using \`window.__gu.ai\` (LLM game opponents, live AI RPG NPCs, custom chatbots/harnesses with model & effort pickers, AI tutors/analyzers).
  - \`genui_forms\` — interactive forms, multi-step wizards, configurators, rubrics & structured intake builders syncing live attachments to chat via \`window.__gu.attach\`.
  - \`genui_dashboards\` — airy data dashboards, Chart.js / D3 analytics, Leaflet maps & scenario comparators.
  - \`genui_visualizers\` — general 2D & 3D interactive simulations, orbital/particle/ecological/fractal sandboxes & explanatory models.
  - \`genui_science\` — physics, chemistry, biology, medicine/clinical & mathematics interactive labs with governing equations and real units.
  - \`genui_spatial\` — architecture, true-to-scale 2D floorplans, 3D massing/solar studies, CAD/mechanical cross-sections & GIS/site layouts.
  - \`genui_business\` — finance/valuation/runway models, legal clause comparators & risk matrices, Gantt/roadmap/capacity & decision workbenches.
  - \`genui_education\` — active-recall courses, spaced-repetition flashcards, language/exam drills & step-by-step interactive trainers.
  - \`genui_creative\` — Web Audio synths/sequencers/DAWs, color/typography/design studios & interactive drawing/sketch canvases (exportable via \`attach\`).

` + generativeUI.body,
};
