import { requireAuth } from "../auth";
import { readUsd } from "../billing";
import { LIMITS } from "../config";
import { audit, db, inImmediateTx, type UserRow } from "../db";
import { financialPolicyFor } from "../financial-policy";
import { likeEscape } from "../gridql";
import { ApiError, clientIp, ok, readJsonBody, v } from "../http";
import { projectAccess, projectById, projectDto, requireProjectAccess, type FinancialProject } from "../projects";
import { readUsage } from "../usage-reader";
import { requireLiveActor } from "../live-auth";

function responsible(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !db.query("SELECT id FROM users WHERE id = ? AND status = 'active'").get(value)) throw new ApiError(400, "Unknown active responsible user");
  return value;
}

function center(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const row = typeof value === "string" ? projectById(value) : null;
  if (!row || row.kind !== "cost_center" || row.status !== "active") throw new ApiError(400, "Unknown active cost center");
  return row.id;
}

function code(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new ApiError(400, "code must contain 1–64 letters, numbers, dots, dashes or underscores");
  return value;
}

function validateDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, "Invalid date range");
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new ApiError(400, "Invalid date range");
  return ms;
}
const dateString = (time: number) => new Date(time).toISOString().slice(0, 10);
export async function handleProjectsRoute(path: string, req: Request): Promise<Response | null> {
  if (path !== "/api/projects" && !path.startsWith("/api/projects/")) return null;
  const ctx = await requireAuth(req), policy = financialPolicyFor(ctx.user), ip = clientIp(req);
  const admin = ctx.user.role === "admin";
  if (path === "/api/projects" && req.method === "GET") {
    const rows = admin
      ? db.query<FinancialProject, []>("SELECT * FROM financial_projects ORDER BY name, id LIMIT 1000").all()
      : db.query<FinancialProject, [string]>("SELECT p.* FROM financial_projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.name, p.id LIMIT 1000").all(ctx.user.id);
    return ok({ projects: rows.map((p) => projectDto(p, ctx.user, policy)), financialPolicy: policy }, req);
  }
  if (path === "/api/projects" && req.method === "POST") {
    if (!admin) throw new ApiError(403, "admin only");
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const kind = body.kind === "project" || body.kind === "cost_center" ? body.kind : null;
    if (!kind) throw new ApiError(400, "Invalid project kind");
    const name = v.str(body, "name", { min: 1, max: 128 })!, projectCode = code(body.code);
    const description = v.str(body, "description", { max: 2000, optional: true }) ?? "";
    const costCenterId = center(body.costCenterId), responsibleUserId = responsible(body.responsibleUserId);
    if (kind === "cost_center" && costCenterId) throw new ApiError(400, "A cost center cannot have a parent");
    const monthly = readUsd(body, "monthlyLimitUsd"), total = readUsd(body, "totalLimitUsd");
    const id = `fp_${crypto.randomUUID().replace(/-/g, "")}`, now = Date.now();
    inImmediateTx(() => {
      if (requireLiveActor(ctx).role !== "admin") throw new ApiError(403, "admin only");
      if (db.query("SELECT id FROM financial_projects WHERE code = ?").get(projectCode)) throw new ApiError(409, "Project code already exists");
      if (costCenterId) center(costCenterId);
      if (responsibleUserId) responsible(responsibleUserId);
      db.prepare(`INSERT INTO financial_projects(id, kind, code, name, description, cost_center_id, responsible_user_id, monthly_nanos, total_nanos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, kind, projectCode, name, description, costCenterId, responsibleUserId, monthly, total, now, now);
      audit("project.created", { actorId: ctx.user.id, target: id, ip, meta: { kind, code: projectCode, name, costCenterId, responsibleUserId, monthlyLimitUsd: monthly === null ? null : monthly / 1e9, totalLimitUsd: total === null ? null : total / 1e9 } });
    });
    return ok({ project: projectDto(projectById(id)!, ctx.user, policy) }, req);
  }
  const match = path.match(/^\/api\/projects\/(fp_[a-f0-9]{32})(?:\/(members|member-candidates|usage)(?:\/([a-f0-9]{24}))?)?$/);
  if (!match) return null;
  const id = match[1]!, action = match[2], target = match[3];
  const project = requireProjectAccess(ctx.user, id, !!action);
  if (!action && req.method === "GET") return ok({ project: projectDto(project, ctx.user, policy), financialPolicy: policy }, req);
  if (!action && req.method === "PATCH") {
    if (!admin) throw new ApiError(403, "admin only");
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    inImmediateTx(() => {
      if (requireLiveActor(ctx).role !== "admin") throw new ApiError(403, "admin only");
      const current = projectById(id)!;
      const projectCode = "code" in body ? code(body.code) : current.code;
      if (db.query("SELECT id FROM financial_projects WHERE code = ? AND id <> ?").get(projectCode, id)) throw new ApiError(409, "Project code already exists");
      const name = v.str(body, "name", { min: 1, max: 128, optional: true }) ?? current.name;
      const description = v.str(body, "description", { max: 2000, optional: true }) ?? current.description;
      const parent = "costCenterId" in body ? center(body.costCenterId) : current.cost_center_id;
      if (current.kind === "cost_center" && parent) throw new ApiError(400, "A cost center cannot have a parent");
      const owner = "responsibleUserId" in body ? responsible(body.responsibleUserId) : current.responsible_user_id;
      const status = "status" in body ? body.status : current.status;
      if (status !== "active" && status !== "archived") throw new ApiError(400, "Invalid project status");
      const monthly = "monthlyLimitUsd" in body ? readUsd(body, "monthlyLimitUsd") : current.monthly_nanos;
      const total = "totalLimitUsd" in body ? readUsd(body, "totalLimitUsd") : current.total_nanos;
      db.prepare(`UPDATE financial_projects SET code=?, name=?, description=?, cost_center_id=?, responsible_user_id=?, status=?, monthly_nanos=?, total_nanos=?, updated_at=? WHERE id=?`)
        .run(projectCode, name, description, parent, owner, status, monthly, total, Date.now(), id);
      audit("project.updated", { actorId: ctx.user.id, target: id, ip, meta: { code: projectCode, name, costCenterId: parent, responsibleUserId: owner, status, monthlyLimitUsd: monthly === null ? null : monthly / 1e9, totalLimitUsd: total === null ? null : total / 1e9 } });
    });
    return ok({ project: projectDto(projectById(id)!, ctx.user, policy) }, req);
  }
  if (action === "members" && !target && req.method === "GET") {
    const rows = db.query<{ user_id: string; email: string; name: string; role: string }, [string]>(`SELECT m.user_id, u.email, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.email LIMIT 1000`).all(id);
    return ok({ members: rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role })) }, req);
  }
  if (action === "member-candidates" && !target && req.method === "GET") {
    const query = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (query.length < 2 || query.length > 80) throw new ApiError(400, "Search must contain 2–80 characters");
    const pattern = `%${likeEscape(query)}%`;
    const users = db.query<{ id: string; email: string; name: string }, [string, string, string]>(`SELECT u.id, u.email, u.name FROM users u WHERE u.status = 'active' AND (u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\') AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ? AND m.user_id = u.id) ORDER BY u.email LIMIT 20`).all(pattern, pattern, id);
    return ok({ users }, req);
  }
  if (action === "members" && target && (req.method === "PUT" || req.method === "DELETE")) {
    const body = req.method === "PUT" ? await readJsonBody(req, LIMITS.apiBodyBytes) : null;
    const rawRole = body?.role;
    if (body && rawRole !== "member" && rawRole !== "manager") throw new ApiError(400, "Invalid membership role");
    const role = rawRole as "member" | "manager" | undefined;
    inImmediateTx(() => {
      const actor = requireLiveActor(ctx);
      const access = projectAccess(actor, id);
      if (access !== "admin" && access !== "manager") throw new ApiError(404, "Project not found");
      const member = db.query<{ role: string }, [string, string]>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(id, target);
      if (access !== "admin" && (role === "manager" || member?.role === "manager")) throw new ApiError(403, "Only administrators manage managers");
      const user = db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ? AND status = 'active'").get(target);
      if (req.method === "PUT") {
        if (!user) throw new ApiError(404, "User not found");
        if (role === "manager" && user.role !== "admin" && user.enterprise_role !== "project_manager") throw new ApiError(400, "User must have the project_manager role");
        db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES(?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role").run(id, target, role!, Date.now());
      } else {
        if (!member) throw new ApiError(404, "Member not found");
        db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, target);
      }
      audit(req.method === "PUT" ? "project.member_set" : "project.member_removed", { actorId: ctx.user.id, target: id, ip, meta: { userId: target, role: role ?? null } });
    });
    return ok({ done: true }, req);
  }
  if (action === "usage" && !target && req.method === "GET") {
    const params = new URL(req.url).searchParams;
    const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const from = params.has("from") ? validateDate(params.get("from")!) : today - 29 * 86_400_000;
    const to = params.has("to") ? validateDate(params.get("to")!) : today;
    if (to < from || to - from > 50 * 366 * 86_400_000) throw new ApiError(400, "Invalid date range");
    const toExclusive = to + 86_400_000;
    const usage = await readUsage({ kind: "financial-project", userId: null, scope: { from, to: toExclusive, selection: {} }, projectId: id, projectKind: project.kind, from, toExclusive, includeCost: policy.budgetPresentation === "usd" }, req.signal);
    return ok({ usage, from: dateString(from), to: dateString(to), financialPolicy: policy }, req);
  }
  return null;
}
