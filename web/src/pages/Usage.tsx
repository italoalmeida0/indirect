import { For, createEffect, on, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js";

import { api } from "../api";
import { AnalyticsToolbar, createAnalyticsFilters } from "../analytics-filters";
import { PageTitle } from "../index";
import { createAnalyticsReport } from "../analytics-report";
import { AnalyticsSummary } from "../AnalyticsSummary";
import { AnalyticsError, AnalyticsLoading, AnalyticsSection, ApiKeyUsageCard, CacheUsageChart, ModelUsageChart, RequestOutcomesChart } from "../AnalyticsCharts";
import {
  Card,
  CardHeader,
  EmptyState,
  Icon,
  Icons,
  fmtCost,
  fmtNum,
} from "../ui";
import {
  UsageGrid,
  ProtoCell,
  serverDatasource,
  StatusCell,
  latencyFormatter,
  timeFormatter,
  tokenFormatter,
  costFormatter,
} from "../aggrid";
import type { ColDef } from "ag-grid-community";

const EVENTS_BLOCK = 100;

const fmtOrDash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

const eventCols: ColDef[] = [
  { field: "ts", headerName: "Time", width: 170, minWidth: 160, valueFormatter: timeFormatter },
  { field: "key_name", headerName: "Key", width: 150, minWidth: 130, flex: 0.8 },
  { field: "proto", headerName: "Protocol", width: 110, minWidth: 100, cellRenderer: ProtoCell },
  { field: "provider_name", headerName: "Provider", width: 150, minWidth: 130, flex: 1, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "model", headerName: "Model", flex: 1.2, minWidth: 150, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "upstream_model", headerName: "Upstream", width: 150, minWidth: 130, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "in_tok", headerName: "In", width: 90, minWidth: 85, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 95, minWidth: 90, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 90, minWidth: 85, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "cost_in", headerName: "In Cost", width: 95, minWidth: 90, type: "rightAligned", valueFormatter: costFormatter },
  { field: "cost_cache", headerName: "Cache Cost", width: 105, minWidth: 100, type: "rightAligned", valueFormatter: costFormatter },
  { field: "cost_out", headerName: "Out Cost", width: 95, minWidth: 90, type: "rightAligned", valueFormatter: costFormatter },
  { field: "cost", headerName: "Total Cost", width: 110, minWidth: 105, type: "rightAligned", valueFormatter: costFormatter },
  { field: "latency_ms", headerName: "Latency", width: 95, minWidth: 90, type: "rightAligned", valueFormatter: latencyFormatter },
  { field: "status", headerName: "Status", width: 90, minWidth: 85, type: "rightAligned", cellRenderer: StatusCell },
];

export default function UsagePage() {
  const filters = createAnalyticsFilters();
  const query = filters.query;
  const { report, refetch } = createAnalyticsReport(filters);
  const media = window.matchMedia("(max-width: 767px)");
  const [mobile, setMobile] = createSignal(media.matches);
  const resize = () => setMobile(media.matches);
  media.addEventListener("change", resize);
  onCleanup(() => media.removeEventListener("change", resize));

  // Every count and page shares the same exact scope as the chart.
  let countAbort: AbortController | undefined;
  let mobileAbort: AbortController | undefined;
  onCleanup(() => { countAbort?.abort(); mobileAbort?.abort(); });
  const [eventCount, countActions] = createResource(query, async (q) => {
    countAbort?.abort();
    countAbort = new AbortController();
    const j = await api<{ total: number }>("GET", `/api/usage/events?${q}&summary=1`, undefined, countAbort.signal);
    return j.total;
  });
  const [mobilePage, setMobilePage] = createSignal(1);
  const [expandedEventKey, setExpandedEventKey] = createSignal<string | null>(null);
  createEffect(on(query, () => { setMobilePage(1); setExpandedEventKey(null); }));
  const mobileQuery = createMemo(() => mobile() ? { scope: query(), page: mobilePage() } : false);
  const [recentEventsList, mobileActions] = createResource(mobileQuery, async (q) => {
    mobileAbort?.abort();
    mobileAbort = new AbortController();
    const j = await api<{ events: any[] }>("GET", `/api/usage/events?${q.scope}&limit=25&offset=${(q.page - 1) * 25}`, undefined, mobileAbort.signal);
    return j.events;
  });
  const totalMobilePages = createMemo(() => Math.max(1, Math.ceil((eventCount.error ? 0 : eventCount() ?? 0) / 25)));

  /** AG Grid infinite row model: blocks are fetched from the API on scroll,
   *  with the grid's sortModel/filterModel translated to SQL server-side.
   *  Forward scrolling uses the keyset cursor of the previous block's last
   *  row (server O(page) instead of O(offset)); jumps/context changes (key,
   *  sort, filters) fall back to OFFSET, which stays correct either way. */
  const eventsDatasource = serverDatasource<any>((() => {
    const cursors = new Map<string, Map<number, { ts: number; id: number }>>();
    return async (params) => {
      const ctx = JSON.stringify([query(), params.sortModel]);
      let ctxCursors = cursors.get(ctx);
      if (!ctxCursors) {
        ctxCursors = new Map();
        if (cursors.size >= 8) cursors.clear();
        cursors.set(ctx, ctxCursors);
      }
      const scope = query();
      const qs = new URLSearchParams(scope);
      qs.set("limit", String(Math.min(params.endRow - params.startRow, 500)));
      qs.set("offset", String(params.startRow));
      if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
      const cursor = params.startRow > 0 ? ctxCursors.get(params.startRow - 1) : undefined;
      // Keep `offset` in the query: the server only honors the cursor for the
      // DEFAULT (ts DESC) ordering — with a column sort or a malformed cursor
      // it falls back to OFFSET, which must still be the right one.
      if (cursor) qs.set("cursor", `${cursor.ts}:${cursor.id}`);
      const j = await api<{ events: any[]; total: number }>(
        "GET",
        `/api/usage/events?${qs.toString()}`,
      );
      const last = j.events[j.events.length - 1];
      if (last && typeof last.ts === "number" && typeof last.id === "number") {
        ctxCursors.set(params.startRow + j.events.length - 1, { ts: last.ts, id: last.id });
      }
      return { rows: j.events, total: j.total };
    };
  })());

  return (
    <div class="analytics-page usage-page" aria-busy={filters.pending() || report.loading || eventCount.loading || recentEventsList.loading}>
      <div class="overview-header">
        <PageTitle title="Usage" subtitle="Understand your spend, models and every request" />
        <AnalyticsToolbar filters={filters} loading={report.loading || eventCount.loading || recentEventsList.loading} align="end" />
      </div>
      <Show when={!report.error} fallback={<AnalyticsError retry={refetch} />}>
        <Show when={report()} fallback={<AnalyticsLoading />} keyed>{(data) => <>
          <AnalyticsSection title="Spend" description="Understand your costs and the models behind them." />
          <AnalyticsSummary report={data} label={data.label} query={data.query} section="spend" />
          <ModelUsageChart modelColors={data.modelColors} data={data.modelSpend} metric="cost" period={data.label} onSelect={(id, label) => filters.toggle("model", "include", id, label)} />
          <AnalyticsSection title="Tokens & caching" description="Track input, cached input and output, then see how effectively your prompts use the cache." />
          <AnalyticsSummary report={data} label={data.label} query={data.query} section="tokens" />
          <CacheUsageChart series={data.series} period={data.label} />
          <AnalyticsSection title="Requests & reliability" description="Follow traffic, response outcomes and the API keys generating activity." />
          <AnalyticsSummary report={data} label={data.label} query={data.query} section="requests" />
          <div class="analytics-detail-grid">
            <ModelUsageChart modelColors={data.modelColors} data={data.modelRequests} metric="reqs" period={data.label} onSelect={(id, label) => filters.toggle("model", "include", id, label)} />
            <RequestOutcomesChart outcomes={data.outcomes} period={data.label} />
          </div>
          <ApiKeyUsageCard keys={data.keys} period={data.label} onSelect={(id, label) => filters.toggle("key_id", "include", id, label)} />
        </>}</Show>
      </Show>
      <AnalyticsSection title="Request history" description="Inspect individual calls with the same date range and filters as your charts." />
      <Card class="usage-request-history">
          <CardHeader
            title="Recent requests"
            subtitle={eventCount.error ? "Request history is unavailable" : eventCount.loading ? "Loading…" : `${fmtNum(eventCount() ?? 0)} events`}
          />
        <Show when={!eventCount.error && !(mobile() && recentEventsList.error)} fallback={<div class="analytics-request-error p-5 flex flex-wrap items-center gap-3" role="alert"><p class="text-xs text-ink-500">Requests could not be loaded. Your filters are preserved.</p><button type="button" class="ui-button ui-button-secondary" onClick={() => { void countActions.refetch(); if (mobile()) void mobileActions.refetch(); }}>Retry requests</button></div>}>
        <Show
          when={eventCount() !== undefined}
          fallback={<div class="p-5 text-xs text-ink-500">Loading…</div>}
        >
          <Show
            when={(eventCount() ?? 0) > 0}
            fallback={<EmptyState icon={Icons.chart} title="No requests in this window" />}
          >
            {/* Desktop AG Grid */}
            <Show when={!mobile()}><div class="hidden md:block px-2 py-2">
              <UsageGrid
                columnDefs={eventCols}
                datasource={eventsDatasource}
                cacheBlockSize={EVENTS_BLOCK}
                refreshDeps={query()}
                heightClass="h-[560px]"
                storageKey="llmgw-grid:usage.recent"
              />
            </div></Show>

            {/* Mobile request details with pagination. */}
            <Show when={mobile()}><div class="usage-mobile-requests p-3 space-y-3">
              <p class="text-[11px] text-ink-500" aria-live="polite">{recentEventsList.loading ? "Loading requests…" : `Showing ${(recentEventsList() ?? []).length} of ${fmtNum(eventCount() ?? 0)} requests`}</p>
              <div class="space-y-2">
                <For each={recentEventsList() ?? []}>
                  {(ev, idx) => {
                    const rowKey = () => `${ev.ts}:${ev.id ?? idx()}`;
                    const isExpanded = () => expandedEventKey() === rowKey();
                    const toggle = () => setExpandedEventKey(isExpanded() ? null : rowKey());

                    return (
                      <div class="rounded-xl border border-line bg-elev transition-colors shadow-xs overflow-hidden">
                        {/* Primary compact summary row */}
                        <button
                          type="button"
                          aria-expanded={isExpanded()}
                          aria-label={`Inspect request for ${ev.model} at ${new Date(ev.ts).toLocaleString()}`}
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
                              <span class="font-mono text-xs font-semibold text-accent-400 tabular-nums shrink-0">
                                {fmtCost(ev.cost)}
                              </span>
                            </div>
                            <div class="flex items-center justify-between text-[11px] text-ink-400 gap-2">
                              <span class="text-ink-300 truncate min-w-0 font-medium">{ev.key_name || "—"}</span>
                              <div class="shrink-0 flex items-center gap-1.5 text-ink-500 font-mono text-[10px]">
                                <span>{latencyFormatter({ value: ev.latency_ms })}</span>
                                <span>·</span>
                                <span>{new Date(ev.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
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
                            <div class="flex flex-wrap items-center justify-between gap-2 text-[10px] text-ink-500 pt-1">
                              <span class="min-w-0 break-all">Provider: <strong class="text-ink-300 font-medium">{ev.provider_name || "—"}</strong></span>
                              <Show when={ev.upstream_model && ev.upstream_model !== ev.model}>
                                <span class="min-w-0 break-all">Upstream: <code class="text-ink-400">{ev.upstream_model}</code></span>
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
            </div></Show>
          </Show>
        </Show>
        </Show>
      </Card>
    </div>
  );
}
