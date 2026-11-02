import type { AuthContext } from "./auth";
import type { UserRow } from "./db";
import type { FinancialPolicy } from "./financial-policy";
import { ApiError } from "./http";
import { requireLiveRead } from "./live-auth";
import { readUsage, type UsageReadRequest, type UsageReadResult } from "./usage-reader";

/** Recheck identity, scope and policy after worker awaits. A policy change can
 * alter predicates or omit cost aggregation, so retry once with the current
 * query rather than returning a result with the wrong visibility semantics. */
export async function readAuthorizedUsage<R extends UsageReadRequest>(
  ctx: AuthContext,
  req: Request,
  requestFor: (user: UserRow, policy: FinancialPolicy) => R,
  deliver: (result: UsageReadResult<R>, policy: FinancialPolicy) => Response,
) {
  let current = requireLiveRead(ctx);
  let query = requestFor(current.user, current.policy);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readUsage(query, req.signal);
    current = requireLiveRead(ctx);
    const next = requestFor(current.user, current.policy);
    // Serialize synchronously after the last check. Returning raw data to an
    // awaiting route would introduce another gap before its projection runs.
    if (JSON.stringify(query) === JSON.stringify(next)) return deliver(result, current.policy);
    query = next;
  }
  throw new ApiError(409, "financial visibility changed during the report; retry the request");
}
