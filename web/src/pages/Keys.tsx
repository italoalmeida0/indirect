import { CatalogToolbar, CatalogState, CatalogPagination, createCatalog } from "../catalog";
import { createSignal, For, Show } from "solid-js";

import { api, type ApiKeyDto } from "../api";
import { PageTitle } from "../chrome";
import {
  Badge,
  Btn,
  Card,
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
  SwitchCard,
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
}

function computeExpiresAt(f: KeyFormState): number | null {
  if (f.preset === "never") return null;
  if (f.preset === "custom") {
    const t = new Date(f.customDate).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return Date.now() + Number(f.preset) * 1000;
}

export default function KeysPage() {
  const view = createCatalog<ApiKeyDto>({ storageKey: "llmgw-grid:keys.user", path: "/api/keys", result: "keys", label: "API keys", sort: [
    { value: "name:asc", label: "Name A–Z" }, { value: "createdAt:desc", label: "Newest first" }, { value: "createdAt:asc", label: "Oldest first" }, { value: "lastUsedAt:desc", label: "Recently used" }, { value: "spendTotalUsd:desc", label: "Highest spend" },
  ] });
  const keyCount = view.total;
  const refreshGrid = view.refresh;
  const keysDatasource = view.datasource;

  const [showCreate, setShowCreate] = createSignal(false);
  const [editing, setEditing] = createSignal<ApiKeyDto | null>(null);
  const [newToken, setNewToken] = createSignal("");
  const [confirmRevoke, setConfirmRevoke] = createSignal<ApiKeyDto | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = createSignal<ApiKeyDto | null>(
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
  });

  const resetForm = () =>
    setForm({
      name: "",
      preset: "never",
      customDate: "",
      dailyLimitUsd: "",
      totalLimitUsd: "",
      rpm: "",
    });

  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  const create = async () => {
    if (!form().name.trim()) return toast("Name is required", "err");
    setBusy(true);
    try {
      const expiresAt = computeExpiresAt(form());
      const j = await api<{ token: string }>("POST", "/api/keys", {
        name: form().name.trim(),
        expiresAt,
        dailyLimitUsd: num(form().dailyLimitUsd),
        totalLimitUsd: num(form().totalLimitUsd),
        rpm: num(form().rpm),
      });
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

  const openEdit = (k: ApiKeyDto) => {
    setForm({
      name: k.name,
      preset: "never",
      customDate: "",
      dailyLimitUsd: k.dailyLimitUsd?.toString() ?? "",
      totalLimitUsd: k.totalLimitUsd?.toString() ?? "",
      rpm: k.rpm?.toString() ?? "",
    });
    setEditing(k);
  };

  const saveEdit = async () => {
    const k = editing();
    if (!k) return;
    setBusy(true);
    try {
      await api("PATCH", `/api/keys/${k.id}`, {
        name: form().name.trim(),
        dailyLimitUsd: num(form().dailyLimitUsd),
        totalLimitUsd: num(form().totalLimitUsd),
        rpm: num(form().rpm),
      });
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

  const copyKey = async (k: ApiKeyDto) => {
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

  function NameCell(props: { data?: ApiKeyDto }) {
    return (
      <span class="text-sm font-medium text-ink-100 truncate block">
        {props.data?.name}
      </span>
    );
  }

  function PrefixCell(props: { data?: ApiKeyDto }) {
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

  /** USD spend, with a mini progress bar when a budget is set. */
  function BudgetCell(props: { data?: ApiKeyDto; kind?: "today" | "total" }) {
    const k = props.data;
    if (!k) return null;
    const today = props.kind === "today";
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

  function ActionsCell(props: { data?: ApiKeyDto }) {
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

  const cols: ColDef[] = [
    { field: "name", headerName: "Name", flex: 1.2, minWidth: 160, cellRenderer: NameCell },
    { field: "prefix", headerName: "Prefix", width: 130, cellRenderer: PrefixCell },
    { field: "status", headerName: "Status", width: 160, cellRenderer: StatusBadgeCell },
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

  return (
    <div class="catalog-page" aria-busy={view.loading()}>
      <PageTitle
        title="API Keys"
        right={
          <Btn onClick={() => setShowCreate(true)}>
            <Icon name={Icons.plus} /> New key
          </Btn>
        }
      />

      <CatalogToolbar view={view} />
      <CatalogState view={view}><Card>
        <Show when={keyCount() > 0} fallback={<EmptyState icon={Icons.key} title="No matching API keys" hint="Adjust your filters or create a new key." />}>
          <Show when={!view.mobile()}><div class="p-2"><UsageGrid columnDefs={cols} datasource={keysDatasource} cacheBlockSize={25} refreshDeps={view.refreshKey()} storageKey="llmgw-grid:keys.user" sort={view.sort()} onSortChanged={view.setSort} /></div></Show>
          <Show when={view.mobile()}><div class="catalog-mobile p-3 space-y-3"><For each={view.rows()}>
                  {(k) => (
                    <div class="p-4 rounded-xl border border-line bg-elev space-y-3 shadow-xs">
                      {/* Key name full width without premature ellipsis */}
                      <div class="space-y-1.5">
                        <div class="flex items-start justify-between gap-2">
                          <h4 class="text-sm font-semibold text-ink-100 break-normal min-w-0">{k.name}</h4>
                          <span class="text-[11px] text-ink-400 shrink-0 font-mono">
                            {k.expiresAt ? `Exp: ${fmtDate(k.expiresAt)}` : "Permanent"}
                          </span>
                        </div>
                        <div class="flex items-center justify-between text-xs gap-2">
                          <div class="flex items-center gap-2">
                            <code class="text-xs font-mono text-ink-300 bg-ink-950/60 px-2 py-0.5 rounded border border-line/60">{k.prefix}…</code>
                            <Badge tone={k.status === "active" ? "green" : k.status === "exhausted" ? "amber" : "zinc"}>
                              {k.status}
                            </Badge>
                          </div>
                          <span class="text-[11px] text-ink-500">
                            {k.lastUsedAt ? `Used: ${fmtDate(k.lastUsedAt)}` : "Never used"}
                          </span>
                        </div>
                      </div>

                      <Show when={k.totalLimitUsd !== null || k.dailyLimitUsd !== null}>
                        <div class="pt-2 border-t border-line/50 space-y-1.5 text-xs text-ink-400">
                          <Show when={k.dailyLimitUsd !== null}>
                            <div class="flex justify-between">
                              <span>Daily limit</span>
                              <span class="font-mono text-ink-200">{fmtCost(k.dailyLimitUsd!)}</span>
                            </div>
                          </Show>
                          <Show when={k.totalLimitUsd !== null}>
                            <div class="flex justify-between">
                              <span>Total cap</span>
                              <span class="font-mono text-ink-200">{fmtCost(k.spendTotalUsd ?? 0)} / {fmtCost(k.totalLimitUsd!)}</span>
                            </div>
                          </Show>
                        </div>
                      </Show>

                      <div class="pt-2 border-t border-line/60 flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          class="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-card border border-line cursor-pointer disabled:opacity-30 transition-colors"
                          disabled={!k.revealable}
                          onClick={() => copyKey(k)}
                        >
                          <Icon name={Icons.copy} size={13} /> Copy
                        </button>
                        <button
                          type="button"
                          class="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-card border border-line cursor-pointer disabled:opacity-30 transition-colors"
                          disabled={k.status === "revoked"}
                          onClick={() => openEdit(k)}
                        >
                          <Icon name={Icons.edit} size={13} /> Edit
                        </button>
                        <Show when={k.status !== "revoked"}>
                          <button
                            type="button"
                            class="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium text-ink-400 hover:text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/30 border border-line cursor-pointer transition-colors"
                            onClick={() => setConfirmRevoke(k)}
                          >
                            <Icon name={Icons.ban} size={13} /> Revoke
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="h-8 w-8 rounded-lg flex items-center justify-center text-ink-400 hover:text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30 border border-line cursor-pointer transition-colors"
                          onClick={() => setConfirmDelete(k)}
                          aria-label="Delete key"
                        >
                          <Icon name={Icons.trash} size={13} />
                        </button>
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
          <ModalField label="Key name">
            <input
              type="text"
              value={form().name}
              onInput={(e) => setForm({ ...form(), name: e.currentTarget.value })}
              placeholder="e.g. production-agent-01"
              class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
            />
          </ModalField>

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
                    class="text-xs text-brand-400 hover:text-brand-300 inline-flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <span>↺ Reset to permanent</span>
                  </button>
                </div>
              </Show>

              <OrDivider text="Or specify custom date" />

              <ModalField label="Custom expiration">
                <input
                  type="datetime-local"
                  value={form().customDate}
                  onInput={(e) =>
                    setForm({
                      ...form(),
                      preset: e.currentTarget.value ? "custom" : "never",
                      customDate: e.currentTarget.value,
                    })
                  }
                  class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                />
              </ModalField>
            </div>
          </ModalSection>

          <ModalSection
            title="USD spending limits"
            info="All billable input, cached input, output and reasoning count in USD. Key limits are independent of the account plan."
          >
            <div class="space-y-3">
              <div class="flex items-center justify-between flex-wrap gap-2">
                <span class="text-xs text-ink-400">Quick limit presets:</span>
                <div class="flex flex-wrap gap-1.5">
                  <For each={[
                    { label: "$1 / day", val: "1" },
                    { label: "$5 / day", val: "5" },
                    { label: "$10 / day", val: "10" },
                    { label: "$50 / day", val: "50" },
                  ]}>
                    {(preset) => (
                      <button
                        type="button"
                        onClick={() => setForm({ ...form(), dailyLimitUsd: preset.val, totalLimitUsd: String(Number(preset.val) * 10) })}
                        class="px-2 py-1 rounded bg-ink-900/60 hover:bg-ink-800 text-[11px] text-ink-300 hover:text-ink-100 border border-line/60 transition-colors cursor-pointer"
                      >
                        {preset.label}
                      </button>
                    )}
                  </For>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form(), dailyLimitUsd: "", totalLimitUsd: "" })}
                    class="px-2 py-1 rounded bg-ink-900/60 hover:bg-ink-800 text-[11px] text-ink-400 hover:text-ink-200 border border-line/60 transition-colors cursor-pointer"
                  >
                    Unlimited
                  </button>
                </div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ModalField label="Daily limit (USD)" hint="Resets 00:00 UTC">
                  <input
                    type="number" aria-label="Daily limit (USD)"
                    min={0} step="0.01" inputMode="decimal"
                    value={form().dailyLimitUsd}
                    onInput={(e) => setForm({ ...form(), dailyLimitUsd: e.currentTarget.value })}
                    placeholder="Unlimited"
                    class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                  />
                </ModalField>
                <ModalField label="Lifetime limit (USD)" hint="Permanent cap">
                  <input
                    type="number" aria-label="Lifetime limit (USD)"
                    min={0} step="0.01" inputMode="decimal"
                    value={form().totalLimitUsd}
                    onInput={(e) => setForm({ ...form(), totalLimitUsd: e.currentTarget.value })}
                    placeholder="Unlimited"
                    class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                  />
                </ModalField>
              </div>
            </div>
          </ModalSection>

          <ModalSection title="Request limits">
            <div class="space-y-3">
              <SwitchCard
                checked={form().rpm !== ""}
                onChange={(checked) => setForm({ ...form(), rpm: checked ? (form().rpm || "120") : "" })}
                title="Enable per-minute rate limiting (RPM)"
              />
              <Show when={form().rpm !== ""}>
                <div class="pl-12">
                  <ModalField label="Maximum requests per minute" hint="Sliding 60-second window (default 120 RPM)">
                    <input
                      type="number"
                      min={1}
                      max={1000000}
                      value={form().rpm}
                      onInput={(e) => setForm({ ...form(), rpm: e.currentTarget.value })}
                      placeholder="120"
                      class="w-full max-w-xs rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                    />
                  </ModalField>
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
        subtitle="Adjust USD spending limits, request rate, or expiration. The account plan remains the shared spending ceiling."
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
              class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
            />
          </ModalField>

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
                    class="text-xs text-brand-400 hover:text-brand-300 inline-flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <span>↺ Reset to permanent</span>
                  </button>
                </div>
              </Show>

              <OrDivider text="Or specify custom date" />

              <ModalField label="Custom expiration">
                <input
                  type="datetime-local"
                  value={form().customDate}
                  onInput={(e) =>
                    setForm({
                      ...form(),
                      preset: e.currentTarget.value ? "custom" : "never",
                      customDate: e.currentTarget.value,
                    })
                  }
                  class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                />
              </ModalField>
            </div>
          </ModalSection>

          <ModalSection
            title="USD spending limits"
            info="All billable usage counts in USD. Leave a field empty for no key-level cap; the account plan still applies."
          >
            <div class="space-y-3">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ModalField label="Daily limit (USD)" hint="Resets at midnight UTC · empty = unlimited">
                  <input
                    type="number" aria-label="Daily limit (USD)"
                    min={0} step="0.01" inputMode="decimal"
                    value={form().dailyLimitUsd}
                    onInput={(e) => setForm({ ...form(), dailyLimitUsd: e.currentTarget.value })}
                    placeholder="Unlimited"
                    class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                  />
                </ModalField>
                <ModalField label="Lifetime limit (USD)" hint="Across the entire lifetime of this key">
                  <input
                    type="number" aria-label="Lifetime limit (USD)"
                    min={0} step="0.01" inputMode="decimal"
                    value={form().totalLimitUsd}
                    onInput={(e) => setForm({ ...form(), totalLimitUsd: e.currentTarget.value })}
                    placeholder="Unlimited"
                    class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                  />
                </ModalField>
              </div>
            </div>
          </ModalSection>

          <ModalSection title="Request limits">
            <div class="space-y-3">
              <SwitchCard
                checked={form().rpm !== ""}
                onChange={(checked) => setForm({ ...form(), rpm: checked ? (form().rpm || "120") : "" })}
                title="Enable per-minute rate limiting (RPM)"
              />
              <Show when={form().rpm !== ""}>
                <div class="pl-12">
                  <ModalField label="Requests per minute" hint="Sliding 60-second window">
                    <input
                      type="number"
                      min={1}
                      max={1000000}
                      value={form().rpm}
                      onInput={(e) => setForm({ ...form(), rpm: e.currentTarget.value })}
                      placeholder="120"
                      class="w-full max-w-xs rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                    />
                  </ModalField>
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
        title="API key generated successfully"
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
          <div class="rounded-xl border border-emerald-500/30 bg-ink-950/80 p-4 space-y-2">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-emerald-400">Gateway Secret Key</span>
              <button
                type="button"
                onClick={() => copyWithToast(newToken())}
                class="text-xs text-ink-400 hover:text-ink-100 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Icon name={Icons.copy} size={12} />
                <span>Copy secret</span>
              </button>
            </div>
            <code class="block font-mono text-xs text-emerald-300 break-all select-all pt-1 bg-ink-900/50 p-2.5 rounded-lg border border-line/40">
              {newToken()}
            </code>
          </div>

          <ModalSection
            title="Integration snippet"
            subtitle="Plug this gateway key into your application or SDK configuration:"
          >
            <div class="space-y-2.5">
              <div class="flex items-center gap-1.5 border-b border-line pb-2">
                <button
                  type="button"
                  onClick={() => setSnippetTab("curl")}
                  class={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    snippetTab() === "curl"
                      ? "bg-accent-500 text-accent-fg shadow-sm"
                      : "text-ink-400 hover:text-ink-100 hover:bg-ink-800/50"
                  }`}
                >
                  cURL
                </button>
                <button
                  type="button"
                  onClick={() => setSnippetTab("python")}
                  class={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    snippetTab() === "python"
                      ? "bg-accent-500 text-accent-fg shadow-sm"
                      : "text-ink-400 hover:text-ink-100 hover:bg-ink-800/50"
                  }`}
                >
                  Python (OpenAI)
                </button>
                <button
                  type="button"
                  onClick={() => setSnippetTab("node")}
                  class={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    snippetTab() === "node"
                      ? "bg-accent-500 text-accent-fg shadow-sm"
                      : "text-ink-400 hover:text-ink-100 hover:bg-ink-800/50"
                  }`}
                >
                  Node.js
                </button>
              </div>

              <pre class="overflow-x-auto rounded-xl border border-line bg-ink-950/80 p-3.5 text-[11px] font-mono text-ink-200 leading-relaxed">
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
            <button
              type="button"
              onClick={() => setConfirmRevoke(null)}
              class="border border-line bg-transparent hover:bg-elev text-ink-300 hover:text-ink-100 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={revoke}
              disabled={busy()}
              class="bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors cursor-pointer"
            >
              {busy() ? "Revoking…" : "Revoke key"}
            </button>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Confirm key deactivation">
            Revoking will immediately cause all SDK and API requests using{" "}
            <strong class="text-white">{confirmRevoke()?.name}</strong> (
            <code class="text-rose-300">{confirmRevoke()?.prefix}…</code>) to fail with 401 Unauthorized.
          </ModalNotice>

          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">What happens when you revoke:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
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
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              class="border border-line bg-transparent hover:bg-elev text-ink-300 hover:text-ink-100 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={hardDelete}
              disabled={busy()}
              class="bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors cursor-pointer"
            >
              {busy() ? "Deleting…" : "Delete permanently"}
            </button>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Purge database record">
            Permanently delete{" "}
            <strong class="text-white">{confirmDelete()?.name}</strong> (
            <code class="text-rose-300">{confirmDelete()?.prefix}…</code>)? This action cannot be undone.
          </ModalNotice>

          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Database purge consequences:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
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
