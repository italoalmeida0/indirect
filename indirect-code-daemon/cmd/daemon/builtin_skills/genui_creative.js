export default {
  name: "genui_creative",
  description:
    "Craft guide for music & audio studios (Web Audio synths, drum machines, chord/scale sequencers), graphic/UI design tools (color, contrast, typography, CSS/gradient labs), and interactive drawing, pixel-art, or wireframe canvases.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Audio/Music, Design & Visual Creative Studios (genui_creative)

Build a **tactile creative studio** that feels instantly playable and rewarding — synthesizers, step sequencers, chord/scale labs, color/typography/gradient design systems, pixel/vector/wireframe sketchpads, and procedural art generators.

## 1. High-craft creative studio patterns
- **Web Audio Synthesizers, Drum Machines & Sequencers:**
  - Create/resume \`AudioContext\` strictly inside a user gesture (Play/pad click/keydown) and close it in \`useEffect\` cleanup.
  - Use lookahead scheduling (\`ctx.currentTime\`) rather than sloppy \`setInterval\` note triggers so grooves stay rock-solid; pipe master output through a \`DynamicsCompressorNode\` + \`AnalyserNode\` driving a crisp 60fps DPR \`<canvas>\` oscilloscope or spectrum visualizer!
  - Include **3–4 musical presets** (e.g. \`Lo-Fi\`, \`Synthwave\`, \`House\`, \`Ambient\`), BPM slider, swing/filter/reverb or ADSR controls in compact tabs, playable piano/pad/step grid with >= 36–44px touch targets, and a crisp \`Play\`/\`Stop\` + \`Mute\` bar.
- **Color, Contrast, Typography & Design System Labs:**
  - Live WCAG contrast ratios (exact relative-luminance math with AA/AAA badges), harmonious palette generators (OKLCH/HSL complementary, analogous, split, semantic ramp), modular type-scale previewers, and interactive shadow/gradient/easing-curve editors with selectable CSS preview blocks (\`<pre>\`) and one-tap \`Attach tokens\` (\`window.__gu.attach\`, since \`navigator.clipboard\` is blocked in the sandbox)!
- **Interactive Drawing, Pixel-Art, Diagram & Wireframe Sketchpads:**
  - DPR-scaled \`.gu-canvas-interactive\` (or crisp SVG) supporting unified pointer/touch drawing (\`onPointerDown\`/\`Move\`/\`Up\` with \`setPointerCapture\`, \`touchAction: "none"\`), brush/shape/eraser/color tools, undo/redo stack (keep snapshots bounded, e.g. <= 20 steps), grid toggle, and clear button.
  - **Attach artwork directly to the session AI (\`window.__gu.attach\`):** Include a crisp \`Attach sketch\` / \`Update sketch\` button using \`window.__gu.attach({ key: "canvas-sketch", name: "sketch.png", dataUrl: canvas.toDataURL("image/png") })\` (or structured JSON/CSS tokens for design studios) so the user can sketch a UI wireframe, diagram, or visual edit and send it straight to you in chat!

## 2. Studio polish, restraint & mobile ergonomics
- **Stage first, tools grouped cleanly:** Give the live canvas, sequencer grid, or design preview 65–80% of attention; group secondary palettes/parameters into **2–3 \`.gu-tabs\`** instead of dumping 20 tiny controls at once.
- **Strict text budget & dual-theme chrome:** \`.gu-title\` <= 6 words, zero essays inside the studio, use \`--gu-*\` tokens for all studio chrome (rich palettes live inside swatches/canvases), persist user patch/palette/settings via \`window.indirectUi.saveState(...)\`, and verify zero overflow at 390px mobile width.
`,
};
