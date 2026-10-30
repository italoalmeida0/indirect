import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import path from "node:path";
import { hashPassword, jwtSign, randomToken, sha256Hex } from "../server/crypto";

/** Standalone HTTP/browser capacity fixtures. All identities and credentials
 * are generated locally; existing application data is never reused implicitly. */
const ROOT = path.resolve(import.meta.dir, "..");
const DAY = 86_400_000;
const VERSION = 1;
const MODELS = [
  { id: "enterprise-fast", share: 0.6 },
  { id: "enterprise-standard", share: 0.3 },
  { id: "enterprise-reasoning", share: 0.1 },
];
const PRICING = { input: 1000, cache: 100, output: 3000 };
const TOKENS = { input: 3000, cache: 12000, output: 1500 };
const COST = { input: TOKENS.input * PRICING.input, cache: TOKENS.cache * PRICING.cache, output: TOKENS.output * PRICING.output };

export interface EnterpriseScenario {
  users: number;
  days: number;
  requestsPerUserDay: number;
  rawDays: number;
  auditDays: number;
  auditPerUserDay: number;
  reservationDays: number;
}

export interface EnterpriseUser { id: string; email: string; keyId: string; key: string; jti: string; accessToken: string }
export interface EnterpriseFixture {
  version: number;
  complete: boolean;
  dir: string;
  seededAt: number;
  scenario: EnterpriseScenario;
  expectedRequests: number;
  admin: { id: string; email: string; password: string; jti: string; accessToken: string };
  users: EnterpriseUser[];
  secret: string;
  providerId: string;
  providerKeyId: string;
  upstreamSecret: string;
  schemaVersion: number;
}

export interface EnterpriseStack {
  base: string;
  fixture: EnterpriseFixture;
  stop: () => Promise<void>;
  setUpstreamDelay: (ms: number) => void;
  upstreamHits: () => number;
  upstreamDuration: (sampleId: string) => number | undefined;
}

export function enterpriseDefaults(full = false): EnterpriseScenario {
  const now = new Date(), start = new Date(now); start.setUTCFullYear(start.getUTCFullYear() - 10);
  const days = Math.ceil((now.getTime() - start.getTime()) / DAY) + 1;
  return { users: 500, days, requestsPerUserDay: 500, rawDays: full ? 90 : 2,
    auditDays: 365, auditPerUserDay: 6, reservationDays: full ? 30 : 2 };
}

function assertScenario(scenario: EnterpriseScenario): void {
  for (const [name, value] of Object.entries(scenario)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (scenario.users > 10_000 || scenario.days > 36_525 || scenario.requestsPerUserDay > 10_000) throw new Error("Fixture scenario exceeds safety bounds");
  if (scenario.rawDays > scenario.days || scenario.auditDays > scenario.days || scenario.reservationDays > scenario.days) throw new Error("Retention cannot exceed fixture history");
}

export function fixturePath(dir: string): string { return path.join(dir, "enterprise-fixture.json"); }

export function loadEnterpriseFixture(dir: string): EnterpriseFixture {
  const fixture = JSON.parse(readFileSync(fixturePath(dir), "utf8")) as EnterpriseFixture;
  if (fixture.version !== VERSION || !fixture.complete || path.resolve(fixture.dir) !== path.resolve(dir)) throw new Error("Not a completed enterprise test fixture");
  assertScenario(fixture.scenario);
  return fixture;
}

function saveFixture(fixture: EnterpriseFixture): void {
  writeFileSync(fixturePath(fixture.dir), JSON.stringify(fixture, null, 2), { mode: 0o600 });
}

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ready") });
  const port = server.port!; server.stop(true); return port;
}

