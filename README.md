# Indirect

**Self-hosted AI platform for a team or a single person.** One Bun process
provides an **LLM API gateway**, its dashboard, and the relay for **Indirect
Code**, a coding-agent workspace whose daemon runs on the user's own machines.

- **Gateway** — OpenAI-, Anthropic- and Responses-compatible APIs in front of
  one or more upstream providers, with per-user `gw_` keys, USD budgets,
  model routing, failover and exact usage accounting.
- **Dashboard** — usage analytics, keys, plans, financial projects, users,
  audit, providers, model registry, backups and operational metrics.
- **Indirect Code** — a coding agent in the same dashboard. A small Go daemon
  on the user's host owns projects, sessions, transcripts and files; the
  gateway only relays the browser ↔ daemon connection.
- **Simple to run** — Bun + SQLite. No Redis, Postgres, queue or separate
  services. Optional SMTP, Google sign-in and corporate OIDC integration.

One installation represents one organization (or one person): accounts share
the gateway's providers and model registry, while keys, budgets, financial
projects and model policies scope what each account can do.

## Quick start (Docker)

```bash
docker build -t indirect .
docker run -d --name indirect \
  -p 3000:3000 \
  -v indirect-data:/data \
  -e INDIRECT_SECRET="$(openssl rand -hex 32)" \
  -e ADMIN_EMAIL="you@example.com" \
  -e ADMIN_PASSWORD="use-a-long-random-password" \
  -e PUBLIC_URL="http://localhost:3000" \
  indirect
```

Open `http://localhost:3000` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
The first admin is created only when the installation has no active
administrator. Then add a provider under **Admin → Providers**, sync its model
list, and invite users.

`PUBLIC_URL` must be the URL users and Indirect Code hosts can reach: the
Indirect Code pairing command and email links are built from it.

To build the image directly from this repository instead of a local checkout,
use `docker build -f Dockerfile.github -t indirect .`.

## Quick start (from source)

Requirements: Bun 1.4 (CI pins 1.4.2). Building the Indirect Code daemon also
needs Go 1.26 and downloads the pinned zig toolchain automatically; Docker users
need neither.

```bash
bun install
bun run build:web             # SPA into dist/, committed daemon releases into dist/r/
cp .env.example .env          # set INDIRECT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, PUBLIC_URL
bun start                     # http://localhost:3000
```

`bun run build` also cross-builds the daemon for Linux, macOS and Windows
(amd64/arm64). `bun run build:daemon` builds only the current host's daemon.
For development, `bun run dev` serves the backend on `:3000` and
`bun run dev:web` serves the SPA with live reload on `:5700`.

## Using the gateway

Point any OpenAI or Anthropic client at the gateway and use a `gw_` key instead
of the real provider key:

