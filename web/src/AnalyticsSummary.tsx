import { For, Show, createMemo } from "solid-js";
import type { AnalyticsReport } from "./api";
import { DailyChart } from "./charts";
import { TokenBucketsChart } from "./AnalyticsCharts";
import { analyticsTotals, type AnalyticsMetric } from "./analytics-data";
import { RequestHeatmap } from "./RequestHeatmap";
import { Card, CountUp, DeltaPill, IconTile, Icons, fmtCost } from "./ui";

export function AnalyticsHero(props: {
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
export function AnalyticsBucket(props: {
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

export function AnalyticsSummary(props: { report: AnalyticsReport; label: string; query: string; section: "spend" | "tokens" | "requests" | "costs" }) {
  const totals = createMemo(() => analyticsTotals(props.report.series));
  const previous = createMemo(() => analyticsTotals(props.report.previous));
  const value = (field: AnalyticsMetric) => totals()[field];
  const delta = (fields: AnalyticsMetric[]) => {
    const before = fields.reduce((sum, field) => sum + previous()[field], 0);
    const now = fields.reduce((sum, field) => sum + value(field), 0);
    return before > 0 ? (now - before) / before * 100 : null;
  };
  const cacheRate = createMemo(() => value("in_tok") + value("cache_tok") > 0 ? value("cache_tok") / (value("in_tok") + value("cache_tok")) * 100 : null);
  const buckets = [
    { label: "Input", token: "in_tok", cost: "cost_in", color: "var(--chart-strong)" },
    { label: "Cache", token: "cache_tok", cost: "cost_cache", color: "var(--chart-mid)" },
    { label: "Output", token: "out_tok", cost: "cost_out", color: "var(--chart-brand)" },
  ] as const;
  return <div class={`analytics-summary ${props.section === "costs" ? "is-pair" : "is-single"}`}>
    <Show when={props.section === "spend" || props.section === "costs"}><Card class="analytics-summary-spend p-5 min-w-0 flex flex-col">
      <AnalyticsHero icon={Icons.dollarSign} cost={value("cost")} label={`Spend · ${props.label}`} delta={delta(["cost"])} />
      <div class="analytics-summary-buckets"><For each={buckets}>{(bucket) => <AnalyticsBucket label={bucket.label} cost={value(bucket.cost)} color={bucket.color} delta={delta([bucket.cost])} />}</For></div>
      <div class="analytics-summary-chart"><DailyChart series={props.report.series} metric="cost" variant="line" height={160} resetKey={props.query} /></div>
    </Card></Show>
    <Show when={props.section === "tokens" || props.section === "costs"}><Card class="analytics-summary-tokens p-5 min-w-0 flex flex-col">
      <AnalyticsHero icon={Icons.chart} count={value("in_tok") + value("cache_tok") + value("out_tok")} label={`Tokens · ${props.label}`} delta={delta(["in_tok", "cache_tok", "out_tok"])} />
      <div class="analytics-summary-buckets"><For each={buckets}>{(bucket) => <AnalyticsBucket label={bucket.label} count={value(bucket.token)} color={bucket.token === "out_tok" ? "var(--chart-soft)" : bucket.color} delta={delta([bucket.token])} />}</For></div>
      <div class="analytics-summary-chart"><TokenBucketsChart series={props.report.series} /></div>
    </Card></Show>
    <Show when={props.section === "requests"}><Card class="analytics-summary-requests overview-requests p-5 min-w-0">
      <AnalyticsHero icon={Icons.bolt} count={value("reqs")} label={`Requests · ${props.label}`} delta={delta(["reqs"])} />
      <RequestHeatmap series={props.report.series} scope={{ ...props.report.scope, unit: props.report.granularity }} cacheHitRate={cacheRate()} />
    </Card></Show>
  </div>;
}
