import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { Axis, AxisCursor, AxisGrid, AxisLabel, AxisLine, AxisTooltip, Bar, Chart, Line, Point } from "solid-charts";
import type { AnalyticsEntity, AnalyticsReport, DailyPoint, ModelTimeline } from "./api";
import { analyticsBuckets, analyticsTotals, cachePercent } from "./analytics-data";
import { Card, Icon, fmtCost, fmtNum, pointLabel } from "./ui";

const colors = ["var(--chart-series-1)", "var(--chart-series-2)", "var(--chart-series-3)", "var(--chart-series-4)", "var(--chart-series-5)", "var(--chart-mid)"];
const percent = (value: number | null) => value === null ? "—" : `${value.toLocaleString("en", { maximumFractionDigits: 1 })}%`;
const bucketDate = (value: string) => value.replace(/T00:00:00\.000Z$/, "").replace("T", " ").replace(/(:00\.000Z| UTC)$/, "");

function ChartHeading(props: { title: string; subtitle: string; value?: string; note?: string }) {
  return <div class="analytics-chart-heading"><div><h2>{props.title}</h2><p>{props.subtitle}</p></div><Show when={props.value}><div class="analytics-chart-value"><strong>{props.value}</strong><span>{props.note}</span></div></Show></div>;
}

function ChartEmpty(props: { label?: string }) {
  return <div class="analytics-chart-empty"><Icon name="lucide:chart-no-axes-combined" size={26} /><strong>{props.label ?? "No activity in this period"}</strong><span>Choose another time range or adjust your filters.</span></div>;
}

interface BarSeries { label: string; color: string; id?: string | null }
function TimelineBars(props: {
  points: { date: string; label: string; values: number[]; lastDate?: string }[]; groups: BarSeries[];
  currency?: boolean; stacked?: boolean; height?: number; onSelect?: (id: string, label: string) => void;
}) {
  const data = createMemo(() => props.points.map((point) => ({ ...point, ...Object.fromEntries(point.values.map((value, index) => [`v${index}`, value])) })));
  const format = (value: number) => props.currency ? fmtCost(value) : fmtNum(Math.round(value));
  const total = () => props.points.reduce((sum, point) => sum + point.values.reduce((a, b) => a + b, 0), 0);
  return <>
    <Show when={props.groups.length && total() > 0} fallback={<ChartEmpty label={props.currency && props.groups.length ? "No spend recorded in this period" : undefined} />}>
      <Show when={data()} keyed>{(points) => <div class="analytics-timeseries chart-root" style={{ height: `${props.height ?? 240}px` }}>
        <Chart data={points} barConfig={{ bandGap: "24%", barGap: "12%" }}>
          <Axis axis="y" position="left" tickCount={4} axisRange={[0, "max"]}>
            <AxisLabel fill="var(--chart-tick)" font-size="10" format={(value) => format(Number(value))} />
            <AxisGrid stroke="var(--chart-grid)" stroke-dasharray="3 4" />
          </Axis>
          <Axis axis="x" position="bottom" dataKey="label">
            <AxisLabel fill="var(--chart-tick)" font-size="10" interval="preserveStartEnd" labelGap={24} />
            <AxisLine stroke="var(--chart-grid)" />
            <AxisCursor stroke="var(--ink-500)" stroke-dasharray="3 4" class="chart-cursor" />
            <AxisTooltip class="chart-tooltip">{(tooltip) => <div class="analytics-chart-tooltip">
              <strong>{bucketDate(tooltip.data.date)}{tooltip.data.lastDate && tooltip.data.lastDate !== tooltip.data.date ? ` – ${bucketDate(tooltip.data.lastDate)}` : ""} · UTC</strong>
              <For each={props.groups}>{(group, index) => <div><span><i style={{ background: group.color }} />{group.label}</span><b>{format(tooltip.data.values[index()] ?? 0)}</b></div>}</For>
            </div>}</AxisTooltip>
          </Axis>
          <For each={props.groups}>{(group, index) => <Bar dataKey={`v${index()}`} stackId={props.stacked === false ? undefined : "usage"} fill={group.color} rx={2} class="analytics-series-bar" />}</For>
        </Chart>
      </div>}</Show>
    </Show>
    <Show when={props.groups.length}><div class="analytics-chart-legend">
      <For each={props.groups}>{(group, index) => {
        const amount = () => props.points.reduce((sum, point) => sum + (point.values[index()] ?? 0), 0);
        return <button type="button" disabled={!props.onSelect || group.id == null} title={`${group.label}: ${format(amount())}${props.onSelect && group.id != null ? " · Filter all charts by this model" : ""}`} onClick={() => group.id != null && props.onSelect?.(group.id, group.label)}><i style={{ background: group.color }} /><span>{group.label}</span><strong>{format(amount())}</strong></button>;
      }}</For>
    </div></Show>
  </>;
}

