import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { api, type BudgetPresentation, type FinancialPolicyDto, type FinancialProjectDto, type ModelDto, type ModelPolicyDto } from "../../api";
import { Badge, Btn, Card, EmptyState, Icons, Input, Modal, ModalNotice, Select, SwitchCard, toast } from "../../ui";

const failure = (error: unknown) => error instanceof Error ? error.message : "Request failed";
const budgetOptions = [{ value: "usd", label: "Amounts in USD" }, { value: "percent", label: "Budget percentages" }, { value: "hidden", label: "Hide financial amounts" }];

export function FinancialDefaults() {
  const [data, { refetch }] = createResource(async () => (await api<{ defaults: FinancialPolicyDto }>("GET", "/api/admin/financial-policy")).defaults);
  const readData = () => data.error ? undefined : data();
  const [presentation, setPresentation] = createSignal("usd");
  const [prices, setPrices] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => { if (readData()) { setPresentation(readData()!.budgetPresentation); setPrices(readData()!.showModelPrices); } });
  const save = async () => {
    setBusy(true); setError("");
    try { await api("PATCH", "/api/admin/financial-policy", { budgetPresentation: presentation(), showModelPrices: prices() }); await refetch(); toast("Financial defaults saved"); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  return <Card class="p-4 sm:p-5 space-y-4"><h2 class="font-semibold text-ink-100">Financial visibility</h2><p class="text-sm text-ink-400">These defaults apply to users and project managers. Administrators retain financial visibility. User overrides are available in Administration → Users.</p>
    <Show when={data.error}><p role="alert" class="text-sm">{failure(data.error)}</p><Btn variant="outline" size="sm" onClick={() => refetch()}>Retry defaults</Btn></Show>
    <Show when={readData()}><Select label="Budget presentation" value={presentation()} onChange={setPresentation} options={budgetOptions} /><SwitchCard title="Show model prices" description="Independent of budget presentation. Controls model price discovery." checked={prices()} onChange={setPrices} /><p class="text-xs text-ink-400">Percentage mode shows finite-budget consumption without USD amounts. Hidden mode keeps operational limits and renewal information available.</p><Show when={error()}><p role="alert" class="text-sm">{error()}</p></Show><Btn disabled={busy()} onClick={save}>{busy() ? "Saving…" : "Save financial defaults"}</Btn></Show>
  </Card>;
}

export function UserFinancialPolicy(props: { userId: string }) {
  type Stored = { budgetPresentation: BudgetPresentation | null; showModelPrices: boolean | null };
  const [data, { refetch }] = createResource(() => props.userId, async (id) => api<{ stored: Stored; defaults: FinancialPolicyDto }>("GET", `/api/admin/users/${encodeURIComponent(id)}/financial-policy`));
  const readData = () => data.error ? undefined : data();
  const [budget, setBudget] = createSignal("inherit");
  const [prices, setPrices] = createSignal("inherit");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => { if (readData()) { setBudget(readData()!.stored.budgetPresentation ?? "inherit"); setPrices(readData()!.stored.showModelPrices === null ? "inherit" : readData()!.stored.showModelPrices ? "true" : "false"); } });
  const save = async () => {
    setBusy(true); setError("");
    try { await api("PATCH", `/api/admin/users/${encodeURIComponent(props.userId)}/financial-policy`, { budgetPresentation: budget() === "inherit" ? null : budget(), showModelPrices: prices() === "inherit" ? null : prices() === "true" }); await refetch(); toast("User financial policy saved"); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  return <div class="space-y-4"><Show when={data.error}><p role="alert">{failure(data.error)}</p><Btn variant="outline" size="sm" onClick={() => refetch()}>Retry policy</Btn></Show><Show when={readData()}><Select label="User budget presentation" value={budget()} onChange={setBudget} options={[{ value: "inherit", label: `Installation default (${readData()!.defaults.budgetPresentation})` }, ...budgetOptions]} /><Select label="User model prices" value={prices()} onChange={setPrices} options={[{ value: "inherit", label: `Installation default (${readData()!.defaults.showModelPrices ? "shown" : "hidden"})` }, { value: "true", label: "Show prices" }, { value: "false", label: "Hide prices" }]} /><Show when={error()}><p role="alert">{error()}</p></Show><Btn disabled={busy()} onClick={save}>Save user financial policy</Btn></Show></div>;
}

export function ModelPolicies() {
  const [policies, { refetch }] = createResource(async () => (await api<{ policies: ModelPolicyDto[] }>("GET", "/api/admin/model-policies")).policies);
  const readPolicies = () => policies.error ? undefined : policies();
  const [projects] = createResource(async () => (await api<{ projects: FinancialProjectDto[] }>("GET", "/api/projects")).projects);
  const readProjects = () => projects.error ? undefined : projects();
  const [models] = createResource(async () => (await api<{ models: ModelDto[] }>("GET", "/api/admin/models")).models);
  const readModels = () => models.error ? undefined : models();
  const [editing, setEditing] = createSignal<ModelPolicyDto | "new" | null>(null);
  const [deleting, setDeleting] = createSignal<ModelPolicyDto | null>(null);
  const [name, setName] = createSignal("");
  const [kind, setKind] = createSignal("default");
  const [projectId, setProjectId] = createSignal("");
  const [enabled, setEnabled] = createSignal(true);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [modelsChanged, setModelsChanged] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const open = (policy: ModelPolicyDto | "new") => { setName(policy === "new" ? "" : policy.name); setKind(policy === "new" ? "default" : policy.kind); setProjectId(policy === "new" ? "" : policy.project_id ?? ""); setEnabled(policy === "new" || !!policy.enabled); setSelected(policy === "new" ? [] : [...policy.models]); setModelsChanged(false); setSearch(""); setError(""); setEditing(policy); };
  const save = async (event: Event) => {
    event.preventDefault(); const item = editing(); if (!item) return;
    setBusy(true); setError("");
    try { await api(item === "new" ? "POST" : "PATCH", item === "new" ? "/api/admin/model-policies" : `/api/admin/model-policies/${encodeURIComponent(item.id)}`, { name: name().trim(), kind: kind(), projectId: kind() === "project" ? projectId() : null, enabled: enabled(), ...(item === "new" || modelsChanged() ? { models: selected() } : {}) }); setEditing(null); await refetch(); toast("Model policy saved"); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  const remove = async () => { const policy = deleting(); if (!policy) return; setBusy(true); setError(""); try { await api("DELETE", `/api/admin/model-policies/${encodeURIComponent(policy.id)}`); setDeleting(null); await refetch(); toast("Model policy deleted"); } catch (e) { setError(failure(e)); } finally { setBusy(false); } };
  return <div class="space-y-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-semibold text-ink-100">Model access policies</h2><p class="text-xs text-ink-400 mt-1">Default access plus additional public model IDs granted to project keys.</p></div><Btn onClick={() => open("new")}>New model policy</Btn></div>
    <ModalNotice>An explicitly empty default list leaves model access unrestricted. Deleted model IDs stay denied until the list is deliberately replaced. Project lists add grants to the default list. Administrators can reach all available models.</ModalNotice>
    <Show when={policies.error}><Card class="p-4"><p role="alert">{failure(policies.error)}</p><Btn size="sm" variant="outline" onClick={() => refetch()}>Retry policies</Btn></Card></Show>
    <Show when={readPolicies() && !readPolicies()!.length}><EmptyState icon={Icons.layers} title="No model policies" hint="All available models are accessible until you configure a default policy." /></Show>
    <For each={readPolicies()}>{(policy) => <Card class="p-4 flex flex-wrap items-center justify-between gap-3"><div class="min-w-0"><h3 class="font-semibold text-sm break-words">{policy.name} <Badge tone={policy.enabled ? "green" : "zinc"}>{policy.enabled ? "Enabled" : "Disabled"}</Badge></h3><p class="text-xs text-ink-400 mt-1">{policy.kind === "default" ? "Installation default" : `Project: ${readProjects()?.find((p) => p.id === policy.project_id)?.name ?? policy.project_id ?? "Unassigned"}`} · {policy.models.length ? `${policy.models.length} model IDs` : "Empty list"}</p><Show when={policy.missingModels?.length}><p class="text-xs text-ink-300 mt-2">{policy.missingModels!.length} deleted model ID(s) retained as denied entries. Edit to review.</p></Show></div><div class="flex gap-2"><Btn variant="outline" size="sm" onClick={() => open(policy)}>Edit {policy.name}</Btn><Btn variant="ghost" size="sm" onClick={() => { setError(""); setDeleting(policy); }}>Delete {policy.name}</Btn></div></Card>}</For>
    <Modal open={editing() !== null} onClose={() => !busy() && setEditing(null)} title={editing() === "new" ? "New model policy" : "Edit model policy"}><form onSubmit={save} class="space-y-4"><Input label="Policy name" value={name()} onInput={setName} required /><Show when={editing() === "new"}><Select label="Policy scope" value={kind()} onChange={setKind} options={[{ value: "default", label: "Installation default" }, { value: "project", label: "Project grant" }]} /><Show when={kind() === "project"}><Select label="Financial project" value={projectId()} onChange={setProjectId} options={[{ value: "", label: "Select a project" }, ...(readProjects() ?? []).map((p) => ({ value: p.id, label: p.name }))]} /></Show></Show><SwitchCard title="Enable model policy" checked={enabled()} onChange={setEnabled} /><Input label="Find models" value={search()} onInput={setSearch} /><p class="text-xs text-ink-400">{selected().length} selected. Public IDs are used for every protocol and model discovery.</p>
      <Show when={models.error}><p role="alert">{failure(models.error)}</p></Show><div class="max-h-64 overflow-y-auto rounded-lg border border-line divide-y divide-line"><For each={(readModels() ?? []).filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(search().toLowerCase()))}>{(model) => <label class="flex items-center gap-3 p-3 text-sm cursor-pointer"><input type="checkbox" class="accent-accent-500 shrink-0" checked={selected().includes(model.id)} onChange={(e) => { setModelsChanged(true); setSelected((ids) => e.currentTarget.checked ? [...ids, model.id] : ids.filter((id) => id !== model.id)); }} /><span class="min-w-0"><span class="block break-words">{model.name}</span><span class="block break-all text-xs text-ink-400">{model.id}{model.enabled ? "" : " · disabled"}</span></span></label>}</For></div>
      <Show when={(editing() !== "new" && editing() !== null && (editing() as ModelPolicyDto).missingModels?.length && !modelsChanged()) || selected().some((id) => !readModels()?.some((model) => model.id === id))}><ModalNotice tone="warn">Some selected IDs are no longer in the registry. Saving only the name or enabled state preserves these denied entries. Remove them explicitly before changing model selection. An empty default list permits all models.<Btn variant="outline" size="sm" onClick={() => { setModelsChanged(true); setSelected((ids) => ids.filter((id) => readModels()?.some((model) => model.id === id))); }}>Remove unavailable IDs</Btn></ModalNotice></Show><Show when={error()}><p role="alert">{error()}</p></Show><div class="flex flex-wrap gap-2 justify-end"><Btn variant="ghost" disabled={busy()} onClick={() => setEditing(null)}>Cancel</Btn><Btn type="submit" disabled={busy() || !name().trim() || (kind() === "project" && !projectId()) || !readModels()}>Save model policy</Btn></div></form></Modal>
    <Modal open={!!deleting()} onClose={() => !busy() && setDeleting(null)} title="Delete model policy"><p class="text-sm text-ink-300 mb-4">Delete {deleting()?.name}? Effective model access changes immediately.</p><Show when={error()}><p role="alert" class="text-sm mb-3">{error()}</p></Show><div class="flex justify-end gap-2"><Btn variant="ghost" disabled={busy()} onClick={() => setDeleting(null)}>Cancel</Btn><Btn variant="danger" disabled={busy()} onClick={remove}>Delete policy</Btn></div></Modal>
  </div>;
}
