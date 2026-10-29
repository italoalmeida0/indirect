# AGENTS.md — indirect

Two projects: Bun gateway (`server/`, `web/`) and Indirect Code Go daemon
(`indirect-code-daemon/`, separate `go.mod`). Current focus: Indirect Code
frontend + daemon. Run checks from the appropriate project root.

## Scope and architecture

- Gateway (`server/index.ts`): `/v1/*` proxies LLM requests; `/api/*` serves
  dashboard and relay; `/*` serves the SPA. `server/routes/relay.ts` is only a
  fan-out pipe: daemon → user's clients, client → daemon selected by hostId.
  **The daemon owns sessions, projects and config on disk.** Do not make the
  gateway or browser an alternate source of truth.
- Indirect Code frontend: `web/src/indirect-code/`; daemon: `indirect-code-daemon/`
  (`cmd/daemon`, `packages/agent|core|provider|runner|…`, Go 1.26).
- Skills are JavaScript ES modules (`packages/skills` over `packages/qjs`):
  each `.js` module's default export is one skill object. Builtins are
  embedded `builtin_skills/*.js` with reserved names; user skills live in
  `<slot>/skills/*.js`. **Composition is JavaScript, not Go**: a module imports
  another skill with `import base from "skill:<file stem>"` (builtins
  included) and decides what to keep with spread and concatenation
  (`{ ...base, name, permissions: { ...base.permissions, edit: "deny" }, body:
  base.body + "…" }`). There is no `inherit` key, no `require` and no
  `skill.extend`, and the loader/`Effective` chain never merges skill objects:
  a base reaches the model because the importing module put its body there.
  Base-only skills stay in the store as ordinary modules (`usable: "never"`)
  and are not injected by anything. The sandbox is restricted and pure: a
  fresh QuickJS runtime per module graph exposes no file, process, network,
  timing or dynamic-code access (`eval`, `Function` and the derived
  constructors are removed before module code runs), imports resolve only
  through the Go callback for `skill:` specifiers, and cycle detection, a
  graph budget, a memory cap and a per-graph timeout bound a hostile file.
  The snapshot boundary accepts plain data only (functions, symbols, class
  instances, accessors, cycles and non-finite numbers are rejected with a
  load error).
  Only `.js` files in `skills/` are skills; any other file is ignored. The
  first shipped format WAS JavaScript, so there is no earlier skill format
  and no conversion step — storage migration v5 only rewrites session meta
  (mode collapse, talk sessions to Home).