export function ModelUsageChart(props: { data: ModelTimeline; metric: "cost" | "reqs"; period: string; modelColors: ReadonlyMap<string, number>; onSelect: (id: string, label: string) => void }) {
  const total = () => props.data.points.reduce((sum, point) => sum + point.values.reduce((a, b) => a + b, 0), 0);
  return <Card class={`analytics-model-chart p-5 min-w-0 ${props.metric === "cost" ? "is-spend" : "is-volume"}`}>
    <ChartHeading title={props.metric === "cost" ? "Usage by model" : "Request volume by model"} subtitle={`Top 5 by ${props.metric === "cost" ? "spend" : "requests"} + other · ${props.period} · UTC`} value={props.metric === "cost" ? fmtCost(total()) : fmtNum(total())} note={props.metric === "cost" ? "across all models" : "requests in this period"} />
    <TimelineBars points={props.data.points} groups={props.data.groups.map((group) => ({ ...group, color: group.id === null ? colors[5]! : colors[props.modelColors.get(group.id) ?? 0]! }))} currency={props.metric === "cost"} onSelect={props.onSelect} />
  </Card>;
}

export function TokenBucketsChart(props: { series: DailyPoint[] }) {
  const points = createMemo(() => analyticsBuckets(props.series).map((point) => ({ date: point.date, lastDate: point.lastDate, label: pointLabel(point), values: [point.in_tok, point.cache_tok, point.out_tok] })));
  return <TimelineBars points={points()} groups={[
    { label: "Input", color: "var(--chart-strong)" }, { label: "Cache", color: "var(--chart-mid)" }, { label: "Output", color: "var(--chart-soft)" },
  ]} stacked={false} height={160} />;
}

export function CacheUsageChart(props: { series: DailyPoint[]; period: string }) {
  const totals = createMemo(() => analyticsTotals(props.series));
  const rate = () => cachePercent(totals().in_tok, totals().cache_tok);
  const points = createMemo(() => analyticsBuckets(props.series).map((point) => ({ date: point.date, lastDate: point.lastDate, label: pointLabel(point), values: [point.in_tok, point.cache_tok] })));
  return <Card class="analytics-cache-chart p-5 min-w-0">
    <ChartHeading title="Prompt token caching" subtitle={`Uncached and cached input · ${props.period} · UTC`} value={percent(rate())} note="cache hit rate" />
    <TimelineBars points={points()} groups={[{ label: "Uncached input", color: "var(--chart-soft)" }, { label: "Cached input", color: "var(--chart-series-1)" }]} />
  </Card>;
}

export function UserSpendChart(props: { users: AnalyticsEntity[]; period: string; onSelect: (id: string, label: string) => void }) {
  const max = () => Math.max(0, ...props.users.map((user) => user.cost ?? 0));
  return <Card class="analytics-user-chart p-5 min-w-0">
    <ChartHeading title="Usage by user" subtitle={`Top 8 by spend · ${props.period}`} value={fmtNum(props.users.reduce((sum, user) => sum + user.members, 0))} note="users with activity" />
    <p class="analytics-chart-hint">Select a user to filter every chart.</p>
    <Show when={props.users.length} fallback={<ChartEmpty />}><div class="analytics-user-list"><For each={props.users}>{(user, index) => <button type="button" disabled={user.id === null} class="analytics-user-row" aria-label={`Filter by user ${user.label}`} onClick={() => user.id !== null && props.onSelect(user.id, user.label)}>
      <span class="analytics-user-avatar" style={{ color: user.id === null ? colors[5] : colors[index() % 5] }}>{user.label.slice(0, 2).toUpperCase()}</span>
      <span class="analytics-user-identity"><strong title={user.label}>{user.label}</strong><small title={user.detail}>{user.detail || `${user.members} users`}</small><span class="analytics-user-bar"><i style={{ width: `${max() > 0 ? (user.cost ?? 0) / max() * 100 : 0}%`, background: user.id === null ? colors[5] : colors[index() % 5] }} /></span></span>
      <span class="analytics-user-amount"><strong>{fmtCost(user.cost ?? 0)}</strong><small>{fmtNum(user.reqs)} requests</small><small>{percent(cachePercent(user.in_tok, user.cache_tok))} cached</small></span>
    </button>}</For></div></Show>
  </Card>;
}

