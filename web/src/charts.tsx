import {
  Axis,
  AxisCursor,
  AxisGrid,
  AxisLabel,
  AxisLine,
  AxisTooltip,
  Bar,
  Chart,
  Line,
  Point,
} from "solid-charts";
import { curveMonotoneX } from "solid-charts/curves";
import { Show, createMemo, type JSX } from "solid-js";

import type { DailyPoint } from "./api";
import { fmtCost, fmtNum, pointLabel } from "./ui";

const IN_BAR = "var(--chart-strong)";
const CACHE_BAR = "var(--chart-mid)";
const OUT_BAR = "var(--chart-soft)";

type DailyChartPoint = DailyPoint & {
  tick: string;
};

type TokenChartPoint = DailyChartPoint & {
  in_visual: number;
  cache_visual: number;
  out_visual: number;
};

/** Per-bucket visual divisors: a typical window's buckets are wildly
 *  disproportionate (e.g. 15M input, 150M cache, 1.5M output), so raw bars
 *  collapse into one dominant block and log1p flattened the differences.
 *  Dividing each bucket by its typical magnitude keeps the three bars
 *  comparable; tooltips keep the exact values. */
const IN_DIVISOR = 8;
const CACHE_DIVISOR = 75;
const OUT_DIVISOR = 1;

function tokenVisualValue(value: number | null | undefined, divisor: number): number {
  return Math.max(0, value ?? 0) / divisor;
}

/** Y-axis tick label: compact and never fractional (raw ticks can render
 *  as "147.4131591025766"). */
function axisNum(value: number): string {
  return fmtNum(Math.round(Number(value)));
}

