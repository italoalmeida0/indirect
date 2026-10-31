import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import {
  api,
  policyRevision,
  type AdminUserDto,
  type BillingDto,
  type BillingPlanDto,
  type BudgetPresentation,
  type BudgetWindowDto,
  type FinancialPolicyDto,
  type HiddenBudgetWindowDto,
  type PercentBudgetWindowDto,
  type ProjectedBillingPlanDto,
  type UsdBudgetWindowDto,
} from "./api";
import { Badge, Btn, Card, Icon, Icons, Modal, ModalField, Select, fmtCost, fmtDate, toast } from "./ui";

const windowName = (kind: string) => ({ monthly: "Monthly allowance", weekly: "Weekly allowance", session: "5-hour session", both: "Weekly + 5-hour" }[kind] ?? kind);
const fmtPct = (value: number) => `${Number(value.toFixed(1))}%`;

function isUsdWindow(w: BudgetWindowDto): w is UsdBudgetWindowDto {
  return w.presentation !== "percent" && w.presentation !== "hidden" && "spentUsd" in w;
}

function isPercentWindow(w: BudgetWindowDto): w is PercentBudgetWindowDto {
  return w.presentation === "percent" || ("usedPercent" in w && !("spentUsd" in w));
}

function asHiddenWindow(w: BudgetWindowDto): HiddenBudgetWindowDto {
  return w as HiddenBudgetWindowDto;
}

function describePlanAllowance(
  plan: BillingPlanDto | ProjectedBillingPlanDto | null,
  policy?: FinancialPolicyDto,
): string {
  if (!plan) return "Your account has no spending ceiling.";
  if ("monthlyUsd" in plan && plan.monthlyUsd !== undefined) {
    return plan.monthlyUsd !== null ? `${fmtCost(plan.monthlyUsd)} monthly allowance` : "Your account has no spending ceiling.";
  }
  const projected = plan as ProjectedBillingPlanDto;
  if (!projected.limitConfigured) return "Your account has no spending ceiling.";
  const mode: BudgetPresentation = policy?.budgetPresentation ?? "hidden";
  return mode === "percent" ? "Percentage-tracked monthly allowance" : "Managed monthly allowance";
}

