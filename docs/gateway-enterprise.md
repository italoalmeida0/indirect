# Gateway enterprise operation and validation

The gateway uses Bun, SQLite and SolidJS. One installation represents one
company or one person. Projects, corporate identity and a monitoring service
are optional; personal keys work without them. The dashboard's **Organization**
page groups the optional administrative controls.

The implementation described here has regression tests. Capacity qualification
is a separate gate and remains unverified until a report for the final source
revision and intended hardware passes. See
[the validation checklist](gateway-enterprise-checklist.md) for run status.

## Operating envelope and defaults

The intended workload is 500 employees making 500 AI requests each per day:
250,000 requests/day. The targets are gateway-added API p99 <=100 ms and complete
dashboard interaction p99 <=1,000 ms. API and frontend results must be reported
separately. A process metric or a fast loading indicator does not establish
either target.

| Setting | Default | Meaning |
| --- | --- | --- |
| `FINANCIAL_DEFAULT_BUDGET` | `usd` | `usd`, `percent` or `hidden` for non-administrators |
| `FINANCIAL_DEFAULT_SHOW_PRICES` | `true` | Model-price discovery, independent of budget presentation |
| Corporate sign-in / required SSO / required administrator MFA | Off | Configured through Organization; local authentication works with these policies off |
| Financial projects and shared budgets | None | Keys are personal until explicitly associated with a project |
| `USAGE_EVENT_RETENTION_DAYS` | `400` | Detailed usage days; `0` disables pruning |
| `AUDIT_RETENTION_DAYS` | `0` | No automatic audit expiry; a positive value enables bounded expiry |
| `ANALYTICS_HOURLY_DAYS` / `ANALYTICS_MINUTE_DAYS` | `90` / `3` | Finer rollup retention; daily/monthly aggregates are independent |
| `BACKUP_INTERVAL_MINUTES` | `1440` | Scheduled snapshots; `0` leaves only manual backup |
| `BACKUP_KEEP_DAILY` / `BACKUP_KEEP_WEEKLY` | `14` / `8` | Snapshot retention buckets |
| `BACKUP_INCLUDE_DAEMON` | `false` | Optional copy of separately owned daemon directories |
| `LIMIT_USER_RPM` / `LIMIT_USER_CONCURRENCY` | `600` / `32` | Aggregate ceilings across an account's keys |
| `LIMIT_GLOBAL_CONCURRENCY` | `512` | Concurrent upstream calls in this process |
| `LIMIT_ADMISSION_WAIT_MS` / `LIMIT_ADMISSION_QUEUE_MAX` | `400` / `1024` | Bounded concurrency wait and queue |
| `LIMIT_ADMISSION_QUEUE_BYTES` | `67108864` | Declared request bytes allowed to wait |

Daily and monthly ledgers are not automatically expired. They preserve the
ten-year accounting requirement after detailed rows expire. At the intended
rate, 400 detailed days mean **100,000,000 physical usage events**; ten years
of represented requests is a different cardinality. Historical local sizing
was roughly 547 MiB per million events, so raw history alone can exceed 53 GiB
before differences in indexes, identifiers, reservations, audit, WAL and free
pages. Measure the actual database. Allow additional disk for live snapshots,
a separate restore and WAL growth. Reducing retention is an explicit
forensic/storage tradeoff, never an implicit performance optimization.

Audit history is separate: the default retains it indefinitely. A fixture with
365 audit days does not qualify ten years of audit storage. Settled reservation
detail is retained for 30 days; expired non-lifetime billing periods are pruned
after 400 days when they have no outstanding holds. Lifetime balances remain.

## Roles and financial scopes

| Capability | User | Project manager | Administrator |
| --- | --- | --- | --- |
| Own keys, plan and personal usage | Yes | Yes | Yes |
| List/read financial scopes | Membership only | Membership only | All scopes |
| Shared report and member directory | No | Assigned manager scopes only | All scopes |
| Add/remove ordinary project members | No | Assigned manager scopes only | Yes |
| Grant/remove manager memberships | No | No | Yes |
| Create/edit/archive scopes and shared budgets | No | No | Yes |
| Providers, registry, users, plans, policies, import, backups and metrics | No | No | Yes |

A project manager needs both the gateway `project_manager` role and a `manager`
membership in the exact scope. A responsible user field alone grants no
capability. A cost-center membership grants no membership in child projects.
Out-of-scope management/report reads return 404; global administration requires
the administrator role. Authorization applies to direct requests too.

