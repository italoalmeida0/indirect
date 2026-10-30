import type { Database } from "bun:sqlite";

/** Reconstruct the pre-USD schema for migration tests after a clean boot. */
export function removeUsdMigration(db: Database) {
  db.exec(`DROP TABLE IF EXISTS usage_hour_rollups; DROP TABLE IF EXISTS usage_minute_rollups; DROP TABLE IF EXISTS usage_rollup_coverage;
    DROP INDEX idx_models_upstream_billing; DROP TABLE billing_reset_uses; DROP TABLE billing_reset_grants; DROP TABLE billing_reservations;
    DROP TABLE billing_instances; DROP TABLE billing_periods; DROP TABLE user_billing; DROP TABLE billing_plans;
    ALTER TABLE api_keys DROP COLUMN daily_usd_nanos; ALTER TABLE api_keys DROP COLUMN total_usd_nanos;`);
  for (const table of ["usage_events", "usage_model_daily", "usage_model_provider_daily", "usage_model_provider_monthly"])
    for (const part of ["in", "cache", "out"]) db.exec(`ALTER TABLE ${table} DROP COLUMN cost_${part}_nanos`);
}
