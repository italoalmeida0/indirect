import { db, stmts, audit, inImmediateTx } from "../db";
import { requireAdmin } from "../auth";
import { assignPlan } from "../billing";
import { assertSessionPolicy, corporateAuthConfig } from "../auth-policy";
import { randomToken, sha256Hex } from "../crypto";
import { ApiError, clientIp, hasControlCharacters, ok } from "../http";

const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 500;
const TTL = 30 * 60_000;
interface ImportRow {
  row: number; email: string; name: string; role: "admin" | "project_manager" | "user";
  planId: string | null; projectIds: string[]; managed: boolean; oidcSubject: string | null;
  status: "create" | "existing" | "error"; errors: string[];
}
interface ImportBatch { id: string; actor_id: string; input_hash: string; rows_json: string; created_at: number; expires_at: number; committed_at: number | null; result_json: string | null }
const fields = ["email", "name", "role", "planId", "projectIds", "managed", "oidcSubject"];

/** Stop reading as soon as the cap is crossed, including chunked requests. */
async function readImportBody(req: Request): Promise<Record<string, unknown>> {
  const maxEnvelope = MAX_BYTES * 2 + 4096;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) throw new ApiError(415, "content-type must be application/json");
  if (Number(req.headers.get("content-length")) > maxEnvelope) throw new ApiError(413, "import payload is too large");
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "import body is required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxEnvelope) { await reader.cancel(); throw new ApiError(413, "import payload is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new ApiError(400, "import body must be a JSON object"); }
}

/** RFC 4180 quoting, bounded rows and columns, no dependencies or regex backtracking. */
function parseCsv(content: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, endedQuote = false;
  const pushCell = () => { row.push(cell); cell = ""; endedQuote = false; if (row.length > fields.length) throw new ApiError(400, "CSV has too many columns"); };
  const pushRow = () => { pushCell(); if (row.some((value) => value !== "")) rows.push(row); row = []; if (rows.length > MAX_ROWS + 1) throw new ApiError(400, `import must contain at most ${MAX_ROWS} users`); };
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; endedQuote = true; }
      else cell += char;
      continue;
    }
    if (char === ",") { pushCell(); continue; }
    if (char === "\n" || char === "\r") { if (char === "\r" && content[i + 1] === "\n") i++; pushRow(); continue; }
    if (endedQuote) throw new ApiError(400, "invalid CSV text after a closing quote");
    if (char === '"') { if (cell) throw new ApiError(400, "invalid quote inside CSV field"); quoted = true; }
    else cell += char;
  }
  if (quoted) throw new ApiError(400, "unterminated quoted CSV field");
  if (cell || row.length || endedQuote) pushRow();
  const header = rows.shift()?.map((value) => value.trim());
  if (!header || !header.includes("email") || !header.includes("name") || new Set(header).size !== header.length || header.some((value) => !fields.includes(value))) throw new ApiError(400, `CSV headers must include email,name; optional headers: ${fields.slice(2).join(",")}`);
  return rows.map((values, index) => {
    if (values.length !== header.length) throw new ApiError(400, `CSV row ${index + 2} has ${values.length} fields; expected ${header.length}`);
    return Object.fromEntries(header.map((key, column) => [key, values[column]]));
  });
}

