import { computePosition, flip, offset, shift } from "@floating-ui/dom";
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
import { Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

import type { DailyPoint } from "./api";
import { Z } from "./floating";
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

/**
 * Portals a solid-charts `<AxisTooltip>` payload to `document.body` via
 * `@floating-ui/dom` so `.ui-card { overflow: hidden }` and compact chart
 * heights never clip multi-row tooltips at card or viewport boundaries.
 */
export function ChartPortalTooltip(props: { class?: string; children: JSX.Element }) {
  const [active, setActive] = createSignal(false);
  let wrapperEl: HTMLElement | null = null;
  let floatingEl: HTMLDivElement | null = null;
  let lastClientX: number | null = null;
  let lastClientY: number | null = null;
  let cancelled = false;
  onCleanup(() => {
    cancelled = true;
  });

  const reposition = () => {
    if (cancelled || !wrapperEl || !floatingEl || !wrapperEl.isConnected || !floatingEl.isConnected) {
      return;
    }
    const svgEl = wrapperEl.querySelector<SVGSVGElement>("svg[data-sc-chart]") ?? wrapperEl;
    const svgRect = svgEl.getBoundingClientRect();
    if (
      svgRect.width <= 0 ||
      svgRect.height <= 0 ||
      svgRect.bottom < 0 ||
      svgRect.top > window.innerHeight
    ) {
      setActive(false);
      return;
    }
    const cursorEl = wrapperEl.querySelector<SVGLineElement>("[data-sc-axis-cursor]");
    const cursorRect = cursorEl?.getBoundingClientRect();
    const hasCursor =
      cursorRect && (cursorRect.left > 0 || cursorRect.top > 0 || cursorRect.height > 0);
    const anchorX = hasCursor
      ? cursorRect.left + cursorRect.width / 2
      : lastClientX !== null
        ? Math.max(svgRect.left, Math.min(svgRect.right, lastClientX))
        : svgRect.left + svgRect.width / 2;
    const anchorY =
      lastClientY !== null
        ? Math.max(svgRect.top + 8, Math.min(svgRect.bottom - 8, lastClientY))
        : svgRect.top + svgRect.height * 0.4;

    const virtualRef = {
      getBoundingClientRect: () => ({
        width: 0,
        height: 0,
        x: anchorX,
        y: anchorY,
        left: anchorX,
        right: anchorX,
        top: anchorY,
        bottom: anchorY,
      }),
    };

    void computePosition(virtualRef, floatingEl, {
      strategy: "fixed",
      placement: "right",
      middleware: [
        offset(14),
        flip({ padding: 12, fallbackPlacements: ["left", "top", "bottom"] }),
        shift({ padding: 12 }),
      ],
    }).then(({ x, y }) => {
      if (cancelled || !floatingEl) return;
      floatingEl.style.left = `${Math.round(x)}px`;
      floatingEl.style.top = `${Math.round(y)}px`;
      floatingEl.style.visibility = "visible";
    });
  };

  const setupProbe = (probe: HTMLSpanElement) => {
    let raf = 0;
    let teardown: (() => void) | undefined;

    const connect = () => {
      if (cancelled) return;
      const hostEl = probe.closest<HTMLElement>("[data-sc-axis-tooltip]");
      const wrap = hostEl?.closest<HTMLElement>("[data-sc-wrapper]") ?? null;
      if (!hostEl || !wrap) {
        raf = requestAnimationFrame(connect);
        return;
      }
      wrapperEl = wrap;
      const syncActive = () => {
        const visible = hostEl.style.opacity === "1";
        setActive(visible);
        if (visible) reposition();
      };
      const obs = new MutationObserver(syncActive);
      obs.observe(hostEl, { attributes: true, attributeFilter: ["style"] });

      const onMove = (e: MouseEvent | PointerEvent) => {
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        syncActive();
      };
      const onLeave = () => {
        setActive(false);
      };
      const onDocPointerDown = (e: PointerEvent) => {
        if (wrap && e.target instanceof Node && !wrap.contains(e.target)) {
          setActive(false);
        }
      };
      const onViewportChange = () => {
        if (active()) reposition();
      };

      wrap.addEventListener("mousemove", onMove, { passive: true });
      wrap.addEventListener("pointermove", onMove, { passive: true });
      wrap.addEventListener("mouseleave", onLeave, { passive: true });
      document.addEventListener("pointerdown", onDocPointerDown, { passive: true });
      window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
      window.addEventListener("resize", onViewportChange, { passive: true });
      syncActive();

      teardown = () => {
        obs.disconnect();
        wrap.removeEventListener("mousemove", onMove);
        wrap.removeEventListener("pointermove", onMove);
        wrap.removeEventListener("mouseleave", onLeave);
        document.removeEventListener("pointerdown", onDocPointerDown);
        window.removeEventListener("scroll", onViewportChange, true);
        window.removeEventListener("resize", onViewportChange);
      };
    };

    connect();
    onCleanup(() => {
      cancelAnimationFrame(raf);
      teardown?.();
    });
  };

  const setupFloating = (el: HTMLDivElement) => {
    floatingEl = el;
    Object.assign(el.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      zIndex: String(Z.floating),
      pointerEvents: "none",
      visibility: "hidden",
    });
    reposition();
    const fRaf = requestAnimationFrame(reposition);
    const ro = new ResizeObserver(reposition);
    ro.observe(el);
    onCleanup(() => {
      cancelAnimationFrame(fRaf);
      ro.disconnect();
      if (floatingEl === el) floatingEl = null;
    });
  };

  return (
    <>
      <span ref={setupProbe} aria-hidden="true" />
      <Show when={active()}>
        <Portal>
          <div ref={setupFloating} data-chart-portal-tooltip="" class={props.class ?? "chart-tooltip"}>
            {props.children}
          </div>
        </Portal>
      </Show>
    </>
  );
}

