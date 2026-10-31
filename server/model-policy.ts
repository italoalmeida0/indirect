import { db, inImmediateTx } from "./db";

/**
 * Model access policy.
 *
 * The catalog is a GLOBAL availability: without a policy, every key of every
 * user can list and call every registered model. An installation that wants an
 * economical set for general use and a privileged set for approved projects
 * needs the decision enforced where the request is served, not in the UI.
 *
 * A policy is a named allow-list of model ids with:
 *   - `kind`: "default" or "project" (grants for that project's keys).
 *   - `models`: public model IDs, never provider aliases.
 *
 * No enabled, nonempty default means unrestricted personal and project use.
 * Otherwise a project's enabled nonempty list adds grants to the default.
 * Empty project lists add nothing; they cannot turn a restricted default into
 * unrestricted access. Administrators alone are exempt.
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
  deleted: number;
}

const policyById = db.prepare<ModelPolicyRow, [string]>("SELECT * FROM model_policies WHERE id = ?");
const defaultPolicy = db.prepare<ModelPolicyRow, []>("SELECT * FROM model_policies WHERE kind = 'default' AND enabled = 1 ORDER BY created_at LIMIT 1");
const projectPolicy = db.prepare<ModelPolicyRow, [string]>("SELECT * FROM model_policies WHERE kind = 'project' AND project_id = ? AND enabled = 1 ORDER BY created_at LIMIT 1");
const allowedFor = db.prepare<ModelPolicyEntry, [string]>("SELECT model_id, deleted FROM model_policy_models WHERE policy_id = ? ORDER BY model_id");

/** Read on every request; membership and policy edits need no cache invalidation. */
export function allowedModels(subject: { role?: string; projectId?: string | null }): Set<string> | null {
  if (subject.role === "admin") return null;
  const base = defaultPolicy.get();
  const rows = base ? allowedFor.all(base.id) : [];
  if (rows.length === 0) return null;
  const allowed = new Set(rows.filter((row) => !row.deleted).map((row) => row.model_id));
  const project = subject.projectId ? projectPolicy.get(subject.projectId) : null;
  if (project) for (const row of allowedFor.all(project.id)) if (!row.deleted) allowed.add(row.model_id);
  return allowed;
}

/** True when this model may be used. */
export function modelAllowed(allowed: Set<string> | null, modelId: string): boolean {
  return allowed === null || allowed.has(modelId);
}

export interface ModelPolicySummary extends ModelPolicyRow {
  models: string[];
  missingModels: string[];
}

function summarize(row: ModelPolicyRow): ModelPolicySummary {
  const rows = allowedFor.all(row.id);
  return { ...row, models: rows.filter((entry) => !entry.deleted).map((entry) => entry.model_id), missingModels: rows.filter((entry) => !!entry.deleted).map((entry) => entry.model_id) };
}

export function listPolicies(): ModelPolicySummary[] {
  const rows = db.query<ModelPolicyRow, []>("SELECT * FROM model_policies ORDER BY kind, created_at").all();
  return rows.map(summarize);
}

export function readPolicy(id: string): ModelPolicySummary | null {
  const row = policyById.get(id);
  return row ? summarize(row) : null;
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
  models?: string[];
}, now = Date.now()): string {
  return inImmediateTx(() => {
    const id = input.id ?? ("mp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20));
    if (input.enabled && input.kind === "default") {
      db.prepare("UPDATE model_policies SET enabled = 0 WHERE kind = 'default' AND id <> ?").run(id);
    } else if (input.enabled && input.kind === "project" && input.projectId) {
      db.prepare("UPDATE model_policies SET enabled = 0 WHERE kind = 'project' AND project_id = ? AND id <> ?").run(input.projectId, id);
    }
    db.prepare(`INSERT INTO model_policies (id, name, kind, project_id, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
        project_id = excluded.project_id, enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(id, input.name, input.kind, input.kind === "project" ? input.projectId ?? null : null, input.enabled ? 1 : 0, now, now);
    if (input.models !== undefined) {
      db.prepare("DELETE FROM model_policy_models WHERE policy_id = ?").run(id);
      const insert = db.prepare("INSERT OR IGNORE INTO model_policy_models (policy_id, model_id) VALUES (?, ?)");
      for (const modelId of new Set(input.models)) insert.run(id, modelId);
    }
    return id;
  });
}

export function deletePolicy(id: string): boolean {
  return inImmediateTx(() => {
    const removed = db.prepare("DELETE FROM model_policies WHERE id = ?").run(id).changes;
    db.prepare("DELETE FROM model_policy_models WHERE policy_id = ?").run(id);
    return removed > 0;
  });
}
