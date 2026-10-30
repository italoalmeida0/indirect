import { db } from "./db";

/**
 * Model access policy.
 *
 * The catalog is a GLOBAL availability: without a policy, every key of every
 * user can list and call every registered model. An installation that wants an
 * economical set for general use and a privileged set for approved projects
 * needs the decision enforced where the request is served, not in the UI.
 *
 * A policy is a named allow-list of model ids with:
 *   - `kind`: "default" (applies to everyone without a more specific match)
 *              or "project" (applies to keys attributed to that project).
 *   - `models`: the allowed model ids. An EMPTY list means "no restriction",
 *     which is how an installation stays unrestricted until it opts in.
 *
 * Resolution order for a caller: the project policy assigned to the invoking
 * key's project, else the default policy. Administrators are exempt: they must
 * be able to reach every registered model to administer the installation.
 */

export interface ModelPolicyRow {
  id: string;
  name: string;
  kind: "default" | "project";
  project_id: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ModelPolicyEntry {
  model_id: string;
}

const policyById = db.prepare<ModelPolicyRow, [string]>("SELECT * FROM model_policies WHERE id = ?");
const defaultPolicy = db.prepare<ModelPolicyRow, []>("SELECT * FROM model_policies WHERE kind = 'default' AND enabled = 1 ORDER BY created_at LIMIT 1");
const projectPolicy = db.prepare<ModelPolicyRow, [string]>("SELECT * FROM model_policies WHERE kind = 'project' AND project_id = ? AND enabled = 1 ORDER BY created_at LIMIT 1");
const allowedFor = db.prepare<ModelPolicyEntry, [string]>("SELECT model_id FROM model_policy_models WHERE policy_id = ? ORDER BY model_id");

/** The policy that applies to a request, or null when nothing restricts it. */
export function policyFor(subject: { role?: string; projectId?: string | null }): ModelPolicyRow | null {
  if (subject.role === "admin") return null;
  if (subject.projectId) {
    const project = projectPolicy.get(subject.projectId);
    if (project) return project;
  }
  return defaultPolicy.get() ?? null;
}

/**
 * Allowed model ids for a policy, or null when the policy does not restrict.
 *
 * An empty allow-list is treated as unrestricted on purpose: it is the state a
 * freshly created policy starts in, and silently blocking every model until an
 * administrator fills the list in would be an outage caused by a form.
 */
export function allowedModels(policy: ModelPolicyRow | null): Set<string> | null {
  if (!policy) return null;
  const rows = allowedFor.all(policy.id);
  if (rows.length === 0) return null;
  return new Set(rows.map((row) => row.model_id));
}

/** True when this model may be used. */
export function modelAllowed(allowed: Set<string> | null, modelId: string): boolean {
  return allowed === null || allowed.has(modelId);
}

export interface ModelPolicySummary extends ModelPolicyRow {
  models: string[];
}

export function listPolicies(): ModelPolicySummary[] {
  const rows = db.query<ModelPolicyRow, []>("SELECT * FROM model_policies ORDER BY kind, created_at").all();
  return rows.map((row) => ({ ...row, models: allowedFor.all(row.id).map((entry) => entry.model_id) }));
}

export function readPolicy(id: string): ModelPolicySummary | null {
  const row = policyById.get(id);
  return row ? { ...row, models: allowedFor.all(row.id).map((entry) => entry.model_id) } : null;
}

/**
 * Create or replace a policy. Validated by the caller (admin route): the ids
 * stored here are model ids that must exist in the registry.
 */
export function upsertPolicy(input: {
  id?: string | null;
  name: string;
  kind: "default" | "project";
  projectId?: string | null;
  enabled: boolean;
  models: string[];
}, now = Date.now()): string {
  return db.transaction(() => {
    const id = input.id ?? ("mp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20));
    if (input.kind === "default") {
      db.prepare("UPDATE model_policies SET kind = 'project', project_id = NULL WHERE kind = 'default' AND id <> ?").run(id);
    }
    db.prepare(`INSERT INTO model_policies (id, name, kind, project_id, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
        project_id = excluded.project_id, enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(id, input.name, input.kind, input.kind === "project" ? input.projectId ?? null : null, input.enabled ? 1 : 0, now, now);
    db.prepare("DELETE FROM model_policy_models WHERE policy_id = ?").run(id);
    const insert = db.prepare("INSERT OR IGNORE INTO model_policy_models (policy_id, model_id) VALUES (?, ?)");
    for (const modelId of new Set(input.models)) insert.run(id, modelId);
    return id;
  }).immediate();
}

export function deletePolicy(id: string): boolean {
  return db.transaction(() => {
    const removed = db.prepare("DELETE FROM model_policies WHERE id = ?").run(id).changes;
    db.prepare("DELETE FROM model_policy_models WHERE policy_id = ?").run(id);
    return removed > 0;
  }).immediate();
}