function gatewayEnv(dir: string, secret: string, port: number): Record<string, string | undefined> {
  return { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dir,
    STATIC_DIR: path.join(ROOT, "dist"), PUBLIC_URL: `http://127.0.0.1:${port}`,
    INDIRECT_SECRET: secret, GATEWAY_SECRET: secret,
    ADMIN_EMAIL: "enterprise-admin@example.test", ADMIN_PASSWORD: "enterprise-fixture-password-12345",
    SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", GOOGLE_CLIENT_ID: "", TRUST_PROXY: "false", TRUSTED_PROXY_CIDRS: "",
    BUN_CONFIG_MAX_HTTP_REQUESTS: "2048" };
}

async function bootGateway(dir: string, secret: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const port = freePort(), base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "server/index.ts"], { cwd: ROOT, env: gatewayEnv(dir, secret, port),
    stdout: Bun.file(path.join(dir, "gateway.stdout.log")), stderr: Bun.file(path.join(dir, "gateway.stderr.log")) });
  const stop = async () => { if (child.exitCode === null) child.kill(); await child.exited; };
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}; inspect fixture gateway.stderr.log`);
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("Gateway startup timed out");
      await Bun.sleep(100);
    }
    return { base, stop };
  } catch (error) { await stop(); throw error; }
}

export async function enterpriseRequest(base: string, route: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${base}${route}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
  const text = await response.text(); let json: any;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text, headers: response.headers };
}

function startUpstream(secret: string) {
  let delay = 20, hits = 0;
  const durations = new Map<string, number>();
  const encoder = new TextEncoder();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 60, async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${secret}` && req.headers.get("x-api-key") !== secret) return Response.json({ error: "unauthorized fixture request" }, { status: 401 });
    const start = performance.now(), url = new URL(req.url);
    if (url.pathname.endsWith("/models")) return Response.json({ data: MODELS.map((model) => ({ id: model.id, context_length: 131072,
      top_provider: { max_completion_tokens: 4096 }, pricing: { prompt: "0.000001", input_cache_reads: "0.0000001", completion: "0.000003" } })) });
    const body = await req.json() as any; hits++;
    const remember = () => {
      if (typeof body.__enterpriseSampleId !== "string") return;
      durations.set(body.__enterpriseSampleId, performance.now() - start);
      if (durations.size > 4096) durations.delete(durations.keys().next().value!);
    };
    if (delay) await Bun.sleep(delay);
    const elapsed = performance.now() - start;
    const headers = { "x-enterprise-upstream-ms": elapsed.toFixed(3) };
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
    if (body.stream) {
      let cancelled = false;
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "enterprise-stream", model: body.model, choices: [{ delta: { content: "fixture" }, finish_reason: null }] })}\n\n`));
        await Bun.sleep(60);
        if (cancelled) { remember(); return; }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "enterprise-stream", model: body.model, choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`));
        remember();
        controller.close();
      }, cancel() { cancelled = true; remember(); } }), { headers: { ...headers, "content-type": "text/event-stream" } });
    }
    const response = Response.json({ id: "enterprise-response", model: body.model, choices: [{ message: { role: "assistant", content: "Enterprise fixture response." }, finish_reason: "stop" }], usage }, { headers });
    remember();
    return response;
  } });
  return { server, setDelay: (ms: number) => { delay = ms; }, hits: () => hits,
    durationFor: (id: string) => { const value = durations.get(id); durations.delete(id); return value; } };
}

async function signFixtureSessions(fixture: EnterpriseFixture): Promise<void> {
  fixture.admin.accessToken = await jwtSign({ sub: fixture.admin.id, jti: fixture.admin.jti, role: "admin", type: "access" }, fixture.secret, 12 * 3600);
  for (const user of fixture.users) user.accessToken = await jwtSign({ sub: user.id, jti: user.jti, role: "user", type: "access" }, fixture.secret, 12 * 3600);
}

