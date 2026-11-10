import { CatalogToolbar, CatalogState, CatalogPagination, createCatalog } from "../catalog";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";

import {
  api,
  currentFinancialPolicy,
  type ApiKeyDto,
  type HiddenApiKeyDto,
  type PercentApiKeyDto,
  type ProjectedApiKeyDto,
  type FinancialProjectDto,
} from "../api";
import { PageTitle } from "../chrome";
import {
  Badge,
  Btn,
  Card,
  CopyButton,
  CurrencyField,
  DateTimePicker,
  EmptyState,
  FilterChip,
  Icon,
  IconBtn,
  Icons,
  Modal,
  ModalField,
  ModalNotice,
  ModalSection,
  OrDivider,
  ProgressBar,
  StepperField,
  Select,
  SwitchCard,
  Tabs,
  copyWithToast,
  fmtDate,
  fmtCost,
  timeUntil,
  toast,
} from "../ui";
import { UsageGrid } from "../aggrid";
import type { ColDef } from "ag-grid-community";

const STATUS_TONE: Record<
  string,
  { tone: "green" | "red" | "amber" | "zinc"; label: string }
> = {
  active: { tone: "green", label: "Active" },
  revoked: { tone: "red", label: "Revoked" },
  exhausted: { tone: "red", label: "Budget exhausted" },
  expired: { tone: "zinc", label: "Expired" },
  daily_limit: { tone: "amber", label: "Daily budget spent" },
  total_limit: { tone: "red", label: "Total budget spent" },
  zinc: { tone: "zinc", label: "Unknown" },
};

const EXPIRY_PRESETS = [
  { value: "never", label: "Permanent" },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "24 hours" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
  { value: "custom", label: "Custom date…" },
];

interface KeyFormState {
  name: string;
  preset: string;
  customDate: string;
  dailyLimitUsd: string;
  totalLimitUsd: string;
  rpm: string;
  projectId: string;
}

function isUsdKey(k: ProjectedApiKeyDto): k is ApiKeyDto {
  return "spendTotalUsd" in k;
}

function isPercentKey(k: ProjectedApiKeyDto): k is PercentApiKeyDto {
  return k.presentation === "percent";
}

function isHiddenKey(k: ProjectedApiKeyDto): k is HiddenApiKeyDto {
  return k.presentation === "hidden";
}

