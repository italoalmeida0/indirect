import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { DailyPoint } from "./api";
import { anchorFloat } from "./floating";
import { buildRequestActivity, type ActivityCell, type ActivityScope } from "./overview-activity";
import { fmtNum } from "./ui";

function ActivityTooltip(props: { cell: ActivityCell; anchor: HTMLButtonElement; id: string }) {
  return <div
    id={props.id}
    role="tooltip"
    class="activity-tooltip"
    ref={(element) => onCleanup(anchorFloat(props.anchor, element, { placement: "top", gap: 9 }))}
  >
    <strong>{props.cell.count!.toLocaleString()} {props.cell.count === 1 ? "request" : "requests"}</strong>
    <span>{props.cell.label} · UTC</span>
  </div>;
}

export function RequestHeatmap(props: { series: DailyPoint[]; scope: ActivityScope; cacheHitRate: number | null }) {
  const model = createMemo(() => buildRequestActivity(props.series, props.scope));
  const [active, setActive] = createSignal<{ cell: ActivityCell; anchor: HTMLButtonElement } | null>(null);
  const [selected, setSelected] = createSignal<ActivityCell | null>(null);
  const [focusKey, setFocusKey] = createSignal("");
  const id = createUniqueId();
  let scroll!: HTMLDivElement;
  let board!: HTMLDivElement;
  const initialKey = () => model().cells.findLast((cell) => cell.count !== null)?.key;
  const noun = () => model().monthly ? "month" : "day";
  const readout = () => active()?.cell ?? selected();
  const showCell = (cell: ActivityCell, anchor: HTMLButtonElement) => {
    setActive({ cell, anchor });
  };
  const handleKey = (event: KeyboardEvent, cell: ActivityCell) => {
    if (event.key === "Escape") { setActive(null); setSelected(null); return; }
    const movement: Record<string, number> = model().monthly
      ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 }
      : model().short ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
      : { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    const offset = movement[event.key];
    if (offset === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const eligible = model().cells.filter((entry) => entry.count !== null);
    const index = eligible.findIndex((entry) => entry.key === cell.key);
    const next = event.key === "Home" ? eligible[0] : event.key === "End" ? eligible.at(-1) : eligible[Math.max(0, Math.min(eligible.length - 1, index + offset))];
    if (!next) return;
    setFocusKey(next.key);
    const button = board.querySelector<HTMLButtonElement>(`[data-date="${next.key}"]`);
    button?.focus({ preventScroll: true });
    if (button) {
      const bounds = button.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      const inset = Number.parseFloat(getComputedStyle(board).getPropertyValue("--activity-label-width")) + 8;
      if (bounds.left < viewport.left + inset) scroll.scrollLeft += bounds.left - viewport.left - inset;
      if (bounds.right > viewport.right - 5) scroll.scrollLeft += bounds.right - viewport.right + 5;
      if (bounds.top < viewport.top + 24) scroll.scrollTop += bounds.top - viewport.top - 24;
      if (bounds.bottom > viewport.bottom - 5) scroll.scrollTop += bounds.bottom - viewport.bottom + 5;
      if (event.key === "Home") scroll.scrollLeft = 0;
      if (event.key === "End") scroll.scrollLeft = scroll.scrollWidth;
    }
  };
  onMount(() => {
    let previousEnd = 0;
    const resize = () => {
      const atEnd = scroll.scrollLeft >= previousEnd - 2;
      previousEnd = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      if (atEnd) scroll.scrollLeft = previousEnd;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(scroll);
    const frame = requestAnimationFrame(resize);
    onCleanup(() => { observer.disconnect(); cancelAnimationFrame(frame); });
  });

  return <div class={`request-activity ${model().monthly ? "is-monthly" : ""} ${model().short ? "is-short" : ""}`}>
    <div class="activity-heading">
      <span>{model().monthly ? "Monthly" : "Daily"} activity <span class="activity-utc">UTC</span></span>
      <span>{model().first === model().last ? model().first : `${model().first ?? ""} – ${model().last ?? ""}`}</span>
    </div>
    <p id={`${id}-hint`} class="sr-only">Request activity by {noun()}. Use arrow keys to explore, Home for the first {noun()}, or End for the last. Muted cells are outside the selected range.</p>
    <div ref={scroll} class="activity-scroll" onPointerLeave={() => setActive(null)}>
      <div
        ref={board} role="group" aria-label="Request activity calendar" aria-describedby={`${id}-hint`}
        class="activity-board"
        style={{ "--activity-columns": model().calendar.columns, "--activity-rows": model().calendar.rowLabels.length }}
      >
        <For each={model().calendar.columnLabels}>{(entry) => <span class="activity-column-label" title={entry.label} style={{ "grid-column": `${entry.column + 2} / span ${model().short || model().monthly ? 1 : Math.min(3, model().calendar.columns - entry.column)}` }}>{entry.label}</span>}</For>
        <For each={model().calendar.rowLabels}>{(label, row) => <span class="activity-row-label" style={{ "grid-row": row() + 2 }}>{label}</span>}</For>
        <For each={model().calendar.cells}>{(cell) => <Show
          when={cell.count !== null}
          fallback={<span aria-hidden="true" class="activity-cell is-outside" style={{ "grid-column": cell.column + 2, "grid-row": cell.row + 2 }} />}
        >
          <button
            type="button"
            data-date={cell.key}
            data-count={cell.count}
            class={`activity-cell activity-level-${cell.level}`}
            classList={{ "is-selected": selected()?.key === cell.key }}
            style={{ "grid-column": cell.column + 2, "grid-row": cell.row + 2 }}
            tabIndex={(focusKey() || initialKey()) === cell.key ? 0 : -1}
            aria-label={`${cell.label}: ${cell.count!.toLocaleString()} ${cell.count === 1 ? "request" : "requests"}, UTC`}
            aria-pressed={selected()?.key === cell.key}
            aria-describedby={active()?.cell.key === cell.key ? `${id}-tooltip` : undefined}
            onPointerEnter={(event) => showCell(cell, event.currentTarget)}
            onFocus={(event) => { setFocusKey(cell.key); showCell(cell, event.currentTarget); }}
            onBlur={() => setActive(null)}
            onKeyDown={(event) => handleKey(event, cell)}
            onClick={(event) => { setSelected(cell); showCell(cell, event.currentTarget); }}
          ><Show when={model().short}><span aria-hidden="true" class="activity-cell-date">{Number(cell.key.slice(-2))}</span></Show></button>
        </Show>}</For>
      </div>
    </div>
    <div class="activity-footer">
      <div class="activity-readout" aria-live="polite" aria-atomic="true">
        <Show when={readout()} fallback={<span>Explore activity by {noun()} <span class="activity-outside-note">· Muted cells are outside the range</span></span>}>
          {(cell) => <span><strong>{cell().count!.toLocaleString()} {cell().count === 1 ? "request" : "requests"}</strong> on {cell().label}</span>}
        </Show>
      </div>
      <div class="activity-legend" aria-label="Request volume: less to more">
        <span>Less</span><For each={[0, 1, 2, 3, 4]}>{(level) => <span class={`activity-cell activity-level-${level}`} />}</For><span>More</span>
      </div>
    </div>
    <div class="activity-summary">
      <div><span>Active {noun()}s</span><strong>{fmtNum(model().active)} <small>/ {fmtNum(model().periods)}</small></strong></div>
      <div><span>{model().monthly ? "Monthly" : "Daily"} average</span><strong>{fmtNum(Math.round(model().average))}<small> requests</small></strong></div>
      <div><span>Busiest {noun()}</span><strong>{model().peak ? fmtNum(model().peak!.count!) : "—"}<small class="activity-peak-date">{model().peak ? model().peak!.label : "No requests in this period"}</small></strong></div>
      <div class="activity-cache-rate" title="Cached input tokens divided by cached and uncached input tokens"><span>Cache hit rate</span><strong>{props.cacheHitRate === null ? "—" : `${props.cacheHitRate.toLocaleString("en", { maximumFractionDigits: 1 })}%`}<Show when={props.cacheHitRate === null}><small>No input tokens</small></Show></strong></div>
    </div>
    <Show when={active()} keyed>{(item) => <Portal><ActivityTooltip cell={item.cell} anchor={item.anchor} id={`${id}-tooltip`} /></Portal>}</Show>
  </div>;
}
