You are responsible for completing and validating the enterprise hardening of the Indirect gateway. Implement the work in this brief, inspect your own changes critically, fix the problems you find, and repeat validation until the acceptance criteria are satisfied. Do not stop at a plan, a partial patch, passing unit tests, or a claim that the product is "10/10."

The quality target is a polished, secure, robust product with no known unresolved defects in the agreed scope. Treat "perfect" as a demand for careful implementation and evidence. Do not claim that finite tests prove the absence of every possible bug or simulate ten actual years of operation.

Read the applicable AGENTS.md files before starting. Write code, documentation, commits, and product strings in English. Conversation with the user may be in Portuguese. This brief authorizes implementation of the findings and missing features below, including their frontend, backend, migration, operational, and test work. Inspect the current branch first: the repository may have advanced since the reviewed commit. Preserve unrelated work and do not overwrite an existing fix with an outdated reproduction.

**Preserve the product's purpose.**

- Support one company with 500 employees and 500 AI requests per employee per day: 250,000 requests/day. Keep aggregated history for ten years and retain detailed events for a documented, configurable window.
- Keep installation and daily use simple for one or two people. A small installation must not need to configure projects, corporate identity, monitoring infrastructure, or several services to start using the gateway.
- Keep the existing Bun, SQLite, and SolidJS architecture unless measurements demonstrate a specific limitation that cannot reasonably be corrected within it. Do not introduce a large framework, mandatory Redis/Postgres, microservices, or a LiteLLM-sized feature set.
- The dashboard frontend must meet p99 <= 1,000 ms for the defined measured interactions. Gateway-added API latency must meet p99 <= 100 ms, excluding the AI provider's measured processing time. Define the workload and hardware precisely; do not replace these targets with averages.
- A financial project in the gateway is a billing/access-control entity. It must not become an alternate owner of Indirect Code daemon projects, sessions, transcripts, or files. Preserve the daemon's ownership and the gateway relay's fan-out role.
- Preserve protocol compatibility, streaming/backpressure, cancellation, failover-before-first-byte, budget accounting, secret handling, and the other AGENTS.md invariants. Use append-only SQLite migrations and minimal dependencies.

**Use the previous independent review as a reproduction list, not as a substitute for inspection.**

The review examined dev at commit 11767d3. It did not modify tracked implementation files. At that time scripts/enterprise-fixture.ts and scripts/test-gateway-enterprise.ts existed but were untracked. Inspect and preserve them, improve them where necessary, and include the useful scripts in version control. Do not delete or regenerate unrelated user work.

The following findings were verified with real gateway processes, HTTP calls, a Chromium render of the actual billing component, and timed workload probes. Reproduce them on the current implementation before fixing them. Turn each confirmed failure into a meaningful regression test that fails before the fix and passes afterward. Test observable behavior through the real boundary; do not merely copy the implementation into an expected-value helper.

1. **A client correlation ID collides with the financial reservation primary key.**

   server/request-context.ts accepts a valid client X-Request-Id. server/proxy/index.ts passes it into reserveBudget, and server/billing.ts used it directly as billing_reservations.id, around line 185 at the reviewed commit.

   Observed sequence using X-Request-Id: review-shared-request-2026: first call 200; second call with the same header 503; another account using that header 503; a call with a newly generated ID 200. Only the two successful requests reached the upstream.

   Separate externally supplied correlation from internally unique operation/reservation identity. Define idempotency explicitly if needed; do not accidentally turn correlation into global idempotency. Preserve useful correlation in logs and responses without permitting financial collisions or cross-account interference. Cover sequential and simultaneous repeated IDs, different accounts/keys, retries, streaming, cancellation, and restart recovery. Confirm correct upstream call counts, settlement, and released reservations.