The original `users.role` column retains its `admin`/`user` constraint.
Delegation is stored in nullable `users.enterprise_role`; `effectiveRole()`
combines them and the public DTO exposes `admin`, `project_manager` or `user`.
Role filtering/sorting uses the same decision. Do not write `project_manager`
directly into the original role column.

Financial scopes use `financial_projects` and `project_members`. They have a
unique editable code, name, description, optional responsible user,
`active`/`archived` status and optional monthly/lifetime USD ceilings. A project
can reference one active cost center; a cost center cannot have a parent.
Neither owns Indirect Code sessions, transcripts, files or daemon
configuration. The daemon continues to own its workspace projects.

Only a **project** can be associated with a key. Its owner must be an active
member. Admission also validates the active parent cost center. An archived
scope or removed member makes an associated key unavailable; it never silently
switches to personal use. Administrative assignment validates the key owner's
membership too. There is no hard-delete project API; archive preserves history.

Admission captures project/cost-center IDs, prices and budget periods. Account,
key, project and cost-center holds are reserved atomically. Monthly shared
ceilings renew at 00:00 UTC on the first of the month; lifetime ceilings do not
renew. `null` means unlimited; zero blocks new billable work. Accepted requests
settle against their captured scopes even if a key moves, membership changes
or a scope is archived while they run. Renaming/reorganizing never reclassifies
old usage. Pre-project historical requests remain personal.

Project reports read the immutable ledger. `from`/`to` are inclusive UTC dates
(`YYYY-MM-DD`), with at most a 50-year span. Cost-center reports use the
attribution recorded for each request, rather than today's parent assignment.

## Financial visibility and model access

Organization → Financial visibility sets installation defaults. Users → Edit →
Financial and corporate access sets independent per-user overrides; `null`
inherits that field's default. Administrators retain USD visibility for
reconciliation. Project managers obey the non-administrator financial policy.

- `usd` returns monetary amounts and balances.
- `percent` returns allowed consumption/hold percentages, configured-limit
  flags and renewal metadata without the underlying USD values.
- `hidden` omits amounts and percentages while preserving permitted
  operational status and renewal information. Project budget windows expose
  only kind and renewal time in this mode.
- `showModelPrices` separately controls model pricing. Hiding budgets does not
  disable explicitly permitted model prices, and hiding model prices does not
  hide a permitted USD account balance.

Explicit projections cover key mutation/list/detail replies, billing/reset
redemption, usage summaries/events/analytics/breakdowns, model catalog/detail
responses and filter/sort metadata. Internal accounting stays in nanodollars.
`X-Financial-Policy` and policy-aware resources refresh an open page after
policy changes; stale USD values must not remain visible when policy narrows.
Finite private plans are not described as unlimited because USD is absent.

Model policies use **public registry IDs**, including IDs with slashes.
Without an enabled nonempty default list, access is unrestricted. Otherwise
an enabled project's list adds grants to that default for its assigned keys.
Empty/disabled project lists add nothing. Administrators are exempt. Discovery
(`/v1/models`, `/api/me/models`), detail reads and every proxy protocol share
the decision; aliases/fallback targets cannot bypass it. The dashboard's
`projectId` model-catalog query validates active membership first.

Model renames update policy references. Deleting a selected model leaves a
denied tombstone in `missingModels`; recreating its ID does not regrant it.
A default containing only tombstones continues to deny access. Name/enabled
edits preserve tombstones; explicitly replacing `models` removes them.
Deliberately saving an empty default restores unrestricted access. The editor
exposes this distinction.

## Corporate sign-in, MFA and recovery

Use Organization → Corporate authentication to configure an OIDC issuer,
client ID and optional client secret. Production requires an HTTPS `PUBLIC_URL`
origin and HTTPS provider endpoints. Register the exact displayed callback:
`PUBLIC_URL/api/auth/oidc/callback`. An empty UI secret retains the configured
secret; the API accepts `clientSecret:""` to clear it. Secrets are encrypted
at rest and never returned in configuration responses.

Authorization code sign-in uses S256 PKCE, browser-bound single-use state and
nonce, fixed return destinations and a short-lived HttpOnly completion cookie.
It validates issuer, audience/authorized party, time bounds, signatures and
applicable token hashes. RS256 and ES256 require their corresponding key types;
HMAC, unsigned and mismatched keys are rejected. Discovery/JWKS responses,
key/flow counts and network deadlines are bounded; rotation refreshes keys.
The HTTP-loopback exception requires `NODE_ENV=test` and
`OIDC_ALLOW_HTTP_LOOPBACK=true`; it does not enable production HTTP sign-in.

