# Enterprise hardening validation checklist

This file records implementation and verification separately. A feature is not
qualified merely because its code exists. The detailed scope is in
`ENTERPRISE_COMPLETION_PROMPT.md`; operating contracts are in
`docs/gateway-enterprise.md`.

## Implemented and covered by regression tests

- [x] Revalidate the earlier correlation, financial policy, UI DTO, audit and
  maintenance fixes.
- [x] Financial projects/cost centers, optional shared monthly and lifetime
  budgets, immutable request attribution, scoped manager membership, public
  model policy resolution and populated-database migrations.
- [x] Project isolation, policy/alias/fallback behaviour and simultaneous
  shared-budget admission with in-flight reassignment.
- [x] Settlement and usage delivery durable together. Rollback on enqueue
  failure, forced process death before delivery and during an uncommitted
  drain, exactly-once raw/rollup delivery, uncertain recovery and original
  financial attribution after reassignment.
- [x] Settlement failure keeps an earned response but retains the pending hold,
  which keeps enforcing the budget; recovery settles it. Admission failure
  still fails closed before any provider call (`test/billing.test.ts`).
- [x] Optional OIDC with browser-bound state/PKCE, RS256 and ES256, explicit
  identity linking, managed SSO, enforced administrator MFA, recovery codes and
  security-policy session invalidation, including key rotation and relay policy
  revalidation.
- [x] Replacing an existing authenticator requires the current code plus the
  account password, or a session established with an unused recovery code.
- [x] Bounded JSON/CSV user import with preview, immutable replay results,
  reference revalidation and audited atomic commit; no invitations are sent.
- [x] Protected process metrics with bounded labels and sample storage.
- [x] Offline restore with manifest/path/hash checks and exact secret recovery;
  a running restored gateway served historical usage, the same balance, key
  reveal and a provider call.
- [x] Percentage/hidden presentation in Chromium against the real SPA and
  gateway: finite/zero/40 %/reserved/unlimited/near-limit/exhausted windows,
  keys and usage pages, and live policy changes.
- [x] Boot never runs an unbounded `ANALYZE`: a large database whose planner
  statistics were never built is skipped with an actionable message, and
  `scripts/analyze-gateway.ts` builds them offline. Scheduled jobs that hold the
  serving loop past their budget are reported.
- [x] Capacity fixtures build planner statistics, so measurements are not taken
  against degenerate plans.

## Gates recorded on the current source revision

- [x] `bun run lint` — clean, zero warnings (the previous run left one unused
  `upstreamStarted` binding from an interrupted proxy edit; removed).
- [x] `bun run typecheck` — clean.
- [x] `bun run build:web` — production SPA built (40 outputs).
- [x] `bun test` — 933 tests / 76 files: 932 pass, one parallel-run timing
  outlier (`test/usage-retention.test.ts`, health max 262.9 ms against a 250 ms
  bound while twelve files ran concurrently). The same file passes in isolation
  with a 92.1 ms maximum, so the maintenance path is bounded and the outlier is
  shared-runner scheduler noise, not a measured stall. It is reported, not
  silenced.

## Delivered physical cardinality measured

- [x] `tmp/enterprise-full400`: 500 users, 3,653 aggregate days,
  `usage_events` = **100,000,000** rows (400 detailed days),
  `billing_reservations` = **7,500,000** settled (30 days),
  `audit_log` = **1,095,005** (365 days), monthly rollups = **913,250,000**
  represented requests. `gateway.db` = 13,686,640 pages ≈ **56 GB**.

## Not verified — must not be reported as passing

- [ ] **Agreed p99 targets on the delivered retention profile.** The full400
  fixture exists and is complete, but this host could not produce the
  measurement: a full `ANALYZE` of `usage_events` at cold cache did not finish
  in fifteen minutes, and the gateway boot that depended on it exceeded the
  30 s harness deadline. The code defect behind that dependency is fixed
  (bounded statistics, offline command), but the numbers themselves were not
  obtained. Exact command and prerequisite:
  `bun scripts/analyze-gateway.ts` with `DATA_DIR` pointing at the fixture
  (gateway stopped), then
  `bun scripts/test-gateway-enterprise.ts --reuse --dir=tmp/enterprise-full400 --samples=1200 --rate=32 --report=…`
  on a native host with ≥100 GiB free and, preferably, Linux. Until that run
  exists, `api-added p99 <= 100 ms` and `dashboard p99 <= 1000 ms` remain
  unmeasured for the delivered profile.
- [x] Enterprise administration browser regressions on a fresh six-user fixture:
  project creation with a shared budget, membership save, financial defaults,
  model policy, bulk import preview/commit, corporate-auth section keyboard
  navigation, verified backup, `project_manager` scope isolation and
  administrative refusal — 0 failed interactions, 0 runtime errors.
- [x] Exploratory browser timing on the same fixture, reuse path, 60
  interactions (20 per page): p50 488 ms, p95 734 ms, p99 1,125 ms; per page
  `/` 347/380/1,125, `/usage` 562/768/773, `/admin/stats` 488/553/664. Chromium
  153.0.8010.12, Bun 1.4.2 arm64, loopback. The single 1,125 ms sample is a
  cold first navigation, and with 20 samples the p99 is the maximum, so this
  does not establish the 1,000 ms target either way.
- [ ] Streaming/non-streaming mixed traffic, maintenance/backup interference
  during measurement, and a sustained soak crossing scheduled maintenance.
- [ ] Ten-year audit cardinality (the fixture profile seeds 365 audit days) and
  any claim of ten-year reliability from a finite soak.
- [ ] The explicit capacity workflow has not executed on a dedicated native
  runner; a local exploratory result is not a qualification.
