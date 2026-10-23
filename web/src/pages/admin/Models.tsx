import { createSignal, For, Show, createResource, createMemo, createEffect } from "solid-js";

import { api, type ModelDto, type ProviderDto, type RoutingMode, type SyncOutcome, type ToolCallMode } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { attachSortable } from "../../sortable";
import { Badge, Btn, Card, EmptyState, FilterChip, Icon, IconBtn, Icons, Modal, ModalField, ModalNotice, ModalSection, Segmented, Select, SwitchCard, toast, fmtNum } from "../../ui";
import { UsageGrid, serverDatasource } from "../../aggrid";
import type { ColDef, GridApi } from "ag-grid-community";

/** Editor-state of one failover routing target. */
interface TargetDraft {
  providerId: string;
  upstreamModel: string; // "" = public id
  enabled: boolean;
}

const ROUTING_OPTIONS = [
  { value: "passthrough", label: "Pass-through" },
  { value: "router", label: "Router" },
] as Array<{ value: RoutingMode; label: string }>;

const USER_SELECTION_SOURCES = new Set([
  "checkboxSelected",
  "rowClicked",
  "spaceKey",
  "uiSelectAll",
  "uiSelectAllFiltered",
  "uiSelectAllCurrentPage",
]);

const PRICING_KEYS = ["prompt", "completion", "image", "request", "input_cache_reads", "input_cache_writes"];

/** Registry pricing is stored as USD per token; the table displays USD per 1M.
 *  Number() parses scientific notation natively — digit-stripping would turn
 *  "4.5e-7" into "4.57" and inflate the price a millionfold. */
function pricePerMillionNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const amount =
    typeof value === "number" ? value : Number(String(value).replace(/[\s,$€£]/g, ""));
  return Number.isFinite(amount) ? amount * 1_000_000 : null;
}

/** Plain-decimal string for the edit field — String() would render sub-micro
 *  prices as "4.5e-7". */
