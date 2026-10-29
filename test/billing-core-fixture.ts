import assert from "node:assert/strict";
import { db, type ModelRow } from "../server/db";
import { createKey } from "../server/keys";
import { assignPlan, billingStatus, cancelBudget, grantReset, recoverBudgets, redeemReset, reserveBudget, settleBudget, startBilling } from "../server/billing";

const now = Date.now(), user = "core-user";
db.run("INSERT INTO users(id,email,created_at) VALUES (?, ?, ?)", [user, "core@example.com", now]);
db.run("INSERT INTO billing_plans(id,name,monthly_nanos,weekly_enabled,session_enabled,created_at,updated_at) VALUES ('core-plan','Core',100000000000,1,1,?,?)", [now, now]);
db.run("INSERT INTO models(id,upstream_model,created_at,updated_at,context_length,max_output_length,pricing_input,pricing_output) VALUES ('core-model','core-model',?,?,100000,1000,.000001,.000003)", [now, now]);
const model = db.query<ModelRow, []>("SELECT * FROM models WHERE id = 'core-model'").get()!;
const key = (await createKey(user, { name: "Core" })).row;
assignPlan(user, "core-plan");
const reserve = (time = now, metadata = model) => reserveBudget(key, metadata, { max_tokens: 64 }, 100, false, true, time);
const charge = (id: string) => settleBudget(id, { inTok: 100, cacheTok: 0, outTok: 10 });
const window = (kind: string, time = now) => billingStatus(user, time).windows.find((entry) => entry.kind === kind)!;
const near = (a: number | null, b: number) => assert(Math.abs(a! - b) <= 1e-9, `${a} != ${b}`);

// Calendar arithmetic includes leap years, exact boundaries and a week
// spanning two monthly cycles. A request belongs to its admission windows.
const leap = Date.UTC(2024, 1, 29, 23, 59);
const pending = reserve(leap);
near(window("weekly", leap).limitUsd, 100 * 7 / 29);
near(window("session", leap).limitUsd, 100 * 5 / (29 * 24));
assert.equal(window("monthly", leap).resetsAt, Date.UTC(2024, 2, 1));
assert.equal(window("session", leap).resetsAt, leap + 5 * 3600000);
charge(pending);
near(window("monthly", leap).spentUsd, .00013);
assert.equal(window("monthly", Date.UTC(2024, 2, 1)).spentUsd, 0);
near(window("weekly", Date.UTC(2024, 2, 1)).spentUsd, .00013);
near(window("weekly", Date.UTC(2024, 2, 1)).limitUsd, 100 * 7 / 31);
const expired = leap + 5 * 3600000;
assert.equal(billingStatus(user, expired).sessionStarted, false);
const next = reserve(expired); assert.equal(window("session", expired).startsAt, expired); cancelBudget(next);

// Rejected admission rolls the session start and newly-created periods back.
db.run("UPDATE user_billing SET session_start = NULL WHERE user_id = ?", [user]);
const current = reserve(); charge(current);
db.run("UPDATE user_billing SET session_start = NULL WHERE user_id = ?", [user]);
db.run("UPDATE billing_periods SET spent_nanos = 100000000000 WHERE scope = 'user' AND owner_id = ? AND kind = 'monthly' AND starts_at = ?", [user, window("monthly").startsAt]);
assert.throws(() => reserve(), /monthly budget/);
assert.equal(db.query<any, [string]>("SELECT session_start FROM user_billing WHERE user_id = ?").get(user)!.session_start, null);
db.run("UPDATE billing_periods SET spent_nanos = 0, forgiven_nanos = 0 WHERE owner_id IN (?,?)", [user, key.id]);

// A reset forgives settled short-window spend while retaining every hold.
const first = reserve(); charge(first);
const second = reserve();
const monthlyBefore = window("monthly").spentUsd, endBefore = window("session").resetsAt;
const grant = grantReset(user, "session", 1, null, "Test", user, "test");
redeemReset(user, grant, "idempotency-reset-test", "test");
assert.equal(window("session").spentUsd, 0); assert(window("session").reservedUsd > 0);
assert.equal(window("monthly").spentUsd, monthlyBefore); assert.equal(window("session").resetsAt, endBefore);
charge(second); near(window("session").spentUsd, .00013); near(window("monthly").spentUsd, .00026);
const after = window("monthly").spentUsd;
charge(second); cancelBudget(second); assert.equal(window("monthly").spentUsd, after); assert.equal(window("monthly").reservedUsd, 0);