function validateRows(raw: unknown[], csv: boolean): ImportRow[] {
  if (!raw.length || raw.length > MAX_ROWS) throw new ApiError(400, `import must contain 1-${MAX_ROWS} users`);
  const seen = new Set<string>();
  const seenSubjects = new Set<string>();
  const config = corporateAuthConfig();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return raw.map((entry, index) => {
    const errors: string[] = [];
    const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    if (source !== entry) errors.push("row must be an object");
    if (Object.keys(source).some((key) => !fields.includes(key))) errors.push("unknown row field");
    const email = typeof source.email === "string" ? source.email.trim().toLowerCase() : "";
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (email.length > 254 || !emailPattern.test(email) || hasControlCharacters(email)) errors.push("email must be a valid address of at most 254 characters");
    if (!name || name.length > 128 || hasControlCharacters(name)) errors.push("name must contain 1-128 characters without control characters");
    const role = source.role === undefined || source.role === "" ? "user" : source.role;
    if (!["admin", "user", "project_manager"].includes(role as string)) errors.push("role must be user, project_manager, or admin");
    const planId = source.planId === undefined || source.planId === "" || source.planId === null ? null : source.planId;
    if (planId !== null && (typeof planId !== "string" || planId.length > 64 || !db.query("SELECT 1 FROM billing_plans WHERE id=?").get(planId))) errors.push("planId is not an existing billing plan");
    const projectValues = csv && typeof source.projectIds === "string" ? source.projectIds.split(";").map((value) => value.trim()).filter(Boolean) : source.projectIds ?? [];
    const projectIds: string[] = [];
    if (!Array.isArray(projectValues) || projectValues.length > 20 || projectValues.some((id) => typeof id !== "string" || !id || id.length > 64)) errors.push("projectIds must contain at most 20 project identifiers");
    else {
      for (const id of projectValues as string[]) {
        if (projectIds.includes(id)) { errors.push("projectIds contains a duplicate"); continue; }
        projectIds.push(id);
        if (!db.query("SELECT 1 FROM financial_projects WHERE id=? AND kind='project' AND status='active'").get(id)) errors.push(`project is unknown or archived: ${id}`);
      }
    }
    const managed = csv ? source.managed === "true" : source.managed === true;
    if (source.managed !== undefined && source.managed !== "" && (csv ? !["true", "false"].includes(source.managed as string) : typeof source.managed !== "boolean")) errors.push("managed must be a boolean (CSV: true or false)");
    const subject = source.oidcSubject === undefined || source.oidcSubject === "" || source.oidcSubject === null ? null : source.oidcSubject;
    if (subject !== null && (typeof subject !== "string" || subject.length > 255 || hasControlCharacters(subject))) errors.push("oidcSubject must be the provider's exact subject, up to 255 characters");
    if (subject && !config.enabled) errors.push("configure corporate authentication before importing OIDC subjects");
    if (typeof subject === "string") {
      if (seenSubjects.has(subject)) errors.push("duplicate oidcSubject within this import");
      seenSubjects.add(subject);
    }
    if (managed && config.requireManagedSso && !subject) errors.push("oidcSubject is required for new managed accounts while SSO is enforced");
    if (role === "project_manager" && projectIds.length === 0) errors.push("a project manager needs at least one project");
    if (seen.has(email)) errors.push("duplicate email within this import");
    seen.add(email);
    const existing = stmts.userByEmail.get(email);
    if (!existing && role === "admin" && config.requireAdminMfa) errors.push("import as a user, enroll an authenticator, then promote to administrator");
    if (!existing && typeof subject === "string" && config.enabled && db.query("SELECT 1 FROM corporate_identities WHERE issuer=? AND subject=?").get(config.issuer, subject)) errors.push("oidcSubject is already linked to another account");
    return {
      row: index + (csv ? 2 : 1), email, name, role: ["admin", "project_manager"].includes(role as string) ? role as ImportRow["role"] : "user",
      planId: typeof planId === "string" ? planId : null, projectIds, managed, oidcSubject: typeof subject === "string" ? subject : null,
      status: errors.length ? "error" : existing ? "existing" : "create", errors,
    };
  });
}

function batchDto(batch: ImportBatch) {
  const rows = JSON.parse(batch.rows_json) as ImportRow[];
  return { batchId: batch.id, expiresAt: batch.expires_at, valid: rows.every((row) => row.status !== "error"), rows, summary: { create: rows.filter((row) => row.status === "create").length, existing: rows.filter((row) => row.status === "existing").length, errors: rows.filter((row) => row.status === "error").length } };
}

