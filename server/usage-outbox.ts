import { db } from "./db";
import { randomToken } from "./crypto";
import type { UsageEvent } from "./usage";

/** Charge integers are encoded as decimal strings; JSON numbers would silently
 * round large SQLite int64 totals. No client-supplied ID is used for delivery. */
export function enqueueUsage(ev: UsageEvent, operationId = `u_${randomToken(16)}`): void {
  const ts = ev.ts ?? Date.now();
  const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
  const invalidUsage = ![ev.inTok, ev.cacheTok, ev.outTok].every(validCount);
  if (!Number.isSafeInteger(ts) || ts < 0 || ts > 8_640_000_000_000_000) throw new Error("invalid usage timestamp");
  if ([ev.charge.input, ev.charge.cache, ev.charge.output].some((amount) => typeof amount !== "bigint" || amount < 0n || amount > 9_000_000_000_000_000n)) throw new Error("invalid frozen usage charge");
  // An invalid provider metric must not become a NULL/NaN poison row that
  // prevents every subsequent event from being delivered. Keep valid counts,
  // mark the unknown metrics estimated, and preserve the ledger's charge.
  const payload = JSON.stringify({
    keyId: ev.keyId, userId: ev.userId, projectId: ev.projectId ?? null, costCenterId: ev.costCenterId ?? null,
    proto: ev.proto, model: ev.model.slice(0, 128), ts,
    inTok: validCount(ev.inTok) ? ev.inTok : 0, cacheTok: validCount(ev.cacheTok) ? ev.cacheTok : 0, outTok: validCount(ev.outTok) ? ev.outTok : 0,
    latencyMs: Number.isFinite(ev.latencyMs) ? Math.max(0, Math.min(2_147_483_647, ev.latencyMs)) : 0,
    status: Number.isInteger(ev.status) && ev.status >= 100 && ev.status <= 599 ? ev.status : 599,
    stream: !!ev.stream, estimated: !!ev.estimated || invalidUsage,
    providerId: ev.providerId ?? "", providerKeyId: ev.providerKeyId ?? "", upstreamModel: ev.upstreamModel ?? "", requestId: ev.requestId ?? "",
    charge: { input: String(ev.charge.input), cache: String(ev.charge.cache), output: String(ev.charge.output) },
  });
  insert.run(operationId, ts, payload);
}

const insert = db.prepare("INSERT INTO usage_outbox(operation_id, ts, payload) VALUES (?, ?, ?)");
const pending = db.prepare<{ pending: number }, []>("SELECT pending FROM usage_outbox_pending WHERE id=1");
export const pendingUsage = () => pending.get()?.pending ?? 0;

export interface OutboxRow { id: number; payload: string }
export function decodeUsage(row: OutboxRow): UsageEvent {
  const data = JSON.parse(row.payload);
  return { ...data, charge: { input: BigInt(data.charge.input), cache: BigInt(data.charge.cache), output: BigInt(data.charge.output) } } as UsageEvent;
}
