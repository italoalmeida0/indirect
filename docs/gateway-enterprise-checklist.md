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
- [x] `bun test` — **933 pass, 0 fail** across 76 files (`bun test` on Bun
  1.4.2 arm64, 305 s). Two earlier runs reported one overlapping timing
  assertion each (`test/usage-retention.test.ts` health maximum 262.9 ms against
  its 250 ms budget; `test/gateway-sqlite-contention.test.ts` before its
  assertion was aligned with the rationale its sibling test already documented).
  Both were investigated rather than retried away: the retention probe measures
  92.1 ms maximum in isolation, and the contention file's steady-state per-sample
  bound lives in its dedicated test.

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

**Caveat that makes these numbers pessimistic:** `usage_events` carries **no
planner statistics** in this fixture. `PRAGMA analysis_limit` is not honoured in
this environment — `ANALYZE` on the 5.48M-row rollup tables took 27–155 s, which
is a full index walk, not a bounded sample — so a full `ANALYZE` of the
100M-row table is not feasible here. A real installation builds those statistics
incrementally as it grows, so its plans for the events grid and partial-day
edges would be better than measured. The administrative aggregates do not touch
`usage_events`, so their 5-second timeouts are not explained by this caveat.

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

- [ ] **Sub-day rollups stay empty for pre-existing detailed data.** On a freshly
  seeded quick fixture, `usage_rollup_coverage` reported `hourly_from` advanced to
  roughly the present while `usage_hour_rollups` and `usage_minute_rollups` held
  **0 rows** for 500,000 detailed events across two days, so recent windows fell
  back to scanning `usage_events` (a 14-day dashboard request cost 3.5 s). The
  production backfill then rebuilt them correctly in 47 hours of coverage. What
  remains unexplained is why the watermark advanced without materialising rows —
  either a backfill defect or a range the backfill refuses — because both would
  leave a restored installation paying raw scans until the next scheduled rollup.
  The fixture now writes hour rollups at seed time, which hides the symptom
  without answering the question.
- [ ] Ten-year audit cardinality (every fixture profile seeds 365 audit days).
- [ ] A dedicated streaming-throughput profile at the agreed arrival rate (the
  soak measured streaming under mixed load, and sustained traffic has not been
  run against the delivered retention).
- [ ] The explicit capacity workflow has not executed on a dedicated native
  runner; a local result on a laptop is evidence, not a qualification.