export async function handleUserImportRoute(path: string, req: Request): Promise<Response | null> {
  if (path !== "/api/admin/users/import/preview" && path !== "/api/admin/users/import/commit") return null;
  const ctx = await requireAdmin(req);
  if (req.method !== "POST") return null;
  const body = await readImportBody(req);
  const requireLiveAdmin = () => {
    const fresh = stmts.userById.get(ctx.user.id), session = stmts.sessionByJti.get(ctx.session.jti);
    if (!fresh || fresh.role !== "admin" || fresh.status !== "active" || !session || session.revoked || session.expires_at <= Date.now() || session.abs_expires_at <= Date.now()) throw new ApiError(403, "administrator session is no longer available");
    assertSessionPolicy(fresh, session);
  };
  if (path.endsWith("/preview")) {
    if (Object.keys(body).some((key) => !["format", "content"].includes(key)) || !["csv", "json"].includes(body.format as string) || typeof body.content !== "string") throw new ApiError(400, "provide format (csv or json) and content (string)");
    if (Buffer.byteLength(body.content, "utf8") > MAX_BYTES) throw new ApiError(413, "import content exceeds 256 KiB");
    const hash = sha256Hex(`${body.format}:${body.content}`);
    let input: unknown;
    if (body.format === "csv") input = parseCsv(body.content.replace(/^\uFEFF/, ""));
    else { try { input = JSON.parse(body.content); } catch { throw new ApiError(400, "import content is not valid JSON"); } }
    if (!Array.isArray(input)) throw new ApiError(400, "JSON import must contain an array of users");
    const rows = validateRows(input, body.format === "csv");
    const batch = inImmediateTx(() => {
      requireLiveAdmin();
      // Preview persistence is bounded globally and per administrator. No unbounded
      // import queue or user creation happens while a preview is being inspected.
      db.prepare("DELETE FROM user_import_batches WHERE id IN (SELECT id FROM user_import_batches WHERE expires_at < ? AND committed_at IS NULL LIMIT 25)").run(Date.now());
      db.prepare("DELETE FROM user_import_batches WHERE id IN (SELECT id FROM user_import_batches WHERE committed_at < ? LIMIT 25)").run(Date.now() - 30 * 86_400_000);
      const prior = db.query<ImportBatch, [string, string, number]>("SELECT * FROM user_import_batches WHERE actor_id=? AND input_hash=? AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(ctx.user.id, hash, Date.now());
      if (prior) return prior;
      if (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user_import_batches").get()!.n >= 200 || db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM user_import_batches WHERE actor_id=? AND expires_at>? AND committed_at IS NULL").get(ctx.user.id, Date.now())!.n >= 5) throw new ApiError(429, "too many pending imports; wait for a preview to expire");
      const id = randomToken(24), now = Date.now();
      db.prepare("INSERT INTO user_import_batches(id,actor_id,input_hash,rows_json,created_at,expires_at) VALUES (?,?,?,?,?,?)").run(id, ctx.user.id, hash, JSON.stringify(rows), now, now + TTL);
      audit("users.import.previewed", { actorId: ctx.user.id, target: id, ip: clientIp(req), meta: { rows: rows.length, invalid: rows.filter((row) => row.errors.length).length } });
      return db.query<ImportBatch, [string]>("SELECT * FROM user_import_batches WHERE id=?").get(id)!;
    });
    const response = ok(batchDto(batch), req);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (Object.keys(body).some((key) => key !== "batchId") || typeof body.batchId !== "string" || !/^[a-f0-9]{48}$/.test(body.batchId)) throw new ApiError(400, "batchId must identify a valid preview");
  const result = inImmediateTx(() => {
    requireLiveAdmin();
    const batch = db.query<ImportBatch, [string, string]>("SELECT * FROM user_import_batches WHERE id=? AND actor_id=?").get(body.batchId as string, ctx.user.id);
    if (!batch) throw new ApiError(404, "import preview not found");
    if (batch.committed_at) return { ...JSON.parse(batch.result_json!) as Record<string, unknown>, replayed: true };
    if (batch.expires_at <= Date.now()) throw new ApiError(409, "import preview expired; preview the file again");
    const preview = JSON.parse(batch.rows_json) as ImportRow[];
    if (preview.some((row) => row.errors.length)) throw new ApiError(409, "fix every invalid row before committing the import");
    // Revalidate references and policy under the writer lock. A changed plan,
    // project or identity cannot leave half an import committed.
    const rows = validateRows(preview.map((row) => ({ email: row.email, name: row.name, role: row.role, planId: row.planId, projectIds: row.projectIds, managed: row.managed, oidcSubject: row.oidcSubject })), false);
    if (rows.some((row) => row.errors.length)) throw new ApiError(409, "an account, project, plan, or security policy changed; create a new preview");
    const config = corporateAuthConfig();
    let created = 0, existing = 0;
    const userIds: string[] = [];
    for (const row of rows) {
      const previous = stmts.userByEmail.get(row.email);
      if (previous) { existing++; userIds.push(previous.id); continue; }
      const id = randomToken(12), now = Date.now();
      db.prepare("INSERT INTO users(id,email,name,role,enterprise_role,status,created_at) VALUES (?,?,?,?,?,'active',?)").run(id, row.email, row.name, row.role === "admin" ? "admin" : "user", row.role === "project_manager" ? "project_manager" : null, now);
      assignPlan(id, row.planId);
      for (const project of row.projectIds) db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run(project, id, row.role === "project_manager" ? "manager" : "member", now);
      db.prepare("INSERT INTO corporate_account_policy(user_id,managed,sso_exempt) VALUES (?,?,0)").run(id, row.managed ? 1 : 0);
      if (row.oidcSubject) db.prepare("INSERT INTO corporate_identities(issuer,subject,user_id,created_at) VALUES (?,?,?,?)").run(config.issuer, row.oidcSubject, id, now);
      audit("user.imported", { actorId: ctx.user.id, target: id, ip: clientIp(req), meta: { batchId: batch.id, row: row.row, role: row.role, managed: row.managed, planId: row.planId, projectIds: row.projectIds } });
      created++; userIds.push(id);
    }
    const outcome = { created, existing, userIds };
    db.prepare("UPDATE user_import_batches SET committed_at=?,result_json=? WHERE id=?").run(Date.now(), JSON.stringify(outcome), batch.id);
    audit("users.import.committed", { actorId: ctx.user.id, target: batch.id, ip: clientIp(req), meta: { created, existing, rows: rows.length } });
    return { ...outcome, replayed: false };
  });
  const response = ok(result, req);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