function DailyTooltip(props: {
  data: DailyChartPoint;
  metric: "tokens" | "requests" | "cost";
  lines?: boolean;
}) {
  return (
    <div class="analytics-chart-tooltip min-w-44">
      <strong>{props.data.label ?? props.data.date}</strong>
      <Show
        when={props.metric === "cost"}
        fallback={
          <Show
            when={props.metric === "tokens"}
            fallback={
              <div>
                <span>
                  <i style={{ background: OUT_BAR }} />
                  Requests
                </span>
                <b>{fmtNum(props.data.reqs ?? 0)}</b>
              </div>
            }
          >
            <div>
              <span>
                <i style={{ background: IN_BAR }} />
                Input
              </span>
              <b>{fmtNum(props.data.in_tok)}</b>
            </div>
            <div>
              <span>
                <i style={{ background: CACHE_BAR }} />
                Input cache
              </span>
              <b>{fmtNum(props.data.cache_tok ?? 0)}</b>
            </div>
            <div>
              <span>
                <i style={{ background: OUT_BAR }} />
                Output
              </span>
              <b>{fmtNum(props.data.out_tok)}</b>
            </div>
            <div class="border-t border-border pt-1.5 mt-1.5">
              <span>Requests</span>
              <b>{fmtNum(props.data.reqs ?? 0)}</b>
            </div>
          </Show>
        }
      >
        <div>
          <span>
            <i style={{ background: IN_BAR }} />
            Input cost
          </span>
          <b>{fmtCost(props.data.cost_in ?? 0)}</b>
        </div>
        <div>
          <span>
            <i style={{ background: CACHE_BAR }} />
            Cache cost
          </span>
          <b>{fmtCost(props.data.cost_cache ?? 0)}</b>
        </div>
        <div>
          <span>
            <i style={{ background: props.lines ? "var(--chart-brand)" : OUT_BAR }} />
            Output cost
          </span>
          <b>{fmtCost(props.data.cost_out ?? 0)}</b>
        </div>
        <div class="border-t border-border pt-1.5 mt-1.5">
          <span class="font-medium text-fg">Total cost</span>
          <b class="text-success">{fmtCost(props.data.cost ?? 0)}</b>
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
                    <AxisTooltip style={{ visibility: "hidden", width: "0px", height: "0px", overflow: "hidden" }}>
                      {(tooltip) => (
                        <ChartPortalTooltip class="chart-tooltip">
                          <Show when={tooltip.data}>
                            {(d) => <DailyTooltip data={d()} metric={metric()} lines={lines()} />}
                          </Show>
                        </ChartPortalTooltip>
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
