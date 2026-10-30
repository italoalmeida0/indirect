import { Database } from "bun:sqlite";
import path from "path";
import { isMainThread, workerData } from "node:worker_threads";

import { DATA_DIR, LIMITS } from "./config";
import { normalizePricing, pricingColumns } from "./pricing";
import { currentRequestId } from "./request-context";
import { isRetryableSqliteError } from "./sqlite-retry";

/**
 * SQLite via bun:sqlite (built into the runtime, WAL mode). Migrations are
 * applied in order and tracked with PRAGMA user_version. All hot-path
 * statements are prepared once at module scope.
 */

const usageReader = !isMainThread && workerData?.usageReader === true;
export const db = new Database(path.join(DATA_DIR, "gateway.db"), usageReader ? { readonly: true } : { create: true });

if (!usageReader) db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`PRAGMA busy_timeout = ${LIMITS.sqliteBusyTimeoutMs}`);

/** SQLite exposes extended busy/locked codes in some Bun versions. */
export function isSqliteBusy(error: unknown): boolean {
  return isRetryableSqliteError(error);
}

type Migration = { name: string; up: string | (() => void) };

const MIGRATIONS: Migration[] = [
  {
    name: "001_init",
    up: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
        password_hash TEXT,
        google_id     TEXT UNIQUE,
        totp_secret   TEXT,
        totp_pending  TEXT,
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE sessions (
        jti          TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        refresh_hash TEXT NOT NULL UNIQUE,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        abs_expires_at INTEGER NOT NULL,
        revoked      INTEGER NOT NULL DEFAULT 0,
        ip           TEXT,
        ua           TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE providers (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        openai_base_url    TEXT,             -- e.g. https://provider/openai/v1
        anthropic_base_url TEXT,             -- e.g. https://provider/anthropic/v1
        api_key_enc        TEXT NOT NULL,
        enabled            INTEGER NOT NULL DEFAULT 1,
        priority           INTEGER NOT NULL DEFAULT 100,
        created_at         INTEGER NOT NULL
      );

      CREATE TABLE api_keys (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL DEFAULT '',
        prefix      TEXT NOT NULL,
        hash        TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER,
        daily_limit INTEGER,
        total_limit INTEGER,
        rpm         INTEGER,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','exhausted')),
        last_used_at INTEGER,
        last_used_ip TEXT
      );
      CREATE INDEX idx_api_keys_user ON api_keys(user_id);

      CREATE TABLE usage_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id     TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        proto      TEXT NOT NULL CHECK (proto IN ('openai','anthropic')),
        model      TEXT NOT NULL DEFAULT '',
        in_tok     INTEGER NOT NULL DEFAULT 0,
        out_tok    INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        status     INTEGER NOT NULL DEFAULT 200,
        stream     INTEGER NOT NULL DEFAULT 0,
        estimated  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_usage_key_ts ON usage_events(key_id, ts);
      CREATE INDEX idx_usage_user_ts ON usage_events(user_id, ts);
      CREATE INDEX idx_usage_ts ON usage_events(ts);

      CREATE TABLE usage_daily (
        key_id  TEXT NOT NULL,
        user_id TEXT NOT NULL,
        date    TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
        in_tok  INTEGER NOT NULL DEFAULT 0,
        out_tok INTEGER NOT NULL DEFAULT 0,
        reqs    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date)
      );
      CREATE INDEX idx_usage_daily_user ON usage_daily(user_id, date);

      CREATE TABLE password_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('invite','reset')),
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      );

      CREATE TABLE audit_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        actor_id TEXT,
        action   TEXT NOT NULL,
        target   TEXT,
        meta     TEXT,
        ip       TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);
    `,
  },
  {
    name: "002_provider_auth_styles",
    up: `
      -- How the upstream expects the real key: 'bearer' (Authorization: Bearer k)
      -- or 'x-api-key' (x-api-key: k). Defaults preserve the old hardcoded behavior.
      ALTER TABLE providers ADD COLUMN openai_auth_style     TEXT NOT NULL DEFAULT 'bearer';
      ALTER TABLE providers ADD COLUMN anthropic_auth_style  TEXT NOT NULL DEFAULT 'x-api-key';
    `,
  },
  {
    name: "003_session_labels",
    up: `
      -- Optional user-facing device name ("my laptop"); survives token rotation.
      ALTER TABLE sessions ADD COLUMN label TEXT;
    `,
  },
  {
    name: "004_key_token_enc",
    up: `
      -- AES-encrypted copy of the plaintext token so owners/admins can reveal
      -- it later (hash remains the proxy lookup key; every reveal is audited).
      ALTER TABLE api_keys ADD COLUMN token_enc TEXT;
    `,
  },
  {
    name: "005_cache_tok",
    up: `
      -- Providers bill cached input tokens at their own rate, so they get a
      -- dedicated column: in_tok stays the cache-free input share, cache_tok
      -- counts the cached share (Anthropic: read + creation). Rows that
      -- predate this migration simply keep cache_tok = 0 (they never had the
      -- cached share in in_tok either).
      ALTER TABLE usage_events ADD COLUMN cache_tok INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_daily  ADD COLUMN cache_tok INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: "006_usage_model_daily",
    up: `
      -- Per-model daily rollup, fed by the same flush that writes usage_daily.
      -- The per-model dashboard queries (admin stats + /api/usage/by-model)
      -- used to GROUP BY over raw usage_events, which grows linearly (~3330ms
      -- at 3.65M events / 10y in the growth sim). The
      -- rollup answers the same questions in ~30ms/~4ms at that scale.
      -- The one-time backfill below costs ~4s per GB of existing history.
      CREATE TABLE usage_model_daily (
        key_id    TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        date      TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
        proto     TEXT NOT NULL,
        model     TEXT NOT NULL,
        in_tok    INTEGER NOT NULL DEFAULT 0,
        cache_tok INTEGER NOT NULL DEFAULT 0,
        out_tok   INTEGER NOT NULL DEFAULT 0,
        reqs      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date, proto, model)
      ) WITHOUT ROWID;
      CREATE INDEX idx_usage_model_daily_user ON usage_model_daily(user_id, date);
      INSERT INTO usage_model_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs)
        SELECT key_id, user_id, date(ts/1000, 'unixepoch'), proto, model,
               SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*)
        FROM usage_events
       GROUP BY key_id, date(ts/1000, 'unixepoch'), proto, model;
    `,
  },
  {
    name: "007_models",
    // Model registry + routing mode. Deleting a provider orphans its models
    // (provider_id -> NULL) instead of deleting them: usage history and the
    // admin registry survive, and the admin can re-link them later.
    up: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE models (
        id                TEXT PRIMARY KEY,         -- public id clients send
        provider_id       TEXT REFERENCES providers(id) ON DELETE SET NULL,
        upstream_model    TEXT NOT NULL,            -- id the provider receives
        proto             TEXT NOT NULL DEFAULT 'openai' CHECK (proto IN ('openai','anthropic')),
        name              TEXT NOT NULL DEFAULT '',
        description       TEXT NOT NULL DEFAULT '',
        hugging_face_id   TEXT NOT NULL DEFAULT '',
        quantization      TEXT NOT NULL DEFAULT '',
        openrouter_slug   TEXT NOT NULL DEFAULT '',
        always_on         INTEGER NOT NULL DEFAULT 1,
        enabled           INTEGER NOT NULL DEFAULT 1,
        context_length    INTEGER,
        max_output_length INTEGER,
        created           INTEGER,                  -- unix seconds (upstream)
        input_modalities  TEXT NOT NULL DEFAULT '["text"]',
        output_modalities TEXT NOT NULL DEFAULT '["text"]',
        sampling_params   TEXT NOT NULL DEFAULT '[]',
        features          TEXT NOT NULL DEFAULT '[]',
        reasoning_efforts TEXT,                     -- JSON array, NULL = unknown
        pricing           TEXT,                     -- JSON object, NULL = unknown
        datacenters       TEXT,                     -- JSON array, NULL = unknown
        source            TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_models_provider ON models(provider_id);
    `,
  },
  {
    name: "008_model_proto_both",
    // A registry entry may serve BOTH protocol surfaces (proto = 'both').
    // SQLite can't alter a CHECK constraint, so the table is rebuilt.
    up: `
      CREATE TABLE models_new (
        id                TEXT PRIMARY KEY,
        provider_id       TEXT REFERENCES providers(id) ON DELETE SET NULL,
        upstream_model    TEXT NOT NULL,
        proto             TEXT NOT NULL DEFAULT 'openai' CHECK (proto IN ('openai','anthropic','both')),
        name              TEXT NOT NULL DEFAULT '',
        description       TEXT NOT NULL DEFAULT '',
        hugging_face_id   TEXT NOT NULL DEFAULT '',
        quantization      TEXT NOT NULL DEFAULT '',
        openrouter_slug   TEXT NOT NULL DEFAULT '',
        always_on         INTEGER NOT NULL DEFAULT 1,
        enabled           INTEGER NOT NULL DEFAULT 1,
        context_length    INTEGER,
        max_output_length INTEGER,
        created           INTEGER,
        input_modalities  TEXT NOT NULL DEFAULT '["text"]',
        output_modalities TEXT NOT NULL DEFAULT '["text"]',
        sampling_params   TEXT NOT NULL DEFAULT '[]',
        features          TEXT NOT NULL DEFAULT '[]',
        reasoning_efforts TEXT,
        pricing           TEXT,
        datacenters       TEXT,
        source            TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      INSERT INTO models_new SELECT * FROM models;
      DROP TABLE models;
      ALTER TABLE models_new RENAME TO models;
      CREATE INDEX idx_models_provider ON models(provider_id);
    `,
  },
  {
    name: "009_failover",
    // Upstream failover: N keys per provider (ordered by priority) and N
    // routing targets per model ((provider, upstream_model) pairs, ordered).
    // The proxy falls through to the next key/target when the preferred one
    // fails (billing/auth/rate_limit/transient) — see server/failover.ts.
    // (Auto-skip of failing keys was removed by 020_no_auto_key_skip:
    // failures only reorder future requests via the sticky winner.)
    //
    // Mirror rule: providers.api_key_enc and models.provider_id /
    // models.upstream_model stay as a denormalized mirror of the top-1
    // (lowest-priority) entry, recomputed after every mutation, so pre-009
    // readers (sync, admin listing) keep working. The last key of a provider
    // can never be deleted (api_key_enc is NOT NULL).
    up: `
      CREATE TABLE provider_keys (
        id               TEXT PRIMARY KEY,
        provider_id      TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        label            TEXT NOT NULL DEFAULT '',
        api_key_enc      TEXT NOT NULL,
        priority         INTEGER NOT NULL DEFAULT 100,
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','exhausted')),
        fail_count       INTEGER NOT NULL DEFAULT 0,
        cooldown_until   INTEGER,
        exhausted_reason TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_provider_keys_provider ON provider_keys(provider_id, priority);

      CREATE TABLE model_targets (
        model_id       TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE ON UPDATE CASCADE,
        provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_model TEXT NOT NULL,
        priority       INTEGER NOT NULL DEFAULT 100,
        enabled        INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (model_id, provider_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_model_targets_provider ON model_targets(provider_id);

      -- Backfill: legacy single key / single provider link become the
      -- priority-0 entries of the new tables.
      INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at)
        SELECT 'pk_' || lower(hex(randomblob(8))), id, 'primary', api_key_enc, 0, 'active', created_at, created_at
        FROM providers;
      INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at)
        SELECT id, provider_id, upstream_model, 0, 1, created_at FROM models WHERE provider_id IS NOT NULL;
    `,
  },
  {
    name: "010_session_families",
    // Refresh-token rotation chains get a family id (the jti of the chain's
    // first session). Presenting a refresh token that was ALREADY rotated
    // away (its session row revoked) is theft evidence: the whole family is
    // revoked, killing the thief's rotated-forward session too (OWASP
    // refresh-token reuse detection).
    up: `
      ALTER TABLE sessions ADD COLUMN family TEXT;
      UPDATE sessions SET family = jti WHERE family IS NULL;
    `,
  },
  {
    name: "011_usage_provider_dims",
    // Usage gains the UPSTREAM dimension: which provider actually served a
    // request, which provider key, and which upstream model id. Pre-011 rows
    // don't know this — the rollup backfill keeps them visible with empty
    // provider fields (the UI shows "—") and only NEW events carry real
    // provider/key/upstream info (written by the proxy from the failover
    // candidate that answered).
    up: `
      ALTER TABLE usage_events ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE usage_events ADD COLUMN provider_key_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE usage_events ADD COLUMN upstream_model TEXT NOT NULL DEFAULT '';

      CREATE TABLE usage_model_provider_daily (
        key_id          TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        date            TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
        proto           TEXT NOT NULL CHECK (proto IN ('openai','anthropic')),
        provider_id     TEXT NOT NULL DEFAULT '',
        provider_key_id TEXT NOT NULL DEFAULT '',
        model           TEXT NOT NULL,
        upstream_model  TEXT NOT NULL DEFAULT '',
        in_tok          INTEGER NOT NULL DEFAULT 0,
        cache_tok       INTEGER NOT NULL DEFAULT 0,
        out_tok         INTEGER NOT NULL DEFAULT 0,
        reqs            INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date, proto, provider_id, provider_key_id, model, upstream_model)
      ) WITHOUT ROWID;
      CREATE INDEX idx_usage_mpd_user ON usage_model_provider_daily(user_id, date);

      INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs)
        SELECT key_id, user_id, date(ts/1000, 'unixepoch'), proto, '', '', model, '',
               SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*)
        FROM usage_events
        GROUP BY key_id, date(ts/1000, 'unixepoch'), proto, model;
      `,
  },
  {
    name: "012_model_pricing_columns",
    // Keep the JSON object for rich provider metadata, but make the common
    // token prices real columns so filtering and sorting do not parse JSON.
    up: () => {
      db.exec(`
        ALTER TABLE models ADD COLUMN pricing_input REAL;
        ALTER TABLE models ADD COLUMN pricing_input_cache REAL;
        ALTER TABLE models ADD COLUMN pricing_input_cache_write REAL;
        ALTER TABLE models ADD COLUMN pricing_output REAL;
      `);
      const rows = db
        .prepare<{ id: string; pricing: string | null }, []>("SELECT id, pricing FROM models")
        .all();
      const update = db.prepare(
        `UPDATE models SET pricing = ?, pricing_input = ?, pricing_input_cache = ?,
         pricing_input_cache_write = ?, pricing_output = ? WHERE id = ?`,
      );
      for (const row of rows) {
        let parsed: unknown = null;
        if (row.pricing) {
          try {
            parsed = JSON.parse(row.pricing);
          } catch {}
        }
        const pricing = normalizePricing(parsed);
        const columns = pricingColumns(pricing);
        update.run(
          pricing ? JSON.stringify(pricing) : null,
          columns.input,
          columns.inputCache,
          columns.inputCacheWrite,
          columns.output,
          row.id,
        );
      }
    },
  },
  {
    name: "013_events_audit_keyset",
    // Keyset-pagination + sorted-grid support for the two unbounded tables
    // (usage_events grows ~10k rows/day under the audited scenario).
    //
    // The dashboard grids paginate with `ORDER BY ts DESC, id DESC` and a
    // LIMIT/OFFSET, so a deep page walks O(offset) index entries. The
    // (user_id, ts, id) index lets the keyset predicate (`ts <= X AND NOT
    // (ts = X AND id >= Y)`) start at the cursor: deep forward pages become
    // O(page). The in_tok tail gives the same jump treatment to grid sorts
    // on that column — AND stays a win for unselective filters on it
    // (measured: 316ms -> 0.01ms at 5y of the audited load). A latency_ms
    // tail was measured and REJECTED: a >= threshold on it matches most rows
    // of the seed distribution (~56%), so the planner routes ~half the user
    // slice through the index + temp-sorts it (2.3s at 18.25M events vs
    // 0.2ms on the ts-scan). Same pair for audit_log, whose grid sorts by
    // (ts DESC, id DESC) and frequently filters by action.
    up: `
      CREATE INDEX idx_usage_user_ts_id ON usage_events(user_id, ts, id);
      CREATE INDEX idx_usage_user_in_tok_id ON usage_events(user_id, in_tok, id);
      CREATE INDEX idx_audit_ts_id ON audit_log(ts, id);
      CREATE INDEX idx_audit_action_ts ON audit_log(action, ts, id);
    `,
  },
  {
    name: "014_remote_code",
    // Remote Code: registered daemon hosts and temporary pairing tokens.
    // Sessions and event transcripts reside on the remote daemon itself (local-first).
    up: `
      CREATE TABLE remote_hosts (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name              TEXT NOT NULL DEFAULT '',
        hostname          TEXT NOT NULL DEFAULT '',
        os                TEXT NOT NULL DEFAULT '',
        arch              TEXT NOT NULL DEFAULT '',
        daemon_token_hash TEXT NOT NULL UNIQUE,
        api_key_id        TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
        status            TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
        last_seen_at      INTEGER,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_remote_hosts_user ON remote_hosts(user_id);

      CREATE TABLE remote_pairing_tokens (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_remote_pairing_user ON remote_pairing_tokens(user_id);
    `,
  },
  {
    name: "016_model_registry_trim",
    // The registry no longer tracks per-model protocol or upstream catalog
    // trivia: every model serves both surfaces (Anthropic-only providers via
    // translation), always_on is implicitly true, and the hugging-face /
    // quantization / openrouter / created / datacenters metadata is gone.
    up: `
      ALTER TABLE models DROP COLUMN proto;
      ALTER TABLE models DROP COLUMN always_on;
      ALTER TABLE models DROP COLUMN hugging_face_id;
      ALTER TABLE models DROP COLUMN quantization;
      ALTER TABLE models DROP COLUMN openrouter_slug;
      ALTER TABLE models DROP COLUMN created;
      ALTER TABLE models DROP COLUMN datacenters;
    `,
  },
  {
    name: "017_responses_capability",
    // Third protocol surface: OpenAI Responses API. Providers gain a
    // `responses_base_url` capability (+ auth style, default bearer like
    // OpenAI); usage `proto` widens to 'responses' on both tables carrying
    // the CHECK (usage_model_daily never had one). SQLite can't alter a
    // CHECK, so both tables are rebuilt (same precedent as 008).
    up: `
      ALTER TABLE providers ADD COLUMN responses_base_url TEXT;
      ALTER TABLE providers ADD COLUMN responses_auth_style TEXT NOT NULL DEFAULT 'bearer';

      CREATE TABLE usage_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id     TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        proto      TEXT NOT NULL CHECK (proto IN ('openai','anthropic','responses')),
        model      TEXT NOT NULL DEFAULT '',
        in_tok     INTEGER NOT NULL DEFAULT 0,
        out_tok    INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        status     INTEGER NOT NULL DEFAULT 200,
        stream     INTEGER NOT NULL DEFAULT 0,
        estimated  INTEGER NOT NULL DEFAULT 0,
        cache_tok  INTEGER NOT NULL DEFAULT 0,
        provider_id TEXT NOT NULL DEFAULT '',
        provider_key_id TEXT NOT NULL DEFAULT '',
        upstream_model TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO usage_events_new
        (id, key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms,
         status, stream, estimated, cache_tok, provider_id, provider_key_id, upstream_model)
        SELECT id, key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms,
         status, stream, estimated, cache_tok, provider_id, provider_key_id, upstream_model
        FROM usage_events;
      DROP TABLE usage_events;
      ALTER TABLE usage_events_new RENAME TO usage_events;
      CREATE INDEX idx_usage_key_ts ON usage_events(key_id, ts);
      CREATE INDEX idx_usage_user_ts ON usage_events(user_id, ts);
      CREATE INDEX idx_usage_ts ON usage_events(ts);
      CREATE INDEX idx_usage_user_ts_id ON usage_events(user_id, ts, id);
      CREATE INDEX idx_usage_user_in_tok_id ON usage_events(user_id, in_tok, id);

      CREATE TABLE usage_model_provider_daily_new (
        key_id          TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        date            TEXT NOT NULL,
        proto           TEXT NOT NULL CHECK (proto IN ('openai','anthropic','responses')),
        provider_id     TEXT NOT NULL DEFAULT '',
        provider_key_id TEXT NOT NULL DEFAULT '',
        model           TEXT NOT NULL,
        upstream_model  TEXT NOT NULL DEFAULT '',
        in_tok          INTEGER NOT NULL DEFAULT 0,
        cache_tok       INTEGER NOT NULL DEFAULT 0,
        out_tok         INTEGER NOT NULL DEFAULT 0,
        reqs            INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date, proto, provider_id, provider_key_id, model, upstream_model)
      ) WITHOUT ROWID;
      INSERT INTO usage_model_provider_daily_new SELECT * FROM usage_model_provider_daily;
      DROP TABLE usage_model_provider_daily;
      ALTER TABLE usage_model_provider_daily_new RENAME TO usage_model_provider_daily;
      CREATE INDEX idx_usage_mpd_user ON usage_model_provider_daily(user_id, date);
    `,
  },
  {
    name: "018_provider_strip_params",
    // Per-provider upstream parameter blocklist: top-level request-body keys
    // the provider rejects (e.g. reasoning-only models refusing `temperature`
    // or `max_tokens`). Stored as a JSON string array, default empty.
    up: `
      ALTER TABLE providers ADD COLUMN strip_params TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    name: "019_push_subscriptions",
    // Web Push subscriptions for turn-end notifications with no tab open.
    // One row per (user, browser endpoint): the endpoint URL is globally
    // unique, so it is the natural dedup key. p256dh/auth are the
    // RFC 8291 client keys (public, safe to store). Dead endpoints (410/404
    // from the push service) are deleted on the send path.
    up: `
      CREATE TABLE push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        label      TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);
    `,
  },
  {
    name: "020_no_auto_key_skip",
    // No-skip policy: the gateway never removes a provider key from rotation
    // automatically (see server/failover.ts). Pre-existing rows stuck in
    // `exhausted`/cooldown state from the old policy are cured back to
    // `active` — only an explicit admin `disabled` keeps a key out. New
    // failures only bump the admin-visible `fail_count` counter.
    up: () => {
      db.prepare(
        `UPDATE provider_keys
         SET status = 'active', exhausted_reason = NULL, cooldown_until = NULL,
           fail_count = 0, updated_at = ?
         WHERE status = 'exhausted'`,
      ).run(Date.now());
    },
  },
  {
    name: "021_model_tool_call_mode",
    // Per-model tool-call strategy. 'native' = everything off; 'fallback'
    // (default) = native tools forwarded but markup calls recovered from
    // every dialect; 'workaround' = strip tools + inject the in-band
    // instruction (see server/proxy/markup-tools.ts). Existing models whose
    // id contains "xiaomi" are backfilled to 'workaround' so the behaviour
    // they already had (id-based auto-detection) becomes an explicit,
    // editable setting; everything else starts at 'fallback'.
    up: `
      ALTER TABLE models ADD COLUMN tool_call_mode TEXT NOT NULL DEFAULT 'fallback';
      UPDATE models SET tool_call_mode = 'workaround' WHERE lower(id) LIKE '%xiaomi%';
    `,
  },
  {
    name: "022_model_tool_call_mode_default_fallback",
    // Tool-call modes are strictly per-model opt-in: there is no id-based
    // auto-detection anymore, so every existing model is reset to the passive
    // 'fallback' default (including the 021 xiaomi backfill and any manual
    // workaround/own overrides). Admins re-apply an active mode explicitly
    // per model if needed.
    up: `
      UPDATE models SET tool_call_mode = 'fallback';
    `,
  },
  {
    name: "023_usage_range_indexes",
    // WITHOUT ROWID secondary indexes already carry every primary-key
    // dimension. Adding reqs makes range-scoped facets covering reads without
    // duplicating the token metrics or maintaining another aggregate table.
    up: `
      DROP INDEX idx_usage_mpd_user;
      CREATE INDEX idx_usage_mpd_user ON usage_model_provider_daily(user_id, date, reqs);
      CREATE INDEX idx_usage_mpd_date ON usage_model_provider_daily(date, user_id, reqs);
      CREATE INDEX idx_usage_user_model_ts_id ON usage_events(user_id, model, ts, id);
    `,
  },
  {
    name: "024_usage_monthly_rollup",
    // Bound long-history reads by months rather than individual days. Backfill
    // from the durable daily ledger, including history whose raw logs expired.
    up: `
      CREATE TABLE usage_model_provider_monthly (
        key_id TEXT NOT NULL, user_id TEXT NOT NULL, month TEXT NOT NULL,
        proto TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '', provider_key_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL, upstream_model TEXT NOT NULL DEFAULT '',
        in_tok INTEGER NOT NULL DEFAULT 0, cache_tok INTEGER NOT NULL DEFAULT 0,
        out_tok INTEGER NOT NULL DEFAULT 0, reqs INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, month, proto, provider_id, provider_key_id, model, upstream_model)
      ) WITHOUT ROWID;
      INSERT INTO usage_model_provider_monthly
        SELECT key_id, user_id, substr(date, 1, 7), proto, provider_id, provider_key_id, model, upstream_model,
               SUM(in_tok), SUM(cache_tok), SUM(out_tok), SUM(reqs)
        FROM usage_model_provider_daily
        GROUP BY key_id, substr(date, 1, 7), proto, provider_id, provider_key_id, model, upstream_model;
      CREATE INDEX idx_usage_mpm_user ON usage_model_provider_monthly(user_id, month, reqs);
      CREATE INDEX idx_usage_mpm_month ON usage_model_provider_monthly(month, user_id, reqs);
    `,
  },
  {
    name: "025_usage_response_outcomes",
    // Keep HTTP outcomes in the existing rollups, with no additional write
    // statement per request. Only retained events can classify old history;
    // archived requests without a status remain explicitly unclassified.
    up: `
      ALTER TABLE usage_model_provider_daily ADD COLUMN success_reqs INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_model_provider_daily ADD COLUMN error_reqs INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_model_provider_monthly ADD COLUMN success_reqs INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_model_provider_monthly ADD COLUMN error_reqs INTEGER NOT NULL DEFAULT 0;

      INSERT INTO usage_model_provider_daily
        (key_id, user_id, date, proto, provider_id, provider_key_id, model, upstream_model,
         in_tok, cache_tok, out_tok, reqs, success_reqs, error_reqs)
      SELECT key_id, user_id, date(ts / 1000, 'unixepoch'), proto, provider_id, provider_key_id, model, upstream_model,
        SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*),
        SUM(status >= 200 AND status < 300), SUM(status < 200 OR status >= 300)
      FROM usage_events
      GROUP BY key_id, date(ts / 1000, 'unixepoch'), proto, provider_id, provider_key_id, model, upstream_model
      ON CONFLICT(key_id, date, proto, provider_id, provider_key_id, model, upstream_model)
      DO UPDATE SET success_reqs = excluded.success_reqs, error_reqs = excluded.error_reqs;

      INSERT INTO usage_model_provider_monthly
        (key_id, user_id, month, proto, provider_id, provider_key_id, model, upstream_model,
         in_tok, cache_tok, out_tok, reqs, success_reqs, error_reqs)
      SELECT key_id, user_id, substr(date, 1, 7), proto, provider_id, provider_key_id, model, upstream_model,
        SUM(in_tok), SUM(cache_tok), SUM(out_tok), SUM(reqs), SUM(success_reqs), SUM(error_reqs)
      FROM usage_model_provider_daily
      GROUP BY key_id, substr(date, 1, 7), proto, provider_id, provider_key_id, model, upstream_model
      ON CONFLICT(key_id, month, proto, provider_id, provider_key_id, model, upstream_model)
      DO UPDATE SET success_reqs = excluded.success_reqs, error_reqs = excluded.error_reqs;
    `,
  },

  {
    name: "026_usd_plans_and_atomic_budgets",
    up: () => {
      db.exec(`
        ALTER TABLE api_keys ADD COLUMN daily_usd_nanos INTEGER;
        ALTER TABLE api_keys ADD COLUMN total_usd_nanos INTEGER;
        UPDATE api_keys SET daily_limit = NULL, total_limit = NULL,
          status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END;
        CREATE TABLE billing_plans (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly_nanos INTEGER,
          weekly_enabled INTEGER NOT NULL DEFAULT 0 CHECK(weekly_enabled IN (0,1)),
          session_enabled INTEGER NOT NULL DEFAULT 0 CHECK(session_enabled IN (0,1)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          CHECK(monthly_nanos IS NULL OR monthly_nanos > 0),
          CHECK(monthly_nanos IS NOT NULL OR (weekly_enabled = 0 AND session_enabled = 0))
        );
        CREATE TABLE user_billing (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          plan_id TEXT REFERENCES billing_plans(id) ON DELETE RESTRICT,
          assignment_version INTEGER NOT NULL DEFAULT 0, session_start INTEGER
        );
        CREATE INDEX idx_billing_plan_users ON user_billing(plan_id);
        CREATE TABLE billing_periods (
          scope TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
          starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
          spent_nanos INTEGER NOT NULL DEFAULT 0 CHECK(typeof(spent_nanos) = 'integer' AND spent_nanos >= 0),
          reserved_nanos INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved_nanos) = 'integer' AND reserved_nanos >= 0),
          forgiven_nanos INTEGER NOT NULL DEFAULT 0 CHECK(typeof(forgiven_nanos) = 'integer' AND forgiven_nanos >= 0 AND forgiven_nanos <= spent_nanos),
          PRIMARY KEY(scope, owner_id, kind, starts_at)
        ) WITHOUT ROWID;
        CREATE INDEX idx_billing_period_expiry ON billing_periods(ends_at);
        CREATE TABLE billing_instances (id TEXT PRIMARY KEY, heartbeat INTEGER NOT NULL);
        CREATE TABLE billing_reservations (
          id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, key_id TEXT NOT NULL, user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL, settled_at INTEGER, amount_nanos INTEGER NOT NULL,
          periods TEXT NOT NULL, pricing TEXT NOT NULL,
          cost_in_nanos INTEGER, cost_cache_nanos INTEGER, cost_out_nanos INTEGER,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','settled','recovered'))
        );
        CREATE INDEX idx_billing_pending ON billing_reservations(instance_id, created_at) WHERE state = 'pending';
        CREATE INDEX idx_billing_settled ON billing_reservations(settled_at);
        CREATE TABLE billing_reset_grants (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assignment_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('weekly','session','both')),
          remaining INTEGER NOT NULL CHECK(remaining >= 0), expires_at INTEGER,
          created_at INTEGER NOT NULL, actor_id TEXT, note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX idx_billing_grants_user ON billing_reset_grants(user_id, created_at);
        CREATE TABLE billing_reset_uses (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          grant_id TEXT NOT NULL, created_at INTEGER NOT NULL
        );
      `);
      db.exec("CREATE INDEX idx_models_upstream_billing ON models(upstream_model, id)");
      // Freeze historical prices once. Unpriced history remains zero; future
      // finite budgets reject unpriced models instead of treating them as free.
      for (const table of ['usage_events', 'usage_model_daily', 'usage_model_provider_daily', 'usage_model_provider_monthly']) {
        for (const part of ['in', 'cache', 'out']) db.exec(`ALTER TABLE ${table} ADD COLUMN cost_${part}_nanos INTEGER`);
        const modelPrice = (column: string, fallback = '0') => `COALESCE(
          (SELECT ${column} FROM models WHERE id = ${table}.model),
          ${table === 'usage_model_daily' ? '' : `(SELECT ${column} FROM models WHERE id = ${table}.upstream_model),
          (SELECT ${column} FROM models WHERE upstream_model = ${table}.upstream_model ORDER BY id LIMIT 1),`}
          ${fallback})`;
        const input = modelPrice('pricing_input');
        db.exec(`UPDATE ${table} SET
          cost_in_nanos = CAST(ROUND(in_tok * ${input} * 1000000000) AS INTEGER),
          cost_cache_nanos = CAST(ROUND(cache_tok * ${modelPrice('pricing_input_cache', input)} * 1000000000) AS INTEGER),
          cost_out_nanos = CAST(ROUND(out_tok * ${modelPrice('pricing_output')} * 1000000000) AS INTEGER)`);
      }
      const cost = '(cost_in_nanos + cost_cache_nanos + cost_out_nanos)';
      db.exec(`
        INSERT INTO billing_periods(scope, owner_id, kind, starts_at, ends_at, spent_nanos)
          SELECT 'key', key_id, 'lifetime', 0, 8640000000000000, SUM(${cost}) FROM usage_model_provider_daily GROUP BY key_id;
        INSERT INTO billing_periods(scope, owner_id, kind, starts_at, ends_at, spent_nanos)
          SELECT 'key', key_id, 'daily', unixepoch(date)*1000, (unixepoch(date)+86400)*1000, SUM(${cost})
          FROM usage_model_provider_daily WHERE date = date('now') GROUP BY key_id, date;
        INSERT INTO billing_periods(scope, owner_id, kind, starts_at, ends_at, spent_nanos)
          SELECT 'user', user_id, 'monthly', unixepoch(month||'-01')*1000, unixepoch(month||'-01', '+1 month')*1000, SUM(${cost})
          FROM usage_model_provider_monthly WHERE month = strftime('%Y-%m','now') GROUP BY user_id, month;
        INSERT INTO billing_periods(scope, owner_id, kind, starts_at, ends_at, spent_nanos)
          SELECT 'user', user_id, 'weekly', unixepoch(date('now','weekday 0','-6 days'))*1000,
            unixepoch(date('now','weekday 0','+1 day'))*1000, SUM(${cost})
          FROM usage_model_provider_daily WHERE date >= date('now','weekday 0','-6 days') GROUP BY user_id;
      `);
    },
  },
  {
    name: "027_usage_subday_rollups",
    up: () => {
      for (const kind of ["hour", "minute"]) {
        db.exec(`CREATE TABLE usage_${kind}_rollups (
          bucket INTEGER NOT NULL, key_id TEXT NOT NULL, user_id TEXT NOT NULL,
          proto TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '', provider_key_id TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL, upstream_model TEXT NOT NULL DEFAULT '',
          in_tok INTEGER NOT NULL, cache_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL,
          reqs INTEGER NOT NULL, success_reqs INTEGER NOT NULL, error_reqs INTEGER NOT NULL,
          cost_in_nanos INTEGER, cost_cache_nanos INTEGER, cost_out_nanos INTEGER,
          PRIMARY KEY(bucket, key_id, proto, provider_id, provider_key_id, model, upstream_model)
        ) WITHOUT ROWID;
        CREATE INDEX idx_usage_${kind}_user ON usage_${kind}_rollups(user_id, bucket, reqs);
        CREATE INDEX idx_usage_${kind}_bucket ON usage_${kind}_rollups(bucket, user_id, reqs);`);
      }
      // Older rows are not assumed to have rollups. New traffic is covered
      // from the next complete bucket; an offline rebuild can extend coverage.
      db.exec(`CREATE TABLE usage_rollup_coverage (
        id INTEGER PRIMARY KEY CHECK(id = 1), raw_from INTEGER NOT NULL,
        hourly_from INTEGER NOT NULL, minute_from INTEGER NOT NULL
      );
      INSERT INTO usage_rollup_coverage VALUES (1, 0,
        (CAST(unixepoch() * 1000 / 3600000 AS INTEGER) + 1) * 3600000,
        (CAST(unixepoch() * 1000 / 60000 AS INTEGER) + 1) * 60000);`);
    },
  },
  {
    name: "028_usage_rollup_prune_floors",
    up: `ALTER TABLE usage_rollup_coverage ADD COLUMN hour_floor INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_rollup_coverage ADD COLUMN minute_floor INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    name: "029_financial_policy",
    // Per-user override of the installation's financial visibility defaults.
    // A NULL column means "inherit"; a row with both columns NULL is deleted
    // rather than stored, so the table only ever holds real overrides.
    // Enforced server-side: hiding a dashboard component would still ship the
    // amounts in the API response.
    up: `
      CREATE TABLE user_financial_policy (
        user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        show_model_prices   INTEGER CHECK (show_model_prices IN (0, 1)),
        budget_presentation TEXT CHECK (budget_presentation IN ('usd', 'percent', 'hidden')),
        updated_at          INTEGER NOT NULL
      );
      CREATE TABLE installation_policy (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    name: "030_request_correlation",
    // The correlation id ties an audit row, a usage event and the response
    // header (X-Request-Id) together. Existing rows keep NULL: they predate
    // the field and inventing an id for them would be a lie.
    up: `
      ALTER TABLE audit_log ADD COLUMN request_id TEXT;
      ALTER TABLE usage_events ADD COLUMN request_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX idx_audit_request ON audit_log(request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX idx_usage_request ON usage_events(request_id) WHERE request_id != '';
    `,
  },
  {
    name: "031_model_access_policy",
    // Named allow-lists of model ids. `kind = 'default'` is the installation
    // fallback; `kind = 'project'` binds to a project. An empty allow-list
    // means "no restriction", so creating a policy cannot black out a working
    // installation before the administrator fills it in.
    up: `
      CREATE TABLE model_policies (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('default','project')),
        project_id TEXT,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_model_policies_project ON model_policies(project_id);
      CREATE TABLE model_policy_models (
        policy_id TEXT NOT NULL REFERENCES model_policies(id) ON DELETE CASCADE,
        model_id  TEXT NOT NULL,
        PRIMARY KEY (policy_id, model_id)
      ) WITHOUT ROWID;
    `,
  },
  {
    name: "032_reservation_request_correlation",
    // Reservation primary keys must always be fresh internal identifiers so a
    // client retrying or sharing X-Request-Id across calls never collides on
    // billing_reservations.id; request_id remains indexed for correlation.
    up: `
      ALTER TABLE billing_reservations ADD COLUMN request_id TEXT;
      CREATE INDEX idx_billing_reservations_request ON billing_reservations(request_id) WHERE request_id IS NOT NULL;
    `,
  },
  {
    name: "033_maintenance_indexes",
    // Keep periodic session and password-token cleanup O(batch) rather than
    // scanning the full table inside a write transaction.
    up: `
      CREATE INDEX IF NOT EXISTS idx_sessions_abs_expires ON sessions(abs_expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_active_expires ON sessions(expires_at) WHERE revoked = 0;
      CREATE INDEX IF NOT EXISTS idx_password_tokens_expires ON password_tokens(expires_at);
    `,
  },
];

/**
 * Boot must survive a database that another process is holding.
 *
 * `migrate()` runs at module load, before the HTTP server exists, so an
 * escaping SQLITE_BUSY is an uncaught exception and Bun exits the process with
 * code 1. The reported failure was exactly that: an operator's external write
 * transaction held the database, `PRAGMA optimize` inside migrate() hit the
 * lock, and the gateway died instead of waiting for the writer to finish.
 *
 * The boot path therefore retries transient contention with a much longer
 * budget than a periodic sweep (an operator may hold a transaction for
 * minutes), and treats the planner-statistics refresh as best effort: it is an
 * optimization, never a prerequisite for serving.
 */
function migrateWithRetry(): void {
  const deadline = Date.now() + BOOT_LOCK_DEADLINE_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      applyMigrations();
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const delay = Math.min(2_000, 50 * 2 ** (attempt - 1));
      if (Date.now() + delay > deadline) {
        console.error(
          `[DB] database stayed locked for ${Math.round(BOOT_LOCK_DEADLINE_MS / 1000)}s during boot.` +
          " Another process (backup tool, sqlite3 session, second gateway) still holds a write transaction." +
          " Release it and restart, or raise SQLITE_BOOT_LOCK_TIMEOUT_MS.",
        );
        throw error;
      }
      if (attempt === 1) console.warn("[DB] database is busy at boot; waiting for the other writer to finish");
      Bun.sleepSync(delay);
    }
  }
}

function applyMigrations(): void {
  const row = Object.values(
    db.query<Record<string, number>, []>("PRAGMA user_version").get() ?? {},
  );
  const version = Number(row[0] ?? 0);
  for (let i = version; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i]!;
    db.transaction(() => {
      if (typeof m.up === "string") db.exec(m.up);
      else m.up();
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
    console.log(`[DB] migration applied: ${m.name}`);
  }
  // Give the query planner table statistics. Without ANALYZE data, SQLite
  // picks bad plans once usage_events grows (measured: the admin 24h per-user
  // aggregate went 287ms -> 0.5ms at 3.65M rows only because of this).
  // Incremental: cheap no-op once stats exist — and optional, so a busy
  // database degrades the next queries slightly instead of failing boot.
  try {
    db.exec("PRAGMA optimize");
  } catch (error) {
    if (!isSqliteBusy(error)) throw error;
    console.warn("[DB] PRAGMA optimize skipped: database is busy");
  }
}

/** How long boot waits for another process to release the database. */
const BOOT_LOCK_DEADLINE_MS = (() => {
  const raw = Number(process.env.SQLITE_BOOT_LOCK_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

export function migrate(): void {
  migrateWithRetry();
}

if (!usageReader) migrate();

// ===== Row types =====

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  password_hash: string | null;
  google_id: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  status: "active" | "banned";
  created_at: number;
  last_login_at: number | null;
}

export interface SessionRow {
  jti: string;
  user_id: string;
  refresh_hash: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  abs_expires_at: number;
  revoked: number;
  ip: string | null;
  ua: string | null;
  label: string | null;
  family: string | null;
}

export type AuthStyle = "bearer" | "x-api-key";

/** Every protocol surface the gateway speaks, and every upstream
 *  capability a provider may expose. "openai" is chat-completions,
 *  "responses" is the OpenAI Responses API, "anthropic" is Messages. */
export type Proto = "openai" | "anthropic" | "responses";

export interface ProviderRow {
  id: string;
  name: string;
  openai_base_url: string | null;
  anthropic_base_url: string | null;
  responses_base_url: string | null;
  api_key_enc: string;
  enabled: number;
  priority: number;
  created_at: number;
  openai_auth_style: AuthStyle;
  anthropic_auth_style: AuthStyle;
  responses_auth_style: AuthStyle;
  /** JSON string array of top-level request-body keys withheld upstream. */
  strip_params: string;
}

/** Tolerant parse of `providers.strip_params` (admin-validated on write). */
export function parseStripParams(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 32);
  } catch {
    return [];
  }
}

/** How the proxy maps `body.model` to an upstream provider.
 *  - passthrough (default): the model string goes to the provider untouched.
 *  - router: the model MUST exist in the registry and is rewritten to the
 *    registered upstream_model of its provider. */
export type RoutingMode = "passthrough" | "router";

/** A registered public model id (Model Registry). `upstream_model` is what the
 *  provider actually receives; `id` is what gateway clients send. */
export interface ModelRow {
  id: string;
  /** NULL = orphaned (its provider was deleted without cascade). */
  provider_id: string | null;
  upstream_model: string;
  name: string;
  description: string;
  enabled: number;
  context_length: number | null;
  max_output_length: number | null;
  /** JSON arrays/objects (validated on write). */
  input_modalities: string;
  output_modalities: string;
  sampling_params: string;
  features: string;
  reasoning_efforts: string | null;
  /** Tool-call strategy: 'native' | 'fallback' | 'workaround' | 'own' (migration 021). */
  tool_call_mode: string;
  pricing: string | null;
  pricing_input: number | null;
  pricing_input_cache: number | null;
  pricing_input_cache_write: number | null;
  pricing_output: number | null;
  source: "auto" | "manual";
  created_at: number;
  updated_at: number;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: number;
  expires_at: number | null;
  daily_limit: number | null;
  total_limit: number | null;
  daily_usd_nanos?: number | null;
  total_usd_nanos?: number | null;
  rpm: number | null;
  status: "active" | "revoked" | "exhausted";
  last_used_at: number | null;
  last_used_ip: string | null;
  token_enc: string | null;
}

/** One upstream API key of a provider (failover chain, ordered by priority).
 *  `exhausted` = detected out-of-credits ('billing', auto-retried after
 *  midnight UTC) or rejected credential ('auth', stays down until re-enabled).
 *  `cooldown_until` covers transient/rate-limit backoff. */
export interface ProviderKeyRow {
  id: string;
  provider_id: string;
  label: string;
  api_key_enc: string;
  priority: number;
  status: "active" | "disabled" | "exhausted";
  fail_count: number;
  cooldown_until: number | null;
  exhausted_reason: string | null;
  created_at: number;
  updated_at: number;
}

/** One routing destination of a registered model: which provider serves it
 *  and under which upstream id. The ordered list (priority ASC) is the
 *  per-model fallback chain. */
export interface ModelTargetRow {
  model_id: string;
  provider_id: string;
  upstream_model: string;
  priority: number;
  enabled: number;
  created_at: number;
}

export interface RemoteHostRow {
  id: string;
  user_id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  daemon_token_hash: string;
  api_key_id: string | null;
  status: "online" | "offline";
  last_seen_at: number | null;
  created_at: number;
}

export interface RemotePairingTokenRow {
  token: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}

// ===== Prepared statements (hot paths) =====

export const stmts = {
  userById: db.prepare<UserRow, [string]>("SELECT * FROM users WHERE id = ?"),
  userByEmail: db.prepare<UserRow, [string]>("SELECT * FROM users WHERE email = ?"),
  userByGoogleId: db.prepare<UserRow, [string]>("SELECT * FROM users WHERE google_id = ?"),
  keyByHash: db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE hash = ?"),
  sessionByJti: db.prepare<SessionRow, [string]>("SELECT * FROM sessions WHERE jti = ?"),
  sessionByRefreshHash: db.prepare<SessionRow, [string]>(
    "SELECT * FROM sessions WHERE refresh_hash = ?",
  ),
};

/**
 * Execute `fn` inside a `BEGIN IMMEDIATE` transaction at the outer boundary,
 * or inside a nested SQLite `SAVEPOINT` when already inside a transaction.
 */
export function inImmediateTx<T>(fn: () => T): T {
  return db.inTransaction ? db.transaction(fn)() : db.transaction(fn).immediate();
}

const insertAuditStmt = db.prepare(
  "INSERT INTO audit_log (ts, actor_id, action, target, meta, ip, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

/** In-process dashboard cache invalidation for audited metadata mutations. */
export let auditRevision = 0;

export function audit(
  action: string,
  opts: { actorId?: string | null; target?: string | null; meta?: unknown; ip?: string | null; requestId?: string | null } = {},
): void {
  // The correlation id is inherited from the request scope when the caller does
  // not pass one, so every audit row written while serving a request can be
  // matched to the response header the client saw.
  const requestId = opts.requestId ?? currentRequestId();
  insertAuditStmt.run(
    Date.now(),
    opts.actorId ?? null,
    action,
    opts.target ?? null,
    opts.meta === undefined ? null : JSON.stringify(opts.meta),
    opts.ip ?? null,
    requestId || null,
  );
  auditRevision++;
}

export interface WalCheckpointStatus {
  runs: number;
  busyRuns: number;
  lastRunAt: number | null;
  lastLogFrames: number;
  lastCheckpointedFrames: number;
}

const walStats: WalCheckpointStatus = {
  runs: 0,
  busyRuns: 0,
  lastRunAt: null,
  lastLogFrames: 0,
  lastCheckpointedFrames: 0,
};

/**
 * Passive WAL checkpoint: transfers frames that no active reader depends on
 * back into gateway.db without blocking concurrent readers or writers.
 */
export function runPassiveWalCheckpoint(targetDb: Database = db): WalCheckpointStatus {
  const row = targetDb
    .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(PASSIVE)")
    .get();
  walStats.runs++;
  walStats.lastRunAt = Date.now();
  if (row) {
    if (row.busy > 0) walStats.busyRuns++;
    walStats.lastLogFrames = row.log;
    walStats.lastCheckpointedFrames = row.checkpointed;
  }
  return { ...walStats };
}

export function walCheckpointStatus(): WalCheckpointStatus {
  return { ...walStats };
}
