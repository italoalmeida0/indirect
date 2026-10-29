import { db } from "./db";
import { ApiError } from "./http";
import { keyQuerySource } from "./keys";
import { buildGridOrder, likeEscape, parseCursor, parseGridQuery } from "./gridql";
import { cachedUsageQuery } from "./usage-cache";

export type CatalogKind = "keys" | "providers" | "models" | "users" | "audit";
interface Field { id: string; label: string; icon: string; value: string; display?: string; json?: string }
type Selection = Record<string, { include: string[]; exclude: string[] }>;
const labels: Record<string, string> = { active: "Active", enabled: "Enabled", disabled: "Disabled", revoked: "Revoked", exhausted: "Budget exhausted", expired: "Expired", daily_limit: "Daily budget spent", total_limit: "Total budget spent", permanent: "Permanent", expiring: "Expiring", limited: "Limited", unlimited: "Unlimited", auto: "Imported", manual: "Manual", user: "User", admin: "Administrator", fallback: "Fallback", native: "Native", workaround: "Workaround", own: "Custom", openai: "OpenAI", anthropic: "Anthropic", responses: "Responses" };
const enumFields = new Set(["status", "role", "expiry", "budget", "source", "tool_mode", "two_factor", "password", "google", "protocol"]);
const field = (id: string, label: string, value: string, icon: string, display?: string): Field => ({ id, label, value, icon: `lucide:${icon}`,
  display: display ?? (enumFields.has(id) ? `CASE ${value} ${Object.entries(labels).map(([key, label]) => `WHEN '${key}' THEN '${label}'`).join(" ")} ELSE ${value} END` : undefined) });

/** Projections are internal only: list routes retain their existing DTO
 * serializers. Facets expose explicitly declared values and labels only. */
export function catalogSource(kind: CatalogKind, userId: string | null) {
  if (kind === "keys") return { ...keyQuerySource(userId), time: "created_at", search: ["name", "prefix", ...(userId === null ? ["userEmail"] : [])], fields: [
    field("key", "API key", "r.id", "key-round", "COALESCE(NULLIF(r.name, ''), r.prefix)"),
    field("status", "Status", "r.effective_status", "circle-check"),
    ...(userId === null ? [field("owner", "Owner", "COALESCE(r.userEmail, '')", "users")] : []),
    field("expiry", "Expiration", "CASE WHEN r.expires_at IS NULL THEN 'permanent' WHEN r.expires_at <= CAST(strftime('%s','now') AS INTEGER)*1000 THEN 'expired' ELSE 'expiring' END", "calendar-clock"),
    field("budget", "Budget", "CASE WHEN r.daily_usd_nanos IS NOT NULL OR r.total_usd_nanos IS NOT NULL THEN 'limited' ELSE 'unlimited' END", "gauge"),
  ] };
  if (kind === "providers") return { sql: `SELECT p.*, (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id) AS model_count,
    json_array(CASE WHEN p.openai_base_url IS NOT NULL THEN 'openai' END, CASE WHEN p.anthropic_base_url IS NOT NULL THEN 'anthropic' END, CASE WHEN p.responses_base_url IS NOT NULL THEN 'responses' END) AS capabilities FROM providers p`, params: [], time: "created_at", search: ["name", "openai_base_url", "anthropic_base_url", "responses_base_url"], fields: [
    field("provider", "Provider", "r.id", "server", "r.name"), field("status", "Status", "CASE WHEN r.enabled THEN 'enabled' ELSE 'disabled' END", "circle-check"),
    { ...field("protocol", "Protocol", "v.value", "arrow-left-right"), json: "r.capabilities" },
  ] };
  if (kind === "models") return { sql: `SELECT m.*, p.name AS provider_name,
    (SELECT json_group_array(id) FROM (SELECT t.provider_id AS id FROM model_targets t WHERE t.model_id = m.id UNION SELECT m.provider_id WHERE m.provider_id IS NOT NULL)) AS provider_ids
    FROM models m LEFT JOIN providers p ON p.id = m.provider_id`, params: [], time: "created_at", search: ["id", "name", "upstream_model", "provider_name"], fields: [
    field("model", "Model", "r.id", "box", "COALESCE(NULLIF(r.name, ''), r.id)"),
    { ...field("provider", "Provider", "v.value", "server", "COALESCE((SELECT name FROM providers WHERE id = v.value), v.value)"), json: "r.provider_ids" },
    field("status", "Status", "CASE WHEN r.enabled THEN 'active' ELSE 'disabled' END", "circle-check"), field("source", "Source", "r.source", "database"),
    field("tool_mode", "Tool call mode", "r.tool_call_mode", "wrench"),
    { ...field("feature", "Feature", "v.value", "sparkles"), json: "r.features" },
    { ...field("modality", "Input modality", "v.value", "layers"), json: "r.input_modalities" },
  ] };
  if (kind === "users") return { sql: `SELECT u.*, b.plan_id, bp.name AS plan_name, (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count FROM users u LEFT JOIN user_billing b ON b.user_id = u.id LEFT JOIN billing_plans bp ON bp.id = b.plan_id`, params: [], time: "created_at", search: ["name", "email"], fields: [
    field("plan", "Plan", "COALESCE(r.plan_id, '')", "wallet", "COALESCE(r.plan_name, 'Unlimited')"),
    field("user", "User", "r.id", "user-round", "r.email"), field("role", "Role", "r.role", "shield"), field("status", "Status", "r.status", "circle-check"),
    field("two_factor", "Two-factor authentication", "CASE WHEN r.totp_secret IS NULL THEN 'disabled' ELSE 'enabled' END", "shield-check"),
    field("password", "Password sign-in", "CASE WHEN r.password_hash IS NULL THEN 'disabled' ELSE 'enabled' END", "key-round"),
    field("google", "Google sign-in", "CASE WHEN r.google_id IS NULL THEN 'disabled' ELSE 'enabled' END", "log-in"),
  ] };
  return { sql: "SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id", params: [], time: "ts", search: ["action", "actor_email", "target", "ip", "meta"], fields: [
    field("action", "Action", "r.action", "activity"), field("actor", "Actor", "COALESCE(r.actor_email, '')", "user-round"),
    field("target", "Target", "COALESCE(r.target, '')", "crosshair"), field("ip", "IP address", "COALESCE(r.ip, '')", "network"),
  ] };
}

