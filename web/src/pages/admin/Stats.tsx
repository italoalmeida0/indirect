import { createMemo, createResource, createSignal, Show } from "solid-js";

import { api, type DailyPoint } from "../../api";
import { AnalyticsToolbar, createAnalyticsFilters } from "../../analytics-filters";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { DailyChart } from "../../charts";
import {
  Card,
  CardHeader,
  EmptyState,
  Icons,
  Segmented,
  StatCard,
  fmtCost,
  fmtNum,
} from "../../ui";
import {
  UsageGrid,
  ProtoCell,
  serverDatasource,
  costFormatter,
  countFormatter,
  tokenFormatter,
  type GridTotals,
} from "../../aggrid";
import type { ColDef } from "ag-grid-community";

interface Buckets {
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
  cost_in?: number;
  cost_cache?: number;
  cost_out?: number;
  cost?: number;
}

interface StatsDto {
  series: DailyPoint[];
  counts: {
    users: number;
    keys: number;
    activeKeys: number;
    providers: number;
  };
  kvCache?: KvCacheSnapshot;
}

/** btdby4 KV provider snapshot (server memoizes it for 60s). */
interface KvCacheSnapshot {
  namespaces: number;
  nodes: number;
  branches: number;
  tokens: number;
  bytes: number;
  max_bytes: number;
  available_bytes: number;
  ttl_seconds: number;
  captured_at: number;
  stale: boolean;
}

interface UserRow extends Buckets {
  user_id: string;
  email: string;
}

interface ModelRow extends Buckets {
  model: string;
  proto: string;
  provider_id: string;
  provider_name: string | null;
  provider_key_id: string;
  provider_key_label: string | null;
  upstream_model: string;
}

const fmtOrDash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

