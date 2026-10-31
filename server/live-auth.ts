import type { AuthContext } from "./auth";
import { assertSessionPolicy } from "./auth-policy";
import { stmts, type UserRow } from "./db";
import { ApiError } from "./http";

/** Revalidate after an awaited request body and within the mutation's writer
 * transaction. Revoking a session or banning an account must take effect
 * before a previously accepted but incomplete request can mutate state. */
export function requireLiveActor(ctx: AuthContext): UserRow {
  const session = stmts.sessionByJti.get(ctx.session.jti);
  const user = stmts.userById.get(ctx.user.id);
  const now = Date.now();
  if (!session || session.user_id !== ctx.user.id || session.revoked || session.expires_at <= now || session.abs_expires_at <= now) throw new ApiError(401, "session revoked");
  if (!user || user.status !== "active") throw new ApiError(403, "account is disabled");
  if (user.role !== ctx.user.role || user.enterprise_role !== ctx.user.enterprise_role || user.password_hash !== ctx.user.password_hash || user.totp_secret !== ctx.user.totp_secret || user.google_id !== ctx.user.google_id) throw new ApiError(401, "account credentials or permissions changed; sign in again");
  assertSessionPolicy(user, session);
  return user;
}