export function ApiKeyUsageCard(props: { keys: AnalyticsEntity[]; period: string; onSelect: (id: string, label: string) => void }) {
  const total = () => props.keys.reduce((sum, key) => sum + (key.cost ?? 0), 0);
  return <Card class="analytics-keys-card p-5 min-w-0">
    <ChartHeading title="Usage by API key" subtitle={`Top 8 by spend + other · ${props.period}`} value={fmtNum(props.keys.reduce((sum, key) => sum + key.members, 0))} note="keys with activity" />
    <Show when={props.keys.length} fallback={<ChartEmpty />}><div class="analytics-key-grid"><For each={props.keys}>{(key, index) => <button type="button" class="analytics-key-tile" disabled={key.id === null} aria-label={`Filter by API key ${key.label}`} onClick={() => key.id !== null && props.onSelect(key.id, key.label)}>
      <span class="analytics-key-heading"><Icon name="lucide:key-round" size={16} /><span><strong title={key.label}>{key.label}</strong><small title={key.detail}>{key.id === null ? `${key.members} more keys` : key.detail}</small></span><Show when={key.id !== null}><Icon name="lucide:arrow-up-right" size={13} /></Show></span>
      <span class="analytics-key-metrics"><span><small>Spend</small><strong>{fmtCost(key.cost ?? 0)}</strong></span><span><small>Requests</small><strong>{fmtNum(key.reqs)}</strong></span></span>
      <span class="analytics-user-bar"><i style={{ width: `${total() > 0 ? (key.cost ?? 0) / total() * 100 : 0}%`, background: key.id === null ? colors[5] : colors[index() % 5] }} /></span>
      <span class="analytics-key-footnote"><span>{percent(cachePercent(key.in_tok, key.cache_tok))} cache hit rate</span><span>{percent(total() > 0 ? (key.cost ?? 0) / total() * 100 : null)} of spend</span></span>
    </button>}</For></div></Show>
  </Card>;
}

export function RequestOutcomesChart(props: { outcomes: AnalyticsReport["outcomes"]; period: string }) {
  const totals = createMemo(() => props.outcomes.reduce((sum, point) => ({ success: sum.success + point.success, errors: sum.errors + point.errors, unknown: sum.unknown + point.unknown }), { success: 0, errors: 0, unknown: 0 }));
  const known = () => totals().success + totals().errors;
  const data = createMemo(() => props.outcomes.map((point) => ({ ...point,
    success_rate: point.success + point.errors ? point.success / (point.success + point.errors) * 100 : null,
    error_rate: point.success + point.errors ? point.errors / (point.success + point.errors) * 100 : null,
  })));
  return <Card class="analytics-outcomes-chart p-5 min-w-0">
    <ChartHeading title="Request success & errors" subtitle={`HTTP response rates over time · ${props.period} · UTC`} value={percent(known() ? totals().success / known() * 100 : null)} note="success rate" />
    <Show when={known() > 0} fallback={<ChartEmpty label={totals().unknown ? "No retained response statuses" : undefined} />}>
      <Show when={data()} keyed>{(points) => <div class="analytics-timeseries chart-root" style={{ height: "240px" }}>
        <Chart data={points}>
          <Axis axis="y" position="left" tickCount={3} axisRange={[0, 100]}>
            <AxisLabel fill="var(--chart-tick)" font-size="10" format={(value) => `${Math.round(Number(value))}%`} />
            <AxisGrid stroke="var(--chart-grid)" stroke-dasharray="3 4" />
          </Axis>
          <Axis axis="x" position="bottom" dataKey="label">
            <AxisLabel fill="var(--chart-tick)" font-size="10" interval="preserveStartEnd" labelGap={24} />
            <AxisLine stroke="var(--chart-grid)" /><AxisCursor stroke="var(--ink-500)" stroke-dasharray="3 4" class="chart-cursor" />
            <AxisTooltip class="chart-tooltip">{(tooltip) => <div class="analytics-chart-tooltip">
              <strong>{bucketDate(tooltip.data.date)}{tooltip.data.lastDate && tooltip.data.lastDate !== tooltip.data.date ? ` – ${bucketDate(tooltip.data.lastDate)}` : ""} · UTC</strong>
              <div><span><i style={{ background: "var(--chart-success)" }} />Success (2xx)</span><b>{percent(tooltip.data.success_rate)} · {fmtNum(tooltip.data.success)}</b></div>
              <div><span><i style={{ background: "var(--chart-error)" }} />Errors</span><b>{percent(tooltip.data.error_rate)} · {fmtNum(tooltip.data.errors)}</b></div>
              <Show when={tooltip.data.unknown}><div><span>Status unavailable</span><b>{fmtNum(tooltip.data.unknown)}</b></div></Show>
            </div>}</AxisTooltip>
          </Axis>
          <Line dataKey="success_rate" stroke="var(--chart-success)" stroke-width={2.2} fill="none" class="analytics-outcome-line is-success" />
          <Line dataKey="error_rate" stroke="var(--chart-error)" stroke-width={2.2} stroke-dasharray="5 4" fill="none" class="analytics-outcome-line is-error" />
          <Point dataKey="success_rate" fill="var(--chart-success)" r={2.2} /><Point dataKey="error_rate" fill="var(--chart-error)" r={2.2} />
        </Chart>
      </div>}</Show>
    </Show>
    <div class="analytics-outcome-totals"><span><i class="is-success" />Success (2xx)<strong>{fmtNum(totals().success)}</strong></span><span><i class="is-error" />Errors<strong>{fmtNum(totals().errors)}</strong></span></div>
    <Show when={totals().unknown}><p class="analytics-chart-hint analytics-outcome-coverage">{fmtNum(totals().unknown)} archived requests have no retained status and are excluded from these rates.</p></Show>
  </Card>;
}

