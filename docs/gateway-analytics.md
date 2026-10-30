# Gateway analytics

## Date → available filters → results

Every view captures one half-open `[from, to)` interval in epoch milliseconds.
Calendar inputs use the browser's timezone; aggregation boundaries use UTC.
Retained raw events support exact millisecond boundaries. If an endpoint falls
inside a UTC day before the declared raw-retention boundary, that endpoint is
expanded to include the whole day. Responses report both `history.requested`
and `history.effective`, `history.rawFrom`, the available `resolution`
(`millisecond` or `day`), and whether bounds were `adjusted`. The dashboard
shows the adjustment; comparison windows report `previousHistory` separately.
This preserves archived boundary-day totals without presenting them as an
exact partial day. Filter options use the same effective interval and the
authenticated user's visibility. Global endpoints require an administrator.

The filter-options endpoint has two operations:

- Without `field`, return category metadata and validate the supplied selections.
  Values absent from the date window are removed, including exclusion values.
- With `field`, return a ranked page of that category's values and request
  counts. `q` searches names and identifiers literally; SQL wildcard characters
  are escaped. Counts sort descending, then names and identifiers break ties.

Pages default to 60 options, with a maximum of 100. Search is capped at 200
characters; selections are capped at 250 values. Only the open category is
loaded. The browser debounces search by 150 ms and result selections by 120 ms,
aborts obsolete option requests, and never renders options from an old range.
Date changes validate and retain applicable selections before submitting the
new result query. Invalidated selections cannot turn into hidden constraints.

## Storage and query cost

Usage ingestion updates events and the minute, hour, daily and monthly ledgers
in one SQLite transaction. Migration 024 backfills monthly aggregates from the
existing daily ledger, preserving history independently of raw logs. Migration
027 starts sub-day coverage at the next complete bucket without assuming older
raw events have already been rolled up. Until a rebuild covers them, queries
read those intervals from raw events.

Long-range queries use nonoverlapping segments:

1. Complete UTC months from `usage_model_provider_monthly`.
2. Remaining complete days from `usage_model_provider_daily`.
3. Covered complete hours and minutes from their dimension-preserving ledgers.
4. The two partial-minute edges, and intervals without rollup coverage, from
   `usage_events`.

Daily charts use daily aggregates; charts over 400 days use monthly buckets.
Input, cached input, output and their costs remain separate. Pricing/name joins
run after grouping, reducing repeated lookups for the same model or provider.
Event lists still read raw retained events with the original requested bounds
and report their exact retained counts; they do not substitute ledger counts
for missing raw rows. Their `history.rawFrom` states the retention boundary,
and the Usage page displays it alongside the list.

By default the gateway keeps hourly rollups for 90 UTC calendar days and minute
rollups for three. `ANALYTICS_HOURLY_DAYS` and `ANALYTICS_MINUTE_DAYS`
change those windows. Cleanup advances the coverage watermark before deleting
at most 1,000 old rows from each table per minute; a query falls back to retained
raw events when the finer rollup is no longer covered. Daily and monthly history
is independent of these sub-day windows. This does not itself delete raw events.

Rebuild covered sub-day rows from retained raw events with the gateway stopped:

```sh
DATA_DIR=/path/to/data bun scripts/rebuild-usage-rollups.ts --raw-from=2026-08-01
```

`--raw-from` is the first UTC day for which all raw events are retained; use
`1970-01-01` when raw history has never been pruned. Optional `--from`,
`--minute-from` and exclusive `--to` are UTC dates. The defaults rebuild
the configured hour/minute windows through the end of the current UTC day.
The producer replaces one day per write transaction, verifies its raw event
count against the durable daily ledger, and publishes coverage only for
completed days. Live ingestion remains consistent but may receive retryable
storage errors during a rebuild, so offline operation is recommended. Programmatic
offline importers can call `rebuildUsageRollups(db, { from, to, rawFrom,
minuteFrom })` from `server/usage-rollup.ts`, with day-aligned epoch
milliseconds and an exclusive `to`.