const userCols: ColDef<UserRow>[] = [
  { field: "email", headerName: "User", flex: 1.4 },
  { field: "in_tok", headerName: "In", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "reqs", headerName: "Requests", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: countFormatter },
  { field: "cost_in", headerName: "In Cost", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_cache", headerName: "Cache Cost", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_out", headerName: "Out Cost", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost", headerName: "Total Cost", width: 105, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
];

const modelCols: ColDef<ModelRow>[] = [
  { field: "model", headerName: "Model", flex: 1.2, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "proto", headerName: "Proto", width: 110, cellRenderer: ProtoCell },
  { field: "provider_name", headerName: "Provider", flex: 1, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "upstream_model", headerName: "Upstream", flex: 1, valueFormatter: (p) => fmtOrDash(p.value) },
  {
    field: "provider_key_id",
    headerName: "Upstream key",
    flex: 0.8,
    valueGetter: (p) => p.data?.provider_key_label || p.data?.provider_key_id?.slice(0, 8) || "—",
    valueFormatter: (p) => p.value,
  },
  { field: "reqs", headerName: "Requests", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: countFormatter },
  { field: "in_tok", headerName: "In", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cost_in", headerName: "In Cost", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_cache", headerName: "Cache Cost", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost_out", headerName: "Out Cost", width: 95, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
  { field: "cost", headerName: "Total Cost", width: 105, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: costFormatter },
];

/** Card heading split in two tight spans so long windows never wrap. */
function CardLabel(props: { title: string; window: string }) {
  return (
    <span class="flex flex-col gap-0.5 leading-tight whitespace-nowrap">
      <span class="text-ink-400">{props.title}</span>
      <span class="text-[10px] uppercase tracking-wider text-ink-600">
        {props.window}
      </span>
    </span>
  );
}

export default function AdminStatsPage() {
  const filters = createAnalyticsFilters(true);
  const statsQuery = filters.query;
  const [stats] = createResource(statsQuery, (q) => api<StatsDto>("GET", `/api/admin/stats?${q}`));

  const [breakdownCounts] = createResource(statsQuery, async (q) => {
    const params = new URLSearchParams(q);
    params.set("limit", "1");
    const [users, models] = await Promise.all([
      api<{ total: number }>("GET", `/api/admin/usage-breakdown/users?${params.toString()}`),
      api<{ total: number }>("GET", `/api/admin/usage-breakdown/models?${params.toString()}`),
    ]);
    return { users: users.total, models: models.total };
  });
  const [usersTotals, setUsersTotals] = createSignal<GridTotals | null>(null);
  const [modelsTotals, setModelsTotals] = createSignal<GridTotals | null>(null);
  const usersDatasource = serverDatasource<UserRow>(async (params) => {
    const scope = statsQuery();
    const qs = new URLSearchParams(scope);
    qs.set("limit", String(Math.min(params.endRow - params.startRow, 500)));
    qs.set("offset", String(params.startRow));
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ users: UserRow[]; total: number; totals?: GridTotals }>("GET", `/api/admin/usage-breakdown/users?${qs}`);
    if (j.totals && scope === statsQuery()) setUsersTotals(j.totals);
    return { rows: j.users, total: j.total };
  });
  const modelsDatasource = serverDatasource<ModelRow>(async (params) => {
    const scope = statsQuery();
    const qs = new URLSearchParams(scope);
    qs.set("limit", String(Math.min(params.endRow - params.startRow, 500)));
    qs.set("offset", String(params.startRow));
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ models: ModelRow[]; total: number; totals?: GridTotals }>("GET", `/api/admin/usage-breakdown/models?${qs}`);
    if (j.totals && scope === statsQuery()) setModelsTotals(j.totals);
    return { rows: j.models, total: j.total };
  });

  // Window totals are summed from the displayed series (per bucket — never
  // one lumped "tokens" number), so the cards describe exactly what the
  // chart below shows.
  const winIn = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.in_tok ?? 0), 0),
  );
  const winCache = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.cache_tok ?? 0), 0),
  );
  const winOut = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.out_tok ?? 0), 0),
  );
  const winReqs = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.reqs ?? 0), 0),
  );
  const winCost = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.cost ?? 0), 0),
  );
  const winCostIn = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.cost_in ?? 0), 0),
  );
  const winCostCache = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.cost_cache ?? 0), 0),
  );
  const winCostOut = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.cost_out ?? 0), 0),
  );
  const [chartMetric, setChartMetric] = createSignal<"tokens" | "requests" | "cost">("tokens");

  const usersGridHeight = () => {
    const c = breakdownCounts()?.users ?? 0;
    if (c <= 2) return "h-[190px]";
    if (c <= 4) return "h-[250px]";
    return "h-[420px]";
  };

  const modelsGridHeight = () => {
    const c = breakdownCounts()?.models ?? 0;
    if (c <= 2) return "h-[190px]";
    if (c <= 4) return "h-[260px]";
    return "h-[420px]";
  };

  return (
    <div>
      <PageTitle
        title="Global overview"
        subtitle="Explore usage across users, keys and providers"
      />
      <AnalyticsToolbar filters={filters} />

      <Show when={stats() && !stats.loading}>
        <div
          class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4 mb-5"
          {...usalItems("fade-u", 90)}
        >
          <StatCard
            icon={Icons.chart}
            label={<CardLabel title="Input" window={filters.label()} />}
            countValue={winIn()}
          />
          <StatCard
            icon={Icons.bolt}
            label={
              <CardLabel title="Input cache" window={filters.label()} />
            }
            countValue={winCache()}
          />
          <StatCard
            icon={Icons.arrowUpRight}
            label={<CardLabel title="Output" window={filters.label()} />}
            countValue={winOut()}
            sub={<span>{fmtNum(winReqs())} requests in window</span>}
          />
          <StatCard
            icon={Icons.dollarSign}
            label={<CardLabel title="Est. spend" window={filters.label()} />}
            value={fmtCost(winCost())}
            sub={
              <span>
                In {fmtCost(winCostIn())} · Cache {fmtCost(winCostCache())} · Out {fmtCost(winCostOut())}
              </span>
            }
          />
          <StatCard
            icon={Icons.users}
            label="Users"
            countValue={stats()!.counts.users}
            sub={<span>Registered accounts</span>}
          />
          <StatCard
            icon={Icons.key}
            label="API keys"
            value={`${stats()!.counts.activeKeys}/${stats()!.counts.keys}`}
            sub={<span>active / total</span>}
          />
        </div>

        <Card class="mb-5">
          <CardHeader
            title={filters.unit() === "day" ? "Daily usage" : filters.unit() === "hour" ? "Hourly usage" : "Usage by minute"}
            subtitle={`${chartMetric() === "tokens" ? "Tokens" : chartMetric() === "cost" ? "Spend ($)" : "Requests"} per ${filters.unit()} (UTC)`}
            right={
              <Segmented
                value={chartMetric()}
                onChange={setChartMetric}
                options={[
                  { value: "tokens", label: "Tokens" },
                  { value: "requests", label: "Requests" },
                  { value: "cost", label: "Cost" },
                ]}
              />
            }
          />
          <div class="px-4 pb-4">
            <DailyChart
              series={stats()!.series}
              metric={chartMetric()}
              unit={filters.unit()}
              resetKey={statsQuery()}
            />
          </div>
        </Card>

        <div class="flex flex-col gap-4" {...usalItems("fade-u", 90)}>
          <Card>
            <CardHeader
              title="Top users"
              subtitle={`By category · ${filters.label()}`}
            />
            <Show
              when={!breakdownCounts.loading}
              fallback={<div class="p-5 text-xs text-ink-500">Loading…</div>}
            >
              <Show
                when={(breakdownCounts()?.users ?? 0) > 0}
                fallback={
                  <div class="p-5">
                    <EmptyState icon={Icons.users} title="No user data in this window" />
                  </div>
                }
              >
                <div class="p-2">
                  <UsageGrid
                    columnDefs={userCols}
                    datasource={usersDatasource}
                    cacheBlockSize={100}
                    refreshDeps={statsQuery()}
                    heightClass={usersGridHeight()}
                    storageKey="llmgw-grid:admin.stats.users"
                    totals={usersTotals()}
                  />
                </div>
              </Show>
            </Show>
          </Card>

          <Card>
            <CardHeader
              title="Models by provider"
              subtitle={`Model × provider breakdown · ${filters.label()}`}
            />
            <Show
              when={!breakdownCounts.loading}
              fallback={<div class="p-5 text-xs text-ink-500">Loading…</div>}
            >
              <Show
                when={(breakdownCounts()?.models ?? 0) > 0}
                fallback={
                  <div class="p-5">
                    <EmptyState icon={Icons.chart} title="No model data in this window" />
                  </div>
                }
              >
                <div class="p-2">
                  <UsageGrid
                    columnDefs={modelCols}
                    datasource={modelsDatasource}
                    cacheBlockSize={100}
                    refreshDeps={statsQuery()}
                    heightClass={modelsGridHeight()}
                    storageKey="llmgw-grid:admin.stats.models"
                    totals={modelsTotals()}
                  />
                </div>
              </Show>
            </Show>
          </Card>
        </div>
      </Show>
    </div>
  );
}
