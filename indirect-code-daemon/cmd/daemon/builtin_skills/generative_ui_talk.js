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
- **Load the matching domain craft subskill FIRST** via \`use_skill({ name: "<name>", once: true })\` before writing code for rich widgets — each gives battle-tested architecture, rendering craft, and mobile+desktop ergonomics:
  - \`genui_games\` — 2D & 3D playable games (arcade, action, 3D vehicle/track racing, first-person 3D arenas/corridors, persistent-world RPG/sims with save, physics, puzzle, strategy).
  - \`genui_visualizers\` — creative interactive labs/studios (generative audio/synth & audio-reactive visuals, orbital/particle/ecological sandboxes) plus 2D & 3D technical, scientific, spatial/architectural, math & professional instruments.
  - \`genui_dashboards\` — airy multi-view data dashboards, Chart.js / D3 analytics, Leaflet maps, financial/planning calculators & scenario comparators.

` + generativeUI.body,
};