export function ProviderMixChart(props: { providers: AnalyticsEntity[]; protocols: AnalyticsEntity[]; period: string; onSelect: (field: "provider_id" | "proto", id: string, label: string) => void }) {
  const [active, setActive] = createSignal<number | null>(null);
  const total = () => props.providers.reduce((sum, row) => sum + row.reqs, 0);
  const segments = createMemo(() => {
    let offset = 0;
    return props.providers.map((row, index) => {
      const size = total() ? row.reqs / total() * 100 : 0;
      const segment = { row, index, offset, size };
      offset += size;
      return segment;
    });
  });
  const current = () => active() === null ? null : props.providers[active()!];
  return <Card class="analytics-provider-chart p-5 min-w-0">
    <ChartHeading title="Provider distribution" subtitle={`Share of requests · ${props.period}`} />
    <Show when={total() > 0} fallback={<ChartEmpty />}>
      <div class="analytics-donut-layout"><div class="analytics-donut-wrap">
        <svg viewBox="0 0 220 220" class="analytics-donut" aria-label="Request share by provider">
          <circle cx="110" cy="110" r="84" fill="none" stroke="var(--elev)" stroke-width="19" />
          <For each={segments()}>{(segment) => <circle cx="110" cy="110" r="84" pathLength="100" fill="none" stroke={segment.row.id === null ? colors[5] : colors[segment.index % 5]} stroke-width={active() === segment.index ? 25 : 19} stroke-dasharray={`${segment.size} ${100 - segment.size}`} stroke-dashoffset={-segment.offset} transform="rotate(-90 110 110)" class="analytics-donut-segment" role="button" tabIndex={segment.row.id === null ? -1 : 0} aria-label={`Filter by provider ${segment.row.label}: ${percent(segment.size)} of requests`} onPointerEnter={() => setActive(segment.index)} onPointerLeave={() => setActive(null)} onFocus={() => setActive(segment.index)} onBlur={() => setActive(null)} onClick={() => segment.row.id !== null && props.onSelect("provider_id", segment.row.id, segment.row.label)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (segment.row.id !== null) props.onSelect("provider_id", segment.row.id, segment.row.label); } }} />}</For>
        </svg>
        <div class="analytics-donut-label"><strong>{fmtNum(current()?.reqs ?? total())}</strong><span>{current()?.label ?? "requests"}</span></div>
      </div><div class="analytics-provider-legend"><For each={segments()}>{(segment) => <button type="button" disabled={segment.row.id === null} onClick={() => segment.row.id !== null && props.onSelect("provider_id", segment.row.id, segment.row.label)}><i style={{ background: segment.row.id === null ? colors[5] : colors[segment.index % 5] }} /><span title={segment.row.label}>{segment.row.label}</span><strong>{percent(segment.size)}</strong></button>}</For></div></div>
      <div class="analytics-protocols"><For each={props.protocols}>{(protocol) => <button type="button" disabled={protocol.id === null} onClick={() => protocol.id !== null && props.onSelect("proto", protocol.id, protocol.label)}><span>{protocol.label}</span><strong>{fmtNum(protocol.reqs)}</strong><small>requests</small></button>}</For></div>
    </Show>
  </Card>;
}

