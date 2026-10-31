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
- [x] **Sub-day coverage after a restore is bounded and self-healing, not stalled.**
  Migration 027 starts `hourly_from`/`minute_from` at the next complete
  hour/minute on purpose: rows that already exist are not assumed to have
  rollups. The scheduled `analytics rollup cleanup` job therefore runs
  `backfillHourRollups` in a loop of `USAGE_HOURLY_BACKFILL_HOURS` (6) one-hour
  steps, so coverage extends backwards **6 hours per minute** — roughly 27 hours
  to rebuild 400 days of hourly coverage from retained events. It never crosses
  `hour_floor` or the raw-retention boundary, so it cannot claim coverage for
  deleted rows. An earlier note here read this watermark as an unexplained
  anomaly; it was the documented initial value. `test/analytics-rollup.test.ts`
  now pins the behaviour: bounded 6-hour steps, convergence onto exactly the
  retained events, a declining step once nothing older exists, and a floor that
  stops it.
- [x] Windows longer than four months chart from the monthly rollup
  (`USAGE_MONTHLY_CHART_SPAN`) instead of the daily table. Before this, a
  ten-year or one-year dashboard request exceeded the 5,000 ms analytics job
  budget and answered `503 "Analytics is busy"`; after it, ten-year stats answer
  in ~690 ms and every ordinary window succeeds.
- [x] **Frontend interaction target met.** Enforced run
  (`--enforce-p99`, 1,000 interactions, production SPA, real gateway, loopback,
  Chromium 153.0.8010.12): p50 474.5 ms, p95 647.6 ms, **p99 701.3 ms** against
  the 1,000 ms target, 0 failed interactions and 0 runtime errors. Per page p99:
  `/` 400, `/usage` 731, `/admin/stats` 579 ms. The interaction starts at the
  document navigation and ends after the target API responded, the populated
  page reported `aria-busy=false` and two animation frames elapsed. Fixture: the
  six-user correctness fixture (900 represented requests), not the delivered
  retention profile — so this qualifies the browser path, not the
  administrative aggregate cost measured below.

## Gates recorded on the current source revision

- [x] `bun run lint` — clean, zero warnings (the previous run left one unused
  `upstreamStarted` binding from an interrupted proxy edit; removed).
- [x] `bun run typecheck` — clean.
- [x] `bun run build:web` — production SPA built (40 outputs).
- [x] `bun test` — **934 pass, 0 fail** across 76 files on Bun 1.4.2 arm64
  (`--max-concurrency=4`, 357 s). Default parallelism is fine where the suite
  owns the disk: the native Linux CI job runs `bun test` with no concurrency flag
  and passes. On this workstation, once ~65 GB of capacity fixtures sit on the
  same volume, default parallelism intermittently produces noise — one run hit a
  transient `SQLiteError: disk I/O error` in the shared end-to-end gateway that
  cascaded into 56 failures, another timed out a single relay test at 25 s. Both
  affected files pass in isolation (83/83 in 24.9 s and 4/4 in 6.2 s), so the
  cause is host I/O rather than a regression; the bounded-concurrency run is what
  is recorded here, and the fix is to keep fixtures off the working volume or to
  bound concurrency, not to change the suite.

## Where the administrative analytics page spends its time

`USAGE_ANALYTICS_TRACE=1` logs each stage of one analytics page. On the quick
fixture, one uncached admin request per window:

| Window | series | chart | comparison | dimensions | four breakdowns | total |
| --- | --- | --- | --- | --- | --- | --- |
| 90 days | 3,430 ms | 179 ms | 577 ms | 170 ms | 21 ms | ~4.4 s |
| 365 days | 968 ms | 569 ms | 2,309 ms | 760 ms | 35 ms | ~4.7 s |
| ten years | 1,431 ms | 1,083 ms | — | 1,300 ms | 23 ms | ~3.8 s |

The first stage to touch a window pays its cold read and every later stage over
the same rows is cheap — that is why the chart costs 179 ms right after the
series costs 3,430 ms over identical data. The consequence for the target is
that an analytics page reads **two** windows (the range and its comparison), so
at least one of them is always cold: 365 days spends 2.3 s on the comparison
alone.