function readScope(kind: CatalogKind, search: URLSearchParams, userId: string | null) {
  const source = catalogSource(kind, userId);
  const rawFrom = search.get("from");
  const from = rawFrom === null || rawFrom === "all" ? null : Number(rawFrom);
  const to = search.has("to") ? Number(search.get("to")) : Date.now();
  if ((from !== null && (!Number.isSafeInteger(from) || from < 0)) || !Number.isSafeInteger(to) || to <= (from ?? -1) || to > 8_640_000_000_000_000) throw new ApiError(400, "Invalid catalog time range");
  let selection: Selection;
  try {
    const parsed = JSON.parse(search.get("selection") ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw 0;
    let count = 0;
    selection = Object.fromEntries(Object.entries(parsed).map(([id, entry]) => {
      if (!source.fields.some((field) => field.id === id) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw 0;
      const candidate = entry as { include?: unknown; exclude?: unknown };
      const values = (raw: unknown) => {
        if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || v.length > 1024)) throw 0;
        count += raw.length; if (count > 250) throw 0;
        return [...new Set(raw)] as string[];
      };
      return [id, { include: values(candidate.include), exclude: values(candidate.exclude) }];
    }));
  } catch { throw new ApiError(400, "Invalid catalog filters"); }
  const text = search.get("search")?.trim() ?? "";
  if (text.length > 200) throw new ApiError(400, "Search is too long");
  return { source, from, to, selection, text };
}

