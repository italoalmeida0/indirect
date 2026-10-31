import { db, type UserRow } from "./db";
import { effectiveRole } from "./roles";
import { ApiError } from "./http";
import type { FinancialPolicy } from "./financial-policy";

export interface FinancialProject {
  id: string;
  kind: "project" | "cost_center";
  code: string;
  name: string;
  description: string;
  cost_center_id: string | null;
  responsible_user_id: string | null;
  status: "active" | "archived";
  monthly_nanos: number | null;
  total_nanos: number | null;
  created_at: number;
  updated_at: number;
}

const byId = db.prepare<FinancialProject, [string]>("SELECT * FROM financial_projects WHERE id = ?");
const membership = db.prepare<{ role: "member" | "manager" }, [string, string]>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?");

export function projectById(id: string): FinancialProject | null { return byId.get(id) ?? null; }

/** A manager has no global authority: both the delegated user role and a
 * manager membership in this exact scope are required for management. */
export function projectAccess(user: UserRow, id: string): "admin" | "manager" | "member" | null {
  if (effectiveRole(user) === "admin") return "admin";
  const member = membership.get(id, user.id);
  if (!member) return null;
  return member.role === "manager" && effectiveRole(user) === "project_manager" ? "manager" : "member";
}

export function requireProjectAccess(user: UserRow, id: string, manage = false): FinancialProject {
  const project = projectById(id), access = project && projectAccess(user, id);
  if (!project || !access || (manage && access !== "admin" && access !== "manager")) throw new ApiError(404, "Project not found");
  return project;
}

/** Validate both membership and lifecycle at the point of admission. An
 * archived scope or removed member makes an associated key unavailable; it is
 * never silently switched to personal billing. */
export function requireKeyProject(userId: string, id: string | null): { project: FinancialProject; costCenter: FinancialProject | null } | null {
  if (!id) return null;
  const project = projectById(id);
  if (!project || project.kind !== "project" || project.status !== "active" || !membership.get(id, userId)) throw new ApiError(403, "API key project is unavailable");
  const costCenter = project.cost_center_id ? projectById(project.cost_center_id) : null;
  if (project.cost_center_id && (!costCenter || costCenter.kind !== "cost_center" || costCenter.status !== "active")) throw new ApiError(403, "API key cost center is unavailable");
  return { project, costCenter };
}

export function validateProjectAssignment(userId: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 64) throw new ApiError(400, "Invalid projectId");
  requireKeyProject(userId, value);
  return value;
}

const counter = db.prepare<{ spent: string; reserved: string }, [string, string, number]>(
  `SELECT CAST(spent_nanos AS TEXT) AS spent, CAST(reserved_nanos AS TEXT) AS reserved
   FROM billing_periods WHERE scope = 'project' AND owner_id = ? AND kind = ? AND starts_at = ?`,
);

function budgetWindow(id: string, kind: "monthly" | "lifetime", limit: number | null, now: number, policy: FinancialPolicy) {
  const date = new Date(now);
  const start = kind === "monthly" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) : 0;
  const resetsAt = kind === "monthly" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) : null;
  const c = counter.get(id, kind, start);
  const spent = BigInt(c?.spent ?? 0), reserved = BigInt(c?.reserved ?? 0);
  const configured = limit !== null;
  if (policy.budgetPresentation === "hidden") return { kind, resetsAt };
  if (policy.budgetPresentation === "percent") {
    const usedPercent = limit === null ? null : limit === 0 ? 100 : Math.min(100, Number((spent + reserved) * 10_000n / BigInt(limit)) / 100);
    return { kind, resetsAt, limitConfigured: configured, usedPercent };
  }
  return { kind, resetsAt, limitConfigured: configured, limitUsd: limit === null ? null : limit / 1e9, spentUsd: Number(spent) / 1e9, reservedUsd: Number(reserved) / 1e9 };
}

export function projectDto(project: FinancialProject, user: UserRow, policy: FinancialPolicy, now = Date.now()) {
  const access = projectAccess(user, project.id);
  return {
    id: project.id, code: project.code, name: project.name, description: project.description, kind: project.kind,
    costCenterId: project.cost_center_id, responsibleUserId: project.responsible_user_id, status: project.status,
    membership: access === "admin" ? null : access, createdAt: project.created_at, updatedAt: project.updated_at,
    budgets: [budgetWindow(project.id, "monthly", project.monthly_nanos, now, policy), budgetWindow(project.id, "lifetime", project.total_nanos, now, policy)],
  };
}