This is why a coarse rollup alone would not reach 1,000 ms here. A
user-independent daily rollup collapses the series, chart and comparison to a few
hundred rows, but the people chart needs per-user rows, and 90 days of 500 users
is 45,000 rows even at the coarsest useful grain (user × day, no key, no model) —
still a cold read on this disk. Reaching the target for cross-user analytics at
500 users needs a host whose cold read of the retention window is fast (server
NVMe and more RAM than the 16 GB available here), not just a different schema.

- [x] **All four gates also passed on native Linux CI**, not only on this
  Windows ARM64 laptop: run `41168782145` on the pushed `dev` revision reports
  `Install dependencies`, `Lint`, `Typecheck`, `Unit + integration tests` and
  `SPA build sanity` as successful in the `Gateway (Linux)` job, and the
  enterprise browser evidence step before the failing one also passed. The job
  then fails at `Transcript browser regressions`, which is outside this brief's
  gateway scope and pre-existing (see below).

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

Per dashboard route p99: `/api/usage/overview` 31, `/api/usage/analytics` 67,
`/api/usage/events` 30, `/api/usage/filter-options` 22, `/api/keys` 14,
`/api/billing` 15, `/api/admin/users` 13, `/api/admin/keys` 9,
`/api/admin/audit` 51, `/api/admin/usage-filter-options` 14,
**`/api/admin/stats` 1,974** and **`/api/admin/analytics` 4,908**. Every
non-administrative dashboard route is inside the budget; the whole overrun comes
from the two cross-user administrative aggregates, which read 500 users' rows
per bucket while a personal page reads one user's (measured: personal analytics
p50 16 ms, admin analytics p50 1,373 ms), and from queueing during the 50-way
burst.

**Split-process methodology correction — the API target passes.** The numbers
above were produced with the fixture's upstream and the load generator in one
process, so generator queueing was charged to the gateway. Measuring the same
gateway from a second process (`--serve` in one, `--base=<url>` in the other;
the per-request upstream time still comes from the response header) gives:

| Workload | Agreed p99 | Measured p50 / p95 / p99 / max | Errors |
| --- | --- | --- | --- |
| Gateway-added API latency, 32 req/s, 1,200 samples | ≤100 ms | 12.5 / 50.5 / **69.3** / 78.4 ms | 0/1,200 |
| Total proxy latency, same workload | — | 33.5 / 71.4 / 89.8 / 105.5 ms | 0/1,200 |
| Dashboard APIs, 12 req/s, 1,200 samples | ≤1,000 ms | — / — / **2,355.2** / — ms | 0/1,200 |
| 50-user distinct analytics burst | ≤1,000 ms | 842 / — / **1,431.1** / — ms | 0/50 |

So the gateway-added latency target **is met** (p99 69.3 ms against 100 ms) and
the co-located generator was inflating it by ~4x. The dashboard and burst
targets are not met, and the cause is isolated to the cross-user administrative
aggregates: closing it needs a global (user-independent) daily rollup for
administrative charts, because at 500 users a cross-user bucket reads 500 times
the rows of a personal one.

**Verdict: two of the four agreed measurements pass on this host.** Gateway-added
API latency passes at p99 69.3 ms (target 100 ms) and the frontend interaction
target passes at p99 701.3 ms (target 1,000 ms). The dashboard API target
(2,355 ms) and the 50-user burst (1,431 ms) do not. Two defects behind the worst
of it were found and fixed in this round — long windows now read monthly rollups
instead of the daily table (`USAGE_MONTHLY_CHART_SPAN`), which removed every
`503 "Analytics is busy"` from ordinary windows and took ten-year stats from
>5,000 ms to ~690 ms, and the fixture now seeds hour rollups the way live
ingestion does, because a fixture without them made every recent window scan raw
events. What remains is cross-user aggregate cost on the two administrative
endpoints and queueing during the 50-way burst; closing it needs a
user-independent daily rollup for administrative charts (a cross-user bucket
reads 500x the rows of a personal one), a coarser per-user daily rollup for the
people chart, and a dedicated pass on burst admission, or qualification on the
intended server hardware.

## Delivered-retention qualification (400 detailed days, 100M events)

Fixture: 500 users, 3,653 aggregate days, **100,000,000** detailed events
(400 days), **7,500,000** settled reservations (30 days), **1,095,005** audit
rows, 913,250,000 represented requests. As seeded it was 13,686,640 pages
(~56 GB); after the bounded hour-rollup backfill (5,198,500 hour rows, 200
passes) `gateway.db` is **55 GB**. Method: gateway served in one process
(`--serve`), load generator in another (`--base`), 1,200 samples at 32 req/s,
production durability, local fixture upstream.