export function BillingSummary(props: { billing: BillingDto; compact?: boolean }) {
  return <div class={`billing-windows ${props.compact ? "is-compact" : ""}`}>
    <For each={props.billing.windows}>{(window) => {
      const renewalText = () =>
        window.kind === "session" && !props.billing.sessionStarted
          ? "Starts with your next request"
          : `Renews ${fmtDate(window.resetsAt)}`;

      if (isUsdWindow(window)) {
        const percent = () => window.limitUsd === null ? 0 : Math.min(100, window.limitUsd > 0 ? (window.spentUsd + window.reservedUsd) / window.limitUsd * 100 : 100);
        return <div class="billing-window">
          <div class="flex items-center justify-between gap-2"><h3>{windowName(window.kind)}</h3><Show when={window.limitUsd !== null}><span class="billing-percent">{Math.round(percent())}%</span></Show></div>
          <div class="billing-amount"><strong>{window.limitUsd === null ? "Unlimited" : fmtCost(window.remainingUsd)}</strong><Show when={window.limitUsd !== null}><span>remaining</span></Show></div>
          <Show when={window.limitUsd !== null}><div class={`billing-meter ${percent() >= 95 ? "is-low" : ""}`} role="progressbar" aria-label={`${windowName(window.kind)} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent())} aria-valuetext={`${fmtCost(window.spentUsd)} spent of ${fmtCost(window.limitUsd)}`}><span style={{ width: `${percent()}%` }} /></div></Show>
          <p class="billing-detail">{fmtCost(window.spentUsd)} spent<Show when={window.limitUsd !== null}> of {fmtCost(window.limitUsd)}</Show><Show when={window.reservedUsd > 0}> · {fmtCost(window.reservedUsd)} reserved</Show></p>
          <p class="billing-reset"><Icon name="lucide:clock-3" size={12} />{renewalText()}</p>
        </div>;
      }

      if (isPercentWindow(window)) {
        const settled = () => window.usedPercent ?? 0;
        const held = () => window.holdPercent ?? 0;
        const committed = () => window.limitConfigured ? Math.min(100, Math.round((settled() + held()) * 10) / 10) : 0;
        const remaining = () => Math.max(0, Math.round((100 - committed()) * 10) / 10);
        return <div class="billing-window">
          <div class="flex items-center justify-between gap-2">
            <h3>{windowName(window.kind)}</h3>
            <Show when={window.limitConfigured}><span class="billing-percent">{fmtPct(committed())}</span></Show>
          </div>
          <div class="billing-amount">
            <strong>{!window.limitConfigured ? "Unlimited" : fmtPct(remaining())}</strong>
            <Show when={window.limitConfigured}><span>{committed() >= 100 ? "remaining · limit reached" : "remaining"}</span></Show>
          </div>
          <Show when={window.limitConfigured}>
            <div
              class={`billing-meter ${committed() >= 95 ? "is-low" : ""}`}
              role="progressbar"
              aria-label={`${windowName(window.kind)} used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(committed())}
              aria-valuetext={
                held() > 0
                  ? `${fmtPct(settled())} used, ${fmtPct(held())} held in flight`
                  : `${fmtPct(settled())} of allowance used`
              }
            >
              <span style={{ width: `${committed()}%` }} />
            </div>
          </Show>
          <p class="billing-detail">
            {!window.limitConfigured
              ? "No spending limit configured"
              : <>
                  {fmtPct(settled())} used
                  <Show when={held() > 0}> · {fmtPct(held())} held in flight</Show>
                  <Show when={committed() >= 95 && committed() < 100}> · Near limit</Show>
                  <Show when={committed() >= 100}> · Allowance exhausted</Show>
                </>}
          </p>
          <p class="billing-reset"><Icon name="lucide:clock-3" size={12} />{renewalText()}</p>
        </div>;
      }

      const hidden = asHiddenWindow(window);
      return <div class="billing-window">
        <div class="flex items-center justify-between gap-2">
          <h3>{windowName(hidden.kind)}</h3>
          <Show when={hidden.limitConfigured}>
            <Badge tone={hidden.exhausted ? "red" : "green"}>{hidden.exhausted ? "Exhausted" : "Active"}</Badge>
          </Show>
        </div>
        <div class="billing-amount">
          <strong>{!hidden.limitConfigured ? "Unlimited" : hidden.exhausted ? "Allowance reached" : "Managed allowance"}</strong>
        </div>
        <p class="billing-detail">
          {!hidden.limitConfigured
            ? "No spending limit configured"
            : hidden.exhausted
              ? "Wait for renewal or redeem an available reset."
              : "Usage is tracked automatically against your plan."}
          <Show when={hidden.activeHold}> · Requests in progress</Show>
        </p>
        <p class="billing-reset"><Icon name="lucide:clock-3" size={12} />{renewalText()}</p>
      </div>;
    }}</For>
  </div>;
}

function createBilling() {
  let controller: AbortController | undefined;
  const [data, actions] = createResource(policyRevision, async () => {
    controller?.abort(); controller = new AbortController();
    return (await api<{ billing: BillingDto }>("GET", "/api/billing", undefined, controller.signal)).billing;
  });
  const timer = setInterval(() => { if (document.visibilityState === "visible" && !data.loading) void actions.refetch(); }, 30_000);
  const visible = () => { if (document.visibilityState === "visible") void actions.refetch(); };
  document.addEventListener("visibilitychange", visible);
  onCleanup(() => { controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); });
  return { data, ...actions };
}

export function PlanUsageCard() {
  const billing = createBilling();
  return <Card class="billing-overview p-5 min-w-0">
    <div class="billing-heading"><div><span class="billing-eyebrow">Account allowance</span><h2>{billing.data.error ? "Plan & limits" : billing.data()?.plan?.name ?? "Plan & limits"}</h2></div><a class="analytics-control" href="#/limits">View limits<Icon name={Icons.chevronRight} size={13} /></a></div>
    <Show when={!billing.data.error} fallback={<div class="billing-error" role="alert">Could not load your allowance.<Btn size="sm" variant="ghost" onClick={() => void billing.refetch()}>Retry</Btn></div>}>
      <Show when={billing.data()} fallback={<p class="text-xs text-ink-500 py-5">Loading your allowance…</p>}>{(data) => <BillingSummary billing={data()} compact />}</Show>
    </Show>
  </Card>;
}