function computeExpiresAt(f: KeyFormState): number | null {
  if (f.preset === "never") return null;
  if (f.preset === "custom") {
    const t = new Date(f.customDate).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return Date.now() + Number(f.preset) * 1000;
}

const BASE_KEY_SORTS = [
  { value: "name:asc", label: "Name A–Z" },
  { value: "createdAt:desc", label: "Newest first" },
  { value: "createdAt:asc", label: "Oldest first" },
  { value: "lastUsedAt:desc", label: "Recently used" },
];

export default function KeysPage() {
  const [projects] = createResource(async () => (await api<{ projects: FinancialProjectDto[] }>("GET", "/api/projects")).projects);
  const readProjects = () => projects.error ? undefined : projects();
  const presentation = createMemo(() => currentFinancialPolicy().budgetPresentation);
  const showUsd = createMemo(() => presentation() === "usd");
  const showPercent = createMemo(() => presentation() === "percent");
  const sortOptions = createMemo(() =>
    showUsd()
      ? [...BASE_KEY_SORTS, { value: "spendTotalUsd:desc", label: "Highest spend" }]
      : BASE_KEY_SORTS,
  );
  const view = createCatalog<ProjectedApiKeyDto>({
    storageKey: "llmgw-grid:keys.user",
    path: "/api/keys",
    result: "keys",
    label: "API keys",
    sort: sortOptions,
  });
  createEffect(() => {
    if (!showUsd()) {
      const next = view.sort().filter((s) => s.colId !== "spendTotalUsd" && s.colId !== "spendTodayUsd");
      if (next.length !== view.sort().length) view.setSort(next);
    }
  });
  const keyCount = view.total;
  const refreshGrid = view.refresh;
  const keysDatasource = view.datasource;

  const [showCreate, setShowCreate] = createSignal(false);
  const [editing, setEditing] = createSignal<ProjectedApiKeyDto | null>(null);
  const [newToken, setNewToken] = createSignal("");
  const [confirmRevoke, setConfirmRevoke] = createSignal<ProjectedApiKeyDto | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = createSignal<ProjectedApiKeyDto | null>(
    null,
  );
  const [busy, setBusy] = createSignal(false);
  const [snippetTab, setSnippetTab] = createSignal<"curl" | "python" | "node">("curl");

  const [form, setForm] = createSignal<KeyFormState>({
    name: "",
    preset: "never",
    customDate: "",
    dailyLimitUsd: "",
    totalLimitUsd: "",
    rpm: "",
    projectId: "",
  });

  const resetForm = () =>
    setForm({
      name: "",
      preset: "never",
      customDate: "",
      dailyLimitUsd: "",
      totalLimitUsd: "",
      rpm: "",
      projectId: "",
    });

  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  const create = async () => {
    if (!form().name.trim()) return toast("Name is required", "err");
    setBusy(true);
    try {
      const expiresAt = computeExpiresAt(form());
      const payload: Record<string, unknown> = {
        name: form().name.trim(),
        expiresAt,
        rpm: num(form().rpm),
        projectId: form().projectId || null,
      };
      if (showUsd()) {
        payload.dailyLimitUsd = num(form().dailyLimitUsd);
        payload.totalLimitUsd = num(form().totalLimitUsd);
      }
      const j = await api<{ token: string }>("POST", "/api/keys", payload);
      setNewToken(j.token);
      setShowCreate(false);
      resetForm();
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to create key", "err");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (k: ProjectedApiKeyDto) => {
    setForm({
      name: k.name,
      preset: "never",
      customDate: "",
      dailyLimitUsd: isUsdKey(k) ? (k.dailyLimitUsd?.toString() ?? "") : "",
      totalLimitUsd: isUsdKey(k) ? (k.totalLimitUsd?.toString() ?? "") : "",
      rpm: k.rpm?.toString() ?? "",
      projectId: k.projectId ?? "",
    });
    setEditing(k);
  };

  const saveEdit = async () => {
    const k = editing();
    if (!k) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form().name.trim(),
        rpm: num(form().rpm),
        projectId: form().projectId || null,
      };
      if (showUsd()) {
        payload.dailyLimitUsd = num(form().dailyLimitUsd);
        payload.totalLimitUsd = num(form().totalLimitUsd);
      }
      await api("PATCH", `/api/keys/${k.id}`, payload);
      toast("Key updated");
      setEditing(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to update", "err");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const k = confirmRevoke();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/keys/${k.id}`);
      toast("Key revoked");
      setConfirmRevoke(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to revoke", "err");
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async (k: ProjectedApiKeyDto) => {
    try {
      const j = await api<{ token: string }>("GET", `/api/keys/${k.id}/reveal`);
      await copyWithToast(j.token);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to copy", "err");
    }
  };

  const hardDelete = async () => {
    const k = confirmDelete();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/keys/${k.id}?hard=true`);
      toast("Key permanently deleted");
      setConfirmDelete(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to delete", "err");
    } finally {
      setBusy(false);
    }
  };

  // ---- grid cells ----

  function NameCell(props: { data?: ProjectedApiKeyDto }) {
    return (
      <span class="text-sm font-medium text-ink-100 truncate block">
        {props.data?.name}
      </span>
    );
  }

  function PrefixCell(props: { data?: ProjectedApiKeyDto }) {
    return (
      <code class="text-[11px] text-ink-500 truncate block">
        {props.data?.prefix}…
      </code>
    );
  }

  function StatusBadgeCell(props: { value?: string }) {
    const st = STATUS_TONE[props.value ?? ""] ?? STATUS_TONE.zinc!;
    return <Badge tone={st.tone}>{st.label}</Badge>;
  }

  /** Budget usage cell supporting usd, percent, and hidden presentation contracts. */
  function BudgetCell(props: { data?: ProjectedApiKeyDto; kind?: "today" | "total" }) {
    const k = props.data;
    if (!k) return null;
    const today = props.kind === "today";
    if (isUsdKey(k)) {
      const used = today ? k.spendTodayUsd : k.spendTotalUsd;
      const limit = today ? k.dailyLimitUsd : k.totalLimitUsd;
      return (
        <div class="flex items-center justify-end gap-2 w-full pr-1">
          <span class="tabular-nums whitespace-nowrap text-xs text-right">
            {fmtCost(used)}
            <span class="text-ink-500 font-normal"> / {limit !== null ? fmtCost(limit) : "Unlimited"}</span>
          </span>
          <div class="w-16 shrink-0 flex items-center justify-center">
            {limit !== null ? (
              <ProgressBar danger value={used} max={limit} />
            ) : (
              <span class="text-[10px] text-ink-600 font-mono leading-none">—</span>
            )}
          </div>
        </div>
      );
    }
    if (isPercentKey(k)) {
      const configured = today ? k.dailyLimitConfigured : k.totalLimitConfigured;
      const pct = today ? k.dailyUsedPercent : k.totalUsedPercent;
      if (!configured) {
        return (
          <div class="flex items-center justify-end gap-2 w-full pr-1">
            <span class="text-xs text-ink-500">Unlimited</span>
            <div class="w-16 shrink-0 flex items-center justify-center">
              <span class="text-[10px] text-ink-600 font-mono leading-none">—</span>
            </div>
          </div>
        );
      }
      const safePct = Math.max(0, Math.min(100, pct ?? 0));
      return (
        <div class="flex items-center justify-end gap-2 w-full pr-1">
          <span class="tabular-nums whitespace-nowrap text-xs text-right">
            {safePct.toLocaleString("en", { maximumFractionDigits: 1 })}%
            <span class="text-ink-500 font-normal"> used</span>
          </span>
          <div class="w-16 shrink-0 flex items-center justify-center">
            <ProgressBar danger value={safePct} max={100} />
          </div>
        </div>
      );
    }
    if (isHiddenKey(k)) {
      const configured = today ? k.dailyLimitConfigured : k.totalLimitConfigured;
      return (
        <div class="flex items-center justify-end w-full pr-1">
          <span class="text-xs text-ink-400">{configured ? "Managed cap" : "No key cap"}</span>
        </div>
      );
    }
    return null;
  }

  function ActionsCell(props: { data?: ProjectedApiKeyDto }) {
    const k = props.data;
    if (!k) return null;
    return (
      <div class="flex items-center justify-end gap-1">
        <IconBtn
          icon={Icons.copy}
          title={
            k.revealable
              ? "Copy full token"
              : "Created before reveal support — rotate it to get a copyable token"
          }
          disabled={!k.revealable}
          onClick={() => copyKey(k)}
        />
        <IconBtn
          icon={Icons.edit}
          title="Edit"
          disabled={k.status === "revoked"}
          onClick={() => openEdit(k)}
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

  const cols = createMemo<ColDef[]>(() => {
    const budgetCols: ColDef[] = showUsd()
      ? [
          {
            field: "spendTodayUsd",
            headerName: "Spend today",
            width: 170,
            filter: "agNumberColumnFilter",
            cellRenderer: BudgetCell,
            cellRendererParams: { kind: "today" },
          },
          {
            field: "spendTotalUsd",
            headerName: "Lifetime spend",
            width: 170,
            filter: "agNumberColumnFilter",
            cellRenderer: BudgetCell,
            cellRendererParams: { kind: "total" },
          },
        ]
      : showPercent()
        ? [
            {
              colId: "dailyAllowance",
              headerName: "Daily allowance",
              width: 170,
              sortable: false,
              filter: false,
              cellRenderer: BudgetCell,
              cellRendererParams: { kind: "today" },
            },
            {
              colId: "lifetimeAllowance",
              headerName: "Lifetime allowance",
              width: 170,
              sortable: false,
              filter: false,
              cellRenderer: BudgetCell,
              cellRendererParams: { kind: "total" },
            },
          ]
        : [];
    return [
      { field: "name", headerName: "Name", flex: 1.2, minWidth: 160, cellRenderer: NameCell },
      { field: "prefix", headerName: "Prefix", width: 130, cellRenderer: PrefixCell },
      { field: "status", headerName: "Status", width: 160, cellRenderer: StatusBadgeCell },
      ...budgetCols,
      {
        field: "expiresAt",
        headerName: "Expires",
        width: 200,
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
        field: "rpm",
        headerName: "RPM",
        width: 100,
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.value ?? "default"),
      },
      {
        colId: "actions",
        headerName: "",
        width: 160,
        cellRenderer: ActionsCell,
        sortable: false,
        filter: false,
        floatingFilter: false,
        resizable: false,
        pinned: typeof window !== "undefined" && window.innerWidth >= 1024 ? "right" : undefined,
      },
    ];
  });

  return (
    <div class="catalog-page" aria-busy={view.loading()}>
      <PageTitle
        title="API keys"
        subtitle="Create and manage keys that authenticate your gateway traffic."
        right={
          <Btn onClick={() => setShowCreate(true)}>
            <Icon name={Icons.plus} /> New key
          </Btn>
        }
      />

      <CatalogToolbar view={view} />
      <CatalogState view={view}><Card>
        <Show when={keyCount() > 0} fallback={<EmptyState icon={Icons.key} title="No matching API keys" hint="Adjust your filters or create a new key." />}>
          <Show when={!view.mobile()}><div class="p-2"><Show when={presentation()} keyed>{(_mode) => <UsageGrid columnDefs={cols()} datasource={keysDatasource} cacheBlockSize={25} refreshDeps={view.refreshKey()} storageKey="llmgw-grid:keys.user" sort={view.sort()} onSortChanged={view.setSort} />}</Show></div></Show>
          <Show when={view.mobile()}><div class="catalog-mobile p-3 space-y-3"><For each={view.rows()}>
                  {(k) => (
                    <div class="p-4 rounded-control border border-line bg-surface-muted space-y-3 shadow-xs">
                      {/* Key name full width without premature ellipsis */}
                      <div class="space-y-1.5">
                        <div class="flex items-start justify-between gap-2">
                          <h4 class="text-sm font-medium text-fg break-normal min-w-0">{k.name}</h4>
                          <span class="text-xs text-fg-secondary shrink-0 font-mono">
                            {k.expiresAt ? `Exp: ${fmtDate(k.expiresAt)}` : "Permanent"}
                          </span>
                        </div>
                        <div class="flex items-center justify-between text-xs gap-2">
                          <div class="flex items-center gap-2">
                            <code class="text-xs font-mono text-fg-secondary bg-surface px-2 py-0.5 rounded border border-line/60">{k.prefix}…</code>
                            <Badge tone={k.status === "active" ? "green" : k.status === "exhausted" ? "amber" : "zinc"}>
                              {k.status}
                            </Badge>
                          </div>
                          <span class="text-xs text-fg-muted">
                            {k.lastUsedAt ? `Used: ${fmtDate(k.lastUsedAt)}` : "Never used"}
                          </span>
                        </div>
                      </div>

                      <Show when={isUsdKey(k) && (k.totalLimitUsd !== null || k.dailyLimitUsd !== null)}>
                        <div class="pt-2 border-t border-line/50 space-y-1.5 text-xs text-fg-secondary">
                          <Show when={isUsdKey(k) && k.dailyLimitUsd !== null}>
                            <div class="flex justify-between">
                              <span>Daily limit</span>
                              <span class="font-mono text-fg">{isUsdKey(k) ? fmtCost(k.dailyLimitUsd!) : ""}</span>
                            </div>
                          </Show>
                          <Show when={isUsdKey(k) && k.totalLimitUsd !== null}>
                            <div class="flex justify-between">
                              <span>Total cap</span>
                              <span class="font-mono text-fg">{isUsdKey(k) ? `${fmtCost(k.spendTotalUsd)} / ${fmtCost(k.totalLimitUsd!)}` : ""}</span>
                            </div>
                          </Show>
                        </div>
                      </Show>

                      <Show when={isPercentKey(k) && (k.totalLimitConfigured || k.dailyLimitConfigured)}>
                        <div class="pt-2 border-t border-line/50 space-y-1.5 text-xs text-fg-secondary">
                          <Show when={isPercentKey(k) && k.dailyLimitConfigured}>
                            <div class="flex justify-between">
                              <span>Daily allowance</span>
                              <span class="font-mono text-fg">{isPercentKey(k) ? `${(k.dailyUsedPercent ?? 0).toLocaleString("en", { maximumFractionDigits: 1 })}% used` : ""}</span>
                            </div>
                          </Show>
                          <Show when={isPercentKey(k) && k.totalLimitConfigured}>
                            <div class="flex justify-between">
                              <span>Lifetime allowance</span>
                              <span class="font-mono text-fg">{isPercentKey(k) ? `${(k.totalUsedPercent ?? 0).toLocaleString("en", { maximumFractionDigits: 1 })}% used` : ""}</span>
                            </div>
                          </Show>
                        </div>
                      </Show>

                      <div class="pt-2 border-t border-line/60 flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          class="ui-button ui-button-outline ui-button-sm"
                          disabled={!k.revealable}
                          onClick={() => copyKey(k)}
                        >
                          <Icon name={Icons.copy} size={13} /> Copy
                        </button>
                        <button
                          type="button"
                          class="ui-button ui-button-outline ui-button-sm"
                          disabled={k.status === "revoked"}
                          onClick={() => openEdit(k)}
                        >
                          <Icon name={Icons.edit} size={13} /> Edit
                        </button>
                        <Show when={k.status !== "revoked"}>
                          <button
                            type="button"
                            class="ui-button ui-button-outline ui-button-sm hover:text-warning hover:border-warning/40"
                            onClick={() => setConfirmRevoke(k)}
                          >
                            <Icon name={Icons.ban} size={13} /> Revoke
                          </button>
                        </Show>
                        <IconBtn
                          icon={Icons.trash}
                          label="Delete key"
                          danger
                          onClick={() => setConfirmDelete(k)}
                        />
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
        title="Create API key"
        width="max-w-xl billing-dialog"
        footer={
          <>
            <Btn variant="outline" size="sm" onClick={() => setShowCreate(false)}>
              Cancel
            </Btn>
            <Btn size="sm" onClick={create} disabled={busy()}>
              {busy() ? "Creating…" : "Create key"}
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          {/* Exclusive Live Cryptographic Key Passport */}
          <div class="rounded-xl border border-line bg-surface-subtle p-3.5 flex items-center justify-between gap-3 flex-wrap" aria-hidden="true">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-9 h-9 rounded-lg bg-accent-subtle border border-accent/35 text-accent flex items-center justify-center shrink-0">
                <Icon name={Icons.key} size={16} />
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-xs font-medium text-fg truncate">
                    {form().name.trim() || "untitled-gateway-key"}
                  </span>
                  <code class="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface border border-line text-fg-secondary">
                    gw_••••••••••••
                  </code>
                </div>
                <div class="text-[11px] text-fg-muted mt-0.5 flex items-center gap-2 flex-wrap">
                  <span>SHA-256 hashed</span>
                  <span>·</span>
                  <span>
                    {form().projectId
                      ? `Project: ${(readProjects() ?? []).find((p) => p.id === form().projectId)?.name ?? "Assigned"}`
                      : "Personal ledger"}
                  </span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <Badge tone={form().preset === "never" ? "green" : "amber"}>
                {form().preset === "never" ? "Permanent ∞" : form().preset === "custom" ? "Custom TTL" : `${form().preset} TTL`}
              </Badge>
              <Badge tone={form().rpm ? "indigo" : "zinc"}>
                {form().rpm ? `${form().rpm} RPM` : "No RPM cap"}
              </Badge>
            </div>
          </div>

          <ModalField label="Key name">
            <input
              type="text"
              value={form().name}
              onInput={(e) => setForm({ ...form(), name: e.currentTarget.value })}
              placeholder="e.g. production-agent-01"
              class="ui-field"
            />
          </ModalField>

          <Show when={readProjects()?.length || projects.error}><Show when={projects.error} fallback={<Select label="Financial project" value={form().projectId} onChange={(id) => setForm({ ...form(), projectId: id })} options={[{ value: "", label: "Personal — no financial project" }, ...(readProjects() ?? []).filter((p) => p.kind === "project" && p.status === "active").map((p) => ({ value: p.id, label: p.name }))]} />}><p role="alert" class="text-xs text-fg-secondary">Financial projects could not be loaded. Reload to choose a project.</p></Show></Show>
          <ModalSection title="Expiration">
            <div class="space-y-2.5">
              <div class="flex flex-wrap gap-2">
                <For each={EXPIRY_PRESETS.filter((p) => p.value !== "custom")}>
                  {(preset) => (
                    <FilterChip
                      selected={form().preset === preset.value}
                      onClick={() => setForm({ ...form(), preset: preset.value, customDate: "" })}
                    >
                      {preset.label}
                    </FilterChip>
                  )}
                </For>
              </div>
              <Show when={form().preset !== "never" && form().preset !== "custom"}>
                <div class="pt-0.5">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form(), preset: "never", customDate: "" })}
                    class="text-xs text-accent hover:text-accent-strong inline-flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <span>↺ Reset to permanent</span>
                  </button>
                </div>
              </Show>

              <OrDivider text="Or specify custom date" />

              <DateTimePicker
                label="Custom expiration"
                ariaLabel="Custom expiration"
                value={form().customDate}
                onChange={(val) =>
                  setForm({
                    ...form(),
                    preset: val ? "custom" : "never",
                    customDate: val,
                  })
                }
              />
            </div>
          </ModalSection>

          <Show when={showUsd()}>
            <ModalSection
              title="USD spending limits"
              info="All billable input, cached input, output and reasoning count in USD. Key limits are independent of the account plan."
            >
              <div class="space-y-3.5">
                {/* Exclusive Synchronized Burn Runway Balancer */}
                <div class="rounded-xl border border-line bg-surface-subtle p-3 space-y-2.5" aria-hidden="true">
                  <div class="flex items-center justify-between gap-2 flex-wrap text-xs">
                    <span class="font-medium text-fg">Synchronized Burn Profiles</span>
                    <span class="font-mono text-[11px] text-accent">
                      {(() => {
                        const d = Number(form().dailyLimitUsd);
                        const t = Number(form().totalLimitUsd);
                        if (!form().dailyLimitUsd && !form().totalLimitUsd) return "∞ Unrestricted daily & lifetime burn";
                        if (d > 0 && t > 0) {
                          if (d > t) return "⚠ Daily cap exceeds lifetime ceiling";
                          return `${(t / d).toFixed(1)} full-burn days before lifetime exhaustion`;
                        }
                        if (d > 0) return `${fmtCost(d)}/day recurring · ∞ lifetime`;
                        return `No daily cap · ${fmtCost(t || 0)} lifetime ceiling`;
                      })()}
                    </span>
                  </div>
                  <div class="grid grid-cols-5 gap-1.5">
                    <For
                      each={[
                        { label: "Sandbox", d: "1", t: "10" },
                        { label: "Dev", d: "5", t: "50" },
                        { label: "Staging", d: "20", t: "200" },
                        { label: "Prod", d: "100", t: "1000" },
                        { label: "No Cap", d: "", t: "" },
                      ]}
                    >
                      {(prof) => {
                        const active = () => form().dailyLimitUsd === prof.d && form().totalLimitUsd === prof.t;
                        return (
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => setForm({ ...form(), dailyLimitUsd: prof.d, totalLimitUsd: prof.t })}
                            class={`rounded-lg border px-2 py-1.5 text-left transition-all cursor-pointer ${
                              active()
                                ? "border-accent bg-accent-subtle text-accent-strong"
                                : "border-line bg-surface hover:border-line-strong text-fg-secondary"
                            }`}
                          >
                            <div class="text-[10px] font-medium tracking-wider text-fg-muted">{prof.label}</div>
                            <div class="text-[11px] font-mono font-medium text-fg mt-0.5">
                              {prof.d ? `$${prof.d}/d · $${prof.t}` : "∞ / ∞"}
                            </div>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <CurrencyField
                    label="Daily limit (USD)"
                    ariaLabel="Daily limit (USD)"
                    value={form().dailyLimitUsd}
                    onInput={(v) => setForm({ ...form(), dailyLimitUsd: v })}
                    step={1}
                    hint="Resets 00:00 UTC · empty = unlimited"
                    presets={[
                      { label: "$1", value: "1" },
                      { label: "$5", value: "5" },
                      { label: "$10", value: "10" },
                      { label: "$50", value: "50" },
                      { label: "∞", value: "" },
                    ]}
                  />
                  <CurrencyField
                    label="Lifetime limit (USD)"
                    ariaLabel="Lifetime limit (USD)"
                    value={form().totalLimitUsd}
                    onInput={(v) => setForm({ ...form(), totalLimitUsd: v })}
                    step={10}
                    hint="Permanent cap across key lifetime"
                    presets={[
                      { label: "$10", value: "10" },
                      { label: "$50", value: "50" },
                      { label: "$100", value: "100" },
                      { label: "$500", value: "500" },
                      { label: "∞", value: "" },
                    ]}
                  />
                </div>
              </div>
            </ModalSection>
          </Show>

          <ModalSection title="Request limits">
            <div class="space-y-3">
              <SwitchCard
                checked={form().rpm !== ""}
                onChange={(checked) => setForm({ ...form(), rpm: checked ? (form().rpm || "120") : "" })}
                title="Enable per-minute rate limiting (RPM)"
              />
              <Show when={form().rpm !== ""}>
                <div class="pl-12 space-y-2.5">
                  {/* Exclusive RPM-to-RPS Throughput Telemetry Bar */}
                  <div class="rounded-lg border border-line bg-surface-subtle px-3 py-2 flex items-center justify-between gap-2 text-xs" aria-hidden="true">
                    <span class="text-fg-secondary">Sustained throughput equivalent</span>
                    <span class="font-mono font-medium text-accent">
                      {((Number(form().rpm) || 0) / 60).toFixed(1)} req/sec ·{" "}
                      {(Number(form().rpm) || 0) <= 60
                        ? "Low concurrency"
                        : (Number(form().rpm) || 0) <= 300
                          ? "Standard agent load"
                          : "High-frequency burst"}
                    </span>
                  </div>
                  <StepperField
                    label="Maximum requests per minute"
                    ariaLabel="Maximum requests per minute"
                    min={1}
                    max={1000000}
                    step={10}
                    unit="RPM"
                    value={form().rpm}
                    onInput={(v) => setForm({ ...form(), rpm: v })}
                    placeholder="120"
                    hint="Sliding 60-second window (default 120 RPM)"
                    presets={[
                      { label: "60 RPM", value: "60" },
                      { label: "120 RPM", value: "120" },
                      { label: "300 RPM", value: "300" },
                      { label: "600 RPM", value: "600" },
                      { label: "1,200 RPM", value: "1200" },
                    ]}
                  />
                </div>
              </Show>
            </div>
          </ModalSection>
        </div>
      </Modal>

      {/* edit modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={`Edit “${editing()?.name ?? ""}”`}
        subtitle={
          showUsd()
            ? "Adjust USD spending limits, request rate, or expiration. The account plan remains the shared spending ceiling."
            : "Adjust key name, request rate, or expiration. Spending allowances are managed by your organization."
        }
        width="max-w-xl billing-dialog"
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
              disabled={busy()}
            >
              {busy() ? "Saving…" : "Save changes"}
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalField label="Key name">
            <input
              type="text"
              value={form().name}
              onInput={(e) => setForm({ ...form(), name: e.currentTarget.value })}
              placeholder="e.g. production-agent-01"
              class="ui-field"
            />
          </ModalField>

          <Show when={readProjects()?.length || form().projectId}><Select label="Financial project" value={form().projectId} onChange={(id) => setForm({ ...form(), projectId: id })} options={[{ value: "", label: "Personal — no financial project" }, ...(readProjects() ?? []).filter((p) => p.kind === "project" && (p.status === "active" || p.id === form().projectId)).map((p) => ({ value: p.id, label: `${p.name}${p.status === "archived" ? " (archived)" : ""}` }))]} hint="Reassignment changes future requests. Historical usage keeps its original financial project." /></Show>
          <ModalSection title="Expiration">
            <div class="space-y-2.5">
              <div class="flex flex-wrap gap-2">
                <For each={EXPIRY_PRESETS.filter((p) => p.value !== "custom")}>
                  {(preset) => (
                    <FilterChip
                      selected={form().preset === preset.value}
                      onClick={() => setForm({ ...form(), preset: preset.value, customDate: "" })}
                    >
                      {preset.label}
                    </FilterChip>
                  )}
                </For>
              </div>
              <Show when={form().preset !== "never" && form().preset !== "custom"}>
                <div class="pt-0.5">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form(), preset: "never", customDate: "" })}
                    class="text-xs text-accent hover:text-accent-strong inline-flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <span>↺ Reset to permanent</span>
                  </button>
                </div>
              </Show>

              <OrDivider text="Or specify custom date" />

              <DateTimePicker
                label="Custom expiration"
                ariaLabel="Custom expiration"
                value={form().customDate}
                onChange={(val) =>
                  setForm({
                    ...form(),
                    preset: val ? "custom" : "never",
                    customDate: val,
                  })
                }
              />
            </div>
          </ModalSection>

          <Show when={showUsd()}>
            <ModalSection
              title="USD spending limits"
              info="All billable usage counts in USD. Leave a field empty for no key-level cap; the account plan still applies."
            >
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <CurrencyField
                  label="Daily limit (USD)"
                  ariaLabel="Daily limit (USD)"
                  value={form().dailyLimitUsd}
                  onInput={(v) => setForm({ ...form(), dailyLimitUsd: v })}
                  step={1}
                  hint="Resets at midnight UTC · empty = unlimited"
                  presets={[
                    { label: "$1", value: "1" },
                    { label: "$5", value: "5" },
                    { label: "$10", value: "10" },
                    { label: "$50", value: "50" },
                    { label: "∞", value: "" },
                  ]}
                />
                <CurrencyField
                  label="Lifetime limit (USD)"
                  ariaLabel="Lifetime limit (USD)"
                  value={form().totalLimitUsd}
                  onInput={(v) => setForm({ ...form(), totalLimitUsd: v })}
                  step={10}
                  hint="Across the entire lifetime of this key"
                  presets={[
                    { label: "$10", value: "10" },
                    { label: "$50", value: "50" },
                    { label: "$100", value: "100" },
                    { label: "$500", value: "500" },
                    { label: "∞", value: "" },
                  ]}
                />
              </div>
            </ModalSection>
          </Show>

          <ModalSection title="Request limits">
            <div class="space-y-3">
              <SwitchCard
                checked={form().rpm !== ""}
                onChange={(checked) => setForm({ ...form(), rpm: checked ? (form().rpm || "120") : "" })}
                title="Enable per-minute rate limiting (RPM)"
              />
              <Show when={form().rpm !== ""}>
                <div class="pl-12">
                  <StepperField
                    label="Requests per minute"
                    ariaLabel="Requests per minute"
                    min={1}
                    max={1000000}
                    step={10}
                    unit="RPM"
                    value={form().rpm}
                    onInput={(v) => setForm({ ...form(), rpm: v })}
                    placeholder="120"
                    hint="Sliding 60-second window"
                    presets={[
                      { label: "60 RPM", value: "60" },
                      { label: "120 RPM", value: "120" },
                      { label: "300 RPM", value: "300" },
                      { label: "600 RPM", value: "600" },
                      { label: "1,200 RPM", value: "1200" },
                    ]}
                  />
                </div>
              </Show>
            </div>
          </ModalSection>
        </div>
      </Modal>

      {/* token-once modal */}
      <Modal
        open={!!newToken()}
        onClose={() => setNewToken("")}
        title="API key generated"
        subtitle="Copy your key and integration snippets now. For security, raw tokens cannot be retrieved again once closed."
        width="max-w-xl billing-dialog"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => copyWithToast(newToken())}
            >
              <Icon name={Icons.copy} size={13} />
              <span>Copy</span>
            </Btn>
            <Btn
              size="sm"
              onClick={() => setNewToken("")}
            >
              Done
            </Btn>
          </>
        }
      >
        <div class="space-y-5">
          <div class="rounded-control border border-success/35 bg-surface-muted p-4 space-y-2">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-success">Gateway secret key</span>
              <CopyButton text={newToken()} label="Copy secret key" />
            </div>
            <code class="block font-mono text-xs text-fg break-all select-all pt-1 bg-surface p-2.5 rounded-lg border border-line/60">
              {newToken()}
            </code>
          </div>

          <ModalSection
            title="Integration snippet"
            subtitle="Plug this gateway key into your application or SDK configuration:"
          >
            <div class="space-y-2.5">
              <Tabs
                value={snippetTab()}
                onChange={setSnippetTab}
                ariaLabel="SDK snippet language"
                items={[
                  { value: "curl", label: "cURL" },
                  { value: "python", label: "Python (OpenAI)" },
                  { value: "node", label: "Node.js" },
                ]}
              />

              <pre class="overflow-x-auto rounded-control border border-line bg-surface-muted p-3.5 text-xs font-mono text-fg-secondary leading-relaxed">
                <Show when={snippetTab() === "curl"}>
{`curl ${window.location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${newToken()}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello!"}]}'`}
                </Show>
                <Show when={snippetTab() === "python"}>
{`from openai import OpenAI

client = OpenAI(
    base_url="${window.location.origin}/v1",
    api_key="${newToken()}",
)
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`}
                </Show>
                <Show when={snippetTab() === "node"}>
{`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${window.location.origin}/v1",
  apiKey: "${newToken()}",
});

const response = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);`}
                </Show>
              </pre>
            </div>
          </ModalSection>

          <ModalNotice tone="info" title="Security advisory">
            The gateway stores only the cryptographic SHA-256 hash of this key. If you misplace this secret,
            you will need to revoke it and generate a new key.
          </ModalNotice>
        </div>
      </Modal>

      {/* revoke confirm */}
      <Modal
        open={!!confirmRevoke()}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke API key"
        subtitle="Immediately deactivate this key across all client applications and active agents."
        width="max-w-lg"
        footer={
          <>
            <Btn variant="outline" size="sm" onClick={() => setConfirmRevoke(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" size="sm" loading={busy()} onClick={revoke}>
              Revoke key
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Confirm key deactivation">
            Revoking will immediately cause all SDK and API requests using{" "}
            <strong class="text-fg font-medium">{confirmRevoke()?.name}</strong> (
            <code class="text-danger">{confirmRevoke()?.prefix}…</code>) to fail with 401 Unauthorized.
          </ModalNotice>

          <div class="rounded-control border border-line bg-surface-muted p-3.5 space-y-2 text-xs text-fg-secondary">
            <div class="font-medium text-fg">What happens when you revoke:</div>
            <ul class="list-disc list-inside space-y-1 text-fg-secondary pl-1">
              <li>In-flight requests already accepted will complete normally.</li>
              <li>Any new request presenting this token is immediately rejected.</li>
              <li>Historical usage records and audit logs are safely preserved.</li>
            </ul>
          </div>
        </div>
      </Modal>

      {/* hard-delete confirm */}
      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete key permanently"
        subtitle="Permanently remove this key record from the gateway database."
        width="max-w-lg"
        footer={
          <>
            <Btn variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" size="sm" loading={busy()} onClick={hardDelete}>
              Delete permanently
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Purge database record">
            Permanently delete{" "}
            <strong class="text-fg font-medium">{confirmDelete()?.name}</strong> (
            <code class="text-danger">{confirmDelete()?.prefix}…</code>)? This action cannot be undone.
          </ModalNotice>

          <div class="rounded-control border border-line bg-surface-muted p-3.5 space-y-2 text-xs text-fg-secondary">
            <div class="font-medium text-fg">Database purge consequences:</div>
            <ul class="list-disc list-inside space-y-1 text-fg-secondary pl-1">
              <li>The API key record is completely removed from the SQLite database.</li>
              <li>All aggregated token and cost usage data remains preserved for audit history.</li>
              <li>Any applications using this token will fail with 401 Unauthorized.</li>
            </ul>
          </div>
        </div>
      </Modal>
    </div>
  );
}
