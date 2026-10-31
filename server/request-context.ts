import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request correlation.
 *
 * A proxy call fans out across provider attempts, and the only way to follow
 * one client request through logs, audit rows and the usage ledger is a shared
 * identifier. The id is carried in an AsyncLocalStorage so it reaches code that
 * has no request parameter (audit(), recordUsage()), instead of being threaded
 * through every signature.
 *
 * The value the client sees (X-Request-Id) is the SAME value persisted on the
 * usage event, so a customer can quote a response header and an operator can
 * find the exact rows.
 */

export interface RequestContext {
  /** Correlation id echoed as X-Request-Id. */
  requestId: string;
  /** Start of the request, for latency logging. */
  startedAt: number;
  method?: string;
  path?: string;
  /** Effective financial policy header attached once the caller authenticates. */
  financialPolicyHeader?: string;
  /** Revalidate dashboard authorization after awaits, under the mutation lock. */
  revalidateMutation?: () => void;
}

const store = new AsyncLocalStorage<RequestContext>();

/** The current correlation id, or an empty string outside a request. */
export function currentRequestId(): string {
  return store.getStore()?.requestId ?? "";
}

export function setCurrentFinancialPolicyHeader(header: string): void {
  const ctx = store.getStore();
  if (ctx) ctx.financialPolicyHeader = header;
}

export function currentFinancialPolicyHeader(): string | undefined {
  return store.getStore()?.financialPolicyHeader;
}

export function setMutationRevalidator(revalidate: () => void): void {
  const ctx = store.getStore();
  if (ctx) ctx.revalidateMutation = revalidate;
}

export function revalidateCurrentMutation(): void {
  store.getStore()?.revalidateMutation?.();
}

/** Run `fn` with `context` bound to the async execution. */
export function runWithRequest<T>(context: RequestContext, fn: () => T): T {
  return store.run(context, fn);
}

const VALID_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Accept a client-provided id when it is well formed, otherwise mint one.
 *
 * A caller-supplied id is honoured because clients that already log request ids
 * (SDKs, API gateways) can then correlate without a mapping table. The charset
 * is restricted so an id can never inject a newline into a log line or a
 * header.
 */
export function resolveRequestId(header: string | null | undefined, mint: () => string): string {
  const candidate = header?.trim();
  if (candidate && VALID_ID.test(candidate)) return candidate;
  return mint();
}
