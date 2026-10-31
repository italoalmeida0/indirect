import { CatalogToolbar, CatalogState, CatalogPagination, createCatalog } from "../../catalog";
import { createResource, createSignal, For, Show } from "solid-js";

import { api, type ApiKeyDto, type FinancialProjectDto } from "../../api";
import { PageTitle } from "../../index";
import {
  Badge,
  Btn,
  Card,
  copyWithToast,
  EmptyState,
  IconBtn,
  Icons,
  Modal,
  ModalNotice,
  Select,
  toast,
  fmtDate,
  fmtCost,
  timeUntil,
} from "../../ui";
import { UsageGrid } from "../../aggrid";
import type { ColDef } from "ag-grid-community";

const TONE: Record<
  string,
  { tone: "green" | "red" | "amber" | "zinc"; label: string }
> = {
  active: { tone: "green", label: "Active" },
  revoked: { tone: "red", label: "Revoked" },
  exhausted: { tone: "red", label: "Exhausted" },
  expired: { tone: "zinc", label: "Expired" },
  daily_limit: { tone: "amber", label: "Daily spent" },
  total_limit: { tone: "red", label: "Total spent" },
  zinc: { tone: "zinc", label: "Unknown" },
};

export default function AdminKeysPage() {
  const [projects, { refetch: refetchProjects }] = createResource(async () => (await api<{ projects: FinancialProjectDto[] }>("GET", "/api/projects")).projects);
  const readProjects = () => projects.error ? undefined : projects();
  const [assigning, setAssigning] = createSignal<ApiKeyDto | null>(null);
  const [projectId, setProjectId] = createSignal("");
  const [assignmentError, setAssignmentError] = createSignal("");
  const view = createCatalog<ApiKeyDto>({ storageKey: "llmgw-grid:admin.keys", path: "/api/admin/keys", result: "keys", label: "All API keys", sort: [
    { value: "name:asc", label: "Name A–Z" }, { value: "userEmail:asc", label: "Owner A–Z" }, { value: "createdAt:desc", label: "Newest first" }, { value: "spendTotalUsd:desc", label: "Highest spend" },
  ] });
  const keyCount = view.total;
  const refreshGrid = view.refresh;
  const keysDatasource = view.datasource;
  const [confirmRevoke, setConfirmRevoke] = createSignal<ApiKeyDto | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = createSignal<ApiKeyDto | null>(
    null,
  );
  const [busy, setBusy] = createSignal(false);
  const assign = async () => {
    const key = assigning(); if (!key) return; setBusy(true); setAssignmentError("");
    try { await api("PATCH", `/api/admin/keys/${encodeURIComponent(key.id)}`, { projectId: projectId() || null }); setAssigning(null); refreshGrid(); toast("Key financial project saved"); }
    catch (e) { setAssignmentError(e instanceof Error ? e.message : "Assignment failed"); } finally { setBusy(false); }
  };
  const openAssignment = (key: ApiKeyDto) => { setProjectId(key.projectId ?? ""); setAssignmentError(""); setAssigning(key); };

  const revoke = async () => {
    const k = confirmRevoke();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/keys/${k.id}`);
      toast("Key revoked");
      setConfirmRevoke(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const hardDelete = async () => {
    const k = confirmDelete();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/keys/${k.id}?hard=true`);
      toast("Key permanently deleted");
      setConfirmDelete(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async (k: ApiKeyDto) => {
    try {
      const j = await api<{ token: string }>(
        "GET",
        `/api/admin/keys/${k.id}/reveal`,
      );
      await copyWithToast(j.token);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to copy", "err");
    }
  };

  // ---- grid cells ----

  function NameCell(props: { data?: ApiKeyDto }) {
    return (
      <span class="text-sm text-ink-100 truncate block">{props.data?.name}</span>
    );
  }

  function PrefixCell(props: { data?: ApiKeyDto }) {
    return (
      <code class="text-ink-500 truncate block">{props.data?.prefix}…</code>
    );
  }

  function StatusCell(props: { value?: string }) {
    const st = TONE[props.value ?? ""] ?? TONE.zinc!;
    return <Badge tone={st.tone}>{st.label}</Badge>;
  }

  function ActionsCell(props: { data?: ApiKeyDto }) {
    const k = props.data;
    if (!k) return null;
    return (
      <div class="flex items-center justify-end gap-1">
        <IconBtn icon={Icons.folder} title="Assign financial project" onClick={() => openAssignment(k)} />
        <IconBtn
          icon={Icons.copy}
          title={k.revealable ? "Copy full token" : "Predates reveal support"}
          disabled={!k.revealable}
          onClick={() => copyKey(k)}
        />
        <IconBtn
          icon={Icons.ban}
          title="Revoke key"
          danger
          disabled={k.status === "revoked"}
          onClick={() => setConfirmRevoke(k)}
        />
        <IconBtn
          icon={Icons.trash}
          title="Delete permanently"
          danger
          onClick={() => setConfirmDelete(k)}
        />
      </div>
    );
  }

  const cols: ColDef[] = [
    { field: "name", headerName: "Name", flex: 1.1, minWidth: 160, cellRenderer: NameCell },
    { field: "prefix", headerName: "Prefix", width: 130, cellRenderer: PrefixCell },
    { colId: "financialProject", headerName: "Financial project", width: 170, sortable: false, valueGetter: (p) => p.data?.projectId ? readProjects()?.find((project) => project.id === p.data.projectId)?.name ?? p.data.projectId : "Personal" },
    {
      field: "userEmail",
      headerName: "Owner",
      flex: 1,
      minWidth: 160,
      valueGetter: (p) => p.data?.userEmail ?? p.data?.userId,
    },
    { field: "status", headerName: "Status", width: 130, cellRenderer: StatusCell },
    {
      field: "spendTodayUsd",
      headerName: "Spend today",
      width: 130,
      type: "rightAligned",
      filter: "agNumberColumnFilter",
      cellRenderer: (p: { data?: ApiKeyDto }) => (
        <span class="tabular-nums">
          {fmtCost(p.data?.spendTodayUsd)}
          {p.data?.dailyLimitUsd ? `/${fmtCost(p.data.dailyLimitUsd)}` : ""}
        </span>
      ),
    },
    {
      field: "spendTotalUsd",
      headerName: "Lifetime spend",
      width: 130,
      type: "rightAligned",
      filter: "agNumberColumnFilter",
      cellRenderer: (p: { data?: ApiKeyDto }) => (
        <span class="tabular-nums">
          {fmtCost(p.data?.spendTotalUsd)}
          {p.data?.totalLimitUsd ? `/${fmtCost(p.data.totalLimitUsd)}` : ""}
        </span>
      ),
    },
    {
      field: "expiresAt",
      headerName: "Expires",
      width: 210,
      filter: "agDateColumnFilter",
      valueFormatter: (p) =>
        p.value ? `${fmtDate(p.value)} (${timeUntil(p.value)})` : "Never",
    },
    {
      field: "lastUsedAt",
      headerName: "Last used",
      width: 160,
      filter: "agDateColumnFilter",
      valueFormatter: (p) => (p.value ? fmtDate(p.value) : "Never"),
    },
    {
      colId: "actions",
      headerName: "",
      width: 170,
      cellRenderer: ActionsCell,
      sortable: false,
      filter: false,
      floatingFilter: false,
      resizable: false,
      pinned: "right",
    },
  ];

  return (
    <div class="catalog-page" aria-busy={view.loading()}>
      <PageTitle
        title="All API keys"
        subtitle="Every user's keys — revoke any of them instantly"
      />

      <Modal open={!!assigning()} onClose={() => !busy() && setAssigning(null)} title="Assign financial project"><div class="space-y-4"><p class="text-sm text-ink-300 break-words">{assigning()?.name} · {assigning()?.userEmail ?? assigning()?.userId}</p><Show when={projects.error} fallback={<Select label="Key financial project" value={projectId()} onChange={setProjectId} options={[{ value: "", label: "Personal — no financial project" }, ...(readProjects() ?? []).filter((project) => project.status === "active" || project.id === projectId()).map((project) => ({ value: project.id, label: project.name }))]} />}><p role="alert" class="text-sm">Financial projects could not be loaded.</p><Btn size="sm" variant="outline" onClick={() => refetchProjects()}>Retry projects</Btn></Show><ModalNotice>The key owner must be a member of the selected active project. Reassignment applies to future requests; historical accounting and accepted requests keep their original attribution.</ModalNotice><Show when={assignmentError()}><p role="alert" class="text-sm">{assignmentError()}</p></Show><div class="flex justify-end gap-2"><Btn variant="ghost" disabled={busy()} onClick={() => setAssigning(null)}>Cancel</Btn><Btn disabled={busy() || !!projects.error || projects.loading} onClick={assign}>Save assignment</Btn></div></div></Modal>
      <CatalogToolbar view={view} />
      <CatalogState view={view}><Card>
        <Show when={keyCount() > 0} fallback={<EmptyState icon={Icons.key} title="No matching API keys" hint="Choose another period or adjust your filters." />}>
          <Show when={!view.mobile()}><div class="p-2"><UsageGrid columnDefs={cols} datasource={keysDatasource} cacheBlockSize={25} refreshDeps={view.refreshKey()} storageKey="llmgw-grid:admin.keys" sort={view.sort()} onSortChanged={view.setSort} /></div></Show>
          <Show when={view.mobile()}><div class="catalog-mobile p-3 space-y-3"><For each={view.rows()}>{(key) => <div class="catalog-key-card p-4 rounded-xl border border-line bg-elev space-y-3">
            <div class="flex items-start justify-between gap-3"><div class="min-w-0"><strong class="block text-sm text-ink-100 break-all">{key.name || "Unnamed key"}</strong><span class="block text-xs text-ink-400 break-all mt-1">{key.userEmail || key.userId}</span></div><StatusCell value={key.status} /></div>
            <code class="block text-xs text-ink-500">{key.prefix}…</code>
            <div class="grid grid-cols-2 gap-3 border-t border-line pt-3 text-[11px] text-ink-500"><span>Spend today<strong class="block text-xs text-ink-200 mt-1">{fmtCost(key.spendTodayUsd)}</strong></span><span>Lifetime spend<strong class="block text-xs text-ink-200 mt-1">{fmtCost(key.spendTotalUsd)}</strong></span><span>Expires<strong class="block text-xs text-ink-200 mt-1">{key.expiresAt ? fmtDate(key.expiresAt) : "Permanent"}</strong></span><span>Last used<strong class="block text-xs text-ink-200 mt-1">{key.lastUsedAt ? fmtDate(key.lastUsedAt) : "Never"}</strong></span></div>
            <div class="border-t border-line pt-3"><ActionsCell data={key} /></div>
          </div>}</For><CatalogPagination view={view} /></div></Show>
        </Show>
      </Card></CatalogState>

      <Modal
        open={!!confirmRevoke()}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke user API key"
        subtitle="Administratively revoke this key across all gateway proxies."
        width="max-w-lg"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setConfirmRevoke(null)}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={revoke}
              disabled={busy()}
            >
              {busy() ? "Revoking…" : "Revoke key"}
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Administrative key deactivation">
            Revoke <strong class="text-white">{confirmRevoke()?.name}</strong> belonging to{" "}
            <strong class="text-white">{confirmRevoke()?.userEmail}</strong>?
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Action consequences:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>All client requests using this key will immediately return 401 Unauthorized.</li>
              <li>Active connections will not be renewed.</li>
              <li>Historical usage logs and aggregates will be preserved.</li>
            </ul>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete key permanently"
        subtitle="Permanently remove this key row from the gateway database."
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
              onClick={hardDelete}
              disabled={busy()}
            >
              {busy() ? "Deleting…" : "Delete permanently"}
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Permanent database purge">
            Permanently delete{" "}
            <strong class="text-white">{confirmDelete()?.name}</strong> belonging to{" "}
            <strong class="text-white">{confirmDelete()?.userEmail}</strong>?
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Database purge consequences:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>The API key record is completely erased from SQLite.</li>
              <li>Historical usage event logs and spend aggregates are safely preserved.</li>
              <li>This action cannot be reverted.</li>
            </ul>
          </div>
        </div>
      </Modal>
    </div>
  );
}
