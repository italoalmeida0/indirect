import {
  createMemo,
  createResource,
  ErrorBoundary,
  For,
  Show,
  Suspense,
  type JSX,
  type Resource,
} from "solid-js";

import { PlanUsageCard } from "../billing";
import { AnalyticsToolbar, createAnalyticsFilters } from "../analytics-filters";
import {
  api,
  currentFinancialPolicy,
  policyRevision,
  type DailyPoint,
  type ProjectedApiKeyDto,
  type TopModelDto,
  type UsageHistoryDto,
} from "../api";
import { AnalyticsHistoryNotice } from "../analytics-history";
import { PageTitle, navigate } from "../chrome";
import { DailyChart } from "../charts";
import { rangeUnit } from "../analytics-range";
import { RequestHeatmap } from "../RequestHeatmap";
import { TopModelsCard } from "../OverviewInsights";
import { AnalyticsHero, AnalyticsBucket } from "../AnalyticsSummary";
import type { ActivityScope } from "../overview-activity";
import { usal, usalItems } from "../motion";
import {
  Card,
  Btn,
  Icon,
  Icons,
  copyWithToast,
} from "../ui";

/** Compare the selected window with the immediately preceding equal window. */
function deltaPct(current: DailyPoint[], previous: DailyPoint[], pick: (d: DailyPoint) => number): number | null {
  const base = previous.reduce((sum, d) => sum + pick(d), 0);
  return base > 0 ? ((current.reduce((sum, d) => sum + pick(d), 0) - base) / base) * 100 : null;
}

const IN_COLOR = "var(--chart-strong)";
const CACHE_COLOR = "var(--chart-mid)";
const OUT_COLOR = "var(--chart-soft)";

/** A failed overview read stays a value, not a thrown resource error, so the
 *  page can keep its header, last data and retry action on screen. */
type OverviewSeries =
  | {
      ok: true;
      points: DailyPoint[];
      models: TopModelDto[];
      history?: UsageHistoryDto;
      scope: ActivityScope;
    }
  | { ok: false; error: string };

interface PreviousWindow {
  points: DailyPoint[];
  history?: UsageHistoryDto;
}

const failure = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed";

/**
 * Overview shell: the page header and range controls render immediately and
 * stay interactive while the cards below load. Resources are created here but
 * only read inside `OverviewBody`, which has its own Suspense boundary, so a
 * slow analytics read never blanks the whole route.
 */