An email claim never silently links an identity or assigns a role. An
administrator can bind the provider's exact issuer and immutable subject in
the user's corporate access settings. A user can explicitly link from Settings
after password/TOTP verification, or a sufficiently recent corporate sign-in
when no password exists. Provider groups do not assign gateway roles.
Unlinking requires another sign-in method and is rejected while managed SSO
requires that identity.

Before enabling policies:

1. Enroll every active administrator in an authenticator before requiring MFA.
2. Generate and safely store recovery codes. Ten single-use codes are shown
   once; the server stores hashes. Regeneration invalidates the old set and
   revokes other sessions. Sign-in accepts a TOTP or recovery code.
3. For required managed SSO, explicitly link every active managed account to
   the configured issuer. Keep an active administrator with a local password,
   authenticator, remaining recovery codes and explicit SSO recovery exemption.

Readiness checks reject violations. Promotion, deactivation, demotion,
deletion, MFA removal and recovery changes preserve required local recovery
access. Keep that identity outside the corporate provider's failure domain.

Saving installation authentication policy signs everyone out using a versioned
check; individual identity-policy changes revoke that account's sessions.
Renewal and relay authentication revalidate method, policy version and required
MFA. Local login/reset and Google sign-in cannot bypass required SSO.
Controlled-provider tests cover these contracts; an actual corporate tenant
integration is a separate operator setup/validation step.

## Bulk user import

Organization → Bulk user import accepts CSV or a JSON array, bounded to
**500 users and 256 KiB of UTF-8 content**, with a separately bounded envelope.
CSV requires `email,name`; optional columns are `role`, `planId`, `projectIds`,
`managed`, `oidcSubject`. JSON uses the same fields with a `projectIds` array
and boolean `managed`. CSV separates project IDs with semicolons and uses
literal `true`/`false`. Plans/active projects must exist; at most 20 project IDs
are allowed per row. Example:

```csv
email,name,role,managed
alex@example.com,Alex,user,false
sam@example.com,Sam,project_manager,false
```

Preview returns row numbers, normalized identities, create/existing/error
status and row errors. Duplicate input emails/subjects are errors; existing
emails are skipped without changing their accounts. Preview is bound to the
requesting administrator, expires after 30 minutes, and is bounded to five
pending batches per administrator and 200 stored batches.

Commit revalidates references/security policy in the transaction that creates
accounts, memberships and audit. Invalid batches make no partial account
changes. Repeating a committed `batchId` returns its stored result with
`replayed:true`. Matching content within its live preview window reuses the
batch. New managed accounts need an exact `oidcSubject` when SSO is enforced;
project-manager imports receive manager membership in their listed projects.
Unenrolled administrators cannot be imported while administrator MFA is required.

Import sends no invitations or notifications and creates no password. For a
local account, deliberately use its invitation/password-setup action after
import. Managed accounts can use their explicitly bound corporate identity.

## Correlation, audit and durability

`X-Request-Id` accepts a client value matching `^[A-Za-z0-9._-]{8,128}$` or is
generated. Responses, usage and audit preserve correlation. Each financial
operation has an independent unique reservation identity: repeating correlation
does not cause global idempotency or cross-account collisions. Reset
redemption's explicit `requestId` is a separate grant/user-bound contract.

Sensitive local mutations commit required audit records in the same transaction
or roll back together. Audit captures actor, action, target, time, correlation
and context without secrets. A no-op may write nothing; import can write
per-user and batch events. Audit is not defined as exactly one row per HTTP
request. External effects such as email cannot be rolled back by SQLite and
are not performed inside a long network transaction.

Settlement commits the charge and durable usage-outbox entry together. A
bounded worker atomically drains it into detailed events and rollups; restart
retries cannot duplicate accounting. Analytics can lag while delivery catches
up, but a process crash does not discard settled usage. Pending holds survive
crashes; bounded recovery conservatively settles uncertain requests after the
missing-heartbeat grace period. See [billing semantics](gateway-billing.md)
for pricing, cancellation and resets.

Admission and settlement fail differently on storage errors, deliberately. An
admission failure happens before any provider call, so it fails closed: the
client receives a `503` and no hold exists. A settlement failure happens after
the provider already produced and billed the tokens, and a flushed stream
cannot be recalled, so the earned response is kept. The pending hold keeps
counting against the budget (nothing is given away), the charge is retried in
bounded memory with backoff, repeated failures degrade to a conservative charge
for the reserved bound, and new admissions stop once that retry queue
saturates.

