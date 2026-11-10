import { createResource, createSignal, For, Show } from "solid-js";
import { api, type BillingPlanDto } from "../../api";
import { PageTitle } from "../../chrome";
import { Badge, Btn, Card, CurrencyField, Icon, Icons, Modal, ModalField, SwitchCard, fmtCost, toast } from "../../ui";

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
    <Card class="billing-intro" motion="fade-u duration-250"><div class="billing-plan-symbol"><Icon name="lucide:wallet" size={24} /></div><div><h2>Monthly by default. Flexible when needed.</h2><p>Choose a USD allowance or unlimited access. Optional weekly and 5-hour limits distribute the monthly allowance over shorter periods. Every API key shares the account ceiling.</p></div></Card>
    <Show when={!plans.error} fallback={<Card class="billing-error"><span role="alert">Plans could not be loaded.</span><Btn variant="outline" onClick={() => void actions.refetch()}>Retry</Btn></Card>}>
      <Show when={plans()} fallback={<p class="text-sm text-ink-500">Loading plans…</p>}><Show when={plans()?.length} fallback={<Card class="billing-empty" motion="fade-u duration-250"><Icon name="lucide:wallet" size={28} /><h2>Create your first plan</h2><p>Existing accounts remain unlimited until you assign a plan.</p><Btn onClick={() => open("new")}>Create plan</Btn></Card>}>
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
      <div class="space-y-5">
        {/* Exclusive Plan Blueprint Header & Tier Archetypes */}
        <div class="rounded-xl border border-line bg-surface-subtle p-3.5 space-y-3">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2">
              <span class="w-7 h-7 rounded-lg bg-accent-subtle border border-accent/35 text-accent inline-flex items-center justify-center">
                <Icon name="lucide:layers" size={14} />
              </span>
              <div>
                <div class="text-xs font-medium text-fg">Plan Blueprint & Quota Architecture</div>
                <div class="text-[11px] text-fg-muted">
                  {unlimited()
                    ? "Unrestricted enterprise ceiling across all billing windows"
                    : `${fmtCost(Number(amount()) || 0)}/mo · ~${fmtCost((Number(amount()) || 0) / days)}/day average pace (${days}d UTC month)`}
                </div>
              </div>
            </div>
            <Badge tone={unlimited() ? "indigo" : "green"}>
              {unlimited() ? "∞ Unlimited Tier" : `${fmtCost(Number(amount()) || 0)} / mo`}
            </Badge>
          </div>

          <div class="grid grid-cols-5 gap-1.5" aria-hidden="true">
            <For
              each={[
                { label: "Starter", usd: "20", tag: "$20/mo", unlim: false },
                { label: "Pro", usd: "100", tag: "$100/mo", unlim: false },
                { label: "Team", usd: "250", tag: "$250/mo", unlim: false },
                { label: "Scale", usd: "1000", tag: "$1K/mo", unlim: false },
                { label: "Infinite", usd: "100", tag: "∞ No cap", unlim: true },
              ]}
            >
              {(tier) => {
                const active = () =>
                  tier.unlim ? unlimited() : !unlimited() && Number(amount()) === Number(tier.usd);
                return (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => {
                      setUnlimited(tier.unlim);
                      if (!tier.unlim) setAmount(tier.usd);
                      if (!name().trim()) setName(tier.label);
                    }}
                    class={`rounded-lg border p-2 text-left transition-all cursor-pointer ${
                      active()
                        ? "border-accent bg-accent-subtle text-accent-strong shadow-2xs"
                        : "border-line bg-surface hover:border-line-strong text-fg-secondary"
                    }`}
                  >
                    <div class="text-[10px] tracking-wider text-fg-muted font-medium">{tier.label}</div>
                    <div class="text-xs font-mono font-medium mt-0.5 text-fg">{tier.tag}</div>
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        <ModalField label="Plan name"><input class="ui-field" aria-label="Plan name" maxLength={64} value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="e.g. Pro" /></ModalField>
        <SwitchCard checked={unlimited()} onChange={(value) => setUnlimited(value)} title="Unlimited spending" description="No account spending ceiling. Individual key limits still apply." />
        <Show when={!unlimited()}>
          <CurrencyField
            label="Monthly allowance (USD)"
            ariaLabel="Monthly allowance (USD)"
            hint="Renews at the beginning of each calendar month"
            min="0.01"
            max="1000000"
            step="0.01"
            allowEmpty={false}
            value={amount()}
            onInput={setAmount}
            presets={[
              { label: "$25", value: "25" },
              { label: "$100", value: "100" },
              { label: "$250", value: "250" },
              { label: "$500", value: "500" },
              { label: "$1,000", value: "1000" },
            ]}
          />

          {/* Exclusive Temporal Cascade Window Architect */}
          <div class="rounded-xl border border-line bg-surface-subtle p-3.5 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <div>
                <h3 class="text-xs font-medium text-fg">Temporal Quota Cascade</h3>
                <p class="text-[11px] text-fg-muted">Proportional sub-windows prevent a single burst from exhausting the entire month.</p>
              </div>
              <span class="text-[11px] font-mono text-fg-secondary bg-surface px-2 py-0.5 rounded border border-line">
                {days}d UTC cycle
              </span>
            </div>

            {/* Visual Proportion Waterfall Bar */}
            <div class="space-y-1.5" aria-hidden="true">
              <div class="grid grid-cols-3 gap-2 text-[11px]">
                <div class="rounded-lg border border-accent/40 bg-surface p-2">
                  <div class="flex items-center justify-between text-fg-muted">
                    <span>1 · Monthly Pool</span>
                    <span class="font-mono text-accent">100%</span>
                  </div>
                  <div class="text-sm font-mono font-medium text-fg mt-0.5">{fmtCost(Number(amount()) || 0)}</div>
                  <div class="h-1.5 rounded-full bg-surface-muted mt-1.5 overflow-hidden">
                    <div class="h-full bg-accent rounded-full w-full" />
                  </div>
                </div>

                <div class={`rounded-lg border p-2 transition-colors ${weekly() ? "border-accent/40 bg-surface" : "border-line bg-surface/50 opacity-60"}`}>
                  <div class="flex items-center justify-between text-fg-muted">
                    <span>2 · 7-Day Slice</span>
                    <span class="font-mono">{((7 / days) * 100).toFixed(1)}%</span>
                  </div>
                  <div class="text-sm font-mono font-medium text-fg mt-0.5">
                    {weekly() ? fmtCost((Number(amount()) || 0) * 7 / days) : "Unbounded"}
                  </div>
                  <div class="h-1.5 rounded-full bg-surface-muted mt-1.5 overflow-hidden">
                    <div class="h-full bg-accent rounded-full transition-all" style={{ width: weekly() ? `${Math.max(12, (7 / days) * 100)}%` : "0%" }} />
                  </div>
                </div>

                <div class={`rounded-lg border p-2 transition-colors ${session() ? "border-accent/40 bg-surface" : "border-line bg-surface/50 opacity-60"}`}>
                  <div class="flex items-center justify-between text-fg-muted">
                    <span>3 · 5-Hr Burst</span>
                    <span class="font-mono">{((5 / (days * 24)) * 100).toFixed(2)}%</span>
                  </div>
                  <div class="text-sm font-mono font-medium text-fg mt-0.5">
                    {session() ? fmtCost((Number(amount()) || 0) * 5 / (days * 24)) : "Unbounded"}
                  </div>
                  <div class="h-1.5 rounded-full bg-surface-muted mt-1.5 overflow-hidden">
                    <div class="h-full bg-accent rounded-full transition-all" style={{ width: session() ? "18%" : "0%" }} />
                  </div>
                </div>
              </div>
            </div>

            <div class="space-y-2 pt-1">
              <SwitchCard checked={weekly()} onChange={setWeekly} title="Weekly allowance" description={`${fmtCost(Number(amount()) * 7 / days)} per week this month · renews Monday`} />
              <SwitchCard checked={session()} onChange={setSession} title="5-hour sessions" description={`${fmtCost(Number(amount()) * 5 / (days * 24))} per session this month · starts on first use`} />
            </div>
          </div>

          <p class="text-xs text-ink-500 leading-relaxed">Configure model prices in Models before assigning a spending limit.</p>
          <Show when={editing() !== "new"}><p class="text-xs text-ink-500 leading-relaxed">Changes apply to all members immediately. Existing spend and active sessions are preserved.</p></Show>
        </Show>
      </div>
    </Modal>
    <Modal open={!!deleting()} onClose={() => { if (!busy()) setDeleting(null); }} width="max-w-xl billing-dialog" title="Delete plan?" description={deleting()?.name} footer={<><Btn variant="outline" size="sm" disabled={busy()} onClick={() => setDeleting(null)}>Cancel</Btn><Btn variant="danger" size="sm" disabled={busy()} onClick={remove}>Delete plan</Btn></>}><p class="text-sm text-ink-400">This plan has no members. Its audit history will be preserved.</p></Modal>
  </div>;
}