The raw boundary is an operator declaration, not a guess based on the oldest
event. If raw events are pruned or imported outside the gateway, set the correct
boundary while the gateway is offline and rebuild before serving queries; do
not remove arbitrary retained rows while leaving the boundary unchanged.

Covering indexes on `(user_id, date/month, reqs)` and `(date/month, user_id, reqs)`
also contain the dimensions of the WITHOUT ROWID primary key. Global date
windows and facet counts therefore avoid full-history table scans. The common
user/model request path additionally uses `(user_id, model, ts, id)`. No index
is added for every possible combination of checkbox selections.

## Isolation, caching and overload

Scoped analytics run on CPU-aware worker threads, each with its own read-only SQLite
connection. They do not migrate, ingest, or change the source database. The
queries within each job share one read transaction, keeping rows and summaries
on the same snapshot. The proxy's event loop remains available while a query
groups or sorts.
The default is two thirds of the available CPU threads, bounded to two through eight.
At most 256 distinct jobs can be pending, with a five-second deadline including
queue time; `ANALYTICS_READERS`, `ANALYTICS_PENDING` and
`ANALYTICS_DEADLINE_MS` tune these bounds. Saturation returns the normal
dashboard error envelope with 503.
Reader replacement waits for termination, preserving the physical worker bound.
Identical requests share a job; a disconnected caller leaves that shared job
alone while other callers still need it. A job with no remaining callers is
removed from the queue or its running worker is terminated.

Identical in-flight requests share one job. Query result caches are LRU bounded
to 256 entries and an 8 MiB encoded key/result budget per process, with a
30-second TTL and a 2 MiB per-entry
limit. Pending work is separately bounded. Cache keys contain tenant identity,
exact bounds, canonical selections and query parameters. Ingestion invalidates
overlapping user/global windows; audited metadata changes invalidate names and
pricing; external SQLite writes are detected through `PRAGMA data_version`.
Writes during an in-flight read prevent that result from entering the cache.
The cache is disposable and never replaces the database ledger.

Grid headers request `summary=1`, avoiding discarded row queries. Counts and
footer totals are cached independently of sorting and pagination. Column filters
are disabled on Usage and Global stats, including their persisted legacy state.

## Validation and capacity measurements

Run the isolated benchmark with:

```sh
bun scripts/bench-usage-filters.ts --events=1000000 --days=3653 --cardinality=50000
```

It creates a temporary database, checks query plans, measures uncached/cached
queries including JSON encoding, and probes event-loop delay during a reader
query. It never seeds the configured gateway database. `--reuse` accepts only a
previous isolated benchmark directory directly under the OS temporary directory.

A historical local Windows run on 2026-10-26 used 1,000,000 raw events spanning 3,653 days,
751,376 daily rows and 50,000 additional archived model IDs in a 538 MiB database.
The archived IDs exercise option cardinality and pagination. Application-cold
measurements keep OS/SQLite pages warm; they are not cold-disk or network timings.

| Query | Uncached p95 | Cached p95 | JSON payload |
| --- | ---: | ---: | ---: |
| Global options, 30 days | 14.71 ms | 0.28 ms | 4.1 KiB |
| Global options, 10 years | 428.65 ms | 0.32 ms | 4.1 KiB |
| Global option search, 10 years | 200.12 ms | 0.20 ms | 0.1 KiB |
| Global chart, 10 years | 921.70 ms | 0.33 ms | 18.2 KiB |
| Global model grid, 10 years | 1,923.86 ms | 1.23 ms | 27.0 KiB |

The main-loop probe's maximum delay was 23.36 ms while the worker performed the
model-grid query. Monthly aggregates also reduced the long chart's payload from
467.3 KiB in the daily-only prototype to 18.2 KiB. These are synthetic local
measurements, not a production SLA. Capacity depends on event rate, dimension
cardinality, hardware and concurrency; measure those workloads before changing
reader limits or choosing a separate analytical database.

Black-box tests cover ownership, date boundaries, leap February, monthly/daily
parity, pricing, pagination, literal search, ingestion/external-write invalidation
and cache coalescing. The browser regression covers date-first option loading,
selection pruning, bounded option pages, and popup stability across responsive
layouts and themes.