2. **Financial visibility is enforced only on some responses.**

   With FINANCIAL_DEFAULT_BUDGET=hidden and FINANCIAL_DEFAULT_SHOW_PRICES=false, an ordinary user's GET /api/billing and GET /api/keys omitted amounts. Other real responses still exposed them:

   - POST /api/keys and PATCH /api/keys/:id returned dailyLimitUsd, totalLimitUsd, spendTodayUsd, and spendTotalUsd. Renaming a key alone exposed its actual spend.
   - /api/usage/summary, /daily, /events, /overview, /analytics, /breakdown, and /by-model returned monetary cost fields.
   - /v1/models returned model pricing despite the configured price policy.
   - POST /api/billing/resets/:id/redeem returned an unprojected billing object, including a US$100 plan and window limits, spend, reservations, and remaining balance. The relevant response was around server/routes/billing.ts:58.

   Inventory every affected response surface, including mutation responses, model details, catalogs, exports, filtering/sorting metadata, reset redemption, and cached responses. Centralize explicit policy-aware response projection with a stable contract. Do not rely on hiding components or on a fragile field-name regex as the only enforcement mechanism.

   Preserve the separate meanings of showModelPrices and budgetPresentation. Apply installation defaults and per-user overrides consistently. Administrators retain the visibility required by the existing contract; other roles obey their effective permissions. Percent mode returns the allowed percentages and renewal data without USD amounts; hidden mode does not disclose those amounts through another endpoint. Define what an unlimited plan and an unconfigured limit mean without inventing a monetary value.

   Test ordinary users, delegated roles, administrators, overrides, inherited defaults, policy changes, all affected endpoints, and cross-user cache isolation. Assert actual payloads and browser-visible behavior. Test that an already open session refreshes financial presentation after the policy changes and that stale client state does not keep displaying restricted values.

3. **The percentage frontend consumes the wrong API contract.**

   The real API returned a monthly window with usedPercent:40 and limitConfigured:true. Rendering the actual PlanLimits component in Chromium showed 100%, "— spent of —", and "Your account has no spending ceiling." web/src/billing.tsx calculated from omitted USD fields and treated an omitted monthly amount as an unlimited allowance.

   Define shared or otherwise checked discriminated DTOs for usd, percent, and hidden presentation. Update the complete UI flow, not just a calculation helper: plan summary, meters, key limits, usage screens, resets, loading, empty/error states, accessibility text, and administrator configuration. A 40% payload must visibly render 40%; finite plans must never be described as unlimited because amounts are private. Cover zero, near-limit, exhausted, reserved, unlimited, and hidden cases. Use the existing UI kit, semantic theme tokens, and responsive patterns. Run real browser tests against real endpoint responses.

4. **Retention still blocks the event loop with an unbounded transaction.**

   pruneUsageEvents in server/usage-rollup.ts, around lines 118-142, executed every limited DELETE in one synchronous loop and one IMMEDIATE transaction. Invoking that production function on 200,000 expired events took 2,315.9 ms and blocked a concurrent health request for 2,306.9 ms. The normal health p99 in that probe remained low: this was a measured maximum stall, not a 2.3-second p99.

   Bound the work and lock time of each scheduled invocation and allow request processing between units of maintenance. Preserve the raw coverage watermark and rollup correctness through partial progress, concurrent writes, restart, and interruption. Do not advance coverage past data that is not safely accounted for. Do not replace the problem with an unbounded startup job, background queue, or burst of parallel writers.

   Inspect the other maintenance paths for the same problem: rollup pruning/backfill, settled reservation cleanup, audit/session cleanup, checkpoints, backup creation/verification, and any compaction. Measure the relevant paths instead of declaring them harmless because they are named async or use LIMIT. Test a retention backlog under concurrent proxy, dashboard, and health traffic, and verify progress and accounting after restart.

5. **Audit coverage and mutation atomicity are incomplete.**

   PATCH /api/me/sessions/:jti successfully renamed a session without adding an audit event. Injecting a failure specifically into the financial_policy.user_updated audit insertion made the policy update return 500 while the new policy remained applied and no audit row existed. The setter and audit were separate operations around server/routes/billing.ts:105.

   Inventory administrator and user mutations. Ensure required audit records include actor, action, target, outcome/context, time, and correlation without secret material. For local sensitive state changes, commit state and its audit together or roll both back. Handle inherently external effects explicitly; do not promise a SQLite transaction can roll back a remote operation. Audit must not become a long transaction around network calls.

   Add real route tests with fault injection for the known failures and other newly introduced sensitive mutations. Check response, persisted state, and audit rows, including retries. Cover profile/session changes, policies, memberships, roles, plans/resets, key lifecycle, identity/security settings, and backup/restore operations as applicable.

6. **Model policy evaluation and discovery are inconsistent.**

   With an economy-only default policy, /v1/models returned only the economy model, while /api/me/models still returned economy and premium. The dashboard catalog only filtered enabled models at server/routes/me.ts:238-244. The proxy resolved policyFor({role:owner.role, projectId:null}) around server/proxy/index.ts:908, so project policy was not connected to a request's real project association.

   Use one effective decision across catalog discovery, detail reads, dashboard selections, every supported proxy protocol, and routing/fallback. Define and test public model IDs versus provider aliases so valid mappings work without bypassing access restrictions. Reject or handle stale selections safely. Wire financial project association into policy resolution, and invalidate relevant snapshots/caches after policy and membership changes. Cover streaming, non-streaming, renamed models, IDs containing slashes, disabled models, fallback, and unauthorized direct requests.