function scopeWhere(scope: ReturnType<typeof readScope>, selected = true) {
  const clauses = [`r.${scope.source.time} < ?`];
  const params: Array<string | number> = [scope.to];
  if (scope.from !== null) { clauses.push(`r.${scope.source.time} >= ?`); params.push(scope.from); }
  if (scope.text) { clauses.push(`(${scope.source.search.map((col) => `r.${col} LIKE ? ESCAPE '\\'`).join(" OR ")})`); params.push(...scope.source.search.map(() => `%${likeEscape(scope.text)}%`)); }
  if (selected) for (const [id, entry] of Object.entries(scope.selection)) {
    const field = scope.source.fields.find((field) => field.id === id)!;
    for (const mode of ["include", "exclude"] as const) if (entry[mode].length) {
      clauses.push(field.json
        ? `${mode === "exclude" ? "NOT " : ""}EXISTS (SELECT 1 FROM json_each(${field.json}) v WHERE CAST(v.value AS TEXT) IN (SELECT value FROM json_each(?)))`
        : `${field.value} ${mode === "exclude" ? "NOT " : ""}IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(entry[mode]));
    }
  }
  return { clauses, params };
}

export function catalogWhere(kind: CatalogKind, search: URLSearchParams, userId: string | null) {
  return scopeWhere(readScope(kind, search, userId));
}

export function catalogListSource(kind: CatalogKind, search: URLSearchParams, userId: string | null) {
  const scope = readScope(kind, search, userId);
  const where = scopeWhere(scope);
  return { sql: `SELECT r.* FROM (${scope.source.sql}) r WHERE ${where.clauses.join(" AND ")}`, params: [...scope.source.params, ...where.params] };
}

export function catalogFilterOptions(kind: CatalogKind, search: URLSearchParams, userId: string | null) {
  const scope = readScope(kind, search, userId);
  const where = scopeWhere(scope, false);
  const baseParams = [...scope.source.params, ...where.params];
  const optionsSql = (field: Field, extra = "") => `SELECT CAST(${field.value} AS TEXT) AS value,
    COALESCE(NULLIF(CAST(${field.display ?? field.value} AS TEXT), ''), 'Unknown') AS label, COUNT(DISTINCT r.id) AS count
    FROM (${kind === "audit" && field.id !== "actor" && !scope.text ? "SELECT * FROM audit_log" : scope.source.sql}) r ${field.json ? `JOIN json_each(${field.json}) v` : ""}
    WHERE ${where.clauses.join(" AND ")} ${field.json ? "AND v.value IS NOT NULL" : ""} ${extra}
    GROUP BY ${field.value}`;
  type Option = { value: string; label: string; count: number };
  const fieldId = search.get("field");
  if (fieldId) {
    const field = scope.source.fields.find((field) => field.id === fieldId);
    if (!field) throw new ApiError(400, "Unknown catalog filter");
    const query = search.get("q")?.trim() ?? "";
    if (query.length > 200) throw new ApiError(400, "Search is too long");
    const offset = Math.min(1_000_000, Math.max(0, Math.trunc(Number(search.get("offset")) || 0)));
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(search.get("limit")) || 60)));
    const sql = `(${optionsSql(field)})`;
    const match = query ? "WHERE value LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\'" : "";
    const params = [...baseParams, ...(query ? Array(2).fill(`%${likeEscape(query)}%`) as string[] : [])];
    return { field: fieldId, options: db.prepare<Option, Array<string | number>>(`SELECT * FROM ${sql} ${match} ORDER BY count DESC, label COLLATE NOCASE, value LIMIT ? OFFSET ?`).all(...params, limit, offset),
      total: db.prepare<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n FROM ${sql} ${match}`).get(...params)!.n, offset, limit };
  }
  const selection: Selection = {};
  const selectedOptions: Record<string, Option[]> = {};
  for (const [id, entry] of Object.entries(scope.selection)) {
    const field = scope.source.fields.find((field) => field.id === id)!;
    const options = db.prepare<Option, Array<string | number>>(optionsSql(field, `AND ${field.value} IN (SELECT value FROM json_each(?))`)).all(...baseParams, JSON.stringify([...entry.include, ...entry.exclude]));
    const valid = new Set(options.map((option) => option.value));
    const next = { include: entry.include.filter((value) => valid.has(value)), exclude: entry.exclude.filter((value) => valid.has(value)) };
    if (next.include.length || next.exclude.length) { selection[id] = next; selectedOptions[id] = options; }
  }
  return { categories: scope.source.fields.map(({ id, label, icon }) => ({ id, label, icon })), selection, selectedOptions };
}

/** Audit history and its facets run on the same bounded read workers as
 * analytics. Keyset continuation keeps forward paging independent of depth. */
export function catalogAuditPage(search: URLSearchParams) {
  const source = catalogListSource("audit", search, null);
  const grid = parseGridQuery(new URL(`http://catalog/?${search}`));
  const cursor = parseCursor(search.get("cursor"));
  const useCursor = cursor && (!grid.sort?.length || (grid.sort.length === 1 && grid.sort[0]!.colId === "ts" && grid.sort[0]!.sort === "desc"));
  const order = buildGridOrder(grid.sort, { ts: { col: "ts" }, action: { col: "action" }, actor_email: { col: "actor_email" }, target: { col: "target" }, ip: { col: "ip" }, meta: { col: "meta" } }, "ts DESC", "id DESC");
  const entries = db.prepare(`SELECT * FROM (${source.sql}) ${useCursor ? "WHERE ts <= ? AND NOT (ts = ? AND id >= ?)" : ""} ORDER BY ${order} LIMIT ? ${useCursor ? "" : "OFFSET ?"}`)
    .all(...source.params, ...(useCursor ? [cursor.ts, cursor.ts, cursor.id] : []), grid.limit, ...(useCursor ? [] : [grid.offset]));
  const scope = readScope("audit", search, null);
  const needsActor = !!scope.text || !!(scope.selection.actor?.include.length || scope.selection.actor?.exclude.length);
  const countWhere = scopeWhere(scope);
  const countSql = needsActor ? source.sql : `SELECT r.* FROM audit_log r WHERE ${countWhere.clauses.join(" AND ")}`;
  const total = cachedUsageQuery("catalog-audit-count", { from: scope.from, to: scope.to, selection: {} }, null,
    () => db.prepare<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n FROM (${countSql})`).get(...source.params)!.n,
    { selection: scope.selection, search: scope.text });
  return { entries, total, limit: grid.limit, offset: grid.offset };
}