export async function createEnterpriseFixture(scenario: EnterpriseScenario, requestedDir?: string): Promise<EnterpriseFixture> {
  assertScenario(scenario);
  const dir = path.resolve(requestedDir ?? path.join(tmpdir(), `indirect-enterprise-${randomToken(8)}`));
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`Refusing to overwrite nonempty fixture directory: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const now = Date.now(), secret = randomToken(48), upstreamSecret = `fixture_${randomToken(24)}`;
  const upstream = startUpstream(upstreamSecret), boot = await bootGateway(dir, secret);
  let fixture: EnterpriseFixture;
  try {
    const login = await enterpriseRequest(boot.base, "/api/auth/login", "", { email: "enterprise-admin@example.test", password: "enterprise-fixture-password-12345" });
    if (login.status !== 200) throw new Error(`Fixture administrator login failed: ${login.status}`);
    const provider = await enterpriseRequest(boot.base, "/api/admin/providers", login.json.accessToken, {
      name: "Enterprise fixture provider", openaiBaseUrl: `http://127.0.0.1:${upstream.server.port}/v1`, apiKey: upstreamSecret });
    if (provider.status !== 200) throw new Error(`Fixture provider creation failed: ${provider.status}`);
    const sync = await enterpriseRequest(boot.base, `/api/admin/providers/${provider.json.provider.id}/sync-models`, login.json.accessToken, {});
    if (sync.status !== 200) throw new Error(`Fixture model synchronization failed: ${sync.status}`);
    const settings = await enterpriseRequest(boot.base, "/api/admin/settings", login.json.accessToken, { routingMode: "router" }, "PATCH");
    if (settings.status !== 200) throw new Error(`Fixture router setup failed: ${settings.status}`);
    fixture = { version: VERSION, complete: false, dir, seededAt: now, scenario, expectedRequests: scenario.users * scenario.days * scenario.requestsPerUserDay,
      admin: { id: login.json.user.id, email: "enterprise-admin@example.test", password: "enterprise-fixture-password-12345", jti: `enterprise-admin-${randomToken(12)}`, accessToken: "" },
      users: [], secret, providerId: provider.json.provider.id, providerKeyId: "", upstreamSecret, schemaVersion: 0 };
    saveFixture(fixture);
  } finally { await boot.stop(); upstream.server.stop(true); }

  const db = new Database(path.join(dir, "gateway.db"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA cache_size=-131072");
  try {
    fixture.providerKeyId = (db.query<{ id: string }, [string]>("SELECT id FROM provider_keys WHERE provider_id=? ORDER BY priority LIMIT 1").get(fixture.providerId)!).id;
    fixture.schemaVersion = Object.values(db.query("PRAGMA user_version").get()!)[0] as number;
    const hash = await hashPassword("enterprise-fixture-password-12345");
    const userInsert = db.prepare("INSERT INTO users(id,email,name,role,password_hash,status,created_at) VALUES(?,?,?,'user',?,'active',?)");
    const keyInsert = db.prepare("INSERT INTO api_keys(id,user_id,name,prefix,hash,created_at,status) VALUES(?,?,'Enterprise fixture','gw_fixture',?,?,'active')");
    const sessionInsert = db.prepare("INSERT INTO sessions(jti,user_id,refresh_hash,created_at,last_used_at,expires_at,abs_expires_at,revoked,family) VALUES(?,?,?,?,?,?,?,0,?)");
    db.exec("CREATE TEMP TABLE seed_users(i INTEGER PRIMARY KEY,id TEXT,key_id TEXT); CREATE TEMP TABLE seed_days(i INTEGER PRIMARY KEY,date TEXT,month TEXT,ts INTEGER,duration INTEGER); CREATE TEMP TABLE seed_models(model TEXT PRIMARY KEY,reqs INTEGER)");
    const seedUser = db.prepare("INSERT INTO seed_users VALUES(?,?,?)"), seedDay = db.prepare("INSERT INTO seed_days VALUES(?,?,?,?,?)"), seedModel = db.prepare("INSERT INTO seed_models VALUES(?,?)");
    const dayStart = Math.floor(now / DAY) * DAY;
    db.transaction(() => {
      for (let i = 0; i < scenario.users; i++) {
        const id = randomToken(12), keyId = randomToken(12), key = `gw_${randomToken(24)}`, jti = `enterprise-${randomToken(16)}`;
        const user: EnterpriseUser = { id, email: `enterprise-${i}@example.test`, keyId, key, jti, accessToken: "" };
        userInsert.run(id, user.email, `Employee ${i + 1}`, hash, now - scenario.days * DAY);
        keyInsert.run(keyId, id, sha256Hex(key), now - scenario.days * DAY);
        sessionInsert.run(jti, id, sha256Hex(randomToken(32)), now, now, now + 30 * DAY, now + 180 * DAY, jti);
        seedUser.run(i, id, keyId); fixture.users.push(user);
      }
      sessionInsert.run(fixture.admin.jti, fixture.admin.id, sha256Hex(randomToken(32)), now, now, now + 30 * DAY, now + 180 * DAY, fixture.admin.jti);
      for (let i = 0; i < scenario.days; i++) {
        const ts = dayStart - i * DAY, date = new Date(ts).toISOString().slice(0, 10);
        seedDay.run(i, date, date.slice(0, 7), ts, i === 0 ? Math.max(1, now - ts) : DAY);
      }
      let remaining = scenario.requestsPerUserDay;
      for (let i = 0; i < MODELS.length; i++) {
        const count = i === MODELS.length - 1 ? remaining : Math.floor(scenario.requestsPerUserDay * MODELS[i]!.share);
        seedModel.run(MODELS[i]!.id, count); remaining -= count;
      }
    })();
    const metrics = `${TOKENS.input}*m.reqs,${TOKENS.cache}*m.reqs,${TOKENS.output}*m.reqs,m.reqs,${COST.input}*m.reqs,${COST.cache}*m.reqs,${COST.output}*m.reqs`;
    const commonColumns = "key_id,user_id,date,proto,model,in_tok,cache_tok,out_tok,reqs,cost_in_nanos,cost_cache_nanos,cost_out_nanos";
    const providerInsert = db.prepare(`INSERT INTO usage_model_provider_daily(${commonColumns},provider_id,provider_key_id,upstream_model,success_reqs,error_reqs)
      SELECT u.key_id,u.id,d.date,'openai',m.model,${metrics},?,?,m.model,m.reqs,0
      FROM seed_users u CROSS JOIN seed_days d CROSS JOIN seed_models m WHERE d.i>=? AND d.i<?`);
    for (let first = 0; first < scenario.days; first += 90) {
      const end = Math.min(first + 90, scenario.days);
      db.transaction(() => providerInsert.run(fixture.providerId, fixture.providerKeyId, first, end))();
      console.log(JSON.stringify({ phase: "daily-history", completedDays: end, days: scenario.days }));
    }
    db.exec(`INSERT INTO usage_model_daily(${commonColumns}) SELECT ${commonColumns} FROM usage_model_provider_daily`);
    db.exec(`INSERT INTO usage_daily(key_id,user_id,date,in_tok,cache_tok,out_tok,reqs)
      SELECT key_id,user_id,date,SUM(in_tok),SUM(cache_tok),SUM(out_tok),SUM(reqs) FROM usage_model_provider_daily GROUP BY key_id,date`);
    db.exec(`INSERT INTO usage_model_provider_monthly(key_id,user_id,month,proto,provider_id,provider_key_id,model,upstream_model,in_tok,cache_tok,out_tok,reqs,success_reqs,error_reqs,cost_in_nanos,cost_cache_nanos,cost_out_nanos)
      SELECT key_id,user_id,substr(date,1,7),proto,provider_id,provider_key_id,model,upstream_model,SUM(in_tok),SUM(cache_tok),SUM(out_tok),SUM(reqs),SUM(success_reqs),SUM(error_reqs),SUM(cost_in_nanos),SUM(cost_cache_nanos),SUM(cost_out_nanos)
      FROM usage_model_provider_daily GROUP BY key_id,substr(date,1,7),proto,provider_id,provider_key_id,model,upstream_model`);
    console.log(JSON.stringify({ phase: "aggregate-history-complete", representedRequests: fixture.expectedRequests }));

    db.exec("CREATE TEMP TABLE seed_calls(i INTEGER PRIMARY KEY)");
    const callInsert = db.prepare("INSERT INTO seed_calls VALUES(?)");
    db.transaction(() => { for (let i = 0; i < scenario.requestsPerUserDay; i++) callInsert.run(i); })();
    const firstShare = Math.floor(scenario.requestsPerUserDay * MODELS[0]!.share), secondShare = firstShare + Math.floor(scenario.requestsPerUserDay * MODELS[1]!.share);
    const modelForCall = `CASE WHEN c.i<${firstShare} THEN '${MODELS[0]!.id}' WHEN c.i<${secondShare} THEN '${MODELS[1]!.id}' ELSE '${MODELS[2]!.id}' END`;
    const timestamp = `d.ts+CAST((c.i+0.5)*d.duration/${scenario.requestsPerUserDay} AS INTEGER)`;
    const rawInsert = db.prepare(`INSERT INTO usage_events(key_id,user_id,ts,proto,model,in_tok,cache_tok,out_tok,latency_ms,status,stream,estimated,provider_id,provider_key_id,upstream_model,cost_in_nanos,cost_cache_nanos,cost_out_nanos)
      SELECT u.key_id,u.id,${timestamp},'openai',${modelForCall},${TOKENS.input},${TOKENS.cache},${TOKENS.output},1500,200,c.i%2,0,?,?,${modelForCall},${COST.input},${COST.cache},${COST.output}
      FROM seed_days d CROSS JOIN seed_users u CROSS JOIN seed_calls c WHERE d.i=?`);
    for (let day = scenario.rawDays - 1; day >= 0; day--) {
      db.transaction(() => rawInsert.run(fixture.providerId, fixture.providerKeyId, day))();
      console.log(JSON.stringify({ phase: "raw-history", completedDays: scenario.rawDays - day, days: scenario.rawDays }));
    }
    // Settled reservations have the same retained cardinality as real traffic.
    const reservationInsert = db.prepare(`INSERT INTO billing_reservations(id,instance_id,key_id,user_id,created_at,settled_at,amount_nanos,periods,pricing,cost_in_nanos,cost_cache_nanos,cost_out_nanos,state)
      SELECT printf('fixture-%d-%d-%d',d.i,u.i,c.i),'fixture',u.key_id,u.id,${timestamp},${timestamp},${COST.input + COST.cache + COST.output},'[]','{}',${COST.input},${COST.cache},${COST.output},'settled'
      FROM seed_days d CROSS JOIN seed_users u CROSS JOIN seed_calls c WHERE d.i=?`);
    for (let day = scenario.reservationDays - 1; day >= 0; day--) {
      db.transaction(() => reservationInsert.run(day))();
      console.log(JSON.stringify({ phase: "settled-reservations", completedDays: scenario.reservationDays - day, days: scenario.reservationDays }));
    }
    db.exec("CREATE TEMP TABLE seed_actions(i INTEGER PRIMARY KEY)");
    const actionInsert = db.prepare("INSERT INTO seed_actions VALUES(?)");
    db.transaction(() => { for (let i = 0; i < scenario.auditPerUserDay; i++) actionInsert.run(i); })();
    db.prepare(`INSERT INTO audit_log(ts,actor_id,action,target,meta,ip)
      SELECT d.ts+CAST((a.i+0.5)*d.duration/? AS INTEGER),u.id,
      CASE a.i%3 WHEN 0 THEN 'login.success' WHEN 1 THEN 'key.updated' ELSE 'profile.updated' END,
      u.id,'{"source":"enterprise-fixture"}','192.0.2.10'
      FROM seed_days d CROSS JOIN seed_users u CROSS JOIN seed_actions a WHERE d.i<?`).run(scenario.auditPerUserDay, scenario.auditDays);
    // Frozen balances are distinct from raw retention, exactly as in production.
    const totalCost = "SUM(cost_in_nanos+cost_cache_nanos+cost_out_nanos)";
    db.exec(`INSERT INTO billing_periods(scope,owner_id,kind,starts_at,ends_at,spent_nanos)
      SELECT 'key',key_id,'lifetime',0,8640000000000000,${totalCost} FROM usage_model_provider_daily GROUP BY key_id`);
    db.prepare(`INSERT INTO billing_periods(scope,owner_id,kind,starts_at,ends_at,spent_nanos)
      SELECT 'key',key_id,'daily',?,?,${totalCost} FROM usage_model_provider_daily WHERE date=? GROUP BY key_id`).run(dayStart, dayStart + DAY, new Date(dayStart).toISOString().slice(0, 10));
    const currentMonth = new Date(now), monthStart = Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1), monthEnd = Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + 1, 1);
    db.prepare(`INSERT INTO billing_periods(scope,owner_id,kind,starts_at,ends_at,spent_nanos)
      SELECT 'user',user_id,'monthly',?,?,${totalCost} FROM usage_model_provider_monthly WHERE month=? GROUP BY user_id`).run(monthStart, monthEnd, new Date(now).toISOString().slice(0, 7));
    const monthRows = db.query<{ n: number }, []>("SELECT SUM(reqs) AS n FROM usage_model_provider_monthly").get()!.n;
    const rawRows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_events").get()!.n;
    if (monthRows !== fixture.expectedRequests || rawRows !== scenario.users * scenario.requestsPerUserDay * scenario.rawDays) throw new Error("Fixture cardinality verification failed");
    // A real installation of this size already has planner statistics; a
    // fixture seeded outside the gateway would otherwise measure degenerate
    // plans (and boot would refuse to analyze it, see server/db.ts). Build them
    // with a bounded per-index sample so seeding stays deterministic.
    db.exec("PRAGMA analysis_limit = 400");
    db.exec("PRAGMA optimize");
    console.log(JSON.stringify({ phase: "planner-statistics", statisticsRows: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_stat1").get()?.n ?? 0 }));
    await signFixtureSessions(fixture);
    fixture.complete = true; saveFixture(fixture);
    console.log(JSON.stringify({ phase: "fixture-complete", dir, rawRows, historicalRequests: monthRows, bytes: statSync(path.join(dir, "gateway.db")).size }));
  } finally { db.close(); }
  return fixture;
}

export async function startEnterpriseStack(fixture: EnterpriseFixture): Promise<EnterpriseStack> {
  const db = new Database(path.join(fixture.dir, "gateway.db"));
  try {
    const now = Date.now();
    db.prepare("UPDATE sessions SET created_at=?,last_used_at=?,expires_at=?,abs_expires_at=?,revoked=0 WHERE jti LIKE 'enterprise-%'").run(now, now, now + 30 * DAY, now + 180 * DAY);
  } finally { db.close(); }
  await signFixtureSessions(fixture); saveFixture(fixture);
  const upstream = startUpstream(fixture.upstreamSecret), gateway = await bootGateway(fixture.dir, fixture.secret);
  try {
    const changed = await enterpriseRequest(gateway.base, `/api/admin/providers/${fixture.providerId}`, fixture.admin.accessToken,
      { openaiBaseUrl: `http://127.0.0.1:${upstream.server.port}/v1` }, "PATCH");
    if (changed.status !== 200) throw new Error(`Cannot bind fixture upstream: ${changed.status}`);
    return { base: gateway.base, fixture, setUpstreamDelay: upstream.setDelay, upstreamHits: upstream.hits, upstreamDuration: upstream.durationFor,
      stop: async () => { await gateway.stop(); upstream.server.stop(true); } };
  } catch (error) { await gateway.stop(); upstream.server.stop(true); throw error; }
}

export function enterpriseMachine() {
  return { platform: process.platform, arch: process.arch, bun: Bun.version, cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryBytes: totalmem(), productionDurability: "unchanged" };
}
