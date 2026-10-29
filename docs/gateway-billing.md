# Gateway USD plans and spending limits

The gateway meters billable usage in USD. These are spending allowances, not
subscription payments. There is no payment processor or invoicing flow.

## Account plans

Administrators create plans under **Plans** and assign them under **Users**.
An account without a plan is unlimited. A named plan may also be unlimited.
A finite plan has a monthly USD allowance; weekly and 5-hour distribution
switches default to off. All keys, protocols and clients share the account cap.
Administrators can select a plan when creating a user.

- Monthly: calendar month, renewing on the first day at 00:00 UTC.
- Weekly: Monday 00:00 UTC through the following Monday. Allowance is
  `monthly allowance × 7 / days in the current UTC month`.
- Session: five hours starting with the first admitted billable request after
  the previous session expires. Allowance is
  `monthly allowance × 5 / (24 × days in the current UTC month)`.

Short windows do not accumulate. Integer division rounds derived allowances
down to a nanodollar. A week or session crossing into a different month retains
its renewal time, while its proportional allowance follows the current month.
Changing a plan never clears spend or restarts an active session. Monthly and
weekly counters also track usage while their limits are disabled. Sessions
begin tracking when their plan first enables session distribution.

**Plan & limits** shows current account spend, remaining and reserved USD,
renewal times and available resets. These are live allowance windows and do not
follow analytics date filters.

## API keys and migration

Keys have optional independent `dailyLimitUsd` and `totalLimitUsd` limits.
The daily cap renews at 00:00 UTC; the lifetime cap never renews. `null` is
unlimited, and zero blocks new billable requests. Both key and account caps
must admit a request. Key owners cannot change their account plan.

Migration 026 removes the old output-token caps and reactivates keys exhausted
by those caps, as requested. Revoked keys remain revoked and expiration stays
in effect. No token value is interpreted as USD. Legacy `dailyLimit` and
`totalLimit` writes return 400; use the explicit USD fields. Key responses expose
`spendTodayUsd` and `spendTotalUsd` instead of token-budget counters. Existing
usage records are retained, and historical prices are frozen using the registry
prices available during migration. Previously unpriced history has zero cost.

## Resets

Administrators grant one or more weekly, session, or combined resets, with an
optional expiry and user-visible note. The user explicitly redeems a grant.
A reset advances only the selected short windows' forgiven-spend baselines.
It never changes monthly spend, key caps, financial history, active reservations
or renewal times. Pending requests still consume the restored short allowance
when they settle. A full window does not consume a reset.

Redemptions require a client-generated `requestId`. The same request is
idempotent, and concurrent redemptions cannot double-spend one credit. Grants
belong to the account's current plan assignment version; switching to another
plan invalidates unused grants. All administrative mutations and redemptions
are audited in their balance-changing transactions.

## Admission, settlement and precision

`server/billing.ts` owns the financial admission path. A short SQLite
`BEGIN IMMEDIATE` transaction reads the current plan/key state and reserves a
conservative request cost against every applicable period. It uses indexed
period counters, independent of raw usage volume and buffered analytics.
Parallel requests across different keys cannot all spend the same remaining
account balance. The reservation ID matches the server-generated 128-bit `X-Request-Id`, and
its pricing snapshot retains the model ID. Prices are stored with the reservation, and settlement
atomically releases the hold and adds the actual usage cost exactly once.
Each request belongs to the windows in which it was admitted, even if it finishes
after a boundary. Analytics events and daily/monthly rollups carry immutable
cost snapshots; editing/deleting a model cannot reprice settled requests.

Enforcement uses integer nanodollars with BigInt arithmetic. SQLite int64
counters are read as text, preventing precision loss above JavaScript's safe
integer range. Per-token prices are parsed as decimal picodollars and costs
round up to the next nanodollar. Input, cache reads, cache creation and output
use their configured registry prices. Reported reasoning is included in the
billable output cost without changing the separate visible-token counters.
Configured per-request fees are included in input cost. Free token-counting
operations do not consume allowance. All-cached streaming inputs remain cached.

Finite budgets require configured model pricing. A request reserves its output
maximum (or the model's registered output/context bound) plus conservative
input framing. Media and provider-managed conversation state require a known
context bound. If a provider strips the requested output cap, admission uses
the registered model bound. Missing or unsafe cost bounds fail before forwarding.
A smaller explicit output maximum can allow a request to fit remaining balance.

Providers remain responsible for truthful usage and honoring their declared
bounds. If reported actual cost exceeds the reservation, the gateway records
the real cost, audits `billing.reservation.exceeded`, and denies further requests
that cannot fit; an upstream violating its bound can overrun a period. Malformed
usage settles conservatively at the reserved bound. This is not a remote hard
stop inside an upstream model's generation process.

Each gateway process has a heartbeat. Pending reservations survive a crash and
continue to reduce available balance. After a five-minute missing heartbeat,
bounded recovery batches settle uncertain reservations at their reserved bound
and audit the recovery. A live heartbeat protects long streams. Confirmed
failures release unspent holds. A client cancellation after forwarding, before
any usable usage or output arrives, settles at the reserved bound and is audited;
disconnecting cannot repeatedly burn upstream compute for free. Partial output
on cancelled streams uses reported or estimated usage. No restart grants free balance. Financial
settlement is synchronous and separate from the buffered analytics log, which
may lag by one second. SQLite's durable commit policy is preserved. Unexpected admission/storage failures
return protocol-shaped 503 responses. A failed settlement retains its hold for
process recovery instead of returning unaccounted balance.

Expired period rows are pruned after 400 days once they have no reservations;
lifetime totals and historical usage rollups remain. Settled reservation detail
is kept for 30 days. Reads and writes to active periods are point lookups, and
recovery batches are capped at 500 rows.

## API surface

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/billing` | Current account | Live limits and reset grants |
| `POST /api/billing/resets/:id/redeem` | Grant owner | Redeem with `requestId` |
| `GET/POST /api/admin/plans` | Administrator | List/create plans |
| `PATCH/DELETE /api/admin/plans/:id` | Administrator | Edit/delete an unused plan |
| `GET/PATCH /api/admin/users/:id/billing` | Administrator | Read usage/assign `planId` |
| `POST /api/admin/users/:id/resets` | Administrator | Grant `kind`, `count`, optional `expiresAt`/`note` |

Plan edits accept `name`, `monthlyUsd`, `weeklyEnabled`, `sessionEnabled`.
No account can redeem a monthly reset. Plans with members cannot be deleted.

## References and validation

The independent short windows and banked-reset behavior follow the publicly
documented patterns in [Claude usage limits](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)
and [Claude limit resets](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset).
USD key caps also follow the model in the
[official OpenRouter authentication documentation](https://github.com/OpenRouterTeam/docs/blob/main/api_reference/authentication.mdx).
The proportional monthly distribution is this gateway's explicit policy, not a
claim about those services' private accounting implementations.

Run `bun test test/billing.test.ts` for HTTP authorization, immutable prices,
streaming/cache/reasoning costs, concurrent multi-key admission, reset races,
legacy migration, leap-month boundaries, crash recovery, large integer
precision and bounded hot-path measurements. Browser validation is
`scripts/test-gateway-billing-ui.ts`, alongside the existing catalog and
analytics UI scripts. Rebuild the SPA with `bun run build:web` after changes.
