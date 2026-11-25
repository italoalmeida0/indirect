export default {
  name: "genui_education",
  description:
    "Craft guide for interactive learning studios, spaced-repetition flashcards, language drills, exam/certification prep, worked step-by-step problem trainers, and diagnostic quizzes with saved progress.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Interactive Learning, Drills & Assessment Studios (genui_education)

Build an **active-recall learning instrument** where the learner practices, gets immediate visual feedback, tracks mastery across reloads, and drills weak spots — NEVER a static wall of lecture notes disguised as a card.

## 1. High-retention interactive formats
- **Spaced-Repetition Flashcards & Language Studios:**
  - Crisp flip/reveal card stage (tap card or press \`Space\` to reveal; keyboard \`1–4\` or tactile \`.gu-btn\` rating buttons \`Again / Hard / Good / Easy\` updating real SM-2/Leitner box intervals), optional Web Speech pronunciation (\`speechSynthesis\`, guarded with feature check and triggered only on click), deck/category filter chips (3–5 chips), and mastery progress bar (\`.gu-progress\`).
- **Worked Step-by-Step Problem Trainers (Math, Code, Grammar, Music Theory, Clinical/Bar Exams):**
  - Present ONE focused problem at a time with interactive choices (\`.gu-choice\`), fill-in input, ordering/matching chips, or interactive diagram manipulation.
  - Reveal concise step-by-step hints progressively (\`Hint 1\` -> \`Hint 2\` -> \`Solution\`) instead of dumping an essay; on submit, highlight exact right/wrong feedback with semantic \`--gu-ok\` / \`--gu-danger\` cues and 1 short takeaway line (<= 15 words).
- **Adaptive Diagnostic & Mastery Summary:**
  - Track accuracy by subtopic (compact \`.gu-bars\` breakdown in a \`Progress\` tab), offer a \`Drill Weak Spots\` filter, and persist streak, mastered IDs, and deck progress via \`window.indirectUi.saveState(...)\` on every answer/rating!

## 2. Optional live AI tutoring & session handoff
- **Optional Socratic hints / custom practice generation (\`window.__gu.ai\`):** When helpful (e.g. language conversation practice, free-response grading, infinite fresh exercises), offer an explicit \`Ask AI Hint\` / \`Check Answer\` / \`Generate Next\` button calling \`window.__gu.ai.complete\` or \`window.__gu.ai.json\` (inheriting the session model by default; never call on mount!).
- **Send weak spots back to the session AI (\`window.__gu.attach\`):** At any point or on quiz completion, offer a crisp \`Attach results\` button (\`window.__gu.attach({ key: "quiz-results", name: "practice-summary.json", content })\`) summarizing score, missed questions, and weak topics so the user can ask you in chat to teach exactly what they missed!

## 3. Clean ergonomics & 390px mobile craft
- **One question/card centered with breathing room:** \`.gu-title\` <= 6 words, compact top progress strip (\`Card 4/12 · 83% · Streak 3\`), zero cluttering sidebars, >= 44px tap targets on answer buttons, and zero horizontal overflow on 390px phones.
`,
};