export function UserEfficiencyChart(props: { users: AnalyticsEntity[]; period: string; onSelect: (id: string, label: string) => void }) {
  const [width, setWidth] = createSignal(400);
  const [active, setActive] = createSignal<AnalyticsEntity | null>(null);
  const users = () => props.users.filter((user) => user.id !== null);
  const maxRequests = () => Math.max(1, ...users().map((user) => user.reqs));
  const maxCost = () => Math.max(.001, ...users().map((user) => user.cost ?? 0));
  const maxOutput = () => Math.max(1, ...users().map((user) => user.out_tok));
  const watchWidth = (element: HTMLDivElement) => {
    const observer = new ResizeObserver(() => setWidth(Math.max(240, Math.floor(element.clientWidth))));
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  };
  return <Card class="analytics-efficiency-chart p-5 min-w-0">
    <ChartHeading title="Spend vs request volume" subtitle={`Top 8 users by spend · Circle size represents output tokens · ${props.period}`} />
    <Show when={users().length} fallback={<ChartEmpty />}>
      <div ref={watchWidth} class="analytics-scatter">
        <svg viewBox={`0 0 ${width()} 250`} width="100%" height="250" role="img" aria-label="User spend against request volume">
          <For each={[0, .5, 1]}>{(tick) => <>
            <line x1="46" x2={width() - 18} y1={196 - tick * 170} y2={196 - tick * 170} stroke="var(--chart-grid)" stroke-dasharray="3 4" />
            <text x="38" y={200 - tick * 170} text-anchor="end" fill="var(--chart-tick)" font-size="10">{fmtCost(maxCost() * tick)}</text>
            <text x={46 + tick * (width() - 64)} y="216" text-anchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} fill="var(--chart-tick)" font-size="10">{fmtNum(maxRequests() * tick)}</text>
          </>}</For>
          <text x={width() / 2} y="241" text-anchor="middle" fill="var(--ink-500)" font-size="10">Requests</text>
          <For each={users()}>{(user, index) => <circle cx={46 + user.reqs / maxRequests() * (width() - 64)} cy={196 - (user.cost ?? 0) / maxCost() * 170} r={6 + Math.sqrt(user.out_tok / maxOutput()) * 10} fill={colors[index() % 5]} fill-opacity={active()?.id === user.id ? .9 : .55} stroke={colors[index() % 5]} stroke-width="1.5" tabIndex={0} role="button" aria-label={`${user.label}: ${fmtCost(user.cost ?? 0)}, ${fmtNum(user.reqs)} requests. Filter by user.`} onPointerEnter={() => setActive(user)} onFocus={() => setActive(user)} onClick={() => props.onSelect(user.id!, user.label)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect(user.id!, user.label); } }} />}</For>
        </svg>
      </div>
      <div class="analytics-scatter-readout" aria-live="polite"><Show when={active()} fallback={<span>Hover or focus a circle to inspect a user. Select it to filter every chart.</span>}>{(user) => <><strong>{user().label}</strong><span>{fmtCost(user().cost ?? 0)} · {fmtNum(user().reqs)} requests · {percent(cachePercent(user().in_tok, user().cache_tok))} cached</span></>}</Show></div>
    </Show>
  </Card>;
}

export function AnalyticsError(props: { retry: () => unknown }) {
  return <Card class="analytics-error p-6"><Icon name="lucide:circle-alert" size={22} /><div><strong>Analytics could not be loaded</strong><p>Your filters are preserved. Try loading this view again.</p></div><button type="button" class="ui-button ui-button-secondary" onClick={() => props.retry()}>Retry</button></Card>;
}

export function AnalyticsLoading() {
  return <div class="analytics-loading" role="status"><Icon name="lucide:loader-circle" size={19} class="animate-spin motion-reduce:animate-none" /><span>Loading your analytics…</span></div>;
}

export function AnalyticsSection(props: { title: string; description: string; right?: JSX.Element }) {
  return <div class="analytics-section-heading"><div><h2>{props.title}</h2><p>{props.description}</p></div>{props.right}</div>;
}