export default function DashboardPage() {
  const showUsd = createMemo(() => currentFinancialPolicy().budgetPresentation === "usd");
  const filters = createAnalyticsFilters();
  const [series, { refetch: refetchSeries }] = createResource(
    () => ({ query: filters.query(), rev: policyRevision() }),
    async ({ query }): Promise<OverviewSeries> => {
      try {
        const params = new URLSearchParams(query);
        const range = { preset: "custom", from: params.get("from") === "all" ? null : Number(params.get("from")), to: Number(params.get("to")) };
        const j = await api<{ series: DailyPoint[]; granularity: ActivityScope["unit"]; models: TopModelDto[]; history?: UsageHistoryDto }>("GET", `/api/usage/overview?${query}`);
        // Keep counts and their resolved scope together while the next window loads.
        return { ok: true, points: j.series, models: j.models, history: j.history, scope: { from: j.history?.effective.from ?? range.from, to: j.history?.effective.to ?? range.to, unit: j.granularity ?? rangeUnit(range) } };
      } catch (error) {
        return { ok: false, error: failure(error) };
      }
    },
  );
  const [previous, { refetch: refetchPrevious }] = createResource(
    () => ({ query: filters.query(), rev: policyRevision() }),
    async ({ query }): Promise<PreviousWindow> => {
      try {
        const params = new URLSearchParams(query);
        if (params.get("from") === "all") return { points: [] as DailyPoint[], history: undefined };
        const range = { from: Number(params.get("from")), to: Number(params.get("to")) };
        if (range.from === 0) return { points: [] as DailyPoint[], history: undefined };
        params.set("from", String(Math.max(0, range.from - (range.to - range.from))));
        params.set("to", String(range.from));
        const j = await api<{ series: DailyPoint[]; history?: UsageHistoryDto }>("GET", `/api/usage/daily?${params}`);
        return { points: j.series, history: j.history };
      } catch {
        // The comparison is optional; never fail the overview for it.
        return { points: [] as DailyPoint[], history: undefined };
      }
    },
  );
  const [keys, { refetch: refetchKeys }] = createResource(policyRevision, async () => {
    try {
      const j = await api<{ keys: ProjectedApiKeyDto[] }>("GET", "/api/keys");
      return j.keys;
    } catch {
      return null;
    }
  });
  const retryOverview = () => {
    refetchSeries();
    refetchPrevious();
    refetchKeys();
  };

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
      <ErrorBoundary
        fallback={(error) => (
          <OverviewError
            message={failure(error)}
            onRetry={() => location.reload()}
          />
        )}
      >
        <Suspense fallback={<OverviewSkeleton spend={showUsd()} />}>
          <OverviewBody
            series={series}
            previous={previous}
            keys={keys}
            filters={filters}
            showUsd={showUsd()}
            onRetry={retryOverview}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function OverviewBody(props: {
  series: Resource<OverviewSeries>;
  previous: Resource<PreviousWindow>;
  keys: Resource<ProjectedApiKeyDto[] | null>;
  filters: ReturnType<typeof createAnalyticsFilters>;
  showUsd: boolean;
  onRetry: () => void;
}): JSX.Element {
  const data = createMemo(() => {
    const result = props.series();
    return result?.ok ? result : undefined;
  });
  const error = createMemo(() => {
    const result = props.series();
    return result && !result.ok ? result.error : undefined;
  });
  const view = () => data()?.points ?? [];
  const comparison = () => props.previous.loading ? [] : props.previous()?.points ?? [];
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

  return (
    <div aria-busy={props.series.loading}>
      <Show when={error()}>
        {(message) => <OverviewError message={message()} onRetry={props.onRetry} />}
      </Show>
      <AnalyticsHistoryNotice history={data()?.history} previous={props.previous()?.history} />

      {/* Keep the previous window visible while refreshing. The keyed resource
          mounts CountUp with resolved values so USAL always owns fresh nodes. */}
      <Show when={data()} keyed>
        {(current) => (
          <div
            class={`overview-charts grid grid-cols-1 ${props.showUsd ? "md:grid-cols-2" : ""} gap-5 mb-5`}
            {...usalItems("fade-u", 110)}
          >
            <Show when={props.showUsd}>
              <Card class="overview-spend p-5 min-w-0 flex flex-col justify-between">
                <div>
                  <AnalyticsHero
                    icon={Icons.dollarSign}
                    cost={winCost()}
                    label={`Spend · ${props.filters.label()}`}
                    delta={costDelta()}
                  />
                  <div class="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-line">
                    <AnalyticsBucket
                      label="Input"
                      cost={winCostIn()}
                      delta={costInDelta()}
                      color={IN_COLOR}
                    />
                    <AnalyticsBucket
                      label="Cache"
                      cost={winCostCache()}
                      delta={costCacheDelta()}
                      color={CACHE_COLOR}
                    />
                    <AnalyticsBucket
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
                    unit={current.scope.unit}
                    resetKey={`spend:${props.filters.query()}`}
                  />
                </div>
              </Card>
            </Show>

            <Card class="overview-tokens p-5 min-w-0 flex flex-col justify-between">
              <div>
                <AnalyticsHero
                  icon={Icons.chart}
                  count={winIn() + winCache() + winOut()}
                  label={`Tokens · ${props.filters.label()}`}
                  delta={tokensDelta()}
                />
                <div class="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-line">
                  <AnalyticsBucket
                    label="Input"
                    count={winIn()}
                    delta={inDelta()}
                    color={IN_COLOR}
                  />
                  <AnalyticsBucket
                    label="Cache"
                    count={winCache()}
                    delta={cacheDelta()}
                    color={CACHE_COLOR}
                  />
                  <AnalyticsBucket
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
                  unit={current.scope.unit}
                  resetKey={`tokens:${props.filters.query()}`}
                />
              </div>
            </Card>

            <div class="overview-activity-row">
              <Card class="overview-requests p-5 min-w-0">
                <AnalyticsHero icon={Icons.bolt} count={winReqs()} label={`Requests · ${props.filters.label()}`} delta={reqDelta()} />
                <RequestHeatmap series={view()} scope={current.scope} cacheHitRate={cacheHitRate()} />
              </Card>
              <TopModelsCard models={current.models} requests={winReqs()} label={props.filters.label()} />
            </div>
          </div>
        )}
      </Show>

      <div
        class="grid grid-cols-1 lg:grid-cols-2 gap-5"
        {...usalItems("fade-u", 110)}
      >
        <PlanUsageCard />

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
            <Show when={props.keys()?.length === 0}>
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

function OverviewError(props: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <Card class="overview-error p-4 sm:p-5 mb-5">
      <div class="overview-error-row" role="alert">
        <Icon name="lucide:circle-alert" size={18} class="overview-error-icon text-amber-500" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-ink-100">Usage analytics could not be loaded</p>
          <p class="text-xs text-ink-400 mt-1">
            {props.message.replace(/\.$/, "")}. Retry the selected period.
          </p>
        </div>
        <Btn variant="outline" size="sm" onClick={props.onRetry}>
          Try again
        </Btn>
      </div>
    </Card>
  );
}

/**
 * First-load placeholder for the analytics region. It mirrors the card grid
 * and approximate heights, so the header, plan card and endpoint card do not
 * jump when the payload resolves. The real cards fade in through USAL.
 */
function OverviewSkeleton(props: { spend: boolean }): JSX.Element {
  const metric = () => (
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="ui-skeleton h-2.5 w-24" />
        <div class="ui-skeleton h-8 w-36 mt-3 rounded-lg" />
      </div>
      <div class="ui-skeleton w-10 h-10 rounded-lg" />
    </div>
  );
  const buckets = () => (
    <div class="grid grid-cols-3 gap-2 mt-5 pt-4 border-t border-line">
      <For each={[0, 1, 2]}>
        {() => (
          <div>
            <div class="ui-skeleton h-2 w-10" />
            <div class="ui-skeleton h-3.5 w-16 mt-2" />
            <div class="ui-skeleton h-2 w-8 mt-2" />
          </div>
        )}
      </For>
    </div>
  );
  const chart = () => <div class="ui-skeleton flex-1 min-h-48 mt-5 rounded-xl" />;
  return (
    <div
      class="overview-charts grid grid-cols-1 md:grid-cols-2 gap-5 mb-5"
      role="status"
      aria-label="Loading usage analytics"
    >
      <Show when={props.spend}>
        <Card class="overview-skeleton-card p-5 flex flex-col">
          {metric()}
          {buckets()}
          {chart()}
        </Card>
      </Show>
      <Card class="overview-skeleton-card p-5 flex flex-col">
        {metric()}
        {buckets()}
        {chart()}
      </Card>
      <div class="overview-activity-row">
        <Card class="overview-skeleton-card overview-skeleton-activity p-5 flex flex-col">
          {metric()}
          <div class="ui-skeleton h-2.5 w-28 mt-7" />
          <div class="grid grid-cols-7 gap-1.5 mt-4">
            <For each={Array.from({ length: 28 })}>
              {() => <div class="ui-skeleton aspect-square rounded" />}
            </For>
          </div>
        </Card>
        <Card class="overview-skeleton-card overview-skeleton-activity p-5 flex flex-col">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="ui-skeleton h-3 w-24" />
              <div class="ui-skeleton h-2 w-32 mt-2" />
            </div>
            <div class="ui-skeleton w-5 h-5 rounded" />
          </div>
          <div class="mt-4">
            <For each={[0, 1, 2, 3]}>
              {() => (
                <div class="flex items-center gap-3 py-4 border-b border-line last:border-0">
                  <div class="ui-skeleton h-2.5 w-4" />
                  <div class="min-w-0 flex-1">
                    <div class="ui-skeleton h-3 w-36 max-w-full" />
                    <div class="ui-skeleton h-2 w-52 max-w-full mt-2" />
                  </div>
                  <div class="w-14 shrink-0">
                    <div class="ui-skeleton h-3 w-10 ml-auto" />
                    <div class="ui-skeleton h-1.5 w-full mt-2 rounded-full" />
                  </div>
                </div>
              )}
            </For>
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