```bash
export INDIRECT_KEY="gw_..."

curl http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer $INDIRECT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model-id","messages":[{"role":"user","content":"Hello"}]}'

curl http://localhost:3000/anthropic/v1/messages \
  -H "x-api-key: $INDIRECT_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model-id","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

The `/openai/v1/*` and `/anthropic/v1/*` prefixes pin the wire protocol for
clients that need one unambiguous base URL. Bare `/v1/*` is also served and
infers the protocol from the endpoint (and from the auth header for
`/v1/models`). `GET /v1/models` lists what the key may use: the registry in
router mode, the upstream catalog in pass-through mode.

## Gateway

### Protocol proxy

- OpenAI-compatible: Chat Completions, Completions, Responses, Embeddings and
  Models (`/openai/v1/...` or `/v1/...`).
- Anthropic-compatible: Messages, token counting and Models
  (`/anthropic/v1/...` or `/v1/...`).
- One registered model can serve all three surfaces: the gateway translates
  between OpenAI, Anthropic and Responses when the upstream provider speaks
  another protocol.
- SSE streams are relayed incrementally with backpressure and cancellation,
  never buffered. Request bytes are preserved except for the OpenAI streaming
  `stream_options.include_usage` hint, injected only when the client did not
  send it.
- Token accounting keeps input, cached input, cache writes and output separate.
  Pricing is frozen onto each request when it is admitted, so later registry
  edits never reprice settled usage.
- Errors keep the envelope of the client protocol (OpenAI, Anthropic or
  Responses). Failover attempts are exposed as `x-gateway-attempts`; retryable
  limits carry `Retry-After`. Token counting is free and does not consume
  allowance.
- Per-IP, per-key and per-account buckets, a bounded admission queue, and a
  per-provider/capability circuit breaker protect the process and upstreams.

### Models, routing and failover

- Providers may expose OpenAI-compatible, Anthropic-compatible and Responses
  API capabilities, each with its own base URL and auth style (`Bearer` or
  `x-api-key`). A provider can hold several keys, ordered by priority; keys are
  never auto-disabled, only explicitly disabled by an administrator.
- Creating or syncing a provider imports its `/models` list into the registry
  (tolerant of OpenAI, Anthropic and OpenRouter-style payloads; re-syncing
  never overwrites admin edits). Optional OpenRouter lookup fills in missing
  pricing and metadata.
- Registry entries carry context/output limits, modalities, pricing, reasoning
  efforts, aliases and an ordered **failover chain** of provider/model targets.
  Per-model tool-call modes (`native`, `fallback`, `workaround`, `own`) recover
  tool calls that some upstreams leak as markup text.
- **Routing mode** switches the proxy between `passthrough` (model names
  forwarded untouched, the default) and `router` (strict: unknown models 404,
  aliases rewrite to the registered upstream id, and `/v1/models` is served
  from the registry).
- Model access policies can be scoped to financial projects, so a project only
  sees and uses the models granted to it. Administrators are exempt.
- Failover happens only before the first byte reaches the client. Billing,
  auth, rate-limit, transient and model-not-found failures may advance the
  request; other 4xx errors are returned as-is. A short-lived sticky winner per
  routing lane avoids re-trying a known-bad candidate first.

### Billing and spend controls

Billing is an allowance system, not a payment processor: there is no checkout,
invoice or subscription flow. Plans and financial projects are optional: an
account without a plan is unlimited, and keys are personal until associated
with a project.

- **Plans** set a monthly USD allowance per account, with optional weekly and
  five-hour session distribution windows. All keys and protocols of an account
  share the same cap. A plan or key can be unlimited; zero blocks new billable
  work.
- **Keys** can add independent daily and lifetime USD caps, RPM and concurrency
  limits, expiration and optional financial-project association.
- **Financial projects and cost centers** add optional shared monthly/lifetime
  ceilings. Admissions reserve account, key, project and cost-center holds
  atomically; a request settles against the scopes captured when it was
  admitted, so renaming or reorganizing never reclassifies history.
- Admission and settlement use integer nanodollars and BigInt arithmetic; an
  unspent hold is released and an actual cost is charged exactly once. Pending
  holds survive crashes and are recovered conservatively.
- Administrators can grant one-off weekly/session resets that the user redeems
  explicitly. A reset never changes monthly spend, key caps or renewal times.
- Financial visibility is configurable per installation and per user (`usd`,
  `percent` or `hidden`), independently from model-price visibility. A finite
  plan whose amounts are hidden is still finite and is not rendered as
  unlimited.

### Usage analytics

- Date-bounded charts, comparisons, breakdowns, filters and a per-request
  history with the same window and filters.
- Ingestion writes events and minute/hour/day/month rollups in one SQLite
  transaction. Long ranges read monthly/daily aggregates; detailed events are
  retained for `USAGE_EVENT_RETENTION_DAYS` (default 400) while daily and
  monthly totals stay independent of raw retention.
- Scoped analytics run on CPU-aware worker threads with their own read-only
  connections, bounded queues and deadlines, plus a bounded in-process result
  cache. Identical in-flight requests share one job; saturation returns a
  normal retryable dashboard error.
- Grid pages request summaries separately from rows, so long windows do not
  materialize result sets they will not render.

### Users, roles and authentication

- Accounts are invite-only: only administrators create users. A new user can
  receive an invite email (or a copyable setup link when SMTP is not
  configured).
- Roles: `admin`, `project_manager` and `user`. Project managers only act on
  the financial scopes where they hold a manager membership; out-of-scope
  reads and writes return 404.
- Password login with PBKDF2-SHA256 password hashing, optional TOTP 2FA with
  anti-replay, single-use recovery codes, Google sign-in, session listing and
  revocation, brute-force lockouts and no account enumeration in errors.
- Corporate OIDC sign-in with authorization code + PKCE, nonce/state binding,
  issuer/audience/signature validation and bounded JWKS/discovery fetching.
  Administrators can require managed SSO and administrator MFA; an account is
  only linked to a corporate identity by an explicit, verified bind.
- Bulk import accepts a bounded CSV or JSON batch (500 users / 256 KiB) with a
  preview, row errors, atomic commit and replayable batch IDs. It creates no
  passwords and sends no notifications.
- Every sensitive mutation writes an audit record in the same transaction (or
  rolls back). Audit captures actor, action, target, time, correlation and
  context without secrets.

### Security

- Upstream provider keys are encrypted at rest with AES-256-GCM under
  `INDIRECT_SECRET`; decrypted values never reach API responses or logs.
- `gw_` keys are stored as SHA-256 hashes for lookup, with an encrypted copy
  when the owner or an administrator is allowed to reveal them; every reveal is
  audited.
- Strict CSP, nosniff and frame headers on every response, a
  path-traversal-protected static server, an origin allow-list and request-body
  caps.
- Forwarding headers are honored only from explicitly trusted proxy CIDRs
  (`TRUST_PROXY` + `TRUSTED_PROXY_CIDRS`); the edge must overwrite client
  headers.
- Capacity and financial operations are bounded: retention, analytics, backup
  and maintenance work yield between micro-transactions instead of holding the
  SQLite writer for an unbounded run.

### Administration and operations

The admin area covers organization-wide settings:

- **Providers** — base URLs, auth styles, keys, connection test and model sync.
- **Models** — registry CRUD, aliases, failover chains, pricing, capabilities,
  model policies and routing mode.
- **Users / Plans / All keys / Audit** — account lifecycle, password resets,
  2FA resets, session revocation, plan assignment and financial-project
  association.
- **Organization** — financial visibility defaults, corporate authentication,
  operations/backups and bulk import.
- **Global stats** — cross-user usage and model/provider breakdowns.
- **Operations** — backups (list/create/verify/delete), backup status and
  operational metrics.
- **Metrics** — `GET /api/admin/metrics` returns JSON for HTTP status classes,
  latency percentiles per route family, active/admitted requests, analytics
  workers, SQLite contention/checkpoints, retention and backups. A read-only
  `GATEWAY_METRICS_TOKEN` (32+ characters) can scrape it without admin access.
- **Health** — `GET /api/health` (liveness) and `GET /api/ready` (readiness).
- **Backups** — consistent `VACUUM INTO` snapshots with a manifest and hashes,
  verified in worker threads. Restore is an offline CLI operation into a new or
  empty directory; it never restores over a live installation.

## Indirect Code

Indirect Code is an agent workspace in the dashboard (`#/code`). The agent does
not run in the gateway: each machine runs `indirect-code-daemon`, a single Go
binary that owns its projects, sessions, transcripts, configuration and files.
The browser reaches that daemon through the gateway's WebSocket relay. The
daemon only makes outbound connections, so the host needs no open inbound
ports.

### Connecting a host

Open **Indirect Code → Connect a host** and run the one-line installer shown
for Linux/macOS or Windows. The pairing token is valid for about 15 minutes;
the installer downloads the matching daemon release from the gateway's `/r/`
assets, connects it, and keeps it running in the background. The handshake
registers the host with a persistent daemon token and a dedicated gateway API
key, so agent traffic is metered and billed like any other key. Disconnecting a
host revokes that access; the host's files stay on the host.

### Workspace and agent

- **Modes** — Build (implement and validate), Plan (explore and plan without
  edits), Talk (conversational research with no workspace access) and Learning
  (guided hints rather than direct answers). Modes are skills; custom skills
  can define their own mode.
- **Sessions and projects** — multiple hosts, projects and conversations,
  session search, pinned sessions, rename/delete, attachments and previews,
  fork, undo, edit-and-resend and a message queue while a turn is running.
- **Agent tools** — file read/write/edit, glob and search, `bash`, `python`,
  URL fetch, web search, todo lists, questions back to the user and background
  jobs. Tool calls can require approval (safe mode) or run auto-approved; an
  optional jail confines filesystem tools to the session directory.
- **Background work** — a command still running after 10 seconds moves to the
  background automatically; the agent (and the user) can check, await or cancel
  it. Background jobs survive reconnect; after a restart the daemon re-adopts
  live processes from pidfiles and never re-runs a completed job.
- **Context** — automatic and manual compaction summarises older turns to stay
  within the model context. Manual `/compact` and `/clear` commands are
  available, and the context meter shows current usage.
- **Models and reasoning** — the model picker lists the gateway registry
  (subject to the user's model policy) and exposes reasoning-effort levels.
- **Notifications** — turn-finished notifications in the browser, including Web
  Push when no tab is open. The dashboard ships a web app manifest and service
  worker, and supports light, dark, high-contrast and system themes.

### Skills and generative UI

- Skills are JavaScript ES modules stored on the host. Built-ins cover the four
  modes and generative UI; users can add modules under the slot's `skills/`
  directory. A module composes another by importing it (`import base from
  "skill:..."`) and spreading/concatenating it. Skill code runs in a restricted
  QuickJS sandbox with no file, process, network or dynamic-code access.
- **Generative UI widgets** let the agent render interactive TSX/React widgets
  inside the transcript. Widget source is linted server-side (compile, import
  audit, smoke render) and mounted in a sandboxed `allow-scripts` iframe with an
  opaque origin. Widget state persists only when the widget explicitly saves it.
  Linting uses a pinned browser downloaded under `DATA_DIR/obscura` on first
  use; `OBSCURA_PATH` and `OBSCURA_ARCHIVE` support offline installs.

### Host data and updates

- Daemon data lives under `~/.indirect-code`: `slots/slot-a|b/` (binary,
  sessions, `config.json`, `projects.json`), `brain/`, `logs/` and `external/`.
  Nothing there is stored by the gateway.
- The daemon updates itself from the gateway's `/r/` manifest into the inactive
  A/B slot; sessions and configuration move with the slot. Auto-update is on by
  default and can be disabled per host. Turn WALs are replayed after a crash,
  and the updater is crash-recoverable.
- Gateway backups can optionally include daemon directories
  (`BACKUP_INCLUDE_DAEMON` / `BACKUP_DAEMON_DIRS`), but the daemon remains the
  owner of that data.

## Architecture

```
OpenAI/Anthropic clients ── gw_ key ──▶ gateway ── real provider key ──▶ upstream providers
                                         │
browser ── HTTP + WebSocket ─────────────┤  dashboard, REST API, relay
                                         │
Indirect Code daemon ── outbound WS ─────┘  projects, sessions, files stay on the host
```

The gateway is a single Bun process with one SQLite database in `DATA_DIR`.
It serves the proxy surfaces, the dashboard REST API and the built SolidJS SPA,
and relays WebSocket frames between an authenticated browser session and a
paired daemon. The relay does not persist transcript content.

**Financial projects are not Indirect Code projects.** A financial project is a
gateway billing/access scope; an Indirect Code project is a directory and
conversation workspace owned by the daemon on the host. They deliberately do
not share storage or lifecycle.

## Repository layout

| Path | Contents |
| --- | --- |
| `server/` | Bun gateway: proxy, protocol translation, auth, billing, analytics, audit, relay, backups |
| `web/` | SolidJS + Tailwind dashboard and the Indirect Code workspace |
| `indirect-code-daemon/` | Indirect Code Go daemon (agent, sessions, runner, skills, widgets) |
| `docs/` | Gateway billing, analytics, enterprise and capacity/validation guides |
| `test/` | Unit, black-box integration, security and contract tests |
| `scripts/` | Build/release, benchmark, fixture and browser-regression scripts |
| `plugins/` | Solid, Tailwind and Iconify build plugins |
| `build.ts` | Production SPA build; stages daemon releases under `dist/r/` |

## Configuration

Deployment configuration is environment-based; see [`.env.example`](.env.example)
for a starting point. Organization-level settings — plans, financial visibility,
corporate auth, backup schedule and similar — live in the admin UI, and the
operator docs cover every environment knob.

| Variable | Purpose |
| --- | --- |
| `INDIRECT_SECRET` | Required in production: 32+ random bytes; signs JWTs and encrypts provider credentials. Preserve it across upgrades. `INDIRECT_SECRET_FILE` reads it from a file. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First-admin bootstrap; only used when no active administrator exists. Password must be at least 10 characters. |
| `PUBLIC_URL` | Absolute public URL of the dashboard; used for email links and the Indirect Code pairing URL. |
| `DATA_DIR` | Directory for `gateway.db`, the development secret, backups and downloaded tooling. Default `./data`; mount it as a volume in Docker. |
| `PORT` / `HOST` | HTTP listen port and interface (default `3000` / `0.0.0.0`). |
| `TRUST_PROXY` / `TRUSTED_PROXY_CIDRS` | Honor forwarding headers only from these proxy peers. |
| `ALLOWED_ORIGINS` | CORS allow-list for the dashboard API (mainly for `dev:web`). |
| `GOOGLE_CLIENT_ID` | Enables Google sign-in; empty disables it. |
| `SMTP_*` | Invite, reset and security emails; when unset, no mail is sent and invite/reset links are returned to the administrator for copying. |
| `GATEWAY_METRICS_TOKEN` | Optional read-only bearer token for `GET /api/admin/metrics`. |
| `BACKUP_*` | Backup directory, schedule, retention and optional daemon inclusion. |
| `USAGE_EVENT_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS` | Detailed usage days (default 400; daily/monthly totals remain) and audit days (default 0 = retain indefinitely). |
| `ANALYTICS_*`, `LIMIT_*`, `DEFAULT_KEY_*` | Analytics workers/deadlines, rate limits, concurrency and admission tuning. |

## Deployment

- Terminate TLS at a reverse proxy (Caddy, nginx, Cloudflare) and set
  `PUBLIC_URL` to the HTTPS origin. To honor forwarded IP/origin headers, set
  `TRUST_PROXY=true` and list only the real proxy peers in
  `TRUSTED_PROXY_CIDRS`; the edge must overwrite client-supplied headers.
- Persist `DATA_DIR` and `INDIRECT_SECRET`. The secret decrypts provider
  credentials and signs sessions; changing or losing it makes existing
  encrypted values unreadable. In Docker, mount `/data` as a volume.
- `GET /api/health` is liveness; `GET /api/ready` is readiness. Point the
  container/load-balancer probes at them; both bypass the public IP bucket.
- Backups are produced from the admin UI or built-in schedule and stored under
  `BACKUP_DIR` (default `DATA_DIR/backups`). Snapshots include a manifest,
  hashes and the secret needed to decrypt credentials, so protect them and keep
  an off-host copy. Restore is an offline CLI operation into a new or empty
  directory: `bun scripts/restore-gateway-backup.ts --snapshot=... --destination=...`.
- Upgrades replace the checked-out release and restart the process: run
  `bun install` and `bun run build:web` (or rebuild the Docker image), then
  start it again. SQLite migrations run at boot and are append-only; take a
  verified backup before a major upgrade.
- Capacity, retention and the manual enterprise qualification workflow are
  documented in [docs/gateway-enterprise.md](docs/gateway-enterprise.md) and
  [docs/gateway-enterprise-checklist.md](docs/gateway-enterprise-checklist.md).

## Development

Prerequisites: Bun 1.4 (CI pins 1.4.2); Go 1.26 and the pinned zig toolchain for
daemon builds; Playwright/Chromium for the external browser regressions (the
financial UI script runs under Node 22). CGO is required for daemon builds.

```bash
bun run lint                  # ESLint + unused-export check
bun run typecheck             # tsc --noEmit
bun test                      # unit, black-box integration and security suites
bun run build:web             # production SPA build
bun run bench                 # direct-vs-proxied load benchmark
bun run fake-upstream         # standalone fake provider on :3399

cd indirect-code-daemon
CGO_ENABLED=1 go test ./...   # daemon suites (needs Go 1.26 + zig)
```

`test/openrouter-integration.test.ts` also ships a live OpenRouter smoke suite
(real catalog, streaming and non-streaming inference, rejected-credential
handling). It runs when `OPENROUTER_API_KEY` is present, which Bun loads from
the gitignored `.env`; `OPENROUTER_BASE_URL` overrides the API root. Without a
key those tests skip, so `bun test` stays offline. Never commit the key.

Browser UI checks are external Playwright scripts (for example
`scripts/test-indirect-transcript-ui.ts` and `scripts/test-gateway-billing-ui.ts`).
They need a built SPA, a Playwright installation and a Chromium binary, passed
through `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH`. Full-stack Indirect Code
scenarios (background turns, compaction) additionally need `dist/`, the daemon
binary and `META_API_KEY`; run them manually when affected.

### CI and releases

`.github/workflows/ci.yml` runs the gateway gates plus the daemon suite natively
on Linux, macOS and Windows (amd64/arm64), a musl/glibc-free proof of the Linux
artifacts and the race detector. `.github/workflows/enterprise-qualification.yml`
is a separate, manual capacity gate; its results are documented in
[`docs/gateway-enterprise-checklist.md`](docs/gateway-enterprise-checklist.md)
and passing it is not implied by ordinary CI.

Releases are tag-driven: `vX.Y.Z` for the gateway and `ind-vX.Y.Z` for
Indirect Code. The release workflow runs the full CI gate,
builds and verifies the daemon artifacts for every supported platform, publishes
a GitHub Release, and commits the refreshed `indirect-code-daemon/dist/` back to
`main`; gateways serve those assets at `/r/` for host installs and updates.

## Documentation

- [Gateway billing](docs/gateway-billing.md) — USD plans, budgets, financial
  projects, resets and settlement semantics.
- [Gateway analytics](docs/gateway-analytics.md) — date windows, filters,
  rollups, caching, retention and benchmark commands.
- [Gateway enterprise](docs/gateway-enterprise.md) — roles, financial scopes,
  corporate auth, bulk import, audit, metrics, backups and offline restore.
- [Enterprise validation checklist](docs/gateway-enterprise-checklist.md) —
  capacity and qualification evidence and remaining scenarios.
- [AGENTS.md](AGENTS.md) — architecture invariants, daemon contracts and
  contributor notes.

## License

MIT