**Complete the missing enterprise features with optional, simple defaults.**

- Implement financial projects and cost centers with responsible users, memberships, lifecycle/status, optional shared budgets, and API-key association. Preserve immutable usage attribution at the time of the request: renaming, moving a key, changing membership, or deleting a project must not retroactively reclassify historical consumption. Define the treatment of in-flight reservations when assignments change. Enforce shared and account/key budgets atomically and keep historical ledger records. Provide reports and usable administrative screens.
- Add a bounded project_manager role with explicit server-side capabilities and project scope. Managers must not gain administrator capabilities through direct URLs, identifiers, exports, mutation endpoints, or cached responses. Define how project scope interacts with personal consumption and financial visibility. Avoid a generic permission framework when fixed, tested roles are enough.
- Add configurable corporate OIDC and optional policies requiring SSO for managed accounts and MFA for administrators. Keep local authentication simple when these options are disabled. Use a maintained minimal implementation and primary documentation; correctly validate state, nonce, issuer, audience, PKCE where applicable, signatures, allowed algorithms, redirect destinations, and key rotation. Define safe account linking, role assignment, revocation, session renewal, recovery, and administrator lockout prevention. Never silently link an untrusted identity merely because it presents a matching email. Test with a local controlled identity provider; distinguish that from a real corporate-provider integration test.
- Add bounded bulk user import with a documented format, validation, duplicate/idempotency behavior, useful row errors, authorization, and audit. Prevent input size/resource abuse and partial-state surprises. Handle invitations or notifications without sending real messages unless the user explicitly authorizes sending them.
- Add protected operational metrics for request/error counts, latency distributions, active requests, admission queue/limits, worker health, relevant SQLite contention/checkpoint behavior, retention progress, and backup outcomes. Keep labels bounded: no request IDs, tokens, raw URLs, or per-user/project labels that create unbounded series. Prefer a small endpoint and clear health/readiness semantics over a new monitoring service dependency.
- Provide administration through the existing UI for financial defaults/overrides, model policies, projects/members, corporate-auth policies, import, and backup controls. A feature available only through raw SQL or an undocumented API is not complete. Test authorization, keyboard use, narrow viewports, empty/error states, reload persistence, and policy changes in an open session.
- Complete the backup/restore operational flow. Exercise a consistent live backup while writes continue, verification and tamper/truncation rejection, restore into a separate empty test installation, and the application's ability to start and serve correct historical/accounting data afterward. Document retention, storage protection, restore steps, and required secrets without exposing them. Never restore over the user's live data to prove the test.

**Meet the agreed performance target with honest measurements.**

Previous measurements used Windows, Bun 1.4.2 x64, a Snapdragon X 12-core machine, and about 16 GB RAM. Treat them as a reproducible local baseline, not a qualification of a native Linux production host. Production durability settings were not weakened. The fixture represented 913,250,000 requests across 3,653 days for 500 users, but physically retained only 500,000 detailed events (two days), about one year of audit records, and two days of settled reservations.

| Workload | Agreed p99 | Observed p99 | Failed requests |
| --- | --- | --- | --- |
| Gateway-added API latency at 32 requests/second, 1,200 samples | <=100 ms | 313.9 ms | 0/1,200 |
| Dashboard APIs at up to 12 requests/second, 1,200 samples | <=1,000 ms | 4,141.2 ms | 8/1,200 (503) |
| Burst of 50 distinct-user analytics requests | <=1,000 ms | 1,086.4 ms | 0/50 |

The previous script independently checked the ten-year aggregate total and a partial-range query against retained raw events. Preserve and expand correctness checks while optimizing. Investigate the slow requests and 503 responses; do not mask them by excluding them from the distribution or treating expected overload responses as successful service at the agreed workload.

The previous baseline command was:

```powershell
bun scripts/test-gateway-enterprise.ts --reuse --dir=tmp/enterprise-c --samples=1200 --rate=32 --report=tmp/enterprise-review.json
```