## Retention, metrics and health

Detailed retention uses bounded micro-transactions and yields between batches.
Defaults are at most 50,000 rows per scheduled tick and 1,000 per write
transaction. Coverage advances only after safe progress; deleting detail never
deletes accounted daily/monthly totals. Other periodic jobs use bounded work
and retry budgets and suppress overlapping runs. Passive checkpoints avoid
a forced truncation checkpoint on the serving path. Bounds do not replace
concurrent-load measurements on the intended disk.

Boot never runs an unbounded `ANALYZE`. When `sqlite_stat1` already holds
statistics, boot runs the incremental `PRAGMA optimize` that keeps plans
healthy as the gateway's own data grows. When statistics are missing and the
file is large — a restored backup copy, a seeded capacity fixture, a database
grown by another tool — boot logs `[DB] planner statistics missing on a
N-page database` and continues with slightly worse plans instead of scanning
every index before the HTTP server exists. Build them once, with the gateway
stopped:

```sh
DATA_DIR=./data bun scripts/analyze-gateway.ts            # bounded per-index sample
DATA_DIR=./data bun scripts/analyze-gateway.ts --limit=400
```

Measured on the delivered retention profile (500 users, 400 detailed days =
100,000,000 raw events, 7,500,000 settled reservations, 1,095,005 audit rows):
`gateway.db` is 13.7M pages ≈ **56 GB**, and a full `ANALYZE` of
`usage_events` on a Windows ARM64 laptop at cold cache did not finish in
fifteen minutes. Both facts are why statistics are built offline with a bounded
sample and why the qualification workflow preflights free disk before seeding.

`GET /api/health` is liveness; `GET /api/ready` tests readiness. Both avoid the
shared public IP bucket. Organization → Operations and backups displays
`GET /api/admin/metrics`. It requires an administrator session or a dedicated
`GATEWAY_METRICS_TOKEN` of at least 32 characters as a bearer token. That token
grants no other admin API. Replies use `Cache-Control:no-store`.

Metrics include HTTP status classes, active/completed/cancelled requests,
5xx counts, route-family latency, admission limits/queues/rejections, analytics
worker health, SQLite contention/checkpoints, retention, maintenance and backup
outcomes. Labels contain no user/project IDs, raw URLs, request IDs or
credentials. Latency p50/p95/p99 cover the last **512 completions per route
family**; count/sum/max are process-lifetime values. Duration includes stream
consumption and provider waits. These are operational signals, not a
gateway-overhead benchmark or evidence that the targets passed.

## Backup and offline restore

Administrators can list/create/verify/delete snapshots in Organization →
Operations and backups. `BACKUP_DIR` defaults to `DATA_DIR/backups`.
A consistent `VACUUM INTO` snapshot runs while WAL writes continue; creation
and verification use worker threads. Worker failure is reported rather than
falling back to synchronous serving-thread work.

Snapshots contain the database, bounded manifest with sizes/hashes/schema
version, and the secret material needed to decrypt credentials. Verification
checks inventory/path safety, sizes, SHA-256, SQLite integrity and critical
table reads. Hashes detect corruption relative to the manifest; they are not
an authenticity signature against replacement of both files and manifest.
Protect snapshots and keep an off-host copy under the operator's access policy.
Copied encryption secrets make snapshot access security-sensitive.

Daemon inclusion is off by default. When enabled, configure
`BACKUP_DAEMON_DIRS` explicitly and arrange an offline/consistent daemon copy
when required. A gateway SQLite snapshot does not establish a simultaneous
transaction with daemon files or transfer their ownership. Daily/weekly
retention applies to complete snapshots; inspect failed/interrupted copies
before operator cleanup.

Restore is an **offline CLI operation into a new or empty directory**; it never
restores over the live installation. The destination parent must exist and be
separate from the snapshot. The source and staged copy are verified before
the restored directory is published:

```sh
bun scripts/restore-gateway-backup.ts \
  --snapshot=/protected/backups/SNAPSHOT_ID \
  --destination=/srv/indirect-restored
```

The CLI prints paths/schema metadata, not credentials. Configure the printed
destination as `DATA_DIR` and its printed `secretFile` as `INDIRECT_SECRET_FILE`:

```sh
DATA_DIR=/srv/indirect-restored \
INDIRECT_SECRET_FILE=/srv/indirect-restored/.secret \
PUBLIC_URL=https://restored.example.com \
bun start
```

Remove unrelated `INDIRECT_SECRET`/`GATEWAY_SECRET` environment values from
that service: they take precedence over the secret file. Secret bytes,
including intentional whitespace, must remain exact. Keep deployment settings
such as `PUBLIC_URL`, SMTP, scraper credentials and proxy configuration with
the deployment; the database does not reconstruct them. Restore optional
`daemon/` copies separately while those daemons are stopped. Check history,
balances, key reveal and an authorized provider request before switching traffic.
The automated restore test does these checks on a separate running installation
while preserving its source installation.

## REST administration reference

Dashboard successes include `success:true`; failures use
`{success:false,error}`. Proxy failures retain the client's OpenAI/Anthropic
envelope. Rate/concurrency rejections include `Retry-After`.

| Routes | Access/purpose |
| --- | --- |
| `GET /api/projects`, `GET /api/projects/:id` | Administrator or membership-scoped metadata/projected budgets |
| `POST /api/projects`, `PATCH /api/projects/:id` | Administrator create/edit/archive; `code,name,description,kind,costCenterId,responsibleUserId,monthlyLimitUsd,totalLimitUsd,status` as applicable; kind fixed after creation |
| `GET /api/projects/:id/members`, `GET /api/projects/:id/member-candidates?q=...` | Scoped manager/administrator; search 2–80 characters, at most 20 candidates |
| `PUT /api/projects/:id/members/:userId`, `DELETE` same path | Scoped member management; only administrators manage manager roles |
| `GET /api/projects/:id/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` | Scoped manager/administrator report; cost only when permitted |
| `POST /api/keys`, `PATCH /api/keys/:id` | Own key with optional `projectId`/`null`; existing key fields keep their contracts |
| `PATCH /api/admin/keys/:id` | Administrator project reassignment, `{projectId}` only |
| `GET/PATCH /api/admin/financial-policy` | Installation financial defaults |
| `GET/PATCH /api/admin/users/:id/financial-policy` | Independent nullable user overrides |
| `GET/POST /api/admin/model-policies`, `GET/PATCH/DELETE /api/admin/model-policies/:id` | Administrator lists; project creation requires `projectId`, association fixed on edit |
| `GET/PUT /api/admin/corporate-auth` | Administrator OIDC/policy configuration/readiness |
| `GET/PUT /api/admin/users/:id/corporate-auth` | Administrator managed/exempt policy and explicit issuer/subject link |
| `GET /api/auth/config`, `/api/auth/oidc/start`, `/api/auth/oidc/callback`, `POST /api/auth/oidc/complete` | Public sign-in flow with browser-bound completion |
| `GET /api/me/security`, `POST/DELETE /api/me/oidc/link`, `POST /api/me/security/recovery-codes` | Current-account identity/recovery with required verification |
| `POST /api/admin/users/import/preview`, `POST /api/admin/users/import/commit` | Administrator bounded preview and atomic commit |
| `GET /api/admin/metrics` | Administrator or read-only scraper token |
| `GET /api/admin/backups`, `GET /api/admin/backups/status`, `POST /api/admin/backups` | Administrator list/status/create |
| `POST /api/admin/backups/:id/verify`, `DELETE /api/admin/backups/:id` | Administrator verify/delete; restore uses the CLI |

## Regression and qualification commands

Run the normal gates from the repository root:

```sh
bun run lint
bun run typecheck
bun test
bun run build:web
```

The reviewed reproductions have specific regression coverage:

| Reproduction | Regression boundary |
| --- | --- |
| Repeated correlation collides with reservation identity | `test/gateway-correlation.test.ts`: sequential/concurrent/cross-account/recovery calls |
| Values leak through alternate/mutation endpoints | `test/gateway-financial-policy.test.ts`, `test/financial-projection.test.ts`: payload inventory and policy changes |
| Percent UI consumes USD DTO fields | `scripts/test-gateway-financial-ui.ts`: actual finite/40%/reserved/unlimited/hidden presentation |
| Retention stalls serving traffic | `test/usage-retention.test.ts`: backlog, interruption/restart, accounting and concurrent health/writes |
| Rename/audit failure leaves unaudited state | `test/gateway-correlation.test.ts`: mutation events and injected rollback failures |
| Dashboard/project model policy differs from proxy | `test/gateway-model-policy.test.ts`, `test/gateway-financial-projects.test.ts`: discovery, aliases, tombstones and grants |

