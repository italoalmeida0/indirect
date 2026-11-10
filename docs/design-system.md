# Design system

The frontend design system lives in `web/src/ds/`. It follows Arc
(uiarc.dev, MIT): calm physical motion, a neutral oklch palette with one
accent spent with intent, concentric radii, weights 400 and 500 only, and a
reduced-motion branch for every animation. Arc is a React library; this is a
SolidJS implementation of its free (MIT) components and rules. Arc Pro items
are never reconstructed: Indirect Code's agent surfaces (tool rows, thinking,
plan, context usage) are original designs built from the free primitives.

```
web/src/ds/
  tokens.css        semantic tokens, themes, accents, density, focus ring
  components.css    ui-* component styles (stable class hooks)
  motion/           spring engine (WAAPI), presence, glide, press, morphs
  primitives/       layer stack (Escape/outside/inert), scroll lock, focus trap,
                    live-region announcer, roving focus
  components/       Solid components (Button, Dialog, Tooltip, Toasts, …)
```

`web/src/ui.tsx` keeps its historical exports (Btn, Modal, Select, Badge, …)
as thin adapters over `ds/`, so older screens get the new look without
call-site changes. New code may import from `ds/` directly.

## Tokens and utilities

Themes: `data-theme` on `<html>` is `light`, `dark` or `high-contrast`.
Accent: `data-accent` is absent (teal, the default) or `neutral`, `violet`,
`blue`, `green`, `amber`, `orange`, `coral`, `rose`. Density: put
`data-density="compact"` on a subtree (the Indirect Code workspace) for
tighter controls and smaller radii.

| Role | CSS variable | Tailwind utility |
| --- | --- | --- |
| Page | `--background` | `bg-background` |
| Surfaces | `--surface`, `--surface-raised`, `--surface-subtle`, `--surface-muted`, `--surface-strong` | `bg-surface`, `bg-surface-raised`, `bg-surface-subtle`, `bg-surface-muted`, `bg-surface-strong` |
| Text | `--foreground`, `--text-secondary`, `--text-muted` | `text-fg`, `text-fg-secondary`, `text-fg-muted` |
| Lines | `--border`, `--border-subtle`, `--border-strong` | `border-border`, `border-border-subtle`, `border-border-strong` |
| Accent | `--accent`, `--accent-strong`, `--accent-subtle`, `--accent-foreground` | `text-accent`, `bg-accent`, `bg-accent-subtle`, `text-accent-foreground` |
| Status | `--success`, `--warning`, `--danger`, `--info` (+ `-subtle`) | `text-success`, `bg-danger-subtle`, … |
| Categorical | `--tone-teal|sky|orchid|violet|rose|amber|green` | `text-tone-sky`, … |
| Charts | `--series-1..4` | (CSS) |
| Radii | `--radius-control` (18px), `--radius-panel` (26px), `--radius-surface` (34px), `--radius-pill` | `rounded-control`, `rounded-panel`, `rounded-surface`, `rounded-pill` |
| Shadows | `--shadow-resting`, `--shadow-raised`, `--shadow-floating` | `shadow-floating`, … |
| Type | `--text-2xs` (11, workspace metadata only), `--text-xs` 12, `--text-sm` 14, `--text-base` 16, `--text-lg` 18, `--text-xl` 22, `--text-2xl` 28, `--text-3xl` 36 | `text-xs`, … |
| Motion | `--ease-standard|enter|exit|in-out|spring`, `--duration-instant|fast|standard|considered|spring` | `ease-standard`, … |

Rules:

- Roles only: no raw hex, no Tailwind palette classes (`bg-rose-500`,
  `text-emerald-400`), no `--neutral-*`.
- The accent marks active, selected, progress and the emphasized data series.
  Status colors only for real status, always with a label or icon.
- Weights 400 and 500 only (`font-medium` for emphasis). No `uppercase`, no
  wide tracking, no eyebrow labels, no em dashes in copy, sentence case.
- Geist (`font-display`) only for headings of 30px and up; Inter for the rest;
  JetBrains Mono for code. `tabular-nums` for changing or aligned numbers.
- Nested corners are concentric: inner radius = outer radius - padding.
- Cards rest on a 1px border with no shadow. Shadows only on floating layers.
- No icons inside rounded tiles; no decorative gradients or glows.
- Keyboard focus uses the shared `:focus-visible` ring from `tokens.css`;
  never hand-made outlines; pointer focus shows no ring.
- Touch targets at least 44px on coarse pointers.

### Legacy aliases (being removed)

`ink-*`, `brand-*`, `card`, `elev`, `line`, `accent-400..700`/`accent-fg` still
resolve (onto the roles above) so unmigrated screens keep rendering. Migrate
with this table:

| Legacy | Use |
| --- | --- |
| `bg-ink-950` | `bg-background` |
| `bg-ink-900`, `bg-ink-850` | `bg-surface-subtle` |
| `bg-ink-800` (hover, fills) | `bg-surface-muted` |
| `bg-card` | `bg-surface` |
| `bg-elev` | `bg-surface-raised` |
| `border-line` | `border-border` |
| `border-ink-700`, `border-ink-600` | `border-border-strong` |
| `text-ink-100`, `text-ink-200` | `text-fg` |
| `text-ink-300`, `text-ink-400` | `text-fg-secondary` |
| `text-ink-500`, `text-ink-600` | `text-fg-muted` |
| `*-brand-*` | `text-accent`, `bg-accent`, `bg-accent-subtle` |
| `bg-accent-500 text-accent-fg` | `<Button>` primary, or `bg-fg text-background` |
| emerald / green | `success` |
| rose / red | `danger` |
| amber / yellow | `warning` |
| sky / blue used as status | `info` |
| `font-semibold`, `font-bold` | `font-medium` |
| `text-[10px]`, `text-[11px]` | `text-2xs` (workspace metadata) or `text-xs` |
| `text-[12px]` / `text-[13px]` | `text-xs` / `text-sm` |

## Motion

All motion goes through `web/src/ds/motion`:

| Token | Use |
| --- | --- |
| `spring.smooth` (0.4s, no bounce) | Panels, height, drawers, progress, anything that reports state |
| `spring.snappy` (0.26s) | Presses, toggles, thumbs, small indicators, icon swaps |
| `spring.morph` (0.42s) | Highlights that glide between options, width following content |
| `tween.fast` / `tween.exit` | Color and opacity; exits are faster than entrances |

- `animate(el, to, transition, { from, clear })`: final state first, played
  from the on-screen value, so every animation is interruptible. Identity
  transforms are removed on finish (no containing block is left behind for
  `position: fixed` descendants).
- `createPresence(open, { enter, exit })` keeps an element mounted until its
  exit finishes (Solid's replacement for AnimatePresence). `cssExit(el)` pairs
  with CSS `@starting-style` entrances for floating layers.
- `createGlide({ container, indicator, target })`: one persistent highlight
  that travels between items (segmented controls, tabs, nav rails, menus).
- `press(el)`: size-aware press scale (0.96 to 0.985). Elements that anchor a
  popup answer with color only.
- `expandHeight`, `collapseHeight`, `morphHeight`, `createMorphWidth`: size
  changes only when the size is the information.
- `usal("fade-u delay-100")` (web/src/motion.ts): one entrance on mount, only
  if on screen. No scroll reveal.

Rules: animate transform and opacity; one continuous movement per
interaction; nothing that reports state overshoots; bounce only for playful
moments; no loops unless they show live status; never animate nodes that
receive streaming tokens. Every animation collapses under reduced motion
(the engine does it for you; CSS needs a `prefers-reduced-motion` rule).

## Layers

`ds/primitives/layers.ts` owns one stack for dialogs, drawers, popovers,
menus and tooltips: the topmost layer gets Escape and outside clicks. While a
modal or drawer is open, `#app` is `inert`, page scroll is locked and Tab is
trapped. Floating surfaces are portaled and positioned with left/top by
`anchorFloat` (floating.tsx), which also sets `data-side` and a
transform-origin facing the trigger. Stacking order (tokens): sticky 20,
shell 30, drawer 40, modal 50, toast 60, floating 70.

## Components

| Need | Use |
| --- | --- |
| Action | `Button` (primary, secondary, ghost, danger; xs/sm/md/lg; `loading`) |
| Icon-only action | `.ui-icon-button` + `Tooltip` (gateway `IconBtn`) |
| Few related views | `SegmentedControl` (gateway `Segmented`) |
| Setting that applies now | `Switch` (or `SwitchCard` in forms) |
| Choice | `Checkbox`, radio (`.ui-radio`), `Select` |
| Decision | `Dialog` (gateway `Modal`) |
| Background result | `toast()` (never the only confirmation of a foreground action) |
| Inline message | `Alert` (gateway `ModalNotice`) |
| Status label | `Badge` |
| Loading | `Skeleton` in the final layout, `Spinner` inside controls |
| Nothing yet | `EmptyState` with one next step |
| Changing number | `RollingNumber` / `CountUp` |
| Work in progress text | `Shimmer` |
| Progress | `Progress` |

## Verification

- `bun test test/ds-motion.test.ts`: spring curves and roving focus.
- `PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-ui-visual-tour.ts`:
  boots an isolated fixture gateway and captures every screen in every theme
  and width; fails on page errors, horizontal overflow and (with `--axe`)
  serious accessibility violations.