Use a fresh seeded directory for reproducibility when the old fixture is unavailable or incompatible. The script already has --full and configurable raw/reservation retention; inspect its implementation before relying on it. Native Bun >=1.4.2 was the intended runtime. On Windows the previous run used BUN_CONFIG_MAX_HTTP_REQUESTS=2048 to avoid a load-generator connection ceiling; disclose equivalent generator settings.

Required performance work:

- Preserve an open-loop arrival schedule or equivalent methodology that counts scheduler delay, queuing, errors, and timeouts. Measure the local upstream's processing time per request and subtract it correctly for gateway-added latency. Do not subtract an assumed constant from every request or confuse upstream time with gateway time-to-first-byte.
- Cover both protocol streaming and non-streaming, realistic provider waits, independent users, many keys owned by one user, mixed dashboard/proxy traffic, cold and warm queries, large date ranges, and simultaneous maintenance/backup activity. Verify admission fairness, bounded memory, disconnect cleanup, and recovery after overload.
- Measure complete frontend navigation and refresh interactions in a real browser with the production SPA and real gateway, including fetching and rendering the meaningful content. A fast spinner or skeleton does not satisfy the dashboard target. Define the interaction's start and completion conditions, report sample counts, browser/network conditions, errors, p50/p95/p99/max, and distinguish frontend timing from API timing.
- Run capacity qualification with the intended physical retention, not just synthetic aggregate counts. At 250,000/day the reviewed default of 400 detailed days permits about 100 million raw events. The existing full profile of 90 days represents 22.5 million raw events, still below that default; disclose this difference. Use bounded fixture generation and realistic data/index cardinalities. Do not silently shrink retention, fixtures, audit history, durability, or workload to obtain a pass. If retention defaults change as a deliberate product decision, justify and document the storage/forensic tradeoff and test the actual delivered configuration.
- Exercise ten-year aggregate/history ranges, partial boundaries, leap dates, renewal/reset boundaries, migrations of an existing populated database, interrupted maintenance, and restart recovery. Ten-year accounting must remain exact after deleting detailed data. Do not equate a test fixture's represented count with physically storing that many detailed rows.
- Reproduce qualification on native target hardware/OS where available, preferably Linux for a Linux deployment. Record CPU, memory, OS/architecture, runtime version, storage, fixture cardinalities and size, durability settings, load shape, command, source commit, and results. Ensure the generator is not the limiting factor and avoid unrelated heavy jobs during measurements.
- Run a sustained mixed workload long enough to cross scheduled maintenance and observe memory/WAL growth, contention, reservations, file handles, queue depth, and restart recovery. State the actual duration. Do not infer ten years without failures from a short soak.
- Commit deterministic correctness and capacity scripts. Put routine regressions in normal CI and provide an explicit CI qualification job or documented native performance gate for the resource-heavy profiles. Keep thresholds enforced; an unrun or failed qualification remains unpassed. Do not claim stable performance from an undersized sample or shared-runner noise.

**Finish validation rather than weakening the checks.**

The previous complete Bun run had 901 passes and 4 failures across 905 tests/69 files. Lint passed with six unused-variable/import warnings; typecheck and a fresh SPA compilation passed. The failures were:

- test/gateway-admission.test.ts: the assertion that an aborted response body cannot throw AbortError stopped the test before its final slot-leak checks. Test valid abort behavior and still prove that every accepted slot/reservation is released; do not remove the important final assertions.
- test/indirect-gen-ui-lint.test.ts: a clean widget exceeded the five-second timeout. Diagnose actual startup/browser/process behavior; distinguish provisioning from steady-state execution. A justified, measured timeout is acceptable, but not an arbitrary increase that conceals a hang or performance regression.
- test/sqlite-retry.test.ts: two batchDelete cases failed during fixture cleanup with Windows EBUSY. Isolated reruns also exposed cleanup/busy failures. Close databases, readers, workers, and child processes correctly and use isolated paths. Do not skip Windows coverage or delete active fixture directories to hide leaked handles.

Use the exact names/paths from the current tree if they have changed. Remove the existing lint warnings as part of touched test/code cleanup. Keep tests independent and repeatable. Do not add blanket catches, sleeps, serial execution, disabled assertions, retries that hide deterministic defects, or skipped tests just to report green.

Validate at the right boundary:

