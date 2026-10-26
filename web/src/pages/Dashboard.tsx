import {
  createMemo,
  createResource,
  Show,
  type JSX,
} from "solid-js";

import { AnalyticsToolbar, createAnalyticsFilters } from "../analytics-filters";
import { api, type ApiKeyDto, type DailyPoint, type TopModelDto } from "../api";
import { PageTitle, navigate } from "../index";
import { DailyChart } from "../charts";
import { rangeUnit } from "../analytics-range";
import { RequestHeatmap } from "../RequestHeatmap";
import { TopModelsCard } from "../OverviewInsights";
import type { ActivityScope } from "../overview-activity";
import { usal, usalItems } from "../motion";
import {
  Card,
  CountUp,
  DeltaPill,
  Icon,
  IconTile,
  Icons,
  ProgressBar,
  copyWithToast,
  fmtCost,
  fmtNum,
} from "../ui";

/** Compare the selected window with the immediately preceding equal window. */
function deltaPct(current: DailyPoint[], previous: DailyPoint[], pick: (d: DailyPoint) => number): number | null {
  const base = previous.reduce((sum, d) => sum + pick(d), 0);
  return base > 0 ? ((current.reduce((sum, d) => sum + pick(d), 0) - base) / base) * 100 : null;
}

function HeroHeader(props: {
  icon: string;
  count?: number;
  cost?: number;
  label: string;
  delta: number | null;
}) {
  return (
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="text-xs font-medium text-ink-500 mb-2 truncate">{props.label}</div>
        <div
          class="text-[32px] sm:text-[38px] leading-tight font-light tracking-tight truncate"
          title={props.cost !== undefined ? fmtCost(props.cost, { compact: false }) : props.count !== undefined ? props.count.toLocaleString() : undefined}
        >
          {props.cost !== undefined ? fmtCost(props.cost) : <CountUp value={props.count ?? 0} />}
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <Show when={props.delta !== null}>
          <DeltaPill pct={props.delta!} />
        </Show>
        <IconTile icon={props.icon} class="w-10 h-10" />
      </div>
    </div>
  );
}

/** One token/cost bucket: big number on top, colored dot + label + delta beneath. */
function BucketStat(props: {
  label: string;
  count?: number;
  cost?: number;
  delta: number | null;
  color: string;
}) {
  return (
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5 text-[11px] text-ink-400 font-medium">
        <span
          class="w-1.5 h-1.5 rounded-full inline-block shrink-0"
          style={{ background: props.color }}
        />
        <span class="whitespace-nowrap shrink-0">{props.label}</span>
      </div>
      <div
        class="text-sm sm:text-base font-semibold text-ink-100 tabular-nums leading-tight mt-1 whitespace-nowrap"
        title={props.cost !== undefined ? fmtCost(props.cost, { compact: false }) : props.count !== undefined ? props.count.toLocaleString() : undefined}
      >
        {props.cost !== undefined ? fmtCost(props.cost) : <CountUp value={props.count ?? 0} />}
      </div>
      <div class="mt-1 h-4 flex items-center">
        <Show when={props.delta !== null} fallback={<span class="text-[10px] text-ink-600 leading-none">—</span>}>
          <DeltaPill pct={props.delta!} class="text-[10px] px-1 py-0 leading-none shrink-0" />
        </Show>
      </div>
    </div>
  );
}

const IN_COLOR = "var(--chart-strong)";
const CACHE_COLOR = "var(--chart-mid)";
const OUT_COLOR = "var(--chart-soft)";