Additional coverage is in `test/gateway-corporate-auth.test.ts`,
`test/gateway-user-import.test.ts`, `test/gateway-metrics.test.ts`,
`test/gateway-backup.test.ts`, `test/gateway-restore.test.ts` and
`test/usage-outbox.test.ts`. Test existence is not a passing result for a later
revision; record the command and verdict after the final edit.

Browser regressions require the built production SPA, an external pinned
Playwright installation and Chromium. The financial script uses Node.js 22
TypeScript stripping and starts Bun via `BUN_BIN`; the enterprise script uses Bun:

```sh
PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs CHROMIUM_PATH=/absolute/chromium \
bun scripts/test-gateway-enterprise-ui.ts --samples=40 --dir=tmp/enterprise-ui

PLAYWRIGHT_MODULE=/absolute/playwright/index.js \
CHROMIUM_PATH=/absolute/chromium BUN_BIN=/absolute/bun \
node --experimental-strip-types scripts/test-gateway-financial-ui.ts
```

Fresh enterprise UI runs use six users/30 days and exercise mutations. They are
correctness smoke tests. Reuse a completed enterprise fixture to measure real
retained history without changing its policies. Keep fixture JSON/databases
private: they contain generated test credentials. Publish sanitized reports
and screenshots only.

Capacity commands use isolated directories and refuse to overwrite nonempty
seed destinations:

```sh
# Quick: 500 users, ten-year aggregates, two physical raw days.
bun scripts/test-gateway-enterprise.ts --seed-only --dir=tmp/enterprise-quick
bun scripts/test-gateway-enterprise.ts --reuse --dir=tmp/enterprise-quick \
  --samples=1200 --rate=32 --report=tmp/enterprise-quick-api.json

# Delivered raw retention: 100M events and 7.5M settled reservations.
bun scripts/test-gateway-enterprise.ts --seed-only --raw-days=400 \
  --reservation-days=30 --dir=tmp/enterprise-400
bun scripts/test-gateway-enterprise.ts --reuse --dir=tmp/enterprise-400 \
  --samples=1200 --rate=32 --report=tmp/enterprise-400-api.json

PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs CHROMIUM_PATH=/absolute/chromium \
bun scripts/test-gateway-enterprise-ui.ts --reuse --dir=tmp/enterprise-400 \
  --samples=3600 --enforce-p99 --report=tmp/enterprise-400-frontend.json
```

`--full` currently seeds 90 raw days (22.5M events), so it does not replace
explicit `--raw-days=400`. The fixture checks physical count and aggregate
totals independently. Its default audit profile is 365 days at six
events/user/day (1,095,000 rows); these commands do not claim ten-year audit
cardinality. Durability is not weakened for measurement.

The API script schedules open-loop arrivals, includes scheduling/queue delay,
errors/timeouts, subtracts per-request local provider processing time and
reports API overhead separately from dashboard API duration. The browser
script measures navigation through the target response, populated page and
rendering frames, recording browser/cache/network conditions and per-route
distributions. `--enforce-p99` requires at least 1,000 total interactions and
rejects failures/runtime errors. The 3,600-interaction command gives 1,200
samples for each of the three currently measured pages. Small samples remain
exploratory even when fast.

Ordinary CI runs production-SPA financial/enterprise regressions.
`.github/workflows/enterprise-qualification.yml` is an explicit manual gate on
a configurable dedicated native Linux runner, with disk/architecture preflight,
separate quick/full400 profiles and sanitized report artifacts. Quick success
does not qualify delivered retention. A full report must still identify which
streaming/protocol/mixed-traffic, cold/warm/date/filter, maintenance/backup and
sustained-load scenarios actually ran. Unimplemented or unrun scenarios remain
unverified. Record CPU/RAM, OS/architecture, Bun/browser versions, storage,
source revision, fixture/index cardinalities/size, actual soak duration,
p50/p95/p99/max, errors, WAL/memory growth and cleanup/recovery results.

The reviewed Windows x64 run on a Snapdragon X ARM host was an emulation
baseline: API-added p99 313.9 ms, dashboard API p99 4,141.2 ms with 8/1,200
errors, and a 50-user burst p99 1,086.4 ms. Its two physical raw days did not
qualify 400-day retention. Native ARM64 Bun 1.4.2 is available for a new local
run; availability is not a passing measurement. A native Linux deployment
needs its documented target-machine run. No ten-year reliability claim follows
from a short soak or finite regression suite.
