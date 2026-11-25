export default {
  name: "genui_games",
  description:
    "Craft guide for 2D & 3D playable games (arcade, action, 3D track/vehicle racing, first-person 3D arenas, persistent-world RPG/sims with save, physics, puzzle, strategy): crisp rendering, tactile feel, desktop + mobile touch controls, and save persistence.",
  usable: "yolo",
  mode: "talk",
  requires: ["generative_ui_talk"],
  body: `# Craft guide: Playable 2D & 3D Games (genui_games)

Games are exempt from \`.gu-*\` chrome rules — build a **full-bleed (\`width: 100%\`) atmospheric game stage** (\`.gu-game-stage\`) where **85–95% of the footprint is the live playable world** (never wrap a game in a cramped centered box, fake bezel, or verbose \`.gu-header\` + tutorial paragraph above the canvas; put controls/rules briefly in your chat reply).

## 1. Choose the right engine & loop
- **2D arcade, action, platformer, top-down, persistent-world RPG:** High-DPI 2D \`<canvas>\` sized with \`window.__gu.fitCanvas(canvas)\` (\`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)\` so coordinates stay in CSS px).
- **2D rigid-body physics:** \`matter-js\` (\`Matter.Engine.update(engine, Math.min(dtMs, 33))\`) rendered onto YOUR OWN DPR-scaled 2D \`<canvas>\` with custom gradients, trails, and impact particles.
- **3D racing, flight, first-person arenas, spatial action:** \`three\` (optionally with \`cannon-es\`, \`world.step(1 / 60, Math.min(dt, 0.05), 3)\`), OR for ultra-crisp retro first-person corridors, a high-DPI 2D \`<canvas>\` DDA textured raycaster + depth-buffered sprites.
- **Zero-stutter React boundary:** Keep ALL per-frame state (entities, physics, particles, shake, held keys/touch, phase) in one \`useRef\`. Bridge React UI buttons to the canvas loop via \`useRef\` callbacks — NEVER attach handlers to \`window.*\`. Clamp \`dt = Math.min((now - last) / 1000, 0.05)\`. NEVER call \`setState\` every frame — sync HUD snapshots only on change or at <= 10 Hz. Clean up rAF, listeners, \`ResizeObserver\`, WebGL resources, and \`AudioContext\` on unmount.
- **Live attract scene on frame 1 (NO dimmed veil, NO control modal):** Render the bright, animated world at 100% clarity immediately on mount (NEVER cover the stage with a dark/blurred full-screen scrim or a large modal card filled with control-hint paragraphs!). Float ONLY a compact title (<= 4 words) + \`Play\` (or \`Continue\` / \`New\`) pill in upper-center clear of both the hero/weapon AND bottom touch controls — put instructions briefly in your chat reply.

## 2. General-purpose high-craft game patterns

### A. 3D Track, Vehicle & Camera-Follow Games (\`three\`)
- **Rich closed-loop world:** Build a smooth circuit (\`THREE.CatmullRomCurve3(pts, true)\` sampled into road ribbon + alternating red/white curb strips + trackside pylons/trees/arches) with procedural \`THREE.CanvasTexture\` asphalt/grass/checker patterns, luminous sky + matching \`THREE.FogExp2\`, and multi-light rig (\`HemisphereLight\` + directional key + accent lights).
- **Kinesthetics & rivals:** Responsive steering, drift slip angle with visible chassis lean/sparks, drift-boost or pad/pickup speed surge with smooth \`camera.fov\` kick, damped chase camera (\`1 - Math.exp(-k * dt)\`), and AI rivals following the spline with lateral lane offsets and gentle pacing.
- **Compact HUD & touch:** Corner minimap showing loop + player/rival dots, 1–2 tight top-left pills (\`Lap 1/3 · P2 · 118\`), desktop \`WASD\`/Arrows + \`Space\` (drift/boost), and \`.gu-touch-controls\` with bottom-left \`◀\`/\`▶\` steer + bottom-right \`Boost\`/\`Drift\` (auto-throttle or gas toggle on touch so thumbs steer effortlessly!).

### B. 3D First-Person Corridor, Arena & Exploration Games
- **Depth, texture & feedback:** Procedural \`CanvasTexture\` stone/metal/hazard walls, clear floor/ceiling contrast, dynamic lighting/fog, animated foreground weapon/tool viewmodel (walk bob, recoil kick, muzzle flash), grid collision with smooth axis-separated wall sliding, active enemy AI (patrol/chase/attack/hit-flash/particles), crisp crosshair + hitmarker + brief damage flash, and compact corner radar.
- **Sandbox-safe controls (NO pointer-lock dependency):** \`requestPointerLock\` degrades quietly in sandboxed iframes — NEVER rely on it! Always support: **pointer-drag anywhere on canvas to turn/aim** + \`WASD\` (move/strafe) + \`ArrowLeft\`/\`ArrowRight\` or \`Q\`/\`E\` (turn) + click/\`Space\` (fire/act). On touch, mount \`.gu-touch-controls\` with bottom-left \`.gu-dpad\` (forward/back/turn or strafe) + drag-to-aim on stage + bottom-right \`.gu-touch-btn-primary.gu-touch-btn-round\` (\`Fire\`).

### C. Persistent-World / RPG / Simulation Games with Real Save
- **Living explorable world:** Crisp tiled/biome 2D canvas with distinct zones/landmarks, NPCs, enemies/resource nodes, smooth camera follow, tap-to-move/interact + D-pad/\`WASD\`, floating damage/\`+XP\`/\`+Gold\` popups, and a real loop (combat/gathering, quests, XP/levels, gold, inventory/upgrades).
- **Calm mobile-friendly UI:** Hero world canvas on top + ONE compact bottom drawer with \`.gu-tabs\` (e.g. \`Quests\`, \`Bag\`, \`World\`) and live feed capped at **max 3 concise lines** — never stack huge stat tables and prose logs over the world on a 390px phone!
- **Real save & restore (\`window.indirectUi.saveState\`):**
  - Export/use pure \`serializeSave(s)\` (plain JSON <= 64 KB: zone, x/y, level, XP, HP, gold, inventory, quest progress) and \`hydrateSave(props)\` merging initial \`App(props)\` cleanly on mount (saved state automatically shallow-merges over fence \`state:\` on reload!).
  - Auto-save on meaningful discrete events (level-up, quest turn-in, combat victory, purchase, zone switch) AND provide a crisp \`Save\` button that calls \`window.indirectUi.saveState(snapshot)\` and flashes a subtle \`Saved\` badge, plus a two-tap \`Reset\` -> \`Confirm?\` flow that resets to defaults and calls \`saveState(defaults)\`. Never save per frame and never touch \`localStorage\`.

## 3. Visual craft, audio & responsive mobile+desktop ergonomics
- **Procedural craft:** Procedural \`CanvasTexture\` / crisp canvas silhouettes, luminous lighting (never dark murky geometry on pitch black), motion/thrust trails, velocity-stretched hit particles, 3–5px damped screen shake, and optional procedural Web Audio SFX (unlocked lazily on first click/tap/keydown, with a compact Mute toggle).
- **Lean HUD, frosted pills & clean minimap:** Put ALL top overlays inside ONE \`.gu-stage-hud\` bar with **strictly MAX 2–3 compact frosted \`.gu-hud-pill\` items** so nothing ever wraps onto a second row at 356px mobile width (combine related stats like \`Lap 1/3 · P2 · 118\` into one pill, and put Mute/Pause/Reset icons INSIDE a frosted \`.gu-hud-pill\` — never bare invisible icons floating on sky/canvas!). **NEVER add a custom fullscreen (\`⛶\`) button** — the host toolbar already provides Fullscreen, Reload, and Reset (keep top-right ~140px clear on desktop; mobile docks the host toolbar above the iframe). Place any corner minimap cleanly below the HUD row (\`top >= 52px\`) or in a clear opposite corner, and construct closed SVG \`<path d>\` strings cleanly (\`pts.map((p, i) => \`\${i ? "L" : "M"}\${p.x},\${p.y}\`).join(" ") + " Z"\`, never trailing \`L Z\`).
- **Bulletproof, uncluttered touch controls (\`>= 44px\`):** Always include working touch controls via \`.gu-touch-controls\` (bottom-corner overlay leaving open center playfield space) or \`.gu-touch-bar\` (docked below stage) using \`.gu-touch-btn\`, \`.gu-touch-btn-primary\`, \`.gu-touch-btn-round\`, \`.gu-touch-group\`, and \`.gu-dpad\`. On 356px mobile width, keep bottom-left to **ONE compact cluster** (\`.gu-dpad\` OR \`◀\`/\`▶\` steer) and bottom-right to **1–2 action buttons** (\`Fire\`, \`Drift\`/\`Boost\`) with clear open space between them — NEVER cram 5–6 buttons shoulder-to-shoulder across the bottom row (use direct canvas drag-to-aim instead of extra turn buttons). Bind held inputs with \`onPointerDown\` + \`onPointerUp\` + \`onPointerCancel\` + \`onPointerLeave\` updating your held-keys \`useRef\` (and \`e.preventDefault()\` on \`Arrow*\`/\`Space\` in \`keydown\`).
- **Responsive & true fullscreen fill:** Size \`.gu-game-stage\` to \`width: 100%\` and \`height: isFs ? "100vh" : "clamp(360px, 58vh, 460px)"\`, subscribed to \`window.__gu.onFullscreen(setIsFs)\` (initialized from \`window.__gu.isFullscreen\`), with \`ResizeObserver\` re-fitting the canvas/Three.js renderer seamlessly on 390px mobile, desktop, and fullscreen.
`,
};