- New or changed routes: real gateway black-box tests, including unauthorized/forbidden, validation, conflict, concurrent updates, failure/rollback, and success responses.
- Policy and budget behavior: independent expected outcomes, cross-user/project isolation, concurrent admission, exactly-once settlement, cancellation, retries, failover, resets, and recovery.
- Financial/model/admin UX: production frontend browser tests against real gateway state; inspect actual network payloads as well as visible text and accessibility attributes.
- Database changes: append-only migration from the reviewed schema and supported existing states, retained history, interruption/retry behavior, indexes/query plans, bounded writes, and upgrade compatibility. Never rebuild a populated production database as a migration shortcut.
- Security-sensitive inputs and outputs: malformed/oversized payloads, invalid credentials/roles, cross-account identifiers, redaction of provider/gateway keys and identity secrets, and protocol-correct error envelopes. Preserve CSRF/origin/session protections and streaming behavior.

Run the repository's required gates from the correct roots:

```text
bun run lint
bun run typecheck
bun test
bun run build:web
```

Run the relevant external Playwright scripts and the new enterprise UI/performance scripts. If daemon changes are required, follow AGENTS.md: CGO_ENABLED=1 with the pinned Zig toolchain, Go tests from indirect-code-daemon, local daemon build, all-platform artifact build/verification, and affected lifecycle/browser integration checks. Do not disable cgo or alter the prebuilt QuickJS archive workflow. Avoid touching daemon code unless necessary for the requested behavior.

After a substantive fix, run its focused regression checks. Once the changes are integrated, run the complete relevant gates and inspect every failure. A change after a successful run requires the affected checks again. Report exactly what ran and on which source revision. Existing automated tests are evidence only for what they actually assert.

**Work in reviewable batches and inspect the final product.**

Start with the reproduced correctness/privacy defects, then complete their UI contracts, bounded maintenance/audit, project/role/model integration, identity/operations, and performance qualification. Adjust the order for real dependencies. Keep a requirement-to-test/evidence checklist so no small endpoint or UI path disappears between batches.

If you delegate, assign non-overlapping work and independently review the resulting diffs and evidence before integration. Delegation is not validation. Look for regressions outside the changed happy path and remove unnecessary abstractions/dependencies. Review effective permissions, migrations, transaction boundaries, error paths, cancellation, cache invalidation, and startup defaults across the final integrated code.

Make coherent commits for completed, validated batches and push according to the user's existing branch/workflow authorization. Stage only the intended files. Do not force-push, rewrite unrelated history, publish a release, or deploy to production as part of this brief. Do not commit databases, secrets, benchmark data files, generated toolchain archives, browser downloads, or unrelated local artifacts. Leave the required local builds available.

Update docs/gateway-enterprise.md and relevant operating documentation so "delivered" means the final implementation and its required evidence exist. Correct overbroad claims. Document defaults, roles/permissions, financial/project semantics, backup/restore, retention/storage sizing, identity setup, and reproducible test/qualification commands. Keep documentation proportional to the product.

If a gate truly cannot run because target hardware, a credential, a service, or another external prerequisite is unavailable, finish the independent authorized work and report the exact missing prerequisite, command, and unverified requirement. Never label that gate passed or the whole project fully qualified. Do not use an external prerequisite as a reason to leave unrelated reproducible defects unfixed.

Before declaring completion, verify every item below against the final source revision:

- All six reproduced findings have passing regression coverage and correct user-visible outcomes.
- Financial restrictions hold across the entire response inventory, and usd/percent/hidden UI states are correct and usable.
- Financial projects, immutable attribution, shared budgets, scoped managers, model policies, optional corporate auth/MFA, import, operational metrics, and administrative controls work end to end.
- Required mutations are auditable, sensitive local changes are atomic with their audit, and secret values do not leak.
- Retention, backup/verification, checkpoints, and other maintenance remain bounded under real serving load; restored data has been checked through a running application.
- Full relevant tests, typecheck, lint, build, affected browser checks, and migration/recovery checks pass without concealed failures.
- The agreed p99 targets pass in the documented qualification profiles with errors/timeouts counted and the actual delivered retention cardinality tested. Frontend and API results are reported separately.
- The final diff has been reviewed for unnecessary complexity, the small-installation path remains simple, documentation matches behavior, and commits/pushes are traceable.

Finish with a concise Portuguese report listing the delivered behavior, fixed reproductions, test commands and results, qualification hardware/cardinalities, p50/p95/p99/error measurements, commit IDs/push status, and any exact unresolved or unverified item. Do not replace evidence with "enterprise-grade," "perfect," "zero bugs," or "10/10." The independent reviewer must be able to reproduce your result from the repository and the report.
