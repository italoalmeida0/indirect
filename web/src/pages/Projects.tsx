import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { api, currentFinancialPolicy, currentSession, policyRevision, type FinancialProjectDto, type ProjectMemberDto, type ProjectUsageDto } from "../api";
import { PageTitle } from "../chrome";
import { Badge, Btn, Card, EmptyState, Icons, Input, Modal, ModalNotice, Select, fmtCost, fmtNum, toast } from "../ui";

const message = (error: unknown) => error instanceof Error ? error.message : "Request failed";

export default function ProjectsPage() {
  const admin = () => currentSession()?.user.role === "admin";
  const [projects, { refetch }] = createResource(async () => (await api<{ projects: FinancialProjectDto[] }>("GET", "/api/projects")).projects);
  const readProjects = () => projects.error ? undefined : projects();
  const [users] = createResource(admin, async () => (await api<{ users: { id: string; name: string; email: string }[] }>("GET", "/api/admin/users?limit=500")).users);
  const readUsers = () => users.error ? undefined : users();
  const [selected, setSelected] = createSignal<string>("");
  const project = () => readProjects()?.find((item) => item.id === selected());
  const canManage = () => admin() || (currentSession()?.user.role === "project_manager" && project()?.membership === "manager");
  const [members, { refetch: refetchMembers }] = createResource(() => selected() && canManage() ? selected() : false, async (id) => (await api<{ members: ProjectMemberDto[] }>("GET", `/api/projects/${encodeURIComponent(id)}/members`)).members);
  const readMembers = () => members.error ? undefined : members();
  const [from, setFrom] = createSignal(new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = createSignal(new Date().toISOString().slice(0, 10));
  const [range, setRange] = createSignal({ from: from(), to: to() });
  const [usage, { refetch: refetchUsage }] = createResource(() => selected() && canManage() ? { id: selected(), ...range() } : false, async ({ id, from, to }) => (await api<{ usage: ProjectUsageDto }>("GET", `/api/projects/${encodeURIComponent(id)}/usage?from=${from}&to=${to}`)).usage);
  const readUsage = () => usage.error ? undefined : usage();
  const [editing, setEditing] = createSignal<FinancialProjectDto | "new" | null>(null);
  const [name, setName] = createSignal("");
  const [code, setCode] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [kind, setKind] = createSignal("project");
  const [costCenter, setCostCenter] = createSignal("");
  const [responsible, setResponsible] = createSignal("");
  const [limit, setLimit] = createSignal("");
  const [totalLimit, setTotalLimit] = createSignal("");
  const [status, setStatus] = createSignal("active");
  const [memberId, setMemberId] = createSignal("");
  const [memberRole, setMemberRole] = createSignal("member");
  const [memberSearch, setMemberSearch] = createSignal("");
  const [candidateQuery, setCandidateQuery] = createSignal("");
  const [candidates] = createResource(() => selected() && canManage() && candidateQuery().trim().length >= 2 ? { id: selected(), q: candidateQuery().trim() } : false, async ({ id, q }) => (await api<{ users: { id: string; name: string; email: string }[] }>("GET", `/api/projects/${encodeURIComponent(id)}/member-candidates?q=${encodeURIComponent(q)}`)).users);
  const readCandidates = () => candidates.error ? undefined : candidates();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => {
    policyRevision();
    void refetch();
    if (selected()) void refetchUsage();
  });

  const edit = (item: FinancialProjectDto | "new") => {
    setName(item === "new" ? "" : item.name);
    setCode(item === "new" ? "" : item.code);
    setDescription(item === "new" ? "" : item.description);
    setKind(item === "new" ? "project" : item.kind);
    setCostCenter(item === "new" ? "" : item.costCenterId ?? "");
    setResponsible(item === "new" ? "" : item.responsibleUserId ?? "");
    setLimit(item === "new" ? "" : item.budgets.find((budget) => budget.kind === "monthly")?.limitUsd?.toString() ?? "");
    setTotalLimit(item === "new" ? "" : item.budgets.find((budget) => budget.kind === "lifetime")?.limitUsd?.toString() ?? "");
    setStatus(item === "new" ? "active" : item.status);
    setError("");
    setEditing(item);
  };
  const save = async (event: Event) => {
    event.preventDefault();
    const item = editing();
    if (!item) return;
    setBusy(true); setError("");
    try {
      const payload = { code: code().trim(), name: name().trim(), description: description().trim(), kind: kind(), costCenterId: kind() === "project" ? costCenter() || null : null, responsibleUserId: responsible().trim() || null, monthlyLimitUsd: limit().trim() === "" ? null : Number(limit()), totalLimitUsd: totalLimit().trim() === "" ? null : Number(totalLimit()), status: status() };
      await api(item === "new" ? "POST" : "PATCH", item === "new" ? "/api/projects" : `/api/projects/${encodeURIComponent(item.id)}`, payload);
      setEditing(null); await refetch(); toast("Financial project saved");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const saveMember = async (event: Event) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api("PUT", `/api/projects/${encodeURIComponent(selected())}/members/${encodeURIComponent(memberId().trim())}`, { role: memberRole() });
      setMemberId(""); await refetchMembers(); toast("Membership saved");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const removeMember = async (item: ProjectMemberDto) => {
    setBusy(true); setError("");
    try { await api("DELETE", `/api/projects/${encodeURIComponent(selected())}/members/${encodeURIComponent(item.userId)}`); await refetchMembers(); toast("Membership removed"); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const changeMembership = async (item: ProjectMemberDto, role: string) => {
    setBusy(true); setError("");
    try { await api("PUT", `/api/projects/${encodeURIComponent(selected())}/members/${encodeURIComponent(item.userId)}`, { role }); await refetchMembers(); toast("Project role saved"); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  return <div class="space-y-5">
    <PageTitle title="Financial projects" subtitle="Group gateway consumption and access by project or cost center." right={<Show when={admin()}><Btn onClick={() => edit("new")}>New financial project</Btn></Show>} />
    <p class="text-xs text-ink-400">Projects are optional. Personal API keys work without one. Usage keeps its original project attribution when names, members, or key assignments change.</p>
    <Show when={projects.error}><Card class="p-4"><p role="alert" class="text-sm text-ink-300">{message(projects.error)}</p><Btn size="sm" variant="outline" onClick={() => refetch()}>Retry projects</Btn></Card></Show>
    <Show when={projects.loading && !readProjects()}><p role="status" class="text-sm text-ink-400">Loading financial projects…</p></Show>
    <Show when={readProjects() && !readProjects()!.length}><EmptyState icon={Icons.folder} title="No financial projects" hint={admin() ? "Create a project when you need shared budgets or access policies." : "Your administrator can add you to a financial project."} /></Show>
    <div class="grid gap-4 xl:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
      <div class="space-y-2"><For each={readProjects()}>{(item) => <button type="button" onClick={() => { setSelected(item.id); setError(""); }} aria-pressed={selected() === item.id} class={`w-full text-left p-4 rounded-xl border transition-colors ${selected() === item.id ? "border-accent-500 bg-accent-500/10" : "border-line bg-card hover:bg-elev"}`}>
        <div class="flex flex-wrap justify-between gap-2"><span class="font-medium text-sm text-ink-100 break-words">{item.name}</span><Badge tone={item.status === "active" ? "green" : "zinc"}>{item.status}</Badge></div>
        <p class="text-xs text-ink-400 mt-2">{item.kind === "cost_center" ? "Cost center" : "Project"}{item.membership ? ` · ${item.membership}` : ""}</p>
        <For each={item.budgets}>{(budget) => <div class="text-xs text-ink-300 mt-2"><Show when={currentFinancialPolicy().budgetPresentation === "usd" && budget.limitUsd !== undefined}><p>{budget.kind === "monthly" ? "Monthly" : "Lifetime"}: {fmtCost(budget.spentUsd ?? 0)} used · {budget.limitUsd === null ? "No shared ceiling" : `${fmtCost(budget.limitUsd!)} ceiling`}</p></Show><Show when={currentFinancialPolicy().budgetPresentation === "percent"}><p>{budget.kind === "monthly" ? "Monthly" : "Lifetime"}: {budget.limitConfigured ? budget.usedPercent == null ? "Budget configured" : `${Math.round(budget.usedPercent)}% used` : "No shared ceiling"}</p></Show></div>}</For>
        <Show when={currentFinancialPolicy().budgetPresentation === "hidden"}><p class="text-xs text-ink-400 mt-2">Financial amounts are private.</p></Show>
      </button>}</For></div>
      <Show when={project()}>{(item) => <div class="space-y-4 min-w-0">
        <Card class="p-4 space-y-4"><div class="flex flex-wrap gap-3 justify-between"><div><h2 class="font-semibold text-ink-100 break-words">{item().name}</h2><p class="text-xs text-ink-400 mt-1 break-all">ID: {item().id}</p></div><Show when={admin()}><Btn variant="outline" size="sm" onClick={() => edit(item())}>Edit project</Btn></Show></div>
          <Show when={item().description}><p class="text-sm text-ink-400 break-words">{item().description}</p></Show>
          <Show when={canManage()} fallback={<p class="text-xs text-ink-400">Project reports and member management are available to the assigned project managers.</p>}>
          <form onSubmit={(event) => { event.preventDefault(); setRange({ from: from(), to: to() }); }} class="grid gap-3 items-end sm:flex sm:flex-wrap"><div class="min-w-0 sm:flex-1"><Input label="Usage from" type="date" value={from()} onInput={setFrom} required /></div><div class="min-w-0 sm:flex-1"><Input label="Usage through" type="date" value={to()} onInput={setTo} required /></div><Btn type="submit" size="sm" disabled={usage.loading}>View report</Btn></form>
          <Show when={usage.error}><p role="alert" class="text-sm text-ink-300">{message(usage.error)}</p></Show>
          <Show when={usage.loading}><p role="status" class="text-xs text-ink-400">Loading report…</p></Show>
          <Show when={readUsage()}>{(report) => <dl class="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm"><div><dt class="text-xs text-ink-400">Requests</dt><dd class="font-mono mt-1">{fmtNum(report().requests)}</dd></div><div><dt class="text-xs text-ink-400">Input tokens</dt><dd class="font-mono mt-1">{fmtNum(report().inputTokens)}</dd></div><div><dt class="text-xs text-ink-400">Cache tokens</dt><dd class="font-mono mt-1">{fmtNum(report().cacheTokens)}</dd></div><div><dt class="text-xs text-ink-400">Output tokens</dt><dd class="font-mono mt-1">{fmtNum(report().outputTokens)}</dd></div><div><dt class="text-xs text-ink-400">Errors</dt><dd class="font-mono mt-1">{fmtNum(report().errorRequests)}</dd></div><Show when={currentFinancialPolicy().budgetPresentation === "usd" && report().costUsd !== undefined}><div><dt class="text-xs text-ink-400">Cost</dt><dd class="font-mono mt-1">{fmtCost(report().costUsd!)}</dd></div></Show></dl>}</Show>
          </Show>
        </Card>
        <Show when={canManage()}><Card class="p-4 space-y-4"><h2 class="font-semibold text-sm text-ink-100">Members and managers</h2><p class="text-xs text-ink-400">Administrators assign managers. Project managers can add and remove members in their assigned projects.</p>
          <Show when={members.error}><p role="alert" class="text-sm">{message(members.error)}</p><Btn size="sm" variant="outline" onClick={() => refetchMembers()}>Retry members</Btn></Show>
          <Show when={readMembers() && !readMembers()!.length}><p class="text-xs text-ink-400">No members yet.</p></Show>
          <ul class="divide-y divide-line"><For each={readMembers()}>{(member) => <li class="flex flex-wrap items-center justify-between gap-2 py-3"><div class="min-w-0"><p class="text-sm break-all">{member.name || member.email}</p><p class="text-xs text-ink-400 break-all">{member.email} · {member.role}</p></div><Show when={admin()}><Select ariaLabel={`Role for ${member.email}`} value={member.role} onChange={(role) => !busy() && changeMembership(member, role)} options={[{ value: "member", label: "Member" }, { value: "manager", label: "Manager" }]} /></Show><Show when={admin() || member.role === "member"}><Btn size="sm" variant="outline" disabled={busy()} onClick={() => removeMember(member)}>Remove {member.name || member.email}</Btn></Show></li>}</For></ul>
          <form onSubmit={(event) => { event.preventDefault(); setCandidateQuery(memberSearch()); }} class="flex flex-wrap gap-3 items-end"><div class="flex-1 min-w-0"><Input label="Find a member" value={memberSearch()} onInput={setMemberSearch} hint="Search by name or email, at least 2 characters." /></div><Btn size="sm" variant="outline" type="submit" disabled={memberSearch().trim().length < 2 || candidates.loading}>Search users</Btn></form><Show when={candidates.error}><p role="alert">{message(candidates.error)}</p></Show><Show when={readCandidates() && readCandidates()!.length === 0}><p class="text-xs text-ink-400">No matching active users.</p></Show>
          <form onSubmit={saveMember} class="space-y-3"><Show when={readCandidates()?.length}><Select label="Member account" value={memberId()} onChange={setMemberId} options={[{ value: "", label: "Choose an account" }, ...(readCandidates() ?? []).map((user) => ({ value: user.id, label: `${user.name || user.email} · ${user.email}` }))]} /></Show><Show when={admin()}><Select label="Project membership" value={memberRole()} onChange={setMemberRole} options={[{ value: "member", label: "Member" }, { value: "manager", label: "Manager" }]} /></Show><Btn type="submit" size="sm" disabled={busy() || !memberId().trim()}>Save membership</Btn></form>
        </Card></Show>
        <Show when={error() && !editing()}><p role="alert" class="text-sm text-ink-300">{error()}</p></Show>
      </div>}</Show>
    </div>
    <Modal open={editing() !== null} onClose={() => !busy() && setEditing(null)} title={editing() === "new" ? "New financial project" : "Edit financial project"}>
      <form onSubmit={save} class="space-y-4"><Input label="Project code" value={code()} onInput={setCode} required hint="1–64 letters, numbers, dots, dashes or underscores; start with a letter or digit." /><Input label="Project name" value={name()} onInput={setName} required /><Input label="Project description" value={description()} onInput={setDescription} /><Show when={editing() === "new"} fallback={<p class="text-xs text-ink-400">Scope type: {kind() === "cost_center" ? "Cost center" : "Project"}</p>}><Select label="Scope type" value={kind()} onChange={setKind} options={[{ value: "project", label: "Project" }, { value: "cost_center", label: "Cost center" }]} /></Show>
        <Show when={kind() === "project"}><Select label="Cost center" value={costCenter()} onChange={setCostCenter} options={[{ value: "", label: "No cost center" }, ...(readProjects() ?? []).filter((p) => p.kind === "cost_center" && (p.status === "active" || p.id === costCenter())).map((p) => ({ value: p.id, label: p.name }))]} /></Show>
        <Select label="Responsible user" value={responsible()} onChange={setResponsible} options={[{ value: "", label: "No responsible user" }, ...(readUsers() ?? []).map((user) => ({ value: user.id, label: `${user.name || user.email} · ${user.email}` }))]} hint="Optional. Assign project membership separately." /><Show when={users.error}><p role="alert" class="text-xs">Responsible users could not be loaded. Reload this page to choose a different user.</p></Show><Input label="Shared monthly budget (USD)" type="number" min={0} step="any" value={limit()} onInput={setLimit} hint="Leave empty for no shared ceiling. Account and key limits still apply." /><Input label="Shared lifetime budget (USD)" type="number" min={0} step="any" value={totalLimit()} onInput={setTotalLimit} hint="Optional lifetime ceiling, independent of the monthly budget." />
        <Show when={editing() !== "new"}><Select label="Project status" value={status()} onChange={setStatus} options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} /><ModalNotice>Archiving blocks new project activity and preserves historical records. Key reassignment affects future requests only.</ModalNotice></Show>
        <Show when={error()}><p role="alert" class="text-sm text-ink-300">{error()}</p></Show><div class="flex flex-wrap gap-2 justify-end"><Btn variant="ghost" disabled={busy()} onClick={() => setEditing(null)}>Cancel</Btn><Btn type="submit" disabled={busy() || !name().trim()}>{busy() ? "Saving…" : "Save project"}</Btn></div>
      </form>
    </Modal>
  </div>;
}
