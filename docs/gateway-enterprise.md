# Gateway enterprise hardening — design and contracts

This document is the shared contract for the enterprise hardening program.

Status is recorded per section below. A section marked **[delivered]** has an
implementation AND automated tests that fail if the behaviour regresses; a
section marked **[pending]** is not implemented yet and must not be described
as if it were.

## Operating envelope

- 500 employees, 500 AI calls per person per day (250k/day).
- 10 years of aggregated history; detailed events under a configurable
  retention window.
- p99 gateway-added latency: <= 100 ms for \`/v1/*\`, <= 1000 ms for
  dashboard APIs (measured with a fixed-cost local upstream).
- One installation represents one company (or one person). Enterprise
  features are gated behind an explicit enable switch and are inert when
  disabled, so a personal installation keeps the one-key, one-model flow.

## Cross-cutting contracts

### Request correlation

- Every HTTP request entering \`server/index.ts\` gets a correlation id:
  \`x-request-id\` from the client when it matches \`^[A-Za-z0-9._-]{8,128}$\`,
  otherwise a fresh id.
- The id is exposed on the response as \`X-Request-Id\` for every route
  (dashboard and proxy), and is available through a request-scoped store
  (\`AsyncLocalStorage\`) so audit rows and usage events inherit it without
  threading a parameter through every function.
- \`usage_events.request_id\` and \`audit_log.request_id\` store the id.
  Proxy responses already send \`X-Request-Id\`; that value MUST equal the
  \`request_id\` persisted on the usage event for the same call.

### Audit coverage

Every authenticated mutation writes exactly one audit row. The rule is
testable: a mutation endpoint invoked by an admin/user must increase
\`audit_log\` by one row with a stable action name.

### Error envelopes

- \`/v1/*\` (including \`/openai/v1/*\` and \`/anthropic/v1/*\`) always speak the
  client protocol envelope (OpenAI \`{error:{message,type,code}}\`,
  Anthropic \`{type:"error",error:{type,message}}\`, Responses shares OpenAI).
- Rate-limited responses always carry \`Retry-After\` (integer seconds >= 1).
- Dashboard routes keep \`{success:false,error}\`.

### Limits

- Per-key RPM and concurrency stay exactly as today.
- Per-account aggregate RPM and concurrency are enforced ACROSS all keys of
  one account (already partially present); they must be configurable and
  must expose the denied dimension in the error message.
- A bounded admission queue may absorb short bursts: a request that would
  exceed a concurrency ceiling waits up to a configured deadline instead of
  failing immediately, and is dequeued (FIFO) the moment a slot frees.
  Queue length and wait deadline are configurable; overflow still returns
  429 with \`Retry-After\`.

### Financial visibility policy

Two independent settings, with an installation default and a per-user
override:

1. \`showModelPrices\` (boolean) — whether model pricing is returned.
2. \`budgetPresentation\` — \`"usd"\` | \`"percent"\` | \`"hidden"\`.

Administrators always see real USD. For a non-admin user whose policy hides
values, the API omits every USD amount (no \`*Usd\`, no \`cost*\`, no
\`pricing*\` field) and returns percentages plus renewal timestamps instead.
The projection is centralized in one module so billing, keys, usage and the
model catalog cannot drift apart. Internal accounting is unchanged.

## Workstreams

### A. Relay session binding and daemon authorization (wave 1)

- A client socket is bound to the \`sessions\` row that authenticated it.
- Revocation (single session, family, all sessions, ban, delete, password
  reset) closes the affected sockets immediately, before the closing
  handshake, so no queued frame crosses the relay.
- A daemon socket revalidates its owner's account status on every inbound
  frame (cheap, prepared statement) and is closed when the account is no
  longer active; the daemon token cannot be used to reconnect while the
  account is banned.
- Coverage: revoked session, rotated refresh family, ban, unban, delete,
  password reset, and an independent user's sockets staying open.

### B. Aggregate limits, admission queue, IP defaults (wave 1)

- \`LIMIT_USER_RPM\` / \`LIMIT_USER_CONCURRENCY\` / \`LIMIT_GLOBAL_CONCURRENCY\`
  already exist; add a bounded queue with deadline and byte-size guards.
- Office/VPN defaults: 40 distinct employees behind one IP must all log in.
  The per-IP credential bucket must not trip on legitimate office egress,
  and the global IP bucket must not throttle health checks.
- \`/api/health\` (liveness) and \`/api/ready\` (readiness) are exempt from the
  shared public IP bucket.

### C. Global analytics on aggregated days (wave 1)

- Long/global queries must read \`usage_model_provider_monthly\` and
  \`usage_model_provider_daily\` for complete UTC days and only touch
  \`usage_events\` for the partial edges of the current day.
- The hourly/minute rollups serve sub-day windows after their coverage
  watermark.
- Measured target on 1M events: complete-day global stats and analytics in
  the low hundreds of milliseconds, not seconds; 503s only under genuine
  overload.
- 50 concurrent distinct-user analytics requests must mostly succeed.

### D. SQLite contention and supported backup (wave 1)

- Periodic jobs (billing heartbeat/recovery, usage flush, maintenance
  sweeps) retry transient \`SQLITE_BUSY\`/\`SQLITE_LOCKED\` with bounded backoff
  instead of exiting.
- Imports and cleanups work in batches.
- A supported backup command uses \`VACUUM INTO\` (or the online backup API)
  and preserves the credential-encryption secret; it can run while the
  gateway is serving, and a verification step re-opens the snapshot.

### E. Financial projects and cost centers (wave 2)

- \`projects\` (id, name, description, responsible user, optional shared
  budget, status) and \`project_members\`.
- \`api_keys.project_id\` associates a key with a project.
- \`usage_events.project_id\` and the rollup tables preserve the attribution
  at write time, so renaming/reorganizing a project never reclassifies
  historical spend.
- Consumption report per project; optional shared budget enforced like the
  existing USD periods.

### F. Roles, visibility policy, OIDC, bulk import (wave 2)

- Fixed roles: \`admin\`, \`project_manager\`, \`user\`. Cost visibility is
  independent of role.
- Configurable OIDC provider, optional "managed accounts must use SSO", MFA
  required for administrators.
- Bulk user import with preview + validation.

### G. Model access policies (wave 2)

- Allowed model sets per role and per project; enforcement in the proxy for
  every protocol, filtering in the catalog, and fallback targets must honour
  the same policy.

### H. Audit, correlation, observability (wave 3)

- Audit coverage for every mutation; \`request_id\` on audit and usage rows.
- Structured request logs that follow a call through provider attempts.
- Metrics: calls, errors, latency, concurrency, queue sizes, limit
  rejections, last backup age. Liveness/readiness split.

### I. Install and delivery (wave 3)

- Obscura archive extraction fixed (ZIP and tar.gz), version + checksum
  pinned, pre-installable offline, native Windows test.
- Static asset compression (Brotli/gzip), and reduced initial JS payload via
  lazy loading of the heaviest screens.
- Configurable retention for detailed usage events; aggregates keep 10 years.

### J. Capacity validation (wave 4)

- Ten-year fixture (500 users x 500 calls/day) with capacity report:
  API added p99 <= 100 ms, dashboard p99 <= 1000 ms, accuracy assertions for
  partial-day ranges, burst of 50 concurrent analytics requests.

## Testing rules

- New routes get black-box tests in \`test/\` that boot a real gateway.
- Anything time- or performance-sensitive is proven with a measurement, not
  a claim: the measurement is committed as a script and reproduced in CI or
  a documented command.
- Failures are fixed, never skipped. A test that cannot run without an
  external prerequisite is documented in the handoff, not silently skipped.
## Delivery status

**[delivered]** Relay session binding and daemon reauthorization — revoked
sessions, rotated families, bans, deletions and password resets close the bound
sockets before any further frame crosses the relay; a banned daemon token
cannot reconnect and an unbanned one redials without receiving a kill frame.
Tests: `test/gateway-relay-bans.test.ts`, `test/gateway-relay-revocation.test.ts`.

**[delivered]** Per-account aggregate limits with a bounded admission queue —
16 keys of one account cannot exceed the account ceiling, another account keeps
serving, and a burst waits inside the deadline instead of failing. Tests:
`test/gateway-admission.test.ts`.

**[delivered]** Financial visibility enforced server-side — installation
default plus per-user override for `showModelPrices` and
`budgetPresentation`; administrators always see USD; everyone else receives
percentages or no amounts at all, asserted on the HTTP payload. Tests:
`test/gateway-financial-policy.test.ts`.

**[delivered]** Model access policies — named allow-lists (default and
project) enforced before routing, so the catalog, a single-model read, the
requested model and every fallback target obey the same decision on every
protocol surface. Tests: `test/gateway-model-policy.test.ts`.

**[delivered]** SQLite contention — boot survives a held lock, periodic work
never blocks the request path, and cleanup runs in bounded batches. Tests:
`test/gateway-sqlite-contention.test.ts`, `test/gateway-contention.test.ts`,
`test/sqlite-retry.test.ts`.

**[delivered]** Supported backup — consistent snapshot while serving,
verification (including of a tampered snapshot), retention, and the
credential-encryption secret travelling with the copy. Tests:
`test/gateway-backup.test.ts`.

**[delivered]** Request correlation and audit coverage — `X-Request-Id` on
every response, the same id on the usage event and the audit row, and a profile
rename is audited with its before/after value. Tests:
`test/gateway-correlation.test.ts`.

**[delivered]** Detailed-event retention — detail expires, aggregates do not.
Tests: `test/usage-retention.test.ts`.

**[delivered]** Asset delivery — brotli/gzip with correct negotiation, ETag
and Range handling; route-level code splitting; latin-only font subsets and an
on-demand KaTeX stylesheet took the initial payload from 4.66 MB to 0.70 MB.
Tests: `test/static-compression.test.ts`.

**[delivered]** Obscura installation — ZIP and tar.gz read in-process (Bun's
archive reader rejects valid ZIP, which is the Windows release format),
version and SHA-256 pinned, air-gapped install supported, every archive member
unpacked. Tests: `test/obscura-install.test.ts`, `test/indirect-gen-ui-lint.test.ts`.

**[pending]** Financial projects and cost centers.

**[pending]** Roles beyond admin/user (project manager), corporate OIDC, MFA
enforced for administrators, bulk user import.

**[pending]** Metrics endpoint (calls, errors, latency, concurrency, queue
depth, rejections, backup age) — liveness and readiness already exist and are
exempt from the shared IP bucket.

**[pending]** Ten-year capacity fixture run (500 users x 500 calls/day) with
the p99 report.

