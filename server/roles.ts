import type { UserRow } from "./db";

/** A delegated role is stored separately to preserve the original users
 * table's CHECK and its many existing foreign-key relationships. */
export function effectiveRole(user: Pick<UserRow, "role"> & Partial<Pick<UserRow, "enterprise_role">>): "admin" | "project_manager" | "user" {
  return user.role === "admin" ? "admin" : user.enterprise_role === "project_manager" ? "project_manager" : "user";
}

/** SQL equivalent for server-side role filtering, sorting, and facets. */
export const EFFECTIVE_ROLE_SQL = "CASE WHEN role = 'admin' THEN 'admin' WHEN enterprise_role = 'project_manager' THEN 'project_manager' ELSE 'user' END";
