import { createResource, createSignal, For, Show } from "solid-js";
import { api, type BillingPlanDto } from "../../api";
import { PageTitle } from "../../index";
import { Badge, Btn, Card, Icon, Icons, Modal, ModalField, SwitchCard, fmtCost, toast } from "../../ui";

export default function AdminPlansPage() {
  const [plans, actions] = createResource(async () => (await api<{ plans: BillingPlanDto[] }>("GET", "/api/admin/plans")).plans);
  const [editing, setEditing] = createSignal<BillingPlanDto | "new" | null>(null);
  const [deleting, setDeleting] = createSignal<BillingPlanDto | null>(null);
  const [name, setName] = createSignal("");
  const [amount, setAmount] = createSignal("100");
  const [unlimited, setUnlimited] = createSignal(false);
  const [weekly, setWeekly] = createSignal(false);
  const [session, setSession] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const days = new Date(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0).getDate();
  const open = (plan: BillingPlanDto | "new") => {
    setName(plan === "new" ? "" : plan.name); setAmount(String(plan === "new" ? 100 : plan.monthlyUsd ?? 100));
    setUnlimited(plan !== "new" && plan.monthlyUsd === null); setWeekly(plan !== "new" && plan.weeklyEnabled); setSession(plan !== "new" && plan.sessionEnabled); setEditing(plan);
  };
  const save = async () => {
    setBusy(true);
    try {
      const current = editing();
      await api(current === "new" ? "POST" : "PATCH", current === "new" ? "/api/admin/plans" : `/api/admin/plans/${(current as BillingPlanDto).id}`, { name: name().trim(), monthlyUsd: unlimited() ? null : Number(amount()), weeklyEnabled: !unlimited() && weekly(), sessionEnabled: !unlimited() && session() });
      setEditing(null); await actions.refetch(); toast("Plan saved");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not save plan", "err"); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting()) return; setBusy(true);
    try { await api("DELETE", `/api/admin/plans/${deleting()!.id}`); setDeleting(null); await actions.refetch(); toast("Plan deleted"); }
    catch (error) { toast(error instanceof Error ? error.message : "Could not delete plan", "err"); } finally { setBusy(false); }
  };
  return <div class="billing-page">
    <PageTitle title="Plans" subtitle="A clear spending allowance for every account. Configure once, assign in Users." right={<Btn onClick={() => open("new")}><Icon name={Icons.plus} size={15} />New plan</Btn>} />
    <Card class="billing-intro"><div class="billing-plan-symbol"><Icon name="lucide:wallet" size={24} /></div><div><h2>Monthly by default. Flexible when needed.</h2><p>Choose a USD allowance or unlimited access. Optional weekly and 5-hour limits distribute the monthly allowance over shorter periods. Every API key shares the account ceiling.</p></div></Card>
    <Show when={!plans.error} fallback={<Card class="billing-error"><span role="alert">Plans could not be loaded.</span><Btn variant="outline" onClick={() => void actions.refetch()}>Retry</Btn></Card>}>
      <Show when={plans()} fallback={<p class="text-sm text-ink-500">Loading plans…</p>}><Show when={plans()?.length} fallback={<Card class="billing-empty"><Icon name="lucide:wallet" size={28} /><h2>Create your first plan</h2><p>Existing accounts remain unlimited until you assign a plan.</p><Btn onClick={() => open("new")}>Create plan</Btn></Card>}>
        <div class="billing-plan-grid"><For each={plans()}>{(plan) => <Card class="billing-plan-card">
          <div class="billing-heading"><h2>{plan.name}</h2><Badge tone="zinc">{plan.members ?? 0} {(plan.members ?? 0) === 1 ? "member" : "members"}</Badge></div>
          <div class="billing-plan-price">{plan.monthlyUsd === null ? "Unlimited" : fmtCost(plan.monthlyUsd)}<Show when={plan.monthlyUsd !== null}><span>/ month</span></Show></div>
          <p class="billing-detail">Account spending allowance · USD</p>
          <div class="billing-plan-windows"><div><span>Weekly</span><strong>{plan.weeklyEnabled ? fmtCost(plan.monthlyUsd! * 7 / days) : "Not limited"}</strong></div><div><span>5-hour session</span><strong>{plan.sessionEnabled ? fmtCost(plan.monthlyUsd! * 5 / (days * 24)) : "Not limited"}</strong></div></div>
          <div class="billing-plan-actions"><Btn variant="outline" size="sm" onClick={() => open(plan)}><Icon name={Icons.edit} size={13} />Edit plan</Btn><Btn variant="ghost" size="sm" disabled={!!plan.members} title={plan.members ? "Move members before deleting this plan" : "Delete plan"} onClick={() => setDeleting(plan)}><Icon name={Icons.trash} size={14} /></Btn></div>
        </Card>}</For></div>
      </Show></Show>
    </Show>
    <p class="billing-footnote">Preview uses {days} days in the current UTC month. Monthly renewal: first day, 00:00 UTC. Weekly renewal: Monday, 00:00 UTC. A 5-hour window starts on first use.</p>
    <Modal open={!!editing()} onClose={() => { if (!busy()) setEditing(null); }} width="max-w-xl billing-dialog" title={editing() === "new" ? "Create plan" : "Edit plan"} description="Amounts are spending allowances, not subscription prices." footer={<><Btn variant="outline" size="sm" disabled={busy()} onClick={() => setEditing(null)}>Cancel</Btn><Btn size="sm" disabled={busy() || !name().trim() || !unlimited() && (!Number.isFinite(Number(amount())) || Number(amount()) < .01 || Number(amount()) > 1_000_000)} onClick={save}>{busy() ? "Saving…" : "Save plan"}</Btn></>}>
      <div class="space-y-5"><ModalField label="Plan name"><input class="ui-field" aria-label="Plan name" maxLength={64} value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="e.g. Pro" /></ModalField>
        <SwitchCard checked={unlimited()} onChange={(value) => setUnlimited(value)} title="Unlimited spending" description="No account spending ceiling. Individual key limits still apply." />
        <Show when={!unlimited()}><ModalField label="Monthly allowance (USD)" hint="Renews at the beginning of each calendar month"><input class="ui-field billing-money-input" type="number" inputMode="decimal" aria-label="Monthly allowance (USD)" min="0.01" max="1000000" step="0.01" value={amount()} onInput={(event) => setAmount(event.currentTarget.value)} /></ModalField>
          <p class="text-xs text-ink-500 leading-relaxed">Configure model prices in Models before assigning a spending limit.</p>
          <div class="billing-option-heading"><h3>Optional distribution</h3><p>Off by default. These limits share the monthly budget.</p></div>
          <SwitchCard checked={weekly()} onChange={setWeekly} title="Weekly allowance" description={`${fmtCost(Number(amount()) * 7 / days)} per week this month · renews Monday`} />
          <SwitchCard checked={session()} onChange={setSession} title="5-hour sessions" description={`${fmtCost(Number(amount()) * 5 / (days * 24))} per session this month · starts on first use`} />
          <Show when={editing() !== "new"}><p class="text-xs text-ink-500 leading-relaxed">Changes apply to all members immediately. Existing spend and active sessions are preserved.</p></Show>
        </Show>
      </div>
    </Modal>
    <Modal open={!!deleting()} onClose={() => { if (!busy()) setDeleting(null); }} width="max-w-xl billing-dialog" title="Delete plan?" description={deleting()?.name} footer={<><Btn variant="outline" size="sm" disabled={busy()} onClick={() => setDeleting(null)}>Cancel</Btn><Btn variant="danger" size="sm" disabled={busy()} onClick={remove}>Delete plan</Btn></>}><p class="text-sm text-ink-400">This plan has no members. Its audit history will be preserved.</p></Modal>
  </div>;
}
