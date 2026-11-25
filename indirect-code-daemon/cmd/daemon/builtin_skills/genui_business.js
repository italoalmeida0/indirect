export default {
  name: "genui_business",
  description:
    "Craft guide for finance, valuation, legal/contract analysis, strategy, and project/operations workbenches: DCF/runway/cap-table models, clause risk matrices, Gantt/roadmap timelines, and weighted decision scorecards.",
  usable: "yolo",
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: `# Craft guide: Finance, Legal, Strategy & Operations Workbenches (genui_business)

Build an **executive-grade interactive workbench** where professionals test assumptions, compare clauses or scenarios, balance capacity, and reach quantitative decisions in seconds — clean, airy, exact, and free of cluttered spreadsheet noise.

## 1. High-value professional workbench patterns
- **Finance, Valuation & Capital Modeling:**
  - SaaS unit economics / runway / burn, DCF & WACC sensitivity matrix, loan/mortgage amortization with extra-payment impact, startup cap-table & dilution rounds, tax/pricing tier margin simulators, and portfolio risk/return allocators.
  - **Accounting precision:** Allocate integer cents (or exact basis points) on splits so totals sum strictly without rounding drift; format currency & percentages cleanly with \`Intl.NumberFormat\`; show break-even / payback / IRR / NPV cleanly in **3–4 hero KPIs** + ONE primary Chart.js/SVG visual + tabbed \`Assumptions\` / \`Schedule\` / \`Sensitivity\` views.
- **Legal, Compliance & Contract Review Tools:**
  - Interactive clause-by-clause comparator (Standard vs Counterparty vs Fallback positions with risk severity badges \`.gu-badge-ok\`/\`-warn\`/\`-danger\`), contract obligation/deadline timeline (interactive SVG), negotiation redline selector, and compliance readiness checklists.
  - Pair seamlessly with \`window.__gu.attach({ key: "legal-review", name: "positions.md", content })\` so the lawyer/operator toggles acceptable fallback clauses or flags redlines and attaches their exact structured decisions back to chat!
- **Project, Product & Operations Planning:**
  - Interactive Gantt / roadmap timeline (SVG with phase bars, milestone diamonds, dependency connectors, critical-path highlight, tap-to-inspect task drawer & duration slider), team capacity/sprint allocator, RACI/risk heatmaps, and weighted multi-criteria decision scorecards (adjustable criterion weights auto-normalized to 100%, live ranked bars).

## 2. Executive restraint & mobile-first polish
- **Strict text budget (CRITICAL):** \`.gu-title\` <= 6 words, optional \`.gu-caption\` <= 8 words (e.g. \`Illustrative model · adjust inputs below\`). NEVER put legal disclaimers, methodology essays, or verbose bullet walls inside the widget — put those concisely in your chat reply.
- **One focal view at a time:** Use **2–4 \`.gu-tabs\`** (\`Overview\`, \`Sensitivity\`, \`Table\`) and **3–4 scenario presets** (\`Base\`, \`Upside\`, \`Downside\`) instead of stacking 5 tall cards vertically.
- **Clean tables & charts:** Wrap tables in \`.gu-table-wrap > .gu-table\` with <= 4–5 concise columns and \`className="num"\` right-aligned tabular numbers. Keep SVG \`viewBox\` balanced (540–640) with zero overlapping labels and \`--gu-*\` tokens only. Persist user scenario inputs via \`window.indirectUi.saveState(...)\`.
`,
};
