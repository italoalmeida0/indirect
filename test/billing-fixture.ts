import type { Database } from "bun:sqlite";

/** Reconstruct the pre-USD schema for migration tests after a clean boot. */
export function removeUsdMigration(db: Database) {
  removeEnterpriseMigrations(db);
  db.exec(`DROP TABLE IF EXISTS usage_hour_rollups; DROP TABLE IF EXISTS usage_minute_rollups; DROP TABLE IF EXISTS usage_rollup_coverage;
    DROP INDEX idx_models_upstream_billing; DROP TABLE billing_reset_uses; DROP TABLE billing_reset_grants; DROP TABLE billing_reservations;
    DROP TABLE billing_instances; DROP TABLE billing_periods; DROP TABLE user_billing; DROP TABLE billing_plans;
    -- Later migrations that must also be re-applied: the financial-policy and
    -- model-policy tables, the correlation indices and the api_keys columns the
    -- USD migration adds (the columns themselves are dropped defensively below).
    DROP TABLE IF EXISTS user_financial_policy; DROP TABLE IF EXISTS installation_policy;
    DROP TABLE IF EXISTS model_policies; DROP TABLE IF EXISTS model_policy_models;
    DROP INDEX IF EXISTS idx_audit_request; DROP INDEX IF EXISTS idx_usage_request;`);
  dropColumns(db, "usage_events", ["cost_in_nanos", "cost_cache_nanos", "cost_out_nanos", "request_id"]);
  for (const table of ["usage_model_daily", "usage_model_provider_daily", "usage_model_provider_monthly"]) {
    dropColumns(db, table, ["cost_in_nanos", "cost_cache_nanos", "cost_out_nanos"]);
  }
  dropColumns(db, "api_keys", ["daily_usd_nanos", "total_usd_nanos"]);
  dropColumns(db, "audit_log", ["request_id"]);
}

/** Reconstruct the populated schema just before enterprise projects/auth. */
export function removeEnterpriseMigrations(db: Database) {
  db.exec(`DROP TABLE IF EXISTS mfa_enrollments; DROP TABLE IF EXISTS usage_outbox; DROP TABLE IF EXISTS usage_outbox_pending;
    DROP INDEX IF EXISTS idx_billing_pending_created;
    DROP TABLE IF EXISTS auth_mfa_uses; DROP TABLE IF EXISTS auth_challenges;
    DROP TABLE IF EXISTS user_import_batches; DROP TABLE IF EXISTS auth_recovery_codes;
    DROP TABLE IF EXISTS oidc_flows; DROP TABLE IF EXISTS corporate_account_policy;
    DROP TABLE IF EXISTS corporate_identities; DROP TABLE IF EXISTS usage_financial_daily;
    DROP TABLE IF EXISTS usage_financial_monthly; DROP TABLE IF EXISTS project_members;
    DROP INDEX IF EXISTS idx_api_keys_project;
    DROP TRIGGER IF EXISTS model_policy_model_deleted; DROP TRIGGER IF EXISTS model_policy_model_renamed;`);
  dropColumns(db, "sessions", ["auth_method", "mfa_verified", "auth_policy_version", "recovery_verified_at"]);
  dropColumns(db, "api_keys", ["project_id"]);
  dropColumns(db, "usage_events", ["project_id", "cost_center_id"]);
  dropColumns(db, "billing_reservations", ["project_id", "cost_center_id", "request_proto", "request_model", "request_stream", "unit_nanos", "uncertain_nanos"]);
  dropColumns(db, "model_policy_models", ["deleted"]);
  db.exec("DROP TABLE IF EXISTS financial_projects");
  dropColumns(db, "users", ["enterprise_role"]);
}

/**
 * Drop the named columns IF they are present.
 *
 * This helper reconstructs a legacy schema for several starting versions, so a
 * column added by a later migration may legitimately not exist yet (or may
 * already have been removed). Failing on the absent case made the fixture
 * brittle every time a migration added a column.
 */
function dropColumns(db: Database, table: string, columns: string[]) {
  const present = new Set(
    (db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const column of columns) {
    if (present.has(column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}
