import { UserPlanManager } from "../../billing";
import { CatalogToolbar, CatalogState, CatalogPagination, createCatalog } from "../../catalog";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { api, currentSession, type AdminUserDto, type BillingPlanDto } from "../../api";
import { PageTitle } from "../../chrome";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  Icon,
  IconBtn,
  Icons,
  Modal,
  ModalField,
  ModalNotice,
  ModalSection,
  RoleCardGroup,
  SwitchCard,
  Select,
  fmtCost,
  copyWithToast,
  fmtDate,
  toast,
} from "../../ui";
import { UsageGrid } from "../../aggrid";
import type { ColDef } from "ag-grid-community";
import { UserFinancialPolicy } from "./FinancialPolicies";
import { UserCorporatePolicy } from "./CorporateAuth";

export default function AdminUsersPage() {
  const view = createCatalog<AdminUserDto>({ storageKey: "llmgw-grid:admin.users.list", path: "/api/admin/users", result: "users", label: "Users", sort: [
    { value: "name:asc", label: "Name A–Z" }, { value: "email:asc", label: "Email A–Z" }, { value: "createdAt:desc", label: "Newest first" }, { value: "lastLoginAt:desc", label: "Recently active" }, { value: "keyCount:desc", label: "Most API keys" },
  ] });
  const userCount = view.total;
  const refreshGrid = view.refresh;
  const usersDatasource = view.datasource;

  const [planUser, setPlanUser] = createSignal<AdminUserDto | null>(null);
  const [showCreate, setShowCreate] = createSignal(false);
  const [editing, setEditing] = createSignal<AdminUserDto | null>(null);
  const [policyUser, setPolicyUser] = createSignal<AdminUserDto | null>(null);
  const [policyTab, setPolicyTab] = createSignal("financial");
  const [confirmDelete, setConfirmDelete] = createSignal<AdminUserDto | null>(
    null,
  );
  const [confirmReset2fa, setConfirmReset2fa] =
    createSignal<AdminUserDto | null>(null);
  const [inviteLink, setInviteLink] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const [email, setEmail] = createSignal("");
  const [name, setName] = createSignal("");
  const [role, setRole] = createSignal("user");
  const [sendInvite, setSendInvite] = createSignal(false);
  const [newPlan, setNewPlan] = createSignal("");
  const [plans] = createResource(async () => (await api<{ plans: BillingPlanDto[] }>("GET", "/api/admin/plans")).plans ?? []);

  const meId = () => currentSession()?.user.id;

  // Built once per plan list instead of on every keystroke in the create form.
  const planOptions = createMemo(() => [
    { value: "", label: "Unlimited — no plan" },
    ...(plans.error ? [] : plans() ?? []).map((plan) => ({
      value: plan.id,
      label: `${plan.name} · ${plan.monthlyUsd === null ? "Unlimited" : `${fmtCost(plan.monthlyUsd)} / month`}`,
    })),
  ]);

  // Server returns an absolute link when PUBLIC_URL is configured, otherwise
  // a root-relative one — prefix our own origin only in the relative case.
  const fullLink = (l: string) =>
    l.startsWith("http")
      ? l
      : `${location.origin}${l.startsWith("/") ? l : `/${l}`}`;

  const create = async () => {
    setBusy(true);
    try {
      const j = await api<any>("POST", "/api/admin/users", {
        email: email().trim(),
        name: name().trim(),
        role: role(),
        sendInvite: sendInvite(),
        planId: newPlan() || null,
      });
      setShowCreate(false);
      setEmail("");
      setName("");
      setRole("user");
      setNewPlan("");
      if (j.invite?.sent) {
        toast("User created — invite email sent");
      } else if (j.invite?.link) {
        setInviteLink(fullLink(j.invite.link));
      }
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    const u = editing();
    if (!u) return;
    setBusy(true);
    try {
      await api("PATCH", `/api/admin/users/${u.id}`, {
        name: u.name,
        role: u.role,
        status: u.status,
      });
      toast("User updated");
      setEditing(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const quick = async (u: AdminUserDto, action: string) => {
    try {
      await api("POST", `/api/admin/users/${u.id}/${action}`);
      toast("Done");
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  const reset2fa = async () => {
    const u = confirmReset2fa();
    if (!u) return;
    setBusy(true);
    try {
      await api("POST", `/api/admin/users/${u.id}/reset-2fa`);
      toast("2FA reset");
      setConfirmReset2fa(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const sendReset = async (u: AdminUserDto) => {
    try {
      const j = await api<{ sent: boolean; link: string | null }>(
        "POST",
        `/api/admin/users/${u.id}/send-reset`,
      );
      if (j.sent) toast("Reset email sent");
      else if (j.link) setInviteLink(fullLink(j.link));
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  const remove = async () => {
    const u = confirmDelete();
    if (!u) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/users/${u.id}`);
      toast("User deleted");
      setConfirmDelete(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  // ---- grid cells ----

  function NameCell(props: { data?: AdminUserDto }) {
    return (
      <span class="text-sm text-ink-100 truncate block">
        {props.data?.name || <span class="text-ink-500 font-normal italic">—</span>}
      </span>
    );
  }

  function EmailCell(props: { data?: AdminUserDto }) {
    return (
      <span class="text-ink-500 truncate block">{props.data?.email}</span>
    );
  }

  function RoleCell(props: { data?: AdminUserDto }) {
    const u = props.data;
    if (!u) return null;
    return (
      <>
        <Badge tone={u.role === "admin" ? "indigo" : "zinc"}>
          {u.role === "admin" ? "Admin" : u.role === "project_manager" ? "Project manager" : "User"}
        </Badge>
        <Show when={u.status === "banned"}>
          <Badge tone="red">Banned</Badge>
        </Show>
      </>
    );
  }

  function SecurityCell(props: { data?: AdminUserDto }) {
    const u = props.data;
    if (!u) return null;
    return (
      <div class="flex items-center gap-1.5 whitespace-nowrap">
        <Show when={u.hasPassword}>
          <span title="Password configured" class="inline-flex text-fg-secondary">
            <Icon name={Icons.key} size={13} />
          </span>
        </Show>
        <Show when={u.totpEnabled}>
          <span title="Two-factor authentication active" class="inline-flex text-success">
            <Icon name={Icons.shield} size={13} />
          </span>
        </Show>
        <Show when={u.googleLinked}>
          <span title="Google account linked" class="inline-flex text-accent font-medium text-xs">
            G
          </span>
        </Show>
        <Show when={!u.hasPassword && !u.totpEnabled && !u.googleLinked}>
          <span class="text-xs text-fg-muted">—</span>
        </Show>
      </div>
    );
  }

  function ActionsCell(props: { data?: AdminUserDto }) {
    const u = props.data;
    if (!u) return null;
    return (
      <div class="flex items-center justify-end gap-1">
        <IconBtn icon="lucide:wallet" title="Manage plan and resets" onClick={() => setPlanUser(u)} />
        <IconBtn
          icon={Icons.edit}
          title="Edit"
          onClick={() => setEditing({ ...u })}
        />
        <IconBtn
          icon={Icons.key}
          title="Send password reset link"
          onClick={() => sendReset(u)}
        />
        <IconBtn
          icon={Icons.logout}
          title="Revoke all sessions"
          onClick={() => quick(u, "revoke-sessions")}
        />
        <Show when={u.totpEnabled}>
          <IconBtn
            icon={Icons.shield}
            title="Reset 2FA"
            onClick={() => setConfirmReset2fa(u)}
          />
        </Show>
        <Show when={u.id !== meId()}>
          <IconBtn
            icon={Icons.trash}
            title="Delete user"
            danger
            onClick={() => setConfirmDelete(u)}
          />
        </Show>
      </div>
    );
  }

  const cols: ColDef[] = [
    { field: "name", headerName: "Name", flex: 1, minWidth: 160, cellRenderer: NameCell },
    { field: "email", headerName: "Email", flex: 1.2, minWidth: 200, cellRenderer: EmailCell },
    { field: "planName", headerName: "Plan", minWidth: 130, valueFormatter: (p) => p.value || "Unlimited" },
    { field: "role", headerName: "Role", width: 150, cellRenderer: RoleCell },
    {
      colId: "security",
      headerName: "Security",
      width: 110,
      cellRenderer: SecurityCell,
      filter: false,
      floatingFilter: false,
    },
    { field: "keyCount", headerName: "Keys", width: 90, type: "rightAligned", filter: "agNumberColumnFilter" },
    {
      field: "lastLoginAt",
      headerName: "Last login",
      width: 170,
      filter: "agDateColumnFilter",
      valueFormatter: (p) => (p.value ? fmtDate(p.value) : "Never"),
    },
    {
      colId: "actions",
      headerName: "",
      width: 240,
      minWidth: 240,
      cellRenderer: ActionsCell,
      sortable: false,
      filter: false,
      floatingFilter: false,
      resizable: false,
      pinned: typeof window !== "undefined" && window.innerWidth >= 1024 ? "right" : undefined,
    },
  ];

  return (
    <div class="catalog-page" aria-busy={view.loading()}>
      <PageTitle
        title="Users"
        subtitle="Accounts, roles and spending plans across this installation."
        right={
          <Btn onClick={() => setShowCreate(true)}>
            <Icon name={Icons.plus} /> New user
          </Btn>
        }
      />

      <UserPlanManager user={planUser()} close={() => setPlanUser(null)} changed={refreshGrid} />
      <CatalogToolbar view={view} />
      <CatalogState view={view}><Card>
        <Show when={userCount() > 0} fallback={<EmptyState icon={Icons.users} title="No matching users" hint="Adjust your filters or create a new user." />}>
          <Show when={!view.mobile()}><div class="p-2"><UsageGrid columnDefs={cols} datasource={usersDatasource} cacheBlockSize={25} refreshDeps={view.refreshKey()} storageKey="llmgw-grid:admin.users.list" sort={view.sort()} onSortChanged={view.setSort} /></div></Show>
          <Show when={view.mobile()}><div class="catalog-mobile p-3 space-y-3"><For each={view.rows()}>
              {(u) => (
                <div class="p-4 rounded-control border border-line bg-surface-muted space-y-3 shadow-xs">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-medium text-fg truncate">{u.name || u.email}</span>
                        <Badge tone={u.role === "admin" ? "indigo" : "zinc"}>{u.role}</Badge>
                      </div>
                      <div class="text-xs text-fg-secondary truncate mt-0.5">{u.email}</div>
                    </div>
                    <div class="text-right shrink-0 text-xs text-fg-secondary">
                      <div>Keys: {u.keyCount}</div><div>{u.planName ?? "Unlimited"}</div>
                      <div>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : "Never logged in"}</div>
                    </div>
                  </div>

                  <div class="pt-2 border-t border-line flex items-center justify-between text-xs text-fg-secondary">
                    <div class="flex items-center gap-1.5">
                      <span class="text-xs">Security:</span>
                      <SecurityCell data={u} />
                    </div>
                    <div class="flex items-center gap-1">
                      <IconBtn icon="lucide:wallet" title="Manage plan and resets" onClick={() => setPlanUser(u)} />
                      <button
                        type="button"
                        class="ui-button ui-button-outline ui-button-sm"
                        onClick={() => setEditing({ ...u })}
                      >
                        <Icon name={Icons.edit} size={14} /> Edit
                      </button>
                      <IconBtn
                        icon={Icons.key}
                        title="Send password reset link"
                        onClick={() => sendReset(u)}
                      />
                      <Show when={u.id !== meId()}>
                        <IconBtn
                          icon={Icons.trash}
                          title="Delete user"
                          danger
                          onClick={() => setConfirmDelete(u)}
                        />
                      </Show>
                    </div>
                  </div>
                </div>
              )}
            </For><CatalogPagination view={view} /></div></Show>
        </Show>
      </Card></CatalogState>

      {/* create modal */}
      <Modal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        title="Create user"
        subtitle="Provision a new user account with dedicated API keys and rate limits."
        width="max-w-lg"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              onClick={create}
              disabled={busy() || !email().trim() || !name().trim()}
            >
              {busy() ? "Creating…" : "Create user"}
            </Btn>
          </>
        }
      >
        <div class="space-y-6">
          {/* Exclusive Live Identity Passport & RBAC Capabilities Matrix */}
          <div class="rounded-xl border border-line bg-surface-subtle p-3.5 space-y-3" aria-hidden="true">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-xl bg-accent-subtle border border-accent/40 text-accent font-mono text-xs font-medium flex items-center justify-center shrink-0">
                  {(name().trim() || email().trim() || "U").slice(0, 2).toUpperCase()}
                </div>
                <div class="min-w-0">
                  <div class="text-xs font-medium text-fg truncate">
                    {name().trim() || "New Gateway Member"}
                  </div>
                  <div class="text-[11px] font-mono text-fg-muted truncate">
                    {email().trim() || "name@example.com"}
                  </div>
                </div>
              </div>
              <Badge tone={role() === "admin" ? "indigo" : role() === "project_manager" ? "amber" : "green"}>
                {role() === "admin" ? "Administrator" : role() === "project_manager" ? "Project Manager" : "Standard User"}
              </Badge>
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px]">
              <For
                each={[
                  { label: "Personal Keys", granted: true },
                  { label: "Project Members", granted: role() === "project_manager" || role() === "admin" },
                  { label: "Model Registry", granted: role() === "admin" },
                  { label: "Billing & Org", granted: role() === "admin" },
                ]}
              >
                {(cap) => (
                  <div
                    class={`rounded-md border px-2 py-1 flex items-center justify-between gap-1 ${
                      cap.granted
                        ? "border-accent/35 bg-surface text-fg"
                        : "border-line bg-surface/40 text-fg-muted opacity-60"
                    }`}
                  >
                    <span class="truncate font-medium">{cap.label}</span>
                    <span class="font-mono">{cap.granted ? "✓" : "—"}</span>
                  </div>
                )}
              </For>
            </div>
          </div>

          <ModalSection
            title="User Credentials"
            subtitle="Account login email and display identity."
          >
            <div class="space-y-3.5">
              <ModalField label="Email address">
                <input
                  type="email"
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                  placeholder="name@example.com"
                  class="ui-field"
                />
              </ModalField>

              <ModalField label="Full name">
                <input
                  type="text"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder="e.g. Alice Smith"
                  class="ui-field"
                />
              </ModalField>

              <Select label="Spending plan" value={newPlan()} onChange={setNewPlan} options={planOptions()} />
              <RoleCardGroup
                label="Gateway role"
                hint="Determines access to the admin dashboard and registry controls."
                value={role()}
                onChange={(v) => setRole(v as "user" | "project_manager" | "admin")}
                options={[
                  { value: "user", label: "User", description: "Personal keys & projects", icon: Icons.users },
                  { value: "project_manager", label: "Project manager", description: "Manage assigned projects", icon: Icons.folder },
                  { value: "admin", label: "Admin", description: "Full gateway control", icon: Icons.shield },
                ]}
              />
            </div>
          </ModalSection>

          <ModalSection
            title="Onboarding & Delivery"
            subtitle="Invitation link and initial credentials."
          >
            <SwitchCard
              checked={sendInvite()}
              onChange={setSendInvite}
              title="Send invitation email"
              description="Sends an invite with password-setup link. If SMTP is not configured, an action link is shown immediately after creation."
            />
          </ModalSection>
        </div>
      </Modal>

      {/* edit modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={`Edit ${editing()?.email ?? ""}`}
        subtitle="Modify user display name, administrative role, and account authorization status."
        width="max-w-lg"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              onClick={saveEdit}
              disabled={busy() || !editing()?.name.trim()}
            >
              {busy() ? "Saving…" : "Save changes"}
            </Btn>
          </>
        }
      >
        <Show when={editing()}>
          {(u) => (
            <div class="space-y-6">
              {/* Exclusive Live Identity Passport & RBAC Capabilities Matrix */}
              <div class="rounded-xl border border-line bg-surface-subtle p-3.5 space-y-3" aria-hidden="true">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-center gap-3 min-w-0">
                    <div
                      class={`w-10 h-10 rounded-xl border font-mono text-xs font-medium flex items-center justify-center shrink-0 ${
                        u().status === "banned"
                          ? "bg-danger-subtle border-danger/40 text-danger"
                          : "bg-accent-subtle border-accent/40 text-accent"
                      }`}
                    >
                      {(u().name.trim() || u().email.trim() || "U").slice(0, 2).toUpperCase()}
                    </div>
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-fg truncate">{u().name || u().email}</div>
                      <div class="text-[11px] font-mono text-fg-muted truncate">{u().email}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <Badge tone={u().status === "active" ? "green" : "red"}>{u().status}</Badge>
                    <Badge tone={u().role === "admin" ? "indigo" : "zinc"}>{u().role}</Badge>
                  </div>
                </div>

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px]">
                  <For
                    each={[
                      { label: "Personal Keys", granted: u().status === "active" },
                      { label: "Project Members", granted: u().status === "active" && (u().role === "project_manager" || u().role === "admin") },
                      { label: "Model Registry", granted: u().status === "active" && u().role === "admin" },
                      { label: "Billing & Org", granted: u().status === "active" && u().role === "admin" },
                    ]}
                  >
                    {(cap) => (
                      <div
                        class={`rounded-md border px-2 py-1 flex items-center justify-between gap-1 ${
                          cap.granted
                            ? "border-accent/35 bg-surface text-fg"
                            : "border-line bg-surface/40 text-fg-muted opacity-60"
                        }`}
                      >
                        <span class="truncate font-medium">{cap.label}</span>
                        <span class="font-mono">{cap.granted ? "✓" : "✕"}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <ModalSection
                title="Account Information"
                subtitle="Primary identity and access privileges."
              >
                <div class="space-y-3.5">
                  <ModalField label="Display name">
                    <input
                      type="text"
                      value={u().name}
                      onInput={(e) => setEditing({ ...u(), name: e.currentTarget.value })}
                      class="ui-field"
                    />
                  </ModalField>

                  <RoleCardGroup
                    label="Gateway role"
                    value={u().role}
                    onChange={(v) => setEditing({ ...u(), role: v as "user" | "project_manager" | "admin" })}
                    options={[
                      { value: "user", label: "User", description: "Personal keys & projects", icon: Icons.users },
                      { value: "project_manager", label: "Project manager", description: "Manage assigned projects", icon: Icons.folder },
                      { value: "admin", label: "Admin", description: "Full gateway control", icon: Icons.shield },
                    ]}
                  />
                  <p class="text-xs text-ink-400">Project managers can manage members only in financial projects where they have manager membership. They do not gain administration access.</p>
                  <div class="rounded-lg border border-line p-3 space-y-2"><p class="text-xs text-ink-400 break-all">User ID: {u().id}</p><Btn size="sm" variant="outline" onClick={() => { setPolicyUser(u()); setPolicyTab("financial"); setEditing(null); }}>Financial and corporate access</Btn></div>

                  <RoleCardGroup
                    label="Account status"
                    hint="Banning immediately revokes active sessions and blocks all proxy keys."
                    columns={2}
                    value={u().status}
                    onChange={(v) => setEditing({ ...u(), status: v as "active" | "banned" })}
                    options={[
                      { value: "active", label: "Active", description: "Authenticated & permitted", icon: Icons.check, tone: "success" },
                      { value: "banned", label: "Banned", description: "All sessions & keys blocked", icon: Icons.ban, tone: "danger" },
                    ]}
                  />
                </div>
              </ModalSection>
            </div>
          )}
        </Show>
      </Modal>

      {/* invite/reset link modal (SMTP absent) */}
      <Modal
        open={!!inviteLink()}
        onClose={() => setInviteLink("")}
        title="Account action link"
        subtitle="SMTP is not configured on this instance. Copy and share this secure one-time onboarding link."
        width="max-w-lg"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => copyWithToast(inviteLink())}
            >
              <Icon name={Icons.copy} size={13} />
              <span>Copy link</span>
            </Btn>
            <Btn
              size="sm"
              onClick={() => setInviteLink("")}
            >
              Done
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <div class="rounded-control border border-line bg-surface-muted p-3.5 space-y-2">
            <div class="text-xs text-fg-secondary font-medium">One-time setup URL</div>
            <code class="block font-mono text-xs text-success break-all select-all bg-surface p-2.5 rounded-lg border border-line/60">
              {inviteLink()}
            </code>
          </div>

          <ModalNotice tone="info" title="Manual distribution required">
            Since outbound email is disabled, deliver this URL to the user securely. It will expire after first use.
          </ModalNotice>
        </div>
      </Modal>

      {/* reset-2FA confirm */}
      <Modal
        open={!!confirmReset2fa()}
        onClose={() => setConfirmReset2fa(null)}
        title="Reset 2FA"
        subtitle="Remove two-factor authentication requirement for this account."
        width="max-w-lg"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setConfirmReset2fa(null)}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={reset2fa}
              disabled={busy()}
            >
              Reset 2FA
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="warn" title="Reset TOTP authentication">
            Reset two-factor authentication for <strong class="text-fg font-medium">{confirmReset2fa()?.email}</strong>? Their existing authenticator app keys will be discarded.
          </ModalNotice>
          <div class="rounded-control border border-line bg-surface-muted p-3.5 space-y-2 text-xs text-fg-secondary">
            <div class="font-medium text-fg">Security reset outcome:</div>
            <ul class="list-disc list-inside space-y-1 text-fg-secondary pl-1">
              <li>TOTP secret will be wiped from the account.</li>
              <li>Active sessions will remain logged in.</li>
              <li>The user will be prompted to enroll a new authenticator upon their next login.</li>
            </ul>
          </div>
        </div>
      </Modal>

      {/* delete confirm */}
      <Modal open={!!policyUser()} onClose={() => setPolicyUser(null)} title={`Access policy: ${policyUser()?.email ?? ""}`}>
        <Show when={policyUser()}>{(user) => <div class="space-y-4"><Select label="User access settings" value={policyTab()} onChange={setPolicyTab} options={[{ value: "financial", label: "Financial visibility" }, { value: "corporate", label: "Corporate identity" }]} /><Show when={policyTab() === "financial"}><UserFinancialPolicy userId={user().id} /></Show><Show when={policyTab() === "corporate"}><UserCorporatePolicy userId={user().id} /></Show></div>}</Show>
      </Modal>
      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete user"
        subtitle="Permanently delete this user account, their API keys, and active sessions."
        width="max-w-lg"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={remove}
              disabled={busy()}
            >
              Delete user
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Confirm account deletion">
            Delete <strong class="text-fg font-medium">{confirmDelete()?.email}</strong>? All their active sessions,
            gateway API keys, and authentication credentials will be permanently erased.
          </ModalNotice>
          <div class="rounded-control border border-line bg-surface-muted p-3.5 space-y-2 text-xs text-fg-secondary">
            <div class="font-medium text-fg">Permanent erasure details:</div>
            <ul class="list-disc list-inside space-y-1 text-fg-secondary pl-1">
              <li>User row, password hashes, and TOTP secrets are permanently removed.</li>
              <li>All gateway API keys owned by this user are deleted.</li>
              <li>Historical usage records remain safely kept for audit and financial accounting.</li>
            </ul>
          </div>
        </div>
      </Modal>
    </div>
  );
}