- **Accounting exactness passed**: `/api/admin/stats?from=all` reported
  913,250,000 historical requests and the partial user range matched an
  independently counted query (7,073), so ten-year aggregates survive the
  deletion window at full cardinality.
- **Gateway-added API latency**: p50 13.4 / p95 114.8 / **p99 164.2** / max
  235.2 ms, **0/1,200 errors**, 1,200/1,200 responses `200`.
- **Dashboard APIs**: p99 **5,019.9 ms** with **28/1,200 errors** (`503` from the
  5,000 ms analytics read budget). Per route p99: `/api/admin/stats` 5,325 (12
  errors), `/api/admin/analytics` 5,122 (16), `/api/usage/events` 2,512,
  `/api/usage/filter-options` 993, `/api/usage/overview` 962,
  `/api/usage/analytics` 626, `/api/keys` 508, `/api/admin/keys` 431,
  `/api/admin/usage-filter-options` 262, `/api/billing` 164,
  `/api/admin/users` 45.
- **50-user burst**: p99 1,362.6 ms, 0 errors.

**Verdict at delivered retention: not qualified on this host.** The dashboard
budget and the zero-error requirement fail; the proxy overhead budget fails at
164 ms against 100 ms, though it passed on the quick profile at 69.3 ms, so the
difference is the larger detailed table and 16 GB of RAM against a 55 GB
database, not the gateway's request path.

**Correction — `analysis_limit` works, and the event table now has statistics.**
An earlier note here claimed the pragma was ignored because `ANALYZE` on a
5.48M-row table took 27–155 s. That was wrong: the pragma is honoured and the
cost was cold random I/O. Controlled measurement on a 2M-row table gives 78 ms
with `analysis_limit=8` against 216 ms with `0`; on the 10,950,005-row audit
table it is 787 ms warm against 28,215 ms cold. `ANALYZE usage_events` on the
55 GB fixture then completed in **1,252.7 s (20.9 min)** and wrote full
statistics for all seven indexes (100,001,250 rows).

**The delivered-retention numbers are dominated by page-cache state, not by
plans.** Three runs of the same workload on the same fixture:

| Run | Host state | Accuracy precheck | API p99 | Dashboard p99 (errors) |
| --- | --- | --- | --- | --- |
| before statistics | warmed by the 5.2M-row hour backfill | passed | 164.2 ms | 5,019.9 ms (28) |
| after statistics | still flushing the 20-minute ANALYZE | passed | 3,867.8 ms | 7,448.9 ms (117) |
| after statistics, restarted | 0.2 GiB of 15.6 GiB RAM free | **failed (503)** | — | — |

In the second run even `/api/admin/keys` reached 4,306 ms at p99 and `/api/billing`
6,036 ms, which no query plan explains. A 55 GB database against 16 GB of RAM
cannot hold its working set, so the same workload moves by more than an order of
magnitude with cache state and at times cannot complete the ten-year accuracy
check inside the 5 s analytics budget. That is the binding constraint on this
host, and it is why the dashboard and burst targets are reported as unmet rather
than as an optimisation still to land.

## Browser gates

- [x] Enterprise administration browser regressions on a fresh six-user fixture:
  project creation with a shared budget, membership save, financial defaults,
  model policy, bulk import preview/commit, corporate-auth section keyboard
  navigation, verified backup, `project_manager` scope isolation and
  administrative refusal — 0 failed interactions, 0 runtime errors.
- [x] Enforced frontend p99 on the same fixture: 1,000 interactions, p50 474.5 /
  p95 647.6 / p99 **701.3** ms (target 1,000), 0 failed interactions, 0 runtime
  errors; per page `/` 400, `/usage` 731, `/admin/stats` 579 ms.
- [x] Exploratory reuse run, 60 interactions (20 per page): p50 488 / p95 734 /
  p99 1,125 ms; per page `/` 347/380/1,125, `/usage` 562/768/773,
  `/admin/stats` 488/553/664. With 20 samples the p99 is the maximum, so this
  neither confirms nor refutes the target — it only informed it.

## Ten-year audit cardinality (10,950,005 rows)

`bun scripts/test-gateway-enterprise.ts --seed-only --users=500
--requests-per-user-day=500 --raw-days=2 --audit-days=3650 --reservation-days=2`
seeds ten years of audit history (500 users × 6 entries × 3,650 days) into a
9.3 GB fixture. Measured on that fixture:

| Query | Result |
| --- | --- |
| first page, cold | 155 ms |
| first page, warm (3 runs) | 157 / 157 / 191 ms |
| deep keyset cursor page | 190 ms |
| exact action filter (`login.success`) | 209 ms cold, 238 ms warm, total 3,650,001 |
| sort by `ts` | 3,763 ms |
| sort by `actor_email` | 13,299 ms |

Paging and filtering hold up at ten-year cardinality; **custom column sorts do
not**. The page query wraps `SELECT a.*, u.email … FROM audit_log a LEFT JOIN
users u` in subqueries, so `ORDER BY` cannot use `idx_audit_ts` and the whole
history is sorted: 3.8 s for a `ts` sort and 13.3 s for a sort on the joined
actor email. Default order (newest first) and cursor paging are unaffected, so
this is not on the measured dashboard path, and it is reported rather than
fixed: the fix (order and limit the bare table, then join the actor for the page)
touches the audit page's SQL and belongs behind its own regression test.

## Sustained mixed soak (quick profile)

`bun scripts/soak-gateway.ts --dir=tmp/enterprise-quick-3 --minutes=11 --rate=8`
— 3 proxy arrivals to 1 dashboard read, open loop, 674 s, on the 500-user quick
fixture. All six dashboard routes were exercised (208 arrivals each), plus 3,744
proxy completions.

- **4,992 arrivals, 4,992 `200`**: 0 client errors, 0 server errors, 0 network
  errors.
- **Memory bounded**: 140 MiB after warm-up, 159 MiB peak, 74 MiB final — the
  run ends below its baseline.
- **Write-ahead log bounded**: 5.35 MiB peak.
- **Scheduled maintenance ran and never failed**: usage flush 624, billing
  heartbeat 44, billing recovery 11, analytics rollup cleanup 11, WAL checkpoint
  2, detailed-event retention 2 — 0 failures across all six jobs.

**Streaming under the same mixed load** (`--stream-share=3`, 481 s, 3,768
arrivals, 942 streaming completions): 0 errors, memory 141 → 66 MiB with a
159 MiB peak, WAL 4.8 MiB, and the six jobs again ran without a failure. First
byte arrived at p50 62.5 / p95 132.7 ms and the stream closed at p50 108.5 /
p95 163 ms, leaving a **median gap of 45.4 ms** (p95 67.4) between first byte and
close — the fixture upstream holds 60 ms between its two frames, so the relay is
forwarding frames as they arrive rather than buffering the body. 157 of the 942
streams (16.7%) arrived as a single read because this client's first read landed
after both frames were buffered under load; that count is reported, and the
assertion is on the population median, which is the claim a soak can defend.

Neither run says anything about ten-year reliability: minutes are not years, and
the fixture retains two detailed days rather than 400.

## Not verified — must not be reported as passing

- [ ] **The capacity qualification workflow has never completed a run.** Two
  independent reasons: GitHub only dispatches `workflow_dispatch` for a workflow
  that exists on the default branch (`main` holds `ci.yml` and `release.yml`
  only, while this one lives on `dev`), and the repository has **0 registered
  self-hosted runners** for its default labels
  `["self-hosted","linux","ARM64","enterprise-capacity"]`
  (`gh api .../actions/runners` → `total_count: 0`). The preflight also requires
  20 GiB free for the quick profile and 100 GiB for full400, which a
  GitHub-hosted runner does not provide.
- [ ] **`dev` CI is red for reasons that predate this work.** On the pushed
  revision the `Gateway (Linux)` job passed dependency install, lint, typecheck,
  `bun test`, SPA build sanity and the enterprise browser evidence, and failed
  only at `Transcript browser regressions` (`0 !== 1`, an Indirect Code transcript
  script). The Go daemon and race jobs also fail. The run that precedes this work
  (`41071388519`) failed the same `Gateway (Linux)` job with a different browser
  assertion (`Expected: > 1000`), so the red state is inherited; the Indirect Code
  suite needs its own investigation and its scripts require `dist/`, the daemon
  binary and `META_API_KEY`, none of which this session set up.
- [ ] Sustained traffic against the delivered retention. The soaks ran on the
  quick profile; the delivered-retention runs could not be repeated once free
  memory fell to 0.2 GiB of 15.6 GiB.
