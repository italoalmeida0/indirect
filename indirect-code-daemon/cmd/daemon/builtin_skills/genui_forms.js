export default {
  name: "genui_forms",
  description:
    "Craft guide for interactive forms, multi-step wizards, configurators, rubrics, and structured intake builders that attach or live-update data directly into the user's chat composer via window.__gu.attach.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Interactive Forms, Configurators & Live Attachments (genui_forms)

Turn multi-question back-and-forth into one crisp, tactile form, wizard, configurator, or review rubric whose structured output attaches directly into the user's composer draft so they can send it to you cleanly in one turn.

## 1. Mastering \`window.__gu.attach\` (Dynamic vs Static Attachments)
- **API surface (available on \`window.__gu\` and \`window.indirectUi\`):**
  - \`window.__gu.attach({ key?, name, content?, data?, mime?, dataUrl? })\` -> returns \`true\`/\`false\`
  - \`window.__gu.detach(key?)\` -> removes this widget's keyed attachment (or all attachments from this widget if omitted)
  - \`window.__gu.getAttachments()\` & \`window.__gu.onAttachmentsChange(fn)\` (returns unsubscribe) -> live list of \`{ key, name, mime, size, updatedAt }\` currently sitting in the user's composer draft!
- **Dynamic / updatable attachment (DEFAULT for forms, configurators, rubrics, live builders):**
  - Always pass a stable \`key\` (e.g. \`key: "project-brief"\`, \`key: "intake-form"\`, \`key: "config"\`).
  - The FIRST call creates one attachment chip in the composer; EVERY subsequent call with the SAME \`key\` **updates that exact chip in-place** (no duplicate files piling up!).
  - Track two lightweight states: \`attached\` (derived from \`onAttachmentsChange\` checking \`list.some((a) => a.key === SLOT)\`) and \`dirty\` (set \`true\` on edits after the last attach, cleared on attach).
  - Show a crystal-clear action button:
    - Not attached yet -> \`Attach to chat\` (\`.gu-btn-primary\`)
    - Attached & synced -> \`Attached ✓\` + subtle \`Detach\` (\`.gu-btn-ghost\`)
    - Attached & edited -> \`Update attachment\` (\`.gu-btn-primary\`) + \`Detach\`
  - Optionally support a compact \`Auto-sync\` toggle (\`.gu-toggle\`) that updates the keyed attachment on discrete changes once attached!
- **Static multi-snapshot attachments:**
  - When the user explicitly wants multiple distinct snapshots attached side-by-side (e.g. "Compare 3 configurations", "Attach Snapshot #1, #2"), omit \`key\` (or use distinct keys like \`"snap-1"\`, \`"snap-2"\`) and give each a numbered filename (\`config-1.json\`, \`config-2.json\`).
- **Canvas / visual snapshots:**
  - Any 2D/WebGL diagram, signature pad, mockup, or annotated board can attach an image via \`window.__gu.attach({ key: "sketch", name: "sketch.png", dataUrl: canvas.toDataURL("image/png") })\`!
- **Payload format for the AI:**
  - Prefer clean, self-describing **Markdown** (\`.md\`) for prose/intake/rubrics OR clean **JSON** (\`.json\`, passing a plain JS object in \`content\` or \`data\`) for structured specs/configs. Include only non-empty answers and clear labels.
  - Pair \`attach(...)\` with \`window.__gu.prefillPrompt("...")\` ONLY if the user clicks a dedicated \`Attach & draft prompt\` action — never auto-send without explicit intent so the user can review their chip and add notes before sending!

## 2. Airy form UX, progressive disclosure & mobile craft
- **Zero wall-of-fields:** Group > 5–6 inputs into **2–4 crisp \`.gu-tabs\` or stepped wizard tabs** (\`1. Basics\`, \`2. Scope\`, \`3. Constraints\`, \`Preview\`) with a slim \`.gu-progress\` bar or completion counter (e.g. \`4/6 answered\`).
- **Tactile input choices:** Prefer \`.gu-choice\` cards, \`.gu-chips\` multi-select pills, \`.gu-segmented\` toggles, and labeled \`.gu-slider\`s over boring walls of raw textboxes whenever options are bounded.
- **Live validation & preview:** Show inline concise validation only on missing required fields (<= 4 words), keep an optional \`Preview\` tab showing the exact Markdown/JSON payload that will attach, and persist in-progress form entries on discrete changes via \`window.indirectUi.saveState(form)\` so reloading never loses work!
- **Strict text budget & 390px mobile:** \`.gu-title\` <= 6 words, concise field labels, \`.gu-grid-2\` (auto-stacks to 1 column on mobile), sticky/bottom action bar wrapping cleanly in \`.gu-row\` with zero horizontal overflow.
`,
};
