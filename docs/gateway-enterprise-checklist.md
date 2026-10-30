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
  against degenerate plans, and seed hour rollups the way live ingestion does,
  so recent windows never fall back to scanning raw events.
- [x] Windows longer than four months chart from the monthly rollup
  (`USAGE_MONTHLY_CHART_SPAN`) instead of the daily table. Before this, a
  ten-year or one-year dashboard request exceeded the 5,000 ms analytics job
  budget and answered `503 "Analytics is busy"`; after it, ten-year stats answer
  in ~690 ms and every ordinary window succeeds.

## Gates recorded on the current source revision

- [x] `bun run lint` — clean, zero warnings (the previous run left one unused
  `upstreamStarted` binding from an interrupted proxy edit; removed).
- [x] `bun run typecheck` — clean.
- [x] `bun run build:web` — production SPA built (40 outputs).
- [x] `bun test` — **933 pass, 0 fail** across 76 files (`bun test` on Bun
  1.4.2 arm64, 305 s). Two earlier runs reported one overlapping timing
  assertion each (`test/usage-retention.test.ts` health maximum 262.9 ms against
  its 250 ms budget; `test/gateway-sqlite-contention.test.ts` before its
  assertion was aligned with the rationale its sibling test already documented).
  Both were investigated rather than retried away: the retention probe measures
  92.1 ms maximum in isolation, and the contention file's steady-state per-sample
  bound lives in its dedicated test.

## Delivered physical cardinality measured

- [x] `tmp/enterprise-full400`: 500 users, 3,653 aggregate days,
  `usage_events` = **100,000,000** rows (400 detailed days),
  `billing_reservations` = **7,500,000** settled (30 days),
  `audit_log` = **1,095,005** (365 days), monthly rollups = **913,250,000**
  represented requests. `gateway.db` = 13,686,640 pages ≈ **56 GB**.

## Measured qualification run (quick profile, native ARM64)

Host: Snapdragon X Elite 12-core, 16 GB RAM, Windows 11 ARM64, Bun 1.4.2
arm64 (native, not emulated), production durability, local fixture upstream
with a 20 ms wait, `BUN_CONFIG_MAX_HTTP_REQUESTS=2048`.
Fixture: 500 users, 3,653 aggregate days, 2 detailed days with hour rollups,
`gateway.db` = 7.2 GB, 5,479,500 daily rollup rows, 500,000 raw events,
913,250,000 represented requests. Correctness precheck passed
(historical 913,250,000; partial user range 1,000 against an independently
counted query).
Command:
`bun scripts/test-gateway-enterprise.ts --dir=tmp/enterprise-quick-3 --samples=1200 --rate=32`
(report: `tmp/enterprise-continuation/quick3-api.json`).

| Workload | Agreed p99 | Measured p50 / p95 / p99 / max | Errors |
| --- | --- | --- | --- |
| Gateway-added API latency, 32 req/s, 1,200 samples | ≤100 ms | 19.6 / 124.2 / **270.7** / 481.3 ms | 0/1,200 |
| Total proxy latency, same workload | — | 40.6 / 144.7 / 291.1 / 502.5 ms | 0/1,200 |
| Dashboard APIs, 12 req/s, 1,200 samples | ≤1,000 ms | 8.0 / 257.5 / **2,298.6** / 5,006.8 ms | 1/1,200 (503) |
| 50-user distinct analytics burst | ≤1,000 ms | 806.8 / 1,417.3 / **1,418.6** / 1,418.6 ms | 0/50 |

Per dashboard route p99: `/api/usage/overview` 68.8, `/api/usage/analytics`
66.8, `/api/usage/events` 25.7, `/api/usage/filter-options` 15.6, `/api/keys`
40.6, `/api/billing` 13.5, `/api/admin/users` 14.6, `/api/admin/keys` 11.5,
`/api/admin/audit` 205.0, `/api/admin/usage-filter-options` 8.9,
**`/api/admin/stats` 1,945.0** and **`/api/admin/analytics` 5,006.8 (the single
503)**. Every non-administrative dashboard route is comfortably inside the
budget; the whole overrun comes from the two cross-user administrative
aggregates and from queueing during the 50-way burst.

**Verdict: the agreed targets are NOT met on this host.** Two defects behind the
worst of it were found and fixed in this round — long windows now read monthly
rollups instead of the daily table (`USAGE_MONTHLY_CHART_SPAN`), which removed
every `503 "Analytics is busy"` from ordinary windows and took ten-year stats
from >5,000 ms to ~690 ms, and the fixture now seeds hour rollups the way live
ingestion does, because a fixture without them made every recent window scan
raw events. What remains is host throughput on the two admin aggregates
(~100–150k rows/s for a seven-dimension grouping on this laptop) and admission
queueing under a 50-way burst; closing it needs either a covering index plus a
single materialised scan per analytics page, or qualification on the intended
server hardware.

## Not verified — must not be reported as passing

- [ ] **Delivered-retention (full400) measurement.** The fixture is complete and
  verified (100,000,000 raw events, 56 GB), but this host could not serve the
  gateway from it: a full `ANALYZE` of `usage_events` at cold cache did not
  finish in fifteen minutes. The boot-side dependency is fixed (bounded
  statistics plus `scripts/analyze-gateway.ts`), the numbers are not obtained.
  Prerequisites: run `bun scripts/analyze-gateway.ts` against the fixture while
  the gateway is stopped, then
  `bun scripts/test-gateway-enterprise.ts --reuse --dir=tmp/enterprise-full400 --samples=1200 --rate=32`,
  preferably on native Linux with ≥100 GiB free.
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
- [ ] **Sub-day rollups stay empty for pre-existing detailed data.** On the
  quick fixture, after boot, `usage_rollup_coverage` reports `hourly_from` and
  `minute_from` advanced to roughly the present, while `usage_hour_rollups` and
  `usage_minute_rollups` both hold **0 rows** for 500,000 detailed events seeded
  across two days. Recent windows therefore fall back to scanning
  `usage_events`, which is what makes a 14-day dashboard request cost 3.5 s and
  an analytics request exceed its budget. The backfill watermark advancing
  without materialising rows needs a dedicated investigation: either it is a
  real backfill defect or the seeded history is outside the range it accepts,
  and both would leave a real installation paying raw scans after a restore
  until the next scheduled rollup.
- [ ] Ten-year audit cardinality (the fixture profile seeds 365 audit days) and
  any claim of ten-year reliability from a finite soak.
- [ ] The explicit capacity workflow has not executed on a dedicated native
  runner; a local exploratory result is not a qualification.