export default function DashboardPage() {
  const filters = createAnalyticsFilters();
  const [series] = createResource(filters.query, async (query) => {
    const params = new URLSearchParams(query);
    const range = { preset: "custom", from: params.get("from") === "all" ? null : Number(params.get("from")), to: Number(params.get("to")) };
    const j = await api<{ series: DailyPoint[]; granularity: ActivityScope["unit"]; models: TopModelDto[] }>("GET", `/api/usage/overview?${query}`);
    // Keep counts and their resolved scope together while the next window loads.
    return { points: j.series, models: j.models, scope: { from: range.from, to: range.to, unit: j.granularity ?? rangeUnit(range) } };
  });
  const [previous] = createResource(filters.query, async (query) => {
    const params = new URLSearchParams(query);
    if (params.get("from") === "all") return [];
    const range = { from: Number(params.get("from")), to: Number(params.get("to")) };
    if (range.from === 0) return [];
    params.set("from", String(Math.max(0, range.from - (range.to - range.from))));
    params.set("to", String(range.from));
    const j = await api<{ series: DailyPoint[] }>("GET", `/api/usage/daily?${params}`);
    return j.series;
  });
  const [keys] = createResource(async () => {
    const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
    return j.keys;
  });
  const view = () => series()?.points ?? [];
  const comparison = () => previous.loading ? [] : previous() ?? [];
  // Keep the three buckets visible alongside the requested combined headline.
  const winIn = createMemo(() =>
    view().reduce((s, d) => s + (d.in_tok ?? 0), 0),
  );
  const winCache = createMemo(() =>
    view().reduce((s, d) => s + (d.cache_tok ?? 0), 0),
  );
  const winOut = createMemo(() =>
    view().reduce((s, d) => s + (d.out_tok ?? 0), 0),
  );
  const winReqs = createMemo(() =>
    view().reduce((s, d) => s + (d.reqs ?? 0), 0),
  );
  const winCost = createMemo(() =>
    view().reduce((s, d) => s + (d.cost ?? 0), 0),
  );
  const winCostIn = createMemo(() =>
    view().reduce((s, d) => s + (d.cost_in ?? 0), 0),
  );
  const winCostCache = createMemo(() =>
    view().reduce((s, d) => s + (d.cost_cache ?? 0), 0),
  );
  const winCostOut = createMemo(() =>
    view().reduce((s, d) => s + (d.cost_out ?? 0), 0),
  );
  const inDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.in_tok ?? 0),
  );
  const cacheDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.cache_tok ?? 0),
  );
  const outDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.out_tok ?? 0),
  );
  const tokensDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => (d.in_tok ?? 0) + (d.cache_tok ?? 0) + (d.out_tok ?? 0)),
  );
  const cacheHitRate = createMemo(() => winIn() + winCache() > 0 ? winCache() / (winIn() + winCache()) * 100 : null);
  const reqDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.reqs ?? 0),
  );
  const costDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.cost ?? 0),
  );
  const costInDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.cost_in ?? 0),
  );
  const costCacheDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.cost_cache ?? 0),
  );
  const costOutDelta = createMemo(() =>
    deltaPct(view(), comparison(), (d) => d.cost_out ?? 0),
  );

  const budget = createMemo(() => {
    const ks = keys() ?? [];
    return {
      cap: ks.reduce((s, k) => s + (k.totalLimit ?? 0), 0),
      used: ks.reduce((s, k) => s + (k.outputTotal ?? 0), 0),
    };
  });

  const todayStr = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div aria-busy={filters.pending() || series.loading}>
      <div class="overview-header">
        <PageTitle title="Overview" subtitle={todayStr} />
        <AnalyticsToolbar filters={filters} loading={series.loading} align="end" />
      </div>

      {/* Keep the previous window visible while refreshing. The keyed resource
          mounts CountUp with resolved values so USAL always owns fresh nodes. */}
      <Show when={series() !== undefined}>
        <Show when={series()} keyed>
          {(_series) => (
          <div
            class="overview-charts grid grid-cols-1 md:grid-cols-2 gap-5 mb-5"
            {...usalItems("fade-u", 110)}
          >
            <Card class="overview-spend p-5 min-w-0 flex flex-col justify-between">
              <div>
                <HeroHeader
                  icon={Icons.dollarSign}
                  cost={winCost()}
                  label={`Spend · ${filters.label()}`}
                  delta={costDelta()}
                />
                <div class="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-line">
                  <BucketStat
                    label="Input"
                    cost={winCostIn()}
                    delta={costInDelta()}
                    color={IN_COLOR}
                  />
                  <BucketStat
                    label="Cache"
                    cost={winCostCache()}
                    delta={costCacheDelta()}
                    color={CACHE_COLOR}
                  />
                  <BucketStat
                    label="Output"
                    cost={winCostOut()}
                    delta={costOutDelta()}
                    color="var(--chart-brand)"
                  />
                </div>
              </div>
              <div
                class="mt-4"
                {...usal("fade-u delay-200 duration-700 threshold-5")}
              >
                <DailyChart
                  series={view()}
                  metric="cost"
                  variant="line"
                  height={200}
                  unit={filters.unit()}
                  resetKey={`spend:${filters.query()}`}
                />
              </div>
            </Card>

            <Card class="overview-tokens p-5 min-w-0 flex flex-col justify-between">
              <div>
                <HeroHeader
                  icon={Icons.chart}
                  count={winIn() + winCache() + winOut()}
                  label={`Tokens · ${filters.label()}`}
                  delta={tokensDelta()}
                />
                <div class="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-line">
                  <BucketStat
                    label="Input"
                    count={winIn()}
                    delta={inDelta()}
                    color={IN_COLOR}
                  />
                  <BucketStat
                    label="Cache"
                    count={winCache()}
                    delta={cacheDelta()}
                    color={CACHE_COLOR}
                  />
                  <BucketStat
                    label="Output"
                    count={winOut()}
                    delta={outDelta()}
                    color={OUT_COLOR}
                  />
                </div>
              </div>
              <div
                class="mt-4"
                {...usal("fade-u delay-250 duration-700 threshold-5")}
              >
                <DailyChart
                  series={view()}
                  metric="tokens"
                  height={200}
                  unit={filters.unit()}
                  resetKey={`tokens:${filters.query()}`}
                />
              </div>
            </Card>

            <div class="overview-activity-row">
              <Card class="overview-requests p-5 min-w-0">
                <HeroHeader icon={Icons.bolt} count={winReqs()} label={`Requests · ${filters.label()}`} delta={reqDelta()} />
                <RequestHeatmap series={view()} scope={series()!.scope} cacheHitRate={cacheHitRate()} />
              </Card>
              <TopModelsCard models={series()!.models} requests={winReqs()} label={filters.label()} />
            </div>
          </div>
          )}
        </Show>
      </Show>

      <div
        class="grid grid-cols-1 lg:grid-cols-2 gap-5"
        {...usalItems("fade-u", 110)}
      >
        <Card class="p-5 min-w-0">
          <div class="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 class="text-sm font-semibold text-ink-100">
                Output token budget
              </h2>
            </div>
            <IconTile icon={Icons.key} class="w-9 h-9 rounded-xl" />
          </div>
          <Show
            when={budget().cap > 0}
            fallback={
              <div>
                <div class="text-[28px] font-light tracking-tight mb-2">
                  Unlimited
                </div>
                <p class="text-xs text-ink-500 leading-relaxed">
                  No lifetime output caps set. Add a total output limit to any
                  key to track spend against a cap here.
                </p>
              </div>
            }
          >
            <div class="flex items-baseline gap-2 mb-3">
              <span class="text-[28px] font-light tracking-tight">
                <CountUp value={budget().used} />
              </span>
              <span class="text-sm text-ink-500">
                of {fmtNum(budget().cap)} output tokens
              </span>
            </div>
            <ProgressBar value={budget().used} max={budget().cap} danger />
            <div class="mt-2.5 text-[11px] text-ink-500 tabular-nums">
              {budget().cap > 0
                ? `${Math.min(100, Math.round((budget().used / budget().cap) * 100))}% consumed · ${fmtNum(budget().cap - budget().used)} remaining`
                : ""}
            </div>
          </Show>
        </Card>

        <Card class="p-5 min-w-0">
          <div class="mb-4">
            <h2 class="text-sm font-semibold text-ink-100">
              Endpoint configuration
            </h2>
          </div>
          <div class="grid gap-3">
            <EndpointRow
              label="OpenAI-compatible"
              value={`${location.origin}/openai/v1`}
            />
            <EndpointRow
              label="Anthropic-compatible"
              value={`${location.origin}/anthropic/v1`}
            />
            <Show when={(keys() ?? []).length === 0}>
              <button
                onClick={() => navigate("/keys")}
                class="ui-button ui-button-primary group mt-1 w-full justify-between"
                {...usal("zoomin-15 delay-150 duration-500")}
              >
                Create your first API key
                <Icon
                  name={Icons.arrowUpRight}
                  size={16}
                  class="transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                />
              </button>
            </Show>
          </div>
        </Card>
      </div>
    </div>
  );
}

function EndpointRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="min-w-0">
      <div class="text-xs font-medium text-ink-400 mb-1.5">{props.label}</div>
      <div class="min-w-0 flex items-center justify-between rounded-xl bg-elev border border-line pl-3.5 pr-1.5 py-1.5 gap-2 transition-colors hover:border-ink-600 focus-within:border-brand-500">
        <span class="text-xs text-ink-200 select-all font-mono truncate min-w-0 flex-1">
          {props.value}
        </span>
        <button
          type="button"
          onClick={() => copyWithToast(props.value)}
          class="h-7 w-7 shrink-0 rounded-lg bg-card/60 border border-line/60 flex items-center justify-center text-ink-400 hover:text-ink-100 hover:bg-card transition-colors cursor-pointer"
          title="Copy endpoint URL"
        >
          <Icon name={Icons.copy} size={13} />
        </button>
      </div>
    </div>
  );
}
