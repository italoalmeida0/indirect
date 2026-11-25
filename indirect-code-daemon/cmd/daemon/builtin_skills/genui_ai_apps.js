export default {
  name: "genui_ai_apps",
  description:
    "Craft guide for AI-powered widgets using window.__gu.ai: LLM game opponents (chess, strategy, fighting), real AI RPG NPCs, custom chatbots & prompt harnesses with agent-built model/effort pickers, and AI tutors or analyzers.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Embedded AI Apps, Opponents & Harnesses (genui_ai_apps)

Build interactive widgets that embed real live AI calls via \`window.__gu.ai\` (alias \`window.indirectUi.ai\`) — e.g. playing chess or fighting games against the AI itself, talking to living RPG NPCs, running a custom chatbot ("harness inception") with model/effort controls, or building interactive AI evaluators and tutors.

## 1. Embedded AI SDK (\`window.__gu.ai\`)
- **Read-only session context (works immediately on mount):**
  - \`const ctx = window.__gu.ai.getContext()\` -> \`{ model, modelName, effort, efforts, models, ready }\`
  - \`efforts\` items: \`{ id, label, description }\` (\`"none" | "minimum" | "low" | "medium" | "high" | "xhigh" | "max"\`)
  - \`models\` items: \`{ id, name, provider, context, output }\`
  - Subscribe to live updates: \`useEffect(() => window.__gu.ai.onContextChange(setCtx), [])\`
- **Inheriting vs overriding model & effort (CRITICAL):**
  - **Default inheritance:** When you omit \`model\` and/or \`effort\` in \`complete\`/\`stream\`/\`json\`, the host automatically uses the active session's current model and effort.
  - **Agent-authored controls (NEVER assume outside chrome exists):** There is NO automatic model/effort selector outside the widget. Whenever the user asks to pick models/effort (e.g. custom chatbot, prompt lab, chess strength/thinking tier, model comparator), build crisp \`.gu-select\` / \`.gu-segmented\` / \`.gu-chips\` controls INSIDE the widget populated from \`ctx.models\` and \`ctx.efforts\`, defaulting cleanly to \`""\` ("Session default · {ctx.modelName}") or \`ctx.model\` / \`ctx.effort\`!
- **Calling the model:**
  - \`await window.__gu.ai.complete({ system, prompt, messages, model, effort, maxTokens, temperature })\` -> \`{ text, reasoning, model, effort, finishReason, usage }\`
  - \`const req = window.__gu.ai.stream({ ..., onToken(delta, full), onReasoning(delta, full) })\` -> streams tokens live and resolves to the same result object; call \`req.abort()\` (or \`window.__gu.ai.abort()\`) on a \`Stop\` button!
  - \`await window.__gu.ai.json({ system, prompt, messages, model, effort, maxTokens })\` -> instructs JSON-only output, parses fenced or raw JSON automatically, and returns \`{ data, text, reasoning, model, effort, finishReason, usage }\`.

## 2. Battle-tested patterns by app type

### A. Turn-Based AI Opponents (Chess, Checkers, Go, Card/Board Strategy)
- Keep ALL game rules, legality checks, and board state deterministic in local JS — NEVER let the LLM mutate board state unchecked.
- Request structured moves with \`window.__gu.ai.json({ system, prompt, maxTokens: effort === "none" ? 256 : 1536, effort })\` passing compact state (e.g. FEN + numbered legal moves list) and asking for \`{"move":"e7e5","taunt":"..."}\` (concise 1-line note). (When using reasoning effort \`low..max\`, always leave \`maxTokens >= 1536\` or omit \`maxTokens\` so thinking tokens never starve the JSON output!)
- Validate \`res.data.move\` against the exact legal-move set! If invalid or rejected, retry ONCE with the error or fall back cleanly to a strong local heuristic move so gameplay NEVER stalls or crashes.
- Optionally let the user toggle AI thinking \`effort\` (\`Off / Low / Medium / High\`) inside the widget to control speed vs strength, and offer \`Attach\` (\`window.__gu.attach({ key: "match", name: "match.json", content })\`) to send the game PGN/board to the main chat AI for post-game analysis!

### B. Real-Time Action & Fighting Games vs AI
- **NEVER block the 60fps \`requestAnimationFrame\` loop awaiting an LLM call!** Run physics, movement, animations, and reactive reflexes continuously at 60fps in \`useRef\`.
- Trigger compact asynchronous tactical calls (\`window.__gu.ai.json\`, fast \`effort: "none"\`, \`maxTokens: 160\`, throttled every 1.5–3s or on round/HP milestones) returning a short tactical directive (e.g. \`{ stance: "aggressive"|"zoning"|"defensive", combo: [...], bark: "..." }\`) that steers the fighter's live behavior loop seamlessly!

### C. Living AI RPG NPCs & Interactive Narratives
- Pair with \`genui_games\` for the 2D/3D world canvas and \`window.indirectUi.saveState\` for persistent saves.
- Give each NPC a compact persona, memory array (cap at last 4–6 exchanges), and current world/quest flags. Stream replies live in a compact dialogue drawer via \`ai.stream\` (with a \`Stop\` button and crisp typing cursor), optionally parsing a structured end tag/JSON for mood, trade, or quest rewards.

### D. Custom Chatbots, Prompt Labs & Multi-Model Harnesses
- Build a clean chat surface: compact top bar with agent-authored \`Model\` (\`.gu-select\` with \`Session default\` + \`ctx.models\`) and \`Effort\` (\`.gu-select\` or \`.gu-segmented\` from \`ctx.efforts\`), optional system-prompt drawer/tab, scrollable message list (auto-scrolling during streaming), collapsible subtle reasoning disclosure when \`reasoning\` is present, and input bar with \`Send\` / \`Stop\` (\`req.abort()\`) + \`Clear\` + optional \`Attach transcript\` (\`window.__gu.attach({ key: "chat", name: "transcript.md", content })\`).

## 3. Reliability, cost hygiene & mobile ergonomics (CRITICAL)
1. **NEVER call \`window.__gu.ai\` on mount (\`useEffect(..., [])\`):** The host blocks unprompted mount-time LLM calls so reopening transcripts never burns credits. Always trigger AI calls from explicit user actions (e.g. \`Start Match\`, player move, \`Talk\`, \`Send\`).
2. **Always provide a \`Stop\` / \`Cancel\` control** while streaming/thinking, disable duplicate submits with an in-flight ref/state guard, surface clear inline errors (never silent hangs), and call \`window.__gu.ai.abort()\` inside \`useEffect\` cleanup on unmount.
3. **Keep prompts lean:** Send compact structured state and rolling recent history (<= 12–20 turns) rather than raw dumps, and honor the core text budget + 390px mobile zero-overflow layout.
`,
};
