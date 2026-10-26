# Gateway analytics

## Date → available filters → results

Every view captures one half-open `[from, to)` interval in epoch milliseconds.
Calendar inputs use the browser's timezone; aggregation boundaries use UTC.
Filter options depend on this interval and the authenticated user's visibility,
not on other selected filters. The global endpoints require an administrator.

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

Usage ingestion updates events, daily ledgers and the monthly provider/model
ledger in one SQLite transaction. Migration 024 backfills monthly aggregates
from the existing daily ledger, preserving history independently of raw logs.
The initial backfill requires time proportional to the existing daily rows.
The developer seed script maintains the same monthly ledger.

Long-range queries use nonoverlapping segments:

1. Complete UTC months from `usage_model_provider_monthly`.
2. Remaining complete days at the two boundaries from
   `usage_model_provider_daily`.
3. Only the partial boundary days from `usage_events`.

Daily charts use daily aggregates; charts over 400 days use monthly buckets.
Input, cached input, output and their costs remain separate. Pricing/name joins
run after grouping, reducing repeated lookups for the same model or provider.
Event lists still read raw retained events and report their exact retained
counts; they do not substitute ledger counts for missing raw rows.

Covering indexes on `(user_id, date/month, reqs)` and `(date/month, user_id, reqs)`
also contain the dimensions of the WITHOUT ROWID primary key. Global date
windows and facet counts therefore avoid full-history table scans. The common
user/model request path additionally uses `(user_id, model, ts, id)`. No index
is added for every possible combination of checkbox selections.

## Isolation, caching and overload

Scoped analytics run on two worker threads, each with its own read-only SQLite
connection. They do not migrate, ingest, or change the source database. The
queries within each job share one read transaction, keeping rows and summaries
on the same snapshot. The proxy's event loop remains available while a query
groups or sorts.
The reader queue holds at most 16 jobs, with a 30-second deadline including
queue time. Saturation returns the normal dashboard error envelope with 503.
Reader replacement waits for termination, preserving the physical worker bound.

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

A local Windows run on 2026-10-26 used 1,000,000 raw events spanning 3,653 days,
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