function perTokenInput(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value === 0) return "0";
  if (value >= 1e-6) return String(value);
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function pricePerMillion(value: string | number | null | undefined): string {
  const amount = pricePerMillionNumber(value);
  if (amount === null) return "—";
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const numOrNull = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

/** Human one-liner for a per-capability sync outcome map. */
export function syncSummary(sync?: Partial<Record<string, SyncOutcome>>): string {
  if (!sync) return "";
  const parts: string[] = [];
  for (const [cap, r] of Object.entries(sync)) {
    if (!r) continue;
    parts.push(
      r.error ? `${cap}: sync failed (${r.error})` : `${cap}: ${r.added} added, ${r.skipped} skipped`,
    );
  }
  return parts.join(" · ");
}

export default function AdminModelsPage() {
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [selectingAll, setSelectingAll] = createSignal(false);
  const [selectedOnly, setSelectedOnly] = createSignal(false);
  let modelsGridApi: GridApi<ModelDto> | undefined;

  const applyLoadedSelection = (gridApi = modelsGridApi) => {
    if (!gridApi) return;
    const ids = selected();
    gridApi.forEachNode((node) => {
      const id = node.data?.id;
      if (!id) return;
      const shouldSelect = ids.has(id);
      if (node.isSelected() !== shouldSelect) {
        node.setSelected(shouldSelect, false, "api");
      }
    });
  };

  // Infinite row model only exposes loaded blocks. Merge those changes into
  // the app-level set so scrolling never drops selections from other blocks.
  const syncLoadedSelection = (event: {
    api: GridApi<ModelDto>;
    source?: string;
  }) => {
    // Ignore selection changes caused by loading blocks or our own API calls.
    // Only user actions should mutate the page-level selection set.
    if (event.source && !USER_SELECTION_SOURCES.has(event.source)) return;
    const next = new Set(selected());
    let changed = false;
    event.api.forEachNode((node) => {
      const id = node.data?.id;
      if (!id) return;
      if (node.isSelected()) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      } else if (next.delete(id)) {
        changed = true;
      }
    });
    if (changed) setSelected(next);
  };

  createEffect(() => {
    selected();
    applyLoadedSelection();
  });

  const clearSelection = () => {
    modelsGridApi?.deselectAll();
    setSelected(new Set<string>());
    setSelectedOnly(false);
  };

  const selectAllFiltered = async () => {
    const gridApi = modelsGridApi;
    if (!gridApi) return;
    setSelectingAll(true);
    try {
      const filters = gridApi.getFilterModel();
      const sort = gridApi
        .getColumnState()
        .filter((column) => column.sort)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((column) => ({ colId: column.colId, sort: column.sort! }));
      const ids: string[] = [];
      let offset = 0;
      let total = 0;

      do {
        const qs = new URLSearchParams({
          limit: "500",
          offset: String(offset),
        });
        if (Object.keys(filters).length > 0) {
          qs.set("filters", JSON.stringify(filters));
        }
        if (sort.length > 0) qs.set("sort", JSON.stringify(sort));
        const page = await api<{ models: ModelDto[]; total: number }>(
          "GET",
          `/api/admin/models?${qs}`,
        );
        total = page.total;
        ids.push(...page.models.map((model) => model.id));
        offset += page.models.length;
        if (page.models.length === 0) break;
      } while (offset < total);

      const next = new Set(selected());
      for (const id of ids) next.add(id);
      setSelected(next);
      applyLoadedSelection(gridApi);
      toast(`${ids.length} model${ids.length === 1 ? "" : "s"} selected`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not select filtered models", "err");
    } finally {
      setSelectingAll(false);
    }
  };

  const [modelCount, { refetch: refetchModelCount }] = createResource(async () => {
    const j = await api<{ total: number }>("GET", "/api/admin/models?limit=1");
    return j.total;
  });
  const [providers] = createResource(async () => {
    const j = await api<{ providers: ProviderDto[] }>("GET", "/api/admin/providers");
    return j.providers;
  });
  const [gridVersion, setGridVersion] = createSignal(0);
  const [modelsList, { refetch: refetchModelsList }] = createResource(gridVersion, async () => {
    try {
      const j = await api<{ models: ModelDto[] }>("GET", "/api/admin/models?limit=100");
      return j.models;
    } catch {
      return [];
    }
  });
  const refreshGrid = () => {
    clearSelection();
    setGridVersion((v) => v + 1);
    refetchModelCount();
    refetchModelsList();
  };

  const [cardSearch, setCardSearch] = createSignal("");
  const [cardStatusFilter, setCardStatusFilter] = createSignal<"all" | "active" | "disabled">("all");
  const [cardProviderFilter, setCardProviderFilter] = createSignal<string>("all");

  const providerFilterOptions = createMemo(() => [
    { value: "all", label: "All providers" },
    ...(providers() ?? []).map((p) => ({ value: p.id, label: p.name })),
  ]);

  const filteredModels = createMemo(() => {
    let list = modelsList() ?? [];
    const st = cardStatusFilter();
    if (st === "active") list = list.filter((m) => m.enabled);
    if (st === "disabled") list = list.filter((m) => !m.enabled);

    const prov = cardProviderFilter();
    if (prov !== "all") list = list.filter((m) => m.providerId === prov || m.providerName === prov);

    const q = cardSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          (m.name && m.name.toLowerCase().includes(q)) ||
          (m.upstreamModel && m.upstreamModel.toLowerCase().includes(q)) ||
          (m.providerName && m.providerName.toLowerCase().includes(q)),
      );
    }
    return list;
  });

  const activeModelCount = createMemo(() => (modelsList() ?? []).filter((m) => m.enabled).length);
  const disabledModelCount = createMemo(() => (modelsList() ?? []).filter((m) => !m.enabled).length);

  const modelsGridHeight = () => {
    const count = modelCount() ?? 0;
    if (count <= 2) return "h-[200px]";
    if (count <= 4) return "h-[280px]";
    if (count <= 8) return "h-[380px]";
    return "h-[540px]";
  };
  const modelsDatasource = serverDatasource<ModelDto>(async (params) => {
    const qs = new URLSearchParams({
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    if (selectedOnly()) {
      qs.set("selected_ids", JSON.stringify([...selected()]));
    }
    const j = await api<{ models: ModelDto[]; total: number }>("GET", `/api/admin/models?${qs}`);
    return { rows: j.models, total: j.total };
  });

  const [routingMode, setRoutingMode] = createSignal<RoutingMode>("passthrough");
  createResource(async () => {
    const j = await api<{ settings: { routingMode: RoutingMode } }>("GET", "/api/admin/settings");
    setRoutingMode(j.settings.routingMode);
    return true;
  });

  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<ModelDto | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<ModelDto | null>(null);
  const [confirmBulk, setConfirmBulk] = createSignal(false);
  const [showAdvanced, setShowAdvanced] = createSignal(false);

  // ---- editor form ----
  const [fId, setFId] = createSignal("");
  const [fTargets, setFTargets] = createSignal<TargetDraft[]>([]);
  const [fEnabled, setFEnabled] = createSignal(true);
  const [fName, setFName] = createSignal("");
  const [fDesc, setFDesc] = createSignal("");
  const [fContext, setFContext] = createSignal("");
  const [fMaxOut, setFMaxOut] = createSignal("");
  const [fInMod, setFInMod] = createSignal("");
  const [fOutMod, setFOutMod] = createSignal("");
  const [fSampling, setFSampling] = createSignal("");
  const [fFeatures, setFFeatures] = createSignal("");
  const [fEfforts, setFEfforts] = createSignal("");
  const [fToolCallMode, setFToolCallMode] = createSignal<ToolCallMode>("fallback");
  const [fPricing, setFPricing] = createSignal<Record<string, string>>({});

  const [enriching, setEnriching] = createSignal(false);
  const enrichAllMissing = async () => {
    setEnriching(true);
    try {
      const res = await api<{ updated: number; message: string }>("POST", "/api/admin/models/enrich-missing");
      toast(res.message || `Enriched ${res.updated} model(s)`, "ok");
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "enrichment failed", "err");
    } finally {
      setEnriching(false);
    }
  };

  const providerOptions = createMemo(() =>
    (providers() ?? []).map((p) => ({ value: p.id, label: p.name })),
  );

  const changeRouting = async (mode: string) => {
    const m = mode as RoutingMode;
    if (m === routingMode()) return;
    try {
      await api("PATCH", "/api/admin/settings", { routingMode: m });
      setRoutingMode(m);
      toast(
        m === "router"
          ? "Router mode on — requests route through the model registry"
          : "Pass-through mode on — model names forward untouched",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not update settings", "err");
    }
  };

  const updateTarget = (i: number, patch: Partial<TargetDraft>) =>
    setFTargets((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const targetsValid = createMemo(
    () => fTargets().length >= 1 && fTargets().every((t) => !!t.providerId),
  );

  const openEditor = (m: ModelDto | "new") => {
    if (m === "new") {
      setFId("");
      setFTargets([{ providerId: providers()?.[0]?.id ?? "", upstreamModel: "", enabled: true }]);
      setFEnabled(true);
      setFName(""); setFDesc("");
      setFContext(""); setFMaxOut("");
      setFInMod("text"); setFOutMod("text"); setFSampling(""); setFFeatures(""); setFEfforts("");
      setFPricing({});
    } else {
      setFId(m.id);
      setFTargets(
        m.targets.length > 0
          ? m.targets.map((t) => ({
              providerId: t.providerId,
              upstreamModel: t.upstreamModel === m.id ? "" : t.upstreamModel,
              enabled: t.enabled,
            }))
          : [{ providerId: "", upstreamModel: "", enabled: true }],
      );
      setFEnabled(m.enabled);
      setFName(m.name); setFDesc(m.description);
      setFContext(m.contextLength == null ? "" : String(m.contextLength));
      setFMaxOut(m.maxOutputLength == null ? "" : String(m.maxOutputLength));
      setFInMod(m.inputModalities.join(", ")); setFOutMod(m.outputModalities.join(", "));
      setFSampling(m.samplingParams.join(", ")); setFFeatures(m.features.join(", "));
      setFEfforts((m.reasoningEfforts ?? []).join(", "));
      setFToolCallMode(m.toolCallMode ?? "fallback");
      setFPricing(
        Object.fromEntries(
          Object.entries(m.pricing ?? {}).map(([key, value]) => [key, perTokenInput(Number(value))]),
        ),
      );
    }
    setShowAdvanced(false);
    setEditing(m);
  };

  /** Clone = pre-filled "new": same metadata/targets, id suffix so the POST
   *  does not collide with the existing row (id is the PK). */
  const cloneModel = (m: ModelDto) => {
    openEditor(m);
    setFId(`${m.id}-copy`);
    setEditing("new"); // POST a new row — openEditor(m) would PATCH/rename the original
  };

  const save = async () => {
    setBusy(true);
    try {
      const pricing: Record<string, string> = {};
      for (const k of PRICING_KEYS) {
        const pv = (fPricing()[k] ?? "").trim();
        if (pv) pricing[k] = pv;
      }
      const body: Record<string, unknown> = {
        enabled: fEnabled(),
        name: fName().trim(),
        description: fDesc(),
        contextLength: numOrNull(fContext()),
        maxOutputLength: numOrNull(fMaxOut()),
        inputModalities: csv(fInMod()),
        outputModalities: csv(fOutMod()),
        samplingParams: csv(fSampling()),
        features: csv(fFeatures()),
        reasoningEfforts: csv(fEfforts()),
        toolCallMode: fToolCallMode(),
        pricing: Object.keys(pricing).length ? pricing : null,
        // Ordered failover chain; "" upstream = defaults to the public id.
        targets: fTargets().map((t) => ({
          providerId: t.providerId,
          upstreamModel: t.upstreamModel.trim() || undefined,
          enabled: t.enabled,
        })),
      };
      if (editing() === "new") {
        body.id = fId().trim();
        await api("POST", "/api/admin/models", body);
        toast("Model registered");
      } else {
        const m = editing() as ModelDto;
        const newId = fId().trim();
        if (newId && newId !== m.id) body.id = newId; // rename (id is the PK)
        await api("PATCH", `/api/admin/models/${encodeURIComponent(m.id)}`, body);
        toast(newId && newId !== m.id ? "Model renamed" : "Model updated");
      }
      setEditing(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (m: ModelDto) => {
    try {
      await api("PATCH", `/api/admin/models/${encodeURIComponent(m.id)}`, { enabled: !m.enabled });
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "update failed", "err");
    }
  };

  const remove = async () => {
    const m = confirmDelete();
    if (!m) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/models/${encodeURIComponent(m.id)}`);
      toast("Model deleted");
      setConfirmDelete(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "delete failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const bulkRemove = async () => {
    setBusy(true);
    try {
      let deleted = 0;
      const ids = [...selected()];
      for (let i = 0; i < ids.length; i += 500) {
        const j = await api<{ deleted: number }>("POST", "/api/admin/models/bulk-delete", {
          ids: ids.slice(i, i + 500),
        });
        deleted += j.deleted;
      }
      toast(`Deleted ${deleted} model${deleted === 1 ? "" : "s"}`);
      setConfirmBulk(false);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "bulk delete failed", "err");
    } finally {
      setBusy(false);
    }
  };

  // ---- grid cells ----

  function ModelIdCell(props: { data?: ModelDto }) {
    const m = props.data;
    if (!m) return null;
    return (
      <span class="text-sm text-ink-100 font-medium truncate block">{m.id}</span>
    );
  }

  function ModelNameCell(props: { data?: ModelDto }) {
    const m = props.data;
    if (!m) return null;
    return (
      <span class="text-ink-400 truncate block">{m.name && m.name !== m.id ? m.name : "—"}</span>
    );
  }

  function ProviderCell(props: { data?: ModelDto }) {
    const m = props.data;
    if (!m) return null;
    return m.providerName ? (
      <span class="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-300">
        {m.providerName}
        <Show when={m.targets.length > 1}>
          <Badge tone="indigo">+{m.targets.length - 1} fallback{m.targets.length === 2 ? "" : "s"}</Badge>
        </Show>
      </span>
    ) : (
      <Badge tone="amber">no provider</Badge>
    );
  }

  function SourceCell(props: { value?: string }) {
    return (
      <Badge tone={props.value === "manual" ? "indigo" : "zinc"}>{props.value}</Badge>
    );
  }

  function EnabledCell(props: { data?: ModelDto }) {
    const m = props.data;
    if (!m) return null;
    return (
      <input
        type="checkbox"
        checked={m.enabled}
        onChange={() => toggleEnabled(m)}
        class="w-4 h-4 rounded border-line bg-elev accent-brand-500 cursor-pointer"
      />
    );
  }

  function ActionsCell(props: { data?: ModelDto }) {
    const m = props.data;
    if (!m) return null;
    return (
      <div class="flex justify-end gap-1">
        <IconBtn icon={Icons.edit} title="Edit model" onClick={() => openEditor(m)} />
        <IconBtn icon={Icons.copy} title="Clone model" onClick={() => cloneModel(m)} />
        <IconBtn icon={Icons.trash} title="Delete model" danger onClick={() => setConfirmDelete(m)} />
      </div>
    );
  }

  const cols: ColDef[] = [
    {
      colId: "sel",
      headerName: "",
      width: 42,
      checkboxSelection: true,
      sortable: false,
      filter: false,
      floatingFilter: false,
      resizable: false,
      pinned: "left",
    },
    { field: "id", headerName: "Model ID", flex: 1.2, minWidth: 180, cellRenderer: ModelIdCell },
    { field: "name", headerName: "Name", flex: 1, minWidth: 140, cellRenderer: ModelNameCell },
    { field: "providerName", headerName: "Provider", flex: 1, minWidth: 140, cellRenderer: ProviderCell },
    {
      field: "upstreamModel",
      headerName: "Upstream model",
      flex: 1,
      minWidth: 140,
      valueGetter: (p) => (p.data?.upstreamModel === p.data?.id ? "—" : p.data?.upstreamModel),
      cellRenderer: (p: { value?: string }) => (
        <code class="text-ink-400 truncate block">{p.value}</code>
      ),
    },
    {
      field: "contextLength",
      headerName: "Context",
      width: 110,
      type: "rightAligned",
      filter: "agNumberColumnFilter",
      valueFormatter: (p) => (p.value != null ? fmtNum(p.value) : "—"),
    },
    {
      colId: "pricing_input",
      headerName: "Input / 1M",
      width: 125,
      cellRenderer: (p: { data?: ModelDto }) => (
        <code class="text-ink-400">
          {pricePerMillion(p.data?.pricingInput)}
        </code>
      ),
      type: "rightAligned",
      filter: "agNumberColumnFilter",
      valueGetter: (p) => pricePerMillionNumber(p.data?.pricingInput),
    },
    {
      colId: "pricing_cache",
      headerName: "Cache read / 1M",
      width: 145,
      cellRenderer: (p: { data?: ModelDto }) => (
        <code class="text-ink-400">
          {pricePerMillion(p.data?.pricingInputCache)}
        </code>
      ),
      type: "rightAligned",
      filter: "agNumberColumnFilter",
      valueGetter: (p) => pricePerMillionNumber(p.data?.pricingInputCache),
    },
    {
      colId: "pricing_cache_write",
      headerName: "Cache write / 1M",
      width: 145,
      cellRenderer: (p: { data?: ModelDto }) => (
        <code class="text-ink-400">
          {pricePerMillion(p.data?.pricingInputCacheWrite)}
        </code>
      ),
      type: "rightAligned",
      filter: "agNumberColumnFilter",
      valueGetter: (p) => pricePerMillionNumber(p.data?.pricingInputCacheWrite),
    },
    {
      colId: "pricing_output",
      headerName: "Output / 1M",
      width: 125,
      cellRenderer: (p: { data?: ModelDto }) => (
        <code class="text-ink-400">
          {pricePerMillion(p.data?.pricingOutput)}
        </code>
      ),
      type: "rightAligned",
      filter: "agNumberColumnFilter",
      valueGetter: (p) => pricePerMillionNumber(p.data?.pricingOutput),
    },
    { field: "source", headerName: "Source", width: 110, cellRenderer: SourceCell },
    { field: "enabled", headerName: "Enabled", width: 90, cellRenderer: EnabledCell, filter: false, floatingFilter: false },
    {
      colId: "actions",
      headerName: "",
      width: 132,
      cellRenderer: ActionsCell,
      sortable: false,
      filter: false,
      floatingFilter: false,
      resizable: false,
      pinned: typeof window !== "undefined" && window.innerWidth >= 1024 ? "right" : undefined,
    },
  ];

  return (
    <div>
      <PageTitle
        title="Models"
        subtitle="Public model registry and provider failover chains"
        right={
          <div class="flex items-center gap-3 flex-wrap">
            <div class="flex items-center gap-2">
              <span class="text-xs text-ink-500">Routing</span>
              <Segmented value={routingMode()} onChange={changeRouting} options={ROUTING_OPTIONS} />
            </div>
            <Btn
              variant="outline"
              onClick={enrichAllMissing}
              disabled={enriching() || busy() || (modelCount() ?? 0) === 0}
              title="Look up and auto-fill missing pricing and metadata for models via OpenRouter"
            >
              <Icon name={Icons.sparkles} /> {enriching() ? "Enriching…" : "Auto-enrich missing"}
            </Btn>
            <Btn onClick={() => openEditor("new")} disabled={(providers() ?? []).length === 0}>
              <Icon name={Icons.plus} /> New model
            </Btn>
          </div>
        }
      />

      <Show when={selected().size > 0 || selectedOnly()}>
        <Card class="p-3 mb-4 flex items-center justify-between">
          <span class="text-xs text-ink-300">{selected().size} selected</span>
          <div class="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={selectAllFiltered} disabled={selectingAll() || busy()}>
              {selectingAll() ? "Selecting…" : "Select all filtered"}
            </Btn>
            <Btn
              variant={selectedOnly() ? "outline" : "ghost"}
              size="sm"
              onClick={() => setSelectedOnly((value) => !value)}
              disabled={
                (!selectedOnly() && selected().size === 0) ||
                selectingAll() ||
                busy()
              }
            >
              Selected only
            </Btn>
            <Btn
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              disabled={
                (!selectedOnly() && selected().size === 0) ||
                selectingAll() ||
                busy()
              }
            >
              Clear
            </Btn>
            <Show when={selected().size > 0}>
              <Btn variant="danger" size="sm" onClick={() => setConfirmBulk(true)} disabled={selectingAll()}>
                <Icon name={Icons.trash} /> Delete selected
              </Btn>
            </Show>
          </div>
        </Card>
      </Show>

      <Show
        when={(modelCount() ?? 0) > 0}
        fallback={
          <Card>
            <EmptyState
              icon={Icons.layers}
              title="No models registered"
              hint="Creating a provider auto-imports its /models list — or add a model manually."
            />
          </Card>
        }
      >
        <Card class="overflow-hidden" {...usalItems("fade-u", 60)}>
          {/* Desktop & Tablet AG Grid */}
          <div class="hidden md:block p-2">
            {/* Selecting a row is local state and must not purge the infinite
                cache. Only changing Selected only mode or a real model
                mutation needs to reload rows. */}
            <UsageGrid
              columnDefs={cols}
              datasource={modelsDatasource}
              cacheBlockSize={100}
              refreshDeps={`${gridVersion()}:${selectedOnly()}:${selectedOnly() ? [...selected()].sort().join(",") : ""}`}
              storageKey="llmgw-grid:admin.models"
              heightClass={modelsGridHeight()}
              rowSelection="multiple"
              suppressRowClickSelection
              getRowId={(p) => p.data.id}
              onGridReady={(e) => {
                modelsGridApi = e.api as GridApi<ModelDto>;
                applyLoadedSelection(modelsGridApi);
              }}
              onModelUpdated={(e) => applyLoadedSelection(e.api as GridApi<ModelDto>)}
              onSelectionChanged={syncLoadedSelection}
            />
          </div>

          {/* Touch / Mobile Card List */}
          <div class="md:hidden p-3 space-y-3">
            {/* Search & Filter Toolbar */}
            <div class="p-3 rounded-xl border border-line bg-elev space-y-3 shadow-xs">
              <div class="relative">
                <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-ink-500">
                  <Icon name={Icons.search} size={15} />
                </span>
                <input
                  type="text"
                  value={cardSearch()}
                  onInput={(e) => setCardSearch(e.currentTarget.value)}
                  placeholder="Search models by name, id or provider…"
                  class="w-full rounded-lg border border-line bg-card pl-9 pr-8 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                />
                <Show when={cardSearch()}>
                  <button
                    type="button"
                    onClick={() => setCardSearch("")}
                    class="absolute inset-y-0 right-0 pr-2.5 flex items-center text-ink-400 hover:text-ink-200 cursor-pointer"
                  >
                    <Icon name={Icons.x} size={14} />
                  </button>
                </Show>
              </div>

              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
                  <FilterChip
                    selected={cardStatusFilter() === "all"}
                    onClick={() => setCardStatusFilter("all")}
                    class="shrink-0"
                  >
                    All ({(modelsList() ?? []).length})
                  </FilterChip>
                  <FilterChip
                    selected={cardStatusFilter() === "active"}
                    onClick={() => setCardStatusFilter("active")}
                    class="shrink-0"
                  >
                    Active ({activeModelCount()})
                  </FilterChip>
                  <Show when={disabledModelCount() > 0}>
                    <FilterChip
                      selected={cardStatusFilter() === "disabled"}
                      onClick={() => setCardStatusFilter("disabled")}
                      class="shrink-0"
                    >
                      Disabled ({disabledModelCount()})
                    </FilterChip>
                  </Show>
                  <Show when={(providers() ?? []).length > 1}>
                    <select
                      value={cardProviderFilter()}
                      onChange={(e) => setCardProviderFilter(e.currentTarget.value)}
                      class="h-6 shrink-0 rounded-md border border-line bg-card px-2 text-[11px] text-ink-300 focus:border-brand-500 focus:outline-none"
                    >
                      <For each={providerFilterOptions()}>
                        {(opt) => <option value={opt.value}>{opt.label}</option>}
                      </For>
                    </select>
                  </Show>
                </div>
                <span class="text-[11px] text-ink-500 tabular-nums shrink-0">
                  Showing {filteredModels().length} of {(modelsList() ?? []).length}
                </span>
              </div>
            </div>

            <Show
              when={filteredModels().length > 0}
              fallback={
                <div class="p-8 text-center rounded-xl border border-line/60 bg-elev space-y-2">
                  <p class="text-xs text-ink-400">
                    No models match your filters.
                  </p>
                  <Show when={cardSearch() || cardStatusFilter() !== "all"}>
                    <button
                      type="button"
                      onClick={() => { setCardSearch(""); setCardStatusFilter("all"); }}
                      class="text-xs text-brand-400 hover:underline cursor-pointer"
                    >
                      Reset filters
                    </button>
                  </Show>
                </div>
              }
            >
              <div class="space-y-3">
                <For each={filteredModels()}>
                  {(m) => (
                    <div class="p-4 rounded-xl border border-line bg-elev space-y-3 shadow-xs">
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-semibold font-mono text-ink-100 truncate">{m.id}</span>
                            <Badge tone={m.enabled ? "green" : "zinc"}>
                              {m.enabled ? "Active" : "Disabled"}
                            </Badge>
                          </div>
                          <div class="text-xs text-ink-400 mt-1 flex items-center gap-2">
                            <span class="px-2 py-0.5 rounded bg-card border border-line text-ink-300">{m.providerName || "No provider"}</span>
                            <Show when={m.upstreamModel && m.upstreamModel !== m.id}>
                              <span class="font-mono text-ink-500 truncate">{m.upstreamModel}</span>
                            </Show>
                          </div>
                        </div>
                        <div class="text-right shrink-0 text-xs text-ink-400">
                          <div>{m.contextLength ? `${fmtNum(m.contextLength)} ctx` : "—"}</div>
                        </div>
                      </div>

                      {/* Pricing row */}
                      <div class="pt-2 border-t border-line/50 grid grid-cols-3 gap-2 text-[11px] text-ink-400">
                        <div>
                          <span class="text-ink-500 block">Input</span>
                          <span class="font-mono text-ink-200">{pricePerMillion(m.pricingInput)}</span>
                        </div>
                        <div>
                          <span class="text-ink-500 block">Cache read</span>
                          <span class="font-mono text-ink-200">{pricePerMillion(m.pricingInputCache)}</span>
                        </div>
                        <div>
                          <span class="text-ink-500 block">Output</span>
                          <span class="font-mono text-ink-200">{pricePerMillion(m.pricingOutput)}</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div class="pt-2 border-t border-line flex items-center justify-between">
                        <button
                          type="button"
                          class="text-xs text-ink-400 hover:text-ink-200 cursor-pointer"
                          onClick={() => toggleEnabled(m)}
                        >
                          {m.enabled ? "Disable" : "Enable"}
                        </button>
                        <div class="flex items-center gap-1.5">
                          <button
                            type="button"
                            class="h-9 px-3 rounded-lg flex items-center gap-1.5 text-xs text-ink-300 hover:text-ink-100 hover:bg-card border border-line cursor-pointer transition-colors"
                            onClick={() => openEditor(m)}
                          >
                            <Icon name={Icons.edit} size={14} /> Edit
                          </button>
                          <button
                            type="button"
                            class="h-9 w-9 rounded-lg flex items-center justify-center text-ink-400 hover:text-ink-100 hover:bg-card border border-line cursor-pointer transition-colors"
                            title="Clone model"
                            onClick={() => cloneModel(m)}
                          >
                            <Icon name={Icons.copy} size={14} />
                          </button>
                          <button
                            type="button"
                            class="h-9 w-9 rounded-lg flex items-center justify-center text-rose-500 hover:bg-rose-500/10 border border-rose-500/30 cursor-pointer transition-colors"
                            title="Delete model"
                            onClick={() => setConfirmDelete(m)}
                          >
                            <Icon name={Icons.trash} size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Card>
      </Show>


      {/* editor modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={editing() === "new" ? "Register model" : `Edit ${(editing() as ModelDto)?.id ?? ""}`}
        subtitle="Configure public model routing, multi-provider failover chains, and client-advertised parameters."
        width="max-w-2xl"
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
              onClick={save}
              disabled={busy() || !targetsValid() || !fId().trim()}
            >
              {busy() ? "Saving…" : "Save model"}
            </Btn>
          </>
        }
      >
        <div class="space-y-5">
          <ModalSection title="Model ID & Status">
            <div class="space-y-3.5">
              <ModalField
                label="Identifier"
                hint={
                  editing() === "new"
                    ? "What clients send as `model` parameter"
                    : "Renaming updates the ID in-place"
                }
              >
                <input
                  type="text"
                  value={fId()}
                  onInput={(e) => setFId(e.currentTarget.value)}
                  placeholder="e.g. gpt-4o, claude-3-7-sonnet"
                  class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                />
              </ModalField>

              <SwitchCard
                checked={fEnabled()}
                onChange={setFEnabled}
                title="Model active in registry"
              />
            </div>
          </ModalSection>

          {/* routing targets / failover chain */}
          <ModalSection
            title="Routing Targets · Fallback Order"
            info="The gateway cascades requests top-down. If an upstream provider hits billing (402) or transient rate limits, the gateway rewrites the model and cascades to the next candidate."
          >
            <div class="space-y-2.5">
              {/* Column header (desktop / tablet) */}
              <div class="hidden sm:flex items-center gap-2 text-[11px] text-ink-400 px-2 select-none">
                <span class="w-5 text-center">#</span>
                <span class="w-[38%]">Provider endpoint</span>
                <span class="w-4 text-center" />
                <span class="flex-1">Upstream model ID</span>
                <span class="w-12 text-center">Active</span>
                <span class="w-6" />
              </div>

              {/* Rows */}
              <div
                class="space-y-2"
                ref={(el) =>
                  attachSortable(el, {
                    onReorder: (ids) =>
                      setFTargets((prev) => ids.map((s) => prev[Number(s)]!).filter(Boolean)),
                  })
                }
              >
                <For each={fTargets()}>
                  {(t, i) => (
                    <div
                      data-id={String(i())}
                      class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-2.5 rounded-xl border border-line bg-ink-950/70 p-2.5 transition-colors hover:border-ink-600"
                    >
                      {/* Top bar on mobile / left side on desktop */}
                      <div class="flex items-center gap-2 flex-1 sm:flex-none sm:w-[38%] min-w-0">
                        <span
                          data-handle
                          class="text-ink-500 hover:text-ink-200 transition-colors shrink-0 cursor-grab active:cursor-grabbing p-1"
                        >
                          <Icon name={Icons.grip} size={14} />
                        </span>
                        <span class="text-xs font-mono font-medium text-ink-400 w-5 shrink-0 text-center">
                          {i() + 1}
                        </span>
                        <div class="flex-1 sm:w-full min-w-0">
                          <Select
                            value={t.providerId}
                            onChange={(v) => updateTarget(i(), { providerId: v })}
                            options={providerOptions()}
                          />
                        </div>
                        {/* Mobile quick actions (Active + Remove) */}
                        <div class="flex sm:hidden items-center gap-2 shrink-0 ml-auto pl-1">
                          <label
                            class="flex items-center gap-1 shrink-0 cursor-pointer text-xs text-ink-300"
                          >
                            <input
                              type="checkbox"
                              checked={t.enabled}
                              onChange={(e) => updateTarget(i(), { enabled: e.currentTarget.checked })}
                              class="w-4 h-4 rounded border-line bg-ink-900 accent-brand-500 cursor-pointer"
                            />
                            <span class="text-[11px] font-medium text-ink-400">On</span>
                          </label>
                          <button
                            type="button"
                            disabled={fTargets().length <= 1}
                            onClick={() => setFTargets((prev) => prev.filter((_, j) => j !== i()))}
                            class="p-1 rounded text-ink-400 hover:text-rose-400 disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer shrink-0"
                          >
                            <Icon name={Icons.x} size={15} />
                          </button>
                        </div>
                      </div>

                      {/* Direction arrow on desktop */}
                      <span class="hidden sm:inline text-ink-500 text-xs shrink-0 select-none">→</span>

                      {/* Model input: on mobile shows inline arrow, takes remaining space */}
                      <div class="flex-1 min-w-0 flex items-center gap-2 pl-7 sm:pl-0">
                        <span class="sm:hidden text-ink-500 text-xs shrink-0 select-none">→</span>
                        <input
                          type="text"
                          value={t.upstreamModel}
                          onInput={(e) => updateTarget(i(), { upstreamModel: e.currentTarget.value })}
                          placeholder={fId() || "defaults to public id"}
                          class="w-full rounded-lg border border-line bg-ink-900/60 px-3 py-1.5 sm:py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                        />
                      </div>

                      {/* Desktop actions */}
                      <div class="hidden sm:flex items-center gap-2 shrink-0">
                        <label
                          class="flex items-center gap-1 shrink-0 cursor-pointer text-xs text-ink-300 px-1"
                        >
                          <input
                            type="checkbox"
                            checked={t.enabled}
                            onChange={(e) => updateTarget(i(), { enabled: e.currentTarget.checked })}
                            class="w-4 h-4 rounded border-line bg-ink-900 accent-brand-500 cursor-pointer"
                          />
                          <span class="text-[11px] font-medium text-ink-400">On</span>
                        </label>
                        <button
                          type="button"
                          disabled={fTargets().length <= 1}
                          onClick={() => setFTargets((prev) => prev.filter((_, j) => j !== i()))}
                          class="p-1 rounded text-ink-400 hover:text-rose-400 disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer shrink-0"
                        >
                          <Icon name={Icons.x} size={15} />
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>

              {/* Add target button */}
              <button
                type="button"
                class="text-xs font-medium text-brand-400 hover:text-brand-300 inline-flex items-center gap-1.5 cursor-pointer py-1.5 transition-colors disabled:opacity-40"
                disabled={fTargets().length >= 8}
                onClick={() =>
                  setFTargets((prev) => [
                    ...prev,
                    {
                      providerId:
                        (providers() ?? []).find((p) => !prev.some((t) => t.providerId === p.id))?.id ??
                        providers()?.[0]?.id ??
                        "",
                      upstreamModel: "",
                      enabled: true,
                    },
                  ])
                }
              >
                <Icon name={Icons.plus} size={13} />
                <span>Add fallback target</span>
              </button>
            </div>
          </ModalSection>

          <ModalSection title="Capabilities">
            <Select
              label="Tool calling mode"
              value={fToolCallMode()}
              onChange={(v) => setFToolCallMode(v as ToolCallMode)}
              options={[
                { value: "native", label: "Native only" },
                { value: "fallback", label: "Fallback (default)" },
                { value: "workaround", label: "Workaround (XML)" },
                { value: "own", label: "Own workaround (fenced JSON)" },
              ]}
              hint="Fallback recovers tool calls from markup formats if provider lacks native support."
            />
          </ModalSection>

          <div class="rounded-xl border border-line bg-elev/70 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced())}
              class="w-full flex items-center justify-between px-4 py-3 text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-card/40 transition-colors cursor-pointer"
            >
              <span class="flex items-center gap-2">
                <Icon
                  name={Icons.chevronDown}
                  size={14}
                  class={`transition-transform duration-200 ${showAdvanced() ? "rotate-180" : ""}`}
                />
                <span>Advanced parameters & pricing</span>
              </span>
              <span class="text-[10px] text-ink-500 bg-ink-950/60 px-2 py-0.5 rounded border border-line/60">Optional</span>
            </button>
            <Show when={showAdvanced()}>
              <div class="p-4 pt-3 border-t border-line space-y-4 bg-card/20">
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <ModalField label="Display name">
                      <input
                        type="text"
                        value={fName()}
                        onInput={(e) => setFName(e.currentTarget.value)}
                        placeholder="defaults to id"
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                    <ModalField label="Description">
                      <input
                        type="text"
                        value={fDesc()}
                        onInput={(e) => setFDesc(e.currentTarget.value)}
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <ModalField label="Context length">
                      <input
                        type="number"
                        value={fContext()}
                        onInput={(e) => setFContext(e.currentTarget.value)}
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                    <ModalField label="Max output">
                      <input
                        type="number"
                        value={fMaxOut()}
                        onInput={(e) => setFMaxOut(e.currentTarget.value)}
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <ModalField label="Input modalities (csv)">
                      <input
                        type="text"
                        value={fInMod()}
                        onInput={(e) => setFInMod(e.currentTarget.value)}
                        placeholder="text, image"
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                    <ModalField label="Output modalities (csv)">
                      <input
                        type="text"
                        value={fOutMod()}
                        onInput={(e) => setFOutMod(e.currentTarget.value)}
                        placeholder="text"
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <ModalField label="Sampling params (csv)">
                      <input
                        type="text"
                        value={fSampling()}
                        onInput={(e) => setFSampling(e.currentTarget.value)}
                        placeholder="temperature, top_p"
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                    <ModalField label="Features (csv)">
                      <input
                        type="text"
                        value={fFeatures()}
                        onInput={(e) => setFFeatures(e.currentTarget.value)}
                        placeholder="tools, reasoning"
                        class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                      />
                    </ModalField>
                  </div>
                  <ModalField label="Reasoning efforts (csv)">
                    <input
                      type="text"
                      value={fEfforts()}
                      onInput={(e) => setFEfforts(e.currentTarget.value)}
                      placeholder="low, medium, high"
                      class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                    />
                  </ModalField>
                  <div>
                    <div class="text-xs font-medium text-ink-300 mb-2">Pricing (per token, USD strings)</div>
                    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <For each={PRICING_KEYS}>
                        {(k) => (
                          <ModalField label={k}>
                            <input
                              type="text"
                              value={fPricing()[k] ?? ""}
                              onInput={(e) => setFPricing((prev) => ({ ...prev, [k]: e.currentTarget.value }))}
                              placeholder="0.00000475"
                              class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                            />
                          </ModalField>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </Show>
            </div>
        </div>
      </Modal>

      {/* delete confirm (single) */}
      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete model"
        subtitle="Remove this model registration from the gateway routing registry."
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
              {busy() ? "Deleting…" : "Delete model"}
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Confirm model deletion">
            Delete model <strong class="text-white">{confirmDelete()?.id}</strong>? Requests targeting
            this model ID in router mode will immediately fail with 404 Not Found.
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Deletion impact:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>Model is removed from registry and routing fallback tables.</li>
              <li>Calls in router mode specifying this model will return 404.</li>
              <li>Historical usage metrics and spend records remain safely stored.</li>
            </ul>
          </div>
        </div>
      </Modal>

      {/* delete confirm (bulk) */}
      <Modal
        open={confirmBulk()}
        onClose={() => setConfirmBulk(false)}
        title="Delete selected models"
        subtitle="Remove all selected model registrations from the gateway routing registry."
        width="max-w-lg"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setConfirmBulk(false)}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={bulkRemove}
              disabled={busy()}
            >
              {busy() ? "Deleting…" : `Delete ${selected().size} models`}
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Bulk deletion">
            Delete <strong class="text-white">{selected().size}</strong> selected model
            {selected().size === 1 ? "" : "s"}? Router-mode requests for these models will immediately return 404.
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Bulk purge summary:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>All {selected().size} model definitions will be dropped from routing.</li>
              <li>Pass-through requests remain unaffected.</li>
              <li>Usage ledger records and historical logs will be preserved.</li>
            </ul>
          </div>
        </div>
      </Modal>
    </div>
  );
}