- QuickJS is linked LATE: `packages/qjs/lib/<platform>/libquickjs.a` holds the
  prebuilt engine (fastcompiled once, never rebuilt here) and
  `link_<os>_<arch>.go` files select it per target. `packages/qjs/shim.c` is
  the only C compiled by this repo and it never recompiles QuickJS. That makes
  the daemon a cgo binary: every build/test needs `CGO_ENABLED=1` and a C
  linker driver matching the archive's ABI, which `scripts/indirect-zig.ts`
  provides: zig is PINNED (0.17.0, per-host SHA256) and resolved from `$ZIG`,
  a vendored `scripts/toolchains/` archive, `~/.cache/indirect-code/toolchains`,
  a matching `zig` on PATH, or a verified download — in that order.
  `bun run toolchains:vendor [--all]` prefetches for offline builds; the
  vendored archives are gitignored on purpose (the six host toolchains are
  ~400 MB and the Windows build alone is at GitHub's per-file limit), so never
  commit them. Never set `CGO_ENABLED=0` for daemon builds, and keep linux
  artifacts static/glibc-free (`musl,static` tags — CI runs them on bare Alpine).
- Browser mirror: SignalDB in `store/sessions.ts` / `hooks/useMirror.ts`, one
  store per hostId, persisted in IndexedDB. Mutations are daemon commands;
  `saveSession`/`saveProjects`/`saveConfig`/`purgeSession` send debounced (300ms)
  `{type:"change", collection}` pings; clients pull whole snapshots with
  `{type:"pull", id, collection}`. No pushes or per-field WS mirror events.
  Project deletion cascades `purgeSession` for every conversation; a late turn
  must not recreate deleted data.
- Transcript streaming (`agent_event`, `session_content`, attachments, search)
  remains event-driven, not part of mirroring. Tool results display on their
  assistant carrier; `srcIdx` maps display messages to raw daemon indices.
  Collapsing the composer hides input, toolbar, footer AND the entire task plan;
  it is unavailable in `draftMode` or a blocked workspace.
- Frontend: SolidJS + Tailwind v4. Use semantic theme tokens (`ink-*`,
  `accent-*`, `brand-*`, `card`/`elev`/`line`), not hardcoded hex. UI kit in
  `web/src/ui.tsx`; `usal` helpers in `web/src/motion.ts`. Never put `data-usal`
  on Modal/toasts: retained transforms break fixed positioning. Modal entrance
  uses fill-mode `backwards`, not `both`. Solid memos evaluate eagerly: declare
  dependencies above `createMemo` (typecheck cannot catch initial-render TDZ).
- Gateway catalog screens share `web/src/catalog.tsx` and external include/exclude
  filters. Desktop blocks and mobile pages use the same server query. AG Grid is
  fixed-order, automatically sized and sort-only; persist sort state only.
  Model selections are shared across cards and tables, capped at 10,000 IDs;
  Selected only queries send IDs in a POST body. Audit reads use bounded workers.
- Daemon process helpers: `packages/proctable` powers `KillTree` (including
  setsid'd descendants); `packages/linereader` replaces `bufio.Scanner` for
  unbounded input such as SSE. Kills escalate TERM → grace → KILL + tree sweep;
  POSIX signal exits report 128+signal. Windows children need UTF-8 env/stdio.
  Keep Go dependencies minimal; no cgo.
- One multi-call binary: default role boots/checks/migrates/verifies and
  self-spawns the worker; boot never downloads. `--worker`, `--update-start`,
  `--update-end`, `--slot` select worker mode. Release artifact is
  `indirect-code-<goos>-<goarch>`; `versions.json` has one `daemon` field.
  V1→V2 migration is manual; release and CI run
  `scripts/verify-release-dist.ts`.

## Daemon actor invariants

`cmd/daemon` uses one `sessionActor` goroutine per session (`inbox` + priority
`control`), supervised by `root` → `sessionSup`/`bgSup`/`ws`/`projects`.
`epoch`/`gen` reject stale worker messages; `cancelRounds` can quarantine.

1. Each actor owns its state; communicate through mailboxes, never a lock
   spanning actors.
2. Watchdog kill is a crash: recover from disk/WAL, not partial memory state.
3. Mailboxes are bounded; full inboxes answer busy or drop with a counter.
4. Drain `control` first; never silently lose an accepted cancellation.
5. Trace respawns, quarantines, dropped messages and stale-worker rejections.
6. Liveness uses progress (`lastProgress` + declared waits), not CPU time;
   upgrades use slot swap, not hot loading. Do not build a mini-OTP framework.

## Runner and background tasks

- Protocol details: `docs/runner-protocol.md`, `docs/runner-plan.md`.
  Every bash/python command runs in a self-copied `--runner`, starting immediately.
  It appends to `runners/out/<sessionId>__<jobId>__<startedAt>.log` (filename is
  identity, GC-exempt) and COPIES the log to `brain/` at terminal transitions.
  `runners/<job>.state.json` is the recovery contract; loopback IPC is only an
  optimization. Runner records pid/pgid and reaps the whole command tree before
  recording completion.
- Durable `runners/<jobId>.disposition` is `background`, `inline`, or
  `suppressed` (absent = inline). Only background outcomes wake the agent.
  Recover runner jobs ONLY via state files; adopt live runners at boot, kill
  unlinkable/old orphans. Retain terminal background notices until a durable
  transcript fold is acknowledged; `background_delivery` deduplicates retries.
- At `AutoBackgroundAfter` (10s), return a placeholder naming the brain log;
  completion notices contain NO result text. Model `bg_cancel` stays silent;
  dashboard Stop delivers a cancellation notice. `bg_await` wakes on transitions.
  Frontend folds terminal snapshots into the original row;
  `normalizeSessionMessages` preserves folds across snapshots. Session deletion
  drops pending notices; late delivery must never resurrect a session.

## Generative UI widgets

- The `generative_ui` fence carries HEADER LINES ONLY: `widget_id:` (links the
  session widget store), `placeholder:`, `state:` (JSON default). The TSX
  source lives in `SessionRecord.Widgets` (WAL `widgets` replace events),
  stored by the `widget_set` tool — never in the transcript.
  Fence headers use `widget_id:` (never `id:`) so the link to the store is
  explicit.
- Tools: `widget_set`/`widget_list`/`widget_lint` everywhere; `widget_read`
  and `widget_edit` are talk-only (the other modes have a real terminal:
  write the source as a file, import with `widget_set {id, src_file}`).
  Tool outputs mirror the native create/inspect/read/edit shapes so the
  frontend bodies are copy-paste; widget edits never produce change balloons.
- Every `widget_set` lints at the gateway (`POST
  /api/indirect-code/gen-ui/lint`, daemon token): compile → import audit →
  smoke render in the Obscura lint browser → optional `test` code importing
  the widget module. Lint compiles with sucrase + source map (the API path
  keeps Bun.Transpiler), so findings and runtime stacks carry ORIGINAL
  source lines and a `createCodeFrame` snippet pointing at the region to fix. One obscura process per lint (`obscura fetch file://…`),
  auto-downloaded into DATA_DIR at gateway boot (stealth build; no fallback
  browser). The model-code audit also neutralizes sandbox escapes
  (constructor/__proto__/prototype, receiver fetch/XHR, reflection, global
  writes).
- Snapshots carry widget METADATA only; sources are fetched over the relay
  with `get_widget` → `widget_data` and cached until a widget tool runs.
- Widget state persists to localStorage (`gu:state:<host>:<session>:<id>`)
  only through the explicit `window.__gu.saveState()` hook (never reactive);
  the saved state wins over the fence `state:` default at mount.
- Legacy fence shapes are migrated at session load (no legacy runtime path):
  `@jsx` bodies become plain ```jsx code fences, the oldest headerless shape
  is dropped. The system prompt documents only the `id:` format.

## Gateway constraints (when touching gateway code)

- SQLite migrations in `server/db.ts` are append-only. `bun:sqlite` `.changes`
  includes FK cascades: count deletions by existence. Never log/serialize
  provider keys, plaintext gateway keys, TOTP secrets or `GATEWAY_SECRET`.
- `/v1/*` errors use the matching OpenAI/Anthropic envelope; dashboard errors
  use `{success:false,error}`. Upstream error bodies pass through
  byte-for-byte only when they are same-protocol JSON; a different client
  protocol or a non-JSON body (HTML interstitial, plain-text banner) is
  re-enveloped, since the response content-type is always clamped to JSON.
  Audit every admin/user mutation. Budgets are
  SQLite-backed USD allowances: account plans have monthly caps and optional
  proportional weekly/5-hour caps; API keys have independent daily/lifetime
  USD caps. Admission reserves balances atomically; settlement freezes prices.
  Resets forgive only settled weekly/session usage, preserve monthly/key spend
  and renewal times, and consume an audited, assignment-bound grant. Keep
  input/cache/output metrics separate. See `docs/gateway-billing.md`.
  Gateway key delete is soft by default; usage ledger survives deletion.
- Failover (`server/failover.ts`) only before first byte reaches client. Never
  auto-disable/skip a provider key: only explicit admin `disabled` skips.
  Billing, auth, rate limit, transient and model-not-found errors may advance
  this request; other 4xx do not. Return real upstream errors + Retry-After;
  keep 2xx streams incremental. Sticky winner is per routing lane, in memory.
- `model_targets` is the ordered fallback chain; top target/key are mirrored
  into `models`/`providers` via `refreshModelMirror`/
  `refreshProviderKeyMirror`. `server/proxy/gateway-ir.ts` translates protocols
  through one IR; target quirks live in `target-profile.ts`. DSML recovery in
  `dsml.ts` requires declared tools, a closed invoke and a matching tool name;
  incomplete candidates restore bytes, native tool calls remain untouched.
- `server/usage.ts`: rollups drive breakdown queries, not raw events. OpenAI
  prompt tokens INCLUDE cached tokens; Anthropic input tokens do not. Estimate
  only all-zero upstream usage when content crosses the wire; never replace
  nonzero upstream figures. Keep input/cache/output separate; analytics summary
  headlines also show their sum, as explicitly requested.
- Model registry (`server/models.ts`): `passthrough` forwards names; `router`
  rejects unknown/disabled (404) and orphaned/unavailable (503), rewrites model
  per target, records public ids. Mutations invalidate `routerSnapshot()`.
  Model ids may contain `/`: encode UI ids, match bulk-delete before `/:id`.
- Proxy request bytes stay untouched except OpenAI stream
  `stream_options.include_usage`, chosen by `route.upstreamPath`. SSE relay is
  pull-based; hold concurrency slot until stream ends. Do not count client
  disconnects as circuit-breaker failures. Clamp upstream Content-Type to
  json/sse/plain and strip upstream security headers. Set Bun `idleTimeout`
  above `LIMITS.proxyStreamIdleMs` (240 > 180s; max 255).
- Build SPA with `plugins/solid-plugin.ts` (Babel 7/isTSX, not Babel 8).
  Avoid new crypto libs. `streaming-markdown@0.2.15` is patched; preserve
  `data-streamdown` CSS hooks. Keep `ag-grid-community@31.1.1` pinned exactly
  to the `solid-ag-grid` version. `@floating-ui/dom` overlays use `<Portal>`;
  z-index order: modal 50 < toast 60 < floating 70; position via left/top.

## Commands and handoff

- Gateway root: `bun run lint`, `bun run typecheck`, `bun test`,
  `bun run build:web`. Daemon root: `CGO_ENABLED=1 go test ./...` (real child
  processes; no Go linter configured; zig provides the C linker driver when
  needed). Add black-box tests when adding gateway routes.
- After implementation changes leave local builds: `bun run build:web` for SPA;
  `bun run build:daemon` for local daemon (via the pinned zig toolchain);
  `bun run build:daemon:all` for daemon changes (refreshes committed
  `indirect-code-daemon/dist/` and SHA256SUMS.txt; each artifact is verified
  by `scripts/verify-daemon-binary.ts` — format, machine, static linking and
  linked engine symbols); `bun run build` builds both SPA and all daemon
  platforms. `dist/` and `indirect-code-daemon/bin/` are gitignored local
  builds; `packages/qjs/lib/**` IS committed (the engine archives are part of
  the source tree).
- `bun run dev` / `bun run dev:web` start backend :3000 / frontend :5700;
  `bun start` starts backend without a separate build.
- Browser UI checks are external Playwright scripts, not `bun test`:
  `PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-<name>-ui.ts`.
  Full-stack `test-indirect-bg-e2e.ts [finish|cancel]` and
  `test-indirect-compaction-e2e.ts [manual|auto|chain|overflow|all]` require
  `dist/`, daemon binary and `META_API_KEY`; run manually when affected.
- CI: `.github/workflows/ci.yml` runs gateway gates, native Go matrix,
  musl/glibc-free checks and race detector. Release tags: `ind-vX.Y.Z` for
  Indirect Code, `vX.Y.Z` for gateway; `.github/workflows/release.yml` builds
  and verifies artifacts, with `dry_run=true` for non-publishing validation.
- Write code, docs, commits and user-facing strings in English; conversation
  may match the user. Never add AI attribution to code, docs, commits or PRs.
- Handoff: if a change requires credentials, publishing a release or running
  slow real-model/browser gates unavailable locally, stop and report the exact
  command and missing prerequisite; never claim that gate passed.