export function PlanLimits() {
  const billing = createBilling();
  const [confirm, setConfirm] = createSignal<{ grant: BillingDto["resets"][number]; requestId: string } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const redeem = async () => {
    const selected = confirm(); if (!selected) return;
    setBusy(true);
    try {
      const result = await api<{ billing: BillingDto }>("POST", `/api/billing/resets/${selected.grant.id}/redeem`, { requestId: selected.requestId });
      billing.mutate(result.billing); setConfirm(null); toast("Allowance restored");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not redeem reset", "err"); }
    finally { setBusy(false); }
  };
  return <div class="billing-page">
    <div class="billing-page-heading"><div><span class="billing-eyebrow">Your account</span><h1>Plan & limits</h1><p>One allowance across every model, API key and connected client.</p></div><Btn variant="outline" size="sm" disabled={billing.data.loading} onClick={() => void billing.refetch()}><Icon name={Icons.refresh} size={14} />Refresh</Btn></div>
    <Show when={!billing.data.error} fallback={<Card class="billing-error"><span role="alert">Your limits could not be loaded.</span><Btn variant="outline" onClick={() => void billing.refetch()}>Try again</Btn></Card>}>
      <Show when={billing.data()} fallback={<Card class="p-6 text-sm text-ink-500">Loading your plan…</Card>}>{(data) => <>
        <Card class="billing-plan-summary"><div class="billing-heading"><div><span class="billing-eyebrow">Current plan</span><h2>{data().plan?.name ?? "Unlimited"}</h2><p>{describePlanAllowance(data().plan, data().financialPolicy)}</p></div><div class="billing-plan-symbol"><Icon name="lucide:wallet" size={24} /></div></div><BillingSummary billing={data()} /></Card>
        <div class="billing-info-grid">
          <Card class="billing-policy"><Icon name="lucide:shield-check" size={20} /><h2>Clear, shared limits</h2><p>All priced input, cached input, output and reasoning count toward your allowance. Individual API keys can have smaller daily and lifetime spending limits.</p><p>Requests in progress temporarily reserve balance. The unused amount returns when a request finishes. Cancelling before the provider reports usage may consume the reserved amount.</p></Card>
          <Card class="billing-policy"><Icon name="lucide:calendar-clock" size={20} /><h2>Predictable renewals</h2><p>The month renews on the first day at 00:00 UTC. Weekly limits renew on Monday. A 5-hour session starts with your first admitted request after the previous session expires.</p><p>Optional shorter allowances are proportional to the number of days in the current month. They do not accumulate.</p></Card>
        </div>
        <Card class="billing-resets"><div class="billing-heading"><div><span class="billing-eyebrow">A little more room</span><h2>Available resets</h2><p>Restore a shorter allowance. Your monthly spend and API key limits stay the same.</p></div><Icon name="lucide:rotate-ccw" size={21} class="text-ink-500" /></div>
          <Show when={data().resets.length} fallback={<div class="billing-empty">No resets available. Resets granted by your administrator appear here.</div>}><div class="billing-reset-list"><For each={data().resets}>{(grant) => <div class="billing-reset-item"><div><strong>{windowName(grant.kind)}</strong><p>{grant.remaining} {grant.remaining === 1 ? "reset" : "resets"} available{grant.expiresAt ? ` · Expires ${fmtDate(grant.expiresAt)}` : ""}</p><Show when={grant.note}><p>{grant.note}</p></Show></div><Btn variant="outline" size="sm" onClick={() => setConfirm({ grant, requestId: crypto.randomUUID() })}>Use reset<Icon name="lucide:rotate-ccw" size={13} /></Btn></div>}</For></div></Show>
        </Card>
      </>}</Show>
    </Show>
    <Modal open={!!confirm()} onClose={() => { if (!busy()) setConfirm(null); }} title="Restore your allowance?" width="max-w-xl billing-dialog" description="Your monthly spend, API key limits and renewal times remain unchanged." footer={<><Btn size="sm" variant="outline" disabled={busy()} onClick={() => setConfirm(null)}>Cancel</Btn><Btn size="sm" disabled={busy()} onClick={redeem}>{busy() ? "Restoring…" : "Use reset"}</Btn></>}>
      <p class="text-sm text-ink-300 leading-relaxed">This uses one {windowName(confirm()?.grant.kind ?? "").toLowerCase()} reset. Requests already in progress will still count when they finish. A reset is kept if there is no eligible spend to restore.</p>
    </Modal>
  </div>;
}

export function UserPlanManager(props: { user: AdminUserDto | null; close: () => void; changed: () => void }) {
  const [selected, setSelected] = createSignal("");
  const [kind, setKind] = createSignal("session");
  const [count, setCount] = createSignal("1");
  const [expiry, setExpiry] = createSignal("");
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  createEffect(() => { if (props.user?.id) { setCount("1"); setExpiry(""); setNote(""); } });
  const [data, actions] = createResource(() => props.user?.id, async (id) => {
    const [status, plans] = await Promise.all([api<{ billing: BillingDto }>("GET", `/api/admin/users/${id}/billing`), api<{ plans: BillingPlanDto[] }>("GET", "/api/admin/plans")]);
    return { userId: id, billing: status.billing, plans: plans.plans };
  });
  createEffect(() => { if (data.error) return; const current = data(); if (current && current.userId === props.user?.id) { setSelected(current.billing.plan?.id ?? ""); setKind(current.billing.plan?.sessionEnabled ? "session" : "weekly"); } });
  const save = async () => {
    if (!props.user) return; setBusy(true);
    try { await api("PATCH", `/api/admin/users/${props.user.id}/billing`, { planId: selected() || null }); await actions.refetch(); props.changed(); toast("Plan updated. Existing spend is preserved."); }
    catch (error) { toast(error instanceof Error ? error.message : "Could not update plan", "err"); } finally { setBusy(false); }
  };
  const grant = async () => {
    if (!props.user) return; setBusy(true);
    try { await api("POST", `/api/admin/users/${props.user.id}/resets`, { kind: kind(), count: Number(count()), expiresAt: expiry() ? new Date(expiry()).getTime() : null, note: note().trim() }); await actions.refetch(); toast("Reset granted"); }
    catch (error) { toast(error instanceof Error ? error.message : "Could not grant reset", "err"); } finally { setBusy(false); }
  };
  const resetOptions = () => [...(data()?.billing.plan?.sessionEnabled ? [{ value: "session", label: "5-hour session" }] : []), ...(data()?.billing.plan?.weeklyEnabled ? [{ value: "weekly", label: "Weekly allowance" }] : []), ...(data()?.billing.plan?.sessionEnabled && data()?.billing.plan?.weeklyEnabled ? [{ value: "both", label: "Weekly + 5-hour" }] : [])];
  return <Modal open={!!props.user} onClose={() => { if (!busy()) props.close(); }} title="Plan & allowance" description={props.user?.email} width="max-w-3xl billing-dialog" footer={<Btn variant="outline" size="sm" disabled={busy()} onClick={props.close}>Done</Btn>}>
    <Show when={!data.error} fallback={<div class="billing-error" role="alert">Could not load this account.<Btn variant="outline" onClick={() => void actions.refetch()}>Retry</Btn></div>}><Show when={data()?.userId === props.user?.id ? data() : undefined} fallback={<p class="text-sm text-ink-500">Loading allowance…</p>}>{(current) => <div class="space-y-6">
      <div class="billing-assignment"><Select label="Account plan" value={selected()} onChange={setSelected} options={[{ value: "", label: "Unlimited — no plan" }, ...current().plans.map((plan) => ({ value: plan.id, label: `${plan.name} · ${plan.monthlyUsd === null ? "Unlimited" : `${fmtCost(plan.monthlyUsd)} / month`}` }))]} /><Btn size="sm" disabled={busy() || selected() === (current().billing.plan?.id ?? "")} onClick={save}>Save plan</Btn></div>
      <p class="text-xs text-ink-500">Changing a plan preserves monthly and weekly spend. A different plan invalidates unused resets.</p>
      <BillingSummary billing={current().billing} />
      <Show when={resetOptions().length}><div class="billing-grant"><div class="billing-heading"><div><h2>Grant resets</h2><p>The user chooses when to restore a shorter allowance.</p></div><Badge tone="zinc">{current().billing.resets.reduce((sum, grant) => sum + grant.remaining, 0)} available</Badge></div><div class="billing-form-grid"><Select label="Restore" value={kind()} onChange={setKind} options={resetOptions()} /><ModalField label="Number of resets"><input class="ui-field" aria-label="Number of resets" type="number" min="1" max="100" value={count()} onInput={(event) => setCount(event.currentTarget.value)} /></ModalField><ModalField label="Expires" hint="Optional · your local time"><input class="ui-field" aria-label="Reset expiration" type="datetime-local" value={expiry()} onInput={(event) => setExpiry(event.currentTarget.value)} /></ModalField><ModalField label="Note" hint="Visible to the user"><input class="ui-field" aria-label="Reset note" maxLength={256} value={note()} onInput={(event) => setNote(event.currentTarget.value)} /></ModalField></div><div class="flex justify-end mt-4"><Btn size="sm" disabled={busy() || !Number.isInteger(Number(count())) || Number(count()) < 1 || Number(count()) > 100} onClick={grant}>Grant reset</Btn></div></div></Show>
    </div>}</Show></Show>
  </Modal>;
}