// Reassigning a plan or toggling the short windows never clears spend.
assignPlan(user, null); assignPlan(user, "core-plan"); assert.equal(window("monthly").spentUsd, after);
assert.throws(() => redeemReset(user, grant, "idempotency-other-test", "test"), /no longer available/);
db.run("UPDATE billing_plans SET weekly_enabled = 0, session_enabled = 0 WHERE id = 'core-plan'");
charge(reserve()); const weeklySpent = window("monthly").spentUsd;
db.run("UPDATE billing_plans SET weekly_enabled = 1, session_enabled = 1 WHERE id = 'core-plan'");
assert(window("weekly").spentUsd >= weeklySpent);

// Media needs a context bound; a tool schema named document does not.
const withoutContext = { ...model, context_length: null };
assert.throws(() => reserveBudget(key, withoutContext, { max_tokens: 64, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/image" } }] }] }, 200), /context length/);
assert.throws(() => reserveBudget(key, withoutContext, { max_tokens: 64, input: [{ type: "input_image", image_url: "https://example.com/image" }] }, 200), /context length/);
cancelBudget(reserveBudget(key, withoutContext, { max_tokens: 64, messages: [{ role: "user", content: "Text only" }], tools: [{ type: "function", function: { name: "read", parameters: { properties: { document: { type: "string" } } } } }] }, 300));

// The integer ledger remains exact above JS's safe-integer range.
assignPlan(user, null);
db.run("UPDATE billing_periods SET spent_nanos = 9007199254740993 WHERE scope = 'key' AND owner_id = ? AND kind = 'lifetime'", [key.id]);
const tiny = reserve(now, { ...model, pricing_input: .000000001 });
settleBudget(tiny, { inTok: 1, cacheTok: 0, outTok: 0 });
assert.equal(db.query<any, [string]>("SELECT CAST(spent_nanos AS TEXT) AS amount FROM billing_periods WHERE scope='key' AND owner_id=? AND kind='lifetime'").get(key.id)!.amount, "9007199254740994");

// Crashed processes cannot free an uncertain request on restart. Recovery
// conservatively settles once, and a live heartbeat protects long streams.
const orphan = reserve();
const held = db.query<any, [string]>("SELECT amount_nanos FROM billing_reservations WHERE id = ?").get(orphan)!.amount_nanos;
db.run("UPDATE billing_reservations SET instance_id = 'dead-instance', created_at = ? WHERE id = ?", [now - 600000, orphan]);
const beforeRecovery = window("monthly").spentUsd;
recoverBudgets(now); near(window("monthly").spentUsd, beforeRecovery + held / 1e9); assert.equal(window("monthly").reservedUsd, 0);
recoverBudgets(now); near(window("monthly").spentUsd, beforeRecovery + held / 1e9);
assert.equal(db.query<any, [string]>("SELECT state FROM billing_reservations WHERE id=?").get(orphan)!.state, "recovered");
startBilling(); const live = reserve(); db.run("UPDATE billing_reservations SET created_at = ? WHERE id = ?", [now - 600000, live]);
recoverBudgets(now); assert(window("monthly").reservedUsd > 0); cancelBudget(live);

// Malformed upstream usage retains the bound instead of becoming free.
const invalid = reserve(); const limit = db.query<any, [string]>("SELECT amount_nanos FROM billing_reservations WHERE id=?").get(invalid)!.amount_nanos;
const paid = settleBudget(invalid, { inTok: -1, cacheTok: 0, outTok: 0 }); assert.equal(paid.input, BigInt(limit));
assert.equal(window("monthly").reservedUsd, 0);

const times: number[] = [];
for (let index = 0; index < 200; index++) { const start = performance.now(); cancelBudget(reserve()); times.push(performance.now() - start); }
times.sort((a,b) => a-b);
console.log(`Core billing invariants passed; 200 reserve/cancel pairs, p50=${times[100]!.toFixed(2)}ms p95=${times[190]!.toFixed(2)}ms.`);
