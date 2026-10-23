import { For, createMemo, createResource, createSignal, Show } from "solid-js";

import { api, type ApiKeyDto } from "../api";
import { PageTitle } from "../index";
import { DailyChart } from "../charts";
import {
  Card,
  CardHeader,
  EmptyState,
  FilterChip,
  Icon,
  Icons,
  Segmented,
  Select,
  fmtCost,
  fmtNum,
  windowLabel,
} from "../ui";
import {
  UsageGrid,
  DateTimeFilter,
  DateTimeFloatingFilter,
  ProtoCell,
  serverDatasource,
  StatusCell,
  latencyFormatter,
  timeFormatter,
  tokenFormatter,
  costFormatter,
  type GridTotals,
} from "../aggrid";
import type { ColDef } from "ag-grid-community";

const EVENTS_BLOCK = 100;

interface BreakdownRow {
  key_id: string;
  key_name: string;
  model: string;
  proto: "openai" | "anthropic";
  provider_id: string;
  provider_name: string | null;
  provider_key_id: string;
  provider_key_label: string | null;
  upstream_model: string;
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
  cost_in?: number;
  cost_cache?: number;
  cost_out?: number;
  cost?: number;
}

const fmtOrDash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

const byModelCols: ColDef<BreakdownRow>[] = [
  {
    field: "model",
    headerName: "Model",
    flex: 1.2,
    minWidth: 150,
    valueFormatter: (p) => fmtOrDash(p.value),
  },
  {
    field: "proto",
    headerName: "Proto",
    width: 105,
    minWidth: 95,
    cellRenderer: ProtoCell,
  },
  {
    field: "provider_name",
    headerName: "Provider",
    flex: 1,
    minWidth: 140,
    valueFormatter: (p) => fmtOrDash(p.value),
  },
  {
    field: "upstream_model",
    headerName: "Upstream",
    flex: 1,
    minWidth: 140,
    valueFormatter: (p) => fmtOrDash(p.value),
  },
  {
    field: "provider_key_id",
    headerName: "Upstream key",
    flex: 0.8,
    minWidth: 130,
    valueGetter: (p) => p.data?.provider_key_label || p.data?.provider_key_id?.slice(0, 8) || "—",
    valueFormatter: (p) => p.value,
  },
  { field: "reqs", headerName: "Requests", width: 100, minWidth: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "in_tok", headerName: "In", width: 95, minWidth: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 95, minWidth: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 95, minWidth: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cost_in", headerName: "In Cost", width: 100, minWidth: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_cache", headerName: "Cache Cost", width: 105, minWidth: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_out", headerName: "Out Cost", width: 100, minWidth: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost", headerName: "Total Cost", width: 110, minWidth: 105, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
];

const eventCols: ColDef[] = [
  // Custom From/To datetime-local filter (menu + floating row); the epoch-ms
  // bounds are translated server-side by the gridql "datetime" branch.
  { field: "ts", headerName: "Time", width: 170, minWidth: 160, filter: DateTimeFilter, floatingFilterComponent: DateTimeFloatingFilter, valueFormatter: timeFormatter },
  { field: "key_name", headerName: "Key", width: 150, minWidth: 130, flex: 0.8 },
  { field: "proto", headerName: "Protocol", width: 110, minWidth: 100, cellRenderer: ProtoCell },
  { field: "provider_name", headerName: "Provider", width: 150, minWidth: 130, flex: 1, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "model", headerName: "Model", flex: 1.2, minWidth: 150, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "upstream_model", headerName: "Upstream", width: 150, minWidth: 130, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "in_tok", headerName: "In", width: 90, minWidth: 85, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 95, minWidth: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 90, minWidth: 85, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cost_in", headerName: "In Cost", width: 95, minWidth: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_cache", headerName: "Cache Cost", width: 105, minWidth: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_out", headerName: "Out Cost", width: 95, minWidth: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost", headerName: "Total Cost", width: 110, minWidth: 105, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "latency_ms", headerName: "Latency", width: 95, minWidth: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: latencyFormatter },
  { field: "status", headerName: "Status", width: 90, minWidth: 85, type: "rightAligned", filter: "agNumberColumnFilter", cellRenderer: StatusCell },
];

export default function UsagePage() {
  const [keyId, setKeyId] = createSignal("");
  const [days, setDays] = createSignal("14");
  const [chartMetric, setChartMetric] = createSignal<"tokens" | "requests" | "cost">(
    "tokens",
  );

  const [keys] = createResource(async () => {
    const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
    return j.keys;
  });

  const query = createMemo(() => ({ k: keyId(), d: days() }));

  const [series] = createResource(query, async (q) => {
    const hourly = q.d === "1";
    const j = await api<{ series: any[] }>(
      "GET",
      `/api/usage/daily?${hourly ? "hours=24" : `days=${q.d}`}${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.series;
  });

  const [breakdownCount] = createResource(query, async (q) => {
    const j = await api<{ total: number }>(
      "GET",
      `/api/usage/breakdown?days=${q.d}&limit=1${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.total;
  });
  const [breakdownTotals, setBreakdownTotals] = createSignal<GridTotals | null>(null);
  const breakdownDatasource = serverDatasource<BreakdownRow>(async (params) => {
    const qs = new URLSearchParams({
      days: days(),
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (keyId()) qs.set("key_id", keyId());
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ rows: BreakdownRow[]; total: number; totals?: GridTotals }>("GET", `/api/usage/breakdown?${qs}`);
    if (j.totals) setBreakdownTotals(j.totals);
    return { rows: j.rows, total: j.total };
  });

  // Header count only — LIMIT 1 (the grid below pulls its own blocks).
  const [eventCount] = createResource(query, async (q) => {
    const j = await api<{ total: number }>(
      "GET",
      `/api/usage/events?limit=1${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.total;
  });

  const [mobilePage, setMobilePage] = createSignal(1);
  const [expandedEventKey, setExpandedEventKey] = createSignal<string | null>(null);
  const [mobileSearch, setMobileSearch] = createSignal("");
  const [mobileStatusFilter, setMobileStatusFilter] = createSignal<"all" | "success" | "errors">("all");
  const [mobileProtoFilter, setMobileProtoFilter] = createSignal<"all" | "openai" | "anthropic">("all");
  const mobileQuery = createMemo(() => ({ k: keyId(), p: mobilePage() }));

  const [recentEventsList] = createResource(mobileQuery, async (q) => {
    try {
      const offset = (q.p - 1) * 25;
      const j = await api<{ events: any[] }>("GET", `/api/usage/events?limit=25&offset=${offset}${q.k ? `&key_id=${q.k}` : ""}`);
      return j.events;
    } catch {
      return [];
    }
  });

  const filteredMobileEvents = createMemo(() => {
    let list = recentEventsList() ?? [];
    const st = mobileStatusFilter();
    if (st === "success") list = list.filter((e) => e.status >= 200 && e.status < 300);
    if (st === "errors") list = list.filter((e) => e.status >= 400);

    const proto = mobileProtoFilter();
    if (proto !== "all") list = list.filter((e) => e.proto === proto);

    const q = mobileSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          (e.model && e.model.toLowerCase().includes(q)) ||
          (e.upstream_model && e.upstream_model.toLowerCase().includes(q)) ||
          (e.key_name && e.key_name.toLowerCase().includes(q)) ||
          (e.provider_name && e.provider_name.toLowerCase().includes(q)),
      );
    }
    return list;
  });

  const totalMobilePages = createMemo(() => Math.max(1, Math.ceil((eventCount() ?? 0) / 25)));

  const byModelHeight = () => {
    const count = breakdownCount() ?? 0;
    if (count <= 2) return "h-[190px]";
    if (count <= 4) return "h-[250px]";
    if (count <= 8) return "h-[340px]";
    return "h-[420px]";
  };

  /** AG Grid infinite row model: blocks are fetched from the API on scroll,
   *  with the grid's sortModel/filterModel translated to SQL server-side.
   *  Forward scrolling uses the keyset cursor of the previous block's last
   *  row (server O(page) instead of O(offset)); jumps/context changes (key,
   *  sort, filters) fall back to OFFSET, which stays correct either way. */
  const [eventsTotals, setEventsTotals] = createSignal<GridTotals | null>(null);
  const eventsDatasource = serverDatasource<any>((() => {
    const cursors = new Map<string, Map<number, { ts: number; id: number }>>();
    return async (params) => {
      const ctx = JSON.stringify([keyId(), params.sortModel, params.filterModel]);
      let ctxCursors = cursors.get(ctx);
      if (!ctxCursors) {
        ctxCursors = new Map();
        cursors.set(ctx, ctxCursors);
      }
      const qs = new URLSearchParams({
        limit: String(Math.min(params.endRow - params.startRow, 500)),
        offset: String(params.startRow),
      });
      if (keyId()) qs.set("key_id", keyId());
      if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
      if (Object.keys(params.filterModel).length > 0) {
        qs.set("filters", JSON.stringify(params.filterModel));
      }
      const cursor = params.startRow > 0 ? ctxCursors.get(params.startRow - 1) : undefined;
      // Keep `offset` in the query: the server only honors the cursor for the
      // DEFAULT (ts DESC) ordering — with a column sort or a malformed cursor
      // it falls back to OFFSET, which must still be the right one.
      if (cursor) qs.set("cursor", `${cursor.ts}:${cursor.id}`);
      const j = await api<{ events: any[]; total: number; totals?: GridTotals }>(
        "GET",
        `/api/usage/events?${qs.toString()}`,
      );
      if (j.totals) setEventsTotals(j.totals);
      const last = j.events[j.events.length - 1];
      if (last && typeof last.ts === "number" && typeof last.id === "number") {
        ctxCursors.set(params.startRow + j.events.length - 1, { ts: last.ts, id: last.id });
      }
      return { rows: j.events, total: j.total };
    };
  })());

  const keyOptions = createMemo(() => [
    { value: "", label: "All keys" },
    ...(keys() ?? []).map((k) => ({
      value: k.id,
      label: `${k.name} (${k.prefix}…)`,
    })),
  ]);

  return (
    <div>
      <PageTitle
        title="Usage"
        subtitle="Inspect consumption per key, provider, model and request"
      />

      <Card class="mb-5">
        <div class="p-4 border-b border-line/60 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div class="w-full md:w-64">
            <Select
              label="API Key"
              value={keyId()}
              onChange={setKeyId}
              options={keyOptions()}
            />
          </div>
          <div class="flex items-center gap-2.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
            <Segmented
              value={chartMetric()}
              onChange={setChartMetric}
              options={[
                { value: "tokens", label: "Tokens" },
                { value: "requests", label: "Requests" },
                { value: "cost", label: "Cost" },
              ]}
            />
            <Segmented
              value={days()}
              onChange={setDays}
              options={[
                { value: "1", label: "1D" },
                { value: "7", label: "7D" },
                { value: "14", label: "14D" },
                { value: "30", label: "30D" },
                { value: "90", label: "90D" },
                { value: "all", label: "ALL" },
              ]}
            />
          </div>
        </div>
        <div class="px-4 pb-4 pt-2">
          <Show when={series() && !series.loading} fallback={<div class="h-32" />}>
            <DailyChart
              series={series()!}
              metric={chartMetric()}
              unit={days() === "1" ? "hour" : "day"}
              resetKey={`${days()}:${keyId()}`}
            />
          </Show>
        </div>
      </Card>

      <Card class="mb-5">
        <CardHeader
          title="By model"
          subtitle={`Model × provider breakdown · ${windowLabel(days())}`}
        />
        <Show
          when={!breakdownCount.loading}
          fallback={<div class="p-5 text-xs text-ink-500">Loading…</div>}
        >
          <Show
            when={(breakdownCount() ?? 0) > 0}
            fallback={<EmptyState icon={Icons.chart} title="No model data in this window" />}
          >
            <div class="px-1 py-1">
              <UsageGrid
                columnDefs={byModelCols}
                datasource={breakdownDatasource}
                cacheBlockSize={100}
                refreshDeps={`${days()}:${keyId()}`}
                heightClass={byModelHeight()}
                storageKey="llmgw-grid:usage.by-model"
                totals={breakdownTotals()}
              />
            </div>
          </Show>
        </Show>
      </Card>

      <Card>
          <CardHeader
            title="Recent requests"
            subtitle={eventCount.loading ? "Loading…" : `${fmtNum(eventCount() ?? 0)} events`}
          />
        <Show
          when={!eventCount.loading}
          fallback={<div class="p-5 text-xs text-ink-500">Loading…</div>}
        >
          <Show
            when={(eventCount() ?? 0) > 0}
            fallback={<EmptyState icon={Icons.chart} title="No requests in this window" />}
          >
            {/* Desktop AG Grid */}
            <div class="hidden md:block px-2 py-2">
              <UsageGrid
                columnDefs={eventCols}
                datasource={eventsDatasource}
                cacheBlockSize={EVENTS_BLOCK}
                refreshDeps={keyId()}
                heightClass="h-[560px]"
                storageKey="llmgw-grid:usage.recent"
                totals={eventsTotals()}
              />
            </div>

            {/* Mobile Card List with Filters & Pagination */}
            <div class="md:hidden p-3 space-y-3">
              {/* Search & Filter Toolbar */}
              <div class="p-3 rounded-xl border border-line bg-elev space-y-2.5 shadow-xs">
                <div class="relative">
                  <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-ink-500">
                    <Icon name={Icons.search} size={15} />
                  </span>
                  <input
                    type="text"
                    value={mobileSearch()}
                    onInput={(e) => setMobileSearch(e.currentTarget.value)}
                    placeholder="Search model, key or error…"
                    class="w-full rounded-lg border border-line bg-card pl-9 pr-8 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                  />
                  <Show when={mobileSearch()}>
                    <button
                      type="button"
                      onClick={() => setMobileSearch("")}
                      class="absolute inset-y-0 right-0 pr-2.5 flex items-center text-ink-400 hover:text-ink-200 cursor-pointer"
                    >
                      <Icon name={Icons.x} size={14} />
                    </button>
                  </Show>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                    <FilterChip
                      selected={mobileStatusFilter() === "all" && mobileProtoFilter() === "all"}
                      onClick={() => { setMobileStatusFilter("all"); setMobileProtoFilter("all"); }}
                      class="shrink-0"
                    >
                      All
                    </FilterChip>
                    <FilterChip
                      selected={mobileStatusFilter() === "success"}
                      onClick={() => setMobileStatusFilter(mobileStatusFilter() === "success" ? "all" : "success")}
                      class="shrink-0"
                    >
                      200 OK
                    </FilterChip>
                    <FilterChip
                      selected={mobileStatusFilter() === "errors"}
                      onClick={() => setMobileStatusFilter(mobileStatusFilter() === "errors" ? "all" : "errors")}
                      class="shrink-0"
                    >
                      Errors
                    </FilterChip>
                    <FilterChip
                      selected={mobileProtoFilter() === "openai"}
                      onClick={() => setMobileProtoFilter(mobileProtoFilter() === "openai" ? "all" : "openai")}
                      class="shrink-0"
                    >
                      OpenAI
                    </FilterChip>
                    <FilterChip
                      selected={mobileProtoFilter() === "anthropic"}
                      onClick={() => setMobileProtoFilter(mobileProtoFilter() === "anthropic" ? "all" : "anthropic")}
                      class="shrink-0"
                    >
                      Anthropic
                    </FilterChip>
                  </div>

                  <div class="flex items-center justify-between text-[11px] text-ink-500 pt-1 border-t border-line/40">
                    <span class="tabular-nums">
                      Showing {filteredMobileEvents().length} of {fmtNum(eventCount() ?? 0)} requests
                    </span>
                    <Show when={mobileSearch() || mobileStatusFilter() !== "all" || mobileProtoFilter() !== "all"}>
                      <button
                        type="button"
                        onClick={() => { setMobileSearch(""); setMobileStatusFilter("all"); setMobileProtoFilter("all"); }}
                        class="text-brand-400 hover:underline cursor-pointer"
                      >
                        Clear filters
                      </button>
                    </Show>
                  </div>
                </div>
              </div>

              <div class="space-y-2">
                <For each={filteredMobileEvents()}>
                  {(ev, idx) => {
                    const rowKey = () => `${ev.ts}:${ev.id ?? idx()}`;
                    const isExpanded = () => expandedEventKey() === rowKey();
                    const toggle = () => setExpandedEventKey(isExpanded() ? null : rowKey());

                    return (
                      <div class="rounded-xl border border-line bg-elev transition-colors shadow-xs overflow-hidden">
                        {/* Primary compact summary row */}
                        <button
                          type="button"
                          onClick={toggle}
                          class="w-full text-left p-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-card/50 transition-colors"
                        >
                          <div class="min-w-0 flex-1 space-y-1.5">
                            <div class="flex items-center justify-between gap-2">
                              <div class="flex items-center gap-1.5 min-w-0">
                                <StatusCell value={ev.status} />
                                <span class="text-xs font-semibold text-ink-100 truncate">{ev.model}</span>
                                <ProtoCell value={ev.proto} />
                              </div>
                              <span class="font-mono text-xs font-semibold text-emerald-400 tabular-nums shrink-0">
                                {fmtCost(ev.cost)}
                              </span>
                            </div>
                            <div class="flex items-center justify-between text-[11px] text-ink-400 gap-2">
                              <span class="text-ink-300 truncate min-w-0 font-medium">{ev.key_name || "—"}</span>
                              <div class="shrink-0 flex items-center gap-1.5 text-ink-500 font-mono text-[10px]">
                                <span>{latencyFormatter({ value: ev.latency_ms })}</span>
                                <span>·</span>
                                <span>{new Date(ev.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                              </div>
                            </div>
                            {/* Row 3: Token breakdown strip visible on card */}
                            <div class="flex items-center gap-2 pt-1 border-t border-line/40 text-[10px] text-ink-400 font-mono">
                              <span>In: <strong class="text-ink-200">{fmtNum(ev.in_tok)}</strong></span>
                              <span class="text-ink-600">·</span>
                              <span>Cache: <strong class="text-ink-200">{fmtNum(ev.cache_tok)}</strong></span>
                              <span class="text-ink-600">·</span>
                              <span>Out: <strong class="text-ink-200">{fmtNum(ev.out_tok)}</strong></span>
                            </div>
                          </div>

                          <div class="text-ink-500 shrink-0 self-center pl-1">
                            <span
                              class="inline-block transition-transform duration-150"
                              style={{ transform: isExpanded() ? "rotate(180deg)" : "rotate(0deg)" }}
                            >
                              <Icon name={Icons.chevronDown} size={14} />
                            </span>
                          </div>
                        </button>

                        {/* Collapsible token & pricing breakdown drawer */}
                        <Show when={isExpanded()}>
                          <div class="px-3.5 pb-3.5 pt-1 border-t border-line/60 bg-ink-950/40 text-[11px] space-y-2">
                            <div class="grid grid-cols-3 gap-2 pt-2 text-ink-400">
                              <div class="p-2 rounded-lg bg-card/60 border border-line/40">
                                <span class="text-ink-500 block text-[10px]">Input</span>
                                <span class="font-mono text-ink-100 block font-medium">{fmtNum(ev.in_tok)}</span>
                                <span class="text-ink-500 text-[10px] block">{fmtCost(ev.cost_in)}</span>
                              </div>
                              <div class="p-2 rounded-lg bg-card/60 border border-line/40">
                                <span class="text-ink-500 block text-[10px]">Cache</span>
                                <span class="font-mono text-ink-100 block font-medium">{fmtNum(ev.cache_tok)}</span>
                                <span class="text-ink-500 text-[10px] block">{fmtCost(ev.cost_cache)}</span>
                              </div>
                              <div class="p-2 rounded-lg bg-card/60 border border-line/40">
                                <span class="text-ink-500 block text-[10px]">Output</span>
                                <span class="font-mono text-ink-100 block font-medium">{fmtNum(ev.out_tok)}</span>
                                <span class="text-ink-500 text-[10px] block">{fmtCost(ev.cost_out)}</span>
                              </div>
                            </div>
                            <div class="flex items-center justify-between text-[10px] text-ink-500 pt-1">
                              <span>Provider: <strong class="text-ink-300 font-medium">{ev.provider_name || "—"}</strong></span>
                              <Show when={ev.upstream_model && ev.upstream_model !== ev.model}>
                                <span>Upstream: <code class="text-ink-400">{ev.upstream_model}</code></span>
                              </Show>
                            </div>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>

              {/* Pagination Controls */}
              <Show when={totalMobilePages() > 1}>
                <div class="pt-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    class="h-9 px-3.5 rounded-lg border border-line bg-elev text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-card disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
                    disabled={mobilePage() <= 1}
                    onClick={() => setMobilePage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <span class="text-xs text-ink-400 font-mono tabular-nums">
                    {mobilePage()} / {totalMobilePages()}
                  </span>
                  <button
                    type="button"
                    class="h-9 px-3.5 rounded-lg border border-line bg-elev text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-card disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
                    disabled={mobilePage() >= totalMobilePages()}
                    onClick={() => setMobilePage((p) => Math.min(totalMobilePages(), p + 1))}
                  >
                    Next
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </Card>
    </div>
  );
}