function axisCost(value: number): string {
  if (value === 0 || Math.abs(value) < 0.0001) return "$0";
  if (value >= 100) return `$${fmtNum(Math.round(value))}`;
  if (value >= 10) return `$${Math.round(value)}`;
  if (value >= 1) return `$${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

function ChartFrame(props: { height: number; children: JSX.Element }) {
  return (
    <div class="relative w-full" style={{ height: `${props.height}px` }}>
      {props.children}
    </div>
  );
}

function DailyTooltip(props: {
  data: DailyChartPoint;
  metric: "tokens" | "requests" | "cost";
}) {
  return (
    <div class="z-20 min-w-36 rounded-xl border border-line bg-elev px-3 py-2 text-[11px] text-ink-200 shadow-xl shadow-black/10">
      <div class="mb-1.5 font-semibold text-ink-100">
        {props.data.label ?? props.data.date}
      </div>
      <Show
        when={props.metric === "cost"}
        fallback={
          <Show
            when={props.metric === "tokens"}
            fallback={
              <div class="flex items-center justify-between gap-4">
                <span>Requests</span>
                <strong class="font-semibold text-ink-100">
                  {fmtNum(props.data.reqs ?? 0)}
                </strong>
              </div>
            }
          >
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-4">
                <span>Input</span>
                <strong class="font-semibold text-ink-100">
                  {fmtNum(props.data.in_tok)}
                </strong>
              </div>
              <div class="flex items-center justify-between gap-4">
                <span>Input cache</span>
                <strong class="font-semibold text-ink-100">
                  {fmtNum(props.data.cache_tok ?? 0)}
                </strong>
              </div>
              <div class="flex items-center justify-between gap-4">
                <span>Output</span>
                <strong class="font-semibold text-ink-100">
                  {fmtNum(props.data.out_tok)}
                </strong>
              </div>
              <div class="flex items-center justify-between gap-4">
                <span>Requests</span>
                <strong class="font-semibold text-ink-100">
                  {fmtNum(props.data.reqs ?? 0)}
                </strong>
              </div>
            </div>
          </Show>
        }
      >
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-4">
            <span>Input cost</span>
            <strong class="font-semibold text-ink-100">
              {fmtCost(props.data.cost_in ?? 0)}
            </strong>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span>Cache cost</span>
            <strong class="font-semibold text-ink-100">
              {fmtCost(props.data.cost_cache ?? 0)}
            </strong>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span>Output cost</span>
            <strong class="font-semibold text-ink-100">
              {fmtCost(props.data.cost_out ?? 0)}
            </strong>
          </div>
          <div class="flex items-center justify-between gap-4 border-t border-line/60 pt-1">
            <span class="font-medium text-ink-100">Total cost</span>
            <strong class="font-semibold text-emerald-400">
              {fmtCost(props.data.cost ?? 0)}
            </strong>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function DailyChart(props: {
  series: DailyPoint[];
  height?: number;
  variant?: "bar" | "line";
  metric?: "tokens" | "requests" | "cost";
  unit?: "day" | "hour" | "minute" | "month";
  /** External filter key; changing it clears solid-charts hover state. */
  resetKey?: string;
}) {
  const metric = () => props.metric ?? "tokens";
  const lines = () => metric() === "cost" && props.variant === "line";
  const data = createMemo<DailyChartPoint[]>(() => {
    const series = props.series;
    const size = Math.max(1, Math.ceil(series.length / 60));
    const points: DailyChartPoint[] = [];
    for (let i = 0; i < series.length; i += size) {
      const chunk = series.slice(i, i + size);
      const first = chunk[0]!;
      const last = chunk[chunk.length - 1]!;
      const tick = pointLabel(first);
      const point: DailyChartPoint = { ...first, tick, date: chunk.length > 1 ? `${first.date} – ${last.date}` : first.date };
      // Preserve every request in long ranges while keeping bars readable.
      for (const key of ["in_tok", "cache_tok", "out_tok", "reqs", "cost_in", "cost_cache", "cost_out", "cost"] as const) {
        point[key] = chunk.reduce((sum, row) => sum + (row[key] ?? 0), 0);
      }
      if (chunk.length > 1) point.label = point.date;
      points.push(point);
    }
    return points;
  });
  const tokenData = createMemo<TokenChartPoint[]>(() =>
    data().map((point) => ({
      ...point,
      in_visual: tokenVisualValue(point.in_tok, IN_DIVISOR),
      cache_visual: tokenVisualValue(point.cache_tok, CACHE_DIVISOR),
      out_visual: tokenVisualValue(point.out_tok, OUT_DIVISOR),
    })),
  );
  const dataKey = createMemo(() =>
    data()
      .map((point) =>
        [
          point.date,
          point.label ?? "",
          point.in_tok,
          point.cache_tok ?? 0,
          point.out_tok,
          point.reqs ?? 0,
          point.cost_in ?? 0,
          point.cost_cache ?? 0,
          point.cost_out ?? 0,
          point.cost ?? 0,
        ].join(":"),
      )
      .join("|"),
  );

  return (
    <Show
      when={data().length > 0}
      fallback={
        <div class="flex h-32 items-center justify-center text-xs text-ink-500">
          No usage data yet
        </div>
      }
    >
      <Show
        when={`${props.resetKey ?? "default"}:${metric()}:${dataKey()}`}
        keyed
      >
        {(_resetKey) => (
          <ChartFrame height={props.height ?? 180}>
            {/* solid-charts 0.0.2 keeps the hovered tick in internal state.
                This keyed wrapper resets it when a provider/window/metric
                changes while the pointer is still over the SVG. */}
            <Show when={metric() === "tokens" ? tokenData() : data()} keyed>
              {(chartData) => (
                <Chart
                  data={chartData}
                  barConfig={{ bandGap: "18%", barGap: "10%" }}
                  class="chart-root"
                >
                  <Axis axis="y" position="left" tickCount={5}>
                    <AxisLabel
                      fill="var(--chart-tick)"
                      font-size="10"
                      format={(value) =>
                        metric() === "cost"
                          ? axisCost(Number(value))
                          : axisNum(Number(value))
                      }
                    />
                    <AxisGrid stroke="var(--chart-grid)" />
                  </Axis>
                  <Axis axis="x" position="bottom" dataKey="tick">
                    <AxisLabel
                      fill="var(--chart-tick)"
                      font-size="10"
                      interval={Math.max(1, Math.ceil(chartData.length / 6))}
                    />
                    <AxisLine stroke="var(--chart-grid)" />
                    <AxisCursor
                      stroke="var(--chart-grid)"
                      stroke-dasharray="3 3"
                      class="chart-cursor"
                    />
                    <AxisTooltip class="chart-tooltip">
                      {(tooltip) => (
                        <DailyTooltip data={tooltip.data} metric={metric()} />
                      )}
                    </AxisTooltip>
                  </Axis>

                  <Show
                    when={lines()}
                    fallback={
                      <Show
                        when={metric() === "requests"}
                        fallback={
                          <>
                            <Bar dataKey={metric() === "tokens" ? "in_visual" : "cost_in"} fill={IN_BAR} rx={3} class="chart-bar chart-bar-input" />
                            <Bar dataKey={metric() === "tokens" ? "cache_visual" : "cost_cache"} fill={CACHE_BAR} rx={3} class="chart-bar" />
                            <Bar dataKey={metric() === "tokens" ? "out_visual" : "cost_out"} fill={OUT_BAR} rx={3} class="chart-bar" />
                          </>
                        }
                      >
                        <Bar dataKey="reqs" fill={OUT_BAR} rx={4} class="chart-bar chart-bar-requests" />
                      </Show>
                    }
                  >
                    <Line dataKey="cost_in" stroke={IN_BAR} stroke-width={2} fill="none" class="spend-line spend-line-input" curve={curveMonotoneX} />
                    <Line dataKey="cost_cache" stroke={CACHE_BAR} stroke-width={2} stroke-dasharray="4 4" fill="none" class="spend-line spend-line-cache" curve={curveMonotoneX} />
                    <Line dataKey="cost_out" stroke="var(--chart-brand)" stroke-width={2.25} fill="none" class="spend-line spend-line-output" curve={curveMonotoneX} />
                    <Show when={chartData.length === 1}>
                      <Point dataKey="cost_in" r={3} fill={IN_BAR} class="spend-point" />
                      <Point dataKey="cost_cache" r={3} fill={CACHE_BAR} class="spend-point" />
                      <Point dataKey="cost_out" r={3} fill="var(--chart-brand)" class="spend-point" />
                    </Show>
                  </Show>
                </Chart>
              )}
            </Show>
          </ChartFrame>
        )}
      </Show>
      <div class="flex min-h-[18px] items-center gap-x-4 gap-y-1 px-1 pt-1.5 text-[11px] text-ink-400">
        <Show
          when={metric() === "requests"}
          fallback={
            <>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: IN_BAR }}
                />
                Input
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: CACHE_BAR }}
                />
                Cache
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: lines() ? "var(--chart-brand)" : OUT_BAR }}
                />
                Output
              </span>
            </>
          }
        >
          <span class="inline-flex items-center gap-1.5">
            <span
              class="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: OUT_BAR }}
            />
            Requests
          </span>
        </Show>
      </div>
    </Show>
  );
}
